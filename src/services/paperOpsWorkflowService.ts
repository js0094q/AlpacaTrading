import { buildPaperExecuteDryRunReport } from "./paperExecuteDryRunService.js";
import {
  buildPaperPortfolioReviewReport,
  type PaperPortfolioReviewMoment,
  type PaperPortfolioReviewReport
} from "./paperPortfolioReviewService.js";
import { buildPaperOptionsDiscoveryReport } from "./paperOptionsDiscoveryService.js";
import { runResearchDaily } from "./researchOrchestrator.js";
import {
  buildPromotionReadinessAnalytics,
  evaluatePaperLearningRecords,
  paperLearningSummary
} from "./paperLearningLedgerService.js";
import { applyPaperLearningGovernance } from "./learningGovernanceService.js";
import {
  createPaperReviewArtifact,
  latestPaperReviewArtifact,
  isPaperReviewArtifactFresh,
  verifyPaperReviewArtifact,
  type ReviewedPayloadSections
} from "./paperReviewArtifactService.js";
import {
  finishPaperOperation,
  startPaperOperation,
  type PaperOperationTriggerSource,
  type PaperOperationStatus
} from "./paperOperationLogService.js";
import {
  buildAndPersistHedgeReview,
  type HedgeReviewReport
} from "./hedgeLearningService.js";
import {
  capturePaperSubmitState,
  validatePaperSubmitState
} from "./paperSubmitStateService.js";

export interface PaperOpsWorkflowReport {
  paperOnly: true;
  generatedAt: string;
  workflow: "morning" | "midday" | "late_day" | "review";
  triggerSource: PaperOperationTriggerSource;
  operationId: string;
  status: PaperOperationStatus;
  reviewOnly: true;
  automatedExecutionEnabled: boolean;
  summary: Record<string, unknown>;
  details: Record<string, unknown>;
  warnings: string[];
  blockers: string[];
}

interface PaperOpsDeps {
  runResearch?: typeof runResearchDaily;
  buildDryRun?: typeof buildPaperExecuteDryRunReport;
  buildPortfolioReview?: typeof buildPaperPortfolioReviewReport;
  buildOptionsDiscovery?: typeof buildPaperOptionsDiscoveryReport;
  evaluateLearning?: typeof evaluatePaperLearningRecords;
  learningSummary?: typeof paperLearningSummary;
  promotionReadiness?: typeof buildPromotionReadinessAnalytics;
  applyLearningGovernance?: typeof applyPaperLearningGovernance;
  buildHedgeReview?: typeof buildAndPersistHedgeReview;
  captureSubmitState?: typeof capturePaperSubmitState;
  now?: () => string;
}

const ENTRY_SECTIONS = ["equityBuys", "equityAdds", "optionBuys"] as const;

const unique = (values: string[]) => [...new Set(values)];

const automatedExecutionEnabled = () =>
  process.env.AUTOMATED_PAPER_EXECUTION_ENABLED === "true" ||
  process.env.AUTOMATED_PAPER_EXECUTION_ENABLED === "1";

const payloadFromRecommendation = (review: PaperPortfolioReviewReport, kind: string) =>
  review.recommendations
    .filter((entry) => entry.recommendation === kind)
    .map((entry) => entry.eligiblePayload)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

const sectionsFromReports = async (
  portfolioReview: PaperPortfolioReviewReport,
  deps: PaperOpsDeps
): Promise<{ sections: ReviewedPayloadSections; dryRun: Awaited<ReturnType<typeof buildPaperExecuteDryRunReport>> }> => {
  const dryRun = await (deps.buildDryRun ?? buildPaperExecuteDryRunReport)({
    dryRun: true,
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    assetClass: "all"
  });
  return {
    dryRun,
    sections: {
      equityBuys: dryRun.wouldSubmit.filter(
        (payload) => payload.assetClass === "equity" && payload.side === "buy"
      ),
      equityAdds: payloadFromRecommendation(portfolioReview, "ADD_TO_EQUITY"),
      equitySells: payloadFromRecommendation(portfolioReview, "SELL_EQUITY"),
      optionBuys: dryRun.wouldSubmit.filter(
        (payload) => payload.assetClass === "option" && payload.position_intent === "buy_to_open"
      ),
      optionSellToCloseExits: payloadFromRecommendation(
        portfolioReview,
        "SELL_TO_CLOSE_OPTION"
      )
    }
  };
};

