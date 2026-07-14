# ADR-003: Autonomous Universe Lifecycle Policy

## Context

The current universe is a static seed with ad hoc asset refresh. It cannot
autonomously discover or qualify symbols, and it has no durable explanation for
why a symbol is available to the paper workflow.

## Decision

Introduce a dedicated, paper-only Autonomous Universe Lifecycle Service that:

- discovers a bounded rotating set of Alpaca active US equities;
- records immutable local lifecycle events;
- separates observable symbols from research-active symbols;
- uses existing research, quality, execution, position, outcome, and learning
  evidence to change only local universe membership;
- runs daily after the market session in its own non-executing systemd unit.

The service projects lifecycle state to the existing enabled field. It does not
change review, execution, broker, or live-trading contracts.

## Rationale

This is the first missing autonomous lifecycle capability. It creates an
automatic downstream path from authoritative discovery to observatory,
qualification, research, ranking, review, and the already guarded paper
workflow without spending effort on accepted subsystems.

## Alternatives considered

1. Expand the static seed manually.
   Rejected because it retains human-driven discovery and cannot meet the
   autonomy requirement.

2. Add discovered symbols directly to the active research universe.
   Rejected because it bypasses observation, liquidity, historical-coverage,
   and evidence qualification.

3. Add a new execution path for paper_eligible symbols.
   Rejected because existing review and execution gates are authoritative and
   must not be bypassed.

4. Replace the 15-minute observatory with the daily lifecycle worker.
   Rejected because the observatory remains the collector for the active known
   universe and has accepted production behavior.

## Consequences

- Existing static members retain research eligibility through a baseline event.
- New members have a conservative observation period before they enter research.
- The lifecycle worker adds bounded Alpaca asset reads and bounded historical-bar
  ingestion, but no order calls.
- Lifecycle state and reason become inspectable through the CLI and database.
- Strategy-family promotion and platform-wide self-healing remain deliberately
  separate follow-on subsystems.

## Validation

The implementation must demonstrate transition persistence, membership
separation, promotion, suspension, recovery, scheduler isolation, paper-only
service configuration, and migration verification.

## Conditions for reconsideration

Revisit this decision only if Alpaca materially changes its assets API, a
Category A production defect invalidates the policy, or a later approved
strategy-promotion subsystem requires a new explicit contract.
