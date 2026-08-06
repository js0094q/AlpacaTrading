# 0DTE Exposure and LEAPS Allocation Design

## Objective

Allow a qualified SPY 0DTE option candidate to proceed when the paper account
holds SPY equity, while continuing to reject an already-held exact option
contract. Raise the independent LEAPS per-entry capital ceiling from $5,000 to
$7,500.

## Scope

- Treat the aggregated PostgreSQL position packet as authoritative when it is
  present. The legacy scalar `open_position_count` may synthesize an exact
  position only for older callers that do not provide the aggregate packet.
- Keep the portfolio arbitrator's exact-symbol position, active-order, pending
  commitment, duplicate-proposal, buying-power, cash, portfolio-capacity, and
  risk checks unchanged.
- Change the paper-only LEAPS default, hard maximum, and autonomous worker
  environment from $5,000 to $7,500.
- Update focused tests and operator documentation to match the new behavior.

## Safety Boundaries

- No existing SPY equity or option position is closed, resized, or otherwise
  mutated.
- No broker order is created for validation.
- Live trading remains disabled and PostgreSQL remains the sole authority.
- No schema, strategy selection, option threshold, scheduler, dashboard, or
  research-path change is included.
- Deployment is excluded. A verified final commit requires separate exact-SHA
  deployment authorization and a separately authorized worker stop/start.

## Acceptance Criteria

1. With an authoritative aggregate containing SPY equity but no exact 0DTE
   contract, a qualified SPY 0DTE proposal is not rejected as symbol exposure.
2. An authoritative aggregate containing the exact 0DTE contract still causes
   `ARBITRATION_SKIPPED_SYMBOL_EXPOSURE`.
3. Callers without aggregate position data retain the legacy scalar-count
   fail-closed behavior.
4. Paper LEAPS sizing accepts and defaults to $7,500, rejects values above
   $7,500, and sizes whole contracts within independently validated capital.
5. The checked-in worker explicitly supplies
   `LEAPS_MAX_ENTRY_CAPITAL_USD=7500`.
6. Focused tests, typecheck, production build, diff validation, and a secret
  scan pass against the exact worktree.
