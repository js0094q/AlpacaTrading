import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-paper-review-artifact-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.PAPER_REVIEW_SIGNING_KEY = "paper-review-test-key";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  createPaperReviewArtifact,
  verifyPaperReviewArtifact,
  type PaperReviewArtifact
} from "../src/services/paperReviewArtifactService.js";

const emptySections = () => ({
  equityBuys: [],
  equityAdds: [],
  equitySells: [],
  optionBuys: [],
  optionSellToCloseExits: []
});

const createArtifact = () =>
  createPaperReviewArtifact({
    id: "review-signed-artifact",
    sourceAction: "paper.ops.review",
    status: "success",
    createdAt: "2026-07-14T14:00:00.000Z",
    maxAgeMinutes: 30,
    payloadSections: emptySections(),
    summary: { payloads: 0 }
  });

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

beforeEach(() => {
  process.env.PAPER_REVIEW_SIGNING_KEY = "paper-review-test-key";
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_review_decisions;
    DELETE FROM decision_lifecycle_events;
    DELETE FROM decision_snapshots;
    DELETE FROM paper_review_artifacts;
  `);
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("paper review artifact authentication", () => {
  test("creates and verifies a canonical HMAC-signed artifact", () => {
    const artifact = createArtifact();
    const verification = verifyPaperReviewArtifact({
      artifact,
      asOf: "2026-07-14T14:05:00.000Z"
    });

    assert.equal(artifact.artifact.recordType, "paper_review_artifact");
    assert.equal(artifact.artifact.signatureAlgorithm, "hmac-sha256");
    assert.match(artifact.artifact.artifactHash, /^[a-f0-9]{64}$/);
    assert.match(artifact.artifact.signature, /^[a-f0-9]{64}$/);
    assert.equal(verification.valid, true);
    assert.deepEqual(verification.blockers, []);
  });

  test("rejects a wrong key and an expired artifact", () => {
    const artifact = createArtifact();

    const wrongKey = verifyPaperReviewArtifact({
      artifact,
      signingKey: "wrong-key",
      asOf: "2026-07-14T14:05:00.000Z"
    });
    const expired = verifyPaperReviewArtifact({
      artifact,
      asOf: "2026-07-14T14:31:00.000Z"
    });

    assert.ok(wrongKey.blockers.includes("REVIEW_ARTIFACT_SIGNATURE_INVALID"));
    assert.ok(expired.blockers.includes("REVIEW_ARTIFACT_EXPIRED"));
  });

  test("rejects payload tampering and database payload-hash mismatch", () => {
    const artifact = createArtifact();
    const tampered = clone(artifact);
    tampered.artifact.payloadSections.equityBuys.push({ symbol: "AAPL" });
    const rowMismatch = clone(artifact);
    rowMismatch.payloadSignature = "f".repeat(64);

    const payloadChanged = verifyPaperReviewArtifact({
      artifact: tampered,
      asOf: "2026-07-14T14:05:00.000Z"
    });
    const storedHashChanged = verifyPaperReviewArtifact({
      artifact: rowMismatch,
      asOf: "2026-07-14T14:05:00.000Z"
    });

    assert.ok(payloadChanged.blockers.includes("REVIEW_ARTIFACT_PAYLOAD_CHANGED"));
    assert.ok(storedHashChanged.blockers.includes("REVIEW_ARTIFACT_PAYLOAD_CHANGED"));
  });

  test("rejects an unsigned legacy artifact", () => {
    const artifact = clone(createArtifact()) as PaperReviewArtifact;
    const legacyBody = artifact.artifact as unknown as Record<string, unknown>;
    delete legacyBody.recordType;
    delete legacyBody.signatureAlgorithm;
    delete legacyBody.artifactHash;
    delete legacyBody.signature;

    const verification = verifyPaperReviewArtifact({
      artifact,
      asOf: "2026-07-14T14:05:00.000Z"
    });

    assert.ok(verification.blockers.includes("REVIEW_ARTIFACT_SIGNATURE_INVALID"));
  });

  test("requires a signing key when creating an artifact", () => {
    delete process.env.PAPER_REVIEW_SIGNING_KEY;

    assert.throws(createArtifact, /PAPER_REVIEW_SIGNING_KEY_REQUIRED/);
  });
});
