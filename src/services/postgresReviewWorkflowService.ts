import { createHmac } from "node:crypto";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";

export type PostgresReviewQuery = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

type ReviewSourceRow = Record<string, unknown> & {
  candidate_id: string;
  symbol: string;
  asset_class: "equity" | "option";
  option_symbol: string | null;
  preferred_expression: string;
  direction: "long" | "short";
  confidence: string | number;
  candidate_as_of: Date | string;
  account_id: string;
  account_snapshot_id: string;
  snapshot_fingerprint: string;
  structural_fingerprint: string;
  buying_power: string | number;
  cash: string | number;
  equity: string | number;
  strategy_key: string;
  allocation_amount: string | number | null;
  allocation_ratio: string | number | null;
  reserved_amount: string | number;
  deployed_amount: string | number;
  max_position_notional: string | number | null;
  max_symbol_notional: string | number | null;
  max_deployment_amount: string | number | null;
  cash_reserve_amount: string | number | null;
  cash_reserve_ratio: string | number | null;
  market_price: string | number;
  market_timestamp: Date | string;
  market_request_id: string | null;
  open_position_count: string | number;
  open_order_count: string | number;
};

const ENTRY_REVIEW_COMMANDS = new Set([
  "paper:review",
  "paper:portfolio:review",
  "paper:options:discover",
  "paper:ops:review",
  "hedge:review"
]);
const EXIT_REVIEW_COMMANDS = new Set([
  "paper:exit:review",
  "hedge:exit:review",
  "zero-dte:exit:review"
]);

const fenceSql = (start: number) => `EXISTS (
  SELECT 1 FROM scheduler_leases lease
  WHERE lease.job_name = $${start} AND lease.workstream = $${start + 1}
    AND lease.owner_id = $${start + 2} AND lease.run_id = $${start + 3}
    AND lease.fencing_token = $${start + 4} AND lease.status = 'held'
    AND lease.expires_at > now()
)`;
const fenceValues = (fence: SchedulerFence) => [
  fence.jobName, fence.workstream, fence.ownerId, fence.runId, fence.fencingToken
];
const finite = (value: unknown) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positiveOrInfinity = (value: unknown) => {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : Number.POSITIVE_INFINITY;
};

