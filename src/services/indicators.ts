import { percent, clamp } from "../lib/utils.js";

export const sma = (values: number[], period: number): number | null => {
  if (values.length < period) {
    return null;
  }
  const window = values.slice(-period);
  const sum = window.reduce((acc, value) => acc + value, 0);
  return sum / period;
};

export const ema = (values: number[], period: number): number | null => {
  if (values.length < period) {
    return null;
  }
  const k = 2 / (period + 1);
  let current = values.slice(0, period).reduce((acc, v) => acc + v, 0) / period;
  for (let index = period; index < values.length; index += 1) {
    current = values[index] * k + current * (1 - k);
  }
  return current;
};

export const rollingStd = (values: number[], period: number): number | null => {
  if (values.length < period) {
    return null;
  }
  const window = values.slice(-period);
  const avg = window.reduce((acc, value) => acc + value, 0) / period;
  const squared = window.reduce((acc, value) => acc + (value - avg) ** 2, 0) / period;
  return Math.sqrt(squared);
};

export const rsi = (changes: number[], period = 14): number | null => {
  if (changes.length < period + 1) {
    return null;
  }
  const slice = changes.slice(-period);
  let gains = 0;
  let losses = 0;
  for (const change of slice) {
    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }
  if (losses === 0) {
    return 100;
  }
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
};

export const atr = (
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): number | null => {
  if (highs.length < period + 1 || lows.length < period + 1 || closes.length < period + 1) {
    return null;
  }
  const trs = [];
  for (let i = 1; i < highs.length; i += 1) {
    const highLow = highs[i] - lows[i];
    const highClose = Math.abs(highs[i] - closes[i - 1]);
    const lowClose = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(highLow, highClose, lowClose));
  }
  if (trs.length < period) {
    return null;
  }
  const window = trs.slice(-period);
  return window.reduce((acc, value) => acc + value, 0) / period;
};

export const macd = (
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { macd: number | null; signal: number | null; histogram: number | null } => {
  if (closes.length < slow + signal) {
    return { macd: null, signal: null, histogram: null };
  }
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  if (emaFast === null || emaSlow === null) {
    return { macd: null, signal: null, histogram: null };
  }
  const line = emaFast - emaSlow;
  return {
    macd: line,
    signal: line !== null ? line * (2 / (signal + 1)) : null,
    histogram: line !== null ? line - (line * (2 / (signal + 1)) || 0) : null
  };
};

export const classifyTrend = (inputs: { sma10: number | null; sma20: number | null; sma50: number | null; close: number }) => {
  if (inputs.sma10 === null || inputs.sma20 === null || inputs.sma50 === null) {
    return "neutral";
  }
  if (inputs.close > inputs.sma20 && inputs.sma20 > inputs.sma50 && inputs.sma20 > inputs.sma10 * 0.985) {
    return "bullish";
  }
  if (inputs.close < inputs.sma20 && inputs.sma20 < inputs.sma50) {
    return "bearish";
  }
  return "neutral";
};

export const distanceFrom = (value: number | null, from: number | null): number | null => {
  if (value === null || from === null || from === 0) {
    return null;
  }
  return percent(value - from, from);
};
