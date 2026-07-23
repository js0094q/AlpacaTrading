# Alpaca Asset-Filter Hardening

## Goal

Make paper research asset validation evidence-bearing and fail-safe. A temporary Alpaca, network, timeout, or response-processing failure must be represented as `UNKNOWN`, not as a definitive asset rejection. Paper order review and submission must continue to require fresh positive asset validation.

## Verified current state

- The 2026-07-15 guarded paper research action completed successfully with 51 targets and six selected candidates.
- The completed run persisted 48 successful `/v2/assets/{symbol}` HTTP 200 requests.
- No persisted asset-response rows exist for SPY, TQQQ, or TSLA for that run. The old validator therefore cannot identify their HTTP status, response body, exception class, timeout state, retry attempts, or Alpaca request ID after the fact.
- The old validator maps every non-404 failure to `api_error`, filters every `tradable: false` result out of research, has no recent-success metadata cache, and validates plan candidates with an in-process per-plan promise cache.
- The SQLite concurrency repair and existing lock diagnostics remain in scope and must not be weakened. A single successful research run is not evidence that the lock incident is permanently closed.
- Existing paper-order safety gates, reconciliation, reservation, buying-power, confirmation, and submit-time controls remain authoritative.

## Desired end state

1. Asset validation returns `VALID`, `INVALID`, or `UNKNOWN`.
2. Definitive asset conditions use explicit classifications: `asset_not_found`, `asset_not_tradable`, `asset_inactive`, and `unsupported_asset_class`.
3. Transport and provider conditions use explicit classifications: `authentication_error`, `authorization_error`, `rate_limited`, `request_timeout`, `network_error`, `invalid_response`, `alpaca_server_error`, and `unknown_api_error`.
4. Each failed attempt captures safe endpoint, method, status, parsed Alpaca code/message, exception class, timeout state, attempt count, Alpaca request ID when present, internal request ID, and correlation ID. Credentials and authorization headers are never persisted or logged.
5. Transient failures receive at most three total attempts, bounded exponential backoff with jitter, and bounded `Retry-After` handling. A batch has an outer deadline and bounded concurrency.
6. Successful asset metadata is cached by trading environment and symbol for a documented freshness interval. Only successful `VALID` responses enter the cache. Stale data is never silently treated as current.
7. Research excludes only `INVALID` results. `UNKNOWN` targets are retained or explicitly deferred, surfaced in the result, and cannot reach order submission.
8. Plan review and both paper execution paths require a fresh positive validation. `UNKNOWN`, stale cache, and `INVALID` are fail-closed.

## Scope

### In scope

- The paper Alpaca asset endpoint call path.
- Asset validation classifications, diagnostics, retry/deadline policy, cache, structured event logging, and batch concurrency.
- Research result summaries and warnings.
- Paper plan review and paper order submit-time validation.
- Focused unit, integration, safety, logging-redaction, concurrency, retry, cache, and deadline tests.
- Controlled paper-only production verification and exact deployed SHA evidence.

### Non-goals

- No live credentials, live endpoint, live order, or live-trading flag changes.
- No changes to the SQLite lock repair.
- No weakening of review, confirmation, account reconciliation, duplicate prevention, reservation, buying-power, or submit-time controls.
- No assumption that SPY, TQQQ, or TSLA are invalid.

## Interfaces and contracts

```ts
type AssetValidationStatus = "VALID" | "INVALID" | "UNKNOWN";

type AssetValidationClassification =
  | "asset_not_found"
  | "asset_not_tradable"
  | "asset_inactive"
  | "unsupported_asset_class"
  | "authentication_error"
  | "authorization_error"
  | "rate_limited"
  | "request_timeout"
  | "network_error"
  | "invalid_response"
  | "alpaca_server_error"
  | "unknown_api_error";

interface AssetValidationFailure {
  symbol: string;
  classification: AssetValidationClassification;
  transient: boolean;
  endpoint?: string;
  httpStatus?: number;
  alpacaCode?: number | string;
  alpacaMessage?: string;
  alpacaRequestId?: string;
  internalRequestId?: string;
  correlationId?: string;
  exceptionClass?: string;
  timedOut?: boolean;
  attemptCount: number;
}
```

`VALID` means Alpaca confirmed the asset exists, is active, and satisfies configured tradability and supported-class requirements. `INVALID` means Alpaca definitively confirmed missing, inactive, non-tradable, or unsupported. `UNKNOWN` means validation did not complete with definitive evidence; it is never an order-eligible state.

## Failure and timing policy

- Default maximum attempts: 3 total.
- Retry only transient failures: 429, 5xx, transport/network failures, and request timeouts.
- Do not retry authentication, authorization, definitive asset validation, or other non-transient 4xx failures.
- Backoff is bounded exponential with jitter and honors a bounded `Retry-After` value.
- Default asset-batch concurrency: 4; configuration is bounded to a safe maximum.
- Default asset-batch deadline: 60 seconds; every request uses the remaining deadline as an upper bound.
- Default successful-cache freshness: 15 minutes. The interval is configurable through `ALPACA_ASSET_CACHE_MAX_AGE_MS`.
- Default request timeout remains bounded by `ALPACA_REQUEST_TIMEOUT_MS`; a request cannot outlive the batch deadline.

## Research and execution behavior

- Research continues with `VALID` and `UNKNOWN` targets. It removes only `INVALID` targets.
- Research output separates `validated`, `invalid`, and `unknown`, and includes structured metrics and warnings.
- Paper plan review forces a fresh asset validation for each candidate. A fresh `VALID` response is required.
- Paper order submission retains existing paper-only and explicit confirmation gates and additionally blocks any asset whose fresh submit-time validation is not `VALID`.

## Acceptance criteria

- The old `api_error` classification is not emitted by the asset-validation path.
- The 20 required test scenarios pass, including 51-symbol bounded concurrency and outer-deadline enforcement.
- Existing SQLite concurrency tests continue to pass without database-repair changes.
- Lint/typecheck and relevant research/paper-safety suites pass.
- A controlled paper research run completes with no live mutation, no generic `api_error`, and a structured result for SPY/TQQQ/TSLA.
- The deployed SHA is recorded and matches the verified checkout.
- Any SQLite lock recurrence during the verification window is reported rather than declared closed.

## Deployment boundary

Only the existing controlled paper deployment path may be used. No live environment, live credentials, order submission, or production infrastructure hardening is authorized by this specification. Research verification must remain read-only broker access and use the existing guarded paper action.