const entrySourceSql = (command: string) => `WITH latest_research AS (
  SELECT id FROM research_runs WHERE status = 'completed'
  ORDER BY completed_at DESC, id DESC LIMIT 1
), current_account AS (
  SELECT * FROM accounts WHERE environment = 'paper'
  ORDER BY updated_at DESC, id LIMIT 1
)
SELECT candidate.id AS candidate_id, candidate.symbol, candidate.asset_class,
       candidate.option_symbol, candidate.preferred_expression,
       candidate.direction, candidate.confidence, candidate.as_of AS candidate_as_of,
       account.id AS account_id, snapshot.id AS account_snapshot_id,
       snapshot.snapshot_fingerprint,
       snapshot.evidence->>'structuralPortfolioFingerprint' AS structural_fingerprint,
       snapshot.buying_power::text, snapshot.cash::text, snapshot.equity::text,
       allocation.strategy_key, allocation.allocation_amount::text,
       allocation.allocation_ratio::text, allocation.reserved_amount::text,
       allocation.deployed_amount::text, limits.max_position_notional::text,
       limits.max_symbol_notional::text, limits.max_deployment_amount::text,
       limits.cash_reserve_amount::text, limits.cash_reserve_ratio::text,
       market.market_price::text, market.market_timestamp,
       market.market_request_id,
       (SELECT COUNT(*) FROM positions position
         WHERE position.account_id = account.id AND position.status IN ('open', 'closing')
           AND (position.symbol = candidate.symbol OR position.option_symbol = candidate.option_symbol)
       ) AS open_position_count,
       (SELECT COUNT(*) FROM orders broker_order
         WHERE broker_order.account_id = account.id
           AND broker_order.status IN ('new','accepted','pending_new','partially_filled','held','pending_cancel')
           AND broker_order.symbol = COALESCE(candidate.option_symbol, candidate.symbol)
       ) AS open_order_count
FROM candidates candidate
JOIN latest_research research ON research.id = candidate.research_run_id
${command === "paper:options:discover" ? "JOIN option_contracts contract ON contract.option_symbol = candidate.option_symbol" : ""}
CROSS JOIN current_account account
JOIN LATERAL (
  SELECT * FROM account_snapshots WHERE account_id = account.id
  ORDER BY observed_at DESC, id DESC LIMIT 1
) snapshot ON true
JOIN LATERAL (
  SELECT * FROM strategy_allocations WHERE account_id = account.id
    AND status = 'active' AND effective_to IS NULL
  ORDER BY updated_at DESC, id LIMIT 1
) allocation ON true
JOIN LATERAL (
  SELECT * FROM risk_limits WHERE account_id = account.id
    AND status = 'active' AND effective_to IS NULL
  ORDER BY CASE WHEN scope_type = 'portfolio' THEN 0 ELSE 1 END, updated_at DESC, id LIMIT 1
) limits ON true
JOIN LATERAL (
  SELECT option_market.market_price, option_market.market_timestamp,
         option_market.market_request_id
  FROM (
    SELECT COALESCE(option_snapshot.midpoint, option_snapshot.ask, option_snapshot.last) AS market_price,
           COALESCE(option_snapshot.quote_timestamp, option_snapshot.snapshot_timestamp,
                    option_snapshot.trade_timestamp, option_snapshot.observed_at) AS market_timestamp,
           option_snapshot.request_id AS market_request_id
    FROM option_snapshots option_snapshot
    WHERE candidate.option_symbol IS NOT NULL
      AND option_snapshot.option_symbol = candidate.option_symbol
    ORDER BY option_snapshot.observed_at DESC LIMIT 1
  ) option_market
  UNION ALL
  SELECT stock_market.market_price, stock_market.market_timestamp,
         stock_market.market_request_id
  FROM (
    SELECT COALESCE(
             (stock.evidence->>'midpoint')::numeric,
             (stock.evidence->>'latestTradePrice')::numeric,
             (stock.evidence->>'minuteClose')::numeric,
             (stock.evidence->>'dailyClose')::numeric,
             bar.close
           ) AS market_price,
           COALESCE(stock.source_timestamp, bar.observed_at) AS market_timestamp,
           COALESCE(stock.request_id, bar.request_id) AS market_request_id
    FROM market_bars bar
    LEFT JOIN LATERAL (
      SELECT * FROM stock_snapshots WHERE symbol = candidate.symbol
      ORDER BY observed_at DESC, id DESC LIMIT 1
    ) stock ON true
    WHERE candidate.option_symbol IS NULL AND bar.symbol = candidate.symbol
      AND bar.timeframe = '1Day'
    ORDER BY bar.observed_at DESC LIMIT 1
  ) stock_market
  LIMIT 1
) market ON market.market_price > 0 AND market.market_timestamp IS NOT NULL
WHERE candidate.decision = 'selected'
  AND candidate.lifecycle_status NOT IN ('closed','expired','rejected','skipped','blocked')
  AND NOT EXISTS (
    SELECT 1 FROM execution_reviews existing_review
    WHERE existing_review.account_id = account.id
      AND existing_review.candidate_id = candidate.id
      AND existing_review.source_snapshot_id = snapshot.id
      AND existing_review.review_type = 'entry'
      AND existing_review.client_order_id IS NOT NULL
  )
  ${command === "paper:options:discover" ? `AND candidate.option_symbol IS NOT NULL
    AND candidate.symbol = $1
    AND contract.expiration_date = (($2::timestamptz AT TIME ZONE 'America/New_York')::date + $3::integer)` : ""}
  ${command === "hedge:review" ? "AND candidate.strategy_family ILIKE '%hedge%'" : ""}
ORDER BY candidate.rank, candidate.id
LIMIT 10`;

