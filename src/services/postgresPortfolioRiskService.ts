import { AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS } from "./autonomousFreshnessPolicy.js";
import {
  classifyManagedOptionLane,
  resolveManagedLeapsMinDte
} from "./optionLanePolicy.js";

type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  readonly rows: Row[];
  readonly rowCount: number | null;
};

export interface PostgresPortfolioRiskQuery {
  query(
    statement: string,
    values?: readonly unknown[]
  ): Promise<QueryResult>;
}

export const isPostgresPortfolioGreekReviewCommand = (
  command: unknown
): command is "paper:portfolio:review" | "hedge:review" =>
  command === "paper:portfolio:review" || command === "hedge:review";

type AccountRow = {
  account_id: unknown;
  account_snapshot_id: unknown;
  observed_at: unknown;
  equity: unknown;
  portfolio_value: unknown;
  snapshot_fingerprint: unknown;
  account_record_status: unknown;
  account_status: unknown;
  account_source: unknown;
};

type PositionRow = {
  position_id: unknown;
  symbol: unknown;
  underlying_symbol: unknown;
  option_symbol: unknown;
  side: unknown;
  quantity: unknown;
  market_value: unknown;
  expiration_date: unknown;
  multiplier: unknown;
  option_type: unknown;
  last_reconciled_at: unknown;
  option_observed_at: unknown;
  quote_timestamp: unknown;
  requested_feed: unknown;
  effective_feed: unknown;
  option_source: unknown;
  option_underlying_price: unknown;
  stock_underlying_price: unknown;
  stock_observed_at: unknown;
  stock_source_timestamp: unknown;
  stock_requested_feed: unknown;
  stock_effective_feed: unknown;
  stock_source: unknown;
  stock_snapshot_id: unknown;
  implied_volatility: unknown;
  delta: unknown;
  gamma: unknown;
  theta: unknown;
  vega: unknown;
  rho: unknown;
};

type GreekMetric = "delta" | "gamma" | "theta" | "vega" | "rho";
type PremiumMetric = GreekMetric | "impliedVolatility";
type ExposureMetric =
  | "deltaShares"
  | "deltaDollars"
  | "gammaSharesPerDollar"
  | "thetaDollarsPerDay"
  | "vegaDollarsPerVolPoint"
  | "rhoDollarsPerRatePoint";
type ManagedOptionLane = ReturnType<typeof classifyManagedOptionLane>;
type PortfolioOptionLane = ManagedOptionLane | "unknown";

const ACCOUNT_SQL = `SELECT account.id AS account_id,
       snapshot.id AS account_snapshot_id, snapshot.observed_at,
       snapshot.equity::text, snapshot.portfolio_value::text,
       snapshot.snapshot_fingerprint,
       account.status AS account_record_status,
       snapshot.account_status, snapshot.source AS account_source
FROM accounts account
JOIN LATERAL (
  SELECT current_snapshot.*
  FROM account_snapshots current_snapshot
  WHERE current_snapshot.account_id = account.id
  ORDER BY current_snapshot.observed_at DESC, current_snapshot.id DESC
  LIMIT 1
) snapshot ON true
WHERE account.broker = 'alpaca' AND account.environment = 'paper'
ORDER BY account.updated_at DESC, account.id
LIMIT 1`;

const OPTION_POSITIONS_SQL = `SELECT position.id AS position_id, position.symbol,
       COALESCE(position.underlying_symbol, contract.underlying_symbol) AS underlying_symbol,
       COALESCE(position.option_symbol, position.symbol) AS option_symbol,
       position.side, position.quantity::text, position.market_value::text,
       position.last_reconciled_at,
       contract.expiration_date, contract.multiplier::text,
       contract.type AS option_type,
       option_snapshot.observed_at AS option_observed_at,
       option_snapshot.quote_timestamp,
       option_snapshot.evidence->>'requestedFeed' AS requested_feed,
       option_snapshot.evidence->>'effectiveFeed' AS effective_feed,
       option_snapshot.source AS option_source,
       option_snapshot.evidence->>'underlyingPrice' AS option_underlying_price,
       COALESCE(
         stock.evidence->>'midpoint',
         stock.evidence->>'latestTradePrice',
         stock.evidence->>'dailyClose'
       ) AS stock_underlying_price,
       stock.observed_at AS stock_observed_at,
       stock.source_timestamp AS stock_source_timestamp,
       stock.requested_feed AS stock_requested_feed,
       stock.effective_feed AS stock_effective_feed,
       stock.source AS stock_source,
       stock.id AS stock_snapshot_id,
       option_snapshot.implied_volatility::text,
       option_snapshot.delta::text, option_snapshot.gamma::text,
       option_snapshot.theta::text, option_snapshot.vega::text,
       option_snapshot.rho::text
FROM positions position
LEFT JOIN option_contracts contract
  ON contract.option_symbol = COALESCE(position.option_symbol, position.symbol)
LEFT JOIN LATERAL (
  SELECT current_option.*
  FROM option_snapshots current_option
  WHERE current_option.option_symbol = contract.option_symbol
  ORDER BY current_option.observed_at DESC
  LIMIT 1
) option_snapshot ON true
LEFT JOIN LATERAL (
  SELECT current_stock.*
  FROM stock_snapshots current_stock
  WHERE current_stock.symbol = contract.underlying_symbol
  ORDER BY current_stock.observed_at DESC, current_stock.id DESC
  LIMIT 1
) stock ON true
WHERE position.account_id = $1
  AND position.asset_class = 'option'
  AND position.status IN ('open', 'closing')
ORDER BY position.opened_at, position.id`;

const textValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const numberValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isoValue = (value: unknown) => {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const unique = (values: readonly string[]) => [...new Set(values)];

const isCurrent = (value: unknown, now: Date) => {
  const timestamp = isoValue(value);
  if (timestamp === null) return false;
  const ageSeconds = (now.getTime() - Date.parse(timestamp)) / 1_000;
  return Number.isFinite(ageSeconds) && ageSeconds >= 0 &&
    ageSeconds <= AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS;
};

type NormalizedPosition = {
  positionId: string;
  optionSymbol: string;
  underlyingSymbol: string;
  lane: PortfolioOptionLane;
  quantity: number;
  absoluteQuantity: number;
  marketValue: number | null;
  evidenceTimestamp: string | null;
  evidenceCurrent: boolean;
  feedValidated: boolean;
  baseExposureUsable: boolean;
  values: Record<PremiumMetric, number | null>;
  exposures: Record<ExposureMetric, number | null>;
  blockers: string[];
  evidenceReferences: string[];
};

const aggregateNullable = (
  positions: readonly NormalizedPosition[],
  metric: ExposureMetric
) => positions.length > 0 && positions.every((position) => position.exposures[metric] !== null)
  ? positions.reduce((sum, position) => sum + position.exposures[metric]!, 0)
  : null;

const riskSummary = (
  positions: readonly NormalizedPosition[],
  additionalBlockers: readonly string[] = [],
  authorityUsable = additionalBlockers.length === 0
) => {
  const totalContracts = positions.reduce((sum, position) => sum + position.absoluteQuantity, 0);
  const exposureMetric = (metric: GreekMetric) => ({
    delta: "deltaShares",
    gamma: "gammaSharesPerDollar",
    theta: "thetaDollarsPerDay",
    vega: "vegaDollarsPerVolPoint",
    rho: "rhoDollarsPerRatePoint"
  } as const)[metric];
  const coverageUsable = (
    position: NormalizedPosition,
    metric: PremiumMetric | "deltaDollars"
  ) => authorityUsable && (
    metric === "impliedVolatility"
      ? position.baseExposureUsable && position.values.impliedVolatility !== null
      : metric === "deltaDollars"
        ? position.exposures.deltaDollars !== null
        : position.exposures[exposureMetric(metric)] !== null
  );
  const contractCoverage = (metric: PremiumMetric | "deltaDollars") =>
    authorityUsable
      ? positions.reduce(
          (sum, position) => sum + (
            coverageUsable(position, metric) ? position.absoluteQuantity : 0
          ),
          0
        )
      : null;
  const totalMarketValue = positions.every((position) => position.marketValue !== null)
    ? positions.reduce((sum, position) => sum + Math.abs(position.marketValue!), 0)
    : null;
  const marketValueCoverage = (metric: PremiumMetric | "deltaDollars") =>
    !authorityUsable || totalMarketValue === null
    ? null
    : positions.reduce((sum, position) => sum + (
      coverageUsable(position, metric)
        ? Math.abs(position.marketValue!)
        : 0
    ), 0);
  const blockers = unique([
    ...positions.flatMap((position) => position.blockers),
    ...additionalBlockers
  ]);
  const weightedImpliedVolatility = authorityUsable && totalMarketValue !== null &&
      totalMarketValue > 0 &&
      positions.every((position) =>
        position.evidenceCurrent && position.feedValidated &&
        position.values.impliedVolatility !== null && position.marketValue !== null
      )
    ? positions.reduce((sum, position) =>
        sum + Math.abs(position.marketValue!) * position.values.impliedVolatility!, 0
      ) / totalMarketValue
    : null;
  const totals = {
    deltaShares: authorityUsable ? aggregateNullable(positions, "deltaShares") : null,
    deltaDollars: authorityUsable ? aggregateNullable(positions, "deltaDollars") : null,
    gammaSharesPerDollar: authorityUsable
      ? aggregateNullable(positions, "gammaSharesPerDollar") : null,
    thetaDollarsPerDay: authorityUsable
      ? aggregateNullable(positions, "thetaDollarsPerDay") : null,
    vegaDollarsPerVolPoint: authorityUsable
      ? aggregateNullable(positions, "vegaDollarsPerVolPoint") : null,
    rhoDollarsPerRatePoint: authorityUsable
      ? aggregateNullable(positions, "rhoDollarsPerRatePoint") : null,
    weightedImpliedVolatility
  };
  return {
    quality: blockers.length === 0 && Object.values(totals).every((value) => value !== null)
      ? "complete" as const
      : "incomplete" as const,
    positionCount: positions.length,
    totals,
    coverage: {
      contracts: {
        total: authorityUsable ? totalContracts : null,
        deltaShares: contractCoverage("delta"),
        deltaDollars: contractCoverage("deltaDollars"),
        gamma: contractCoverage("gamma"),
        theta: contractCoverage("theta"),
        vega: contractCoverage("vega"),
        rho: contractCoverage("rho"),
        impliedVolatility: contractCoverage("impliedVolatility")
      },
      marketValue: {
        total: authorityUsable ? totalMarketValue : null,
        deltaShares: marketValueCoverage("delta"),
        deltaDollars: marketValueCoverage("deltaDollars"),
        gamma: marketValueCoverage("gamma"),
        theta: marketValueCoverage("theta"),
        vega: marketValueCoverage("vega"),
        rho: marketValueCoverage("rho"),
        impliedVolatility: marketValueCoverage("impliedVolatility")
      }
    },
    blockers,
    evidenceReferences: unique(
      positions.flatMap((position) => position.evidenceReferences)
    )
  };
};

const normalizePosition = (
  row: PositionRow,
  now: Date,
  managedLeapsMinDte: number
): NormalizedPosition => {
  const positionId = textValue(row.position_id) ?? "unknown-position";
  const optionSymbol = textValue(row.option_symbol) ?? textValue(row.symbol) ?? "unknown-option";
  const underlyingSymbol = textValue(row.underlying_symbol) ?? "unknown-underlying";
  const expirationDate = isoValue(row.expiration_date)?.slice(0, 10) ??
    textValue(row.expiration_date) ?? "";
  const evidenceTimestamp = isoValue(row.quote_timestamp) ?? isoValue(row.option_observed_at);
  const evidenceAgeSeconds = evidenceTimestamp === null
    ? null
    : (now.getTime() - Date.parse(evidenceTimestamp)) / 1_000;
  const evidenceCurrent = evidenceAgeSeconds !== null &&
    Number.isFinite(evidenceAgeSeconds) && evidenceAgeSeconds >= 0 &&
    evidenceAgeSeconds <= AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS;
  const positionEvidenceCurrent = isCurrent(row.last_reconciled_at, now);
  const requestedFeed = textValue(row.requested_feed)?.toLowerCase();
  const effectiveFeed = textValue(row.effective_feed)?.toLowerCase();
  const source = textValue(row.option_source)?.toLowerCase();
  const feedValidated = requestedFeed === "opra" && effectiveFeed === "opra" &&
    (source === "alpaca" || source === "alpaca_opra_stream");
  const quantity = numberValue(row.quantity);
  const multiplier = numberValue(row.multiplier);
  const optionUnderlyingPrice = numberValue(row.option_underlying_price);
  const optionUnderlyingUsable = optionUnderlyingPrice !== null && optionUnderlyingPrice > 0 &&
    evidenceCurrent && feedValidated;
  const stockUnderlyingPrice = numberValue(row.stock_underlying_price);
  const stockEvidenceTimestamp = isoValue(row.stock_source_timestamp) ??
    isoValue(row.stock_observed_at);
  const stockEvidenceUsable = stockUnderlyingPrice !== null && stockUnderlyingPrice > 0 &&
    isCurrent(stockEvidenceTimestamp, now) &&
    textValue(row.stock_requested_feed)?.toLowerCase() === "sip" &&
    textValue(row.stock_effective_feed)?.toLowerCase() === "sip" &&
    textValue(row.stock_source)?.toLowerCase() === "alpaca";
  const underlyingPrice = optionUnderlyingUsable
    ? optionUnderlyingPrice
    : stockEvidenceUsable
      ? stockUnderlyingPrice
      : null;
  const usedStockUnderlying = !optionUnderlyingUsable && stockEvidenceUsable;
  const side = textValue(row.side)?.toLowerCase();
  const signedQuantity = quantity === null || (side !== "long" && side !== "short")
    ? null
    : (side === "short" ? -quantity : quantity);
  const values = {
    delta: numberValue(row.delta),
    gamma: numberValue(row.gamma),
    theta: numberValue(row.theta),
    vega: numberValue(row.vega),
    rho: numberValue(row.rho),
    impliedVolatility: numberValue(row.implied_volatility)
  };
  const usable = evidenceCurrent && positionEvidenceCurrent && feedValidated &&
    signedQuantity !== null && multiplier !== null;
  const scaled = (metric: GreekMetric) => usable && values[metric] !== null
    ? signedQuantity * multiplier * values[metric]
    : null;
  const deltaShares = scaled("delta");
  const blockers: string[] = [];
  if (!evidenceCurrent) blockers.push("PORTFOLIO_GREEK_EVIDENCE_STALE");
  if (!positionEvidenceCurrent) blockers.push("PORTFOLIO_POSITION_EVIDENCE_STALE");
  if (!feedValidated) blockers.push("PORTFOLIO_OPRA_FEED_INVALID");
  if (side !== "long" && side !== "short") {
    blockers.push("PORTFOLIO_POSITION_SIDE_INVALID");
  }
  if (quantity === null || multiplier === null ||
      (["delta", "gamma", "theta", "vega", "rho"] as const)
        .some((metric) => values[metric] === null)) {
    blockers.push("PORTFOLIO_GREEKS_INCOMPLETE");
  }
  if (values.impliedVolatility === null) {
    blockers.push("PORTFOLIO_IMPLIED_VOLATILITY_MISSING");
  }
  if (underlyingPrice === null) {
    blockers.push("PORTFOLIO_UNDERLYING_PRICE_EVIDENCE_INVALID");
  }
  let lane: PortfolioOptionLane = "unknown";
  try {
    lane = classifyManagedOptionLane({
      expirationDate,
      observedAt: now.toISOString(),
      managedLeapsMinDte
    });
  } catch {
    blockers.push("PORTFOLIO_OPTION_CONTRACT_MISSING");
  }
  if (multiplier === null || !["call", "put"].includes(textValue(row.option_type) ?? "")) {
    blockers.push("PORTFOLIO_OPTION_CONTRACT_MISSING");
  }
  if (lane === "expired") blockers.push("PORTFOLIO_OPTION_EXPIRED");
  return {
    positionId,
    optionSymbol,
    underlyingSymbol,
    lane,
    quantity: signedQuantity ?? 0,
    absoluteQuantity: quantity === null ? 0 : Math.abs(quantity),
    marketValue: numberValue(row.market_value),
    evidenceTimestamp,
    evidenceCurrent: evidenceCurrent && positionEvidenceCurrent,
    feedValidated,
    baseExposureUsable: usable,
    values,
    exposures: {
      deltaShares,
      deltaDollars: deltaShares !== null && underlyingPrice !== null
        ? deltaShares * underlyingPrice
        : null,
      gammaSharesPerDollar: scaled("gamma"),
      thetaDollarsPerDay: scaled("theta"),
      vegaDollarsPerVolPoint: scaled("vega"),
      rhoDollarsPerRatePoint: scaled("rho")
    },
    blockers: unique(blockers),
    evidenceReferences: unique([
      ...(isoValue(row.option_observed_at) === null
        ? []
        : [`postgres:option_snapshot:${optionSymbol}:${isoValue(row.option_observed_at)}`]),
      ...(usedStockUnderlying &&
          textValue(row.stock_snapshot_id) && isoValue(row.stock_observed_at)
        ? [`postgres:stock_snapshot:${textValue(row.stock_snapshot_id)}:${isoValue(row.stock_observed_at)}`]
        : [])
    ])
  };
};

export const runPostgresPortfolioGreekReview = async (input: {
  readonly command: "paper:portfolio:review" | "hedge:review";
  readonly cycleId: string;
  readonly query: PostgresPortfolioRiskQuery;
  readonly now?: Date;
}) => {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("POSTGRES_PORTFOLIO_RISK_TIME_INVALID");
  const accountResult = await input.query.query(ACCOUNT_SQL);
  const account = accountResult.rows[0] as AccountRow | undefined;
  const accountId = account ? textValue(account.account_id) : null;
  const accountSnapshotId = account ? textValue(account.account_snapshot_id) : null;
  if (!accountId || !accountSnapshotId) {
    throw new Error("POSTGRES_PORTFOLIO_ACCOUNT_UNAVAILABLE");
  }
  const positionResult = await input.query.query(OPTION_POSITIONS_SQL, [accountId]);
  const accountBlockers = [
    ...(!isCurrent(account?.observed_at, now)
      ? ["PORTFOLIO_ACCOUNT_EVIDENCE_STALE"]
      : []),
    ...(textValue(account?.account_record_status)?.toLowerCase() !== "active" ||
        textValue(account?.account_status)?.toLowerCase() !== "active"
      ? ["PORTFOLIO_ACCOUNT_STATUS_INVALID"]
      : []),
    ...(textValue(account?.account_source)?.toLowerCase() !== "alpaca"
      ? ["PORTFOLIO_ACCOUNT_SOURCE_INVALID"]
      : [])
  ];
  const accountAuthorityUsable = accountBlockers.length === 0;
  const positions = positionResult.rows.map((row) => normalizePosition(
    row as PositionRow,
    now,
    resolveManagedLeapsMinDte(process.env.LEAPS_MIN_DTE_AT_ENTRY)
  ));
  const byLaneEntries = (["options_0dte", "options_standard", "options_leaps"] as const)
    .map((lane) => [lane, positions.filter((position) => position.lane === lane)] as const)
    .filter(([, lanePositions]) => lanePositions.length > 0)
    .map(([lane, lanePositions]) => [
      lane,
      riskSummary(lanePositions, accountBlockers, accountAuthorityUsable)
    ] as const);
  const byLane = Object.fromEntries(byLaneEntries) as Record<string, ReturnType<typeof riskSummary>>;
  const portfolioGreeks = positions.length === 0
    ? {
        quality: accountAuthorityUsable ? "not_applicable" as const : "incomplete" as const,
        positionCount: 0,
        totals: {
          deltaShares: null,
          deltaDollars: null,
          gammaSharesPerDollar: null,
          thetaDollarsPerDay: null,
          vegaDollarsPerVolPoint: null,
          rhoDollarsPerRatePoint: null,
          weightedImpliedVolatility: null
        },
        coverage: {
          contracts: {
            total: accountAuthorityUsable ? 0 : null,
            deltaShares: accountAuthorityUsable ? 0 : null,
            deltaDollars: accountAuthorityUsable ? 0 : null,
            gamma: accountAuthorityUsable ? 0 : null,
            theta: accountAuthorityUsable ? 0 : null,
            vega: accountAuthorityUsable ? 0 : null,
            rho: accountAuthorityUsable ? 0 : null,
            impliedVolatility: accountAuthorityUsable ? 0 : null
          },
          marketValue: {
            total: accountAuthorityUsable ? 0 : null,
            deltaShares: accountAuthorityUsable ? 0 : null,
            deltaDollars: accountAuthorityUsable ? 0 : null,
            gamma: accountAuthorityUsable ? 0 : null,
            theta: accountAuthorityUsable ? 0 : null,
            vega: accountAuthorityUsable ? 0 : null,
            rho: accountAuthorityUsable ? 0 : null,
            impliedVolatility: accountAuthorityUsable ? 0 : null
          }
        },
        blockers: accountBlockers,
        evidenceReferences: [] as string[],
        byLane
      }
    : { ...riskSummary(positions, accountBlockers, accountAuthorityUsable), byLane };
  const startedAt = now.toISOString();
  const workstreamResults = byLaneEntries
    .filter(([lane]) => lane === "options_0dte" || lane === "options_leaps")
    .map(([lane, summary]) => ({
      cycle_id: input.cycleId,
      lane: lane === "options_0dte" ? "options_0dte" as const : "options_leaps" as const,
      started_at: startedAt,
      completed_at: startedAt,
      outcome: "no_action" as const,
      proposals: [] as never[],
      evidence_references: [
        `postgres:account_snapshot:${accountSnapshotId}`,
        ...summary.evidenceReferences
      ],
      reason_codes: [
        summary.quality === "complete"
          ? "PORTFOLIO_GREEKS_OBSERVED"
          : "PORTFOLIO_GREEKS_INCOMPLETE"
      ],
      diagnostic_summary: summary.quality === "complete"
        ? `Current paid OPRA Greeks aggregated across ${summary.positionCount} option position(s).`
        : `Option portfolio Greek aggregation is incomplete across ${summary.positionCount} position(s).`,
      portfolio_greeks: summary
    }));
  return {
    status: "completed" as const,
    command: input.command,
    paperOnly: true as const,
    brokerMutationPerformed: false as const,
    accountId,
    accountSnapshotId,
    asOf: startedAt,
    portfolioGreeks,
    workstreamResults
  };
};
