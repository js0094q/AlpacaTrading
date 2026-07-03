import { getDb, queryAll, queryOne, getDb as rawDb } from "../lib/db.js";
import { getLatestFeatures } from "./featureService.js";
import { selectExpression } from "./strategySelector.js";
import type { RiskProfile, TargetSnapshotRow } from "../types.js";
import { seedInitialUniverse } from "./universeService.js";
import { nowIso } from "../lib/utils.js";

interface LearningSummary {
  modelName: string;
  accuracy?: number;
}

const latestLearning = (): LearningSummary | null => {
  const row = queryOne<{
    model_name: string;
    metrics_json: string;
  }>(`
    SELECT model_name, metrics_json
    FROM learning_runs
    ORDER BY trained_at DESC
    LIMIT 1
  `);
  if (!row) {
    return null;
  }
  return {
    modelName: row.model_name,
    accuracy: JSON.parse(row.metrics_json)?.accuracy
  };
};

const clamp01 = (value: number | null) =>
  value === null ? null : Math.max(0, Math.min(1, value));

const parseFeature = (features: Record<string, string | number | null>) => {
  const directionScore =
    (typeof features.trend === "string" && features.trend === "bullish"
      ? 1
      : features.trend === "bearish"
      ? -1
      : 0) +
    (typeof features.rsi14 === "number"
      ? (features.rsi14 - 50) / 100
      : 0) +
    (typeof features.ema9 === "number" && typeof features.ema21 === "number"
      ? (features.ema9 - features.ema21) / (features.ema21 || 1)
      : 0) +
    (typeof features.macdHistogram === "number" ? Math.sign(features.macdHistogram) * 0.2 : 0) +
    (typeof features.relativeVolume === "number" ? 0.2 * (features.relativeVolume - 1) : 0);

  const volatilityAdjusted = Math.max(
    0,
    Math.min(2, 1 + (typeof features.atmImpliedVol === "number" ? features.atmImpliedVol : 0.2))
  );
  const atr = typeof features.atr14 === "number" ? features.atr14 : null;
  const close = typeof features.close === "number" ? features.close : 0;

  return {
    directionScore,
    volatilityAdjusted,
    atr,
    close
  };
};

