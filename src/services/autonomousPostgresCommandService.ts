import type { QueryResult } from "pg";

import type { SchedulerFence } from "../repositories/contracts/common.js";

export type AutonomousPostgresQueryExecutor = {
  query: (
    sql: string,
    values?: readonly unknown[]
  ) => Promise<Pick<QueryResult<Record<string, unknown>>, "rows" | "rowCount">>;
};

type EvidenceRow = {
  account_count: string | number;
  snapshot_count: string | number;
  risk_limit_count: string | number;
  allocation_count: string | number;
  exposure_count: string | number;
  active_reservation_count: string | number;
  pending_intent_count: string | number;
  open_order_count: string | number;
  open_position_count: string | number;
  completed_research_count: string | number;
  eligible_candidate_count: string | number;
  valid_review_count: string | number;
  reconciliable_order_count: string | number;
};

const INSPECTION_COMMANDS = new Set([
  "research:daily",
  "paper:review",
  "paper:portfolio:review",
  "paper:options:discover",
  "paper:ops:review",
  "paper:exit:review",
  "hedge:review",
  "hedge:exit:review",
  "zero-dte:exit:review",
  "zero-dte:reconcile",
  "paper:learn",
  "system:recover"
]);

const count = (value: string | number | undefined) => {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("POSTGRES_AUTONOMOUS_EVIDENCE_COUNT_INVALID");
  }
  return parsed;
};

const inspectionSql = `WITH current_account AS (
  SELECT id
  FROM accounts
  WHERE environment = 'paper'
  ORDER BY updated_at DESC, id
  LIMIT 1
), latest_research AS (
  SELECT id
  FROM research_runs
  WHERE status = 'completed'
  ORDER BY completed_at DESC, id DESC
  LIMIT 1
)
SELECT
  (SELECT COUNT(*) FROM current_account) AS account_count,
  (SELECT COUNT(*) FROM account_snapshots snapshot
    JOIN current_account account ON account.id = snapshot.account_id) AS snapshot_count,
  (SELECT COUNT(*) FROM risk_limits limits
    JOIN current_account account ON account.id = limits.account_id
    WHERE limits.status = 'active' AND limits.effective_to IS NULL) AS risk_limit_count,
  (SELECT COUNT(*) FROM strategy_allocations allocation
    JOIN current_account account ON account.id = allocation.account_id
    WHERE allocation.status = 'active' AND allocation.effective_to IS NULL) AS allocation_count,
  (SELECT COUNT(*) FROM portfolio_exposure exposure
    JOIN current_account account ON account.id = exposure.account_id) AS exposure_count,
  (SELECT COUNT(*) FROM buying_power_reservations reservation
    JOIN current_account account ON account.id = reservation.account_id
    WHERE reservation.status = 'active' AND reservation.expires_at > now()) AS active_reservation_count,
  (SELECT COUNT(*) FROM order_intents intent
    JOIN current_account account ON account.id = intent.account_id
    WHERE intent.status IN ('ready_for_submission', 'submission_pending', 'ambiguous')) AS pending_intent_count,
  (SELECT COUNT(*) FROM orders broker_order
    JOIN current_account account ON account.id = broker_order.account_id
    WHERE broker_order.status IN ('new', 'accepted', 'pending_new', 'partially_filled', 'held', 'pending_cancel')) AS open_order_count,
  (SELECT COUNT(*) FROM positions position
    JOIN current_account account ON account.id = position.account_id
    WHERE position.status IN ('open', 'closing')) AS open_position_count,
  (SELECT COUNT(*) FROM research_runs WHERE status = 'completed') AS completed_research_count,
  (SELECT COUNT(*) FROM candidates candidate
    JOIN latest_research research ON research.id = candidate.research_run_id
    WHERE candidate.decision = 'selected'
      AND candidate.lifecycle_status NOT IN ('closed', 'expired', 'rejected', 'skipped', 'blocked')) AS eligible_candidate_count,
  (SELECT COUNT(*) FROM execution_reviews review
    JOIN current_account account ON account.id = review.account_id
    WHERE review.status = 'valid' AND review.expires_at > now()
      AND review.environment = 'paper' AND review.paper_only AND NOT review.live_trading_enabled) AS valid_review_count,
  (SELECT COUNT(*) FROM order_intents intent
    JOIN current_account account ON account.id = intent.account_id
    WHERE intent.status IN ('submitted', 'ambiguous')) AS reconciliable_order_count`;

const requireAuthorityEvidence = (row: EvidenceRow | undefined) => {
  if (!row || count(row.account_count) !== 1) {
    throw new Error("POSTGRES_EXECUTION_ACCOUNT_EVIDENCE_MISSING");
  }
  if (count(row.snapshot_count) < 1) {
    throw new Error("POSTGRES_ACCOUNT_SNAPSHOT_EVIDENCE_MISSING");
  }
  if (count(row.risk_limit_count) < 1) {
    throw new Error("POSTGRES_RISK_LIMIT_EVIDENCE_MISSING");
  }
  if (count(row.allocation_count) < 1) {
    throw new Error("POSTGRES_STRATEGY_ALLOCATION_EVIDENCE_MISSING");
  }
  if (count(row.exposure_count) < 1) {
    throw new Error("POSTGRES_PORTFOLIO_EXPOSURE_EVIDENCE_MISSING");
  }
};

