import test from "node:test";
import assert from "node:assert/strict";

process.env.DASHBOARD_CONTROL_NO_START = "1";
const { normalizeControlPayload } = await import("../server/dashboard-control/server.js");
const { redactSensitiveData } = await import("../src/lib/securityRedaction.js");

test("dashboard control payload normalization recursively serializes dates", () => {
  const input = {
    createdAt: new Date("2026-07-24T16:42:00.000Z"),
    nullable: null,
    rows: [{ observedAt: new Date("2026-07-24T16:43:00.000Z"), value: 3 }],
    result: {
      rows: [{ nested: { expiresAt: new Date("2026-07-24T16:44:00.000Z") } }],
      rowCount: 1
    }
  };

  assert.deepEqual(normalizeControlPayload(input), {
    createdAt: "2026-07-24T16:42:00.000Z",
    nullable: null,
    rows: [{ observedAt: "2026-07-24T16:43:00.000Z", value: 3 }],
    result: {
      rows: [{ nested: { expiresAt: "2026-07-24T16:44:00.000Z" } }],
      rowCount: 1
    }
  });
});

test("dashboard response serialization normalizes dates before redaction", () => {
  const serialized = redactSensitiveData(normalizeControlPayload({
    generatedAt: new Date("2026-07-24T16:45:00.000Z"),
    token: "super-secret-token",
    nested: { password: "another-secret", nullable: null }
  }));

  assert.deepEqual(serialized, {
    generatedAt: "2026-07-24T16:45:00.000Z",
    token: "[REDACTED:token]",
    nested: { password: "[REDACTED:password]", nullable: null }
  });
});
