import assert from "node:assert/strict";
import test from "node:test";

import {
  POSTGRES_SCHEDULER_COMMAND_REGISTRY,
  resolvePostgresSchedulerInvocation,
  resolvePostgresSchedulerJob,
  type PostgresSchedulerCommandInput
} from "../src/services/postgresSchedulerCommandRegistry.js";
import {
  POSTGRES_SCHEDULER_JOBS
} from "../src/services/postgresSchedulerExecutionService.js";

const resolve = (
  command: string | undefined,
  action?: string,
  subaction?: string,
  sections?: string | readonly string[]
) => resolvePostgresSchedulerJob({ command, action, subaction, sections });

const assertAliasesResolveTo = (
  aliases: readonly PostgresSchedulerCommandInput[],
  expected: (typeof POSTGRES_SCHEDULER_JOBS)[keyof typeof POSTGRES_SCHEDULER_JOBS]
) => {
  for (const alias of aliases) {
    assert.strictEqual(resolvePostgresSchedulerJob(alias), expected);
  }
};

test("research, observatory, and market-data aliases converge on stable jobs", () => {
  assertAliasesResolveTo(
    [
      { command: "research", action: "daily" },
      { command: "research:daily" }
    ],
    POSTGRES_SCHEDULER_JOBS.research
  );
  assertAliasesResolveTo(
    [
      { command: "observatory", action: "collect" },
      { command: "observatory:collect" }
    ],
    POSTGRES_SCHEDULER_JOBS.observatory
  );
  assertAliasesResolveTo(
    [
      { command: "data", action: "ingest" },
      { command: "data:ingest" },
      { command: "options", action: "ingest" },
      { command: "options:ingest" }
    ],
    POSTGRES_SCHEDULER_JOBS.marketDataRefresh
  );
});

test("0DTE lifecycle commands and reconciliation resolve to stable jobs", () => {
  assertAliasesResolveTo(
    [
      { command: "zero-dte:engine" },
      { command: "zero-dte:exit:review" },
      { command: "zero-dte:eod" }
    ],
    POSTGRES_SCHEDULER_JOBS.zeroDte
  );
  assert.strictEqual(
    resolve("zero-dte:reconcile"),
    POSTGRES_SCHEDULER_JOBS.reconciliation
  );
  assert.strictEqual(
    resolve("paper:reconcile:external-order"),
    POSTGRES_SCHEDULER_JOBS.reconciliation
  );
});

test("paper exit-review aliases converge on the exit-review job", () => {
  assertAliasesResolveTo(
    [
      { command: "paper:exit:review" },
      { command: "paper", action: "exit-review" },
      { command: "paper:ops:review" },
      { command: "paper", action: "ops", subaction: "review" },
      { command: "paper:ops:late-day" },
      { command: "paper:ops:late_day" },
      { command: "paper", action: "ops", subaction: "late-day" },
      { command: "paper", action: "ops", subaction: "late_day" }
    ],
    POSTGRES_SCHEDULER_JOBS.exitReview
  );
});

test("direct paper exits and reviewed execution use explicit stable jobs", () => {
  assertAliasesResolveTo(
    [
      { command: "paper:exit:execute" },
      { command: "paper", action: "exit-execute" },
      {
        command: "paper:execute:reviewed",
        sections: "equitySells,optionSellToCloseExits"
      },
      {
        command: "paper:execute:reviewed",
        sections: ["optionSellToCloseExits", "equitySells"]
      }
    ],
    POSTGRES_SCHEDULER_JOBS.paperExit
  );
  assertAliasesResolveTo(
    [
      { command: "paper:execute" }
    ],
    POSTGRES_SCHEDULER_JOBS.paperExecution
  );
});

test("allocation, universe, and recovery timers cannot bypass scheduler leasing", () => {
  assertAliasesResolveTo(
    [
      { command: "paper:review" },
      { command: "paper:portfolio:review" },
      { command: "paper:ops:morning" },
      { command: "paper:ops:midday" }
    ],
    POSTGRES_SCHEDULER_JOBS.allocation
  );
  assert.strictEqual(
    resolve("universe:lifecycle"),
    POSTGRES_SCHEDULER_JOBS.universeLifecycle
  );
  assert.strictEqual(
    resolve("system:recover"),
    POSTGRES_SCHEDULER_JOBS.autonomousRecovery
  );
});

test("all reviewed execution section combinations use one execution lease", () => {
  assertAliasesResolveTo(
    [
      { command: "paper:execute:reviewed" },
      {
        command: "paper:execute:reviewed",
        sections: "equityBuys,equityAdds,optionBuys"
      },
      {
        command: "paper:execute:reviewed",
        sections: "equitySells,optionBuys"
      }
    ],
    POSTGRES_SCHEDULER_JOBS.paperExecution
  );
});

test("unrelated read-only commands are not registered", () => {
  const unmapped: readonly PostgresSchedulerCommandInput[] = [
    { command: undefined },
    { command: "paper:runtime" },
    { command: "paper", action: "runtime" },
    { command: "options:diagnose" },
    { command: "zero-dte:summary" },
    { command: "allocation:run" }
  ];

  for (const command of unmapped) {
    assert.equal(resolvePostgresSchedulerJob(command), null);
  }
  const registeredJobNames = new Set(
    POSTGRES_SCHEDULER_COMMAND_REGISTRY.map(
      (registration) => registration.job.jobName
    ) as readonly string[]
  );
  for (const job of Object.values(POSTGRES_SCHEDULER_JOBS)) {
    assert.equal(registeredJobNames.has(job.jobName), true);
  }
});

test("scheduler invocation identity remains separate from domain run identity", () => {
  const registration = resolvePostgresSchedulerInvocation({
    schedulerInvocationId: "scheduler-invocation-42",
    command: { command: "research", action: "daily" }
  });

  assert.deepEqual(registration, {
    schedulerInvocationId: "scheduler-invocation-42",
    job: POSTGRES_SCHEDULER_JOBS.research
  });
  assert.equal(registration && "runId" in registration, false);
});
