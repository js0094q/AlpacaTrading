import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

process.env.RESEARCH_DB_PATH = join(mkdtempSync(join(tmpdir(), "hedge-reservation-")), "research.db");

import { closeDbForTests } from "../src/lib/db.js";
import {
  releaseExpiredHedgeReservations,
  reservePaperExecutionAttempt
} from "../src/services/paperExecutionLedgerService.js";

test("atomically reserves one deterministic client order id and releases abandoned reservations", () => {
  const input = {
    reviewId: "hedge-review-1",
    clientOrderId: "hedge-entry-1",
    symbol: "SPY260918P00500000",
    underlyingSymbol: "SPY",
    quantity: 1,
    limitPrice: 5,
    estimatedPremium: 500,
    expiresAt: "2026-07-13T14:01:00.000Z"
  };
  const first = reservePaperExecutionAttempt(input);
  const second = reservePaperExecutionAttempt(input);
  assert.equal(first.reserved, true);
  assert.equal(second.reserved, false);
  assert.ok(second.blockers.includes("HEDGE_DUPLICATE_ORDER"));
  assert.equal(releaseExpiredHedgeReservations("2026-07-13T14:02:00.000Z"), 1);
  closeDbForTests();
});