const recover = async (
  query: AutonomousPostgresQueryExecutor,
  fence: SchedulerFence,
  now: Date
) => {
  const values = [
    now.toISOString(),
    fence.jobName,
    fence.workstream,
    fence.ownerId,
    fence.runId,
    fence.fencingToken
  ];
  const fenceSql = `EXISTS (
    SELECT 1 FROM scheduler_leases lease
    WHERE lease.job_name = $2 AND lease.workstream = $3
      AND lease.owner_id = $4 AND lease.run_id = $5
      AND lease.fencing_token = $6 AND lease.status = 'held'
      AND lease.expires_at > now()
  )`;
  const researchRuns = await query.query(
    `UPDATE research_runs
     SET status = 'recovered', completed_at = $1, recovered_at = $1,
         recovery_reason = 'WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED',
         recovery_source = 'autonomous_worker', updated_at = $1, version = version + 1
     WHERE status IN ('reserved', 'running')
       AND COALESCE(heartbeat_at, started_at) <= $1::timestamptz - interval '15 minutes'
       AND ${fenceSql}`,
    values
  );
  const reservations = await query.query(
    `UPDATE buying_power_reservations
     SET status = 'expired', released_at = $1, release_reason = 'expired',
         updated_at = $1, version = version + 1
     WHERE status = 'active' AND expires_at <= $1 AND ${fenceSql}`,
    values
  );
  const reviews = await query.query(
    `UPDATE execution_reviews
     SET status = 'expired', updated_at = $1, version = version + 1
     WHERE status IN ('created', 'valid') AND expires_at <= $1 AND ${fenceSql}`,
    values
  );
  const confirmations = await query.query(
    `UPDATE confirmation_evidence
     SET status = 'expired', updated_at = $1, version = version + 1
     WHERE status = 'valid' AND expires_at <= $1 AND ${fenceSql}`,
    values
  );
  return {
    researchRuns: researchRuns.rowCount ?? 0,
    reservations: reservations.rowCount ?? 0,
    reviews: reviews.rowCount ?? 0,
    confirmations: confirmations.rowCount ?? 0
  };
};

export const runAutonomousPostgresCommand = async (input: {
  readonly command: string;
  readonly query: AutonomousPostgresQueryExecutor;
  readonly fence: SchedulerFence;
  readonly now?: Date;
}) => {
  if (!INSPECTION_COMMANDS.has(input.command)) {
    throw new Error(`POSTGRES_AUTONOMOUS_COMMAND_UNSUPPORTED: ${input.command}`);
  }
  const now = input.now ?? new Date();
  const recovery = input.command === "system:recover"
    ? await recover(input.query, input.fence, now)
    : undefined;
  const evidenceResult = await input.query.query(inspectionSql);
  const row = evidenceResult.rows[0] as EvidenceRow | undefined;
  requireAuthorityEvidence(row);
  const evidence = {
    activeReservationCount: count(row!.active_reservation_count),
    pendingIntentCount: count(row!.pending_intent_count),
    openOrderCount: count(row!.open_order_count),
    openPositionCount: count(row!.open_position_count),
    completedResearchCount: count(row!.completed_research_count),
    eligibleCandidateCount: count(row!.eligible_candidate_count),
    validReviewCount: count(row!.valid_review_count),
    reconciliableOrderCount: count(row!.reconciliable_order_count)
  };

  let code: string | undefined;
  if (input.command === "research:daily" && evidence.eligibleCandidateCount === 0) {
    code = "NO_ELIGIBLE_POSTGRES_CANDIDATES";
  } else if (
    ["paper:exit:review", "hedge:exit:review", "zero-dte:exit:review"].includes(input.command) &&
    evidence.openPositionCount === 0
  ) {
    code = "NO_OPEN_POSTGRES_POSITIONS";
  } else if (
    ["paper:review", "paper:ops:review", "hedge:review"].includes(input.command) &&
    evidence.eligibleCandidateCount === 0
  ) {
    code = "NO_ELIGIBLE_POSTGRES_CANDIDATES";
  } else if (input.command === "paper:learn" && evidence.reconciliableOrderCount === 0) {
    code = "NO_RECONCILIABLE_POSTGRES_ORDERS";
  } else if (input.command === "zero-dte:reconcile" && evidence.reconciliableOrderCount === 0) {
    code = "NO_RECONCILIABLE_POSTGRES_ORDERS";
  }

  return {
    status: code ? "no_op" as const : "completed" as const,
    code,
    command: input.command,
    paperOnly: true,
    mutationAttempted: input.command === "system:recover",
    evidence,
    ...(recovery ? { recovery } : {})
  };
};
