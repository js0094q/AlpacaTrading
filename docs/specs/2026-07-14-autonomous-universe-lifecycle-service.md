# Autonomous Universe Lifecycle Service

## Goal

Make the bounded equity universe an autonomous, paper-only lifecycle that feeds
the existing paper-trading workflow without adding a broker-mutating path.

The service owns these symbol states:

discovered -> observe_only -> research_eligible -> paper_eligible -> paper_active
-> suspended -> retired

## Verified current state

- The VPS, GitHub main branch, and Vercel production were aligned at
  922664132d0feb32a8b31bdd424b46418a73b6f2 on 2026-07-14.
- The 15-minute Alpaca Market Observatory is a read-only collector for the
  enabled static universe.
- Research, ranking, review, paper execution, monitoring, exits, and learning
  have active scheduled consumers and retain their existing paper-only gates.
- universe_symbols contains static membership and Alpaca asset metadata but has
  no lifecycle state, transition event, autonomous discovery, or daily lifecycle
  timer.
- Existing assets are read through Alpaca Trading API GET /v2/assets with
  status, asset_class, exchange, and attributes metadata. See
  https://docs.alpaca.markets/us/reference/get-v2-assets-1.

## Subsystem completion matrix

This matrix is the release boundary for this task. Closed rows are not reopened
without a Category A production defect or explicit user direction.

| Subsystem | Status for this task | Evidence and downstream consumer |
| --- | --- | --- |
| Observatory | Closed | The read-only 15-minute alpaca-market-observatory timer persists stock snapshots. |
| Research | Closed | paper-ops-morning and review scheduling invoke bounded research automatically. |
| Candidate ranking | Closed | Research persists selected, rejected, skipped, and blocked decisions for review consumption. |
| Review generation | Closed | Scheduled paper review builds guarded reviewed payloads. |
| Paper execution | Closed | Separate paper-only confirmed execution timers retain review, runtime, and confirmation gates. |
| Reconciliation | Closed | Paper and 0DTE reconciliation persist broker-authoritative evidence without synthetic fills. |
| Position monitoring | Closed | Scheduled portfolio and exit review consume reconciled paper positions. |
| Exits | Closed | Reviewed paper exit workflow and 0DTE exit lifecycle are independently scheduled. |
| Learning | Closed | Scheduled learning evaluates evidence and existing ranking consumes learning adjustments for prioritization. Strategy promotion remains separate. |
| Universe lifecycle management | First incomplete subsystem | Membership is static/manual; no autonomous discovery, qualification, or lifecycle evidence exists. |
| Strategy promotion and suspension | Incomplete after this subsystem | Existing analytics are not an automated strategy-policy actuator. It is out of scope here. |
| Recovery and self-healing | Incomplete after this subsystem | The new worker receives local idempotent recovery only; platform-wide recovery remains later work. |

## Desired end state

1. A weekday post-close VPS unit performs a bounded autonomous universe pass.
2. The pass reads Alpaca assets and market data only. It never calls an order,
   position-mutation, account-mutation, or live endpoint.
3. Every lifecycle transition has a local immutable event with a reason code,
   redacted evidence, timestamp, Git SHA, configuration version, and
   configuration hash.
4. The observatory collects discovered and observe_only symbols, while existing
   research and all downstream systems consume only research_eligible,
   paper_eligible, and paper_active symbols.
5. Existing static symbols begin at research_eligible so the current operating
   system has no membership interruption.
6. The service uses existing research, data-quality, execution-quality,
   reconciliation, position, and learning evidence to promote, suspend, or
   retire symbols.

## Scope

Included:

- Bounded authoritative Alpaca US-equity discovery.
- Asset validation for active status, tradability, asset class, approved
  exchange, and options attribute when options are required.
- Historical-bar, price, liquidity, spread, and observation-quality validation.
- Local state, run, and transition persistence.
- Automatic membership handoff to the observatory and the existing research
  pipeline.
