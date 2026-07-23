# SQLite Operational State Inventory

Date: 2026-07-15
Status: Release 1 implementation inventory
Verified source baseline: `8cc9fe8431e3676b96a3a904a1256d4aa2dcf21b`

## Scope and counting note

Source inspection finds 55 physical SQLite tables: 54 application-domain tables
plus the shared `schema_migrations` ledger. The requested 54-table inventory is
the application set; this document also classifies `schema_migrations` so no
physical table is omitted.

Schema sources are `src/lib/db.ts`, `src/lib/zeroDteSchema.ts`,
`src/lib/sqliteConcurrencySchema.ts`, and `src/lib/sqliteMigrations.ts`.
Reader entries below list every production module with a direct read reference.
The writer map expands every direct insert, update, and delete statement.

Classifications describe data semantics, not necessarily final placement. Some
append-only or derived evidence moves to PostgreSQL because it participates in
cross-workstream control, reconciliation, risk, or execution lineage.

## SQLite database files and connection ownership

- Repository default: `data/research.db`, selected by `RESEARCH_DB_PATH` when
  present. It is runtime-generated and ignored; no SQLite database file exists
  in the isolated worktree.
- VPS authoritative source: `/home/alpaca/Alpaca-Trading/data/research.db`, owned
  by `alpaca:alpaca`. The long-running dashboard-control service and all
  scheduled CLI workers open independent `node:sqlite` connections through
  `src/lib/db.ts`.
- Protected WAL-test backups:
  `/opt/alpaca-investing/backups/research-before-wal-test-20260715T193021Z.db`
  and `research-before-wal-test-20260715T193346Z.db`, both mode `0400`. The
  first is retained as failed-gate evidence and must not be used for migration;
  the second is the checksum-identical quiesced source backup.
- Retained WAL test copy:
  `/home/alpaca/Alpaca-Trading/data/research-wal-compatibility-20260715T193346Z.db`,
  mode `0400`. It is non-authoritative and must never be selected by
  `RESEARCH_DB_PATH`.

Vercel does not own or mount the VPS SQLite file. Its dashboard routes either
use the VPS bridge or a read-only fallback and cannot make local Vercel SQLite
authoritative.

## Table classification and access inventory