const exitSourceSql = (command: string) => `WITH current_account AS (
  SELECT * FROM accounts WHERE environment = 'paper'
  ORDER BY updated_at DESC, id LIMIT 1
)
SELECT position.id AS position_id, position.candidate_id, position.symbol,
       COALESCE(position.option_symbol, position.symbol) AS order_symbol,
       position.asset_class, position.side, position.available_quantity::text,
       position.average_entry_price::text,
       COALESCE(candidate.strategy_family, allocation.strategy_key) AS strategy_key,
       account.id AS account_id, snapshot.id AS account_snapshot_id,
       snapshot.snapshot_fingerprint,
       snapshot.evidence->>'structuralPortfolioFingerprint' AS structural_fingerprint,
       market.market_price::text, market.market_timestamp, market.market_request_id
FROM positions position
CROSS JOIN current_account account
LEFT JOIN candidates candidate ON candidate.id = position.candidate_id
JOIN LATERAL (
  SELECT * FROM account_snapshots WHERE account_id = account.id
  ORDER BY observed_at DESC, id DESC LIMIT 1
) snapshot ON true
JOIN LATERAL (
  SELECT * FROM strategy_allocations WHERE account_id = account.id
    AND status = 'active' AND effective_to IS NULL
  ORDER BY updated_at DESC, id LIMIT 1
) allocation ON true
JOIN LATERAL (
  SELECT option_market.market_price, option_market.market_timestamp,
         option_market.market_request_id
  FROM (
    SELECT COALESCE(option_snapshot.bid, option_snapshot.midpoint, option_snapshot.last) AS market_price,
           COALESCE(option_snapshot.quote_timestamp, option_snapshot.snapshot_timestamp,
                    option_snapshot.trade_timestamp, option_snapshot.observed_at) AS market_timestamp,
           option_snapshot.request_id AS market_request_id
    FROM option_snapshots option_snapshot
    WHERE position.option_symbol IS NOT NULL
      AND option_snapshot.option_symbol = position.option_symbol
    ORDER BY option_snapshot.observed_at DESC LIMIT 1
  ) option_market
  UNION ALL
  SELECT stock_market.market_price, stock_market.market_timestamp,
         stock_market.market_request_id
  FROM (
    SELECT COALESCE(
             (stock.evidence->>'midpoint')::numeric,
             (stock.evidence->>'latestTradePrice')::numeric,
             (stock.evidence->>'minuteClose')::numeric,
             (stock.evidence->>'dailyClose')::numeric,
             bar.close
           ) AS market_price,
           COALESCE(stock.source_timestamp, bar.observed_at) AS market_timestamp,
           COALESCE(stock.request_id, bar.request_id) AS market_request_id
    FROM market_bars bar
    LEFT JOIN LATERAL (
      SELECT * FROM stock_snapshots WHERE symbol = position.symbol
      ORDER BY observed_at DESC, id DESC LIMIT 1
    ) stock ON true
    WHERE position.option_symbol IS NULL AND bar.symbol = position.symbol
      AND bar.timeframe = '1Day'
    ORDER BY bar.observed_at DESC LIMIT 1
  ) stock_market
  LIMIT 1
) market ON market.market_price > 0 AND market.market_timestamp IS NOT NULL
WHERE position.account_id = account.id AND position.status IN ('open','closing')
  AND position.available_quantity > 0
  ${command === "hedge:exit:review" ? "AND COALESCE(candidate.strategy_family, allocation.strategy_key) ILIKE '%hedge%'" : ""}
  ${command === "zero-dte:exit:review" ? "AND position.asset_class = 'option' AND substring(position.option_symbol from '[0-9]{6}') = to_char(now() AT TIME ZONE 'America/New_York', 'YYMMDD')" : ""}
ORDER BY position.opened_at, position.id`;

