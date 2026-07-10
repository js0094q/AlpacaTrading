import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { queryOne } from "../lib/db.js";
import type { AlpacaAccountSnapshot } from "./alpacaAccountService.js";
import { getAlpacaAccountSnapshot } from "./alpacaAccountService.js";
import type { AlpacaPositionSnapshot } from "./alpacaPositionService.js";
import { listAlpacaPositions } from "./alpacaPositionService.js";
import {
  buildHedgeConfig,
  hedgeConfigurationFingerprint,
  type HedgeConfig
} from "./hedgeConfigService.js";
import {
  latestPortfolioHighWaterMark,
  observePortfolioHighWaterMark
} from "./hedgePersistenceService.js";
import type { HedgeDataQualityStatus } from "./hedgeTypes.js";
import { optionDaysToExpiration, parseOptionSymbol } from "./optionSymbolService.js";
import { portfolioBetasForSymbols } from "./portfolioBetaService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

export interface OptionRiskEvidence {
  multiplier: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  quoteTimestamp: string | null;
}

export interface PositionBetaEvidence {
  beta: number | null;
  status: string;
  warnings: string[];
}

export interface PortfolioRiskEvidence {
  optionEvidence: Record<string, OptionRiskEvidence>;
  underlyingPrices: Record<string, number | null>;
  betas: Record<string, PositionBetaEvidence>;
  highWaterMark: number | null;
  warnings?: string[];
  blockers?: string[];
}

export interface NormalizedRiskPosition {
  symbol: string;
  underlying: string;
  assetClass: "equity" | "option";
  optionType: "call" | "put" | null;
  quantity: number | null;
  marketValue: number | null;
  currentPrice: number | null;
  underlyingPrice: number | null;
  costBasis: number | null;
  unrealizedPl: number | null;
  unrealizedPlPct: number | null;
  sector: string;
  beta: number | null;
  betaStatus: string;
  multiplier: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  expirationDate: string | null;
  strikePrice: number | null;
  daysToExpiration: number | null;
  moneynessPct: number | null;
  deltaEquivalentShares: number | null;
  deltaAdjustedExposure: number | null;
  betaExposure: number | null;
  gammaExposure: number | null;
  thetaExposure: number | null;
  vegaExposure: number | null;
  rhoExposure: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  bidAskSpreadPct: number | null;
  quoteTimestamp: string | null;
  inverseExposure: boolean;
  warnings: string[];
  blockers: string[];
}

export interface PortfolioScenario {
  benchmarkDeclinePct: 5 | 8 | 10 | 15;
  grossModeledLoss: number;
  existingProtection: number;
  netModeledLoss: number | null;
  netModeledLossPct: number | null;
  coverage: number;
  warnings: string[];
}

export interface PortfolioRiskSnapshot {
  paperOnly: true;
  environment: "paper";
  generatedAt: string;
  snapshotId: string;
  sourceAccountSnapshotId: string | null;
  riskModelVersion: string;
  configurationFingerprint: string;
  account: {
    equity: number | null;
    cash: number | null;
    buyingPower: number | null;
    highWaterMark: number | null;
    drawdownPct: number | null;
  };
  positions: NormalizedRiskPosition[];
  exposures: {
    grossExposure: number;
    netExposure: number;
    longExposure: number;
    shortOrInverseExposure: number;
    grossExposurePct: number | null;
    netExposurePct: number | null;
  };
  options: {
    deltaExposure: number | null;
    absoluteDeltaExposure: number | null;
    absoluteDeltaExposurePct: number | null;
    positiveDeltaExposure: number | null;
    positiveDeltaExposurePct: number | null;
    gammaExposure: number | null;
    thetaExposure: number | null;
    vegaExposure: number | null;
    rhoExposure: number | null;
    nearTermExposurePct: number | null;
  };
  concentration: {
    largestUnderlyingWeight: number | null;
    topFiveUnderlyingWeight: number | null;
    byUnderlying: Record<string, number>;
    bySector: Record<string, number>;
    unknownSectorWeight: number | null;
  };
  portfolioBeta: number | null;
  betaCoverage: number;
  scenarios: PortfolioScenario[];
  dataQualityStatus: HedgeDataQualityStatus;
  dataQuality: {
    positionPriceCoverage: number;
    optionDeltaCoverage: number;
    optionGammaCoverage: number;
    optionThetaCoverage: number;
    optionVegaCoverage: number;
    betaCoverage: number;
    sectorCoverage: number;
  };
  warnings: string[];
  blockers: string[];
}

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const signedQuantity = (position: AlpacaPositionSnapshot) => {
  const quantity = numberOrNull(position.qty);
  if (quantity === null) {
    return null;
  }
  return String(position.side || "").toLowerCase() === "short" && quantity > 0
    ? -quantity
    : quantity;
};