| Table | Readers | Writers | Classification | Target ownership and reason |
|---|---|---|---|---|
| `api_request_log` | none | `apiLog` | APPEND_ONLY | Local SQLite diagnostic evidence |
| `autonomous_recovery_events` | none | `autonomousRecoveryService` | APPEND_ONLY | PostgreSQL workstream/recovery provenance |
| `autonomous_recovery_runs` | `autonomousRecoveryService` | `autonomousRecoveryService` | AUTHORITATIVE | PostgreSQL recovery coordination |
| `backtest_options_trades` | `candidateRankingService` | `backtestService` | DERIVED | Local SQLite replay/backtest output |
| `backtest_runs` | `candidateRankingService` | `backtestService` | DERIVED | Local SQLite backtest output |
| `backtest_trades` | `candidateRankingService` | `backtestService` | DERIVED | Local SQLite replay/backtest output |
| `decision_lifecycle_events` | `marketDecisionEvidenceService`, `marketDecisionTraceService` | `marketDecisionEvidenceService` | APPEND_ONLY | PostgreSQL candidate/execution lifecycle |
| `decision_snapshots` | `hedgePersistenceService`, `marketDecisionEvidenceService`, `marketDecisionTraceService`, `paperLearningLedgerService`, `paperPositionLifecycleService`, `paperReviewArtifactService` | `marketDecisionEvidenceService` | AUTHORITATIVE | PostgreSQL immutable decision evidence |
| `feature_snapshots` | `candidateRankingService`, `featureService` | `featureService` | DERIVED | Local SQLite feature history |
| `hedge_execution_reviews` | `hedgeLearningLifecycleService`, `hedgePersistenceService` | `hedgePersistenceService`, `paperExecutionLedgerService` | AUTHORITATIVE | PostgreSQL execution review state |
| `hedge_learning_events` | `hedgeLearningLifecycleService` | `hedgeLearningLifecycleService` | APPEND_ONLY | PostgreSQL execution-linked lifecycle evidence |
| `ingestion_runs` | `paperPlanService` | `marketDataIngest`, `optionsService`, `stockObservationService` | APPEND_ONLY | Local SQLite ingestion provenance |
| `learning_runs` | `candidateRankingService`, `paperTradeService`, `targetService` | `learningService` | DERIVED | Local SQLite learning traces |
| `market_bars` | `hedgeRecommendationService`, `leapsExitReviewService`, `marketDataIngest`, `paperPlanService`, `paperTradeService`, `portfolioRiskEvidenceService`, `universeLifecycleService` | `marketDataIngest` | CACHE | Local SQLite re-fetchable market history |
| `option_contracts` | `backtestService`, `featureService`, `hedgeRecommendationService`, `leapsExitReviewService`, `optionsDiagnosticService`, `optionsService`, `paperOptionsDiscoveryService`, `paperPlanService`, `paperSubmitStateService`, `portfolioRiskEvidenceService` | `optionsService` | CACHE | Local SQLite provider contract cache |
| `option_snapshots` | `backtestService`, `featureService`, `hedgeRecommendationService`, `leapsExitReviewService`, `paperLearningLedgerService`, `paperOptionsDiscoveryService`, `paperPlanService`, `paperTradeService`, `portfolioRiskEvidenceService` | `optionsService` | CACHE | Local SQLite provider snapshot cache |
| `options_strategy_snapshots` | `candidateRankingService` | `targetService` | DERIVED | Local SQLite scoring/strategy traces |
| `paper_execution_ledger` | `leapsExitReviewService`, `marketDecisionTraceService`, `paperExecutionLedgerService`, `paperPositionLifecycleService`, `universeLifecycleService`, `zeroDteActivityEvidenceService`, `zeroDteExecutionService` | `paperExecutionLedgerService`, `zeroDteExecutionService`, `zeroDteExitService` | AUTHORITATIVE | PostgreSQL order intents, reservations, orders, and broker evidence |
| `paper_learning_governance_decisions` | `learningGovernanceService` | `learningGovernanceService` | AUTHORITATIVE | PostgreSQL cross-workstream governance state |
| `paper_learning_governance_runs` | `learningGovernanceService` | `autonomousRecoveryService`, `learningGovernanceService` | AUTHORITATIVE | PostgreSQL scheduled governance control state |
| `paper_learning_records` | `hedgePersistenceService`, `leapsExitReviewService`, `learningGovernanceService`, `marketDecisionTraceService`, `paperExitReviewService`, `paperLearningLedgerService`, `paperPlanService`, `universeLifecycleService` | `hedgePersistenceService`, `paperLearningLedgerService` | DERIVED | PostgreSQL because governance consumes it across workstreams |
| `paper_operation_log` | `autonomousRecoveryService`, `paperOperationLogService` | `autonomousRecoveryService`, `paperOperationLogService` | APPEND_ONLY | PostgreSQL workstream audit and reconciliation evidence |
| `paper_position_observation_links` | `marketDecisionTraceService`, `paperPositionLifecycleService` | `paperPositionLifecycleService` | APPEND_ONLY | PostgreSQL immutable execution/outcome linkage |
| `paper_position_observations` | `marketDecisionTraceService`, `paperPositionLifecycleService` | `paperPositionLifecycleService` | APPEND_ONLY | PostgreSQL canonical position-outcome evidence |
| `paper_position_outcome_revisions` | `marketDecisionTraceService`, `paperPositionLifecycleService`, `zeroDteActivityEvidenceService` | `paperPositionLifecycleService` | APPEND_ONLY | PostgreSQL corrections audit |
| `paper_position_outcomes` | `marketDecisionTraceService`, `paperPositionLifecycleService`, `universeLifecycleService`, `zeroDteActivityEvidenceService` | `paperPositionLifecycleService` | DERIVED | PostgreSQL cross-workstream execution/risk projection |
| `paper_positions` | `hedgePersistenceService`, `marketDecisionTraceService`, `paperPortfolioReviewService`, `paperPositionLifecycleService`, `paperReviewArtifactService`, `universeLifecycleService`, `zeroDteActivityEvidenceService` | `paperPositionLifecycleService` | AUTHORITATIVE | PostgreSQL canonical attributed position state |
| `paper_recommendation_snapshots` | `paperRecommendationSnapshotService`, `paperTrendsService` | `paperOutcomeAnalyticsService` | DERIVED | Local SQLite recommendation history |
| `paper_reconciliation_events` | `paperAccountReconciliationService` | `paperAccountReconciliationService` | APPEND_ONLY | PostgreSQL reconciliation checkpoints/evidence |
| `paper_review_artifacts` | `leapsExitReviewService`, `marketDecisionTraceService`, `paperReviewArtifactService` | `paperReviewArtifactService` | AUTHORITATIVE | PostgreSQL signed confirmation evidence |
| `paper_review_decisions` | `marketDecisionTraceService`, `paperReviewArtifactService` | `marketDecisionEvidenceService` | AUTHORITATIVE | PostgreSQL review-to-decision linkage |
| `paper_trade_candidates` | `db`, `candidateRankingService`, `paperExecutionLedgerService`, `paperOutcomeAnalyticsService`, `paperPlanService`, `paperPortfolioReviewService`, `paperReviewArtifactService`, `paperRuntimeService`, `paperSubmitStateService`, `paperTradeService`, `universeLifecycleService` | `db`, `candidateRankingService` | AUTHORITATIVE | PostgreSQL candidate lifecycle |
| `paper_trade_evaluations` | `paperOutcomeAnalyticsService` | `paperTradeService` | DERIVED | Local SQLite scoring/skipped-trade evidence |
| `paper_trade_plans` | `paperTradeService` | `paperTradeService` | AUTHORITATIVE | PostgreSQL mutable reviewed planning state |
| `portfolio_beta_cache` | `hedgePersistenceService` | `hedgePersistenceService` | CACHE | Local SQLite re-computable cache |
| `portfolio_high_water_marks` | `hedgePersistenceService` | `hedgePersistenceService` | AUTHORITATIVE | PostgreSQL portfolio risk input |
| `research_runs` | `candidateRankingService`, `optionsService`, `paperOutcomeAnalyticsService`, `paperPlanService`, `paperPortfolioReviewService`, `paperRuntimeService`, `paperTradeService`, `researchRunLifecycleService` | `researchRunLifecycleService` | AUTHORITATIVE | PostgreSQL research-run control state |
| `runtime_write_leases` | `sqliteWriteLeaseService` | `sqliteWriteLeaseService` | AUTHORITATIVE | Replaced by PostgreSQL scheduler leases/fencing |
| `stock_snapshots` | `stockObservationService`, `universeLifecycleService` | `stockObservationService` | APPEND_ONLY | Local SQLite raw research observation |
| `target_snapshots` | `paperPlanService`, `paperTradeService`, `targetService` | `targetService` | DERIVED | Local SQLite signal/target history |
| `universe_lifecycle_events` | `universeLifecycleService` | `universeLifecycleService` | APPEND_ONLY | PostgreSQL universe/workstream lifecycle evidence |
| `universe_lifecycle_runs` | `universeLifecycleService` | `autonomousRecoveryService`, `universeLifecycleService` | AUTHORITATIVE | PostgreSQL scheduled-work control state |
| `universe_symbols` | `universeLifecycleService`, `universeService` | `universeLifecycleService`, `universeService` | AUTHORITATIVE | PostgreSQL enabled/tradable universe state shared by workstreams |
| `zero_dte_candidate_observations` | `zeroDteEngineService` | `zeroDtePersistenceService` | APPEND_ONLY | PostgreSQL decision evidence used by execution lifecycle |
| `zero_dte_candidates` | `zeroDteEngineService`, `zeroDteExecutionService`, `zeroDteLifecycleService`, `zeroDteOutcomeService`, `zeroDtePersistenceService` | `zeroDteEngineService`, `zeroDteExecutionService`, `zeroDtePersistenceService` | AUTHORITATIVE | PostgreSQL candidate lifecycle |
| `zero_dte_configuration_versions` | none | `zeroDteEngineService` | APPEND_ONLY | PostgreSQL execution-configuration evidence |
| `zero_dte_decisions` | `zeroDteEngineService`, `zeroDteExecutionService`, `zeroDteExitService`, `zeroDteLifecycleService`, `zeroDteShadowService` | `zeroDteLifecycleService` | AUTHORITATIVE | PostgreSQL execution decision state |
| `zero_dte_engine_runs` | `zeroDteEngineService`, `zeroDteExitService`, `zeroDteLifecycleService`, `zeroDteShadowService` | `zeroDteEngineService` | AUTHORITATIVE | PostgreSQL run/scheduler state |
| `zero_dte_lifecycle_events` | `zeroDteEngineService`, `zeroDteExecutionService`, `zeroDteExitService`, `zeroDteLifecycleService`, `zeroDtePersistenceService`, `zeroDteShadowService` | `zeroDteLifecycleService` | APPEND_ONLY | PostgreSQL candidate/order lifecycle |
| `zero_dte_paper_trades` | `zeroDteSchema`, `zeroDteActivityEvidenceService`, `zeroDteEngineService`, `zeroDteExecutionService`, `zeroDteExitService`, `zeroDteLifecycleService` | `zeroDteEngineService`, `zeroDteExecutionService`, `zeroDteExitService` | AUTHORITATIVE | PostgreSQL paper order/trade state |
| `zero_dte_playbook_evaluations` | none | `zeroDtePersistenceService` | APPEND_ONLY | PostgreSQL decision evidence |
| `zero_dte_position_marks` | `zeroDteEngineService` | `zeroDteEngineService`, `zeroDteShadowService` | APPEND_ONLY | PostgreSQL risk/exit evidence |
| `zero_dte_shadow_trades` | `zeroDteSchema`, `zeroDteEngineService`, `zeroDteLifecycleService`, `zeroDteOutcomeService`, `zeroDteShadowService` | `zeroDteShadowService` | DERIVED | Local SQLite shadow decisions |
| `zero_dte_terminal_outcomes` | `zeroDteSchema`, `zeroDteExitService`, `zeroDteOutcomeService` | `zeroDteExitService`, `zeroDteOutcomeService` | DERIVED | PostgreSQL because activity/risk projections consume it |
| `schema_migrations` | migration/status/verification modules | `sqliteMigrations` | AUTHORITATIVE | Per-database ledger; PostgreSQL receives its own independent ledger |

