import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type EnvParityModule = {
  buildEnvParityReport: (input: {
    localEnv: Record<string, string>;
    vercelProductionEnv?: Record<string, string>;
    vercelProductionKeys?: Set<string>;
    keys?: string[];
    vercelPullAvailable?: boolean;
    vercelPresenceVerified?: boolean;
  }) => {
    envParity: Record<string, {
      localPresent: boolean;
      vercelProductionPresent: boolean;
      fingerprintMatches: boolean | null;
    }>;
    valueParityVerified: boolean;
    comparableKeys: number;
    incomparablePresentKeys: number;
    vercelPresenceVerified: boolean;
    note: string;
  };
  parseEnvText: (text: string) => Record<string, string>;
  readEnvFiles: (paths: string[]) => Record<string, string>;
  runCli: (argv: string[]) => unknown;
};

const loadModule = async () => {
  const url = pathToFileURL(`${process.cwd()}/scripts/check-vercel-env-parity.mjs`);
  return import(url.href) as Promise<EnvParityModule>;
};

describe("Vercel env parity checker", () => {
  test("compares values by fingerprint without returning raw values", async () => {
    const { buildEnvParityReport } = await loadModule();
    const report = buildEnvParityReport({
      keys: ["DASHBOARD_ADMIN_TOKEN", "VPS_CONTROL_TOKEN", "VPS_CONTROL_BASE_URL"],
      localEnv: {
        DASHBOARD_ADMIN_TOKEN: "admin-local-secret",
        VPS_CONTROL_TOKEN: "shared-control-secret",
        VPS_CONTROL_BASE_URL: "https://vps.example.test"
      },
      vercelProductionEnv: {
        DASHBOARD_ADMIN_TOKEN: "admin-vercel-secret",
        VPS_CONTROL_TOKEN: "shared-control-secret",
        VPS_CONTROL_BASE_URL: "https://vps.example.test"
      }
    });

    assert.equal(report.envParity.DASHBOARD_ADMIN_TOKEN.fingerprintMatches, false);
    assert.equal(report.envParity.VPS_CONTROL_TOKEN.fingerprintMatches, true);
    assert.equal(report.envParity.VPS_CONTROL_BASE_URL.fingerprintMatches, true);
    assert.equal(report.valueParityVerified, true);
    assert.equal(report.comparableKeys, 3);
    assert.equal(report.incomparablePresentKeys, 0);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("admin-local-secret"), false);
    assert.equal(serialized.includes("admin-vercel-secret"), false);
    assert.equal(serialized.includes("shared-control-secret"), false);
    assert.equal(serialized.includes("https://vps.example.test"), false);
  });

  test("reports presence-only status when Vercel values are unavailable", async () => {
    const { buildEnvParityReport } = await loadModule();
    const report = buildEnvParityReport({
      keys: ["DASHBOARD_ADMIN_TOKEN"],
      localEnv: { DASHBOARD_ADMIN_TOKEN: "admin-local-secret" },
      vercelProductionKeys: new Set(["DASHBOARD_ADMIN_TOKEN"]),
      vercelPullAvailable: false,
      vercelPresenceVerified: true
    });

    assert.equal(report.envParity.DASHBOARD_ADMIN_TOKEN.localPresent, true);
    assert.equal(report.envParity.DASHBOARD_ADMIN_TOKEN.vercelProductionPresent, true);
    assert.equal(report.envParity.DASHBOARD_ADMIN_TOKEN.fingerprintMatches, null);
    assert.equal(report.valueParityVerified, false);
    assert.equal(report.comparableKeys, 0);
    assert.equal(report.incomparablePresentKeys, 1);
    assert.match(report.note, /Value parity not verified/);
  });

  test("reads local env files with runtime fallback precedence", async () => {
    const { readEnvFiles, runCli } = await loadModule();
    const dir = mkdtempSync(join(tmpdir(), "alpaca-env-parity-test-"));
    const localPath = join(dir, ".env");
    const fallbackPath = join(dir, ".env.txt");
    const vercelPath = join(dir, "vercel.env");
    try {
      writeFileSync(localPath, "DASHBOARD_ADMIN_TOKEN=local-admin\nLIVE_TRADING_ENABLED=false\n");
      writeFileSync(fallbackPath, "DASHBOARD_ADMIN_TOKEN=fallback-admin\nVPS_CONTROL_TOKEN=fallback-control\n");
      writeFileSync(vercelPath, "DASHBOARD_ADMIN_TOKEN=local-admin\nVPS_CONTROL_TOKEN=fallback-control\n");

      assert.deepEqual(readEnvFiles([localPath, fallbackPath]), {
        DASHBOARD_ADMIN_TOKEN: "local-admin",
        LIVE_TRADING_ENABLED: "false",
        VPS_CONTROL_TOKEN: "fallback-control"
      });

      const report = runCli([
        "--local-file",
        localPath,
        "--local-file",
        fallbackPath,
        "--vercel-file",
        vercelPath,
        "--keys",
        "DASHBOARD_ADMIN_TOKEN,VPS_CONTROL_TOKEN"
      ]) as {
        envParity: Record<string, { fingerprintMatches: boolean | null }>;
      };

      assert.equal(report.envParity.DASHBOARD_ADMIN_TOKEN.fingerprintMatches, true);
      assert.equal(report.envParity.VPS_CONTROL_TOKEN.fingerprintMatches, true);
      assert.equal(JSON.stringify(report).includes("local-admin"), false);
      assert.equal(JSON.stringify(report).includes("fallback-control"), false);

      const cliOutput = execFileSync(process.execPath, [
        `${process.cwd()}/scripts/check-vercel-env-parity.mjs`,
        "--local-file",
        localPath,
        "--local-file",
        fallbackPath,
        "--vercel-file",
        vercelPath,
        "--keys",
        "DASHBOARD_ADMIN_TOKEN,VPS_CONTROL_TOKEN"
      ], { encoding: "utf8" });
      const cliReport = JSON.parse(cliOutput) as {
        envParity: Record<string, { fingerprintMatches: boolean | null }>;
      };
      assert.equal(cliReport.envParity.DASHBOARD_ADMIN_TOKEN.fingerprintMatches, true);
      assert.equal(cliOutput.includes("local-admin"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