const signedMarketValue = (position: AlpacaPositionSnapshot) => {
  const value = numberOrNull(position.marketValue);
  if (value === null) {
    return null;
  }
  return String(position.side || "").toLowerCase() === "short" && value > 0
    ? -value
    : value;
};

const ratio = (numerator: number, denominator: number | null) =>
  denominator !== null && denominator > 0 ? numerator / denominator : null;

const unique = (values: string[]) => [...new Set(values)];

const aggregateObserved = (
  positions: NormalizedRiskPosition[],
  field: "deltaAdjustedExposure" | "gammaExposure" | "thetaExposure" | "vegaExposure" | "rhoExposure"
) => {
  if (!positions.length) {
    return 0;
  }
  const observed = positions.map((position) => position[field]);
  if (observed.some((value) => value === null)) {
    return null;
  }
  return observed.reduce<number>((sum, value) => sum + (value ?? 0), 0);
};

export const normalizePortfolioEvidence = (
  accountInput: AlpacaAccountSnapshot,
  positionInputs: AlpacaPositionSnapshot[],
  evidence: PortfolioRiskEvidence,
  config: HedgeConfig,
  asOf = new Date().toISOString()
): PortfolioRiskSnapshot => {
  const equity = numberOrNull(accountInput.equity ?? accountInput.portfolioValue);
  const cash = numberOrNull(accountInput.cash);
  const buyingPower = numberOrNull(accountInput.buyingPower);
  const normalizedPositions: NormalizedRiskPosition[] = positionInputs.map((position) => {
    const parsed = parseOptionSymbol(position.symbol);
    const isOption =
      String(position.assetClass || "").toLowerCase().includes("option") || parsed.ok;
    const quantity = signedQuantity(position);
    const currentPrice = numberOrNull(position.currentPrice);
    let marketValue = signedMarketValue(position);
    const warnings: string[] = [];
    const blockers: string[] = [];
    if (marketValue === null && quantity !== null && currentPrice !== null) {
      marketValue = quantity * currentPrice;
      warnings.push("MARKET_VALUE_DERIVED_FROM_OBSERVED_PRICE");
    }
    const underlying = parsed.ok ? parsed.underlying : position.symbol.trim().toUpperCase();
    const optionEvidence = parsed.ok
      ? evidence.optionEvidence[parsed.normalizedSymbol] ?? null
      : null;
    if (isOption && !parsed.ok) {
      warnings.push("OPTION_SYMBOL_PARSE_FAILED");
    }
    const underlyingPrice =
      evidence.underlyingPrices[underlying] ?? (!isOption ? currentPrice : null);
    const multiplier = isOption ? optionEvidence?.multiplier ?? null : null;
    const delta = isOption ? optionEvidence?.delta ?? null : null;
    const gamma = isOption ? optionEvidence?.gamma ?? null : null;
    const theta = isOption ? optionEvidence?.theta ?? null : null;
    const vega = isOption ? optionEvidence?.vega ?? null : null;
    const rho = isOption ? optionEvidence?.rho ?? null : null;
    if (isOption && delta === null) warnings.push("OPTION_DELTA_UNAVAILABLE");
    if (isOption && gamma === null) warnings.push("OPTION_GAMMA_UNAVAILABLE");
    if (isOption && theta === null) warnings.push("OPTION_THETA_UNAVAILABLE");
    if (isOption && vega === null) warnings.push("OPTION_VEGA_UNAVAILABLE");
    if (underlyingPrice === null) warnings.push("UNDERLYING_PRICE_UNAVAILABLE");
    if (marketValue === null) warnings.push("POSITION_PRICE_UNAVAILABLE");
    const deltaEquivalentShares =
      isOption && quantity !== null && multiplier !== null && delta !== null
        ? quantity * multiplier * delta
        : null;
    const deltaAdjustedExposure = isOption
      ? deltaEquivalentShares !== null && underlyingPrice !== null
        ? deltaEquivalentShares * underlyingPrice
        : null
      : marketValue;
    const betaEvidence = evidence.betas[underlying];
    const beta = betaEvidence?.beta ?? null;
    if (beta === null && deltaAdjustedExposure !== null && deltaAdjustedExposure !== 0) {
      warnings.push("POSITION_BETA_UNAVAILABLE");
    }
    const gammaExposure =
      isOption && quantity !== null && multiplier !== null && gamma !== null
        ? quantity * multiplier * gamma
        : isOption
          ? null
          : 0;
    const thetaExposure =
      isOption && quantity !== null && multiplier !== null && theta !== null
        ? quantity * multiplier * theta
        : isOption
          ? null
          : 0;
    const vegaExposure =
      isOption && quantity !== null && multiplier !== null && vega !== null
        ? quantity * multiplier * vega
        : isOption
          ? null
          : 0;
    const rhoExposure =
      isOption && quantity !== null && multiplier !== null && rho !== null
        ? quantity * multiplier * rho
        : isOption
          ? null
          : 0;
    const bid = optionEvidence?.bid ?? null;
    const ask = optionEvidence?.ask ?? null;
    const midpoint = optionEvidence?.midpoint ?? null;
    const bidAskSpreadPct =
      bid !== null && ask !== null && midpoint !== null && midpoint > 0 && ask >= bid
        ? (ask - bid) / midpoint
        : null;
    const sector = config.sectorMap[underlying] ?? "unknown";
    const daysToExpiration = parsed.ok
      ? optionDaysToExpiration(parsed.expirationDate, asOf)
      : null;
    return {
      symbol: position.symbol.trim().toUpperCase(),
      underlying,
      assetClass: isOption ? "option" : "equity",
      optionType: parsed.ok ? parsed.optionType : null,
      quantity,
      marketValue,
      currentPrice,
      underlyingPrice,
      costBasis: numberOrNull(position.costBasis),
      unrealizedPl: numberOrNull(position.unrealizedPl),
      unrealizedPlPct: numberOrNull(position.unrealizedPlpc),
      sector,
      beta,
      betaStatus: betaEvidence?.status ?? "unavailable",
      multiplier,
      delta,
      gamma,
      theta,
      vega,
      rho,
      expirationDate: parsed.ok ? parsed.expirationDate : null,
      strikePrice: parsed.ok ? parsed.strikePrice : null,
      daysToExpiration,
      moneynessPct:
        parsed.ok && underlyingPrice !== null && underlyingPrice > 0
          ? (parsed.strikePrice - underlyingPrice) / underlyingPrice
          : null,
      deltaEquivalentShares,
      deltaAdjustedExposure,
      betaExposure:
        deltaAdjustedExposure !== null && beta !== null
          ? deltaAdjustedExposure * beta
          : null,
      gammaExposure,
      thetaExposure,
      vegaExposure,
      rhoExposure,
      bid,
      ask,
      midpoint,
      bidAskSpreadPct,
      quoteTimestamp: optionEvidence?.quoteTimestamp ?? null,
      inverseExposure: underlying === "SH" || underlying === "PSQ",
      warnings: unique([...warnings, ...(betaEvidence?.warnings ?? [])]),
      blockers
    };
  });

  const measuredExposures = normalizedPositions
    .map((position) => position.deltaAdjustedExposure)
    .filter((value): value is number => value !== null);
  const grossExposure = measuredExposures.reduce((sum, value) => sum + Math.abs(value), 0);
  const netExposure = measuredExposures.reduce((sum, value) => sum + value, 0);
  const longExposure = measuredExposures.reduce((sum, value) => sum + Math.max(0, value), 0);
  const shortOrInverseExposure = measuredExposures.reduce(
    (sum, value) => sum + Math.abs(Math.min(0, value)),
    0
  );
  const optionPositions = normalizedPositions.filter((position) => position.assetClass === "option");
  const deltaExposure = aggregateObserved(optionPositions, "deltaAdjustedExposure");
  const absoluteDeltaExposure =
    deltaExposure === null
      ? null
      : optionPositions.reduce(
          (sum, position) => sum + Math.abs(position.deltaAdjustedExposure ?? 0),
          0
        );
  const positiveDeltaExposure =
    deltaExposure === null
      ? null
      : optionPositions.reduce(
          (sum, position) => sum + Math.max(0, position.deltaAdjustedExposure ?? 0),
          0
        );
  const nearTermExposure = optionPositions.reduce((sum, position) => {
    return position.daysToExpiration !== null && position.daysToExpiration <= 90
      ? sum + Math.abs(position.deltaAdjustedExposure ?? 0)
      : sum;
  }, 0);

  const underlyingExposure: Record<string, number> = {};
  const sectorExposure: Record<string, number> = {};
  for (const position of normalizedPositions) {
    const exposure = Math.abs(position.deltaAdjustedExposure ?? 0);
    underlyingExposure[position.underlying] =
      (underlyingExposure[position.underlying] ?? 0) + exposure;
    sectorExposure[position.sector] = (sectorExposure[position.sector] ?? 0) + exposure;
  }
  const byUnderlying = Object.fromEntries(
    Object.entries(underlyingExposure).map(([key, value]) => [key, ratio(value, equity) ?? 0])
  );
  const bySector = Object.fromEntries(
    Object.entries(sectorExposure).map(([key, value]) => [key, ratio(value, equity) ?? 0])
  );
  const underlyingWeights = Object.values(byUnderlying).sort((left, right) => right - left);

  const betaMeasuredExposure = normalizedPositions.reduce(
    (sum, position) =>
      sum + (position.betaExposure === null ? 0 : Math.abs(position.deltaAdjustedExposure ?? 0)),
    0
  );
  const betaCoverage = grossExposure > 0 ? betaMeasuredExposure / grossExposure : 1;
  const portfolioBeta =
    equity !== null && equity > 0 && betaCoverage >= config.beta.minimumCoverage
      ? normalizedPositions.reduce((sum, position) => sum + (position.betaExposure ?? 0), 0) /
        equity
      : null;

  const scenarios = ([5, 8, 10, 15] as const).map((benchmarkDeclinePct) => {
    let grossModeledLoss = 0;
    let existingProtection = 0;
    for (const position of normalizedPositions) {
      if (position.betaExposure === null) {
        continue;
      }
      const decline = benchmarkDeclinePct / 100;
      let modeledPnl = position.betaExposure * -decline;
      if (
        position.assetClass === "option" &&
        position.gammaExposure !== null &&
        position.underlyingPrice !== null
      ) {
        modeledPnl +=
          0.5 *
          position.gammaExposure *
          (position.underlyingPrice * decline) ** 2;
      }
      if (modeledPnl < 0) {
        grossModeledLoss += Math.abs(modeledPnl);
      } else {
        existingProtection += modeledPnl;
      }
    }
    const netModeledLoss =
      grossExposure === 0 || betaMeasuredExposure > 0
        ? Math.max(0, grossModeledLoss - existingProtection)
        : null;
    return {
      benchmarkDeclinePct,
      grossModeledLoss,
      existingProtection,
      netModeledLoss,
      netModeledLossPct:
        netModeledLoss !== null && equity !== null && equity > 0
          ? netModeledLoss / equity
          : null,
      coverage: betaCoverage,
      warnings:
        betaCoverage < config.beta.minimumCoverage
          ? ["SCENARIO_BETA_COVERAGE_INSUFFICIENT"]
          : []
    };
  });

  const positionCount = normalizedPositions.length;
  const priceCoverage = positionCount
    ? normalizedPositions.filter((position) => position.marketValue !== null).length / positionCount
    : 1;
  const coverageFor = (field: "delta" | "gamma" | "theta" | "vega") =>
    optionPositions.length
      ? optionPositions.filter((position) => position[field] !== null).length / optionPositions.length
      : 1;
  const sectorCoverage = positionCount
    ? normalizedPositions.filter((position) => position.sector !== "unknown").length / positionCount
    : 1;
  const dataQuality = {
    positionPriceCoverage: priceCoverage,
    optionDeltaCoverage: coverageFor("delta"),
    optionGammaCoverage: coverageFor("gamma"),
    optionThetaCoverage: coverageFor("theta"),
    optionVegaCoverage: coverageFor("vega"),
    betaCoverage,
    sectorCoverage
  };
  const blockers = [...(evidence.blockers ?? [])];
  if (equity === null || equity <= 0) blockers.push("PORTFOLIO_EQUITY_UNAVAILABLE");
  const warnings = unique([
    ...(evidence.warnings ?? []),
    ...config.warnings,
    ...normalizedPositions.flatMap((position) => position.warnings),
    ...(betaCoverage < config.beta.minimumCoverage
      ? ["PORTFOLIO_BETA_COVERAGE_INSUFFICIENT"]
      : []),
    ...(dataQuality.optionDeltaCoverage < 1 ||
    dataQuality.optionGammaCoverage < 1 ||
    dataQuality.optionThetaCoverage < 1 ||
    dataQuality.optionVegaCoverage < 1
      ? ["OPTION_GREEKS_COVERAGE_PARTIAL"]
      : []),
    ...(sectorCoverage < 1 ? ["SECTOR_COVERAGE_PARTIAL"] : [])
  ]);
  const dataQualityStatus: HedgeDataQualityStatus = blockers.length
    ? "blocked"
    : priceCoverage < 1 ||
        dataQuality.optionDeltaCoverage < 1 ||
        betaCoverage < config.beta.minimumCoverage
      ? "monitoring"
      : warnings.length
        ? "partial"
        : "complete";

  const highWaterMark =
    equity !== null && evidence.highWaterMark !== null
      ? Math.max(equity, evidence.highWaterMark)
      : evidence.highWaterMark ?? equity;
  const accountSnapshot = {
    equity,
    cash,
    buyingPower,
    highWaterMark,
    drawdownPct:
      equity !== null && highWaterMark !== null && highWaterMark > 0
        ? Math.max(0, (highWaterMark - equity) / highWaterMark)
        : null
  };
  const configurationFingerprint = hedgeConfigurationFingerprint(config);
  const sourceAccountSnapshotId = accountInput.id
    ? canonicalJsonHash({
        environment: "paper",
        accountId: accountInput.id,
        accountCreatedAt: accountInput.createdAt ?? null
      })
    : null;
  const snapshotId = canonicalJsonHash({
    environment: "paper",
    account: accountSnapshot,
    positions: normalizedPositions,
    riskModelVersion: config.riskModelVersion,
    configurationFingerprint
  });

  return {
    paperOnly: true,
    environment: "paper",
    generatedAt: asOf,
    snapshotId,
    sourceAccountSnapshotId,
    riskModelVersion: config.riskModelVersion,
    configurationFingerprint,
    account: accountSnapshot,
    positions: normalizedPositions,
    exposures: {
      grossExposure,
      netExposure,
      longExposure,
      shortOrInverseExposure,
      grossExposurePct: ratio(grossExposure, equity),
      netExposurePct: equity !== null && equity > 0 ? netExposure / equity : null
    },
    options: {
      deltaExposure,
      absoluteDeltaExposure,
      absoluteDeltaExposurePct:
        absoluteDeltaExposure === null ? null : ratio(absoluteDeltaExposure, equity),
      positiveDeltaExposure,
      positiveDeltaExposurePct:
        positiveDeltaExposure === null ? null : ratio(positiveDeltaExposure, equity),
      gammaExposure: aggregateObserved(optionPositions, "gammaExposure"),
      thetaExposure: aggregateObserved(optionPositions, "thetaExposure"),
      vegaExposure: aggregateObserved(optionPositions, "vegaExposure"),
      rhoExposure: aggregateObserved(optionPositions, "rhoExposure"),
      nearTermExposurePct:
        deltaExposure === null ? null : ratio(nearTermExposure, equity)
    },
    concentration: {
      largestUnderlyingWeight: equity !== null ? underlyingWeights[0] ?? 0 : null,
      topFiveUnderlyingWeight:
        equity !== null
          ? underlyingWeights.slice(0, 5).reduce((sum, value) => sum + value, 0)
          : null,
      byUnderlying,
      bySector,
      unknownSectorWeight:
        equity !== null ? bySector.unknown ?? 0 : null
    },
    portfolioBeta,
    betaCoverage,
    scenarios,
    dataQualityStatus,
    dataQuality,
    warnings,
    blockers: unique(blockers)
  };
};