Classification totals across all 55 physical tables:

- AUTHORITATIVE: 21
- APPEND_ONLY: 17
- DERIVED: 13
- CACHE: 4
- TRANSIENT: 0
- OBSOLETE: 0

Placement is intentionally stricter than classification: 38 tables, including
the PostgreSQL migration ledger, move to PostgreSQL because they are
authoritative or participate in cross-workstream control, execution, risk,
lifecycle, or reconciliation. Seventeen remain eligible for local SQLite.

## Complete SQLite writer map

`I` is insert, `II` is insert-or-ignore, `U` is update, and `D` is delete.
Line numbers refer to the verified source baseline and may move mechanically as
the migration implementation lands.

```text
src/lib/db.ts
  U paper_trade_candidates:1127 (Phase 1B explicit migration only)
  U paper_trade_plans:1136 (Phase 1B exact-candidate backfill only)
  U paper_trade_evaluations:1137 (Phase 1B exact-candidate backfill only)
  U paper_execution_ledger:1138 (Phase 1B exact-candidate backfill only)
  U paper_learning_records:1139 (Phase 1B exact-candidate backfill only)

src/lib/sqliteMigrations.ts
  I schema_migrations:66

src/services/apiLog.ts
  I api_request_log:27

src/services/autonomousRecoveryService.ts
  I autonomous_recovery_events:131
  U universe_lifecycle_runs:156
  U paper_learning_governance_runs:173
  U paper_operation_log:190
  I autonomous_recovery_runs:216
  U autonomous_recovery_runs:308,343

src/services/backtestService.ts
  I backtest_runs:415
  U backtest_runs:694
  I backtest_trades:702
  I backtest_options_trades:733

src/services/candidateRankingService.ts
  I paper_trade_candidates:663

src/services/featureService.ts
  I feature_snapshots:422

src/services/hedgeLearningLifecycleService.ts
  I hedge_learning_events:131

src/services/hedgePersistenceService.ts
  I portfolio_high_water_marks:609
  I portfolio_beta_cache:645
  I paper_learning_records:745,1072
  U paper_learning_records:1060
  I hedge_execution_reviews:1189
  U hedge_execution_reviews:1363

src/services/learningGovernanceService.ts
  I paper_learning_governance_runs:423
  U paper_learning_governance_runs:491,535
  U paper_learning_governance_decisions:464
  I paper_learning_governance_decisions:469

src/services/learningService.ts
  I learning_runs:218

src/services/marketDataIngest.ts
  I ingestion_runs:20
  U ingestion_runs:43
  I market_bars:96

src/services/marketDecisionEvidenceService.ts
  I decision_snapshots:144
  I decision_lifecycle_events:240
  II paper_review_decisions:265

src/services/optionsService.ts
  I ingestion_runs:47
  U ingestion_runs:74
  I option_contracts:192
  I option_snapshots:305

src/services/paperAccountReconciliationService.ts
  I paper_reconciliation_events:385

src/services/paperExecutionLedgerService.ts
  I paper_execution_ledger:252
  U paper_execution_ledger:375,420
  U hedge_execution_reviews:703

src/services/paperLearningLedgerService.ts
  I paper_learning_records:310
  U paper_learning_records:424,453,497,510

src/services/paperOperationLogService.ts
  I paper_operation_log:86
  U paper_operation_log:148

src/services/paperOutcomeAnalyticsService.ts
  I paper_recommendation_snapshots:610

src/services/paperPositionLifecycleService.ts
  U paper_positions:140,403,485
  I paper_positions:202
  I paper_position_observations:327
  II paper_position_observation_links:389
  I paper_position_outcomes:732
  I paper_position_outcome_revisions:814

src/services/paperReviewArtifactService.ts
  I paper_review_artifacts:336

src/services/paperTradeService.ts
  I paper_trade_plans:343
  I paper_trade_evaluations:480
  U paper_trade_plans:500

src/services/researchRunLifecycleService.ts
  U research_runs:64,218,241,269,299
  I research_runs:183

src/services/sqliteWriteLeaseService.ts
  U runtime_write_leases:97,146
  I runtime_write_leases:103
  D runtime_write_leases:181

src/services/stockObservationService.ts
  I stock_snapshots:61
  I ingestion_runs:156
  U ingestion_runs:174,199

src/services/targetService.ts
  I target_snapshots:75
  I options_strategy_snapshots:197

src/services/universeLifecycleService.ts
  U universe_symbols:278,323,345
  I universe_symbols:380
  I universe_lifecycle_events:243
  I universe_lifecycle_runs:438
  U universe_lifecycle_runs:464,482

src/services/universeService.ts
  U universe_symbols:166,213,283
  I universe_symbols:176,335
  D universe_symbols:188

src/services/zeroDte/zeroDteEngineService.ts
  II zero_dte_configuration_versions:254
  II zero_dte_engine_runs:277
  U zero_dte_engine_runs:331
  I zero_dte_position_marks:780
  U zero_dte_paper_trades:804
  U zero_dte_candidates:1156

src/services/zeroDte/zeroDteExecutionService.ts
  U paper_execution_ledger:801,1512,2145
  U zero_dte_paper_trades:1060,1307,1318,1337,2268,2300,2318
  U zero_dte_candidates:1707
  II zero_dte_paper_trades:2213

src/services/zeroDte/zeroDteExitService.ts
  U paper_execution_ledger:366
  I zero_dte_terminal_outcomes:634
  U zero_dte_paper_trades:706,884,910

src/services/zeroDte/zeroDteLifecycleService.ts
  I zero_dte_decisions:462
  I zero_dte_lifecycle_events:536

src/services/zeroDte/zeroDteOutcomeService.ts
  I zero_dte_terminal_outcomes:345
  U zero_dte_terminal_outcomes:354

src/services/zeroDte/zeroDtePersistenceService.ts
  I zero_dte_candidates:659
  I zero_dte_candidate_observations:856
  I zero_dte_playbook_evaluations:924

src/services/zeroDte/zeroDteShadowService.ts
  U zero_dte_shadow_trades:452,691
  I zero_dte_shadow_trades:539
  II zero_dte_position_marks:599
```

