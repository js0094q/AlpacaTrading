import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { alpacaRuntimeConfig } from "./alpacaRuntimeConfig.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

type EnvFileName = ".env" | ".env.txt";
type EnvSource = EnvFileName | "process.env" | null;

interface EnvFileRecord {
  name: EnvFileName;
  path: string;
  exists: boolean;
  parsed: Record<string, string>;
}

interface DiagnosticInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const PAPER_KEY_NAMES = [
  "ALPACA_PAPER_API_KEY",
  "ALPACA_PAPER_KEY",
  "ALPACA_API_KEY"
];

const PAPER_SECRET_NAMES = [
  "ALPACA_PAPER_SECRET_KEY",
  "ALPACA_PAPER_SECRET",
  "ALPACA_SECRET_KEY"
];

const LIVE_KEY_NAMES = ["ALPACA_LIVE_KEY", "ALPACA_LIVE_API_KEY"];
const LIVE_SECRET_NAMES = ["ALPACA_LIVE_SECRET", "ALPACA_LIVE_SECRET_KEY"];

const readEnvFile = (cwd: string, name: EnvFileName): EnvFileRecord => {
  const path = join(cwd, name);
  if (!existsSync(path)) {
    return { name, path, exists: false, parsed: {} };
  }
  return {
    name,
    path,
    exists: true,
    parsed: parseDotenv(readFileSync(path))
  };
};

const hasValue = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const pickValue = (
  names: readonly string[],
  effectiveEnv: Record<string, string | undefined>
): { variable: string | null; value: string } => {
  for (const name of names) {
    const value = effectiveEnv[name];
    if (hasValue(value)) {
      return { variable: name, value: value.trim() };
    }
  }
  return { variable: null, value: "" };
};

const buildEffectiveEnv = (
  env: NodeJS.ProcessEnv,
  dotEnv: EnvFileRecord,
  dotEnvTxt: EnvFileRecord
) => {
  const out: Record<string, string | undefined> = {
    ...dotEnvTxt.parsed,
    ...dotEnv.parsed
  };

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};

const sourceForValue = (
  variable: string | null,
  value: string,
  env: NodeJS.ProcessEnv,
  dotEnv: EnvFileRecord,
  dotEnvTxt: EnvFileRecord
): EnvSource => {
  if (!variable || !value) {
    return null;
  }
  if (dotEnv.parsed[variable] !== undefined && dotEnv.parsed[variable]?.trim() === value) {
    return ".env";
  }
  if (dotEnvTxt.parsed[variable] !== undefined && dotEnvTxt.parsed[variable]?.trim() === value) {
    return ".env.txt";
  }
  if (env[variable] !== undefined) {
    return "process.env";
  }
  return null;
};

const keyPrefix = (value: string) => {
  if (!value) {
    return null;
  }
  return `${value.slice(0, Math.min(2, value.length))}...`;
};

const hasOuterQuotes = (value: string) =>
  (value.startsWith("\"") && value.endsWith("\"")) ||
  (value.startsWith("'") && value.endsWith("'"));

const hasOuterWhitespace = (value: string) => value !== value.trim();

export interface AlpacaConfigDiagnostic {
  paperOnly: boolean;
  environment: ReturnType<typeof getTradingSafetyState>["alpacaEnv"];
  liveTradingEnabled: boolean;
  config: {
    hasPaperApiKey: boolean;
    paperApiKeyPrefix: string | null;
    paperApiKeyVariable: string | null;
    paperApiKeySource: EnvSource;
    paperApiKeyHasOuterWhitespace: boolean;
    paperApiKeyHasOuterQuotes: boolean;
    hasPaperSecretKey: boolean;
    paperSecretKeyVariable: string | null;
    paperSecretKeySource: EnvSource;
    paperSecretKeyHasOuterWhitespace: boolean;
    paperSecretKeyHasOuterQuotes: boolean;
    hasLiveApiKey: boolean;
    hasLiveSecretKey: boolean;
    paperBaseUrl: string | null;
    paperBaseUrlSource: EnvSource;
    dataBaseUrl: string | null;
    dataBaseUrlSource: EnvSource;
    liveBaseUrl: string | null;
    envFilesLoaded: EnvFileName[];
    envFilesDetected: EnvFileName[];
    envPrecedence: string;
    envPrecedenceNote: string | null;
  };
}

