# 0DTE Level 2 Engine

Date: 2026-07-13
Status: approved design; implementation pending
Initial design checkpoint: branch `0DTE` at `a9d8e60`
Implementation baseline after the resolved paper-exit cherry-pick: `main` at `d4431f9`

## Goal

Add an integrated, standalone 0DTE Level 2 paper-trading domain that maintains a continuous ranked candidate queue, attributes signals to five playbooks, records immutable decisions and lifecycle events, simulates shadow alternatives, manages paper positions, and produces learning outcomes.

The engine must operate independently of the Market Observatory while preserving the existing observatory, equity, hedge, LEAPS, and legacy paper-option workflows.

## Verified current state

- The repository is a TypeScript CLI with local SQLite persistence and VPS systemd scheduling.
- Existing 0DTE support covers explicit SPY discovery, paper planning, execution validation, and late-day exit review. It does not provide a standalone minute-level engine or the Level 2 lifecycle model.
- Paper execution already has account/runtime gates, option validation, a paper-only Alpaca client, deterministic ledger support, and duplicate checks. The new domain must reuse these controls rather than bypassing them.
- The current approved 0DTE exit behavior is 50% stop/target outside the final two hours, 25% stop/target in the final two hours, and forced sell-to-close during the final 30 minutes when the contract remains sellable. The new engine will call the existing exit policy.
- The working tree contains an unrelated existing modification to `docs/superpowers/plans/2026-07-10-guarded-paper-hedge-execution.md`. It is outside this feature and must remain untouched.

## Desired end state

The new flow is:

```text
session gate
  -> direct intraday market snapshot and bars
  -> same-session contract discovery and quote normalization
  -> five independent playbook evaluations
  -> candidate upsert and signal observation
  -> deterministic ranked queue
  -> immutable decision and lifecycle capture
  -> paper selection or structured skip/reject
  -> paper position review or isolated shadow trade
  -> marks, exits, terminal outcomes, and learning summary
```

The engine never requires a completed Market Observatory run. Observatory data may be included as optional context when fresh, but missing Observatory data cannot be the reason the engine refuses to start.

## Scope

### Included

- A dedicated `src/services/zeroDte/` domain boundary.
- Direct market-clock, underlying quote/bar, option-contract, and option-quote adapters built on existing Alpaca client/provider conventions.
- Additive, idempotent SQLite schema and migration registration.
- Stable candidate identity and current-state upsert behavior.
- Candidate observations, signal slopes, state transitions, deterministic queue ranking, and structured reasons.
- Trend continuation, reversal, breakout, gamma-proxy, and volatility-expansion playbooks.
- Conservative paper entry selection, deterministic order IDs, execution reservations, and reuse of existing paper-only order submission controls.
- Reuse of existing 0DTE exit rules with new Level 2 decision and lifecycle evidence.
- Isolated shadow positions with conservative entry/exit fill assumptions.
- Forward outcome capture for missed candidates and terminal outcome capture for paper and shadow trades.
- CLI commands, systemd timer/service definitions, VPS runner integration, and a read-only dashboard section.
- Focused tests and bounded local/runtime validation.

### Not included

- Live trading, live credentials, live routes, or live account changes.
- Removal or replacement of the Market Observatory, hedge, equity, or LEAPS systems.
- Dealer-gamma claims, event inference, or fabricated Greeks when source data is unavailable.
- Automatic tuning or promotion of thresholds from learning results.
- Sub-minute REST polling or a new streaming infrastructure.
- Dashboard order-submission controls.
- Destructive migrations or deletion of existing paper records.

## Domain boundary and modules

Use `src/services/zeroDte/` to keep the feature isolated while following the repository's existing service and CLI conventions.

Expected modules:

- `zeroDteTypes.ts`: domain types, states, playbooks, reason codes, lifecycle events, and provider contracts.
- `zeroDteConfigService.ts`: validated environment parsing and configuration fingerprints.
- `zeroDteMarketDataService.ts`: session validation, direct underlying data, bar aggregation, contract discovery, and quote normalization.
- `zeroDtePlaybookService.ts`: pure playbook evaluators and structured evidence.
- `zeroDteCandidateService.ts`: candidate identity, upsert state transitions, observations, slopes, and queue ranking.
- `zeroDtePersistenceService.ts`: query/write operations and dashboard read models.
- `zeroDteExecutionService.ts`: eligibility gates, reservation, paper payload construction, and paper-only submission linkage.
- `zeroDteExitService.ts`: open-position review and reuse of existing 0DTE exit policy.
- `zeroDteShadowService.ts`: shadow entry, marking, conservative fills, MFE/MAE, and terminal closure.
- `zeroDteLifecycleService.ts`: append-only events, immutable decisions, and structured reason evidence.
- `zeroDteOutcomeService.ts`: missed-opportunity horizons, production outcomes, and daily learning summary.
- `zeroDteEngineService.ts`: cycle orchestration and non-overlap handling.

Pure scoring and ranking functions must be usable without a broker or database so focused tests can use deterministic fixtures.

## Identity and persistence

### Candidate identity

There is one logical candidate per:

```text
trading date + underlying + option symbol + playbook + direction + expiration + strike
```

The canonical identity string is hashed into a stable `candidate_id`. Repeated minute-level observations update the same candidate. Different playbooks remain separately attributable even when they select the same contract and direction.

### Configuration identity

Each engine run stores:

- `strategy_version`;
- `configuration_version_id`;
- a canonical configuration hash;
- scoring weights, thresholds, session windows, liquidity limits, risk limits, and execution flags.

The hash must be calculated from normalized configuration values, not raw environment ordering.

### Additive tables

Register a migration version such as `2026-07-13-zero-dte-level-2` through the repository's existing SQLite initialization/migration path. The migration is transactional, idempotent, foreign-key aware, and non-destructive.

Create these logical entities, consolidating only when the resulting fields remain queryable:

- `zero_dte_engine_runs`: run status, session, timestamps, counts, error summary, configuration identity, and paper-account verification.
- `zero_dte_candidates`: stable identity, contract fields, current state, current scores, current quote, first/last seen, state reason, and timestamps.
- `zero_dte_candidate_observations`: chronological market/signal snapshots, score changes, short/medium slopes, peak/drawdown, data-quality flags, and setup age.
- `zero_dte_playbook_evaluations`: one row per candidate-playbook evaluation with score, confidence, direction, eligibility, blockers, missing inputs, and structured evidence.
- `zero_dte_decisions`: immutable decision identity, decision group, candidate, applied thresholds, account mode, source timestamps, action, and reason codes.
- `zero_dte_lifecycle_events`: append-only event stream with event type, reason code, detail, and linked decision/candidate/trade IDs.
- `zero_dte_paper_trades`: intended/submitted/fill/exit linkage, premium, fees, slippage, MFE, MAE, realized P&L, and terminal state.
- `zero_dte_shadow_trades`: simulated entry/mark/exit, fill assumptions, fees, MFE, MAE, P&L, and linked decision group.
- `zero_dte_position_marks`: chronological paper/shadow marks and quote quality.
- `zero_dte_terminal_outcomes`: immutable terminal outcome record, including production and missed-opportunity horizons.
- `zero_dte_configuration_versions`: canonical configuration payload, hash, strategy version, and creation timestamp.

Core fields are typed columns. JSON is reserved for flexible evidence, supporting/opposing signal arrays, raw-but-redacted provider metadata, and configuration payloads. Add indexes for trading date, current state, candidate, decision group, open trades, option symbol, and event timestamp.

## Candidate queue and signal tracking

Candidate states include:

`discovered`, `watching`, `strengthening`, `stable`, `weakening`, `eligible`, `selected`, `executed`, `shadowed`, `skipped`, `rejected`, `expired`, `invalidated`, and `closed`.

Every state transition stores its timestamp and structured reason. A state transition is not inferred only from the latest score; it is persisted as an event and remains auditable.