const runExitReview = async (input: {
  command: string;
  query: PostgresReviewQuery;
  fence: SchedulerFence;
  signingKey: string;
  now: Date;
  maxMarketAgeHours: number;
}) => {
  const rows = (await input.query.query(exitSourceSql(input.command))).rows as Array<Record<string, unknown>>;
  const eligible = rows.flatMap((row) => {
    const price = finite(row.market_price);
    const entry = finite(row.average_entry_price);
    const quantity = finite(row.available_quantity);
    if (price === null || price <= 0 || entry === null || entry <= 0 || quantity === null || quantity <= 0) {
      throw new Error(`POSTGRES_EXIT_REVIEW_EVIDENCE_INCOMPLETE:${String(row.symbol)}`);
    }
    const timestamp = new Date(String(row.market_timestamp)).toISOString();
    const age = input.now.getTime() - Date.parse(timestamp);
    if (!Number.isFinite(age) || age < -60_000 || age > input.maxMarketAgeHours * 3_600_000) {
      throw new Error(`POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:${String(row.symbol)}`);
    }
    const directionalReturn = (price / entry - 1) * (row.side === "short" ? -1 : 1);
    const option = row.asset_class === "option";
    const reason = option
      ? directionalReturn <= -0.5 ? "ODTE_STOP_LOSS_50" : directionalReturn >= 0.5 ? "ODTE_TAKE_PROFIT_50" : null
      : directionalReturn <= -0.05 ? "EQUITY_STOP_LOSS_5" : directionalReturn >= 0.08 ? "EQUITY_TAKE_PROFIT_8" : null;
    return reason ? [{ row, price, quantity, timestamp, option, reason, directionalReturn }] : [];
  });
  if (!eligible.length) {
    return { status: "no_op" as const, code: "NO_POSTGRES_EXIT_TRIGGER", reviewsCreated: 0, pendingIntentsCreated: 0, capacityBlocked: 0 };
  }
  let created = 0;
  for (const item of eligible) {
    const row = item.row;
    const accountId = String(row.account_id);
    const positionId = String(row.position_id);
    const orderSymbol = String(row.order_symbol);
    const candidateId = row.candidate_id ? String(row.candidate_id) : null;
    const structural = String(row.structural_fingerprint || "");
    const portfolio = String(row.snapshot_fingerprint || "");
    const snapshotId = String(row.account_snapshot_id || "");
    if (!structural || !portfolio || !snapshotId) throw new Error("POSTGRES_REVIEW_ACCOUNT_FINGERPRINT_MISSING");
    const clientOrderId = `pg-exit-${canonicalJsonHash({ accountId, positionId, snapshotId }).slice(0, 28)}`;
    const marketEvidence = [{
      symbol: orderSymbol, underlyingSymbol: String(row.symbol),
      referencePrice: item.price, timestamp: item.timestamp,
      requestId: row.market_request_id ?? null,
      source: item.option ? "postgres.option_snapshots" : "postgres.stock_snapshots"
    }];
    const orderIntent = {
      symbol: orderSymbol, underlyingSymbol: item.option ? String(row.symbol) : null,
      assetClass: String(row.asset_class), side: item.option ? "sell_to_close" : "sell",
      orderType: item.option ? "limit" : "market", timeInForce: "day",
      quantity: item.quantity, notional: null, limitPrice: item.option ? item.price : null,
      clientOrderId, strategyKey: String(row.strategy_key), reason: item.reason
    };
    const payload = {
      positionId, candidateId, accountSnapshotId: snapshotId,
      accountFingerprint: structural, orderIntent, marketEvidence,
      trigger: { reason: item.reason, return: item.directionalReturn }, paperOnly: true
    };
    const payloadFingerprint = canonicalJsonHash(payload);
    const reviewId = `review_${payloadFingerprint}`;
    const signature = createHmac("sha256", input.signingKey).update(payloadFingerprint).digest("hex");
    const nowIso = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + 15 * 60_000).toISOString();
    const review = await input.query.query(
      `INSERT INTO execution_reviews(
         id, account_id, candidate_id, review_type, environment, paper_only,
         live_trading_enabled, status, client_order_id, account_fingerprint,
         source_snapshot_id, configuration_fingerprint, payload_fingerprint,
         signature_algorithm, signature, order_intent, market_evidence,
         portfolio_evidence, warnings, blockers, expires_at, created_at, updated_at
       ) SELECT $1, $2, $3, 'exit', 'paper', true, false, 'valid', $4, $5,
                $6, $7, $8, 'hmac-sha256', $9, $10::jsonb, $11::jsonb,
                $12::jsonb, '[]'::jsonb, '[]'::jsonb, $13, $14, $14
         WHERE ${fenceSql(15)}
       ON CONFLICT (account_id, payload_fingerprint) DO NOTHING`,
      [reviewId, accountId, candidateId, clientOrderId, structural, snapshotId,
        canonicalJsonHash({ reason: item.reason }), payloadFingerprint, signature,
        JSON.stringify(orderIntent), JSON.stringify(marketEvidence),
        JSON.stringify({ snapshotId, portfolioFingerprint: portfolio, structuralPortfolioFingerprint: structural }),
        expiresAt, nowIso, ...fenceValues(input.fence)]
    );
    const intentFingerprint = canonicalJsonHash({ reviewId, orderIntent });
    const intent = await input.query.query(
      `INSERT INTO order_intents(
         id, account_id, candidate_id, execution_review_id, environment,
         client_order_id, idempotency_key, strategy_key, symbol,
         underlying_symbol, asset_class, side, order_type, time_in_force,
         quantity, limit_price, estimated_premium, max_risk, status,
         intent_fingerprint, lifecycle_fingerprint, request_payload,
         created_at, updated_at
       ) SELECT $1, $2, $3, $4, 'paper', $5, $6, $7, $8, $9, $10, $11,
                $12, 'day', $13, $14, $15, $16, 'created', $17, $18,
                $19::jsonb, $20, $20
         WHERE ${fenceSql(21)}
       ON CONFLICT (account_id, intent_fingerprint) DO NOTHING`,
      [`intent_${intentFingerprint}`, accountId, candidateId, reviewId, clientOrderId,
        `review:${payloadFingerprint}`, String(row.strategy_key), orderSymbol,
        item.option ? String(row.symbol) : null, String(row.asset_class),
        item.option ? "sell_to_close" : "sell", item.option ? "limit" : "market",
        item.quantity, item.option ? item.price : null,
        item.option ? item.price * 100 * item.quantity : null,
        item.option ? item.price * 100 * item.quantity : item.price * item.quantity,
        intentFingerprint, canonicalJsonHash({ status: "created", at: nowIso }),
        JSON.stringify(orderIntent), nowIso, ...fenceValues(input.fence)]
    );
    if (![0, 1].includes(review.rowCount ?? -1) || ![0, 1].includes(intent.rowCount ?? -1)) {
      throw new Error("POSTGRES_EXIT_REVIEW_PERSISTENCE_FAILED");
    }
    created += review.rowCount === 1 ? 1 : 0;
  }
  return {
    status: "completed" as const, command: input.command, reviewsCreated: created,
    pendingIntentsCreated: created, skipped: 0, capacityBlocked: 0, confirmationCreated: false, paperOnly: true
  };
};