## Transaction and runtime-DDL inventory

| Transaction family | Lock form | Scope and external-work finding |
|---|---|---|
| Explicit schema migrations | `BEGIN IMMEDIATE` | DDL/backfill loops only under `db:migrate`; ordinary runtime never invokes them |
| Option contract/snapshot batches | `BEGIN IMMEDIATE` | 250 normalized rows maximum; network and normalization occur before transaction |
| Research reservation, recovery, heartbeat/final writes | `BEGIN IMMEDIATE` or autocommit | No network/sleep/file I/O; stale-row recovery loop is not SQL-limited |
| SQLite heavy-write lease acquire/renew/release | `BEGIN IMMEDIATE` | Short; retry delay occurs only after rollback |
| Execution-ledger reservation | `BEGIN IMMEDIATE` | No Alpaca call inside; loops over supplied reviewed payloads |
| Universe lifecycle state | `BEGIN IMMEDIATE` | One-symbol transaction; Alpaca discovery is outside |
| Autonomous recovery | `BEGIN IMMEDIATE` | Four stale-row/event loops, currently unbounded; no network/file I/O |
| Learning governance | `BEGIN IMMEDIATE` | Scoring is outside; at most 100 symbol scopes plus fixed strategy scopes |
| 0DTE engine persistence | `BEGIN IMMEDIATE` | Market fetch/scoring outside; configured batch is not hard-capped in source |
| 0DTE outcome and shadow marking | `BEGIN IMMEDIATE` | Candidate-by-horizon/open-trade loops are unbounded; no external call inside |
| 0DTE lifecycle/execution/exit persistence | `BEGIN IMMEDIATE` | Broker requests precede persistence; no network/sleep/file I/O inside |

