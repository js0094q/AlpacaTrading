import { getDb } from "../lib/db.js";
import { getBars } from "./marketDataIngest.js";
import { getLatestFeatures } from "./featureService.js";
import { config } from "../config.js";
import { selectExpression } from "./strategySelector.js";
import { nowIso, normalizeSymbol, uuid } from "../lib/utils.js";
import { getActiveSymbols, seedInitialUniverse } from "./universeService.js";

export interface BacktestConfig {
  startDate?: string | null;
  endDate?: string | null;
  initialCapital?: number;
  maxPositions?: number;
  positionSize?: number;
  holdingPeriod?: number;
  longEnabled?: boolean;
  shortEnabled?: boolean;
  optionsEnabled?: boolean;
  aggressiveMode?: boolean;
  stopLoss?: number;
  takeProfit?: number;
  trailingStop?: number;
  maxLossPerTrade?: number;
  maxNotionalPerTrade?: number;
}

type Side = "long" | "short";

type Position = {
  symbol: string;
  side: Side;
  entryDate: string;
  entryPrice: number;
  quantity: number;
  stopLoss: number | null;
  takeProfit: number | null;
  trailingStop: number | null;
  holdDays: number;
  expression:
    | "shares"
    | "long_call"
    | "long_put"
    | "call_spread"
    | "put_spread"
    | "covered_call"
    | "cash_secured_put"
    | "protective_put"
    | "collar"
    | "none";
};

interface ShareTrade {
  symbol: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  side: Side;
  quantity: number;
  pnl: number;
  returnPct: number;
  exitReason:
    | "stop_loss"
    | "take_profit"
    | "time_exit"
    | "signal_exit"
    | "trailing_stop";
}

interface OptionTrade {
  underlyingSymbol: string;
  optionSymbol: string;
  strategy:
    | "long_call"
    | "long_put"
    | "call_spread"
    | "put_spread"
    | "covered_call"
    | "cash_secured_put"
    | "protective_put"
    | "collar";
  entryDate: string;
  exitDate: string;
  expirationDate?: string;
  strike?: number;
  shortStrike?: number;
  entryPremium: number | null;
  exitPremium: number | null;
  contracts: number;
  estimatedMaxLoss: number | null;
  estimatedMaxProfit: number | null;
  pnl: number;
  returnPct: number;
  exitReason:
    | "stop_loss"
    | "take_profit"
    | "time_exit"
    | "signal_exit"
    | "trailing_stop"
    | "expiration";
}

interface OptionPosition {
  symbol: string;
  optionSymbol: string;
  side: Side;
  strategy:
    | "long_call"
    | "long_put"
    | "call_spread"
    | "put_spread"
    | "covered_call"
    | "cash_secured_put"
    | "protective_put"
    | "collar";
  entryDate: string;
  entryPremium: number;
  contracts: number;
  strike: number;
  shortStrike?: number;
  expirationDate: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  trailingStop: number | null;
  holdDays: number;
  maxLoss: number | null;
  maxProfit: number | null;
}

const computeMetrics = (trades: Array<{ returnPct: number }>) => {
  if (!trades.length) {
    return {
      totalReturn: 0,
      annualizedReturn: null,
      maxDrawdown: 0,
      winRate: 0,
      profitFactor: null,
      sharpeApprox: null,
      trades: 0,
      avgTradeReturn: 0,
      bestTrade: 0,
      worstTrade: 0
    };
  }

  const returns = trades.map((trade) => trade.returnPct);
  const totalReturn = returns.reduce((acc, value) => acc + value, 0);
  const positiveTrades = returns.filter((ret) => ret > 0);
  const negativeTrades = returns.filter((ret) => ret < 0);
  const winRate = positiveTrades.length / returns.length;
  const totalWin = positiveTrades.reduce((acc, value) => acc + value, 0);
  const totalLoss = Math.abs(negativeTrades.reduce((acc, value) => acc + value, 0));
  const profitFactor = totalLoss === 0 ? null : totalWin / totalLoss;
  const avgTradeReturn = totalReturn / returns.length;
  const bestTrade = Math.max(...returns);
  const worstTrade = Math.min(...returns);
  const running = returns.reduce(
    (acc, value) => {
      const latest = acc.balance * (1 + value / 100);
      const peak = Math.max(acc.peak, latest);
      acc.drawdown = Math.min(acc.drawdown, (latest - peak) / peak);
      acc.balance = latest;
      return { ...acc, peak };
    },
    { balance: 1, peak: 1, drawdown: 0 }
  );

  return {
    totalReturn,
    annualizedReturn: null,
    maxDrawdown: Math.abs(running.drawdown),
    winRate,
    profitFactor,
    sharpeApprox: null,
    trades: returns.length,
    avgTradeReturn,
    bestTrade,
    worstTrade
  };
};