- Symbol-level promotion, suspension, retirement, and recovery.
- A dedicated non-executing systemd service and daily timer.
- Focused unit and scheduler tests, documentation, and migration verification.

Excluded:

- New order submission, order replacement, cancellation, account mutation, or
  live trading.
- Changes to paper-review, paper-execution, reconciliation, exit, hedge, or
  0DTE acceptance logic.
- Strategy-family promotion or suspension policy.
- A new Vercel mutation route or dashboard control action.

## Lifecycle policy

### State membership

| State | Observatory | Research and downstream paper workflow | Meaning |
| --- | --- | --- | --- |
| discovered | No | No | Asset was recorded but has not passed metadata admission. |
| observe_only | Yes | No | Asset is eligible for collection and qualification only. |
| research_eligible | Yes | Yes | Existing research and paper gates may consider the symbol. |
| paper_eligible | Yes | Yes | Evidence supports paper consideration; no execution gate is bypassed. |
| paper_active | Yes | Yes | A local reconciled paper position is open for the symbol. |
| suspended | No | No | The symbol failed a documented policy condition. |
| retired | No | No | The symbol is terminally excluded until an explicit future policy changes it. |

### Transition rules

| From | To | Required reason code class |
| --- | --- | --- |
| absent | discovered | DISCOVERED_FROM_ALPACA |
| discovered | observe_only | ASSET_METADATA_ACCEPTED |
| observe_only | research_eligible | OBSERVATION_AND_HISTORY_QUALIFIED |
| research_eligible | paper_eligible | RESEARCH_AND_QUALITY_QUALIFIED |
| research_eligible or paper_eligible | paper_active | RECONCILED_PAPER_POSITION_OPEN |
| paper_active | paper_eligible | RECONCILED_PAPER_POSITION_CLOSED |
| active lifecycle state | suspended | DATA_FAILURE_THRESHOLD, LIQUIDITY_FAILURE_THRESHOLD, ASSET_INELIGIBLE, EXECUTION_QUALITY_FAILURE, or UNDERPERFORMANCE_THRESHOLD |
| suspended | observe_only | RECOVERY_REQUALIFICATION |
| suspended | retired | SUSPENSION_RETIREMENT_THRESHOLD |

The worker may record the initial absent -> discovered and discovered ->
observe_only transitions in one run. It may not skip the immutable events.

### Conservative default policy

The effective policy is environment-configurable and persisted by version and
hash. Defaults are intentionally bounded:

| Setting | Default |
| --- | --- |
| discovery scan window | 250 assets |
| new symbols per run | 10 |
| assessed symbols per run | 80 |
| approved exchanges | AMEX, ARCA, BATS, NASDAQ, NYSE, NYSEARCA |
| minimum price | 5 USD |
| minimum daily dollar volume | 5,000,000 USD |
| maximum spread percent | 2 |
| minimum daily bars | 120 |
| minimum good observations | 3 |
| maximum observation age | 36 hours |
| required selected research decisions | 1 |
| required options attribute | false |
| data, execution, or underperformance failure threshold | 3 |
| suspension retirement threshold | 30 days |

The existing execution gates remain authoritative even when a symbol reaches
paper_eligible. A lifecycle state is not an order authorization.

The lifecycle worker evaluates persisted historical coverage only. The existing
15-minute observatory is the sole automatic collector for `observe_only`
symbols; the lifecycle never invokes market-data ingestion inline.

## Interfaces and persistence

### Database

universe_symbols gains current lifecycle state, reason, entry timestamp,
update timestamp, and lifecycle configuration version. Its enabled field remains
the compatibility projection:

- enabled is 1 only for research_eligible, paper_eligible, and paper_active.
- enabled is 0 for discovered, observe_only, suspended, and retired.

New append-only tables:

- universe_lifecycle_runs records bounded run status, cursor movement, counts,
  errors, Git SHA, configuration version, and configuration hash.
- universe_lifecycle_events records every state transition with redacted
  evidence.

No lifecycle event has a foreign key to universe_symbols so historical evidence
survives an explicit legacy symbol removal.