Explicit transaction owners at the verified baseline are:

- `src/lib/sqliteMigrations.ts`: one migration-group `BEGIN IMMEDIATE`
- `src/services/autonomousRecoveryService.ts`: one recovery transaction
- `src/services/featureService.ts`: one deferred feature persistence transaction
- `src/services/learningGovernanceService.ts`: one governance transaction
- `src/services/optionsService.ts`: contract and snapshot batch transactions
- `src/services/paperExecutionLedgerService.ts`: reviewed reservation transaction
- `src/services/researchRunLifecycleService.ts`: stale recovery, reservation, and
  active-run final persistence transactions
- `src/services/sqliteWriteLeaseService.ts`: acquire, renew, and release transactions
- `src/services/universeLifecycleService.ts`: discovery, transition, and
  reconciliation transactions
- `src/services/zeroDte/zeroDteLifecycleService.ts`: lifecycle wrapper
- `src/services/zeroDte/zeroDteOutcomeService.ts`: outcome wrapper
- `src/services/zeroDte/zeroDtePersistenceService.ts`: engine persistence wrapper
- `src/services/zeroDte/zeroDteShadowService.ts`: shadow persistence wrapper

The `BEGIN` tokens in `src/lib/zeroDteSchema.ts` are trigger-body delimiters,
not application-opened transactions.

