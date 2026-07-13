# Paper Hedge Full Validation, Deployment, and Authorized Execution Runbook — 2026-07-13

## Goal

Consult Basic Memory Cloud first and use it as continuity only. Treat the current local repository and runtime state as authoritative when they differ. Update Basic Memory Cloud before finishing.

Complete the paper hedge implementation by:

1. Running a single full validation cycle.
2. Correcting only implementation regressions.
3. Publishing the completed hedge branch.
4. Merging it into `main`.
5. Deploying the merged commit to the VPS and Vercel production.
6. Validating the deployed paper-only runtime.
7. Enabling the complete guarded paper hedge lifecycle.
8. Executing one qualified paper hedge if, and only if, the deployed system independently determines that it is eligible.
9. Executing an eligible paper hedge exit only when the configured exit policy independently triggers it.
10. Recording execution, reconciliation, and learning artifacts.
11. Leaving live trading disabled.

## Authorization

Authorized actions:

- repository inspection and narrow correction
- one canonical full test-suite attempt
- focused test reruns after branch-caused fixes
- typecheck and changed-file lint
- commit, push, pull request, and merge
- VPS deployment
- Vercel production deployment
- safe runtime configuration alignment
- database migrations required by the merged source
- service and timer restart
- authenticated paper hedge review and mutation routes
- guarded paper hedge entry submission
- guarded paper hedge sell-to-close submission when independently eligible
- paper account, position, order, reservation, and ledger reconciliation
- Basic Memory write-back

Not authorized:

- live trading
- live order submission
- live credential use
- multi-leg hedge execution
- naked short options
- bypassing authentication, HMAC validation, review freshness, reservation, idempotency, duplicate checks, caps, or account verification
- forcing a paper order only to demonstrate that the route works

## Verified starting context

Expected repository:

`js0094q/AlpacaTrading`

Expected local branch:

`feat/paper-hedge-execution`

Expected completed local HEAD:

`40cfe4a`

Completed implementation commits:

- `3d1dc96` — Expose complete portfolio Greeks
- `d770c68` — Add reviewed paper hedge payloads
- `445e420` — Guard hedge execution state
- `0d739cf` — Execute bounded paper hedges
- `0f099d8` — Track paper hedge outcomes
- `58ab126` — Expose authenticated paper hedge controls
- `93b1e14` — Align paper hedge configuration
- `40cfe4a` — Stabilize paper hedge exit validation

Previously validated:

- bounded lifecycle integration: 101 passed, 0 failed
- focused Task 3–8 tests passed
- `npm run typecheck` passed
- `git diff --check` passed

Expected pre-existing local plan modification:

`docs/superpowers/plans/2026-07-10-guarded-paper-hedge-execution.md`

Preserve it unless intentionally updated. Do not stage it accidentally.

## Source-of-truth rule

Use the following authority order:

1. current local working tree and Git output
2. current GitHub state
3. current VPS deployed source and runtime
4. current Vercel production deployment
5. current Alpaca paper-account read-only and mutation responses
6. Basic Memory notes

When Basic Memory conflicts with live state, preserve the live fact and update the stale note.

## Phase 1 — Repository validation

Read the nearest applicable `AGENTS.md`, `README.md`, package configuration, deployment configuration, current implementation plan, and this runbook.

Verify:

```bash
git status --short --branch
git rev-parse --show-toplevel
git rev-parse HEAD
git log --oneline --decorate -12
git diff --check
git diff --stat
```

Confirm:

- branch is `feat/paper-hedge-execution`
- expected HEAD is `40cfe4a`, or explain any newer intentional commit
- no unresolved merge conflict exists
- only intentional uncommitted changes exist
- no secret file is staged

Stop only for a concrete state mismatch that risks deploying the wrong code.

## Phase 2 — One full validation cycle

Use the repository’s canonical commands. Prefer:

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

If package scripts define a canonical aggregate command such as `npm run verify`, use it instead of inventing a new sequence.

Full-suite policy:

- run the full suite once initially
- classify failures as branch-caused or unrelated/pre-existing
- fix only branch-caused regressions
- rerun directly affected focused tests and typecheck
- rerun the full suite only one additional time when needed to verify a correction
- do not enter another broad review or repeated testing loop

Any failure affecting paper/live separation, authentication, request signing, account verification, order construction, reservation, idempotency, duplicate prevention, persistence, migrations, dashboard mutation controls, or deployment must be fixed before deployment or submission.

Unrelated failures may be deferred only when documented and when all directly relevant hedge lifecycle tests and typecheck pass.

## Phase 3 — Final local commit hygiene

Before any new corrective commit:

```bash
git diff --check
git status --short
git diff --cached
```

Stage only intentional files. Never commit secret values or local credential files.

Create narrow corrective commits only when required. Do not squash the existing Task 3–8 sequence unless repository policy explicitly requires it.

## Phase 4 — Publish and merge

Push the completed branch:

```bash
git push -u origin feat/paper-hedge-execution
```

Create a pull request into `main` containing:

- implementation summary
- safety boundary
- test results
- paper flags enabled
- live flags disabled
- deployment plan
- explicit statement that paper execution is authorized only through existing guarded controls

Wait for required checks. Resolve only concrete merge or CI failures. Do not restart an exhaustive review cycle.

Merge using the repository’s established strategy. Record:

- PR number
- branch tip SHA
- merge SHA
- merge strategy

Update local `main` and verify it matches GitHub before deployment.

## Phase 5 — Required runtime configuration

Use canonical existing variable names. Do not invent duplicates.

Required paper posture:

```text
ALPACA_ENV=paper
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
PAPER_ORDER_EXECUTION_ENABLED=true
PAPER_OPTIONS_EXECUTION_ENABLED=true
AUTOMATED_PAPER_EXECUTION_ENABLED=true
HEDGE_PAPER_EXECUTION_ENABLED=true
HEDGE_AUTOMATED_PAPER_EXECUTION_ENABLED=true
HEDGE_EXIT_MANAGEMENT_ENABLED=true
HEDGE_LEARNING_ENABLED=true
HEDGE_DASHBOARD_MUTATIONS_ENABLED=true
```

Required disabled posture:

```text
LIVE_TRADING_ENABLED=false
AUTOMATED_LIVE_EXECUTION_ENABLED=false
HEDGE_LIVE_EXECUTION_ENABLED=false
MULTI_LEG_HEDGE_EXECUTION_ENABLED=false
```

Verify effective runtime values by names and safe booleans only. Never print secrets, tokens, account identifiers, signing material, or authorization headers.

## Phase 6 — VPS deployment

Deploy the exact merged `main` SHA to the known VPS repository using the established deployment mechanism.

Required sequence:

1. Verify the remote working tree and deployed branch.
2. Preserve or stop safely if there are unexplained remote modifications.
3. Fetch and fast-forward to the exact merged SHA.
4. Install locked dependencies.
5. Apply repository-defined database migrations or initialization.
6. Build required packages.
7. Align paper-only runtime flags outside the repository.
8. Reload systemd when unit definitions changed.
9. Restart affected services and timers.
10. Verify each affected service is active and healthy.

Do not replace or print secret values.

Record the deployed SHA and migration result.

## Phase 7 — Vercel production deployment

Deploy the exact merged SHA to the existing Vercel production project.

Verify:

- production build succeeded
- deployment resolves to the merged SHA
- public health and read routes work
- authenticated mutation routes reject missing or invalid authentication
- valid authenticated requests reach the VPS bridge only under paper-safe preflight
- environment-name presence and paper/live booleans are aligned without exposing values
- request and correlation IDs remain structured and redacted

Record the production deployment ID and URL returned by Vercel tooling.

## Phase 8 — Post-deployment safety validation

Before any paper submission, prove all of the following from current runtime evidence:

- Alpaca client is explicitly paper-only
- account endpoint is reachable
- account environment matches paper
- live trading flags are false
- live hedge execution is false
- multi-leg execution is false
- dashboard mutation flag is true
- paper hedge execution flag is true
- paper options execution flag is true
- HMAC or equivalent signing validation is operational
- authenticated mutation routes reject missing and invalid authentication
- database migrations are current
- no stale execution reservation blocks the lifecycle
- no unexplained open hedge order exists

If paper and live credentials or endpoints cannot be proven separate, stop before mutation.

## Phase 9 — Fresh hedge lifecycle review

Generate current evidence through the canonical commands or routes:

```text
hedge:risk
hedge:review
hedge:plan --paperOnly
```

Then create a fresh signed execution review.

Reconcile:

- current account
- current positions
- current open orders
- prior hedge ledger entries
- current reservations
- candidate quote and liquidity
- plan and review timestamps
- portfolio beta and exposure inputs

A paper entry is eligible only when the deployed policy independently selects it and every execution gate passes.

Allowed entry structure:

- one long put

Disallowed structures:

- put spread
- call spread
- multi-leg order
- short put
- naked option
- live endpoint fallback

If there is no eligible entry, return `VALIDATED_NO_OP`. Do not weaken policy gates or manufacture a trade.

## Phase 10 — Authorized paper hedge entry

Paper order submission is green-lit for this task.

Submit at most one newly qualified hedge entry through the canonical guarded execution path.