interface OptionEvidenceRow {
  multiplier: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  quote_timestamp: string | null;
  timestamp: string | null;
}

const latestOptionEvidence = (symbol: string): OptionRiskEvidence => {
  const row = queryOne<OptionEvidenceRow>(
    `
    SELECT c.multiplier, s.delta, s.gamma, s.theta, s.vega, s.rho,
           s.bid, s.ask, s.midpoint, s.quote_timestamp, s.timestamp
    FROM option_contracts c
    LEFT JOIN option_snapshots s
      ON s.option_symbol = c.option_symbol
     AND s.timestamp = (
       SELECT MAX(latest.timestamp)
       FROM option_snapshots latest
       WHERE latest.option_symbol = c.option_symbol
     )
    WHERE c.option_symbol = ?
    LIMIT 1
    `,
    [symbol]
  );
  return {
    multiplier: numberOrNull(row?.multiplier) ?? 100,
    delta: numberOrNull(row?.delta),
    gamma: numberOrNull(row?.gamma),
    theta: numberOrNull(row?.theta),
    vega: numberOrNull(row?.vega),
    rho: numberOrNull(row?.rho),
    bid: numberOrNull(row?.bid),
    ask: numberOrNull(row?.ask),
    midpoint: numberOrNull(row?.midpoint),
    quoteTimestamp: row?.quote_timestamp ?? row?.timestamp ?? null
  };
};