No runtime transaction was found spanning Alpaca, market-data, HTTP, sleep,
retry delay, or file operations. Residual transition lock-duration risks are the
unbounded recovery, outcome, shadow-mark, and configurable 0DTE engine loops.
PostgreSQL migration removes their shared authoritative writer dependency; it
must not reproduce those loops inside long PostgreSQL transactions.

All SQLite DDL is reachable through `initializeDatabaseHandle` and
`runMigrationGroup`. `db:migrate` is the explicit production writer.
`db:verify` opens read-only. Ordinary runtime performs only connection PRAGMAs
and migration-ledger reads and now rejects both empty and pending schemas. It
also refuses a missing path before creating a directory or empty database file.
Test-only scratch initialization requires the explicit
`tests/helpers/enableSqliteFixtureInitialization.mjs` runner preload. No
environment variable enables runtime DDL.

Connection policy during transition:

- `PRAGMA foreign_keys = ON`
- bounded `PRAGMA busy_timeout`, default 5,000 ms and capped at 30,000 ms
- journal mode is observed, not forced
- production currently reports DELETE mode
- retry defaults: four attempts, 25 ms base delay, 1,000 ms maximum delay,
  20% jitter, and 5,000 ms total deadline; attempts are capped at eight and the
  deadline at 30,000 ms
- both base and extended numeric/string/message forms of `SQLITE_BUSY` and
  `SQLITE_LOCKED` are classified explicitly
- retry call sites are limited to research lifecycle writes, option ingestion
  completion/batches, lease maintenance, and explicitly retry-safe 0DTE work

## Scheduler ownership inventory

Every unit runs as `alpaca`, uses `/home/alpaca/Alpaca-Trading`, and loads the
protected VPS environment file. The dashboard-control service is unscheduled
but is also a possible SQLite reader/writer/command dispatcher.

