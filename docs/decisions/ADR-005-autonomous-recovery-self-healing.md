# ADR-005: Bounded Autonomous Recovery and Self-Healing

## Context

The daily universe-lifecycle systemd deadline can terminate a worker after its
database run record is created but before it becomes terminal. The existing
recovery hook only ran with the following daily lifecycle invocation.

## Decision

Add a local, auditable recovery worker that terminalizes stale records and emits
immutable recovery events. It runs periodically with `Persistent=true` and is
the `OnFailure` target for the universe-lifecycle unit.

## Rationale

Terminalizing a known stale record restores the autonomous downstream contract
without reissuing market-data work, placing orders, or modifying broker state.
The next existing scheduled worker remains responsible for new work.

## Alternatives considered

- Retry the interrupted lifecycle immediately: rejected because it could create
  overlap and database pressure.
- Wait for the next lifecycle window: rejected because it leaves a demonstrated
  autonomous failure unresolved for nearly a day.
- Add generic stale-lock deletion: rejected because no stale-lock defect was
  demonstrated and known monitor locks already clean up through systemd.

## Consequences

Recovery is bounded to local records and requires its own production evidence.
Global timer orchestration and broader service-health remediation remain a
separate subsystem.

## Reconsideration

Revisit only for a reproduced recovery failure, a changed service contract, or
a required autonomous lifecycle stage that remains without a downstream
consumer.
