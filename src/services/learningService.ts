import { getDb } from "../lib/db.js";
import { getLatestFeatures } from "./featureService.js";
import { nowIso, normalizeSymbol, uuid } from "../lib/utils.js";
import type { TimeHorizon } from "../types.js";

interface FeatureRow {
  symbol: string;
  timestamp: string;
  features: Record<string, string | number | null>;
}

interface TrainInput {
  horizonDays: 1 | 5 | 20;
  X: number[][];
  y: number[];
  featureNames: string[];
}

const featureNames = [
  "close",
  "dailyReturn",
  "rsi14",
  "macd",
  "macdHistogram",
  "atr14",
  "relativeVolume",
  "volatility20",
  "sma20",
  "sma50"
];

const toNumberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const collectSamples = (rows: FeatureRow[], horizonDays: 1 | 5 | 20): TrainInput => {
  const bySymbol = new Map<string, FeatureRow[]>();
  for (const row of rows) {
    const normalizedSymbol = normalizeSymbol(row.symbol);
    const list = bySymbol.get(normalizedSymbol) || [];
    list.push(row);
    bySymbol.set(normalizedSymbol, list);
  }

  const X: number[][] = [];
  const y: number[] = [];
  for (const list of bySymbol.values()) {
    const ordered = [...list].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    for (let i = 0; i + horizonDays < ordered.length; i += 1) {
      const current = ordered[i];
      const future = ordered[i + horizonDays];
      if (!current?.features.close || !future?.features.close) {
        continue;
      }
      const featureVector: number[] = [];
      let valid = true;
      for (const name of featureNames) {
        const value = toNumberOrNull(current.features[name]);
        if (value === null) {
          valid = false;
          break;
        }
        featureVector.push(value);
      }
      if (!valid) {
        continue;
      }
      const currentClose = Number(current.features.close);
      const futureClose = Number(future.features.close);
      X.push(featureVector);
      y.push(futureClose > currentClose ? 1 : 0);
    }
  }

  return { horizonDays, X, y, featureNames };
};

const trainLogistic = (input: TrainInput, iterations = 250, lr = 0.01) => {
  const weights = new Array(input.featureNames.length).fill(0.01);
  let bias = 0;
  for (let epoch = 0; epoch < iterations; epoch += 1) {
    for (let i = 0; i < input.X.length; i += 1) {
      const row = input.X[i];
      const label = input.y[i];
      const z = row.reduce((acc, value, idx) => acc + value * weights[idx], bias);
      const pred = 1 / (1 + Math.exp(-z));
      const error = pred - label;
      bias -= lr * error;
      for (let j = 0; j < weights.length; j += 1) {
        weights[j] -= lr * error * row[j];
      }
    }
  }
  return { weights, bias };
};

const score = (features: number[], model: { weights: number[]; bias: number }) => {
  const z = features.reduce((acc, value, idx) => acc + value * model.weights[idx], model.bias);
  return 1 / (1 + Math.exp(-z));
};

const evaluate = (input: TrainInput) => {
  if (!input.X.length) {
    return {
      accuracy: 0,
      precision: 0,
      recall: 0,
      directionalAccuracy: 0,
      optionOutperformanceAccuracy: 0,
      model: { weights: new Array(input.featureNames.length).fill(0), bias: 0 }
    };
  }
  const split = Math.max(1, Math.floor(input.X.length * 0.75));
  const trainX = input.X.slice(0, split);
  const trainY = input.y.slice(0, split);
  const testX = input.X.slice(split);
  const testY = input.y.slice(split);
  const model = trainLogistic({
    ...input,
    X: trainX,
    y: trainY
  });

  let correct = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < testX.length; i += 1) {
    const pred = score(testX[i], model) >= 0.5 ? 1 : 0;
    if (pred === testY[i]) {
      correct += 1;
    }
    if (pred === 1 && testY[i] === 1) {
      tp += 1;
    }
    if (pred === 1 && testY[i] === 0) {
      fp += 1;
    }
    if (pred === 0 && testY[i] === 1) {
      fn += 1;
    }
  }

  const denom = testX.length || 1;
  return {
    accuracy: correct / denom,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
    directionalAccuracy: correct / denom,
    optionOutperformanceAccuracy: correct / denom,
    model
  };
};

const optionOutperformSignal = (rows: FeatureRow[]) => {
  let good = 0;
  let attempts = 0;
  for (const row of rows) {
    const iv = toNumberOrNull(row.features.atmImpliedVol);
    const relativeVolume = toNumberOrNull(row.features.relativeVolume);
    if (iv === null || relativeVolume === null) {
      continue;
    }
    attempts += 1;
    if (iv > 0.25 && relativeVolume > 1) {
      good += 1;
    }
  }
  return attempts ? good / attempts : 0;
};

export const runLearning = async (horizon: TimeHorizon = "1d") => {
  const horizonMap = { "1d": 1, "5d": 5, "20d": 20 } as const;
  const rows = getLatestFeatures().map((snapshot): FeatureRow => ({
    symbol: snapshot.symbol,
    timestamp: snapshot.timestamp,
    features: snapshot.features
  }));
  const data = collectSamples(rows, horizonMap[horizon]);
  const metrics = evaluate(data);
  const featureImportance = Object.fromEntries(
    featureNames.map((name, index) => [name, Math.abs(metrics.model.weights[index] || 0)])
  );
  const modelName = `baseline_logistic_${horizon}`;
  const model = {
    modelName,
    trainedAt: nowIso(),
    horizon,
    universe: Array.from(new Set(rows.map((row) => normalizeSymbol(row.symbol)))),
    metrics: {
      accuracy: metrics.accuracy,
      precision: metrics.precision,
      recall: metrics.recall,
      auc: undefined,
      meanAbsoluteError: undefined,
      directionalAccuracy: metrics.directionalAccuracy,
      optionOutperformanceAccuracy: metrics.optionOutperformanceAccuracy
    },
    featureImportance,
    strategyPerformance: {
      shares: metrics.accuracy,
      long_call: metrics.precision,
      long_put: metrics.recall,
      call_spread: metrics.recall,
      put_spread: metrics.precision
    },
    notes: [
      `Trained on ${data.X.length} labeled examples`,
      "Options-aware labels are estimated from feature-based liquidity/volatility proxies."
    ]
  };

  const runId = `learn_${uuid()}`;
  getDb()
    .prepare(
      `
      INSERT INTO learning_runs(
        id,
        model_name,
        trained_at,
        horizon,
        universe_json,
        metrics_json,
        feature_importance_json,
        strategy_performance_json,
        notes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      runId,
      model.modelName,
      model.trainedAt,
      horizon,
      JSON.stringify(model.universe),
      JSON.stringify({
        accuracy: model.metrics.accuracy,
        precision: model.metrics.precision,
        recall: model.metrics.recall,
        auc: model.metrics.auc,
        meanAbsoluteError: model.metrics.meanAbsoluteError,
        directionalAccuracy: model.metrics.directionalAccuracy,
        optionOutperformanceAccuracy: model.metrics.optionOutperformanceAccuracy
      }),
      JSON.stringify(model.featureImportance),
      JSON.stringify(model.strategyPerformance),
      JSON.stringify({
        ...model.notes,
        optionOutperformanceAccuracy: optionOutperformSignal(rows)
      })
    );

  return model;
};