| Schedule | Workstream | SQLite | Current process-local ownership |
|---|---|---|---|
| 08:30 weekdays | morning learning/governance/research/options/review | read/write | none |
| 09:00-15:45 every 15m | observatory | read/write | `/tmp/alpaca-market-observatory.lock` |
| every 30m | review | read/write | `/tmp/alpaca-paper-monitor-review.lock` |
| every 30m | reviewed entry execution | read/write capable, paper-gated | `/tmp/alpaca-paper-monitor-execute.lock` |
| every 15m then 5m | exit review/late-day review | read/write | `/tmp/alpaca-paper-monitor-exit-review.lock` |
| every 15m then 5m | reviewed exit execution | read/write capable, paper-gated | `/tmp/alpaca-paper-monitor-exit-execute.lock` |
| 12:10 weekdays | midday portfolio/hedge review | read/write | none |
| 15:25 weekdays | late-day forced-exit/hedge review | read/write | none |
| every minute in window | 0DTE engine | read/write, paper execution gated | `/tmp/alpaca-zero-dte-engine.lock` |
| every minute | 0DTE exit review | read/write | `/tmp/alpaca-zero-dte-exit-review.lock` |
| every five minutes | 0DTE reconciliation | read/write | `/tmp/alpaca-zero-dte-reconcile.lock` |
| 16:05 weekdays | 0DTE EOD | read/write | `/tmp/alpaca-zero-dte-eod.lock` |
| 16:30 weekdays | universe lifecycle | read/write | none |
| :07/:22/:37/:52 | autonomous recovery | read/write | none |

The nine monitor locks use exclusive local lock-file creation and prevent only a
duplicate of the same task on one host. They do not coordinate different jobs,
Vercel, future workers, restarts, or stale owners. The SQLite
`runtime_write_leases` row protects only research option persistence and the
0DTE engine batch. PostgreSQL scheduler leases with fencing replace both as
authoritative ownership during Release 3.

## WAL compatibility decision gate

The repository contains a copy-only verifier that refuses source/copy identity,
checks source preservation, creates and checkpoints WAL sidecars, exercises a
concurrent reader/writer, validates online backup, simulates process termination,
and runs integrity/foreign-key checks without emitting row data.

The production decision also requires evidence from a copy on the same VPS
filesystem/device as the live database:

- filesystem type, mount options, block device, and Btrfs/RBD/remote-storage facts
- sidecar lifecycle and sidecar-aware backup/restore behavior
- FULL-synchronous commit and checkpoint latency
- uncommitted rollback and committed-but-uncheckpointed recovery after termination
- migration-twice and schema verification on the copy
- synthetic overlapping reader/writer shapes only; no broker command

### VPS copied-database result

The first quiesce attempt correctly failed closed before WAL mutation because a
raw protected copy did not match the pre-copy checksum. Timers and dashboard
control were restored automatically. The file size changed during that attempt,
proving that an initial timer stop plus immediate service check was not a
sufficient read-consistency boundary.

The second attempt added an explicit stop for all timer, service, and dashboard
units, verified zero Node workers, ran read-only schema verification, and
required the source checksum to remain unchanged for a stability interval. It
then created a checksum-identical protected backup at mode `0400`.

On a same-filesystem Btrfs volume backed by `/dev/rbd0`, the copied database
passed:

- source and pre-mutation copy checksum equality
- WAL and shared-memory sidecar creation
- consistent concurrent reader plus committed writer behavior
- FULL-synchronous commit in 67 ms
- truncating checkpoint in 49 ms
- SQLite online backup and restored integrity
- rollback of an uncommitted SIGKILL child
- survival of a committed, uncheckpointed SIGKILL child
- zero foreign-key violations and `integrity_check=ok`
- explicit SQLite migration twice and schema verification
- source checksum preservation and source journal mode remaining DELETE
- retained WAL test copy at mode `0400`
- restoration of the five previously active timers and dashboard control

### Journal decision

Retain DELETE mode during the PostgreSQL transition. The copied database proves
that WAL mechanics work on this storage, but the repository has no automated,
sidecar-aware production backup/restore path. The failed first raw-copy attempt
also demonstrates that a merely stopped timer set is not a sufficient backup
boundary. Adopting WAL would therefore add sidecar and checkpoint obligations
without removing the single-writer limit or providing distributed ownership.
The bounded PostgreSQL migration is the safer contention solution. The source
database was not altered and live trading remained disabled.

## Root cause

The shared SQLite file offers one writer slot to many independent scheduled
workstreams. The observed research heartbeat failed after options persistence
while the closest proven competing scope was the scheduled 0DTE
`BEGIN IMMEDIATE` persistence batch. The historical lock-holder PID and exact
hold duration were not logged, so they are not inferred. Process-local task
locks and one narrow SQLite lease do not provide global or distributed writer
coordination. Retries reduce transient failures but cannot make reservations,
allocation, scheduler ownership, or cross-workstream state atomic.
