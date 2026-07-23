# Autonomous Scheduler Orchestration and Lifecycle Health

## Goal

Make every non-broker autonomous handoff durable across VPS rebuilds and remove
the observed database-heavy timer collisions.

## Verified current state

- The VPS had all three `paper-ops-*` timers enabled, but the canonical
  monitoring installer and disable script did not own them.
- `paper-ops-midday.timer` and the observatory both ran at 12:00 ET.
- `paper-ops-late-day.timer` and the observatory both ran at 15:15 ET.
- The observatory has a five-minute deadline; recovery is scheduled at minutes
  07, 22, 37, and 52 with a one-minute deadline.
- Universe lifecycle recovery is production-complete and remains separate from
  scheduler orchestration.

## Desired end state

One canonical installer owns every non-broker pipeline timer. Intraday
database-heavy workflows are time-separated and ordered behind observatory and
recovery if either remains active. Existing execution timers and gates remain
unchanged.

## Scope

- Add morning, midday, and late-day paper-ops units to install/disable scripts.
- Move midday work to 12:10 ET and late-day work to 15:25 ET.
- Add local systemd ordering behind observatory and recovery for those workflows.
- Persist the schedule contract in docs and tests.

## Non-goals

- No root auto-remediation, unit reset, lock redesign, broker call, order retry,
  execution timer change, or lifecycle-policy change.
- No change to observatory cadence or the existing execution gates.

## Acceptance criteria

- A rebuilt VPS enables the complete non-broker autonomous timer set from one
  installer.
- Midday and late-day workflows cannot begin in the observatory/recovery
  deadline windows under their documented schedules.
- All affected services remain paper-only and review-only.
- Production timer evidence confirms the new canonical schedule is active.
