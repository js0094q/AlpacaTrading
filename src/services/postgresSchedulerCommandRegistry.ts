import {
  POSTGRES_SCHEDULER_JOBS,
  type PostgresSchedulerJob
} from "./postgresSchedulerExecutionService.js";

export type PostgresSchedulerCommandInput = {
  readonly command: string | undefined;
  readonly action?: string;
  readonly subaction?: string;
  readonly sections?: string | readonly string[];
};

export type PostgresSchedulerCommandRegistration = {
  readonly job: PostgresSchedulerJob;
  readonly aliases: readonly string[];
  readonly requiresReviewedExitSections?: boolean;
};

export type PostgresSchedulerInvocationRegistration = {
  readonly schedulerInvocationId: string;
  readonly job: PostgresSchedulerJob;
};

export type PostgresSchedulerInvocationInput = {
  readonly schedulerInvocationId: string;
  readonly command: PostgresSchedulerCommandInput;
};

export const POSTGRES_SCHEDULER_COMMAND_REGISTRY = [
  {
    job: POSTGRES_SCHEDULER_JOBS.research,
    aliases: ["research:daily"]
  },
  {
    job: POSTGRES_SCHEDULER_JOBS.zeroDte,
    aliases: ["zero-dte:engine"]
  },
  {
    job: POSTGRES_SCHEDULER_JOBS.observatory,
    aliases: ["observatory:collect"]
  },
  {
    job: POSTGRES_SCHEDULER_JOBS.reconciliation,
    aliases: ["zero-dte:reconcile"]
  },
  {
    job: POSTGRES_SCHEDULER_JOBS.exitReview,
    aliases: [
      "paper:exit:review",
      "paper:exit-review",
      "paper:ops:review",
      "paper:ops:late-day",
      "paper:ops:late_day"
    ]
  },
  {
    job: POSTGRES_SCHEDULER_JOBS.paperExit,
    aliases: ["paper:exit:execute", "paper:exit-execute"]
  },
  {
    job: POSTGRES_SCHEDULER_JOBS.paperExit,
    aliases: ["paper:execute:reviewed"],
    requiresReviewedExitSections: true
  },
  {
    job: POSTGRES_SCHEDULER_JOBS.marketDataRefresh,
    aliases: ["data:ingest", "options:ingest"]
  }
] as const satisfies readonly PostgresSchedulerCommandRegistration[];

const REVIEWED_EXIT_SECTIONS = new Set([
  "equitySells",
  "optionSellToCloseExits"
]);

const normalizedCommand = (input: PostgresSchedulerCommandInput) => {
  const command = input.command?.trim();
  if (!command) return null;
  if (command.includes(":")) return command;

  return [command, input.action, input.subaction]
    .map((segment) => segment?.trim())
    .filter(
      (segment): segment is string =>
        Boolean(segment && !segment.startsWith("--"))
    )
    .join(":");
};

const hasReviewedExitSections = (
  sections: PostgresSchedulerCommandInput["sections"]
) => {
  const values = (
    typeof sections === "string" ? sections.split(",") : sections ?? []
  )
    .map((section) => section.trim())
    .filter(Boolean);

  return (
    values.length > 0 &&
    values.every((section) => REVIEWED_EXIT_SECTIONS.has(section))
  );
};

export const resolvePostgresSchedulerJob = (
  input: PostgresSchedulerCommandInput
): PostgresSchedulerJob | null => {
  const command = normalizedCommand(input);
  if (!command) return null;

  for (const registration of POSTGRES_SCHEDULER_COMMAND_REGISTRY) {
    if (!(registration.aliases as readonly string[]).includes(command)) continue;
    if (
      "requiresReviewedExitSections" in registration &&
      registration.requiresReviewedExitSections &&
      !hasReviewedExitSections(input.sections)
    ) {
      continue;
    }
    return registration.job;
  }

  return null;
};

export const resolvePostgresSchedulerInvocation = (
  input: PostgresSchedulerInvocationInput
): PostgresSchedulerInvocationRegistration | null => {
  const job = resolvePostgresSchedulerJob(input.command);
  return job
    ? { schedulerInvocationId: input.schedulerInvocationId, job }
    : null;
};
