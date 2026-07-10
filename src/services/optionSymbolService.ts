export type OptionSymbolParseFailureCode =
  | "OPTION_SYMBOL_EMPTY"
  | "OPTION_SYMBOL_FORMAT_INVALID"
  | "OPTION_EXPIRATION_INVALID"
  | "OPTION_STRIKE_INVALID";

export type OptionSymbolParseSuccess = {
  ok: true;
  input: string;
  normalizedSymbol: string;
  underlying: string;
  expirationDate: string;
  optionType: "call" | "put";
  strikePrice: number;
  strikeMilliunits: number;
  occRoot: string;
};

export type OptionSymbolParseFailure = {
  ok: false;
  input: string;
  code: OptionSymbolParseFailureCode;
  message: string;
};

export type OptionSymbolParseResult =
  | OptionSymbolParseSuccess
  | OptionSymbolParseFailure;

const failure = (
  input: string,
  code: OptionSymbolParseFailureCode,
  message: string
): OptionSymbolParseFailure => ({ ok: false, input, code, message });

const validUtcDate = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

export const parseOptionSymbol = (input: string): OptionSymbolParseResult => {
  const normalizedSymbol = String(input || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!normalizedSymbol) {
    return failure(input, "OPTION_SYMBOL_EMPTY", "Option symbol is empty.");
  }

  const match = normalizedSymbol.match(
    /^([A-Z0-9]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/
  );
  if (!match) {
    return failure(
      input,
      "OPTION_SYMBOL_FORMAT_INVALID",
      "Option symbol is not valid OCC format."
    );
  }

  const [, root, yearText, monthText, dayText, marker, strikeText] = match;
  const year = 2000 + Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!validUtcDate(year, month, day)) {
    return failure(
      input,
      "OPTION_EXPIRATION_INVALID",
      "Option expiration is not a real calendar date."
    );
  }

  const strikeMilliunits = Number(strikeText);
  if (!Number.isSafeInteger(strikeMilliunits) || strikeMilliunits < 0) {
    return failure(input, "OPTION_STRIKE_INVALID", "Option strike is invalid.");
  }

  return {
    ok: true,
    input,
    normalizedSymbol,
    occRoot: root,
    underlying: root,
    expirationDate: `${year}-${monthText}-${dayText}`,
    optionType: marker === "C" ? "call" : "put",
    strikeMilliunits,
    strikePrice: strikeMilliunits / 1000
  };
};

const utcDay = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

export const optionDaysToExpiration = (
  expirationDate: string,
  asOf: string
): number | null => {
  const expiration = /^\d{4}-\d{2}-\d{2}$/.test(expirationDate)
    ? utcDay(`${expirationDate}T00:00:00.000Z`)
    : null;
  const current = utcDay(asOf);
  if (expiration === null || current === null) {
    return null;
  }
  return Math.floor((expiration - current) / 86_400_000);
};
