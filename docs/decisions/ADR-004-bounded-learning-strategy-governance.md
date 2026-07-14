# ADR-004: Bounded Learning Strategy Governance

## Context

Paper-learning evaluation ran automatically but only produced analytics. Its outcomes did not persist an operational decision or influence the next autonomous stage.

## Decision

Introduce a local, paper-only governance service that converts bounded evaluated live-like outcomes into immutable strategy-family and symbol decisions. The existing morning paper-ops workflow invokes evaluation, governance, and then research. Candidate ranking consumes the latest decisions, applying a capped priority multiplier or a research-only suspension.

## Rationale

This closes the missing `Learn -> Repeat` lifecycle edge while preserving closed subsystems. Live-like P&L includes modeled execution quality, decision transitions remain auditable, and insufficient evidence preserves the existing baseline.

## Alternatives Considered

- Manual promotion review: rejected because it leaves no automatic downstream consumer.
- Direct changes to universe lifecycle, cadence, or paper eligibility: rejected because those controls belong to closed autonomous subsystems.
- Altering execution gates or broker orders: rejected because learning governance must remain non-broker-mutating.
- Adding a separate timer: rejected because the existing daily morning workflow already provides a bounded automatic consumer; scheduler expansion is a later subsystem.

## Consequences

- Strategy and symbol learning decisions are explicit, bounded, versioned, and inspectable.
- A suspension can suppress future research candidates but cannot change the universe lifecycle or an open position.
- The first research cycle after deployment may remain unchanged when evidence is insufficient, by design.

## Validation

- Targeted service and workflow tests prove priority, suspension, and ordering behavior.
- Production validation requires a completed morning workflow record with a completed governance run and a subsequent research run on the same deployed SHA.

## Conditions for Reconsideration

Revisit only if a reproduced Category A defect shows governance bypasses a closed safety boundary, the bounded policy cannot represent a supported strategy family, or scheduler health work identifies a required orchestration contract.
