import { randomUUID } from "node:crypto";

export const nowIso = () => new Date().toISOString();

export const normalizeSymbol = (symbol: string): string =>
  symbol.trim().toUpperCase();

export const dedupeSymbols = (symbols: string[]): string[] =>
  Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));

export const parseDate = (value?: string | null): Date | null => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const asTimestamp = (value: Date | string): string =>
  new Date(value).toISOString();

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const percent = (num: number, den: number): number =>
  den === 0 ? 0 : (num / den) * 100;

export const uuid = () => randomUUID();