export const buildAlpacaConfigDiagnostic = (
  input: DiagnosticInput = {}
): AlpacaConfigDiagnostic => {
  const cwd = input.cwd || process.cwd();
  const env = input.env || process.env;
  const dotEnv = readEnvFile(cwd, ".env");
  const dotEnvTxt = readEnvFile(cwd, ".env.txt");
  const effectiveEnv = buildEffectiveEnv(env, dotEnv, dotEnvTxt);
  const state = getTradingSafetyState();

  const paperKey = pickValue(PAPER_KEY_NAMES, effectiveEnv);
  const paperSecret = pickValue(PAPER_SECRET_NAMES, effectiveEnv);
  const liveKey = pickValue(LIVE_KEY_NAMES, effectiveEnv);
  const liveSecret = pickValue(LIVE_SECRET_NAMES, effectiveEnv);
  const paperBaseUrl = pickValue(["ALPACA_PAPER_BASE_URL"], effectiveEnv);
  const dataBaseUrl = pickValue(["ALPACA_DATA_BASE_URL"], effectiveEnv);
  const liveBaseUrl = pickValue(["ALPACA_LIVE_BASE_URL"], effectiveEnv);

  const envFilesLoaded = [dotEnv, dotEnvTxt]
    .filter((file) => file.exists)
    .map((file) => file.name);
  const bothEnvFilesDetected = dotEnv.exists && dotEnvTxt.exists;

  return {
    paperOnly: state.paperOnly,
    environment: state.alpacaEnv,
    liveTradingEnabled: state.liveTradingEnabled,
    config: {
      hasPaperApiKey: Boolean(paperKey.value),
      paperApiKeyPrefix: keyPrefix(paperKey.value),
      paperApiKeyVariable: paperKey.variable,
      paperApiKeySource: sourceForValue(paperKey.variable, paperKey.value, env, dotEnv, dotEnvTxt),
      paperApiKeyHasOuterWhitespace: hasOuterWhitespace(String(effectiveEnv[paperKey.variable || ""] || "")),
      paperApiKeyHasOuterQuotes: hasOuterQuotes(paperKey.value),
      hasPaperSecretKey: Boolean(paperSecret.value),
      paperSecretKeyVariable: paperSecret.variable,
      paperSecretKeySource: sourceForValue(paperSecret.variable, paperSecret.value, env, dotEnv, dotEnvTxt),
      paperSecretKeyHasOuterWhitespace: hasOuterWhitespace(String(effectiveEnv[paperSecret.variable || ""] || "")),
      paperSecretKeyHasOuterQuotes: hasOuterQuotes(paperSecret.value),
      hasLiveApiKey: Boolean(liveKey.value),
      hasLiveSecretKey: Boolean(liveSecret.value),
      paperBaseUrl: paperBaseUrl.value || alpacaRuntimeConfig.paperBaseUrl || null,
      paperBaseUrlSource: sourceForValue(paperBaseUrl.variable, paperBaseUrl.value, env, dotEnv, dotEnvTxt),
      dataBaseUrl: dataBaseUrl.value || alpacaRuntimeConfig.dataBaseUrl || null,
      dataBaseUrlSource: sourceForValue(dataBaseUrl.variable, dataBaseUrl.value, env, dotEnv, dotEnvTxt),
      liveBaseUrl: liveBaseUrl.value || alpacaRuntimeConfig.liveBaseUrl || null,
      envFilesLoaded,
      envFilesDetected: envFilesLoaded,
      envPrecedence: ".env -> .env.txt fallback; process env keeps precedence when already set",
      envPrecedenceNote: bothEnvFilesDetected
        ? ".env and .env.txt both detected; .env values take precedence over .env.txt fallback values."
        : null
    }
  };
};
