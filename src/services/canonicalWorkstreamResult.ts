export type WorkstreamLane = "equity" | "options_0dte" | "options_leaps";
export type WorkstreamOutcome = "success" | "no_action" | "error";

export interface WorkstreamResult<Proposal> {
  cycle_id: string;
  lane: WorkstreamLane;
  started_at: string;
  completed_at: string;
  outcome: WorkstreamOutcome;
  proposals: Proposal[];
  evidence_references: string[];
  confidence?: number;
  reason_codes: string[];
  diagnostic_summary: string;
}

export interface WorkstreamLaneEvaluation<Proposal> {
  proposals: readonly Proposal[];
  evidence_references?: readonly string[];
  confidence?: number;
  reason_codes?: readonly string[];
  diagnostic_summary?: string;
}

export interface WorkstreamLaneExecutor<Proposal> {
  lane: WorkstreamLane;
  execute: () => Promise<WorkstreamLaneEvaluation<Proposal>>;
}

const DIAGNOSTIC_SUMMARY_MAX_LENGTH = 240;
const ERROR_CODE_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

const boundedSummary = (value: string) =>
  value.length <= DIAGNOSTIC_SUMMARY_MAX_LENGTH
    ? value
    : value.slice(0, DIAGNOSTIC_SUMMARY_MAX_LENGTH);

const uniqueText = (values: readonly string[] = []) =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))];

const errorDetails = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    reason_codes: [message.match(ERROR_CODE_PATTERN)?.[0] ?? "LANE_EXECUTION_ERROR"],
    diagnostic_summary: boundedSummary(message || "Lane evaluation failed.")
  };
};

export const executeWorkstreamLanes = async <Proposal>(input: {
  cycleId: string;
  lanes: readonly WorkstreamLaneExecutor<Proposal>[];
  now?: () => Date;
}): Promise<Array<WorkstreamResult<Proposal>>> => {
  const now = input.now ?? (() => new Date());
  const results: Array<WorkstreamResult<Proposal>> = [];

  for (const lane of input.lanes) {
    const started_at = now().toISOString();
    try {
      const evaluated = await lane.execute();
      const proposals = [...evaluated.proposals];
      const outcome = proposals.length > 0 ? "success" : "no_action";
      results.push({
        cycle_id: input.cycleId,
        lane: lane.lane,
        started_at,
        completed_at: now().toISOString(),
        outcome,
        proposals,
        evidence_references: uniqueText(evaluated.evidence_references),
        ...(Number.isFinite(evaluated.confidence)
          ? { confidence: evaluated.confidence }
          : {}),
        reason_codes: uniqueText(evaluated.reason_codes).length
          ? uniqueText(evaluated.reason_codes)
          : [outcome === "success" ? "PROPOSALS_CREATED" : "NO_ACTION"],
        diagnostic_summary: boundedSummary(
          evaluated.diagnostic_summary ??
            (outcome === "success"
              ? `Lane produced ${proposals.length} proposal(s).`
              : "Lane evaluation completed without proposals.")
        )
      });
    } catch (error) {
      results.push({
        cycle_id: input.cycleId,
        lane: lane.lane,
        started_at,
        completed_at: now().toISOString(),
        outcome: "error",
        proposals: [],
        evidence_references: [],
        ...errorDetails(error)
      });
    }
  }

  return results;
};
