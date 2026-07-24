const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const number = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const paperLeapsExitConfig = () => ({
  minDteAtEntry: Math.max(
    1,
    integer(process.env.LEAPS_MIN_DTE_AT_ENTRY, 270)
  ),
  dteExitThreshold: Math.max(
    0,
    integer(process.env.LEAPS_DTE_EXIT_THRESHOLD, 180)
  ),
  reviewLossPct: number(process.env.LEAPS_REVIEW_LOSS_PCT, -20),
  hardStopLossPct: number(process.env.LEAPS_HARD_STOP_LOSS_PCT, -35),
  partialProfitTakePct: number(
    process.env.LEAPS_PARTIAL_PROFIT_TAKE_PCT,
    75
  ),
  fullProfitTakePct: number(
    process.env.LEAPS_FULL_PROFIT_TAKE_PCT,
    125
  ),
  trendReviewSma: Math.max(
    1,
    integer(process.env.LEAPS_TREND_REVIEW_SMA, 100)
  ),
  severeTrendExitSma: Math.max(
    1,
    integer(process.env.LEAPS_SEVERE_TREND_EXIT_SMA, 200)
  ),
  maxBidAskSpreadPct: Math.max(
    0,
    number(process.env.LEAPS_MAX_BID_ASK_SPREAD_PCT, 20)
  ),
  minDeltaReview: Math.max(
    0,
    number(process.env.LEAPS_MIN_DELTA_REVIEW, 0.45)
  ),
  reviewIntervalDays: Math.max(
    1,
    integer(process.env.LEAPS_REVIEW_INTERVAL_DAYS, 30)
  )
});