const getFeatureForDate = (symbol: string, timestamp: string) => {
  const rows = getLatestFeatures()
    .filter((feature) => feature.symbol === symbol)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return rows.find((row) => row.timestamp === timestamp);
};

const optionContractsForUnderlying = (symbol: string, direction: Side) => {
  const type = direction === "long" ? "call" : "put";
  return getDb().prepare(
    `
    SELECT option_symbol, strike, expiration_date
    FROM option_contracts
    WHERE underlying_symbol = ? AND type = ? AND tradable = 1
    ORDER BY ABS(strike - ?)
    LIMIT 1
    `
  );
};

const optionSnapshotForSymbol = (optionSymbol: string) => {
  return getDb().prepare(
    `
    SELECT bid, ask, midpoint, last
    FROM option_snapshots
    WHERE option_symbol = ?
    ORDER BY timestamp DESC
    LIMIT 1
    `
  ).get(optionSymbol) as
    | {
        bid: number | null;
        ask: number | null;
        midpoint: number | null;
        last: number | null;
      }
    | undefined;
};

const estimateOptionPremium = (
  strategy: OptionPosition["strategy"],
  currentClose: number,
  strike: number,
  shortStrike: number | undefined,
  snapshot: ReturnType<typeof optionSnapshotForSymbol>
) => {
  const fallback = () => {
    if (strategy === "call_spread") {
      const longCall = Math.max(0, currentClose - strike);
      const shortCall = Math.max(0, currentClose - (shortStrike ?? strike + 1));
      return Math.max(0.01, longCall - shortCall + 0.1);
    }
    if (strategy === "put_spread") {
      const longPut = Math.max(0, (shortStrike ?? strike) - currentClose);
      const shortPut = Math.max(0, (shortStrike ?? strike - 1) - currentClose);
      return Math.max(0.01, longPut - shortPut + 0.1);
    }
    if (strategy === "long_call") {
      return Math.max(0.01, Math.max(0, currentClose - strike) + 0.5);
    }
    return Math.max(0.01, Math.max(0, strike - currentClose) + 0.5);
  };

  const quoted =
    snapshot?.ask ?? snapshot?.midpoint ?? snapshot?.last ?? snapshot?.bid ?? null;
  if (quoted === null || quoted === undefined) {
    return fallback();
  }

  return quoted;
};

const closeSharePosition = (
  position: Position,
  exitPrice: number,
  exitReason: ShareTrade["exitReason"],
  exitDate: string
): ShareTrade => {
  const priceMove =
    position.side === "long" ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
  const pnl = priceMove * position.quantity;
  return {
    symbol: position.symbol,
    entryDate: position.entryDate,
    exitDate,
    entryPrice: position.entryPrice,
    exitPrice,
    side: position.side,
    quantity: position.quantity,
    pnl,
    returnPct: position.entryPrice > 0 ? (pnl / (position.entryPrice * position.quantity)) * 100 : 0,
    exitReason
  };
};

