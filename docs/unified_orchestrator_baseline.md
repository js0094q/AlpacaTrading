# Unified Orchestrator Baseline

Inspection-only baseline for Section 1. Captured 2026-07-27 from local source at
`71489c4c95d89fff3e3bc492e736a66228f50297`, the matching clean VPS checkout,
bounded PostgreSQL metadata/statistics, sanitized systemd journal output, and local
source inspection. No production code, schema, configuration, or runtime state was
changed.

## Observed runtime warning

The autonomous paper service was already enabled and active; it was not manually
started or restarted. It is not healthy. The five most recent terminal cycles in
the six-hour sample all failed, the two newest at `paper:review` with
`POSTGRES_REVIEW_OPTION_CONTRACT_INVALID`. The worker exits on that fatal command
result and systemd restarts it. The installed unit file matches the repository
file, but the loaded service reports `NoNewPrivileges=no` while the file specifies
`NoNewPrivileges=true`; a daemon reload/restart is required to reconcile that
drift and was intentionally not performed in this inspection phase.

## A. Current control flow

1. `server/systemd/alpaca-autonomous-paper.service` launches
   `scripts/autonomous-paper-worker.mjs` from `/home/alpaca/Alpaca-Trading`.
   `Restart=on-failure` and `RestartSec=30` supervise the process.
2. `assertRuntime`, package-script checks, and
   `config/autonomous-postgres-command-contract.json` require paper mode,
   PostgreSQL authority, scheduler/worker/execution flags, and the approved
   production command set before a cycle starts.
3. The worker runs 20 commands sequentially from `WORKSTREAMS`; there is no
   thread/process concurrency. Each command enters through `src/postgresOnlyCli.ts`
   and the PostgreSQL scheduler registry.
4. `runWithPostgresSchedulerLease` acquires a PostgreSQL lease/fencing token,
   heartbeats it, runs the command, then completes or releases the lease.
5. `research:daily` calls `runPostgresResearchWorkflow`: Alpaca SIP/OPRA REST data
   is refreshed, stored, transformed into features/targets, and ranked candidates
   are classified as `equity`, `standard_option`, `zero_dte_spy`, or `leaps`.
6. `paper:options:discover` refreshes same-day SPY option evidence.
   `paper:review` calls `runPostgresReviewWorkflow` for shared equity/option/LEAPS
   review and writes signed `execution_reviews` and `order_intents`.
7. Portfolio, operations, hedge, and exit-review commands add proposal/order-level
   evidence and guards. The dedicated 0DTE path enters at
   `runZeroDteEngine` in `src/services/zeroDte/zeroDteEngineService.ts`.
8. `paper:execute:reviewed` calls `runAutonomousPostgresExecutionCommand`;
   `assertSafety` and evidence/capacity/identity checks precede
   `submitPaperOrder` in `src/services/alpacaClient.ts`. Submission remains paper
   only and requires `--confirmPaper`.
9. Broker-mutating commands are followed by
   `reconcilePostgresPaperOrders`; it reads Alpaca orders/positions/account state
   and updates order, fill evidence, position, reservation, and lifecycle state.
10. `paper:learn` and `system:recover` finish the loop. Any result not classified
    as blocked, skipped, deferred, or no-action reaches the worker's fatal branch,
    records `workstream_failed` and `cycle_failed`, throws through `main`, and exits
    the process before later commands run.

### External data and persistence interfaces

- Alpaca REST: `src/services/providers/alpaca.ts` retrieves stock bars/snapshots,
  option contracts/chains/latest quotes, and assets.
  `src/services/alpacaClient.ts` retrieves account, clock, positions, orders, and
  activities and is the paper-order submission boundary.
- Streaming: `src/services/alpacaStockStream.ts` optionally subscribes to SIP
  trades, quotes, and bars. `src/services/stockMarketDataAccessor.ts` prefers a
  fresh stream value and falls back to REST. The runtime flag was enabled, but no
  established worker/dashboard stream socket was observed in the snapshot.
- PostgreSQL: `src/lib/database/config.ts` and `postgres.ts` configure the
  TLS-enforced pool. Contracts live in `src/repositories/contracts/`; concrete
  repositories live in `src/repositories/postgres/`. Migrations are
  `src/lib/database/migrations/001` through `006`.
- Retry bounds: Alpaca requests use a bounded request timeout and default maximum
  of two transport retries; pagination rejects repeated/invalid tokens.
  `runWithPostgresRetry` retries only classified transaction-safe
  serialization/deadlock/connection failures within bounded attempts and a
  default five-second deadline. Lease heartbeats and ambiguous broker recovery
  are bounded. The worker does not retry a failed command in-process; systemd
  restarts the whole worker after 30 seconds.

