import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PostgresEvidencePanel } from "../apps/dashboard/app/components/PostgresEvidencePanel.js";
import {
  readPostgresDashboardData,
  type PostgresDashboardQuery
} from "../src/services/postgresDashboardReadService.js";

test("PostgreSQL dashboard projection returns bounded lineage, lifecycle, and premium decision evidence", async () => {
  const sql: string[] = [];
  const query: PostgresDashboardQuery = {
    query: async (statement) => {
      sql.push(statement);
      if (statement.includes("FROM research_runs research")) {
        return {
          rows: [{
            id: "research-1",
            started_at: new Date("2026-07-24T15:00:00.000Z"),
            completed_at: "not-a-timestamp",
            error_message:
              "Broker Authorization: Bearer dashboard-secret-token-value",
            raw_headers: { authorization: "Bearer must-not-leak" }
          }],
          rowCount: 1
        };
      }
      if (statement.includes("FROM candidates candidate")) {
        return {
          rows: [{
            candidate_id: "candidate-1",
            review_id: "review-1",
            confirmation_id: "confirmation-1",
            intent_id: "intent-1",
            client_order_id: "pg-1",
            broker_order_id: "broker-1",
            broker_order_status: "filled",
            position_id: "position-1",
            reservation_id: "reservation-1",
            reservation_status: "released",
            release_reason: "filled",
            last_reconciled_at: new Date("2026-07-24T15:10:00.000Z"),
            operation: "buy_to_open",
            strategy_classification: "standard_long_call",
            lifecycle_state: "position_reconciled",
            autonomous_cycle_id: "cycle-1",
            workstream_execution_id: "workstream-1",
            exit_trigger: null,
            lifecycle_reason_code: "BROKER_FILL_RECONCILED",
            premium_decision_evidence: {
              sipPrice: 100,
              opraFeed: "opra",
              bid: 4.9,
              ask: 5.1,
              historicalBarCount: 252,
              realizedVolatility: 0.21,
              finalConfidence: 0.88,
              expectedReturn: 0.03,
              positionSizingInput: { quantity: 1 },
              limitPriceConstruction: { limitPrice: 5 },
              password: "must-not-render",
              rawHeaders: { authorization: "Bearer must-not-render" }
            },
            api_key: "must-not-render"
          }],
          rowCount: 1
        };
      }
      if (statement.includes("FROM execution_reviews review")) {
        return { rows: [{ review_id: "review-1", intent_id: "intent-1" }], rowCount: 1 };
      }
      if (statement.trimStart().startsWith("SELECT intent.id AS intent_id")) {
        return {
          rows: [{
            intent_id: "intent-smci",
            symbol: "SMCI",
            intent_status: "cancelled",
            intent_terminal_reason: "STALE_READY_INTENT_RECOVERY",
            reservation_status: "expired",
            broker_order_id: null,
            lifecycle_state: "cancelled",
            operation: "buy_to_open",
            autonomous_cycle_id: "cycle-1",
            workstream_execution_id: "workstream-cancel",
            last_reconciled_at: "invalid"
          }],
          rowCount: 1
        };
      }
      if (statement.includes("FROM orders order_row")) {
        return { rows: [{ id: "order-1", broker_order_id: "broker-1" }], rowCount: 1 };
      }
      if (statement.includes("FROM option_contracts contract")) {
        return { rows: [{ option_symbol: "SPY260724C00600000", implied_volatility: 0.2 }], rowCount: 1 };
      }
      if (statement.includes("WITH latest_terminal")) {
        return {
          rows: [{
            cycle_id: "cycle-1",
            event_type: "workstream_completed",
            workstream: "paper:exit:review",
            position: 11,
            classification: "no_action",
            reason_code: "NO_POSTGRES_EXIT_TRIGGER",
            duration_ms: 4264,
            occurred_at: new Date("2026-07-24T15:15:00.000Z"),
            cycle_scope: "last_completed",
            lifecycle_state: "position_reconciled",
            operation: "buy_to_open",
            candidate_id: "candidate-1",
            review_id: "review-1",
            confirmation_id: "confirmation-1",
            intent_id: "intent-1",
            client_order_id: "pg-1",
            broker_order_id: "broker-1",
            broker_status: "filled",
            reservation_state: "released",
            reservation_release_reason: "filled",
            latest_reconciled_at: new Date("2026-07-24T15:10:00.000Z"),
            autonomous_cycle_id: "cycle-1",
            workstream_execution_id: "workstream-1",
            exit_trigger: null,
            lifecycle_reason_code: "BROKER_FILL_RECONCILED",
            decision_evidence: {
              opraFeed: "opra",
              delta: 0.5,
              rawHeaders: { authorization: "Bearer must-not-render" }
            }
          }],
          rowCount: 1
        };
      }
      if (statement.includes("COUNT(*) AS ready_count")) {
        return { rows: [{ ready_count: "0" }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_DASHBOARD_SQL:${statement.slice(0, 80)}`);
    }
  };

  const result = await readPostgresDashboardData(query, 25);
  const projectedPlan = result.latestPaperPlans[0] as Record<string, unknown>;
  const projectedPremiumEvidence =
    projectedPlan.premium_decision_evidence as Record<string, unknown>;

  assert.equal(result.latestPaperPlans[0]?.candidate_id, "candidate-1");
  assert.equal(result.orderIntents[0]?.intent_id, "intent-smci");
  assert.equal(result.orderIntents[0]?.intent_terminal_reason, "STALE_READY_INTENT_RECOVERY");
  assert.equal(result.autonomousLifecycle[0]?.classification, "no_action");
  assert.equal(result.readyIntentCount, 0);
  assert.equal(result.latestResearch[0]?.started_at, "2026-07-24T15:00:00.000Z");
  assert.equal(result.latestResearch[0]?.completed_at, null);
  assert.equal(
    result.latestPaperPlans[0]?.last_reconciled_at,
    "2026-07-24T15:10:00.000Z"
  );
  assert.equal(result.orderIntents[0]?.last_reconciled_at, null);
  assert.equal(
    result.autonomousLifecycle[0]?.occurred_at,
    "2026-07-24T15:15:00.000Z"
  );
  assert.equal(projectedPremiumEvidence.delta, null);
  assert.equal(projectedPremiumEvidence.gamma, null);
  assert.equal(result.latestPaperPlans[0]?.operation, "buy_to_open");
  assert.equal(result.latestPaperPlans[0]?.lifecycle_state, "position_reconciled");
  assert.equal(result.autonomousLifecycle[0]?.intent_id, "intent-1");
  assert.equal(result.autonomousLifecycle[0]?.broker_order_id, "broker-1");
  assert.equal(result.autonomousLifecycle[0]?.reservation_release_reason, "filled");
  assert.equal(result.autonomousLifecycle[0]?.cycle_scope, "last_completed");
  assert.doesNotMatch(
    JSON.stringify(result),
    /must-not-render|must-not-leak|dashboard-secret-token-value/i
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /"(?:rawHeaders|raw_headers|authorization|api_key|password)"\s*:/i
  );

  const candidateSql = sql.find((statement) => statement.includes("FROM candidates candidate")) ?? "";
  assert.match(candidateSql, /premium_decision_evidence/);
  assert.match(candidateSql, /signal_inputs/);
  assert.match(candidateSql, /market_evidence/);
  assert.match(candidateSql, /historical_bar_count/);
  assert.match(candidateSql, /positionSizingInput/);
  assert.match(candidateSql, /limitPriceConstruction/);

  const intentSql = sql.find((statement) => statement.includes("FROM order_intents intent")) ?? "";
  assert.match(intentSql, /recoveryReason/);
  assert.match(intentSql, /reservation_status/);
  assert.match(intentSql, /last_reconciled_at/);
  assert.match(intentSql, /lifecycle_state/);
  assert.match(intentSql, /operation/);
  assert.match(intentSql, /autonomous_cycle_id/);
  assert.match(intentSql, /workstream_execution_id/);

  const lifecycleSql = sql.find((statement) => statement.includes("WITH latest_terminal")) ?? "";
  assert.match(lifecycleSql, /workstream_completed/);
  assert.match(lifecycleSql, /reasonCode/);
  assert.match(lifecycleSql, /current_cycle/);
  assert.match(lifecycleSql, /order_intents/);
  assert.match(lifecycleSql, /exitTrigger/);
});

test("dashboard page renders current and last autonomous cycle health", () => {
  const page = readFileSync("apps/dashboard/app/page.tsx", "utf8");
  assert.match(page, /Autonomous Worker/);
  assert.match(page, /lastEventAt/);
  assert.match(page, /lastCycleCompletedAt/);
  assert.match(page, /cycleId/);
});

test("dashboard evidence component renders lineage, terminal intent, classifications, and whitelisted premium inputs", () => {
  const html = renderToStaticMarkup(
    <PostgresEvidencePanel
      plans={[{
        candidate_id: "candidate-1",
        symbol: "SPY",
        strategy_family: "standard_option",
        review_id: "review-1",
        confirmation_id: "confirmation-1",
        confirmation_status: "consumed",
        intent_id: "intent-1",
        intent_status: "reconciled",
        client_order_id: "pg-1",
        broker_order_id: "broker-1",
        broker_order_status: "filled",
        filled_quantity: 1,
        filled_average_price: 5,
        position_id: "position-1",
        position_status: "open",
        reservation_id: "reservation-1",
        reservation_status: "released",
        last_reconciled_at: "2026-07-24T15:10:00.000Z",
        premium_decision_evidence: {
          sipPrice: 600,
          opraFeed: "opra",
          bid: 4.9,
          ask: 5.1,
          spread: 0.2,
          volume: 500,
          openInterest: 1000,
          impliedVolatility: 0.25,
          delta: 0.5,
          gamma: 0.02,
          theta: -0.08,
          vega: 0.12,
          rho: 0.03,
          historicalBarCount: 252,
          realizedVolatility: 0.21,
          liquidityScore: 0.92,
          finalConfidence: 0.88,
          expectedReturn: 0.03,
          positionSizingInput: { quantity: 1 },
          limitPriceConstruction: { limitPrice: 5 },
          password: "must-not-render"
        }
      }]}
      intents={[{
        intent_id: "intent-smci",
        symbol: "SMCI",
        intent_status: "cancelled",
        intent_terminal_reason: "STALE_READY_INTENT_RECOVERY",
        reservation_status: "expired",
        broker_order_id: null
      }]}
      lifecycle={[{
        cycle_id: "cycle-1",
        position: 11,
        workstream: "paper:exit:review",
        classification: "no_action",
        reason_code: "NO_POSTGRES_EXIT_TRIGGER",
        duration_ms: 4264
      }]}
    />
  );

  for (const expected of [
    "candidate-1",
    "review-1",
    "confirmation-1",
    "intent-1",
    "pg-1",
    "broker-1",
    "position-1",
    "reservation-1",
    "intent-smci",
    "STALE_READY_INTENT_RECOVERY",
    "Successful-empty",
    "NO_POSTGRES_EXIT_TRIGGER",
    "OPRA",
    "Delta",
    "Historical bars",
    "Position sizing",
    "Limit construction"
  ]) {
    assert.match(html, new RegExp(expected));
  }
  assert.doesNotMatch(html, /must-not-render/);
});
