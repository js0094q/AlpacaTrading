import { normalizeSymbol } from "../lib/utils.js";
import { parseOptionSymbol } from "./optionSymbolService.js";

export type AssetIdentity =
  | {
      assetClass: "equity";
      symbol: string;
    }
  | {
      assetClass: "option";
      optionSymbol: string;
      underlyingSymbol: string;
    };

type AssetLike = {
  symbol?: string | null;
  assetClass?: string | null;
  asset_class?: string | null;
  optionSymbol?: string | null;
  option_symbol?: string | null;
  underlyingSymbol?: string | null;
  underlying_symbol?: string | null;
};

export const normalizeAssetClass = (value?: string | null): "equity" | "option" | null => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["us_equity", "equity", "stock", "stocks"].includes(normalized)) {
    return "equity";
  }
  if (["option", "options", "us_option", "us_options"].includes(normalized)) {
    return "option";
  }
  return null;
};

export const optionUnderlyingFromSymbol = (symbol: string): string => {
  const parsed = parseOptionSymbol(symbol);
  return parsed.ok ? parsed.underlying : "";
};

export const looksLikeOptionSymbol = (symbol: string): boolean =>
  parseOptionSymbol(symbol).ok;

export const getCandidateAssetIdentity = (candidate: AssetLike): AssetIdentity | null => {
  const assetClass = normalizeAssetClass(candidate.assetClass ?? candidate.asset_class);
  const optionSymbol = normalizeSymbol(candidate.optionSymbol ?? candidate.option_symbol ?? "");
  const underlyingSymbol = normalizeSymbol(
    candidate.underlyingSymbol ||
      candidate.underlying_symbol ||
      optionUnderlyingFromSymbol(optionSymbol) ||
      candidate.symbol ||
      ""
  );

  if (assetClass === "option" || optionSymbol) {
    if (!optionSymbol) {
      return null;
    }
    return {
      assetClass: "option",
      optionSymbol,
      underlyingSymbol
    };
  }

  const symbol = normalizeSymbol(candidate.symbol ?? "");
  if (!symbol) {
    return null;
  }
  return {
    assetClass: "equity",
    symbol
  };
};

export const getPositionAssetIdentity = (position: AssetLike): AssetIdentity | null => {
  const symbol = normalizeSymbol(position.symbol ?? "");
  if (!symbol) {
    return null;
  }

  const assetClass = normalizeAssetClass(position.assetClass ?? position.asset_class);
  if (assetClass === "option" || (assetClass === null && looksLikeOptionSymbol(symbol))) {
    return {
      assetClass: "option",
      optionSymbol: symbol,
      underlyingSymbol: normalizeSymbol(
        position.underlyingSymbol ||
          position.underlying_symbol ||
          optionUnderlyingFromSymbol(symbol)
      )
    };
  }

  return {
    assetClass: "equity",
    symbol
  };
};

export const getOrderAssetIdentity = getPositionAssetIdentity;

export const isSameHeldInstrument = (
  candidate: AssetIdentity,
  held: AssetIdentity
): boolean => {
  if (candidate.assetClass === "equity" && held.assetClass === "equity") {
    return candidate.symbol === held.symbol;
  }
  if (candidate.assetClass === "option" && held.assetClass === "option") {
    return candidate.optionSymbol === held.optionSymbol;
  }
  return false;
};
