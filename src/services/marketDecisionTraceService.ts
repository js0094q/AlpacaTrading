import { queryAll, queryOne } from "../lib/db.js";
import type { DecisionId, PositionLifecycleId } from "../types.js";
import { asDecisionId } from "./marketDecisionIdentityService.js";

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const buildMarketDecisionTrace = (rawDecisionId: string) => {
  const decisionId = asDecisionId(rawDecisionId);
  const snapshot = queryOne<{
    decision_id: DecisionId;
    origin_type: string;
    origin_id: string;
    decision_role: string;
    candidate_id: string | null;
    position_lifecycle_id: PositionLifecycleId | null;
    created_at: string;
    strategy_family: string | null;
    symbol: string | null;
    underlying_symbol: string | null;
    option_symbol: string | null;
    research_run_id: string | null;
    candidate_rank: number | null;
    candidate_status: string | null;
    decision_status: string;
    score: number | null;
    confidence: number | null;
    reason_codes_json: string;
    rationale: string | null;
    data_quality_status: string;
    source_timestamps_json: string;
    environment: string;
    git_sha: string | null;
    config_allowlist_version: string;
    strategy_config_hash: string | null;
    risk_config_hash: string | null;
    broker_request_id: string | null;
    market_data_request_id: string | null;
    feed: string | null;
  }>(
    `
    SELECT decision_id, origin_type, origin_id, decision_role, candidate_id,
           position_lifecycle_id, created_at, strategy_family, symbol,
           underlying_symbol, option_symbol, research_run_id, candidate_rank,
           candidate_status, decision_status, score, confidence,
           reason_codes_json, rationale, data_quality_status,
           source_timestamps_json, environment, git_sha,
           config_allowlist_version, strategy_config_hash, risk_config_hash,
           broker_request_id, market_data_request_id, feed
    FROM decision_snapshots
    WHERE decision_id = ?
    LIMIT 1
    `,
    [decisionId]
  );
  if (!snapshot) {
    throw new Error("DECISION_NOT_FOUND");
  }

  const position = queryOne<{
    position_lifecycle_id: PositionLifecycleId;
    entry_decision_id: DecisionId;
    terminal_exit_decision_id: DecisionId | null;
    symbol: string;
    option_symbol: string | null;
    asset_class: string;
    side: string;
    broker_entry_order_id: string | null;
    entry_client_order_id: string;
    status: string;
    opened_at: string;
    closed_at: string | null;
    entry_quantity: number | null;
    entry_price: number | null;
    linkage_status: string;
  }>(
    `
    SELECT position_lifecycle_id, entry_decision_id, terminal_exit_decision_id,
           symbol, option_symbol, asset_class, side, broker_entry_order_id,
           entry_client_order_id, status, opened_at, closed_at, entry_quantity,
           entry_price, linkage_status
    FROM paper_positions
    WHERE entry_decision_id = ? OR terminal_exit_decision_id = ?
       OR position_lifecycle_id = ?
    ORDER BY opened_at
    LIMIT 1
    `,
    [decisionId, decisionId, snapshot.position_lifecycle_id]
  );
  const positionLifecycleId =
    position?.position_lifecycle_id ?? snapshot.position_lifecycle_id;

  const outcome = positionLifecycleId
    ? queryOne<Record<string, unknown>>(
        `
        SELECT outcome_id AS outcomeId,
               position_lifecycle_id AS positionLifecycleId,
               entry_decision_id AS entryDecisionId,
               exit_decision_id AS exitDecisionId,
               terminal_status AS terminalStatus,
               closed_at AS closedAt,
               entry_price AS entryPrice,
               exit_price AS exitPrice,
               quantity,
               realized_pnl AS realizedPnl,
               realized_return_pct AS realizedReturnPct,
               unrealized_return_pct AS unrealizedReturnPct,
               option_position_return_pct AS optionPositionReturnPct,
               underlying_return_pct AS underlyingReturnPct,
               holding_duration_ms AS holdingDurationMs,
               mfe_pct AS mfePct,
               mae_pct AS maePct,
               time_to_mfe_ms AS timeToMfeMs,
               time_to_mae_ms AS timeToMaeMs,
               time_to_first_profit_ms AS timeToFirstProfitMs,
               maximum_runup_pct AS maximumRunupPct,
               maximum_drawdown_pct AS maximumDrawdownPct,
               exit_reason_code AS exitReasonCode,
               data_quality_status AS dataQualityStatus,
               completeness_status AS completenessStatus,
               evaluation_reason AS evaluationReason,
               created_at AS createdAt
        FROM paper_position_outcomes
        WHERE position_lifecycle_id = ?
        LIMIT 1
        `,
        [positionLifecycleId]
      )
    : null;
  const outcomeId = typeof outcome?.outcomeId === "string" ? outcome.outcomeId : null;

  return {
    readOnly: true as const,
    paperOnly: true as const,
    decision: {
      decisionId: snapshot.decision_id,
      originType: snapshot.origin_type,
      originId: snapshot.origin_id,
      decisionRole: snapshot.decision_role,
      candidateId: snapshot.candidate_id,
      positionLifecycleId: snapshot.position_lifecycle_id,
      createdAt: snapshot.created_at,
      strategyFamily: snapshot.strategy_family,
      symbol: snapshot.symbol,
      underlyingSymbol: snapshot.underlying_symbol,
      optionSymbol: snapshot.option_symbol,
      researchRunId: snapshot.research_run_id,
      candidateRank: snapshot.candidate_rank,
      candidateStatus: snapshot.candidate_status,
      decisionStatus: snapshot.decision_status,
      score: snapshot.score,
      confidence: snapshot.confidence,
      reasonCodes: parseJson<string[]>(snapshot.reason_codes_json, []),
      rationale: parseJson<unknown>(snapshot.rationale, snapshot.rationale),
      dataQualityStatus: snapshot.data_quality_status,
      sourceTimestamps: parseJson<Record<string, string | null>>(
        snapshot.source_timestamps_json,
        {}
      ),
      environment: snapshot.environment,
      gitSha: snapshot.git_sha,
      configAllowlistVersion: snapshot.config_allowlist_version,
      strategyConfigHash: snapshot.strategy_config_hash,
      riskConfigHash: snapshot.risk_config_hash,
      brokerRequestId: snapshot.broker_request_id,
      marketDataRequestId: snapshot.market_data_request_id,
      feed: snapshot.feed
    },
    events: queryAll<Record<string, unknown>>(
      `
      SELECT event_id AS eventId, status, reason_codes_json AS reasonCodesJson,
             occurred_at AS occurredAt, source_type AS sourceType,
             source_id AS sourceId
      FROM decision_lifecycle_events
      WHERE decision_id = ?
      ORDER BY occurred_at, event_id
      `,
      [decisionId]
    ).map((event) => ({
      ...event,
      reasonCodes: parseJson<string[]>(String(event.reasonCodesJson ?? "[]"), []),
      reasonCodesJson: undefined
    })),
    reviewLinks: queryAll<Record<string, unknown>>(
      `
      SELECT prd.artifact_id AS artifactId, prd.section,
             prd.payload_index AS payloadIndex, prd.decision_role AS decisionRole,
             pra.created_at AS createdAt, pra.expires_at AS expiresAt,
             pra.source_action AS sourceAction, pra.status,
             pra.payload_signature AS payloadSignature
      FROM paper_review_decisions prd
      JOIN paper_review_artifacts pra ON pra.id = prd.artifact_id
      WHERE prd.decision_id = ?
      ORDER BY pra.created_at, prd.section, prd.payload_index
      `,
      [decisionId]
    ),
    execution: queryAll<Record<string, unknown>>(
      `
      SELECT id, created_at AS createdAt, updated_at AS updatedAt, mode,
             asset_class AS assetClass, symbol, underlying_symbol AS underlyingSymbol,
             strategy, side, order_type AS orderType, time_in_force AS timeInForce,
             qty, notional, limit_price AS limitPrice, dedupe_key AS dedupeKey,
             client_order_id AS clientOrderId, alpaca_order_id AS alpacaOrderId,
             alpaca_status AS alpacaStatus, request_id AS requestId,
             source_plan_id AS sourcePlanId, source_candidate_id AS sourceCandidateId,
             decision_id AS decisionId, position_lifecycle_id AS positionLifecycleId,
             decision_linkage_status AS decisionLinkageStatus, status, reason,
             blocked_reason AS blockedReason
      FROM paper_execution_ledger
      WHERE decision_id = ? OR position_lifecycle_id = ?
      ORDER BY created_at, id
      `,
      [decisionId, positionLifecycleId]
    ),
    position: position
      ? {
          positionLifecycleId: position.position_lifecycle_id,
          entryDecisionId: position.entry_decision_id,
          terminalExitDecisionId: position.terminal_exit_decision_id,
          symbol: position.symbol,
          optionSymbol: position.option_symbol,
          assetClass: position.asset_class,
          side: position.side,
          brokerEntryOrderId: position.broker_entry_order_id,
          entryClientOrderId: position.entry_client_order_id,
          status: position.status,
          openedAt: position.opened_at,
          closedAt: position.closed_at,
          entryQuantity: position.entry_quantity,
          entryPrice: position.entry_price,
          linkageStatus: position.linkage_status
        }
      : null,
    observations: positionLifecycleId
      ? queryAll<Record<string, unknown>>(
          `
          SELECT o.observation_id AS observationId,
                 l.linkage_status AS linkageStatus, o.broker_symbol_key AS brokerSymbolKey,
                 o.symbol, o.option_symbol AS optionSymbol, o.observed_at AS observedAt,
                 o.source_timestamp AS sourceTimestamp,
                 o.broker_request_id AS brokerRequestId,
                 o.market_data_request_id AS marketDataRequestId, o.feed,
                 o.underlying_price AS underlyingPrice, o.bid, o.ask, o.midpoint,
                 o.mark, o.quantity, o.average_entry_price AS averageEntryPrice,
                 o.market_value AS marketValue, o.unrealized_pnl AS unrealizedPnl,
                 o.unrealized_return AS unrealizedReturn, o.realized_pnl AS realizedPnl,
                 o.delta, o.gamma, o.theta, o.vega, o.rho,
                 o.implied_volatility AS impliedVolatility,
                 o.quote_freshness AS quoteFreshness,
                 o.data_quality_status AS dataQualityStatus
          FROM paper_position_observation_links l
          JOIN paper_position_observations o ON o.observation_id = l.observation_id
          WHERE l.position_lifecycle_id = ?
          ORDER BY o.observed_at, o.observation_id
          `,
          [positionLifecycleId]
        )
      : [],
    outcome,
    outcomeRevisions: outcomeId
      ? queryAll<Record<string, unknown>>(
          `
          SELECT revision_id AS revisionId, outcome_id AS outcomeId,
                 revision_number AS revisionNumber,
                 supersedes_revision_id AS supersedesRevisionId,
                 correction_reason AS correctionReason, created_at AS createdAt
          FROM paper_position_outcome_revisions
          WHERE outcome_id = ?
          ORDER BY revision_number
          `,
          [outcomeId]
        )
      : [],
    learning: queryAll<Record<string, unknown>>(
      `
      SELECT id, created_at AS createdAt, updated_at AS updatedAt,
             strategy_family AS strategyFamily, symbol,
             underlying_symbol AS underlyingSymbol, option_symbol AS optionSymbol,
             decision, skip_reason AS skipReason, block_reason AS blockReason,
             hypothesis, learning_status AS learningStatus,
             promotion_eligible AS promotionEligible,
             promotion_block_reason AS promotionBlockReason,
             source_research_run_id AS sourceResearchRunId,
             source_candidate_id AS sourceCandidateId,
             decision_id AS decisionId, entry_decision_id AS entryDecisionId,
             exit_decision_id AS exitDecisionId,
             position_lifecycle_id AS positionLifecycleId,
             outcome_id AS outcomeId,
             effective_outcome_revision_id AS effectiveOutcomeRevisionId,
             outcome_completeness_status AS outcomeCompletenessStatus,
             decision_linkage_status AS decisionLinkageStatus
      FROM paper_learning_records
      WHERE decision_id = ? OR entry_decision_id = ? OR exit_decision_id = ?
         OR position_lifecycle_id = ? OR outcome_id = ?
      ORDER BY created_at, id
      `,
      [decisionId, decisionId, decisionId, positionLifecycleId, outcomeId]
    )
  };
};
