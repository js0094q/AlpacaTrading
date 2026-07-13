export interface HedgeExecutionGateInput {
  environment: string;
  paperOnlyIntent: boolean;
  executionEnabled: boolean;
  planValid: boolean;
  sourceSnapshotMatches: boolean;
  configurationMatches: boolean;
  reviewedPayloadHashMatches: boolean;
  duplicateDetected: boolean;
  instrumentSupported: boolean;
  runtimePreflightPassed: boolean;
  liveTradingEnabled?: boolean;
  liveHedgeExecutionEnabled?: boolean;
  multiLegExecution?: boolean;
}

export interface HedgeExecutionGateResult {
  allowed: boolean;
  blockers: string[];
  checks: Record<string, boolean>;
}

export const evaluateHedgeExecutionGate = (
  input: HedgeExecutionGateInput
): HedgeExecutionGateResult => {
  const checks = {
    paperEnvironment: input.environment === "paper",
    paperOnlyIntent: input.paperOnlyIntent,
    executionEnabled: input.executionEnabled,
    planValid: input.planValid,
    sourceSnapshotMatches: input.sourceSnapshotMatches,
    configurationMatches: input.configurationMatches,
    reviewedPayloadHashMatches: input.reviewedPayloadHashMatches,
    duplicateProtectionClear: !input.duplicateDetected,
    instrumentSupported: input.instrumentSupported,
    runtimePreflightPassed: input.runtimePreflightPassed,
    liveTradingDisabled: input.liveTradingEnabled !== true,
    liveHedgeExecutionDisabled: input.liveHedgeExecutionEnabled !== true,
    singleLegOnly: input.multiLegExecution !== true
  };
  const blockers = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => `HEDGE_EXECUTION_GATE_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_FAILED`);
  return {
    allowed: blockers.length === 0,
    blockers,
    checks
  };
};
