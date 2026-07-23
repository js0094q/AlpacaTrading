export const parsePostgresDecimal = (value: number | string) => {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("POSTGRES_NUMERIC_NONFINITE");
  }
  const text = String(value).trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new Error("POSTGRES_NUMERIC_INVALID");
  const exponent = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new Error("POSTGRES_NUMERIC_INVALID");
  }
  const fraction = match[3] ?? match[4] ?? "";
  let coefficient = BigInt(`${match[1] === "-" ? "-" : ""}${match[2] ?? "0"}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
};

export const canonicalizePostgresNumeric = (
  value: number | string | null,
  precision: number,
  scale: number
): string | null => {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(precision) ||
    !Number.isSafeInteger(scale) ||
    precision < 1 ||
    scale < 0 ||
    scale > precision
  ) {
    throw new Error("POSTGRES_NUMERIC_DEFINITION_INVALID");
  }
  const parsed = parsePostgresDecimal(value);
  const negative = parsed.coefficient < 0n;
  let absolute = negative ? -parsed.coefficient : parsed.coefficient;
  if (parsed.scale > scale) {
    const divisor = 10n ** BigInt(parsed.scale - scale);
    const remainder = absolute % divisor;
    absolute /= divisor;
    if (remainder * 2n >= divisor) absolute += 1n;
  } else if (parsed.scale < scale) {
    absolute *= 10n ** BigInt(scale - parsed.scale);
  }
  if (absolute >= 10n ** BigInt(precision)) {
    throw new Error("POSTGRES_NUMERIC_OVERFLOW");
  }
  const digits = absolute.toString().padStart(scale + 1, "0");
  const unsigned = scale === 0
    ? digits
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative && absolute !== 0n ? `-${unsigned}` : unsigned;
};
