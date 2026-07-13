import type { ZeroDteCandidateState } from "./zeroDteTypes.js";

const DEFAULT_SIGNAL_SHORT_WINDOW = 3;
const DEFAULT_SIGNAL_MEDIUM_WINDOW = 5;
const REAPPEARANCE_STATES = new Set<ZeroDteCandidateState>([
  "weakening",
  "expired",
  "invalidated"
]);

export interface ZeroDteSignalObservation {
  observedAt: string;
  score: number;
}

export interface ZeroDteSignalSummary {
  scoreChange: number | null;
  shortSlope: number | null;
  mediumSlope: number | null;
  peakScore: number;
  drawdownFromPeak: number;
  strengtheningDurationMs: number;
  weakeningDurationMs: number;
  observationCount: number;
  setupAgeMs: number;
  state: ZeroDteCandidateState;
  reappeared: boolean;
}

export interface ZeroDteSignalSummaryInput {
  scores: ZeroDteSignalObservation[];
  previousState: ZeroDteCandidateState | null;
  minimumMovement: number;
  minimumConfirmationObservations: number;
  shortWindow?: number;
  mediumWindow?: number;
}

interface OrderedObservation extends ZeroDteSignalObservation {
  timestampMs: number;
}

const parseObservation = (observation: ZeroDteSignalObservation): OrderedObservation => {
  if (!Number.isFinite(observation.score)) {
    throw new RangeError("0DTE signal scores must be finite");
  }
  const timestampMs = Date.parse(observation.observedAt);
  if (!Number.isFinite(timestampMs)) {
    throw new RangeError("0DTE signal observations require valid timestamps");
  }
  return { ...observation, timestampMs };
};

const normalizeWindow = (value: number | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 2) {
    throw new RangeError("0DTE signal windows must be integers of at least two observations");
  }
  return value;
};

const linearSlope = (observations: OrderedObservation[]): number | null => {
  if (observations.length < 2) return null;

  const meanX = (observations.length - 1) / 2;
  const meanY = observations.reduce((sum, observation) => sum + observation.score, 0) /
    observations.length;
  let numerator = 0;
  let denominator = 0;

  for (const [index, observation] of observations.entries()) {
    const xDelta = index - meanX;
    numerator += xDelta * (observation.score - meanY);
    denominator += xDelta * xDelta;
  }

  if (denominator === 0) return null;
  const slope = numerator / denominator;
  return Object.is(slope, -0) ? 0 : slope;
};

const slopeForWindow = (
  observations: OrderedObservation[],
  window: number
): number | null => {
  if (observations.length < window) return null;
  return linearSlope(observations.slice(-window));
};

const directionalDurations = (
  observations: OrderedObservation[],
  minimumMovement: number
) => {
  let strengtheningDurationMs = 0;
  let weakeningDurationMs = 0;

  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1];
    const current = observations[index];
    const durationMs = Math.max(0, current.timestampMs - previous.timestampMs);
    const change = current.score - previous.score;

    if (change >= minimumMovement) {
      strengtheningDurationMs += durationMs;
    } else if (change <= -minimumMovement) {
      weakeningDurationMs += durationMs;
    }
  }

  return { strengtheningDurationMs, weakeningDurationMs };
};

const classifyState = (input: {
  observationCount: number;
  requiredObservations: number;
  scoreChange: number | null;
  minimumMovement: number;
}): ZeroDteCandidateState => {
  if (input.observationCount === 0) return "discovered";
  if (
    input.observationCount < input.requiredObservations ||
    input.scoreChange === null
  ) {
    return "watching";
  }
  if (input.scoreChange >= input.minimumMovement) return "strengthening";
  if (input.scoreChange <= -input.minimumMovement) return "weakening";
  return "stable";
};

export const summarizeZeroDteSignal = (
  input: ZeroDteSignalSummaryInput
): ZeroDteSignalSummary => {
  if (!Number.isFinite(input.minimumMovement) || input.minimumMovement < 0) {
    throw new RangeError("0DTE minimum movement must be a finite non-negative number");
  }
  if (
    !Number.isFinite(input.minimumConfirmationObservations) ||
    input.minimumConfirmationObservations < 0
  ) {
    throw new RangeError("0DTE confirmation observations must be non-negative");
  }

  const ordered = input.scores
    .map(parseObservation)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const observationCount = ordered.length;
  const latest = ordered.at(-1);
  const previous = ordered.at(-2);
  const scoreChange = latest && previous ? latest.score - previous.score : null;
  const peakScore = observationCount
    ? Math.max(...ordered.map((observation) => observation.score))
    : 0;
  const drawdownFromPeak = latest ? Math.max(0, peakScore - latest.score) : 0;
  const setupAgeMs = latest && ordered[0]
    ? Math.max(0, latest.timestampMs - ordered[0].timestampMs)
    : 0;
  const shortWindow = normalizeWindow(input.shortWindow, DEFAULT_SIGNAL_SHORT_WINDOW);
  const mediumWindow = normalizeWindow(input.mediumWindow, DEFAULT_SIGNAL_MEDIUM_WINDOW);
  const requiredObservations = Math.max(
    2,
    Math.ceil(input.minimumConfirmationObservations)
  );
  const state = classifyState({
    observationCount,
    requiredObservations,
    scoreChange,
    minimumMovement: input.minimumMovement
  });
  const durations = directionalDurations(ordered, input.minimumMovement);

  return {
    scoreChange,
    shortSlope: slopeForWindow(ordered, shortWindow),
    mediumSlope: slopeForWindow(ordered, mediumWindow),
    peakScore,
    drawdownFromPeak,
    ...durations,
    observationCount,
    setupAgeMs,
    state,
    reappeared:
      state === "strengthening" &&
      input.previousState !== null &&
      REAPPEARANCE_STATES.has(input.previousState)
  };
};