const closeOptionPosition = (
  position: OptionPosition,
  exitPremium: number,
  exitReason: OptionTrade["exitReason"],
  exitDate: string
): OptionTrade => {
  const pnl = (exitPremium - position.entryPremium) * (position.contracts * 100);
  return {
    underlyingSymbol: position.symbol,
    optionSymbol: position.optionSymbol,
    strategy: position.strategy,
    entryDate: position.entryDate,
    exitDate,
    expirationDate: position.expirationDate ?? undefined,
    strike: position.strike,
    shortStrike: position.shortStrike,
    entryPremium: position.entryPremium,
    exitPremium,
    contracts: position.contracts,
    estimatedMaxLoss: position.maxLoss,
    estimatedMaxProfit: position.maxProfit,
    pnl,
    returnPct: position.entryPremium > 0 ? ((exitPremium - position.entryPremium) / position.entryPremium) * 100 : 0,
    exitReason
  };
};

const buildOptionPosition = (
  symbol: string,
  asOf: string,
  side: Side,
  closePrice: number,
  strategy:
    | "long_call"
    | "long_put"
    | "call_spread"
    | "put_spread"
    | "covered_call"
    | "cash_secured_put"
    | "protective_put"
    | "collar",
  cfg: {
    initialCapital: number;
    positionSize: number;
    maxNotionalPerTrade: number;
    stopLoss: number;
    takeProfit: number;
    trailingStop: number;
  }
): OptionPosition | null => {
  const normalizedStrategy =
    strategy === "long_call" || strategy === "call_spread" || strategy === "covered_call"
      ? "long"
      : "short";

  const row = optionContractsForUnderlying(symbol, normalizedStrategy)
    .get(symbol, normalizedStrategy === "long" ? "call" : "put", closePrice) as
    | {
        option_symbol: string;
        strike: number;
        expiration_date: string;
      }
    | undefined;

  const optionSymbol = row?.option_symbol ?? `${symbol}_${normalizedStrategy}_ATM`;
  const strike = row && Number.isFinite(row.strike) ? row.strike : closePrice;
  const shortStrike =
    strategy === "call_spread"
      ? strike * 1.02
      : strategy === "put_spread"
        ? strike * 0.98
        : undefined;
  const snapshot = optionSnapshotForSymbol(optionSymbol);
  const entryPremium = estimateOptionPremium(strategy, closePrice, strike, shortStrike, snapshot);

  const notional = Math.min(cfg.maxNotionalPerTrade, cfg.initialCapital * cfg.positionSize);
  const premiumPerContract = Math.max(0.01, entryPremium * 100);
  const contracts = Math.max(1, Math.floor(notional / premiumPerContract));
  const stopLoss = entryPremium * (1 - cfg.stopLoss);
  const takeProfit = entryPremium * (1 + cfg.takeProfit);
  const trailingStop = entryPremium * (1 - cfg.trailingStop);

  const spreadWidth = shortStrike === undefined ? 0 : Math.abs(shortStrike - strike);
  const maxLoss = entryPremium * contracts * 100;
  const maxProfit =
    strategy === "call_spread" || strategy === "put_spread"
      ? (spreadWidth * 100 - entryPremium) * contracts
      : null;

  return {
    symbol,
    optionSymbol,
    strategy,
    side: normalizedStrategy,
    entryDate: asOf,
    entryPremium,
    contracts,
    strike,
    shortStrike,
    expirationDate: row?.expiration_date ?? null,
    stopLoss,
    takeProfit,
    trailingStop,
    holdDays: 0,
    maxLoss,
    maxProfit
  };
};

