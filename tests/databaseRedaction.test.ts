import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeDatabaseError } from "../src/lib/database/redaction.js";

test("database errors retain a safe code while removing URLs, passwords, and detail fields", () => {
  const error = Object.assign(
    new Error(
      "connection failed for postgresql://synthetic:synthetic-password@host.invalid/db password=synthetic-password"
    ),
    {
      code: "ECONNRESET",
      detail: "secret detail",
      connectionString: "postgresql://synthetic:synthetic-password@host.invalid/db"
    }
  );

  const sanitized = sanitizeDatabaseError(error);
  const serialized = JSON.stringify(sanitized);

  assert.equal(sanitized.code, "ECONNRESET");
  assert.doesNotMatch(serialized, /synthetic-password|host\.invalid|secret detail/);
  assert.match(sanitized.message, /REDACTED/);
});
