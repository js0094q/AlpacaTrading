# ADR-001: Guarded Paper Hedge Execution

**Status:** Accepted  
**Date:** 2026-07-10

## Context

The portfolio-risk layer can recommend protection but intentionally cannot submit hedge orders. The approved next phase requires one real paper hedge for controlled learning while preserving a hard prohibition on live trading. Existing generic reviewed execution is timer-integrated and does not revalidate the complete portfolio Greek and hedge evidence required here.

## Decision

1. Support only a single-leg long protective put for the first executable phase.
2. Keep put spreads analysis-only until atomic broker and SDK semantics, parent/leg persistence, and failure recovery are independently verified.
3. Create a separate HMAC-signed hedge execution review bound to the paper account, source portfolio/risk/recommendation, current market evidence, quantity, price, and premium cap.
4. Execute only on the VPS through explicit confirmed-paper CLI or authenticated proxy action.
5. Keep hedge intents outside the existing timer-owned `optionBuys` reviewed section.
6. Require current delta coverage and selected-contract quote/Greek freshness before every submission.
7. Use deterministic client order IDs, ledger reservation, broker/order/position reconciliation, bounded limit repricing, and cancellation of only the newly submitted hedge order.
8. Keep `HEDGE_LIVE_EXECUTION_ENABLED=false` and `HEDGE_AUTOMATED_PAPER_EXECUTION_ENABLED=false` in the deployed phase.

## Rationale

A long put has defined premium risk, preserves upside, can be represented as one broker order, and supplies real paper evidence without legging risk. A separate review prevents analysis artifacts or scheduled generic option entry workflows from accidentally becoming execution authority. Keyed signatures and execution-time revalidation protect against stored-payload mutation and stale evidence.

## Alternatives Considered

- **Enable existing hedge plans directly:** rejected because they are unkeyed, weakly schema-validated, and intentionally omit executable order fields.
- **Add hedges to generic `optionBuys`:** rejected because existing entry timers can consume that section.
- **Submit put-spread legs sequentially:** prohibited because either leg can fill independently and create unintended exposure.
- **Use an inverse ETF first:** rejected for this phase because path dependence and sizing assumptions require a separate execution review.
- **Stay recommendation-only:** rejected because the approved objective is controlled paper learning from actual execution.

## Consequences

- New review, execution, fill-management, reconciliation, and learning code is required.
- The paper Alpaca client gains get/replace/cancel order methods, all hard-bound to the paper endpoint.
- The scheduler may refresh and monitor, but cannot submit hedges by default.
- Paid premium and imperfect fills are accepted paper-learning outcomes when they remain inside reviewed caps.

## Validation

- Tests prove no live client receives a call, no blocked path calls the broker, only the reviewed symbol/quantity can submit, only the new hedge order can be replaced/canceled, and all retry/reprice counts are bounded.
- Deployment reads back paper/live/automation booleans without secrets.
- The used review cannot be resubmitted.

## Reconsideration

Atomic put spreads may be reconsidered only after the exact broker request/response contract, options approval, parent/leg state model, partial-fill behavior, cancel/replace semantics, and recovery tests are documented and verified in paper trading.

