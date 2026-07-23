import { DatabaseSync } from "node:sqlite";

export const executionStateCandidateId = "candidate-execution-1";

export const createExecutionStateSnapshotFixture = (
  path: string,
  options: { capturedAt?: string; positionMarketValue?: number } = {}
) => {
  const capturedAt = options.capturedAt ?? "2026-07-16T16:00:00.000Z";
  const expiresAt = new Date(Date.parse(capturedAt) + 60 * 60 * 1_000).toISOString();
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE paper_trade_candidates (id TEXT PRIMARY KEY);
    CREATE TABLE decision_snapshots (
      decision_id TEXT PRIMARY KEY,
      candidate_id TEXT,
      position_lifecycle_id TEXT
    );
    CREATE TABLE paper_review_artifacts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      source_action TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_signature TEXT NOT NULL,
      payload_count INTEGER NOT NULL,
      artifact_json TEXT NOT NULL
    );
    CREATE TABLE hedge_execution_reviews (
      review_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      review_json TEXT NOT NULL
    );
    CREATE TABLE paper_execution_ledger (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      symbol TEXT NOT NULL,
      underlying_symbol TEXT,
      strategy TEXT,
      side TEXT,
      order_type TEXT,
      time_in_force TEXT,
      qty TEXT,
      notional TEXT,
      limit_price TEXT,
      estimated_premium REAL,
      max_risk REAL,
      dedupe_key TEXT NOT NULL,
      client_order_id TEXT NOT NULL UNIQUE,
      alpaca_order_id TEXT,
      alpaca_status TEXT,
      request_id TEXT,
      source_plan_id TEXT,
      source_candidate_id TEXT,
      decision_id TEXT,
      position_lifecycle_id TEXT,
      decision_linkage_status TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      blocked_reason TEXT,
      error_message TEXT,
      payload_json TEXT NOT NULL,
      raw_payload_json TEXT,
      raw_response_json TEXT
    );
    CREATE TABLE paper_positions (
      position_lifecycle_id TEXT PRIMARY KEY,
      entry_decision_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      option_symbol TEXT,
      asset_class TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_client_order_id TEXT NOT NULL,
      status TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      entry_quantity REAL,
      entry_price REAL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO paper_trade_candidates(id) VALUES ('candidate-execution-1');
    INSERT INTO decision_snapshots(decision_id, candidate_id, position_lifecycle_id)
    VALUES ('11111111-1111-4111-8111-111111111111', 'candidate-execution-1', NULL);
  `);
  const state = {
    version: "paper-submit-state-v1",
    capturedAt,
    accountIdentityHash: "account-hash-release-4",
    accountState: {
      status: "ACTIVE",
      cash: 4000.123456789,
      equity: 10000.123456789,
      buyingPower: 8000.123456789,
      optionsBuyingPower: 5000.123456789,
      optionsApprovalLevel: 2,
      tradingBlocked: false,
      accountBlocked: false
    },
    configuration: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      maxPositionNotional: 2500,
      maxTotalPlanNotional: 5000,
      equityMaxNotionalPerOrder: 1000,
      equityMaxPortfolioDeployPct: 50,
      equityMaxPositionPct: 20,
      equityMinCashReservePct: 20,
      optionMaxOrderNotional: 500,
      optionMaxContracts: 2,
      optionMaxPortfolioRiskPct: 5,
      optionMaxPositionRiskPct: 2,
      quoteMaxAgeSeconds: 30,
      maxPriceDriftPct: 2
    },
    configurationFingerprint: "release-4-configuration-fingerprint",
    positions: options.positionMarketValue === undefined ? [] : [{
      symbol: "AAPL",
      assetClass: "equity" as const,
      quantity: 1,
      marketValue: options.positionMarketValue,
      currentPrice: options.positionMarketValue
    }],
    openOrders: [{
      symbol: "SPY",
      assetClass: "equity",
      side: "buy",
      status: "accepted",
      quantity: 2,
      notional: null,
      limitPrice: 500.123456789,
      clientOrderIdHash: "client-order-hash"
    }],
    reservations: [],
    marketEvidence: [],
    payloadIntents: [],
    structuralPortfolioFingerprint: "release-4-structural-fingerprint",
    portfolioFingerprint: "release-4-portfolio-fingerprint",
    marketEvidenceFingerprint: "release-4-market-fingerprint",
    allocationAttestation: {
      mode: "baseline",
      identity: "baseline-v1",
      allocatorControlled: false
    },
    complete: true,
    blockers: [],
    warnings: []
  };
  const artifact = {
    recordType: "paper_review_artifact",
    id: "review-release-4",
    createdAt: capturedAt,
    expiresAt,
    sourceAction: "paper:review",
    status: "approved",
    payloadSignature: "release-4-payload-signature",
    payloadSections: {
      equityBuys: [],
      equityAdds: [],
      equitySells: [],
      optionBuys: [],
      optionSellToCloseExits: []
    },
    submitState: state,
    summary: {},
    warnings: [],
    blockers: [],
    signatureAlgorithm: "hmac-sha256",
    artifactHash: "release-4-artifact-hash",
    signature: "release-4-signature"
  };
  database.prepare(`
    INSERT INTO paper_review_artifacts(
      id, created_at, expires_at, source_action, status,
      payload_signature, payload_count, artifact_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.id,
    artifact.createdAt,
    artifact.expiresAt,
    artifact.sourceAction,
    artifact.status,
    artifact.payloadSignature,
    1,
    JSON.stringify(artifact)
  );
  database.prepare(`
    INSERT INTO paper_execution_ledger(
      id, created_at, updated_at, mode, asset_class, symbol,
      underlying_symbol, strategy, side, order_type, time_in_force,
      qty, notional, limit_price, estimated_premium, max_risk,
      dedupe_key, client_order_id, alpaca_order_id, alpaca_status,
      request_id, source_plan_id, source_candidate_id, decision_id,
      position_lifecycle_id, decision_linkage_status, status,
      reason, blocked_reason, error_message, payload_json,
      raw_payload_json, raw_response_json
    ) VALUES (
      1, ?, ?, 'confirmPaper', 'equity', 'SPY', NULL, 'reviewed-paper',
      'buy', 'limit', 'day', '2.0000000000004', NULL, '500.123456789',
      NULL, 1000.246913578, 'release-4-dedupe', 'release-4-client-order',
      'release-4-broker-order', 'accepted', 'release-4-request',
      'review-release-4', 'candidate-execution-1',
      '11111111-1111-4111-8111-111111111111', NULL, 'EXACT', 'accepted',
      NULL, NULL, NULL, ?, ?, ?
    )
  `).run(
    "2026-07-16T16:05:00.000Z",
    "2026-07-16T16:05:01.000Z",
    JSON.stringify({ symbol: "SPY", qty: "2.0000000000004", limit_price: "500.123456789" }),
    JSON.stringify({ position_intent: "buy" }),
    JSON.stringify({
      id: "release-4-broker-order",
      client_order_id: "release-4-client-order",
      status: "accepted",
      filled_qty: "0"
    })
  );
  database.close();
};