## B. Workstream coupling map

| Lane | Existing entry point | Shared dependencies | Conditions preventing evaluation | Does failure stop other lanes now? |
|---|---|---|---|---|
| Equity | `research:daily` -> `runPostgresResearchWorkflow` -> `persistCandidates` (`strategyFamily=equity`); then shared `paper:review` | Scheduler lease, Alpaca market refresh, PostgreSQL evidence/features/targets, shared review/signing/account/capacity services | Worker preflight; lease/fence; market/evidence freshness; candidate eligibility; review/account/capacity gates | Yes. A fatal `research:daily` or `paper:review` result exits the process before later commands. |
| 0DTE | Generic research family `zero_dte_spy`, plus dedicated `zero-dte:engine` -> `runZeroDteEngine` | SPY SIP context, OPRA contract/quote evidence, account/market clock, execution/reconciliation, worker ordering | Engine disabled; non-paper account; closed market; incomplete provider/context; playbook blockers; paper confirmation; broker/ledger identity guards | Yes. Generic-path failures stop the cycle before the dedicated engine; a fatal engine/reconcile failure stops later work. Some per-underlying/playbook errors are already collected locally. |
| LEAPS | `research:daily` -> `persistCandidates` (`strategyFamily=leaps` using `postgresLeapsPolicy`, default 180-730 DTE); then shared `paper:review` and LEAPS exit policy | Same research/review/order-intent path as equity plus option contracts, OPRA quotes, DTE policy, option lineage | Shared research/review gates; missing/stale option contract or quote; DTE/contract identity; liquidity/spread; capacity and exposure | Yes. LEAPS has no independent top-level command boundary, so shared command failure stops all following workstreams. |

`standard_option` is an existing fourth strategy-family value but is not a
requested orchestrator lane; it currently shares the general options path.

## C. Blocker inventory

Rows group exact reason-code families enforced by one function or boundary.
Screening preferences are distinguished from safety/identity invariants; no
disposition was applied.

