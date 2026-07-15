const SECRET_ENV_NAMES = [
  "DASHBOARD_ADMIN_TOKEN",
  "VPS_CONTROL_TOKEN",
  "APCA_API_KEY_ID",
  "APCA_API_SECRET_KEY",
  "ALPACA_API_KEY",
  "ALPACA_SECRET_KEY",
  "ALPACA_LIVE_API_KEY",
  "ALPACA_LIVE_SECRET_KEY",
  "ALPACA_PAPER_API_KEY",
  "ALPACA_PAPER_SECRET_KEY",
  "ALPACA_LIVE_KEY",
  "ALPACA_LIVE_SECRET",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_PRISMA_URL",
  "PGPASSWORD",
  "POSTGRES_PASSWORD"
];

const SENSITIVE_ENV_NAMES = new Set(SECRET_ENV_NAMES);
const COMMON_SECRET_OBJECT_KEYS = new Set([
  "password",
  "token",
  "authtoken",
  "secret",
  "apikey",
  "connectionstring"
]);

const isCommonSecretObjectKey = (key: string) => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (COMMON_SECRET_OBJECT_KEYS.has(normalized)) return true;
  return ["password", "token", "secret", "apikey", "connectionstring"]
    .some((suffix) => normalized.endsWith(suffix));
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const redactSensitiveText = (value: string): string => {
  let redacted = value;

  for (const name of SECRET_ENV_NAMES) {
    const configured = process.env[name];
    if (configured) {
      redacted = redacted.replace(new RegExp(escapeRegExp(configured), "g"), `[REDACTED:${name}]`);
    }
  }

  redacted = redacted
    .replace(
      /\bpostgres(?:ql)?:\/\/[^\s"'<>;,)\]}]+/gi,
      "[REDACTED:POSTGRES_CONNECTION_URL]"
    )
    .replace(
      /\b(password|pass|pwd)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED:PRIVATE_KEY]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-proj-[A-Za-z0-9_-]{20,}/g, "[REDACTED:OPENAI_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:OPENAI_KEY]");

  for (const name of SECRET_ENV_NAMES) {
    redacted = redacted.replace(
      new RegExp(`\\b${name}\\s*[:=]\\s*["']?[^"',\\s}]+`, "g"),
      `${name}=[REDACTED]`
    );
  }

  return redacted;
};

export const redactSensitiveData = (value: unknown): unknown => {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveData(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_ENV_NAMES.has(key.toUpperCase())
          ? `[REDACTED:${key.toUpperCase()}]`
          : isCommonSecretObjectKey(key)
            ? `[REDACTED:${key}]`
          : redactSensitiveData(entry)
      ])
    );
  }
  return value;
};
