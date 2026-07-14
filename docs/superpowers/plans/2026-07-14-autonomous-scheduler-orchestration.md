# Autonomous Scheduler Orchestration Plan

1. Trace installed VPS timers and local unit schedules.
2. Add omitted paper-ops units to the canonical installer and disable path.
3. Move only the two observed colliding schedules outside observatory and
   recovery deadlines, then add ordering for manual/backlogged overlap.
4. Add static schedule and installer coverage to the normal test path.
5. Validate, perform two release reviews, deploy, and confirm timer evidence on
   the VPS.

## Self-review

This is a non-broker scheduling fix. It does not enable or alter execution
timers, reset a failed unit, retry a workload, or change any strategy, universe,
or paper-execution policy. Broader root-level scheduler remediation remains out
of scope because no disabled-timer production defect was observed.