export const generateTargets = async (input?: {
  riskProfile?: RiskProfile;
  optionsOnly?: boolean;
}) => {
  await seedInitialUniverse();
  const features = getLatestFeatures();
  const learning = latestLearning();
  const learningBoost = clamp01((learning?.accuracy ?? 0.5) - 0.5) || 0;
  const insert = rawDb().prepare(`
    INSERT INTO target_snapshots(
      symbol,
      as_of,
      direction,
      horizon,
      entry_reference,
      upside_target,
      downside_risk,
      stop_loss,
      take_profit,
      confidence,
      expected_return,
      volatility_adjusted_score,
      risk_profile,
      preferred_expression,
      rationale
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rows: TargetSnapshotRow[] = [];

  for (const snapshot of features) {
    const asOf = snapshot.timestamp;
    const f = snapshot.features;
    const parsed = parseFeature(f);
    const expectedReturn = parsed.directionScore * (parsed.volatilityAdjusted || 1);
    const baseConfidence = Math.abs(parsed.directionScore) / 2;
    const confidence = Math.min(1, Math.max(0, baseConfidence + learningBoost * 0.2));

    let direction: "long" | "short" | "neutral" = "neutral";
    if (parsed.directionScore > 0.25) {
      direction = "long";
    }
    if (parsed.directionScore < -0.25) {
      direction = "short";
    }

    let riskProfile: RiskProfile = "moderate";
    if (input?.riskProfile) {
      riskProfile = input.riskProfile;
    } else if (Math.abs(parsed.directionScore) > 0.7 && confidence > 0.75) {
      riskProfile = "aggressive";
    } else if (confidence < 0.45 || typeof parsed.atr === "number" && parsed.atr > 0.06) {
      riskProfile = "conservative";
    }

    const stopLossDist = typeof parsed.atr === "number" ? parsed.atr * 1.5 : 0;
    const takeProfitDist = typeof parsed.atr === "number" ? parsed.atr * 3 : 0;
    const entryReference = parsed.close;
    const downsideRisk = direction === "long" ? stopLossDist : stopLossDist;
    const upsideTarget = direction === "long" ? takeProfitDist : takeProfitDist;

    const selector = selectExpression({
      symbol: snapshot.symbol,
      asOf,
      direction,
      confidence,
      expectedReturn,
      atr: parsed.atr,
      trend: String(f.trend ?? "neutral"),
      iv: typeof f.atmImpliedVol === "number" ? Number(f.atmImpliedVol) : null,
      liquidityScore: typeof f.preferredContractLiquidityScore === "number" ? Number(f.preferredContractLiquidityScore) : 0,
      spreadPct:
        typeof f.estimatedBidAskSpreadPct === "number"
          ? Number(f.estimatedBidAskSpreadPct)
          : null,
      hasOptionsData:
        (typeof f.callLiquidityAvailable === "number" &&
          Number(f.callLiquidityAvailable) > 0) ||
        (typeof f.putLiquidityAvailable === "number" &&
          Number(f.putLiquidityAvailable) > 0)
    });

    if (input?.optionsOnly && selector.preferredExpression === "shares") {
      continue;
    }

    const rationale = [
      ...selector.rationale,
      `Risk profile set to ${riskProfile}`,
      `Learning boost from ${learning?.modelName ?? "no model"}`
    ];

    const row: TargetSnapshotRow = {
      symbol: snapshot.symbol,
      asOf,
      direction,
      horizon: "1d",
      entryReference,
      upsideTarget: entryReference + upsideTarget,
      downsideRisk: entryReference - downsideRisk,
      stopLoss: direction === "long" ? entryReference - downsideRisk : entryReference + downsideRisk,
      takeProfit:
        direction === "long" ? entryReference + upsideTarget : entryReference - upsideTarget,
      confidence,
      expectedReturn,
      volatilityAdjustedScore: parsed.volatilityAdjusted,
      riskProfile,
      preferredExpression: selector.preferredExpression,
      rationale
    };

    rows.push(row);
    insert.run(
      row.symbol,
      row.asOf,
      direction,
      "1d",
      row.entryReference,
      row.upsideTarget,
      row.downsideRisk,
      row.stopLoss,
      row.takeProfit,
      row.confidence,
      row.expectedReturn,
      row.volatilityAdjustedScore,
      row.riskProfile,
      row.preferredExpression,
      JSON.stringify(row.rationale)
    );
    rawDb()
      .prepare(
        `
        INSERT INTO options_strategy_snapshots(
          symbol,
          as_of,
          direction,
          preferred_expression,
          alternatives,
          rationale,
          options_candidate
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        selector.symbol,
        selector.asOf,
        selector.direction,
        selector.preferredExpression,
        JSON.stringify(selector.alternatives),
        JSON.stringify(selector.rationale),
        selector.optionsCandidate ? JSON.stringify(selector.optionsCandidate) : null
      );
  }

  return { generated: rows.length, rows };
};

export const getTargets = (riskProfile?: RiskProfile, optionsOnly = false) =>
  queryAll<{
    symbol: string;
    as_of: string;
    direction: string;
    horizon: string;
    entry_reference: number;
    upside_target: number;
    downside_risk: number;
    stop_loss: number | null;
    take_profit: number | null;
    confidence: number;
    expected_return: number | null;
    volatility_adjusted_score: number | null;
    risk_profile: string;
    preferred_expression: string;
    rationale: string;
  }>(
    `
    SELECT *
    FROM target_snapshots
    ${riskProfile ? "WHERE risk_profile = ?" : ""}
    ${riskProfile ? "AND" : "WHERE"} ${optionsOnly ? "preferred_expression != 'shares'" : "1 = 1"}
    ORDER BY confidence DESC
    `,
    riskProfile ? [riskProfile] : []
  );