| Gate or blocker family | File / function | Scope | Data checked; duplicate check | Failure now | Recommended disposition |
|---|---|---|---|---|---|
| Paper/PostgreSQL runtime authority | `scripts/autonomous-paper-worker.mjs::assertRuntime` | Global | paper/live, DB backend, read/write/control/scheduler/execution flags; repeated at CLI/execution/reconcile | Process exits | Deduplicate shared facts; keep paper/live at every broker execution boundary |
| Production command contract | worker `assertCommandEntry`, `assertCompleteCommandContract` | Global | package scripts, registry, persistence, import graph; unique preflight | Process exits | Keep global preflight |
| Scheduler lease/fence/heartbeat | `postgresSchedulerExecutionService.ts::validateInput`, lease runner | Workstream | owner/run/job, lease expiry and fencing; fence repeated in repositories | Command fails, then worker exits | Keep; centralize duplicate fence assertions |
| Command timeout/runner/output contract | worker `runWorkstream`, `classify` | Workstream | spawn, timeout, exit code, bounded output/JSON | Fatal classes exit worker | Keep bounded process guard; later isolate result to lane |
| Unresolved prior mutation | worker mutation/reconciliation branch | Order/workstream | post-mutation reconciliation status; not duplicated | Later broker mutations blocked, service continues | Keep at mutation boundary |
| Required symbols/underlying | `postgresMarketDataService.ts::refreshPostgresMarketData` | Symbol/lane | nonempty symbols and required option underlyings | Command throws | Keep structural checks; scope failures by symbol/lane |
| Bar/snapshot currentness | same service | Symbol | bar/snapshot presence, completeness, timestamp; rechecked at review/execution | Command throws | Deduplicate freshness calculation; keep final execution check |
| OPRA contract/quote identity and readback | same service | Symbol/contract | feed, underlying, identity, timestamps, fingerprints, persisted readback; repeated in review/execution | Command throws | Deduplicate evidence validator; keep identity at execution |
| Research evidence/fencing/persistence | `postgresResearchWorkflowService.ts::persistEvidence` | Workstream | batch size, fence, row persistence; unique durability check | Research fails, worker exits | Keep durability guard; isolate lane result after shared context exists |
| Learning-model capability | `resolvePostgresLearningModelCapability` | Workstream | PostgreSQL model availability/support | Selected-candidate research fails | Convert unsupported optional learning to bounded evidence/scoring input |
| Candidate eligibility/ranking | `persistCandidates` | Proposal | direction, expression, current option evidence, score/rank/cap; not safety-duplicated | Rejected candidate; empty set becomes no-action downstream | Keep as scoring/eligibility input, never global failure |
| Review signing and artifact integrity | `runPostgresReviewWorkflow`; execution artifact match | Proposal/order | signing key, fingerprint, signature, expiry; rechecked at execution | Command/order throws or blocks | Keep at proposal creation and execution; share validator |
| Option executable evidence | review `assertExecutableOptionReviewEvidence`, `assertObservedOptionContract` | Proposal | contract provenance/identity/current observation; repeated market/execution checks | Entire `paper:review` throws (current failure) | Scope to proposal/lane; deduplicate evidence validator |
| SIP underlying freshness | review `assertFreshAlpacaSipUnderlying`; execution `validateOptionUnderlyingSipEvidence` | Proposal/order | feed, quote/bar receipt and age; duplicated | Review or order throws | One shared evidence rule; keep final order-time freshness |
| Market price/freshness/drift | review workflow; `validateAutonomousExecutionEvidence` | Proposal/order | timestamp, reference/limit price and drift; duplicated intentionally over time | Review/order throws | Share calculation; keep execution-time revalidation |
| Account identity/sizing | review fingerprint checks; execution evidence validator | Proposal/order | broker account, structural fingerprint, quantity/notional | Review/order throws | Share validator; keep execution boundary |
| Capacity/allocation/exposure | review capacity, confirmation promotion, execution | Proposal/order | buying power, reservations, allocations, portfolio caps | Proposal blocked/no intent or order blocked | Keep portfolio/order boundary; future arbitrator should own shared resource decision |
| Duplicate/open exposure | review and execution services | Proposal/order | client/idempotency IDs, existing intents/orders/positions | Proposal/order blocked | Deduplicate query; keep final idempotency/exposure guard |
| Paper confirmation/options/short eligibility | execution `assertSafety` and execution loop | Order | `confirmPaper`, paper execution flags, market open, option flag, shortability | No-action or order throws | Keep exclusively at execution boundary |
| Intent size/limit/position lineage | `validateAutonomousExecutionEvidence` | Order | qty/notional, limit, close quantity, contract/opening lineage | Order throws | Keep at execution boundary |
| Durable submission/ambiguity recovery | autonomous execution submission helpers | Order | attempt record, client ID, broker lookup/result | Rejected or bounded recovery-pending | Keep; never convert broker ambiguity to score |
| Reconciliation identity/quantity/terminal state | `reconcilePostgresPaperOrders` | Order | account/order IDs, statuses, fills, partial quantity, reservation settlement | Per-order errors collected; some persistence errors fail command | Keep; scope individual corrupt order, retain command-level DB outage |
| Confirmed broker absence | reconciliation absence helpers | Order | four observations over at least 120 seconds | Pending until threshold, then terminalized | Keep bounded evidence rule |
| 0DTE engine eligibility | `runZeroDteEngine` | Lane/symbol/proposal | paper account, enabled flag, clock, provider context, playbook | Some errors collected; command can fail | Keep safety gates; scoring/playbook failures should remain proposal outcomes |
| 0DTE broker/ledger equality | `zeroDteExecutionService.ts` validation functions | Order | ledger/decision IDs, broker/client IDs, symbol, semantics, qty/fill state | Order/reconcile error | Deduplicate identities; keep execution/reconciliation boundary |
| Successful empty outcomes | worker `SUCCESSFUL_NO_ACTION_REASON_CODES`, `classify` | Workstream | exact bounded `NO_*` codes | `WORKSTREAM_NO_ACTION`; cycle continues | Keep; map to canonical `no_action` in Section 2 |

No reviewed safety, identity, idempotency, or broker-state gate is recommended
for removal. The main duplication is the same account, market-currentness, option
contract, position, and identity fact being independently reconstructed by market
ingest, review, execution, and reconciliation.

## D. PostgreSQL evidence inventory

Counts are `pg_stat_user_tables.n_live_tup` estimates, not full counts. Date
ranges are approximate `pg_stats` bounds and can lag current inserts. `R/W` names
the principal read/write path; `Decision` is direct, supporting, or audit-only.