const sizing = (row: ReviewSourceRow): number | null => {
  const buyingPower = finite(row.buying_power);
  const cash = finite(row.cash);
  const equity = finite(row.equity);
  if (buyingPower === null || cash === null || equity === null) {
    throw new Error("POSTGRES_REVIEW_ACCOUNT_SIZING_EVIDENCE_MISSING");
  }
  const allocation = row.allocation_amount !== null
    ? positiveOrInfinity(row.allocation_amount)
    : finite(row.allocation_ratio) !== null
      ? buyingPower * finite(row.allocation_ratio)!
      : Number.POSITIVE_INFINITY;
  const allocationRemaining = Math.max(0, allocation - (finite(row.reserved_amount) ?? 0) - (finite(row.deployed_amount) ?? 0));
  const cashReserve = row.cash_reserve_amount !== null
    ? finite(row.cash_reserve_amount) ?? 0
    : equity * (finite(row.cash_reserve_ratio) ?? 0);
  const amount = Math.floor(Math.min(
    1_000,
    buyingPower,
    Math.max(0, cash - cashReserve),
    allocationRemaining,
    positiveOrInfinity(row.max_position_notional),
    positiveOrInfinity(row.max_symbol_notional),
    positiveOrInfinity(row.max_deployment_amount)
  ) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
};

export const runPostgresReviewWorkflow = async (input: {
  command: string;
  query: PostgresReviewQuery;
  fence: SchedulerFence;
  signingKey?: string;
  now?: Date;
  maxMarketAgeHours?: number;
  underlying?: string;
  dte?: number;
}) => {
  if (!ENTRY_REVIEW_COMMANDS.has(input.command) && !EXIT_REVIEW_COMMANDS.has(input.command)) {
    return { status: "no_op" as const, code: "NO_POSTGRES_REVIEW_SCOPE", reviewsCreated: 0, pendingIntentsCreated: 0, capacityBlocked: 0 };
  }
  const signingKey = input.signingKey ?? process.env.PAPER_REVIEW_SIGNING_KEY?.trim();
  if (!signingKey || signingKey.length < 16) throw new Error("PAPER_REVIEW_SIGNING_KEY_REQUIRED");
  const now = input.now ?? new Date();
  if (EXIT_REVIEW_COMMANDS.has(input.command)) {
    return runExitReview({
      command: input.command,
      query: input.query,
      fence: input.fence,
      signingKey,
      now,
      maxMarketAgeHours: input.maxMarketAgeHours ?? 96
    });
  }
  let sourceValues: readonly unknown[] = [];
  if (input.command === "paper:options:discover") {
    const underlying = String(input.underlying ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z.]{0,14}$/.test(underlying)) {
      throw new Error("POSTGRES_OPTION_DISCOVERY_UNDERLYING_REQUIRED");
    }
    if (!Number.isSafeInteger(input.dte) || input.dte! < 0 || input.dte! > 730) {
      throw new Error("POSTGRES_OPTION_DISCOVERY_DTE_INVALID");
    }
    sourceValues = [underlying, now.toISOString(), input.dte!];
  }
  const rows = (await input.query.query(entrySourceSql(input.command), sourceValues)).rows as ReviewSourceRow[];
  if (!rows.length) {
    return { status: "no_op" as const, code: "NO_ELIGIBLE_POSTGRES_CANDIDATES", reviewsCreated: 0, pendingIntentsCreated: 0, capacityBlocked: 0 };
  }
  // Classify already-held / already-ordered candidates as row-level skips. Validate
  // every remaining row before writing anything so stale or incomplete evidence
  // still fails closed for the entire review batch.
  let skipped = 0;
  let capacityBlocked = 0;
  const eligibleRows: ReviewSourceRow[] = [];
  for (const row of rows) {
    if (!row.structural_fingerprint || !row.snapshot_fingerprint) {
      throw new Error("POSTGRES_REVIEW_ACCOUNT_FINGERPRINT_MISSING");
    }
    if (Number(row.open_position_count) > 0 || Number(row.open_order_count) > 0) {
      skipped += 1;
      continue;
    }
    const marketTimestamp = new Date(row.market_timestamp).toISOString();
    const age = now.getTime() - Date.parse(marketTimestamp);
    const maxAge = (input.maxMarketAgeHours ?? 96) * 3_600_000;
    if (!Number.isFinite(age) || age < -60_000 || age > maxAge) {
      throw new Error(`POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:${row.symbol}`);
    }
    const price = finite(row.market_price);
    if (price === null || price <= 0) throw new Error(`POSTGRES_REVIEW_MARKET_PRICE_MISSING:${row.symbol}`);
    const amount = sizing(row);
    if (amount === null) {
      capacityBlocked += 1;
      continue;
    }
    if (row.asset_class === "option" && !Math.floor(amount / (price * 100))) {
      throw new Error(`POSTGRES_REVIEW_OPTION_CAPACITY_INSUFFICIENT:${row.symbol}`);
    }
    eligibleRows.push(row);
  }
  if (!eligibleRows.length) {
    return {
      status: "completed" as const, command: input.command, reviewsCreated: 0,
      pendingIntentsCreated: 0, skipped, capacityBlocked,
      ...(capacityBlocked > 0 ? { code: "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE" } : {}),
      confirmationCreated: false, paperOnly: true
    };
  }
  let created = 0;
  for (const row of eligibleRows) {
    const marketTimestamp = new Date(row.market_timestamp).toISOString();
    const age = now.getTime() - Date.parse(marketTimestamp);
    const maxAge = (input.maxMarketAgeHours ?? 96) * 3_600_000;
    if (!Number.isFinite(age) || age < -60_000 || age > maxAge) {
      throw new Error(`POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:${row.symbol}`);
    }
    const price = finite(row.market_price);
    if (price === null || price <= 0) throw new Error(`POSTGRES_REVIEW_MARKET_PRICE_MISSING:${row.symbol}`);
    const amount = sizing(row);
    if (amount === null) continue;
    const option = row.asset_class === "option";
    const quantity = option ? Math.floor(amount / (price * 100)) : null;
    if (option && (!quantity || quantity <= 0)) throw new Error(`POSTGRES_REVIEW_OPTION_CAPACITY_INSUFFICIENT:${row.symbol}`);
    const orderSymbol = row.option_symbol ?? row.symbol;
    const clientOrderId = `pg-${canonicalJsonHash({ account: row.account_id, candidate: row.candidate_id, snapshot: row.account_snapshot_id }).slice(0, 32)}`;
    const marketEvidence = [{
      symbol: orderSymbol,
      underlyingSymbol: row.symbol,
      referencePrice: price,
      timestamp: marketTimestamp,
      requestId: row.market_request_id,
      source: option ? "postgres.option_snapshots" : "postgres.stock_snapshots"
    }];
    const orderIntent = {
      symbol: orderSymbol,
      underlyingSymbol: option ? row.symbol : null,
      assetClass: row.asset_class,
      side: option ? "buy_to_open" : "buy",
      orderType: option ? "limit" : "market",
      timeInForce: "day",
      quantity,
      notional: option ? null : amount,
      limitPrice: option ? price : null,
      clientOrderId,
      strategyKey: row.strategy_key
    };
    const configuration = {
      environment: "paper", liveTradingEnabled: false,
      allocationAmount: row.allocation_amount, allocationRatio: row.allocation_ratio,
      maxPositionNotional: row.max_position_notional,
      maxSymbolNotional: row.max_symbol_notional,
      maxDeploymentAmount: row.max_deployment_amount,
      cashReserveAmount: row.cash_reserve_amount,
      cashReserveRatio: row.cash_reserve_ratio
    };
    const payload = {
      candidateId: row.candidate_id, accountSnapshotId: row.account_snapshot_id,
      accountFingerprint: row.structural_fingerprint, orderIntent, marketEvidence,
      paperOnly: true
    };
    const payloadFingerprint = canonicalJsonHash(payload);
    const configFingerprint = canonicalJsonHash(configuration);
    const reviewId = `review_${payloadFingerprint}`;
    const signature = createHmac("sha256", signingKey).update(payloadFingerprint).digest("hex");
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const review = await input.query.query(
      `INSERT INTO execution_reviews(
         id, account_id, candidate_id, review_type, environment, paper_only,
         live_trading_enabled, status, client_order_id, account_fingerprint,
         source_snapshot_id, configuration_fingerprint, payload_fingerprint,
         signature_algorithm, signature, order_intent, market_evidence,
         portfolio_evidence, warnings, blockers, expires_at, created_at, updated_at
       ) SELECT $1, $2, $3, 'entry', 'paper', true, false, 'valid', $4, $5,
                $6, $7, $8, 'hmac-sha256', $9, $10::jsonb, $11::jsonb,
                $12::jsonb, '[]'::jsonb, '[]'::jsonb, $13, $14, $14
         WHERE ${fenceSql(15)}
       ON CONFLICT (account_id, payload_fingerprint) DO NOTHING`,
      [reviewId, row.account_id, row.candidate_id, clientOrderId,
        row.structural_fingerprint, row.account_snapshot_id, configFingerprint,
        payloadFingerprint, signature, JSON.stringify(orderIntent),
        JSON.stringify(marketEvidence), JSON.stringify({
          snapshotId: row.account_snapshot_id,
          portfolioFingerprint: row.snapshot_fingerprint,
          structuralPortfolioFingerprint: row.structural_fingerprint
        }), expiresAt, now.toISOString(), ...fenceValues(input.fence)]
    );
    if (review.rowCount !== 1 && review.rowCount !== 0) throw new Error("POSTGRES_REVIEW_PERSISTENCE_FAILED");
    const intentFingerprint = canonicalJsonHash({ reviewId, orderIntent });
    const intentId = `intent_${intentFingerprint}`;
    const intentResult = await input.query.query(
      `INSERT INTO order_intents(
         id, account_id, candidate_id, execution_review_id, environment,
         client_order_id, idempotency_key, strategy_key, symbol,
         underlying_symbol, asset_class, side, order_type, time_in_force,
         quantity, notional, limit_price, estimated_premium, max_risk, status,
         intent_fingerprint, lifecycle_fingerprint, request_payload,
         created_at, updated_at
       ) SELECT $1, $2, $3, $4, 'paper', $5, $6, $7, $8, $9, $10, $11,
                $12, 'day', $13, $14, $15, $16, $17, 'created', $18, $19,
                $20::jsonb, $21, $21
         WHERE ${fenceSql(22)}
       ON CONFLICT (account_id, intent_fingerprint) DO NOTHING`,
      [intentId, row.account_id, row.candidate_id, reviewId, clientOrderId,
        `review:${payloadFingerprint}`, row.strategy_key, orderSymbol,
        option ? row.symbol : null, row.asset_class, option ? "buy_to_open" : "buy",
        option ? "limit" : "market", quantity, option ? null : amount,
        option ? price : null, option ? price * 100 * (quantity ?? 0) : null,
        amount, intentFingerprint, canonicalJsonHash({ status: "created", at: now.toISOString() }),
        JSON.stringify(orderIntent), now.toISOString(), ...fenceValues(input.fence)]
    );
    if (intentResult.rowCount !== 1 && intentResult.rowCount !== 0) throw new Error("POSTGRES_ORDER_INTENT_PERSISTENCE_FAILED");
    created += review.rowCount === 1 ? 1 : 0;
  }
  return {
    status: "completed" as const,
    command: input.command,
    reviewsCreated: created,
    pendingIntentsCreated: created,
    skipped,
    capacityBlocked,
    confirmationCreated: false,
    paperOnly: true
  };
};