### Service API

The new universeLifecycleService exports:

- runAutonomousUniverseLifecycle for the daily worker.
- getUniverseLifecycleStatus for read-only CLI and operational inspection.
- dependency injection points for assets, clock, and Git SHA in focused tests.

universeService exports getObservableUniverse and getObservableSymbols in
addition to the existing active-universe API. Existing getActiveSymbols retains
its contract as the research and downstream pipeline input.

### Evidence sources

- Alpaca asset inventory supplies asset class, status, tradability, exchange,
  and options attributes.
- market_bars supplies historical coverage and daily dollar-volume evidence.
- stock_snapshots supplies recent observation count, data quality, price, and
  spread evidence.
- paper_trade_candidates supplies selected research evidence.
- paper_execution_ledger supplies failed, blocked, rejected, or error evidence.
- paper_positions and paper_position_outcomes supply active-position and
  documented-underperformance evidence.
- paper_learning_records supplies evaluated negative learning evidence where it
  exists for the symbol.

Evidence JSON stores only bounded, non-secret summaries. It must not include
credentials, raw broker payloads, account values, or full request headers.

## Scheduling and recovery

- alpaca-universe-lifecycle.service runs as the alpaca user from the VPS repo
  with the existing paper-only environment file and
  AUTOMATED_PAPER_EXECUTION_ENABLED=false.
- alpaca-universe-lifecycle.timer runs weekdays at 16:30 America/New_York,
  after the 16:05 0DTE end-of-day worker and outside the 15-minute observatory
  and paper review windows.
- The daily service is a systemd oneshot. Systemd does not run concurrent
  instances of the same active unit. It has a 120-second start deadline,
  30-second stop deadline, and control-group termination.
- A failed run is recorded as failed and returns nonzero. The timer does not
  replay a missed run on boot. The next normal run is idempotent, resumes from
  the persisted discovery cursor, re-evaluates local evidence, and marks any
  interrupted `running` lifecycle record failed before continuing.
- No timer command includes confirmPaper or an execution command.

## Acceptance criteria

1. A new asset discovered from the injected Alpaca inventory persists both
   discovered and observe_only events and is observable but not research-active.
2. A symbol meeting observation, history, price, liquidity, exchange, and
   asset-policy requirements promotes to research_eligible.
3. A symbol with qualifying research and no quality, execution, or learning
   blocker promotes to paper_eligible without changing execution behavior.
4. Open and closed reconciled paper positions move a symbol into and out of
   paper_active.
5. Repeated documented failures suspend a symbol; a persistent suspension
   retires it; qualified recovery returns a suspended symbol to observe_only.
6. Events include reason code, evidence, timestamp, Git SHA, configuration
   version, and configuration hash.
7. A symbol without sufficient persisted history remains `observe_only` and is
   collected by the observatory without the lifecycle initiating a bar-ingestion
   run.
8. The daily unit has a 120-second start deadline and 30-second stop deadline,
   preventing an interrupted run from overlapping the next lifecycle window.
9. The observatory collects observe_only symbols, while research does not.
10. The systemd unit is non-executing, offset from database-heavy jobs, and
   installed and disabled by the existing scripts.
9. No existing paper execution, live-trading, review, exit, reconciliation, or
   0DTE behavior changes.

## Validation plan

- Run the new focused universe lifecycle test file.
- Run the scheduler contract test.
- Run TypeScript typecheck and lint.
- Run bash -n on changed installer scripts.
- Run systemd-analyze verify on the new service and timer before VPS install.
- Run database migration verification against a copy of the VPS database.
- After deployment, inspect the first service result, lifecycle run/event rows,
  timer status, and paper-only health without submitting any order.

## Deployment authorization and boundaries

The user authorized this paper-only implementation, release, VPS deployment,
and post-deploy validation. This authorization does not authorize a direct
manual paper order or any live order. Deployment must preserve the existing
paper-only flags, SSH posture, UFW, fail2ban, dashboard read-only boundary, and
all existing execution gates.
