export interface ZeroDteQueueCandidate extends Record<string, unknown> {
  candidateId: string;
  eligible?: boolean;
  executable?: boolean;
  totalScore?: number;
  score?: number;
  shortSlope?: number | null;
  signalSlope?: number | null;
  liquidityScore?: number | null;
  liquidity?: number | null;
  freshnessScore?: number | null;
  freshness?: number | null;
  spreadPct?: number | null;
  spread?: number | null;
  componentScores?: Record<string, unknown>;
  blockers?: string[];
  rank?: number;
}

export interface ZeroDteQueueSliceOptions {
  queueTopN?: number;
  executionTopN?: number;
}

export interface ZeroDteQueueSlices {
  queue: ZeroDteQueueCandidate[];
  execution: ZeroDteQueueCandidate[];
}

const DEFAULT_QUEUE_TOP_N = 20;
const DEFAULT_EXECUTION_TOP_N = 3;

const readFiniteNumber = (
  candidate: ZeroDteQueueCandidate,
  keys: string[]
): number | null => {
  for (const key of keys) {
    const value = candidate[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

const isEligible = (candidate: ZeroDteQueueCandidate) =>
  candidate.eligible === true || candidate.executable === true;

const compareDescending = (left: number | null, right: number | null) =>
  (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY);

const compareAscending = (left: number | null, right: number | null) =>
  (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);

const compareCandidateIds = (
  left: ZeroDteQueueCandidate,
  right: ZeroDteQueueCandidate
) => {
  if (left.candidateId < right.candidateId) return -1;
  if (left.candidateId > right.candidateId) return 1;
  return 0;
};

const compareQueueCandidates = (
  left: ZeroDteQueueCandidate,
  right: ZeroDteQueueCandidate
) => {
  const eligibilityDifference = Number(isEligible(right)) - Number(isEligible(left));
  if (eligibilityDifference !== 0) return eligibilityDifference;

  const scoreDifference = compareDescending(
    readFiniteNumber(left, ["totalScore", "score"]),
    readFiniteNumber(right, ["totalScore", "score"])
  );
  if (scoreDifference !== 0) return scoreDifference;

  const slopeDifference = compareDescending(
    readFiniteNumber(left, ["shortSlope", "signalSlope"]),
    readFiniteNumber(right, ["shortSlope", "signalSlope"])
  );
  if (slopeDifference !== 0) return slopeDifference;

  const liquidityDifference = compareDescending(
    readFiniteNumber(left, ["liquidityScore", "liquidity"]),
    readFiniteNumber(right, ["liquidityScore", "liquidity"])
  );
  if (liquidityDifference !== 0) return liquidityDifference;

  const freshnessDifference = compareDescending(
    readFiniteNumber(left, ["freshnessScore", "freshness"]),
    readFiniteNumber(right, ["freshnessScore", "freshness"])
  );
  if (freshnessDifference !== 0) return freshnessDifference;

  const spreadDifference = compareAscending(
    readFiniteNumber(left, ["spreadPct", "spread"]),
    readFiniteNumber(right, ["spreadPct", "spread"])
  );
  if (spreadDifference !== 0) return spreadDifference;

  return compareCandidateIds(left, right);
};

export const rankZeroDteQueue = (
  candidates: ZeroDteQueueCandidate[]
): ZeroDteQueueCandidate[] => {
  const decorated = candidates.map((candidate, originalIndex) => ({
    candidate,
    originalIndex
  }));

  decorated.sort((left, right) => {
    const comparison = compareQueueCandidates(left.candidate, right.candidate);
    return comparison || left.originalIndex - right.originalIndex;
  });

  return decorated.map(({ candidate }, index) => ({
    ...candidate,
    rank: index + 1
  }));
};

const normalizeLimit = (value: number | undefined, fallback: number) => {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError("0DTE queue limits must be non-negative integers");
  }
  return limit;
};

export const selectZeroDteQueue = (
  candidates: ZeroDteQueueCandidate[],
  options: ZeroDteQueueSliceOptions = {}
): ZeroDteQueueSlices => {
  const ranked = rankZeroDteQueue(candidates);
  const queueTopN = normalizeLimit(options.queueTopN, DEFAULT_QUEUE_TOP_N);
  const executionTopN = normalizeLimit(
    options.executionTopN,
    DEFAULT_EXECUTION_TOP_N
  );

  return {
    queue: ranked.slice(0, queueTopN),
    execution: ranked.filter(isEligible).slice(0, executionTopN)
  };
};

export const sliceZeroDteQueue = selectZeroDteQueue;
