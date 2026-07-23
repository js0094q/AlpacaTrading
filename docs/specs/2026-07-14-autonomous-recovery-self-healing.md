# Autonomous Recovery and Self-Healing

## Goal

Close the demonstrated autonomous recovery gap without broadening broker or
execution behavior. A universe-lifecycle timeout on 2026-07-14 left its local
run record in `running` until the next daily lifecycle invocation.

## Verified current state

- The universe lifecycle is production-complete at `8232ff9` and remains
  non-broker-mutating.
- Its systemd deadline can terminate a run after its local run record is
  created but before it becomes terminal.
- The previous lifecycle worker only repaired stale runs when the following
  daily lifecycle invocation began.
- Existing monitor locks already have systemd `ExecStopPost` cleanup. This
  scope does not modify lock behavior.

## Desired end state

A bounded local recovery worker automatically terminalizes stale autonomous
records, persists provenance, and leaves reruns to existing scheduled workers.
It is paper-only and has no Alpaca or order-submission path.

## Scope

- Persist recovery runs and immutable recovery events with timestamps, Git SHA,
  configuration version/hash, source record, and reason code.
- Mark only stale `running` rows terminal:
  - universe lifecycle after 90 seconds;
  - learning governance after five minutes;
  - non-mutating paper operations after 15 minutes.
- Schedule recovery at minutes 07, 22, 37, and 52 with reboot catch-up.
- Invoke recovery after a universe-lifecycle systemd failure.

## Non-goals

- No broker API calls, order submission, retry, lock deletion, timer redesign,
  strategy policy change, or universe-selection change.
- No synthetic failure injection in production.

## Contracts

- `system:recover` returns recovery counts and provenance.
- `system:recover:status` returns the latest recovery run and current stale
  counts.
- Every repair uses `RECOVERED_INCOMPLETE_RUN` or
  `RECOVERED_INCOMPLETE_OPERATION` and emits an immutable event.
- A repeated recovery run is idempotent: terminal rows are not changed again.

## Failure behavior

If recovery itself fails, it records a failed recovery run. It does not retry
the source workload. Existing next-window schedulers remain the automatic
downstream consumers.

## Acceptance criteria

- A timed-out lifecycle row becomes terminal without waiting for the next daily
  lifecycle run.
- Stale learning and non-mutating operations are terminalized under bounded
  thresholds.
- Fresh rows and execution-related records remain untouched.
- Recovery is scheduled, reboot-aware, audited, paper-only, and validated on
  the VPS.