export const runBacktest = async (configInput?: BacktestConfig) => {
  if (!config.safeMode) {
    throw new Error("Live execution disabled by platform policy in this phase.");
  }

  await seedInitialUniverse();

  const cfg = {
    startDate: configInput?.startDate ?? undefined,
    endDate: configInput?.endDate ?? undefined,
    initialCapital: configInput?.initialCapital || 100000,
    maxPositions: configInput?.maxPositions || 2,
    positionSize: configInput?.positionSize || 0.2,
    holdingPeriod: configInput?.holdingPeriod || 5,
    longEnabled: configInput?.longEnabled ?? true,
    shortEnabled: configInput?.shortEnabled ?? true,
    optionsEnabled: configInput?.optionsEnabled ?? false,
    aggressiveMode: configInput?.aggressiveMode ?? false,
    stopLoss: configInput?.stopLoss ?? 0.05,
    takeProfit: configInput?.takeProfit ?? 0.1,
    trailingStop: configInput?.trailingStop ?? 0.03,
    maxLossPerTrade: configInput?.maxLossPerTrade || 2000,
    maxNotionalPerTrade: configInput?.maxNotionalPerTrade || 10000
  };

  const runId = `bt_${uuid()}`;
  const start = nowIso();
  getDb()
    .prepare(
      `INSERT INTO backtest_runs(id, started_at, status, config_json) VALUES (?, ?, 'running', ?) `
    )
    .run(runId, start, JSON.stringify(cfg));

  const symbols = getActiveSymbols();
  const sharesTrades: ShareTrade[] = [];
  const optionTrades: OptionTrade[] = [];

  for (const symbol of symbols) {
    const bars = await getBars(symbol, "1Day", cfg.startDate, cfg.endDate);
    if (!bars.length) {
      continue;
    }

    const parsedBars = bars.map((bar) => ({
      symbol: normalizeSymbol(bar.symbol),
      timestamp: bar.timestamp,
      open: bar.open,
      close: bar.close
    }));

    let position: Position | null = null;
    let optionPosition: OptionPosition | null = null;

    for (let i = 0; i < parsedBars.length; i += 1) {
      const bar = parsedBars[i];
      const feature = getFeatureForDate(symbol, bar.timestamp);
      const close = bar.close;
      const featureData = feature?.features || {};
      const trend = String(featureData.trend || featureData.direction || "neutral");
      const direction =
        trend === "bullish" ? "bullish" : trend === "bearish" ? "bearish" : "neutral";
      const atr = typeof featureData.atr14 === "number" ? featureData.atr14 : close * 0.01;
      const confidence = Math.min(
        1,
        Math.abs((direction === "bullish" ? 1 : direction === "bearish" ? -1 : 0) * 0.5)
      );
      const expectedReturn =
        direction === "bullish" ? 0.01 : direction === "bearish" ? -0.01 : 0;
      const selector = selectExpression({
        symbol,
        asOf: bar.timestamp,
        direction:
          direction === "bullish" ? "long" : direction === "bearish" ? "short" : "neutral",
        confidence,
        expectedReturn,
        atr,
        trend,
        iv: featureData.atmImpliedVol ? Number(featureData.atmImpliedVol) : null,
        liquidityScore:
          typeof featureData.preferredContractLiquidityScore === "number"
            ? featureData.preferredContractLiquidityScore
            : 0,
        spreadPct:
          typeof featureData.estimatedBidAskSpreadPct === "number"
            ? Number(featureData.estimatedBidAskSpreadPct)
            : null,
        hasOptionsData:
          Number(featureData.callLiquidityAvailable || 0) > 0 ||
          Number(featureData.putLiquidityAvailable || 0) > 0
      });

      if (position) {
        const active = position;
        active.holdDays += 1;
        const priceMove =
          active.side === "long" ? close - active.entryPrice : active.entryPrice - close;

        if (
          active.stopLoss !== null &&
          ((active.side === "long" && close <= active.stopLoss) ||
            (active.side === "short" && close >= active.stopLoss))
        ) {
          sharesTrades.push(closeSharePosition(active, close, "stop_loss", bar.timestamp));
          position = null;
          continue;
        }

        if (
          active.takeProfit !== null &&
          ((active.side === "long" && close >= active.takeProfit) ||
            (active.side === "short" && close <= active.takeProfit))
        ) {
          sharesTrades.push(closeSharePosition(active, close, "take_profit", bar.timestamp));
          position = null;
          continue;
        }

        if (
          active.trailingStop !== null &&
          ((active.side === "long" && close <= active.trailingStop) ||
            (active.side === "short" && close >= active.trailingStop))
        ) {
          sharesTrades.push(closeSharePosition(active, close, "trailing_stop", bar.timestamp));
          position = null;
          continue;
        }

        if (active.holdDays >= cfg.holdingPeriod) {
          sharesTrades.push(closeSharePosition(active, close, "time_exit", bar.timestamp));
          position = null;
          continue;
        }

        if (
          active.side === "long" &&
          selector.direction === "short" &&
          cfg.shortEnabled
        ) {
          sharesTrades.push(closeSharePosition(active, close, "signal_exit", bar.timestamp));
          position = null;
        }
        if (
          active.side === "short" &&
          selector.direction === "long" &&
          cfg.longEnabled
        ) {
          sharesTrades.push(closeSharePosition(active, close, "signal_exit", bar.timestamp));
          position = null;
        }
      }

      if (optionPosition) {
        const active = optionPosition;
        active.holdDays += 1;
        const snapshot = optionSnapshotForSymbol(active.optionSymbol);
        const premium = estimateOptionPremium(
          active.strategy,
          close,
          active.strike,
          active.shortStrike,
          snapshot
        );

        if (active.stopLoss !== null && premium <= active.stopLoss) {
          optionTrades.push(
            closeOptionPosition(active, premium, "stop_loss", bar.timestamp)
          );
          optionPosition = null;
          continue;
        }

        if (active.takeProfit !== null && premium >= active.takeProfit) {
          optionTrades.push(
            closeOptionPosition(active, premium, "take_profit", bar.timestamp)
          );
          optionPosition = null;
          continue;
        }

        if (active.trailingStop !== null && premium <= active.trailingStop) {
          optionTrades.push(
            closeOptionPosition(active, premium, "trailing_stop", bar.timestamp)
          );
          optionPosition = null;
          continue;
        }

        if (active.holdDays >= cfg.holdingPeriod) {
          optionTrades.push(closeOptionPosition(active, premium, "time_exit", bar.timestamp));
          optionPosition = null;
          continue;
        }

        if (
          active.side === "long" &&
          selector.direction === "short" &&
          cfg.shortEnabled
        ) {
          optionTrades.push(
            closeOptionPosition(active, premium, "signal_exit", bar.timestamp)
          );
          optionPosition = null;
        }
        if (
          active.side === "short" &&
          selector.direction === "long" &&
          cfg.longEnabled
        ) {
          optionTrades.push(
            closeOptionPosition(active, premium, "signal_exit", bar.timestamp)
          );
          optionPosition = null;
        }
      }

      if (position || optionPosition) {
        continue;
      }

      const shouldEnter =
        (selector.direction === "long" && cfg.longEnabled && direction === "bullish") ||
        (selector.direction === "short" && cfg.shortEnabled && direction === "bearish");
      if (!shouldEnter || selector.preferredExpression === "none") {
        continue;
      }

      const side: Side = selector.direction === "long" ? "long" : "short";
      const notional = Math.min(cfg.maxNotionalPerTrade, cfg.initialCapital * cfg.positionSize);
      const entryPrice = bar.open;
      const rawStop = side === "long" ? entryPrice * (1 - cfg.stopLoss) : entryPrice * (1 + cfg.stopLoss);
      const rawTake = side === "long" ? entryPrice * (1 + cfg.takeProfit) : entryPrice * (1 - cfg.takeProfit);
      const trailing =
        side === "long" ? entryPrice * (1 - cfg.trailingStop) : entryPrice * (1 + cfg.trailingStop);

      const wantsOptions =
        cfg.optionsEnabled &&
        cfg.aggressiveMode &&
        config.enableAggressivePaperStrategies;

      if (wantsOptions) {
        const optionStrategy =
          selector.preferredExpression === "call_spread"
            ? "call_spread"
            : selector.preferredExpression === "put_spread"
              ? "put_spread"
              : selector.preferredExpression === "long_call" || side === "long"
                ? "long_call"
                : "long_put";

        const opened = buildOptionPosition(symbol, bar.timestamp, side, close, optionStrategy, {
          initialCapital: cfg.initialCapital,
          positionSize: cfg.positionSize,
          maxNotionalPerTrade: cfg.maxNotionalPerTrade,
          stopLoss: cfg.stopLoss,
          takeProfit: cfg.takeProfit,
          trailingStop: cfg.trailingStop
        });

        if (opened) {
          optionPosition = opened;
          continue;
        }
      }

      const positionNotional = Math.max(1, cfg.positionSize * notional);
      const quantity = Math.max(1, Math.floor(notional / (entryPrice * Math.max(positionNotional, 1))));
      position = {
        symbol,
        side,
        entryDate: bar.timestamp,
        entryPrice,
        quantity,
        stopLoss: rawStop,
        takeProfit: rawTake,
        trailingStop: trailing,
        holdDays: 0,
        expression: selector.preferredExpression
      };
    }

    if (optionPosition) {
      // close any open options at final bar for deterministic accounting
      const finalBar = parsedBars[parsedBars.length - 1]!;
      const snapshot = optionSnapshotForSymbol(optionPosition.optionSymbol);
      const premium = estimateOptionPremium(
        optionPosition.strategy,
        finalBar.close,
        optionPosition.strike,
        optionPosition.shortStrike,
        snapshot
      );
      optionTrades.push(
        closeOptionPosition(optionPosition, premium, "time_exit", finalBar.timestamp)
      );
      optionPosition = null;
    }

    if (position) {
      const finalBar = parsedBars[parsedBars.length - 1]!;
      sharesTrades.push(closeSharePosition(position, finalBar.close, "time_exit", finalBar.timestamp));
      position = null;
    }
  }

  const metrics = computeMetrics([...sharesTrades, ...optionTrades]);
  getDb()
    .prepare(
      `
      UPDATE backtest_runs
      SET status = 'completed', completed_at = ?, metrics_json = ?
      WHERE id = ?
      `
    )
    .run(nowIso(), JSON.stringify(metrics), runId);

  const insertTrade = getDb().prepare(`
    INSERT INTO backtest_trades(
      run_id,
      symbol,
      entry_date,
      exit_date,
      entry_price,
      exit_price,
      side,
      quantity,
      pnl,
      return_pct,
      exit_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const trade of sharesTrades) {
    insertTrade.run(
      runId,
      trade.symbol,
      trade.entryDate,
      trade.exitDate,
      trade.entryPrice,
      trade.exitPrice,
      trade.side,
      trade.quantity,
      trade.pnl,
      trade.returnPct,
      trade.exitReason
    );
  }

  const insertOptionTrade = getDb().prepare(`
    INSERT INTO backtest_options_trades(
      run_id,
      underlying_symbol,
      option_symbol,
      strategy,
      entry_date,
      exit_date,
      expiration_date,
      strike,
      short_strike,
      entry_premium,
      exit_premium,
      contracts,
      estimated_max_loss,
      estimated_max_profit,
      pnl,
      return_pct,
      exit_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const trade of optionTrades) {
    insertOptionTrade.run(
      runId,
      trade.underlyingSymbol,
      trade.optionSymbol,
      trade.strategy,
      trade.entryDate,
      trade.exitDate,
      trade.expirationDate ?? null,
      trade.strike ?? null,
      trade.shortStrike ?? null,
      trade.entryPremium,
      trade.exitPremium,
      trade.contracts,
      trade.estimatedMaxLoss,
      trade.estimatedMaxProfit,
      trade.pnl,
      trade.returnPct,
      trade.exitReason
    );
  }

  return { runId, metrics, trades: sharesTrades, optionTrades };
}