Required controls:

- explicit paper-account verification
- fresh reviewed plan
- valid request signature
- authenticated mutation route or canonical CLI confirmation
- atomic execution reservation
- deterministic idempotency key
- duplicate position and open-order checks
- stale-plan rejection
- current quote
- expiration and liquidity filters
- quantity cap
- premium cap
- portfolio hedge allocation cap
- single-long-put payload validation

Do not submit a paper order solely to test connectivity.

Persist and report safely:

- execution decision
- option symbol
- side
- quantity
- order type
- limit price when applicable
- reserved premium or capped exposure
- redacted request ID
- broker order ID
- initial order status
- ledger result

Do not print credentials or raw signed payloads.

## Phase 11 — Post-entry reconciliation and idempotency

After submission:

1. Read the broker order by ID or reconcile open orders.
2. Reconcile positions.
3. Verify the execution ledger contains one deterministic outcome.
4. Verify the reservation is consumed or finalized correctly.
5. Retry the same reviewed execution request once through the safe idempotency check.
6. Confirm no second broker order was created.

Do not cancel or replace the order unless the canonical strategy itself requires it and the operation is within the existing guarded lifecycle.

## Phase 12 — Exit lifecycle

Run the canonical hedge exit review.

An exit may execute only when one of the configured policies independently triggers, including:

- profit exit
- loss containment
- time-to-expiration exit
- stale-thesis exit
- portfolio-risk-normalization exit

Allowed exit structure:

- sell to close an existing long put

Do not force an exit and do not create a short position.

When eligible, execute through the guarded paper-only exit path and reconcile the resulting order and position state.

## Phase 13 — Learning and audit trail

Verify that the lifecycle records:

- reviewed plan
- reservation event
- broker request and order identifiers
- entry or exit outcome
- realized or unrealized result when available
- execution quality
- slippage or limit-price evidence when available
- post-trade evaluation
- learning-ledger event

Do not fabricate a completed fill or realized outcome when the broker order remains pending or open. Label time-sensitive state with a timestamp.

## Phase 14 — Basic Memory write-back

Update the smallest relevant set of notes, including current state, trading boundaries, decision log, deployment record, and dated reflection.

Record:

- starting local SHA
- ending branch SHA
- PR number
- merged SHA
- VPS deployed SHA
- Vercel deployed SHA and deployment ID
- validation commands and results
- migration result
- effective non-secret paper/live posture
- paper execution result or `VALIDATED_NO_OP`
- redacted request ID and broker order ID when submitted
- reconciliation and idempotency result
- learning result
- exact next action

Never store secrets, tokens, account IDs, raw environment values, authorization headers, or signed request payloads.

## Stop conditions

Stop before deployment or mutation only for a concrete blocker:

- repository state materially differs and cannot be reconciled safely
- unresolved merge conflict
- branch-caused typecheck or critical test failure
- exposed secret
- paper/live credential or endpoint separation cannot be proven
- required database migration cannot be applied safely
- authenticated mutation route cannot be proven paper-only
- execution payload violates single-long-put or sell-to-close boundaries
- live execution must be enabled to proceed

Do not stop for optional refactoring, naming preferences, desire for additional review agents, or unrelated lint/test failures that do not affect the hedge lifecycle or safety boundary.

## Final report contract

Return the following.

### Repository

- starting local SHA
- ending branch SHA
- commits added during correction
- PR number
- merge strategy and merged SHA

### Validation

- dependency-install command and result
- lint command and result
- typecheck command and result
- full-suite command and totals
- focused reruns
- unrelated failures intentionally deferred

### Deployment

- VPS deployed SHA
- migrations applied
- services and timers restarted
- VPS health result
- Vercel deployed SHA
- Vercel deployment ID
- dashboard and route validation

### Runtime safety

- effective paper flags
- effective live-disabled flags
- account-environment verification
- authentication and request-signing result
- reservation and duplicate-check status

### Hedge lifecycle

- current risk decision
- candidate and sizing decision
- execution result or `VALIDATED_NO_OP`
- safe order details when submitted
- post-submission reconciliation
- duplicate retry result
- exit review and execution result
- learning-ledger result

### Confirmation

Explicitly confirm:

- no live order was submitted
- live trading remained disabled
- no multi-leg hedge was submitted
- no safety gate was weakened
- Basic Memory was updated

## Conditions

This authorization applies to the paper environment and current guarded hedge implementation only. It does not authorize live trading or a redesign of execution boundaries.

## Supersession rule

This runbook is superseded by a newer explicit user authorization, a material architecture change, or live repository/runtime evidence showing that its expected branch, commit, or safety controls no longer apply.
