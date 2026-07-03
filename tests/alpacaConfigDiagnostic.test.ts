import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";

import { buildAlpacaConfigDiagnostic } from "../src/services/alpacaConfigDiagnosticService.js";

const tempDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "alpaca-config-diagnostic-test-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("alpaca config diagnostic", () => {
  test(".env takes precedence over .env.txt fallback values", () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, ".env"),
      [
        "ALPACA_PAPER_API_KEY=PKDOTENV123456",
        "ALPACA_PAPER_SECRET_KEY=SECRET_DOTENV",
        "ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets"
      ].join("\n")
    );
    writeFileSync(
      join(cwd, ".env.txt"),
      [
        "ALPACA_PAPER_API_KEY=PKTXT999999",
        "ALPACA_PAPER_SECRET_KEY=SECRET_TXT",
        "ALPACA_DATA_BASE_URL=https://data.alpaca.markets"
      ].join("\n")
    );

    const diagnostic = buildAlpacaConfigDiagnostic({ cwd, env: {} });

    assert.equal(diagnostic.config.hasPaperApiKey, true);
    assert.equal(diagnostic.config.paperApiKeyPrefix, "PK...");
    assert.equal(diagnostic.config.paperApiKeySource, ".env");
    assert.deepEqual(diagnostic.config.envFilesLoaded, [".env", ".env.txt"]);
    assert.match(String(diagnostic.config.envPrecedenceNote), /\.env values take precedence/);
  });

  test(".env.txt fallback is reported when .env is absent", () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, ".env.txt"),
      [
        "ALPACA_PAPER_API_KEY=PKTXT123456",
        "ALPACA_PAPER_SECRET_KEY=SECRET_TXT",
        "ALPACA_DATA_BASE_URL=https://data.alpaca.markets"
      ].join("\n")
    );

    const diagnostic = buildAlpacaConfigDiagnostic({ cwd, env: {} });

    assert.equal(diagnostic.config.hasPaperApiKey, true);
    assert.equal(diagnostic.config.paperApiKeySource, ".env.txt");
    assert.deepEqual(diagnostic.config.envFilesLoaded, [".env.txt"]);
  });

  test("process env values override env file values when already set", () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, ".env"),
      [
        "ALPACA_PAPER_API_KEY=PKDOTENV123456",
        "ALPACA_PAPER_SECRET_KEY=SECRET_DOTENV"
      ].join("\n")
    );

    const diagnostic = buildAlpacaConfigDiagnostic({
      cwd,
      env: {
        ALPACA_PAPER_API_KEY: "PKPROCESS123456",
        ALPACA_PAPER_SECRET_KEY: "SECRET_PROCESS"
      }
    });

    assert.equal(diagnostic.config.paperApiKeySource, "process.env");
    assert.equal(diagnostic.config.paperSecretKeySource, "process.env");
  });

  test("diagnostic redacts full keys and secrets", () => {
    const cwd = makeTempDir();
    const fullKey = "PKFULLKEYSHOULDNOTLEAK";
    const fullSecret = "FULLSECRET_SHOULD_NOT_LEAK";
    const diagnostic = buildAlpacaConfigDiagnostic({
      cwd,
      env: {
        ALPACA_PAPER_API_KEY: fullKey,
        ALPACA_PAPER_SECRET_KEY: fullSecret
      }
    });

    const serialized = JSON.stringify(diagnostic);
    assert.equal(serialized.includes(fullKey), false);
    assert.equal(serialized.includes(fullSecret), false);
    assert.equal(serialized.includes("PK..."), true);
    assert.equal(diagnostic.config.hasPaperSecretKey, true);
  });

  test("reports paper environment and live-trading guard state", () => {
    const diagnostic = buildAlpacaConfigDiagnostic({ cwd: makeTempDir(), env: {} });

    assert.equal(diagnostic.paperOnly, true);
    assert.equal(diagnostic.environment, "paper");
    assert.equal(diagnostic.liveTradingEnabled, false);
  });
});
