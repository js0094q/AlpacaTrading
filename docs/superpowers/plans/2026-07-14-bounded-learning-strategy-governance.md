# Bounded Learning Strategy Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert evaluated paper-learning outcomes into bounded, persisted research-priority and research-suspension decisions consumed automatically by the morning paper-ops workflow.

**Architecture:** A local SQLite governance service computes policy decisions from a bounded sample of evaluated paper-learning outcomes. The existing morning timer invokes evaluation, governance, and then research; candidate ranking reads the current immutable decision state once and applies a capped priority multiplier or a fail-closed research skip.

**Tech Stack:** TypeScript, Node.js built-in SQLite, systemd existing paper-ops timer, paper-only Alpaca configuration.

## Global Constraints

- Paper-only; no broker-mutating API call is permitted.
- Preserve all existing execution, review, universe lifecycle, observatory, and live-trading gates.
- Limit each strategy-family scan to 250 records and symbol scopes to 100.
- A governance suspension is research-only and must never retire or disable a universe symbol.
- Record Git SHA, policy version, and policy hash with every governance transition.

---

### Task 1: Persist bounded governance state

**Files:**
- Modify: `src/lib/db.ts`
- Create: `src/services/learningGovernanceService.ts`
- Test: `tests/learningGovernanceService.test.ts`

**Interfaces:**
- Produces: `applyPaperLearningGovernance()` and `getCurrentPaperLearningGovernance()`.
- Produces: immutable decision transitions for `strategy_family` and `symbol` scopes.

- [ ] Add `paper_learning_governance_runs` and `paper_learning_governance_decisions` with a unique current-state index.
- [ ] Aggregate only valid `pnlLiveLike` outcomes, preserving insufficient evidence as `observe`.
- [ ] Persist only state, multiplier, or reason changes; retain a completed run record for every invocation.
- [ ] Assert positive and negative outcome sets persist priority and suspension decisions without broker access.

### Task 2: Consume governance in candidate ranking

**Files:**
- Modify: `src/services/candidateRankingService.ts`
- Test: `tests/learningGovernanceService.test.ts`

**Interfaces:**
- Consumes: current governance decisions from Task 1.
- Produces: prioritized candidate scores and `LEARNING_GOVERNANCE_SUSPENDED` skipped decisions.

- [ ] Resolve one strategy-family and one symbol decision per ranked target.
- [ ] Cap combined priority at 1.25x.
- [ ] Exclude suspended candidates before normal and aggressive fallback selection.
- [ ] Assert a prioritized symbol ranks above an otherwise equivalent baseline and a suspended symbol cannot be selected.

### Task 3: Make the existing timer path autonomous

**Files:**
- Modify: `src/services/paperOpsWorkflowService.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Test: `tests/paperOpsWorkflowService.test.ts`

**Interfaces:**
- Consumes: paper-learning evaluation and governance services.
- Produces: morning workflow details containing `learningGovernance` before research begins.

- [ ] Reorder morning operations to evaluation, governance, research, discovery, and review.
- [ ] Expose manual governance and read-only governance-status CLI commands for operations evidence.
- [ ] Assert the workflow call ordering and persisted governance result.

### Task 4: Document, review, and release

**Files:**
- Create: `docs/specs/2026-07-14-bounded-learning-strategy-governance.md`
- Create: `docs/decisions/ADR-004-bounded-learning-strategy-governance.md`
- Create: this implementation plan

- [ ] Document the closed subsystem matrix, policy bounds, ownership boundaries, and acceptance criteria.
- [ ] Review the diff twice for Critical and High issues; create GitHub issues only for remaining Low or theoretical findings.
- [ ] Run targeted validation, repository validation, merge, deploy, and obtain an existing-timer service evidence record.

## Self-Review

- Spec coverage: Tasks 1 through 3 implement durable decisions, a concrete ranking consumer, and the automatic timer path; Task 4 captures provenance and release evidence.
- Boundary coverage: the service has no Alpaca import, no order method, and no write path outside local SQLite governance tables.
- Lifecycle coverage: evaluation now has an automatic downstream consumer, and that consumer changes the immediately following research run without enabling execution.
- Type consistency: service exports are named consistently across workflow, CLI, and tests; candidate ranking reads current state rather than inventing a parallel policy.

Execution proceeds inline under the user's direct implementation authorization.