The active queue exposes rank, candidate identity, contract, playbook, direction, total score, component scores, confidence, signal slope, age, quote, spread, volume, open interest, IV, available Greeks, premium, state, and blockers.

Ranking is deterministic:

1. executable/eligible candidates first;
2. total score descending;
3. short-window slope descending;
4. liquidity score descending;
5. freshness descending;
6. spread ascending;
7. stable candidate ID ascending as the final tie-breaker.

Signal configuration defaults are short window `3`, medium window `5`, minimum confirmation observations `2`, and a non-zero minimum score movement. A candidate is classified as strengthening or weakening only when movement exceeds that configured minimum.

Candidates expire or invalidate for stale quotes, untradable contracts, entry cutoff, score floor, lost playbook conditions, maximum age, duplicate exposure, or daily/portfolio restrictions. The exact reason code is persisted.

When a previously weakened, expired, or invalidated setup returns above the configured score/data-quality floor, append `candidate_reappeared`, increment its reappearance count, and transition it back to `watching` or `strengthening` with the new evidence. Reappearance must not create a second logical candidate row.

## Market data and playbooks

The market-data adapter must:

- validate the exchange session using the existing market-clock/calendar conventions;
- determine same-session expiration from an explicit trading date;
- load only configured underlyings and a narrow strike band;
- normalize bid/ask/midpoint, volume, open interest, IV, and available Greeks;
- preserve source timestamps separately from ingestion timestamps;
- mark missing, stale, crossed, or incomplete data explicitly.

Default discovery settings are configurable and paper-safe:

```text
ZERO_DTE_UNDERLYINGS=SPY,QQQ,IWM
ZERO_DTE_MAX_STRIKES_EACH_SIDE=5
ZERO_DTE_MIN_OPTION_VOLUME=100
ZERO_DTE_MIN_OPEN_INTEREST=250
ZERO_DTE_MAX_SPREAD_PCT=15
ZERO_DTE_MIN_PREMIUM=0.10
ZERO_DTE_MAX_PREMIUM=5.00
```

`ZERO_DTE_MAX_SPREAD_PCT` is expressed in percentage points, matching the repository's existing option configuration convention.

Each playbook returns the same structured shape:

```ts
{
  playbook,
  score,
  confidence,
  direction,
  eligible,
  supportingSignals,
  opposingSignals,
  blockers,
  missingInputs
}
```

Playbook rules:

- Trend continuation uses VWAP, EMA alignment, multi-timeframe consistency, pullback/reclaim behavior, relative volume, momentum persistence, intraday-extreme distance, and option liquidity.
- Reversal requires stronger confirmation from VWAP/ATR extension, exhaustion, failed break, reversal candle, volume climax, and supported divergence.
- Breakout uses configurable opening-range/consolidation boundaries, compression, breakout distance, volume expansion, retest, timeframe alignment, liquidity, and false-break risk.
- Gamma is explicitly a data-backed gamma proxy. Missing gamma or open-interest inputs produce `insufficient_data`/blockers rather than an invented score or dealer-positioning claim.
- Volatility expansion uses realized-volatility and ATR acceleration, range break, available volatility-index movement, IV, velocity, breadth, cross-index confirmation, and liquidity.

The composite score stores playbook score, signal-strength adjustment, liquidity adjustment, regime adjustment, execution-quality adjustment, risk penalties, and stale-data penalties as separate fields. Regimes are `trend`, `range`, `high-volatility`, `low-volatility`, `event-risk`, or `uncertain`. `event-risk` is only set from a configured verified calendar/source.

## Execution, exits, and duplicate protection

Minimum paper-entry eligibility requires:

- engine and paper execution flags enabled;
- `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, and `LIVE_TRADING_ENABLED=false`;
- a conclusive paper-account verification through the paper endpoint;
- valid market session, fresh underlying data, fresh option quote, eligible playbook, score threshold, confirmation observations, liquidity, position, daily-loss, daily-trade, and buying-power checks;
- no equivalent open position, open order, ledger reservation, or prior same-day action.

The implementation must reuse existing paper execution preflight, option validation, paper-only client routing, and execution ledger behavior. New Level 2 records link to the existing ledger without exposing raw credentials or unnecessary broker payloads.

New defaults are:

```text
ZERO_DTE_ENGINE_ENABLED=true
ZERO_DTE_PAPER_EXECUTION_ENABLED=true
ZERO_DTE_SHADOW_ENABLED=true
ZERO_DTE_DISCOVERY_START_ET=09:35
ZERO_DTE_NEW_ENTRY_CUTOFF_ET=15:15
ZERO_DTE_FORCE_EXIT_ET=15:50
ZERO_DTE_ENGINE_INTERVAL_SECONDS=60
ZERO_DTE_QUEUE_MAX_ACTIVE=100
ZERO_DTE_QUEUE_TOP_N=20
ZERO_DTE_EXECUTION_TOP_N=3
ZERO_DTE_MAX_CONTRACTS_PER_TRADE=1
ZERO_DTE_MAX_OPEN_POSITIONS=3
ZERO_DTE_MAX_TRADES_PER_DAY=3
ZERO_DTE_MAX_PREMIUM_PER_TRADE=250
ZERO_DTE_MAX_DAILY_PREMIUM=750
ZERO_DTE_MAX_DAILY_REALIZED_LOSS=250
```

The new engine's intent flags do not override the existing global safety gates. If any paper identity or mutation gate is uncertain, the engine records `ACCOUNT_NOT_PAPER`, `EXECUTION_DISABLED`, or the precise failed reason and performs no broker mutation.

Every entry and exit uses a deterministic client order ID derived from trading date, candidate/trade identity, action, and attempt number. All automated 0DTE entry paths use a shared canonical reservation key based on trading date, option symbol, and action so the new engine cannot race the legacy paper-option path into a duplicate order. The legacy workflow remains available for review/reporting; Level 2 owns automatic 0DTE entries when its owner flag is enabled. Existing equity, hedge, and LEAPS automation is unaffected.

Every executed position immediately enters the existing 0DTE exit-management policy. Exit decisions persist trigger, quote/position inputs, applied threshold, action, and execution result. The new engine adds per-minute review and lifecycle linkage without changing the approved exit thresholds.

## Shadow portfolio and outcomes

Shadow trades are created only for configured-quality candidates that were skipped, rejected by capacity/ranking, blocked by buying power, or displaced by a higher-ranked candidate. Controlled alternatives include runner-up, alternative playbook, alternative contract, and delayed entry. Low-quality candidates are not simulated indiscriminately.

Default fill assumptions are conservative: entry at ask plus configured slippage, exit at bid minus configured slippage, fees included, and no fill when quote quality or spread limits fail. Shadow rows are isolated from broker positions, buying power, actual exposure, and broker order methods.

Missed eligible candidates receive forward outcome marks at configured horizons `5,15,30,60` minutes when data is available. Production and shadow trades receive terminal price, MFE, MAE, P&L, return, holding time, exit reason, and completeness status. End-of-day recommendations are retrospective only and cannot modify thresholds automatically.

## Lifecycle events

Every material evaluation has an engine run ID, decision ID, candidate ID, decision group ID, account mode, strategy version, configuration version, market timestamp, and decision timestamp.

Persist at least these append-only events:

`candidate_discovered`, `candidate_observed`, `candidate_strengthened`, `candidate_weakened`, `candidate_reappeared`, `candidate_became_eligible`, `candidate_selected`, `candidate_skipped`, `candidate_rejected`, `candidate_expired`, `candidate_invalidated`, `paper_order_requested`, `paper_order_accepted`, `paper_order_rejected`, `paper_order_filled`, `paper_order_partially_filled`, `paper_order_canceled`, `position_opened`, `position_marked`, `exit_triggered`, `exit_order_requested`, `position_closed`, `shadow_opened`, `shadow_marked`, `shadow_closed`, and `terminal_outcome_recorded`.

Reason codes remain structured, including `BELOW_SCORE_THRESHOLD`, `INSUFFICIENT_CONFIRMATION`, `WEAKENING_SIGNAL`, `WIDE_SPREAD`, `LOW_VOLUME`, `LOW_OPEN_INTEREST`, `STALE_QUOTE`, `MISSING_GREEKS`, `ENTRY_CUTOFF`, `DAILY_TRADE_LIMIT`, `DAILY_LOSS_LIMIT`, `BUYING_POWER`, `MAX_OPEN_0DTE_POSITIONS`, `DUPLICATE_EXPOSURE`, `HIGHER_RANKED_CANDIDATE`, `PLAYBOOK_INVALIDATED`, `ACCOUNT_NOT_PAPER`, `EXECUTION_DISABLED`, and `ORDER_REJECTED`.

## Scheduling and CLI

Add CLI entry points following existing repository conventions:

- `zero-dte:engine` for the primary cycle, with explicit `--dryRun` and `--confirmPaper` modes;
- `zero-dte:exit:review` for active paper-position exit review;
- `zero-dte:reconcile` for marks, fills, terminal outcomes, and missed-opportunity horizons;
- `zero-dte:eod` for the persisted daily learning summary;
- `zero-dte:summary` for a sanitized queue/health read model.

Add existing-pattern systemd services/timers for:

- primary engine every 60 seconds during configured weekday/session windows;
- exit review every 60 seconds;
- reconciliation every 5 minutes;
- one end-of-day summary after the configured cutoff.

The runner must use the existing non-overlap lock pattern, session gate, paper-runtime gate, and redacted structured logging. Outside market hours it records a skipped/closed-session run rather than treating the condition as an error.

## Dashboard

Add a read-only Level 2 panel through the existing VPS bridge and Vercel read-only route. It displays:

- live ranked queue and block reasons;
- active paper positions and exit state;
- shadow positions labeled simulated;
- lifecycle counts and recent reasons;
- playbook and score-band performance;
- engine health, last successful cycle, scheduler state, stale-data count, account mode, and enabled flags.

The panel cannot submit orders and must never expose API keys, authorization headers, or raw secrets. Vercel remains a read-only presentation surface; the engine and SQLite database remain VPS-owned.

## Validation and acceptance criteria

Focused validation is sufficient for this implementation:

1. Typecheck/build and database migration initialization succeed.
2. Migration is idempotent on clean and existing databases and does not alter existing rows destructively.
3. Tests cover candidate identity/upsert, deterministic ranking, signal strengthening/weakening, at least one playbook, gamma missing-data behavior, paper-account fail-closed behavior, order idempotency, shadow isolation, lifecycle persistence, and exit policy linkage.
4. A dry engine cycle creates no broker orders and records a bounded run outcome.
5. The engine operates with direct market-data adapters without requiring an Observatory snapshot.
6. Queue rows and playbook evaluations persist independently and are exposed through the sanitized summary route.
7. A paper-enabled runtime cycle is attempted only under paper identity and existing mutation gates. No forced low-quality trade is created solely for validation.
8. If the market is closed, deployed timers, migrations, account mode, dashboard, dry-run, and data-path checks are validated and the engine remains ready for the next eligible session.
9. Existing focused tests for observatory, hedge, options, paper execution, and dashboard safety remain green where they overlap the changed contracts.

## Deployment boundaries

After implementation validation, the authorized delivery sequence is:

1. Stage only feature files and commit them; preserve the unrelated hedge-plan modification.
2. Push the working branch and create/update the explicitly authorized pull request.
3. Merge only after repository-required checks pass.
4. Deploy the merged SHA to the VPS paper runtime and dashboard if applicable.
5. Apply the additive migration.
6. Verify all paper/live environment flags and account identity.
7. Enable the Level 2 timers and run one read-only cycle.
8. Run one paper-enabled cycle only if a natural candidate satisfies every gate.
9. Validate queue, observations, playbook attribution, shadow isolation, lifecycle events, dashboard rendering, and absence of live execution paths.
10. Record the final state in Basic Memory Cloud without secret values.

Live order submission, live credentials, live configuration, and live infrastructure changes are explicitly out of scope.
