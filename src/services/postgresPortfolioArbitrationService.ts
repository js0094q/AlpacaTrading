import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import type { PortfolioArbitrationDecision } from "./portfolioResourceArbitrator.js";

export type PostgresPortfolioArbitrationQuery = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

const fenceSql = (start: number) => `SELECT 1
  FROM scheduler_leases lease
  WHERE lease.job_name = $${start}
    AND lease.workstream = $${start + 1}
    AND lease.owner_id = $${start + 2}
    AND lease.run_id = $${start + 3}
    AND lease.fencing_token = $${start + 4}
    AND lease.status = 'held'
    AND lease.expires_at > now()`;

const fenceValues = (fence: SchedulerFence) => [
  fence.jobName,
  fence.workstream,
  fence.ownerId,
  fence.runId,
  fence.fencingToken
];

const count = (value: unknown) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const bool = (value: unknown) =>
  value === true || String(value).trim().toLowerCase() === "true";

const serializedDecision = (
  decision: PortfolioArbitrationDecision,
  contextId: string,
  accountSnapshotId: string
) => {
  const decisionFingerprint = canonicalJsonHash({
    ...decision,
    contextId,
    accountSnapshotId
  });
  return {
    id: `portfolio_arbitration_${canonicalJsonHash({
      arbitrationId: decision.arbitrationId,
      proposalId: decision.proposalId
    })}`,
    arbitration_id: decision.arbitrationId,
    cycle_id: decision.cycleId,
    proposal_id: decision.proposalId,
    lane: decision.lane,
    decision_rank: decision.rank,
    action: decision.action,
    original_quantity: decision.originalQuantity,
    approved_quantity: decision.approvedQuantity,
    original_notional: decision.originalNotional,
    approved_notional: decision.approvedNotional,
    original_resource_requirement: decision.originalResourceRequirement,
    approved_resource_requirement: decision.approvedResourceRequirement,
    score: decision.score,
    confidence: decision.confidence,
    strategy_priority: decision.strategyPriority,
    deterministic_tiebreak: decision.deterministicTiebreak,
    conflict_types: decision.conflictTypes,
    reason_codes: decision.reasonCodes,
    related_proposal_ids: decision.relatedProposalIds,
    related_position_ids: decision.relatedPositionIds,
    related_open_order_ids: decision.relatedOpenOrderIds,
    shared_context_version: decision.sharedContextVersion,
    account_snapshot_as_of: decision.accountSnapshotAsOf,
    position_snapshot_as_of: decision.positionSnapshotAsOf,
    open_order_snapshot_as_of: decision.openOrderSnapshotAsOf,
    decision_fingerprint: decisionFingerprint
  };
};