| Table | Rows; approximate range | Identifier; important columns | Principal R/W path | Decision |
|---|---|---|---|---|
| `accounts` | 1; current state | `id`; broker/account/environment/status | reconciliation/account repositories | Direct safety identity |
| `account_snapshots` | 210; 2026-07-15..07-24 | `id`, unique account+fingerprint; equity, BP, blocks | reconciliation writes; review/execution read | Direct |
| `research_runs` | 790; 2026-07-05..07-24 stats | `id`, unique workstream+run_key; status/counts/config/summary | research workflow R/W | Direct run context |
| `candidates` | 12,286; 2026-07-02..07-24 | `id`; family/score/confidence/decision/status/signals | research writes; review/learning read | Direct |
| `candidate_lifecycle_events` | 6,046; 2026-07-14..07-15 stats | `event_id`, candidate+sequence/idempotency | research/review/execution lifecycle R/W | Supporting |
| `research_evidence` | 5,607,171; 2026-07-20..07-24 stats | `id`, run+type+source key/fingerprint; payload | research workflow R/W | Direct evidence |
| `universe_symbols` | 51; current state | `symbol`; class/enabled/source/observed_at | market repository R/W | Direct universe |
| `market_data_ingestion_runs` | 7,497; 2026-07-23..07-27 | `id`; type/status/request IDs/counts/pages | market ingest R/W | Supporting freshness/audit |
| `market_bars` | 13,056; 2025-12-10..2026-07-27 | symbol+timeframe+observed_at; OHLCV/source | market ingest writes; features read | Direct |
| `stock_snapshots` | 18,840; observed data current to 07-27 | `id`, evidence fingerprint; feeds/timestamps/evidence | market ingest writes; review reads | Direct |
| `option_contracts` | 135,679; 2026-07-21..07-27 | `option_symbol`; underlying/type/expiry/strike/tradable | option ingest writes; research/review read | Direct |
| `option_snapshots` | 7,975,981; 2026-07-20..07-27 | option+observed_at; bid/ask/trade/Greeks/evidence | option ingest writes; research/review read | Direct |
| `feature_snapshots` | 20,362; 2025-12-10..2026-07-27 | symbol+observed_at; features/source fingerprint | feature workflow R/W | Direct |
| `target_snapshots` | 7,159; 2026-07-22..07-24 stats | symbol+as_of+profile; direction/targets/confidence | target workflow R/W | Direct |
| `options_strategy_snapshots` | 7,512; 2026-07-22..07-24 stats | symbol+as_of+profile; expression/alternatives | target/option strategy R/W | Direct |
| `risk_limits` | 2; current config | `id`; account/scope/limits/fingerprint | review/execution repositories | Direct guard |
| `strategy_allocations` | 2; current config | `id`; strategy/reserved/deployed/config | confirmation/execution/reconcile R/W | Direct |
| `portfolio_exposure` | 108; observed snapshots | `id`, account+fingerprint; gross/net/orders/reserves | portfolio review R/W | Direct |
| `execution_reviews` | 2,763; 2026-07-15..07-24 stats | `id`, payload fingerprint; status/artifact/evidence/blockers | review writes; execution reads | Direct |
| `confirmation_evidence` | 147; 2026-07-15..07-24 | `id`, review+fingerprint; status/evidence/expiry | confirmation/execution R/W | Direct |
| `buying_power_reservations` | 171; 2026-07-07..07-24 | `id`, account+idempotency; amount/status/expiry | confirmation/execution/reconcile R/W | Direct |
| `order_intents` | 2,693; operational history | `id`, account+client/idempotency/fingerprint; order payload/status | review writes; execution/reconcile read/write | Direct proposal |
| `orders` | 75; 2026-07-17..07-24 | `id`, account+client ID; broker/status/qty/fills | execution/reconciliation R/W | Direct |
| `positions` | 44; 2026-07-17..07-24 | `id`, account+broker position; qty/cost/P&L/lineage | reconciliation writes; review/exit read | Direct |
| `broker_events` | 228; 2026-07-17..07-24 | `event_id`; order/intent/type/status/payload | execution/reconciliation writes; audit/recovery read | Supporting |
| `lifecycle_fingerprints` | 2,877; operational history | `id`, unique entity/stage/fingerprint; evidence | lifecycle services R/W | Supporting integrity |
| `autonomous_trade_lifecycle_transitions` | 0 | `id`, intent+idempotency; from/to/operation/evidence | execution lifecycle R/W | Direct when populated |
| `reservation_terminal_transitions` | 49; operational history | `id`, unique reservation; terminal/reason | reconciliation R/W | Supporting |
| `reconciliation_checkpoints` | 36; operational history | `id`, workstream+checkpoint; status/aggregates | reconciliation R/W | Supporting authority |
| `reconciliation_discrepancies` | 537; operational history | `id`; checkpoint/domain/type/evidence | reconciliation writes; health/ops read | Direct health gate |
| `scheduler_leases` | 16; current/expired state | `job_name`; owner/run/fence/heartbeat/expiry | scheduler lease service R/W | Direct control |
| `idempotency_records` | 0 | `id`, unique scope+key; fingerprint/status/result | repository support | Direct when populated |
| `workstream_events` | 10,590; stats through 07-24, live events newer | `event_id`; workstream/type/entity/payload/status | worker state/event repositories R/W | Supporting control/health |
| `workstream_event_failures` | 176; 2026-07-21..07-27 | `id`, event+attempt; classification/retry/error | event processing R/W | Audit/recovery |