const latestUnderlyingPrice = (symbol: string) => {
  const row = queryOne<{ close: number }>(
    `SELECT close FROM market_bars
     WHERE symbol = ? AND timeframe = '1Day'
     ORDER BY timestamp DESC LIMIT 1`,
    [symbol]
  );
  return numberOrNull(row?.close);
};

export interface PortfolioRiskDeps {
  getAccount?: typeof getAlpacaAccountSnapshot;
  getPositions?: typeof listAlpacaPositions;
}

export const buildPortfolioRiskSnapshot = async (
  input: { config?: HedgeConfig; asOf?: string } = {},
  deps: PortfolioRiskDeps = {}
): Promise<PortfolioRiskSnapshot> => {
  const config = input.config ?? buildHedgeConfig();
  const asOf = input.asOf ?? new Date().toISOString();
  const safety = getTradingSafetyState();
  if (safety.alpacaEnv !== "paper" || safety.liveTradingEnabled) {
    return normalizePortfolioEvidence(
      {},
      [],
      {
        optionEvidence: {},
        underlyingPrices: {},
        betas: {},
        highWaterMark: null,
        blockers: ["HEDGE_PAPER_ENVIRONMENT_REQUIRED"]
      },
      config,
      asOf
    );
  }
  try {
    const [account, positionResult] = await Promise.all([
      (deps.getAccount ?? getAlpacaAccountSnapshot)(),
      (deps.getPositions ?? listAlpacaPositions)()
    ]);
    const positions = positionResult.positions;
    const underlyings = unique(
      positions.map((position) => {
        const parsed = parseOptionSymbol(position.symbol);
        return parsed.ok ? parsed.underlying : position.symbol.trim().toUpperCase();
      })
    );
    const betas = portfolioBetasForSymbols({ symbols: underlyings, config, asOf });
    const optionEvidence = Object.fromEntries(
      positions
        .map((position) => parseOptionSymbol(position.symbol))
        .filter((parsed) => parsed.ok)
        .map((parsed) => [parsed.normalizedSymbol, latestOptionEvidence(parsed.normalizedSymbol)])
    );
    const underlyingPrices = Object.fromEntries(
      underlyings.map((symbol) => [symbol, latestUnderlyingPrice(symbol)])
    );
    const equity = numberOrNull(account.equity ?? account.portfolioValue);
    let highWaterMark = latestPortfolioHighWaterMark("paper")?.equity ?? null;
    if (equity !== null && equity > 0) {
      highWaterMark = observePortfolioHighWaterMark({
        environment: "paper",
        equity,
        observedAt: asOf
      }).equity;
    }
    return normalizePortfolioEvidence(
      account,
      positions,
      {
        optionEvidence,
        underlyingPrices,
        betas,
        highWaterMark
      },
      config,
      asOf
    );
  } catch {
    return normalizePortfolioEvidence(
      {},
      [],
      {
        optionEvidence: {},
        underlyingPrices: {},
        betas: {},
        highWaterMark: null,
        warnings: ["PAPER_ACCOUNT_READ_FAILED"],
        blockers: ["PAPER_ACCOUNT_UNAVAILABLE"]
      },
      config,
      asOf
    );
  }
};