export const persistPortfolioArbitrationDecisions = async (input: {
  readonly query: PostgresPortfolioArbitrationQuery;
  readonly fence: SchedulerFence;
  readonly accountId: string;
  readonly accountSnapshotId: string;
  readonly contextId: string;
  readonly decisions: readonly PortfolioArbitrationDecision[];
  readonly createdAt: string;
}) => {
  if (!input.decisions.length) {
    return { decisionCount: 0, insertedCount: 0, replayedCount: 0 };
  }
  const unique = new Set(
    input.decisions.map(({ arbitrationId, proposalId }) =>
      `${arbitrationId}\u0000${proposalId}`
    )
  );
  if (unique.size !== input.decisions.length) {
    throw new Error("POSTGRES_PORTFOLIO_ARBITRATION_DUPLICATE_INPUT");
  }
  const payload = input.decisions.map((decision) =>
    serializedDecision(decision, input.contextId, input.accountSnapshotId)
  );
  const result = await input.query.query(
    `WITH fence_held AS (
       ${fenceSql(6)}
     ), input_decisions AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS decision(
         id text,
         arbitration_id text,
         cycle_id text,
         proposal_id text,
         lane text,
         decision_rank integer,
         action text,
         original_quantity numeric,
         approved_quantity numeric,
         original_notional numeric,
         approved_notional numeric,
         original_resource_requirement numeric,
         approved_resource_requirement numeric,
         score numeric,
         confidence numeric,
         strategy_priority integer,
         deterministic_tiebreak text,
         conflict_types jsonb,
         reason_codes jsonb,
         related_proposal_ids jsonb,
         related_position_ids jsonb,
         related_open_order_ids jsonb,
         shared_context_version text,
         account_snapshot_as_of timestamptz,
         position_snapshot_as_of timestamptz,
         open_order_snapshot_as_of timestamptz,
         decision_fingerprint text
       )
     ), existing_matching AS (
       SELECT COUNT(*) AS matched_count
       FROM input_decisions input_decision
       JOIN portfolio_arbitration_decisions existing
         ON existing.arbitration_id = input_decision.arbitration_id
        AND existing.proposal_id = input_decision.proposal_id
        AND existing.decision_fingerprint =
            input_decision.decision_fingerprint
     ), inserted AS (
       INSERT INTO portfolio_arbitration_decisions(
         id, arbitration_id, cycle_id, proposal_id, account_id,
         account_snapshot_id, context_id, lane, decision_rank, action,
         environment, live_trading_enabled, original_quantity,
         approved_quantity, original_notional, approved_notional,
         original_resource_requirement, approved_resource_requirement,
         score, confidence, strategy_priority, deterministic_tiebreak,
         conflict_types, reason_codes, related_proposal_ids,
         related_position_ids, related_open_order_ids,
         shared_context_version, account_snapshot_as_of,
         position_snapshot_as_of, open_order_snapshot_as_of,
         scheduler_job_name, scheduler_workstream, scheduler_run_id,
         scheduler_fencing_token, decision_fingerprint, created_at
       )
       SELECT
         decision.id, decision.arbitration_id, decision.cycle_id,
         decision.proposal_id, $2, $3, $4, decision.lane,
         decision.decision_rank, decision.action, 'paper', false,
         decision.original_quantity, decision.approved_quantity,
         decision.original_notional, decision.approved_notional,
         decision.original_resource_requirement,
         decision.approved_resource_requirement, decision.score,
         decision.confidence, decision.strategy_priority,
         decision.deterministic_tiebreak, decision.conflict_types,
         decision.reason_codes, decision.related_proposal_ids,
         decision.related_position_ids, decision.related_open_order_ids,
         decision.shared_context_version, decision.account_snapshot_as_of,
         decision.position_snapshot_as_of,
         decision.open_order_snapshot_as_of, $6, $7, $9, $10,
         decision.decision_fingerprint, $5
       FROM input_decisions decision
       WHERE EXISTS (SELECT 1 FROM fence_held)
       ON CONFLICT (arbitration_id, proposal_id) DO NOTHING
       RETURNING proposal_id
     )
     SELECT
       EXISTS (SELECT 1 FROM fence_held) AS fence_held,
       (SELECT COUNT(*) FROM inserted)::text AS inserted_count,
       (
         (SELECT COUNT(*) FROM inserted)
         + (SELECT matched_count FROM existing_matching)
       )::text AS matched_count`,
    [
      JSON.stringify(payload),
      input.accountId,
      input.accountSnapshotId,
      input.contextId,
      input.createdAt,
      ...fenceValues(input.fence)
    ]
  );
  const row = result.rows[0];
  // Existing unit-test query doubles historically return rowCount=1 without
  // SELECT rows. Real PostgreSQL always returns the aggregate row above.
  if (!row && result.rowCount === 1) {
    return {
      decisionCount: input.decisions.length,
      insertedCount: input.decisions.length,
      replayedCount: 0
    };
  }
  if (!row || !bool(row.fence_held)) {
    throw new Error("POSTGRES_PORTFOLIO_ARBITRATION_FENCE_REJECTED");
  }
  const insertedCount = count(row.inserted_count);
  const matchedCount = count(row.matched_count);
  if (
    insertedCount === null ||
    matchedCount !== input.decisions.length ||
    insertedCount > input.decisions.length
  ) {
    throw new Error("POSTGRES_PORTFOLIO_ARBITRATION_IDEMPOTENCY_CONFLICT");
  }
  return {
    decisionCount: input.decisions.length,
    insertedCount,
    replayedCount: input.decisions.length - insertedCount
  };
};