There is no separate PostgreSQL `fills` table. Fill evidence is represented by
`orders.filled_quantity`, fill price/time fields, and `broker_events`; position
and realized lifecycle outcomes are represented by `positions`, candidate/order
lifecycle records, and learning projections. Unrelated public tables
`playing_with_neon`, `Game`, `OddsMain`, and `OddsProp` were observed but are not
read by the trading paths and are outside this inventory.

## E. Runtime baseline

Snapshot time: 2026-07-27 11:26-11:28 EDT.

- Host: 2 vCPU; load average `0.55 0.96 1.07`; 2.9 GiB RAM, about 250 MiB used
  and 2.6 GiB available; no swap.
- Worker main process: about 50,976 KiB RSS, 0.2% CPU; active research child:
  about 63,312 KiB RSS, 0.5% CPU. Dashboard process: about 60,016 KiB RSS.
- Disk: 28 GiB filesystem, 13 GiB used, 15 GiB free (47% used).
- PostgreSQL: 30 GiB (`32,237,494,272` bytes). Largest tables:
  `research_evidence` 14 GiB, `option_snapshots` 13 GiB,
  `feature_snapshots` 2,733 MiB, `option_contracts` 175 MiB.
- Cycle duration: latest failed cycles were 962.968s and 964.601s. Recent
  successful cycles on 2026-07-24 were approximately 20-21 minutes. The latest
  research command alone took 903.409s.
- Error rate: five failures among five terminal cycles in the bounded six-hour
  sample (100%); a sixth cycle was in progress. There has been no recorded
  successful full cycle since 2026-07-24T20:30:13.897Z.
- WebSockets: configured stock streaming was enabled in the dashboard process,
  but zero established worker/dashboard TCP stream connections were observed;
  health output did not expose a stream connection metric. Treat connection
  count as snapshot evidence, not proof the feature is disabled.
- Health/observability: `/api/v1/health` reported paper-only PostgreSQL authority,
  a passing latest authority checkpoint, dashboard readiness, and worker-running
  state. JSON worker/journal events and PostgreSQL workstream events provide
  cycle/workstream durations and failure codes. HTTP/process health does not prove
  a successful complete cycle.

## F. Minimal implementation points

| Later capability | Smallest existing integration point |
|---|---|
| Workstream result envelope | **Exact Section 2 starting edit:** adapt the normalized return from `scripts/autonomous-paper-worker.mjs::runWorkstream` and its `workstreamResultIsFatal` branch, while deriving lane identity from existing `strategy_family` at `postgresResearchWorkflowService.ts::persistCandidates` and wrapping the dedicated `runZeroDteEngine` result. Do not change proposal/order-intent schemas. |
| Thin orchestrator | Place a thin coordinator immediately above the existing worker command loop; reuse `runWorkstream`, state persistence, lease-backed commands, and current sequence. Do not add a scheduler. |
| Shared evidence context | Assemble identifiers at `runPostgresResearchWorkflow` after market/evidence persistence and before `persistCandidates`; pass references to lane adapters rather than copying payloads. |
| Scoped execution validator | Extract/reuse the evidence checks currently split between `runPostgresReviewWorkflow` and `validateAutonomousExecutionEvidence`; invoke once per proposal/order at the existing submission boundary. |
| Portfolio resource arbitrator | Insert a decision adapter before confirmation promotion/reservation in `autonomousPostgresExecutionService.ts`, backed by existing `risk_limits`, `strategy_allocations`, `portfolio_exposure`, and reservations. |

The Section 2 constraint is structural: equity and LEAPS currently share both
`research:daily` and `paper:review`, while 0DTE has both a generic candidate family
and a dedicated engine. The result adapter must therefore label existing outputs
without treating one command as one lane. This phase intentionally added no
envelope, orchestrator, validation change, table, migration, or concurrency.
