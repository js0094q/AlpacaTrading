# Autonomous Recovery and Self-Healing Plan

1. Add recovery-run and recovery-event persistence plus database-health checks.
2. Implement an idempotent local service that terminalizes only three bounded
   stale-record scopes.
3. Add CLI entry points, a paper-only systemd service/timer, and a lifecycle
   `OnFailure` handoff.
4. Add focused service and scheduler tests, shell syntax checks, and normal
   repository validation.
5. Conduct two release reviews. If neither finds a Critical or High issue,
   file Low/theoretical follow-ups and release.
6. Deploy the service, terminalize the proven stale lifecycle row, and retain
   production evidence.

## Self-review

The service is terminal-only. It cannot restart interrupted work or mutate
broker, order, position, lock, strategy, or universe state. The recovery timer
is offset from quarter-hour collectors and persists across reboot. The only
direct failure handoff is the verified lifecycle timeout path; broader scheduler
orchestration remains the next incomplete subsystem.
