# Plan: Alpaca Asset-Filter Hardening

**Goal:** Replace generic Alpaca asset-filter failures with evidence-backed `VALID`/`INVALID`/`UNKNOWN` validation while preserving paper-only fail-closed execution.

**Constraints:** Preserve the SQLite repair, existing paper safety gates, API contracts where compatibility is possible, and unrelated user changes. No live credentials or orders.

## Task 1: Establish the diagnostic contract

Files: `src/services/alpacaClient.ts`, `src/services/alpacaAssetService.ts`, `src/lib/db.ts`, `src/services/assetValidationLogService.ts`.

Implementation:

```text
1. Add the explicit classification and status unions.
2. Extend the read-only paper GET path with per-attempt safe diagnostics.
3. Capture endpoint, GET method, status, parsed provider code/message, exception class, timeout, attempt count, Alpaca request ID, internal request ID, and correlation ID.
4. Add asset-validation cache and event tables without changing existing SQLite lock behavior.
5. Persist event rows and successful cache entries in bounded batch writes; never persist credentials or authorization headers.
```

Validation: first add tests for classifications, error parsing, request IDs, and redaction; run them red to confirm the contract is not already implemented.

## Task 2: Implement bounded validation, retry, cache, and deadline behavior

Files: `src/services/alpacaAssetService.ts`, `src/services/alpacaClient.ts`, `src/config.ts` if required.

Implementation:

```text
1. Validate a fresh successful response into a complete metadata snapshot.
2. Classify definitive invalid responses separately from transient and unknown failures.
3. Retry only transient failures, no more than three total attempts, with bounded exponential backoff, jitter, and bounded Retry-After.
4. Run a 51-symbol batch through a bounded worker pool with a hard outer deadline.
5. Reuse only fresh successful cache entries; return UNKNOWN on stale-cache transient failure and retain stale data only as informational evidence.
6. Record metrics and diagnostics for every attempt and return a structured batch result.
```

Validation: run the focused validation tests for all required status, retry, cache, deadline, concurrency, and redaction cases.

## Task 3: Integrate research semantics

Files: `src/services/researchOrchestrator.ts`, `server/dashboard-control/server.ts`, `src/services/paperOpsWorkflowService.ts` if context propagation is needed.

Implementation:

```text
1. Propagate the control request and correlation IDs into the child research process.
2. Replace sequential boolean filtering with the bounded validation batch.
3. Preserve UNKNOWN targets for research and remove only INVALID targets.
4. Separate invalid and unknown arrays in the persisted result while retaining compatibility aliases where existing consumers require them.
5. Include metrics, classifications, warnings, and IDs without sensitive headers.
```

Validation: update research integration tests and run the existing research suite plus SQLite concurrency coverage.

## Task 4: Integrate fail-closed plan and execution validation

Files: `src/services/paperPlanService.ts`, `src/services/paperExecuteDryRunService.ts`, `src/services/paperReviewedPayloadExecutionService.ts`, related tests.

Implementation:

```text
1. Make plan review require fresh positive validation instead of accepting stale or UNKNOWN state.
2. Pass an explicit fresh-validation requirement through confirm-paper execution.
3. Add the same fresh validation immediately before reviewed paper payload submission.
4. Block with a specific asset-validation reason and preserve existing reconciliation, duplicate, reservation, buying-power, and confirmation controls.
```

Validation: add/adjust paper plan, dry-run, confirm-paper, and reviewed-payload tests; verify no submit callback runs for UNKNOWN.

## Task 5: Verify and release through the controlled paper process

Files: relevant source/tests/docs only.

Implementation:

```text
1. Run focused tests, SQLite concurrency tests, lint, typecheck, build, and relevant paper-safety suites.
2. Inspect the final diff and stage only relevant files.
3. Commit and push the feature through the existing controlled deployment path.
4. Verify the exact deployed SHA on the VPS and confirm the service is running that SHA.
5. Trigger the equivalent guarded paper research action with aggressive risk, options enabled, maxCandidates 10, assetClass all, underlying SPY, and dte 0.
6. Inspect the research result, structured diagnostics, event logs, request/correlation IDs, and service journal for SQLite lock recurrence.
```

Acceptance: report root cause, behavior change, status semantics, retry/deadline/cache/concurrency settings, exact test results, deployed SHA, production IDs, Alpaca request IDs for any new failures, paper-only safeguard confirmation, and SQLite-lock observations.
