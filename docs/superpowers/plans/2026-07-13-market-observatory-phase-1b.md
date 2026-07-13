# Market Observatory Phase 1B Implementation Plan

**Goal:** Implement durable decision evidence, broker-reconciled analytical
lifecycles, persisted-only outcomes, learning linkage, trace, and safe deployment
on the Phase 1A baseline.

## Completed implementation slices

- [x] Add the named migration ledger, typed decision/lifecycle identity, exact
  linkage columns/backfill, `db:migrate`, and `db:verify`.
- [x] Persist immutable candidate and review snapshots, append lifecycle events,
  canonical allowlisted provenance hashes, and exact reviewed-payload links.
- [x] Create analytical positions from exact confirmed fills; append exact or
  ambiguous observations; compute complete/incomplete terminal outcomes; append
  revisions.
- [x] Link learning to entry/exit decisions, lifecycle, outcome, and effective
  revision without changing promotion thresholds.
- [x] Add read-only `paper:trace` and documentation/ADR/runbook updates.

## Publication validation

- [ ] Run `npm run lint`, `npm run typecheck`, `npm run build`, and canonical
  `npm test` once from the final commit.
- [ ] Run relevant `bash -n`, `node --check`, `git diff --check`, status/stat, and
  recent-log checks.
- [ ] Migrate and verify a copied database twice; confirm retained counts and
  `PRAGMA integrity_check`.
- [ ] Push the four focused commits, open a ready PR covering Phase 1A/1B, require
  green checks, merge with the established merge-commit strategy, and align local
  and remote `main`.

## VPS deployment

- [ ] Verify target SHA, clean deployment checkout, disk, services/timers/locks,
  database path/integrity/schema, broker-order baseline, and paper/live flags
  without printing secrets.
- [ ] Stop affected database writers, back up SQLite, migrate/verify a controlled
  copy, then migrate/verify the production database.
- [ ] Fast-forward deploy the merged SHA, install/build, reinstall existing units,
  restore prior service/timer state, and enable `alpaca-market-observatory.timer`.
- [ ] Verify migration/indexes/retained rows/orphans, services, timer schedule,
  51-symbol universe, and read-only Alpaca access.
- [ ] Validate a 51-accounted `COMPLETE` or explicit bounded `PARTIAL` run. Outside
  market hours, record `SKIPPED_MARKET_CLOSED` and regular-session evidence pending.
- [ ] Run research/review without forced execution. Report `VALIDATED_NO_OP` when
  no candidate naturally passes unchanged gates.
- [ ] Update and read back Basic Memory with commits, PR/merge/deploy SHAs,
  migration/timer/observatory results, runtime limitations, and safety confirmation.

## Hard boundaries

Paper only. No live credentials/orders, no forced paper trades, no guard weakening,
no multi-leg/external-data/counterfactual expansion, and no unrelated strategy
redesign. Preserve the user-owned guarded-hedge plan edit.
