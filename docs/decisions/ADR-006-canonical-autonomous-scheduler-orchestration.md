# ADR-006: Canonical Autonomous Scheduler Orchestration

## Context

The VPS ran the non-broker morning, midday, and late-day paper-ops timers, but
the canonical installation scripts did not manage them. Midday and late-day
work also shared direct timer windows with the database-heavy observatory.

## Decision

Manage all non-broker autonomous timers through the canonical installer and
disable script. Schedule midday paper operations at 12:10 ET and late-day
operations at 15:25 ET, with systemd ordering behind observatory and recovery.

## Rationale

This removes rebuild drift and deterministic overlap without enabling execution
or introducing a privileged auto-remediation service. The fixed windows leave
the observatory and recovery deadlines clear before each paper-ops workflow.

## Consequences

The non-broker lifecycle has one deployment surface and bounded database load.
Execution timers retain their existing independent gates and are intentionally
outside this decision.

## Reconsideration

Revisit only for a reproduced timer-health failure, a documented timing
requirement change, or a new Category A overlap defect.