const statusFrom = (blockers: string[], warnings: string[]): PaperOperationStatus =>
  blockers.length ? "blocked" : warnings.length ? "warning" : "success";

const hedgeRefreshWarnings = (report: HedgeReviewReport) => [
  ...report.warnings,
  ...(report.blockers.length ? ["HEDGE_REVIEW_REFRESH_BLOCKED"] : [])
];

export const runPaperOpsReview = async (
  input: {
    triggerSource?: PaperOperationTriggerSource;
    moment?: PaperPortfolioReviewMoment;
    sourceAction?: string;
    requestId?: string | null;
    correlationId?: string | null;
  } = {},
  deps: PaperOpsDeps = {}
): Promise<PaperOpsWorkflowReport> => {
  const triggerSource = input.triggerSource || "cli";
  const started = startPaperOperation({
    actionType: "paper.ops.review",
    triggerSource,
    requestId: input.requestId,
    correlationId: input.correlationId,
    command: "paper:ops:review"
  });
  const generatedAt = deps.now?.() || new Date().toISOString();
  try {
    const portfolioReview = await (deps.buildPortfolioReview ?? buildPaperPortfolioReviewReport)(
      {
        moment: input.moment || "manual"
      }
    );
    const hedgeReview = await (deps.buildHedgeReview ?? buildAndPersistHedgeReview)({
      asOf: generatedAt,
      triggerSource,
      requestId: input.requestId ?? undefined,
      correlationId: input.correlationId ?? undefined
    });
    const { sections, dryRun } = await sectionsFromReports(portfolioReview, deps);
    const submitState = await (deps.captureSubmitState ?? capturePaperSubmitState)({
      capturedAt: new Date().toISOString(),
      payloadSections: sections
    });
    const entrySections = ENTRY_SECTIONS.filter(
      (section) => sections[section].length > 0
    );
    const submitStateValidation = validatePaperSubmitState({
      reviewed: submitState,
      current: submitState,
      sections: [...entrySections]
    });
    const warnings = unique([
      ...dryRun.warnings,
      ...portfolioReview.warnings,
      ...submitState.warnings,
      ...submitStateValidation.warnings,
      ...(automatedExecutionEnabled() ? ["AUTOMATED_PAPER_EXECUTION_ENABLED_REQUIRES_EXPLICIT_CONFIRM_GATES"] : [])
    ]);
    const blockers = unique([
      ...dryRun.blockers,
      ...portfolioReview.blockers,
      ...submitState.blockers,
      ...submitStateValidation.blockers
    ]);
    const status = statusFrom(blockers, warnings);
    const artifact = createPaperReviewArtifact({
      sourceAction: input.sourceAction ?? "paper.ops.review",
      status,
      payloadSections: sections,
      submitState,
      summary: {
        dryRunStatus: dryRun.status,
        dryRunWouldSubmit: dryRun.summary.wouldSubmitCount,
        portfolioEligiblePayloads: portfolioReview.summary.eligiblePayloads,
        hedgeRecommendationId: hedgeReview.recommendation.recommendationId,
        hedgeRecommendationStatus: hedgeReview.status,
        payloadSections: Object.fromEntries(
          Object.entries(sections).map(([key, value]) => [key, value.length])
        )
      },
      warnings,
      blockers,
      details: {
        dryRun,
        portfolioReview,
        hedgeReview,
        submitStateValidation
      },
      createdAt: generatedAt
    });
    const summary = {
      artifactId: artifact.id,
      payloadSignature: artifact.payloadSignature,
      payloadCount: artifact.payloadCount,
      sections: Object.fromEntries(
        Object.entries(sections).map(([key, value]) => [key, value.length])
      )
    };
    finishPaperOperation({
      id: started.id,
      status,
      summary,
      warnings,
      blockers
    });
    return {
      paperOnly: true,
      generatedAt,
      workflow: "review",
      triggerSource,
      operationId: started.id,
      status,
      reviewOnly: true,
      automatedExecutionEnabled: automatedExecutionEnabled(),
      summary,
      details: {
        artifact,
        dryRun,
        portfolioReview,
        hedgeReview,
        submitState,
        submitStateValidation
      },
      warnings,
      blockers
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paper ops review failed.";
    finishPaperOperation({
      id: started.id,
      status: "failed",
      errorMessage: message,
      blockers: ["PAPER_OPS_REVIEW_FAILED"]
    });
    throw error;
  }
};

const finishWorkflow = (
  operationId: string,
  workflow: PaperOpsWorkflowReport["workflow"],
  triggerSource: PaperOperationTriggerSource,
  generatedAt: string,
  details: Record<string, unknown>,
  warnings: string[],
  blockers: string[]
): PaperOpsWorkflowReport => {
  const status = statusFrom(blockers, warnings);
  const summary = {
    steps: Object.keys(details),
    automatedExecutionEnabled: automatedExecutionEnabled()
  };
  finishPaperOperation({
    id: operationId,
    status,
    summary,
    warnings,
    blockers
  });
  return {
    paperOnly: true,
    generatedAt,
    workflow,
    triggerSource,
    operationId,
    status,
    reviewOnly: true,
    automatedExecutionEnabled: automatedExecutionEnabled(),
    summary,
    details,
    warnings,
    blockers
  };
};

export const runPaperOpsMorning = async (
  input: { triggerSource?: PaperOperationTriggerSource } = {},
  deps: PaperOpsDeps = {}
): Promise<PaperOpsWorkflowReport> => {
  const triggerSource = input.triggerSource || "cli";
  const operation = startPaperOperation({
    actionType: "paper.ops.morning",
    triggerSource,
    command: "paper:ops:morning"
  });
  const generatedAt = deps.now?.() || new Date().toISOString();
  try {
    const learningEvaluation = (deps.evaluateLearning ?? evaluatePaperLearningRecords)({
      limit: 100,
      asOf: generatedAt
    });
    const learningSummary = (deps.learningSummary ?? paperLearningSummary)();
    const promotionReadiness = (deps.promotionReadiness ?? buildPromotionReadinessAnalytics)();
    const learningGovernance = (deps.applyLearningGovernance ?? applyPaperLearningGovernance)();
    const research = await (deps.runResearch ?? runResearchDaily)({
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 10,
      useAlpacaAssets: true,
      barLookbackDays: 120
    });
    const optionsDiscovery = await (deps.buildOptionsDiscovery ?? buildPaperOptionsDiscoveryReport)({
      underlying: "SPY",
      dte: 0,
      asOf: generatedAt
    });
    const review = await runPaperOpsReview(
      {
        triggerSource,
        moment: "morning"
      },
      deps
    );
    return finishWorkflow(
      operation.id,
      "morning",
      triggerSource,
      generatedAt,
      {
        learningEvaluation,
        learningSummary,
        promotionReadiness,
        learningGovernance,
        research,
        optionsDiscovery,
        review
      },
      [
        ...optionsDiscovery.warnings,
        ...review.warnings,
        ...(automatedExecutionEnabled() ? ["AUTOMATED_EXECUTION_NOT_RUN_BY_OPS_WORKFLOW"] : [])
      ],
      [...optionsDiscovery.blockers, ...review.blockers]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Morning paper ops workflow failed.";
    finishPaperOperation({
      id: operation.id,
      status: "failed",
      errorMessage: message,
      blockers: ["PAPER_OPS_MORNING_FAILED"]
    });
    throw error;
  }
};

export const runPaperOpsMidday = async (
  input: { triggerSource?: PaperOperationTriggerSource } = {},
  deps: PaperOpsDeps = {}
): Promise<PaperOpsWorkflowReport> => {
  const triggerSource = input.triggerSource || "cli";
  const operation = startPaperOperation({
    actionType: "paper.ops.midday",
    triggerSource,
    command: "paper:ops:midday"
  });
  const generatedAt = deps.now?.() || new Date().toISOString();
  try {
    const portfolioReview = await (deps.buildPortfolioReview ?? buildPaperPortfolioReviewReport)({
      moment: "midday"
    });
    const hedgeReview = await (deps.buildHedgeReview ?? buildAndPersistHedgeReview)({
      asOf: generatedAt,
      triggerSource
    });
    return finishWorkflow(
      operation.id,
      "midday",
      triggerSource,
      generatedAt,
      {
        portfolioReview,
        hedgeReview
      },
      [...portfolioReview.warnings, ...hedgeRefreshWarnings(hedgeReview)],
      portfolioReview.blockers
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Midday paper ops workflow failed.";
    finishPaperOperation({
      id: operation.id,
      status: "failed",
      errorMessage: message,
      blockers: ["PAPER_OPS_MIDDAY_FAILED"]
    });
    throw error;
  }
};

export const runPaperOpsLateDay = async (
  input: { triggerSource?: PaperOperationTriggerSource } = {},
  deps: PaperOpsDeps = {}
): Promise<PaperOpsWorkflowReport> => {
  const triggerSource = input.triggerSource || "cli";
  const operation = startPaperOperation({
    actionType: "paper.ops.late_day",
    triggerSource,
    command: "paper:ops:late-day"
  });
  const generatedAt = deps.now?.() || new Date().toISOString();
  try {
    const review = await runPaperOpsReview(
      {
        triggerSource,
        moment: "late_day",
        sourceAction: "paper.ops.late_day"
      },
      deps
    );
    const portfolioReview = review.details.portfolioReview as PaperPortfolioReviewReport;
    const hedgeReview = review.details.hedgeReview as HedgeReviewReport;
    return finishWorkflow(
      operation.id,
      "late_day",
      triggerSource,
      generatedAt,
      {
        portfolioReview,
        hedgeReview,
        artifact: review.details.artifact,
        review,
        forcedExitReview: true
      },
      unique([...review.warnings, ...hedgeRefreshWarnings(hedgeReview)]),
      unique(review.blockers)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Late-day paper ops workflow failed.";
    finishPaperOperation({
      id: operation.id,
      status: "failed",
      errorMessage: message,
      blockers: ["PAPER_OPS_LATE_DAY_FAILED"]
    });
    throw error;
  }
};

export const latestReviewArtifactReadiness = () => {
  const artifact = latestPaperReviewArtifact();
  if (!artifact) {
    return {
      ready: false,
      status: "blocked" as const,
      reason: "NO_REVIEW_ARTIFACT"
    };
  }
  const verification = verifyPaperReviewArtifact({ artifact });
  if (!verification.valid) {
    return {
      ready: false,
      status: "blocked" as const,
      reason:
        verification.blockers[0] ?? "REVIEW_ARTIFACT_SIGNATURE_INVALID",
      artifact
    };
  }
  const entryBlocked =
    !(["success", "warning"] as string[]).includes(artifact.status) ||
    artifact.artifact.blockers.length > 0;
  const hasExitPayload =
    artifact.artifact.payloadSections.equitySells.length > 0 ||
    artifact.artifact.payloadSections.optionSellToCloseExits.length > 0;
  if (entryBlocked && !hasExitPayload) {
    return {
      ready: false,
      status: "blocked" as const,
      reason: "REVIEW_ARTIFACT_ENTRY_BLOCKED",
      artifact
    };
  }
  if (!isPaperReviewArtifactFresh(artifact)) {
    return {
      ready: false,
      status: "warning" as const,
      reason: "REVIEW_STALE_OR_PAYLOAD_CHANGED",
      artifact
    };
  }
  if (artifact.payloadCount <= 0) {
    return {
      ready: false,
      status: "blocked" as const,
      reason: "NO_ELIGIBLE_REVIEWED_PAYLOADS",
      artifact
    };
  }
  return {
    ready: true,
    status: entryBlocked ? "warning" as const : "success" as const,
    reason: entryBlocked ? "REVIEW_ARTIFACT_ENTRY_BLOCKED" : null,
    artifact
  };
};

export const formatPaperOpsWorkflowReportAsTable = (report: PaperOpsWorkflowReport) => {
  const lines: string[] = [];
  lines.push(`Paper Ops ${report.workflow}`);
  lines.push(`Status: ${report.status}`);
  lines.push(`Operation ID: ${report.operationId}`);
  lines.push(`Trigger: ${report.triggerSource}`);
  lines.push(`Automated execution enabled: ${String(report.automatedExecutionEnabled)}`);
  lines.push(`Steps: ${Object.keys(report.details).join(", ") || "none"}`);
  if (report.blockers.length) {
    lines.push(`Blockers: ${report.blockers.join(", ")}`);
  }
  if (report.warnings.length) {
    lines.push(`Warnings: ${report.warnings.join(", ")}`);
  }
  lines.push("Review-only workflow. No orders were submitted.");
  return lines.join("\n");
};
