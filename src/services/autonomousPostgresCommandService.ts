import type { QueryResult } from "pg";

import type { SchedulerFence } from "../repositories/contracts/common.js";
import { AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS } from "./autonomousFreshnessPolicy.js";

type StaleReadyOrderLookup = (
  clientOrderId: string
) => Promise<{ data: { id?: string; client_order_id?: string; status?: string }; status?: number }>;

export type AutonomousPostgresQueryExecutor = {
  query: (
    sql: string,
    values?: readonly unknown[]
  ) => Promise<Pick<QueryResult<Record<string, unknown>>, "rows" | "rowCount">>;
};

const brokerOrderAbsent = (error: unknown) => {
  const status = Number((error as { status?: unknown } | null)?.status);
  const message = error instanceof Error ? error.message : String(error ?? "");
  return status === 404 || /\b404\b|order not found/i.test(message);
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

export const runAutonomousPostgresRecovery = async (
  query: AutonomousPostgresQueryExecutor,
  fence: SchedulerFence,
  now: Date,
  options: { getOrderByClientOrderId?: StaleReadyOrderLookup } = {}
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
  const fenceSqlAt = (start: number) => `EXISTS (
    SELECT 1 FROM scheduler_leases lease
    WHERE lease.job_name = $${start} AND lease.workstream = $${start + 1}
      AND lease.owner_id = $${start + 2} AND lease.run_id = $${start + 3}
      AND lease.fencing_token = $${start + 4} AND lease.status = 'held'
      AND lease.expires_at > now()
  )`;
  let staleReadyIntents = 0;
  let staleReadyCancelled = 0;
  let staleReadyPreserved = 0;
  let staleReadyReservationsReleased = 0;
  let staleReadyAllocationsAdjusted = 0;
  if (options.getOrderByClientOrderId) {
    const staleReady = await query.query(
      `SELECT intent.id, intent.client_order_id
       FROM order_intents intent
       JOIN execution_reviews review ON review.id = intent.execution_review_id
       JOIN candidates candidate ON candidate.id = intent.candidate_id
       LEFT JOIN confirmation_evidence confirmation
         ON confirmation.id = intent.confirmation_evidence_id
       LEFT JOIN buying_power_reservations reservation
         ON reservation.id = intent.reservation_id
       WHERE intent.status = 'ready_for_submission'
         AND intent.environment = 'paper'
         AND NOT EXISTS (
           SELECT 1 FROM orders existing_order
           WHERE existing_order.order_intent_id = intent.id
         )
         AND (
           candidate.decision <> 'selected'
           OR candidate.lifecycle_status IN ('expired', 'rejected', 'blocked', 'skipped')
           OR candidate.as_of <= $7::timestamptz - ($8::integer * interval '1 second')
           OR
           review.status IN ('expired', 'revoked', 'blocked') OR review.expires_at <= $1
           OR confirmation.status IS NULL OR confirmation.status <> 'valid'
           OR confirmation.expires_at IS NULL OR confirmation.expires_at <= $1
           OR reservation.status IS NULL OR reservation.status NOT IN ('active', 'committed')
           OR reservation.expires_at IS NULL OR reservation.expires_at <= $1
         )
         AND ${fenceSql}`,
      [now.toISOString(), ...values.slice(1), now.toISOString(), AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS]
    );
    staleReadyIntents = staleReady.rowCount ?? staleReady.rows.length;
    for (const row of staleReady.rows) {
      const clientOrderId = String(row.client_order_id ?? "").trim();
      if (!clientOrderId) continue;
      try {
        const broker = await options.getOrderByClientOrderId(clientOrderId);
        if (!broker.data?.id || broker.data.client_order_id !== clientOrderId) {
          throw new Error("POSTGRES_STALE_READY_BROKER_IDENTITY_MISMATCH");
        }
        const preserved = await query.query(
          `UPDATE order_intents
           SET status = 'ambiguous', updated_at = $2, version = version + 1,
               request_payload = request_payload || jsonb_build_object(
                 'staleReadyRecovery', jsonb_build_object(
                   'brokerOrderId', $3, 'brokerStatus', $4,
                   'reason', 'BROKER_ORDER_FOUND_DURING_STALE_READY_RECOVERY'
                 )
               )
           WHERE id = $1 AND status = 'ready_for_submission' AND ${fenceSqlAt(5)}`,
          [row.id, now.toISOString(), broker.data.id, broker.data.status ?? "unknown", ...values.slice(1)]
        );
        if (preserved.rowCount === 1) staleReadyPreserved += 1;
      } catch (error) {
        if (!brokerOrderAbsent(error)) throw error;
        const cancelled = await query.query(
          `WITH locked_reservation AS MATERIALIZED (
             SELECT reservation.id, reservation.account_id, reservation.strategy_key,
                    reservation.amount
             FROM buying_power_reservations reservation
             WHERE reservation.id = (
               SELECT intent.reservation_id FROM order_intents intent WHERE intent.id = $1
             ) AND reservation.status IN ('active', 'committed')
             FOR UPDATE
           ), locked_allocation AS MATERIALIZED (
             SELECT allocation.id, allocation.account_id, allocation.strategy_key,
                    allocation.reserved_amount
             FROM strategy_allocations allocation
             JOIN locked_reservation reservation
               ON reservation.account_id = allocation.account_id
              AND reservation.strategy_key = allocation.strategy_key
             WHERE allocation.status = 'active' AND allocation.effective_to IS NULL
             FOR UPDATE
           ), validation AS (
             SELECT CASE WHEN (SELECT COUNT(*) FROM locked_reservation) = 0 OR
                              ((SELECT COUNT(*) FROM locked_allocation) = 1 AND
                               (SELECT MIN(reserved_amount) FROM locked_allocation) >=
                               (SELECT MIN(amount) FROM locked_reservation))
                         THEN 'ok' ELSE 'mismatch' END AS outcome
           ), cancelled AS (
             UPDATE order_intents intent
             SET status = 'cancelled', terminal_at = $2, updated_at = $2,
                 version = intent.version + 1,
                 request_payload = request_payload || jsonb_build_object(
                   'recoveryReason', 'STALE_READY_INTENT_RECOVERY'
                 ),
                 lifecycle_fingerprint = encode(sha256(convert_to(
                   concat_ws('|', intent.id, intent.lifecycle_fingerprint, 'cancelled',
                     'STALE_READY_INTENT_RECOVERY'), 'UTF8')), 'hex')
             WHERE intent.id = $1 AND intent.status = 'ready_for_submission'
               AND NOT EXISTS (SELECT 1 FROM orders existing_order WHERE existing_order.order_intent_id = intent.id)
               AND (SELECT outcome = 'ok' FROM validation)
               AND ${fenceSqlAt(3)}
             RETURNING intent.id, intent.account_id, intent.reservation_id
           ), released AS (
             UPDATE buying_power_reservations reservation
             SET status = 'released', released_at = $2,
                 release_reason = 'STALE_READY_INTENT_RECOVERY',
                 updated_at = $2, version = reservation.version + 1
             FROM cancelled
             WHERE reservation.id = cancelled.reservation_id
               AND reservation.status IN ('active', 'committed')
               AND (SELECT outcome = 'ok' FROM validation)
               AND ${fenceSqlAt(3)}
             RETURNING reservation.account_id, reservation.strategy_key, reservation.amount
           ), adjusted AS (
             UPDATE strategy_allocations allocation
             SET reserved_amount = allocation.reserved_amount - released.amount,
                 updated_at = $2, version = allocation.version + 1
             FROM released
             WHERE allocation.account_id = released.account_id
               AND allocation.strategy_key = released.strategy_key
               AND allocation.status = 'active' AND allocation.effective_to IS NULL
               AND (SELECT outcome = 'ok' FROM validation)
               AND ${fenceSqlAt(3)}
             RETURNING allocation.id
           )
           SELECT (SELECT outcome FROM validation) AS outcome,
                  (SELECT COUNT(*) FROM cancelled)::text AS cancelled_count,
                  (SELECT COUNT(*) FROM released)::text AS released_count,
                  (SELECT COUNT(*) FROM adjusted)::text AS adjusted_count`,
          [row.id, now.toISOString(), ...values.slice(1)]
        );
        if (String(cancelled.rows[0]?.outcome ?? "mismatch") !== "ok") {
          throw new Error("POSTGRES_STALE_READY_RESERVATION_ALLOCATION_MISMATCH");
        }
        if (Number(cancelled.rows[0]?.cancelled_count ?? 0) !== 1) continue;
        const releasedCount = Number(cancelled.rows[0]?.released_count ?? 0);
        const adjustedCount = Number(cancelled.rows[0]?.adjusted_count ?? 0);
        if (releasedCount > 0 && adjustedCount !== releasedCount) {
          throw new Error("POSTGRES_STALE_READY_RESERVATION_RELEASE_FAILED");
        }
        staleReadyCancelled += 1;
        staleReadyReservationsReleased += releasedCount;
        staleReadyAllocationsAdjusted += adjustedCount;
      }
    }
  }
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
    `WITH locked_reservations AS MATERIALIZED (
       SELECT reservation.id, reservation.account_id, reservation.strategy_key,
              reservation.amount
       FROM buying_power_reservations reservation
       WHERE reservation.status = 'active' AND reservation.expires_at <= $1
         AND ${fenceSql}
       FOR UPDATE
     ), locked_allocations AS MATERIALIZED (
       SELECT allocation.id, allocation.account_id, allocation.strategy_key,
              allocation.reserved_amount
       FROM strategy_allocations allocation
       WHERE allocation.status = 'active' AND allocation.effective_to IS NULL
         AND EXISTS (
           SELECT 1 FROM locked_reservations reservation
           WHERE reservation.account_id = allocation.account_id
             AND reservation.strategy_key = allocation.strategy_key
         )
       FOR UPDATE
     ), grouped AS (
       SELECT reservation.account_id, reservation.strategy_key,
              SUM(reservation.amount) AS expired_sum,
              COUNT(DISTINCT allocation.id) AS allocation_count,
              MIN(allocation.reserved_amount) AS allocation_reserved
       FROM locked_reservations reservation
       LEFT JOIN locked_allocations allocation
         ON allocation.account_id = reservation.account_id
        AND allocation.strategy_key = reservation.strategy_key
       GROUP BY reservation.account_id, reservation.strategy_key
     ), validation AS (
       SELECT CASE WHEN COUNT(*) FILTER (
         WHERE grouped.allocation_count <> 1
            OR grouped.allocation_reserved < grouped.expired_sum
       ) > 0 THEN 'mismatch' ELSE 'ok' END AS outcome
       FROM grouped
     ), totals AS (
       SELECT account_id, strategy_key, SUM(amount) AS amount
       FROM locked_reservations
       GROUP BY account_id, strategy_key
     ), allocation_updates AS (
       UPDATE strategy_allocations allocation
       SET reserved_amount = allocation.reserved_amount - totals.amount,
           version = allocation.version + 1, updated_at = $1
       FROM totals, validation
       WHERE allocation.account_id = totals.account_id
         AND allocation.strategy_key = totals.strategy_key
         AND allocation.status = 'active' AND allocation.effective_to IS NULL
         AND validation.outcome = 'ok'
         AND allocation.reserved_amount >= totals.amount
         AND ${fenceSql}
       RETURNING allocation.id
     ), expired AS (
       UPDATE buying_power_reservations reservation
       SET status = 'expired', released_at = $1, release_reason = 'expired',
           updated_at = $1, version = version + 1
       FROM locked_reservations locked, validation
       WHERE reservation.id = locked.id
         AND validation.outcome = 'ok'
         AND reservation.status = 'active' AND reservation.expires_at <= $1
         AND ${fenceSql}
       RETURNING reservation.id
     )
     SELECT validation.outcome,
            (SELECT COUNT(*) FROM expired)::text AS expired_reservation_count
     FROM validation
     UNION ALL
     SELECT 'ok', '0'
     WHERE NOT EXISTS (SELECT 1 FROM validation)`,
    values
  );
  const reservationOutcome = String(reservations.rows[0]?.outcome ?? "mismatch");
  if (reservationOutcome !== "ok") {
    throw new Error("POSTGRES_RECOVERY_RESERVATION_ALLOCATION_MISMATCH");
  }
  const expiredReservationCount = Number(reservations.rows[0]?.expired_reservation_count ?? 0);
  if (!Number.isSafeInteger(expiredReservationCount) || expiredReservationCount < 0) {
    throw new Error("POSTGRES_RECOVERY_RESERVATION_ALLOCATION_MISMATCH");
  }
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
  const intents = await query.query(
    `WITH stale AS (
       SELECT intent.id
       FROM order_intents intent
       JOIN execution_reviews review ON review.id = intent.execution_review_id
       WHERE intent.status = 'created'
         AND (review.status IN ('expired', 'revoked', 'blocked') OR review.expires_at <= $1)
         AND ${fenceSql}
     ), cancelled AS (
       UPDATE order_intents intent
       SET status = 'cancelled', terminal_at = $1, updated_at = $1,
           version = intent.version + 1,
           lifecycle_fingerprint = encode(sha256(convert_to(
             concat_ws('|', intent.id, intent.lifecycle_fingerprint, 'cancelled',
               to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
             'UTF8'
           )), 'hex')
       FROM execution_reviews review
       WHERE intent.id IN (SELECT stale.id FROM stale)
         AND intent.execution_review_id = review.id
         AND intent.status = 'created'
         AND (review.status IN ('expired', 'revoked', 'blocked') OR review.expires_at <= $1)
         AND ${fenceSql}
       RETURNING intent.id, intent.account_id, intent.execution_review_id,
                 intent.lifecycle_fingerprint
     ), fingerprints AS (
       INSERT INTO lifecycle_fingerprints(
         id, account_id, order_intent_id, entity_type, entity_id,
         lifecycle_stage, fingerprint, algorithm, payload_version, evidence,
         captured_at, created_at
       )
       SELECT 'recovery_order_intent_cancelled:' || cancelled.id,
              cancelled.account_id, cancelled.id, 'order_intent', cancelled.id,
              'cancelled', cancelled.lifecycle_fingerprint, 'sha256', 1,
              jsonb_build_object(
                'executionReviewId', review.id,
                'reviewStatus', review.status,
                'reviewExpiresAt', review.expires_at,
                'recoveryReason', 'STALE_CREATED_INTENT_RECOVERY'
              ),
              $1, $1
       FROM cancelled
       JOIN execution_reviews review ON review.id = cancelled.execution_review_id
       RETURNING order_intent_id
     )
     SELECT cancelled.id
     FROM cancelled
     JOIN fingerprints ON fingerprints.order_intent_id = cancelled.id`,
    values
  );
  return {
    researchRuns: researchRuns.rowCount ?? 0,
    reservations: expiredReservationCount,
    reviews: reviews.rowCount ?? 0,
    confirmations: confirmations.rowCount ?? 0,
    intents: intents.rowCount ?? 0,
    staleReadyIntents,
    staleReadyCancelled,
    staleReadyPreserved,
    staleReadyReservationsReleased,
    staleReadyAllocationsAdjusted
  };
};

export const runAutonomousPostgresCommand = async (input: {
  readonly command: string;
  readonly query: AutonomousPostgresQueryExecutor;
  readonly fence: SchedulerFence;
  readonly now?: Date;
  readonly getOrderByClientOrderId?: StaleReadyOrderLookup;
}) => {
  if (!INSPECTION_COMMANDS.has(input.command)) {
    throw new Error(`POSTGRES_AUTONOMOUS_COMMAND_UNSUPPORTED: ${input.command}`);
  }
  const now = input.now ?? new Date();
  const recovery = input.command === "system:recover"
    ? await runAutonomousPostgresRecovery(input.query, input.fence, now, {
        getOrderByClientOrderId: input.getOrderByClientOrderId
      })
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
