import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

describe("CLI output redaction", () => {
  test("invalid direct colon commands redact configured credentials while retaining the error response", () => {
    const paperKey = "PK_CLI_REDACTION_TEST_KEY";
    const paperSecret = "CLI_REDACTION_TEST_SECRET";
    const controlToken = "CLI_REDACTION_TEST_CONTROL";
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "paper:runtime", "--format=json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ALPACA_PAPER_API_KEY: paperKey,
          ALPACA_PAPER_SECRET_KEY: paperSecret,
          VPS_CONTROL_TOKEN: controlToken
        }
      }
    );
    const output = String(result.stdout);

    assert.equal(result.status, 1);
    assert.match(output, /Unknown command/);
    assert.equal(output.includes(paperKey), false);
    assert.equal(output.includes(paperSecret), false);
    assert.equal(output.includes(controlToken), false);
  });
});
