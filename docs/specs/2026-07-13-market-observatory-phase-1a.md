# Market Observatory Phase 1A

**Repository:** `/Users/josephstewart/Documents/Alpaca Trading`
**Date:** 2026-07-13
**Status:** Approved for implementation
**Risk level:** Financially consequential data and research change; non-executing
**Target branch:** `feat/market-observatory`
**Baseline:** `main@1d274301fab8739702d0105bcf8e6b7ff504761a`

## Goal

Expand the canonical research universe with the requested 20-name set, make every
canonical symbol traceable through the existing research and paper lifecycle, and
collect rich Alpaca stock snapshots every 15 minutes during regular market hours.
Persist source timestamps, feed provenance, freshness, partial-data status, and
straightforward derived values without creating a parallel research or execution
system.

## Verified Current State

- Basic Memory records `main@1d274301fab8739702d0105bcf8e6b7ff504761a` as the
  converged repository state and `feat/market-observatory` as the next work lane.
- The local checkout matched that SHA before the feature branch was created. The
  user-owned modification to
  `docs/superpowers/plans/2026-07-10-guarded-paper-hedge-execution.md` remains
  outside this task.
- `src/config/universe.seed.ts` is the canonical seed. It currently contains 32
  unique symbols and already includes `TSLA`; the requested set therefore adds 19
  net-new rows and results in 51 unique canonical symbols.
- `universe_symbols` currently stores symbol, asset class, enabled state, source,
  tradability, and created/updated timestamps.
- `market_bars`, `feature_snapshots`, `research_runs`,
  `paper_trade_candidates`, `paper_learning_records`, and `ingestion_runs` are the
  existing lifecycle stores.
- Research seeds the canonical universe, ingests active-symbol bars, builds
  features and targets, ranks candidates, persists selected candidates, and builds
  paper plans. No separate research ticker array is present in that pipeline.
- `scripts/paper-monitor-runner.mjs` already provides market-session gating,
  per-task non-overlap locks, bounded child execution, and redacted logs.
- The canonical pre-change `npm test` run passed.
- Alpaca asset-reference validation on 2026-07-13 found all 20 requested symbols
  active, tradable, fractionable, shortable, and options-enabled through the
  `has_options` attribute. A read-only IEX multi-symbol snapshot returned trade,
  quote, minute, daily, and previous-daily components.
- `docs/ARCHITECTURE.md` and `docs/runbooks/` are not present. README, the current
  source, existing specs/ADR, and systemd units are authoritative for this task.

## Desired End State

1. The canonical seed contains every existing symbol plus:
   `AAPL`, `MSFT`, `NVDA`, `AMZN`, `META`, `GOOGL`, `TSLA`, `AMD`, `AVGO`,
   `NFLX`, `JPM`, `GS`, `XOM`, `LLY`, `UNH`, `COST`, `WMT`, `CAT`, `PLTR`,
   and `SMCI`.
2. Universe initialization is idempotent and enriched asset validation records
   status, exchange, tradability, fractionability, shortability, marginability,
   options availability, attributes, validation time, and request ID when present.
3. Inactive or non-tradable assets remain recorded but are disabled and excluded
   from the active universe.
4. One batched Alpaca stock-snapshot provider collects the complete traceable
   universe and preserves the requested/effective feed plus Alpaca request ID.
5. One append-only `stock_snapshots` table stores raw normalized evidence,
   component timestamps, derived values, freshness, data quality, source, and the
   ingestion run ID. Repeated source evidence is deduplicated.
6. Latest observatory values augment the most recent feature snapshot for each
   symbol. Historical feature rows are not rewritten with current observations.
7. Every fully scored candidate is stored in `paper_trade_candidates`, including
   selected and non-selected decisions, with decision/reason, strategy family,
   signal inputs, and data-quality state. Only selected candidates continue into
   existing paper-plan creation.
8. The existing learning service continues to accept features for every canonical
   symbol without symbol allowlists.
9. A dedicated systemd timer invokes the existing non-overlapping monitor runner
   every 15 minutes on weekdays during regular market-hour windows. The observation
   command checks the Alpaca market clock again and records market-closed skips.
10. The observation path contains no order client and cannot submit paper or live
    orders.

## Scope

### In scope

- Canonical seed expansion and enriched `universe_symbols` metadata.
- Read-only Alpaca asset-reference refresh for the traceable universe.
- Read-only, batched stock snapshots using an explicit feed, initially `iex`.
- Additive/idempotent SQLite schema and indexes.
- Complete/partial/stale/missing/source-error normalization.
- Derived midpoint, spread, spread percentage, daily return, gap from previous
  close, return from open, distance from VWAP, intraday range, and relative
  current-day volume when inputs exist.
- Research feature enrichment, all-scored-candidate persistence, learning
  compatibility, CLI command, existing-runner registration, systemd units, tests,
  README/resume synchronization, commit, push, and Basic Memory update.

### Non-goals

- External macro, event, Treasury, FRED, SEC, or Cboe data.
- Counterfactual analytics, MFE/MAE, decision-ID propagation, or longitudinal
  outcome tracking beyond the candidate evidence required here.
