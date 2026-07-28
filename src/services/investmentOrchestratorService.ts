import {
  executeWorkstreamLanes,
  type WorkstreamLane,
  type WorkstreamLaneEvaluation,
  type WorkstreamResult
} from "./canonicalWorkstreamResult.js";

export interface InvestmentStrategyLane<SharedContext, Proposal> {
  readonly lane: WorkstreamLane;
  readonly enabled: boolean;
  readonly execute: (
    context: SharedContext
  ) => Promise<WorkstreamLaneEvaluation<Proposal>>;
}

export interface InvestmentOrchestratorResult<Proposal> {
  readonly cycleId: string;
  readonly enabledLanes: WorkstreamLane[];
  readonly workstreamResults: Array<WorkstreamResult<Proposal>>;
  readonly proposals: Proposal[];
}

export const runInvestmentOrchestrator = async <SharedContext, Proposal>(input: {
  readonly cycleId: string;
  readonly loadSharedContext: () => Promise<SharedContext>;
  readonly lanes: readonly InvestmentStrategyLane<SharedContext, Proposal>[];
  readonly now?: () => Date;
}): Promise<InvestmentOrchestratorResult<Proposal>> => {
  const enabledLanes = input.lanes.filter(({ enabled }) => enabled);
  const sharedContext = await input.loadSharedContext();
  const workstreamResults = await executeWorkstreamLanes({
    cycleId: input.cycleId,
    lanes: enabledLanes.map(({ lane, execute }) => ({
      lane,
      execute: () => execute(sharedContext)
    })),
    now: input.now
  });

  return {
    cycleId: input.cycleId,
    enabledLanes: enabledLanes.map(({ lane }) => lane),
    workstreamResults,
    proposals: workstreamResults.flatMap((result) =>
      result.outcome === "success" ? result.proposals : []
    )
  };
};
