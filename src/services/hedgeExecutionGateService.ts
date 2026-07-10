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
}

export interface HedgeExecutionGateResult {
  allowed: false;
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
    runtimePreflightPassed: input.runtimePreflightPassed
  };
  const blockers = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => `HEDGE_EXECUTION_GATE_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_FAILED`);
  blockers.push("HEDGE_EXECUTION_NOT_IMPLEMENTED");
  return {
    allowed: false,
    blockers,
    checks
  };
};
