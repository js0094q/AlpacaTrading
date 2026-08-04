export const DEFAULT_MANAGED_LEAPS_MIN_DTE = 270;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T/;

const dateOnlyEpoch = (value: string) => {
  if (!DATE_ONLY.test(value)) {
    throw new RangeError(`INVALID_OPTION_DATE:${value}`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  if (
    !Number.isFinite(epoch) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError(`INVALID_OPTION_DATE:${value}`);
  }
  return epoch;
};

export const resolveManagedLeapsMinDte = (value: string | undefined) => {
  const parsed = value === undefined ? DEFAULT_MANAGED_LEAPS_MIN_DTE : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("INVALID_MANAGED_LEAPS_MIN_DTE");
  }
  return parsed;
};

export const newYorkTradingDate = (value: string | Date) => {
  if (typeof value === "string" && DATE_ONLY.test(value)) {
    dateOnlyEpoch(value);
    return value;
  }
  if (typeof value === "string") {
    const match = ISO_TIMESTAMP.exec(value);
    if (!match) {
      throw new RangeError("INVALID_OPTION_OBSERVATION_TIMESTAMP");
    }
    dateOnlyEpoch(match[1]);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("INVALID_OPTION_OBSERVATION_TIMESTAMP");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (!year || !month || !day) {
    throw new RangeError("INVALID_OPTION_OBSERVATION_TIMESTAMP");
  }
  return `${year}-${month}-${day}`;
};

export const optionCalendarDte = (expirationDate: string, observedAt: string | Date) =>
  Math.round(
    (dateOnlyEpoch(expirationDate) - dateOnlyEpoch(newYorkTradingDate(observedAt))) /
      86_400_000
  );

export const classifyManagedOptionLane = (input: {
  expirationDate: string;
  observedAt: string | Date;
  managedLeapsMinDte?: number;
}) => {
  const daysToExpiration = optionCalendarDte(input.expirationDate, input.observedAt);
  const managedLeapsMinDte = resolveManagedLeapsMinDte(
    input.managedLeapsMinDte === undefined ? undefined : String(input.managedLeapsMinDte)
  );
  if (daysToExpiration < 0) return "expired" as const;
  if (daysToExpiration === 0) return "options_0dte" as const;
  if (daysToExpiration >= managedLeapsMinDte) return "options_leaps" as const;
  return "options_standard" as const;
};
