import assert from "node:assert/strict";
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
            completed_at: new Date("2026-07-24T15:05:00.000Z")
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
            position_id: "position-1",
            reservation_id: "reservation-1",
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
              limitPriceConstruction: { limitPrice: 5 }
            }
          }],
          rowCount: 1
        };
      }
      if (statement.includes("FROM execution_reviews review")) {
        return { rows: [{ review_id: "review-1", intent_id: "intent-1" }], rowCount: 1 };
      }
      if (statement.includes("FROM order_intents intent")) {
        return {
          rows: [{
            intent_id: "intent-smci",
            symbol: "SMCI",
            intent_status: "cancelled",
            intent_terminal_reason: "STALE_READY_INTENT_RECOVERY",
            reservation_status: "expired",
            broker_order_id: null
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
            duration_ms: 4264
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

  assert.equal(result.latestPaperPlans[0]?.candidate_id, "candidate-1");
  assert.equal(result.orderIntents[0]?.intent_id, "intent-smci");
  assert.equal(result.orderIntents[0]?.intent_terminal_reason, "STALE_READY_INTENT_RECOVERY");
  assert.equal(result.autonomousLifecycle[0]?.classification, "no_action");
  assert.equal(result.readyIntentCount, 0);

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

  const lifecycleSql = sql.find((statement) => statement.includes("WITH latest_terminal")) ?? "";
  assert.match(lifecycleSql, /workstream_completed/);
  assert.match(lifecycleSql, /reasonCode/);
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