- New dashboard views or routes.
- VPS or Vercel deployment.
- Paper or live order submission, forced paper trades, or changes to execution,
  review, reservation, idempotency, duplicate, sizing, exposure, or risk guards.
- Adaptive scheduling or a second scheduling framework.

## Architecture

### Canonical universe

`src/config/universe.seed.ts` remains the only static universe definition.
`seedInitialUniverse()` performs idempotent inserts. A focused asset refresh uses
`getAlpacaAsset()` and updates metadata in place. The active research/observation
universe remains `enabled = 1 AND tradable = 1`; non-tradable or inactive rows fail
closed by setting `enabled = 0` and `tradable = 0`.

### Raw stock observations

`fetchStockSnapshots(symbols, feed)` uses Alpaca's multi-symbol
`/v2/stocks/snapshots` endpoint in bounded chunks. The provider returns each raw
symbol payload with the request ID and requested/effective feed.

`normalizeStockSnapshot()` accepts Alpaca short-field/camel-case payloads and
normalized snake-case fixture payloads. Missing numeric values stay `null`; zero is
preserved. Trade, quote, minute, daily, and previous-daily timestamps remain
separate. `observed_at` is ingestion time and never substitutes for source time.

Freshness uses quote time, then trade time, then minute-bar time. The default
freshness limit is 20 minutes and can be configured with
`MARKET_OBSERVATORY_MAX_AGE_SECONDS`. Freshness is `FRESH`, `STALE`, or `UNKNOWN`.
Data quality is `COMPLETE`, `PARTIAL`, `MISSING_QUOTE`, `MISSING_TRADE`,
`MISSING_MINUTE_BAR`, or `SOURCE_ERROR`.

### Persistence and runs

`stock_snapshots` is additive and append-only. A unique key on symbol, requested
feed, and source timestamp deduplicates repeated market evidence. Indexes cover
symbol/observed time, freshness, source time, and ingestion run.

`ingestion_runs` gains additive requested/successful/failed symbol counts and an
error summary. Observation statuses are `running`, `completed`, `partial`,
`failed`, and `skipped_market_closed`. Persistence uses short transactions; a
symbol-level failure is recorded without discarding successful rows.

### Research and candidate flow

The most recent bar-derived feature row for a symbol is enriched with the latest
persisted stock observation. Snapshot features include prices, spread, bar state,
VWAP, volumes, trade counts, freshness, data quality, and the derived values listed
above. Missing inputs remain `null`.

Candidate ranking keeps its current selected-candidate behavior. It additionally
emits a decision record for every scored candidate. Selected records carry
`decision=selected`; candidates omitted by bounded ranking/diversity caps carry
`decision=skipped` with a structured reason. The persistence contract also accepts
`rejected` and `blocked` decisions so existing and future gates retain their
reason. Paper plan construction still receives only selected candidates.

### Automation

`observatory:collect` performs:

1. paper/live safety assertion for read-only access;
2. canonical seed initialization;
3. Alpaca market-clock check;
4. `skipped_market_closed` run completion when closed;
5. stale/missing asset-reference refresh while the market is open;
6. one bounded multi-symbol stock-snapshot collection;
7. normalization and per-symbol persistence;
8. completed/partial/failed run finalization.

The existing monitor runner registers an `observatory` task with its own lock and
no execution flags or confirmation argument. New systemd units wake every 15
minutes during weekday regular-market windows. No retry loop is added beyond the
existing bounded Alpaca provider retry policy.

## Failure Behavior

- Missing credentials fail before collection and finalize a failed ingestion run
  without exposing credentials.
- A closed market is a successful no-op with a persisted
  `skipped_market_closed` run.
- A missing symbol in an otherwise successful batch becomes a `SOURCE_ERROR`
  observation and makes the run partial.
- A provider or persistence error is sanitized into the ingestion run; successful
  rows already committed remain auditable.
- Empty/malformed component fields remain null and receive an explicit quality
  status. No zero, current time, or prior value is fabricated.
- A busy monitor lock returns `LOCK_BUSY` and starts no second process.

## Acceptance Criteria

- All requested names are present once; all original symbols remain; unique seed
  size is 51; repeated seeding does not add rows.
- Asset normalization and inactive/non-tradable fail-closed behavior are tested.
- Snapshot complete/missing/partial/timestamp/feed/freshness/spread/deduplication
  cases are tested.
- Market-open, market-closed, overlap, partial-symbol, ingestion status, bounded
  retry source, scheduler registration, and no-order-dependency cases are tested.
- New symbols enter bar/feature/target/research flow; all-scored candidate decisions
  persist; learning remains symbol-agnostic; selected-only paper planning remains
  unchanged.
- `npm run lint`, `npm run typecheck`, focused tests, the final canonical test
  suite, `git diff --check`, and repository status/stat checks pass or any unrelated
  failure is reported exactly.
- The branch is committed and pushed without the user-owned plan modification.
- Basic Memory Current State, Phase 1 direction, and a new implementation checkpoint
  contain the exact branch, SHAs, commits, validation, limitations, and safety state
  and are read back before completion.

## Deployment Authorization

No deployment is authorized. The branch may be pushed, but it must not be merged,
deployed to the VPS, deployed to Vercel, or used to submit an order in this task.
