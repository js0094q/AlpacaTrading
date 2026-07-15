import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COMMAND_OUTPUT_LIMIT,
  GuardedCommandError,
  normalizeCommandFailure
} from "../server/dashboard-control/commandResult.js";

describe("guarded dashboard command failures", () => {
  test("keeps structured SQLite stdout primary and records stderr warning separately", () => {
    const failure = normalizeCommandFailure({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ code: "SQLITE_BUSY", error: "database is locked" }),
      stderr: "(node:123) ExperimentalWarning: SQLite is an experimental feature"
    });

    assert.deepEqual(failure.error, {
      code: "SQLITE_BUSY",
      message: "database is locked"
    });
    assert.deepEqual(failure.warnings, [
      "(node:123) ExperimentalWarning: SQLite is an experimental feature"
    ]);
    assert.equal(failure.exitCode, 1);
    assert.equal(failure.signal, null);
    assert.equal(failure.timedOut, false);
  });

  test("retains a structured causal failure even when cleanup reaches the outer timeout", () => {
    const failure = normalizeCommandFailure({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: JSON.stringify({ code: "SQLITE_BUSY", error: "database is locked" }),
      stderr: "ExperimentalWarning: SQLite is experimental"
    });

    assert.deepEqual(failure.error, {
      code: "SQLITE_BUSY",
      message: "database is locked"
    });
    assert.equal(failure.timedOut, true);
    assert.equal(failure.signal, "SIGKILL");
  });

  test("uses a causal stderr-only failure when stdout has no structured error", () => {
    const failure = normalizeCommandFailure({
      exitCode: 2,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "fatal: unable to open database"
    });

    assert.equal(failure.error.code, "COMMAND_FAILED");
    assert.equal(failure.error.message, "fatal: unable to open database");
  });

  test("retains malformed stdout as a bounded fallback diagnostic", () => {
    const failure = normalizeCommandFailure({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "not-json command failure",
      stderr: ""
    });

    assert.equal(failure.error.code, "COMMAND_FAILED");
    assert.equal(failure.error.message, "not-json command failure");
    assert.match(failure.diagnosticExcerpt, /not-json command failure/);
  });

  test("returns structured timeout and signal metadata", () => {
    const timeout = normalizeCommandFailure({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: "",
      stderr: ""
    });
    assert.deepEqual(timeout.error, {
      code: "COMMAND_TIMEOUT",
      message: "Command timed out."
    });
    assert.equal(timeout.signal, "SIGKILL");

    const signal = normalizeCommandFailure({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: ""
    });
    assert.deepEqual(signal.error, {
      code: "COMMAND_SIGNALLED",
      message: "Command terminated by signal SIGTERM."
    });
  });

  test("redacts secrets and bounds all public output", () => {
    const secret = "APCA_API_SECRET_KEY=super-secret-value";
    const failure = normalizeCommandFailure({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ error: `${secret} ${"x".repeat(COMMAND_OUTPUT_LIMIT * 2)}` }),
      stderr: `ExperimentalWarning: ${secret} ${"y".repeat(COMMAND_OUTPUT_LIMIT * 2)}`
    });

    const serialized = JSON.stringify(failure);
    assert.equal(serialized.includes("super-secret-value"), false);
    assert.equal(failure.stdout.length <= COMMAND_OUTPUT_LIMIT, true);
    assert.equal(failure.stderr.length <= COMMAND_OUTPUT_LIMIT, true);
    assert.equal(failure.error.message.length <= COMMAND_OUTPUT_LIMIT, true);
    assert.equal(failure.diagnosticExcerpt.length <= COMMAND_OUTPUT_LIMIT, true);
  });

  test("GuardedCommandError exposes the normalized causal code and result", () => {
    const failure = normalizeCommandFailure({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ error: "database is locked" }),
      stderr: "ExperimentalWarning: SQLite is experimental"
    });
    const error = new GuardedCommandError("research.run", failure);

    assert.equal(error.code, "SQLITE_BUSY");
    assert.equal(error.message, "research.run command failed: database is locked");
    assert.equal(error.result, failure);
  });
});
