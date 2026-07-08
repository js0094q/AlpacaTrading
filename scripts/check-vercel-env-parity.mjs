#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export const DEFAULT_ENV_KEYS = [
  "DASHBOARD_ADMIN_TOKEN",
  "VPS_CONTROL_TOKEN",
  "VPS_CONTROL_BASE_URL",
  "ALPACA_ENV",
  "TRADING_MODE",
  "ALPACA_LIVE_TRADE",
  "LIVE_TRADING_ENABLED",
  "PAPER_ORDER_EXECUTION_ENABLED",
  "PAPER_OPTIONS_EXECUTION_ENABLED",
  "ENABLE_AGGRESSIVE_PAPER_STRATEGIES"
];

const DEFAULT_LOCAL_ENV_FILES = [".env", ".env.txt"];

const sha256 = (value) => createHash("sha256").update(value).digest();

const fingerprintMatches = (left, right) => {
  const leftHash = sha256(left);
  const rightHash = sha256(right);
  return leftHash.length === rightHash.length && timingSafeEqual(leftHash, rightHash);
};

export const parseEnvText = (text) => {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex < 1) {
      continue;
    }
    const key = normalized.slice(0, equalsIndex).trim();
    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
};

export const readEnvFiles = (paths) => {
  const merged = {};
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    const parsed = parseEnvText(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
};

export const parseVercelEnvList = (text) => {
  const keys = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(">") || line.startsWith("-")) {
      continue;
    }
    const key = line.split(/\s+/)[0];
    if (/^[A-Z0-9_]+$/.test(key)) {
      keys.add(key);
    }
  }
  return keys;
};

export const buildEnvParityReport = ({
  localEnv,
  vercelProductionEnv = {},
  vercelProductionKeys = new Set(),
  keys = DEFAULT_ENV_KEYS,
  vercelPullAvailable = true,
  vercelPresenceVerified = true
}) => {
  const envParity = {};
  let comparableKeys = 0;
  let incomparablePresentKeys = 0;
  for (const key of keys) {
    const localValue = localEnv[key];
    const vercelValue = vercelProductionEnv[key];
    const localPresent = localValue !== undefined && localValue !== "";
    const vercelProductionPresent =
      (vercelValue !== undefined && vercelValue !== "") || vercelProductionKeys.has(key);
    const canCompare = localPresent && vercelValue !== undefined && vercelValue !== "";
    if (canCompare) {
      comparableKeys += 1;
    } else if (localPresent && vercelProductionPresent) {
      incomparablePresentKeys += 1;
    }

    envParity[key] = {
      localPresent,
      vercelProductionPresent,
      fingerprintMatches: canCompare ? fingerprintMatches(localValue, vercelValue) : null
    };
  }

  return {
    envParity,
    valueParityVerified: vercelPullAvailable && incomparablePresentKeys === 0,
    comparableKeys,
    incomparablePresentKeys,
    vercelPresenceVerified,
    note: vercelPullAvailable && incomparablePresentKeys === 0
      ? "Compared values by sha256 fingerprint only; raw values were not printed."
      : "Presence verified where possible. Value parity not verified for keys whose production values were unavailable from a safe env pull."
  };
};

const parseArgs = (argv) => {
  const options = {
    localFiles: [],
    keys: DEFAULT_ENV_KEYS,
    pullVercel: false,
    checkVercelPresence: false,
    vercelFile: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local-file") {
      options.localFiles.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--local-file=")) {
      options.localFiles.push(arg.slice("--local-file=".length));
      continue;
    }
    if (arg === "--keys") {
      options.keys = argv[index + 1].split(",").map((key) => key.trim()).filter(Boolean);
      index += 1;
      continue;
    }
    if (arg.startsWith("--keys=")) {
      options.keys = arg.slice("--keys=".length).split(",").map((key) => key.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--vercel-file") {
      options.vercelFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--vercel-file=")) {
      options.vercelFile = arg.slice("--vercel-file=".length);
      continue;
    }
    if (arg === "--pull-vercel") {
      options.pullVercel = true;
      continue;
    }
    if (arg === "--check-vercel-presence") {
      options.checkVercelPresence = true;
    }
  }

  if (options.localFiles.length === 0) {
    options.localFiles = DEFAULT_LOCAL_ENV_FILES;
  }
  return options;
};

const runVercelEnvLs = () => {
  try {
    return {
      ok: true,
      keys: parseVercelEnvList(
        execFileSync("vercel", ["env", "ls"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        })
      )
    };
  } catch {
    return { ok: false, keys: new Set() };
  }
};

const pullVercelProductionEnv = () => {
  const dir = mkdtempSync(join(tmpdir(), "alpaca-vercel-env-"));
  const path = join(dir, "production.env");
  try {
    execFileSync("vercel", ["env", "pull", path, "--environment=production", "--yes"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"]
    });
    return {
      ok: true,
      env: readEnvFiles([path])
    };
  } catch {
    return { ok: false, env: {} };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const runCli = (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  const localEnv = readEnvFiles(options.localFiles);
  const lsResult = options.checkVercelPresence ? runVercelEnvLs() : { ok: false, keys: new Set() };

  let vercelProductionEnv = {};
  let vercelPullAvailable = false;
  if (options.vercelFile) {
    vercelProductionEnv = readEnvFiles([options.vercelFile]);
    vercelPullAvailable = true;
  } else if (options.pullVercel) {
    const pull = pullVercelProductionEnv();
    vercelProductionEnv = pull.env;
    vercelPullAvailable = pull.ok;
  }

  return buildEnvParityReport({
    localEnv,
    vercelProductionEnv,
    vercelProductionKeys: lsResult.keys,
    keys: options.keys,
    vercelPullAvailable,
    vercelPresenceVerified: lsResult.ok
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(runCli(), null, 2)}\n`);
}
