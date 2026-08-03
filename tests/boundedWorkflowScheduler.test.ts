import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type ResourceClass =
  | "shared_context"
  | "compute_readonly"
  | "postgres_serial"
  | "broker_mutation";

type Scheduler = {
  run<T>(input: {
    workflowId: string;
    resourceClass: ResourceClass;
    signal?: AbortSignal;
  }, operation: () => Promise<T>): Promise<T>;
};

type SchedulerModule = {
  createBoundedScheduler(input: {
    configuredConcurrency?: number;
    minimumConcurrency?: number;
    maximumConcurrency?: number;
    samplePressure: () => unknown;
    emit: (event: unknown) => void;
    now?: () => number;
  }): Scheduler;
  resourcePressureSample(input: {
    availableMemoryBytes: number;
    loadAverageOneMinute: number;
    postgresLatencyMs: number;
    configuredPostgresLatencyMs: number;
    workerStateLatencyMs: number;
    configuredStateLatencyMs: number;
    providerThrottled: boolean;
    priorWorkflowTimedOut: boolean;
    heartbeatOrFenceRisk: boolean;
    diskFreeRatio: number;
    fileDescriptorRatio: number;
  }): {
    pressure: boolean;
    reasons: readonly string[];
  };
  executeWorkflowGraph<TDefinition extends WorkflowDefinition>(input: {
    registry: readonly TDefinition[];
    decisions?: readonly WorkflowDecision[];
    scheduler: Scheduler;
    signal?: AbortSignal;
    runWorkflow: (
      definition: TDefinition & {
        readonly args: readonly string[];
        readonly boundInputs?: Readonly<Record<string, string | number | boolean>>;
      },
      signal: AbortSignal
    ) => Promise<unknown>;
    persistTerminal: (terminal: WorkflowTerminal) => Promise<void>;
    sleep?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
  }): Promise<{
    status: "success" | "partial";
    terminals: readonly WorkflowTerminal[];
    decisions: readonly {
      type: "registry_decision";
      terminal: false;
      workflowId: string;
      enabled: false;
      reasonCode: "WORKFLOW_DISABLED";
      enableWhen: string;
      inactiveDependencyIds: readonly string[];
    }[];
  }>;
};

type WorkflowDefinition = {
  readonly id: string;
  readonly args: readonly string[];
  readonly dependencies: readonly string[];
  readonly resourceClass: ResourceClass;
  readonly enableWhen: string;
  readonly timeoutMs: number;
  readonly retryPolicy: {
    readonly maxAttempts: number;
    readonly backoffMs: number;
    readonly retryableReasonCodes: readonly string[];
  };
  readonly inputBindings: readonly {
    readonly argName: string;
    readonly fromWorkflowId: string;
    readonly outputField: string;
  }[];
  readonly failureScope?: string;
};

type WorkflowDecision = {
  readonly id: string;
  readonly enableWhen: string;
  readonly enabled: boolean;
  readonly inactiveDependencyIds: readonly string[];
};

type WorkflowTerminal = {
  readonly workflowId: string;
  readonly terminal: true;
  readonly classification: string;
  readonly reasonCode?: string;
  readonly attempt: number;
  readonly output?: unknown;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly submissionMayHaveOccurred?: boolean;
};

const repoRoot = process.cwd();

const loadSchedulerModule = async () => {
  const url = pathToFileURL(join(repoRoot, "scripts/lib/bounded-workflow-scheduler.mjs"));
  return import(url.href) as Promise<SchedulerModule>;
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const settleAdmissions = () => new Promise<void>((resolve) => setImmediate(resolve));

const workflowDefinition = (
  id: string,
  overrides: Partial<WorkflowDefinition> = {}
): WorkflowDefinition => Object.freeze({
  id,
  args: Object.freeze([]),
  dependencies: Object.freeze([]),
  resourceClass: "compute_readonly" as const,
  enableWhen: "always",
  timeoutMs: 1_000,
  retryPolicy: Object.freeze({
    maxAttempts: 1,
    backoffMs: 0,
    retryableReasonCodes: Object.freeze([])
  }),
  inputBindings: Object.freeze([]),
  failureScope: "local",
  ...overrides
});

const createHealthyScheduler = (createBoundedScheduler: SchedulerModule["createBoundedScheduler"]) =>
  createBoundedScheduler({
    configuredConcurrency: 2,
    minimumConcurrency: 1,
    maximumConcurrency: 2,
    samplePressure: () => ({ pressure: false, reasons: [] }),
    emit: () => undefined
  });

test("non-mutating admissions are FIFO and never exceed the configured two-slot cap", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();
  const scheduler = createBoundedScheduler({
    configuredConcurrency: 2,
    minimumConcurrency: 1,
    maximumConcurrency: 2,
    samplePressure: () => ({ pressure: false, reasons: [] }),
    emit: () => undefined
  });
  const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
  const starts: string[] = [];
  let active = 0;
  let maximumObserved = 0;

  const runs = ["first", "second", "third"].map((workflowId, index) =>
    scheduler.run({ workflowId, resourceClass: "compute_readonly" }, async () => {
      starts.push(workflowId);
      active += 1;
      maximumObserved = Math.max(maximumObserved, active);
      await releases[index]!.promise;
      active -= 1;
      return workflowId;
    })
  );

  await settleAdmissions();
  assert.deepEqual(starts, ["first", "second"]);
  assert.equal(maximumObserved, 2);

  releases[1]!.resolve();
  await settleAdmissions();
  assert.deepEqual(starts, ["first", "second", "third"]);
  assert.equal(maximumObserved, 2);

  releases[0]!.resolve();
  releases[2]!.resolve();
  assert.deepEqual(await Promise.all(runs), ["first", "second", "third"]);
});

test("configured concurrency accepts only integer limits inside one and two", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();
  const create = (configuredConcurrency: number) => createBoundedScheduler({
    configuredConcurrency,
    minimumConcurrency: 1,
    maximumConcurrency: 2,
    samplePressure: () => ({ pressure: false, reasons: [] }),
    emit: () => undefined
  });

  for (const invalid of [0, 3, 1.5, Number.NaN]) {
    assert.throws(
      () => create(invalid),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "AUTONOMOUS_COMPUTE_CONCURRENCY_INVALID"
    );
  }
  for (const explicitBounds of [
    { minimumConcurrency: 0, maximumConcurrency: 2 },
    { minimumConcurrency: 1, maximumConcurrency: 3 }
  ]) {
    assert.throws(
      () => createBoundedScheduler({
        configuredConcurrency: 2,
        ...explicitBounds,
        samplePressure: () => ({ pressure: false, reasons: [] }),
        emit: () => undefined
      }),
      (error: unknown) => error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "AUTONOMOUS_COMPUTE_CONCURRENCY_INVALID"
    );
  }
  assert.doesNotThrow(() => create(1));
  assert.doesNotThrow(() => create(2));
});

test("shared-context and PostgreSQL gates serialize their own resource classes", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();

  for (const resourceClass of ["shared_context", "postgres_serial"] as const) {
    const scheduler = createBoundedScheduler({
      configuredConcurrency: 2,
      minimumConcurrency: 1,
      maximumConcurrency: 2,
      samplePressure: () => ({ pressure: false, reasons: [] }),
      emit: () => undefined
    });
    const firstRelease = deferred<void>();
    const secondRelease = deferred<void>();
    const starts: string[] = [];
    const first = scheduler.run({ workflowId: `${resourceClass}.first`, resourceClass }, async () => {
      starts.push("first");
      await firstRelease.promise;
    });
    const second = scheduler.run({ workflowId: `${resourceClass}.second`, resourceClass }, async () => {
      starts.push("second");
      await secondRelease.promise;
    });

    await settleAdmissions();
    assert.deepEqual(starts, ["first"], resourceClass);
    firstRelease.resolve();
    await first;
    await settleAdmissions();
    assert.deepEqual(starts, ["first", "second"], resourceClass);
    secondRelease.resolve();
    await second;
  }
});

test("broker mutation uses a separate single-slot gate", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();
  const scheduler = createBoundedScheduler({
    configuredConcurrency: 2,
    minimumConcurrency: 1,
    maximumConcurrency: 2,
    samplePressure: () => ({ pressure: false, reasons: [] }),
    emit: () => undefined
  });
  const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
  const starts: string[] = [];
  const firstBroker = scheduler.run(
    { workflowId: "broker.first", resourceClass: "broker_mutation" },
    async () => {
      starts.push("broker.first");
      await releases[0]!.promise;
    }
  );
  const secondBroker = scheduler.run(
    { workflowId: "broker.second", resourceClass: "broker_mutation" },
    async () => {
      starts.push("broker.second");
      await releases[1]!.promise;
    }
  );
  const compute = scheduler.run(
    { workflowId: "compute", resourceClass: "compute_readonly" },
    async () => {
      starts.push("compute");
      await releases[2]!.promise;
    }
  );

  await settleAdmissions();
  assert.deepEqual(starts, ["broker.first", "compute"]);
  releases[0]!.resolve();
  await firstBroker;
  await settleAdmissions();
  assert.deepEqual(starts, ["broker.first", "compute", "broker.second"]);
  releases[1]!.resolve();
  releases[2]!.resolve();
  await Promise.all([secondBroker, compute]);
});

test("aborted workflows are rejected before admission and never start", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();
  const scheduler = createBoundedScheduler({
    configuredConcurrency: 1,
    minimumConcurrency: 1,
    maximumConcurrency: 2,
    samplePressure: () => ({ pressure: false, reasons: [] }),
    emit: () => undefined
  });
  const release = deferred<void>();
  let queuedStarted = false;
  const first = scheduler.run(
    { workflowId: "first", resourceClass: "compute_readonly" },
    () => release.promise
  );
  const controller = new AbortController();
  const queued = scheduler.run(
    { workflowId: "queued", resourceClass: "compute_readonly", signal: controller.signal },
    async () => {
      queuedStarted = true;
    }
  );
  const queuedRejection = assert.rejects(
    queued,
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "AUTONOMOUS_WORKFLOW_ABORTED"
  );

  await settleAdmissions();
  controller.abort();
  release.resolve();
  await first;
  await queuedRejection;
  assert.equal(queuedStarted, false);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let alreadyAbortedStarted = false;
  await assert.rejects(
    scheduler.run(
      {
        workflowId: "already-aborted",
        resourceClass: "compute_readonly",
        signal: alreadyAborted.signal
      },
      async () => {
        alreadyAbortedStarted = true;
      }
    ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "AUTONOMOUS_WORKFLOW_ABORTED"
  );
  assert.equal(alreadyAbortedStarted, false);
});

test("resource pressure uses the exact declared threshold operators", async () => {
  const { resourcePressureSample } = await loadSchedulerModule();
  const healthy = {
    availableMemoryBytes: 1024 ** 3,
    loadAverageOneMinute: 2.5,
    postgresLatencyMs: 500,
    configuredPostgresLatencyMs: 500,
    workerStateLatencyMs: 250,
    configuredStateLatencyMs: 250,
    providerThrottled: false,
    priorWorkflowTimedOut: false,
    heartbeatOrFenceRisk: false,
    diskFreeRatio: 0.10,
    fileDescriptorRatio: 0.89
  };

  assert.deepEqual(resourcePressureSample(healthy), {
    pressure: false,
    reasons: []
  });

  const pressureCases: readonly [string, Partial<typeof healthy>][] = [
    ["AVAILABLE_MEMORY_LOW", { availableMemoryBytes: 1024 ** 3 - 1 }],
    ["LOAD_AVERAGE_HIGH", { loadAverageOneMinute: 2.500_001 }],
    ["POSTGRES_LATENCY_HIGH", { postgresLatencyMs: 501 }],
    ["WORKER_STATE_LATENCY_HIGH", { workerStateLatencyMs: 251 }],
    ["PROVIDER_THROTTLED", { providerThrottled: true }],
    ["PRIOR_WORKFLOW_TIMEOUT", { priorWorkflowTimedOut: true }],
    ["HEARTBEAT_OR_FENCE_RISK", { heartbeatOrFenceRisk: true }],
    ["DISK_FREE_LOW", { diskFreeRatio: 0.099_999 }],
    ["FILE_DESCRIPTOR_HIGH", { fileDescriptorRatio: 0.90 }]
  ];
  for (const [reason, override] of pressureCases) {
    assert.deepEqual(resourcePressureSample({ ...healthy, ...override }), {
      pressure: true,
      reasons: [reason]
    });
  }
});

test("pressure fallback drains running work without killing the second slot", async () => {
  const { createBoundedScheduler, resourcePressureSample } = await loadSchedulerModule();
  let now = 0;
  let pressureInput = {
    availableMemoryBytes: 2 * 1024 ** 3,
    loadAverageOneMinute: 1,
    postgresLatencyMs: 10,
    configuredPostgresLatencyMs: 500,
    workerStateLatencyMs: 10,
    configuredStateLatencyMs: 250,
    providerThrottled: false,
    priorWorkflowTimedOut: false,
    heartbeatOrFenceRisk: false,
    diskFreeRatio: 0.50,
    fileDescriptorRatio: 0.10
  };
  const events: unknown[] = [];
  const scheduler = createBoundedScheduler({
    configuredConcurrency: 2,
    minimumConcurrency: 1,
    maximumConcurrency: 2,
    samplePressure: () => resourcePressureSample(pressureInput),
    emit: (event) => events.push(event),
    now: () => now
  });
  const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
  const starts: string[] = [];
  const run = (workflowId: string, index: number) => scheduler.run(
    { workflowId, resourceClass: "compute_readonly" },
    async () => {
      starts.push(workflowId);
      await releases[index]!.promise;
    }
  );
  const first = run("first", 0);
  const second = run("second", 1);
  await settleAdmissions();
  assert.deepEqual(starts, ["first", "second"]);

  pressureInput = { ...pressureInput, availableMemoryBytes: 1024 ** 3 - 1 };
  const third = run("third", 2);
  await settleAdmissions();
  assert.deepEqual(starts, ["first", "second"]);
  assert.deepEqual(events, [{
    type: "AUTONOMOUS_COMPUTE_PRESSURE_FALLBACK",
    reason: "AVAILABLE_MEMORY_LOW",
    configuredLimit: 2,
    effectiveLimit: 1,
    timestamp: "1970-01-01T00:00:00.000Z"
  }]);

  releases[0]!.resolve();
  await first;
  await settleAdmissions();
  assert.deepEqual(starts, ["first", "second"]);
  releases[1]!.resolve();
  await second;
  await settleAdmissions();
  assert.deepEqual(starts, ["first", "second", "third"]);
  releases[2]!.resolve();
  await third;
});

test("pressure recovery requires five clear samples and a sixty-second cooldown", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();
  let now = 0;
  let pressure = true;
  const events: unknown[] = [];
  const scheduler = createBoundedScheduler({
    configuredConcurrency: 2,
    minimumConcurrency: 1,
    maximumConcurrency: 2,
    samplePressure: () => pressure
      ? { pressure: true, reasons: ["PROVIDER_THROTTLED"] }
      : { pressure: false, reasons: [] },
    emit: (event) => events.push(event),
    now: () => now
  });

  await scheduler.run(
    { workflowId: "pressure", resourceClass: "compute_readonly" },
    async () => undefined
  );
  pressure = false;
  for (const timestamp of [10_000, 20_000, 30_000, 40_000]) {
    now = timestamp;
    await scheduler.run(
      { workflowId: `clear-${timestamp}`, resourceClass: "compute_readonly" },
      async () => undefined
    );
  }
  assert.equal(events.length, 1);

  now = 60_000;
  await scheduler.run(
    { workflowId: "clear-60000", resourceClass: "compute_readonly" },
    async () => undefined
  );
  assert.deepEqual(events, [
    {
      type: "AUTONOMOUS_COMPUTE_PRESSURE_FALLBACK",
      reason: "PROVIDER_THROTTLED",
      configuredLimit: 2,
      effectiveLimit: 1,
      timestamp: "1970-01-01T00:00:00.000Z"
    },
    {
      type: "AUTONOMOUS_COMPUTE_PRESSURE_RECOVERY",
      reason: "PRESSURE_RECOVERED",
      configuredLimit: 2,
      effectiveLimit: 2,
      timestamp: "1970-01-01T00:01:00.000Z"
    }
  ]);
});

test("graph retries only declared reasons with the exact bounded backoff", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const attempts: number[] = [];
  const sleeps: number[] = [];
  const persisted: WorkflowTerminal[] = [];
  const registry = [workflowDefinition("retry.local", {
    retryPolicy: Object.freeze({
      maxAttempts: 2,
      backoffMs: 25,
      retryableReasonCodes: Object.freeze(["POSTGRES_TRANSIENT"])
    })
  })];

  const result = await executeWorkflowGraph({
    registry,
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 1) {
        return { classification: "error", reasonCode: "POSTGRES_TRANSIENT" };
      }
      return { classification: "success", output: { value: "healthy" } };
    },
    persistTerminal: async (terminal) => {
      persisted.push(terminal);
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    }
  });

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(sleeps, [25]);
  assert.equal(result.status, "success");
  assert.equal(result.terminals.length, 1);
  assert.equal(result.terminals[0]?.attempt, 2);
  assert.deepEqual(result.terminals[0]?.output, { value: "healthy" });
  assert.deepEqual(persisted, result.terminals);
});

test("graph backoff is abortable and does not admit another attempt", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const controller = new AbortController();
  const firstAttempt = deferred<void>();
  let attempts = 0;
  const execution = executeWorkflowGraph({
    registry: [workflowDefinition("retry.abort", {
      retryPolicy: Object.freeze({
        maxAttempts: 2,
        backoffMs: 60_000,
        retryableReasonCodes: Object.freeze(["POSTGRES_TRANSIENT"])
      })
    })],
    scheduler: createHealthyScheduler(createBoundedScheduler),
    signal: controller.signal,
    runWorkflow: async () => {
      attempts += 1;
      firstAttempt.resolve();
      return { classification: "error", reasonCode: "POSTGRES_TRANSIENT" };
    },
    persistTerminal: async () => undefined
  });

  await firstAttempt.promise;
  controller.abort();
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "AUTONOMOUS_WORKFLOW_ABORTED"
  );
  assert.equal(attempts, 1);
});

test("PostgreSQL nodes persist inside their gate and dependents wait for persisted terminals", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const databaseRelease = deferred<void>();
  const events: string[] = [];
  const execution = executeWorkflowGraph({
    registry: [
      workflowDefinition("database", { resourceClass: "postgres_serial" }),
      workflowDefinition("parent"),
      workflowDefinition("child", { dependencies: Object.freeze(["parent"]) })
    ],
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async (definition) => {
      events.push(`${definition.id}.run`);
      if (definition.id === "database") await databaseRelease.promise;
      return { classification: "success" };
    },
    persistTerminal: async (terminal) => {
      events.push(`${terminal.workflowId}.persist`);
    }
  });

  await settleAdmissions();
  await settleAdmissions();
  assert.deepEqual(new Set(events), new Set(["database.run", "parent.run"]));

  databaseRelease.resolve();
  const result = await execution;
  assert.ok(events.indexOf("database.persist") > events.indexOf("database.run"));
  assert.ok(events.indexOf("parent.persist") > events.indexOf("database.persist"));
  assert.ok(events.indexOf("child.run") > events.indexOf("parent.persist"));
  assert.ok(events.indexOf("child.persist") > events.indexOf("child.run"));
  assert.deepEqual(result.terminals.map(({ workflowId }) => workflowId), [
    "database",
    "parent",
    "child"
  ]);
});

test("disabled nodes produce decisions, remove edges, and valid scalar bindings become args", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const runs: { id: string; args: readonly string[]; boundInputs?: unknown }[] = [];
  const registry = [
    workflowDefinition("prepare"),
    workflowDefinition("disabled.option"),
    workflowDefinition("finalize", {
      dependencies: Object.freeze(["prepare", "disabled.option"]),
      inputBindings: Object.freeze([Object.freeze({
        argName: "researchRunId",
        fromWorkflowId: "prepare",
        outputField: "researchRunId"
      })])
    })
  ];
  const decisions: readonly WorkflowDecision[] = Object.freeze([
    Object.freeze({ id: "prepare", enableWhen: "always", enabled: true, inactiveDependencyIds: Object.freeze([]) }),
    Object.freeze({
      id: "disabled.option",
      enableWhen: "options_enabled",
      enabled: false,
      inactiveDependencyIds: Object.freeze([])
    }),
    Object.freeze({
      id: "finalize",
      enableWhen: "always",
      enabled: true,
      inactiveDependencyIds: Object.freeze(["disabled.option"])
    })
  ]);

  const result = await executeWorkflowGraph({
    registry,
    decisions,
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async (definition) => {
      runs.push({ id: definition.id, args: definition.args, boundInputs: definition.boundInputs });
      return definition.id === "prepare"
        ? { classification: "success", output: { researchRunId: "research-123" } }
        : { classification: "success" };
    },
    persistTerminal: async () => undefined
  });

  assert.deepEqual(runs.map(({ id }) => id), ["prepare", "finalize"]);
  assert.deepEqual(runs[1], {
    id: "finalize",
    args: ["--researchRunId=research-123"],
    boundInputs: { researchRunId: "research-123" }
  });
  assert.equal(result.terminals.length, 2);
  assert.deepEqual(result.decisions, [{
    type: "registry_decision",
    terminal: false,
    workflowId: "disabled.option",
    enabled: false,
    reasonCode: "WORKFLOW_DISABLED",
    enableWhen: "options_enabled",
    inactiveDependencyIds: []
  }]);
});

test("missing, malformed, oversized, and non-allowlisted bindings terminate only their node", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const cases = [
    { name: "missing", output: {}, outputField: "researchRunId" },
    { name: "malformed", output: { researchRunId: { nested: true } }, outputField: "researchRunId" },
    { name: "oversized", output: { researchRunId: "x".repeat(257) }, outputField: "researchRunId" },
    { name: "non-allowlisted", output: { secret: "value" }, outputField: "secret" }
  ] as const;

  for (const bindingCase of cases) {
    const runs: string[] = [];
    const persisted: WorkflowTerminal[] = [];
    const result = await executeWorkflowGraph({
      registry: [
        workflowDefinition("prepare"),
        workflowDefinition("bound", {
          dependencies: Object.freeze(["prepare"]),
          inputBindings: Object.freeze([Object.freeze({
            argName: "researchRunId",
            fromWorkflowId: "prepare",
            outputField: bindingCase.outputField
          })])
        }),
        workflowDefinition("peer", { dependencies: Object.freeze(["prepare"]) })
      ],
      scheduler: createHealthyScheduler(createBoundedScheduler),
      runWorkflow: async (definition) => {
        runs.push(definition.id);
        return definition.id === "prepare"
          ? { classification: "success", output: bindingCase.output }
          : { classification: "success" };
      },
      persistTerminal: async (terminal) => {
        persisted.push(terminal);
      }
    });

    assert.deepEqual(runs, ["prepare", "peer"], bindingCase.name);
    assert.equal(result.status, "partial", bindingCase.name);
    assert.equal(result.terminals.length, 3, bindingCase.name);
    assert.equal(
      result.terminals.find(({ workflowId }) => workflowId === "bound")?.reasonCode,
      "WORKFLOW_INPUT_BINDING_INVALID",
      bindingCase.name
    );
    assert.equal(persisted.length, 3, bindingCase.name);
  }
});

test("exhausted local retries persist RETRY_EXHAUSTED evidence and later compartments run", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const runs: string[] = [];
  const result = await executeWorkflowGraph({
    registry: [
      workflowDefinition("unstable", {
        retryPolicy: Object.freeze({
          maxAttempts: 2,
          backoffMs: 10,
          retryableReasonCodes: Object.freeze(["POSTGRES_TRANSIENT"])
        })
      }),
      workflowDefinition("later", { dependencies: Object.freeze(["unstable"]) })
    ],
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async (definition) => {
      runs.push(definition.id);
      return definition.id === "unstable"
        ? { classification: "error", reasonCode: "POSTGRES_TRANSIENT" }
        : { classification: "success" };
    },
    persistTerminal: async () => undefined,
    sleep: async () => undefined
  });

  assert.deepEqual(runs, ["unstable", "unstable", "later"]);
  assert.equal(result.status, "partial");
  assert.deepEqual(
    result.terminals.find(({ workflowId }) => workflowId === "unstable"),
    {
      workflowId: "unstable",
      terminal: true,
      classification: "error",
      reasonCode: "RETRY_EXHAUSTED",
      attempt: 2,
      evidence: {
        attempts: 2,
        lastReasonCode: "POSTGRES_TRANSIENT"
      }
    }
  );
  assert.ok(result.terminals.some(({ workflowId }) => workflowId === "later"));
});

test("local failures in each required compartment remain isolated and produce partial cycles", async () => {
  const schedulerModule = await loadSchedulerModule();
  const registryUrl = pathToFileURL(join(repoRoot, "scripts/lib/autonomous-worker-registry.mjs"));
  const registryModule = await import(registryUrl.href) as {
    AUTONOMOUS_WORKFLOW_REGISTRY: readonly WorkflowDefinition[];
  };
  const forcedFailures = [
    "proposal.zero_dte",
    "proposal.leaps",
    "entry.zero_dte",
    "exit.review.hedge"
  ];

  for (const forcedFailure of forcedFailures) {
    const runs: string[] = [];
    const result = await schedulerModule.executeWorkflowGraph({
      registry: registryModule.AUTONOMOUS_WORKFLOW_REGISTRY,
      scheduler: createHealthyScheduler(schedulerModule.createBoundedScheduler),
      runWorkflow: async (definition) => {
        runs.push(definition.id);
        if (definition.id === forcedFailure) {
          const error = new Error("forced local failure") as Error & { code?: string };
          error.code = "LOCAL_FAILURE";
          throw error;
        }
        return definition.id === "research.prepare"
          ? { classification: "success", output: { researchRunId: "research-cycle" } }
          : { classification: "success" };
      },
      persistTerminal: async () => undefined,
      sleep: async () => undefined
    });

    assert.equal(result.status, "partial", forcedFailure);
    assert.equal(result.terminals.length, registryModule.AUTONOMOUS_WORKFLOW_REGISTRY.length, forcedFailure);
    assert.equal(new Set(result.terminals.map(({ workflowId }) => workflowId)).size, result.terminals.length);
    assert.ok(runs.includes("proposal.equity"), forcedFailure);
    assert.ok(runs.includes("proposal.standard_option"), forcedFailure);
    assert.ok(runs.includes("recover.final"), forcedFailure);
    assert.equal(runs.filter((id) => id === forcedFailure).length, 1, forcedFailure);
    assert.equal(
      result.terminals.find(({ workflowId }) => workflowId === forcedFailure)?.reasonCode,
      "LOCAL_FAILURE",
      forcedFailure
    );
  }
});

test("no-action and timeout terminals do not cancel dependent or peer compartments", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const runs: string[] = [];
  const registry = [
    workflowDefinition("no.action"),
    workflowDefinition("timed.out", { timeoutMs: 10 }),
    workflowDefinition("after.no.action", { dependencies: Object.freeze(["no.action"]) }),
    workflowDefinition("after.timeout", { dependencies: Object.freeze(["timed.out"]) }),
    workflowDefinition("peer")
  ];
  const result = await executeWorkflowGraph({
    registry,
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async (definition, signal) => {
      runs.push(definition.id);
      if (definition.id === "no.action") {
        return { classification: "no_action", reasonCode: "NOTHING_TO_DO" };
      }
      if (definition.id === "timed.out") {
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(
          Object.assign(new Error("timed out"), { code: "WORKFLOW_TIMEOUT" })
        ), { once: true }));
      }
      return { classification: "success" };
    },
    persistTerminal: async () => undefined
  });

  assert.equal(result.status, "partial");
  assert.ok(runs.includes("after.no.action"));
  assert.ok(runs.includes("after.timeout"));
  assert.ok(runs.includes("peer"));
  assert.equal(
    result.terminals.find(({ workflowId }) => workflowId === "timed.out")?.reasonCode,
    "WORKFLOW_TIMEOUT"
  );
});

test("indeterminate broker mutation is never retried and latches later mutation only", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const runs: string[] = [];
  const brokerRetryPolicy = Object.freeze({
    maxAttempts: 2,
    backoffMs: 1,
    retryableReasonCodes: Object.freeze(["POSTGRES_TRANSIENT"])
  });
  const registry = [
    workflowDefinition("entry.indeterminate", {
      resourceClass: "broker_mutation",
      retryPolicy: brokerRetryPolicy
    }),
    workflowDefinition("entry.queued", {
      resourceClass: "broker_mutation",
      retryPolicy: brokerRetryPolicy
    }),
    workflowDefinition("reconcile", {
      resourceClass: "postgres_serial",
      dependencies: Object.freeze(["entry.indeterminate", "entry.queued"])
    }),
    workflowDefinition("mutation.later", {
      resourceClass: "broker_mutation",
      dependencies: Object.freeze(["reconcile"]),
      retryPolicy: brokerRetryPolicy
    }),
    workflowDefinition("recover", {
      resourceClass: "postgres_serial",
      dependencies: Object.freeze(["reconcile", "mutation.later"])
    })
  ];

  const result = await executeWorkflowGraph({
    registry,
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async (definition) => {
      runs.push(definition.id);
      return definition.id === "entry.indeterminate"
        ? {
          classification: "mutation_indeterminate",
          reasonCode: "BROKER_MUTATION_INDETERMINATE",
          submissionMayHaveOccurred: true
        }
        : { classification: "success" };
    },
    persistTerminal: async () => undefined,
    sleep: async () => undefined
  });

  assert.equal(runs.filter((id) => id === "entry.indeterminate").length, 1);
  assert.ok(!runs.includes("entry.queued"));
  assert.ok(runs.includes("reconcile"));
  assert.ok(!runs.includes("mutation.later"));
  assert.ok(runs.includes("recover"));
  assert.equal(result.status, "partial");
  assert.equal(result.terminals.length, registry.length);
  assert.equal(
    result.terminals.find(({ workflowId }) => workflowId === "entry.queued")?.reasonCode,
    "BROKER_MUTATION_LATCHED"
  );
  assert.equal(
    result.terminals.find(({ workflowId }) => workflowId === "mutation.later")?.reasonCode,
    "BROKER_MUTATION_LATCHED"
  );
});

test("omitted concurrency fields default to the safe two-slot and one-slot bounds", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();
  const scheduler = createBoundedScheduler({
    samplePressure: () => ({ pressure: false, reasons: [] }),
    emit: () => undefined
  });
  const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
  const starts: string[] = [];
  const runs = ["first", "second", "third"].map((workflowId, index) => scheduler.run(
    { workflowId, resourceClass: "compute_readonly" },
    async () => {
      starts.push(workflowId);
      await releases[index]!.promise;
    }
  ));

  await settleAdmissions();
  assert.deepEqual(starts, ["first", "second"]);
  releases[0]!.resolve();
  await settleAdmissions();
  assert.deepEqual(starts, ["first", "second", "third"]);
  releases[1]!.resolve();
  releases[2]!.resolve();
  await Promise.all(runs);
});

test("mixed non-mutating resource classes share the hard two-workflow cap", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();
  const scheduler = createHealthyScheduler(createBoundedScheduler);
  const definitions = [
    { workflowId: "shared", resourceClass: "shared_context" as const },
    { workflowId: "compute", resourceClass: "compute_readonly" as const },
    { workflowId: "postgres", resourceClass: "postgres_serial" as const }
  ];
  const releases = definitions.map(() => deferred<void>());
  const starts: string[] = [];
  let active = 0;
  let maximumObserved = 0;
  const runs = definitions.map((definition, index) => scheduler.run(definition, async () => {
    starts.push(definition.workflowId);
    active += 1;
    maximumObserved = Math.max(maximumObserved, active);
    await releases[index]!.promise;
    active -= 1;
  }));

  await settleAdmissions();
  assert.deepEqual(new Set(starts), new Set(["shared", "compute"]));
  assert.equal(maximumObserved, 2);
  releases[1]!.resolve();
  await settleAdmissions();
  assert.ok(starts.includes("postgres"));
  assert.equal(maximumObserved, 2);
  releases[0]!.resolve();
  releases[2]!.resolve();
  await Promise.all(runs);
});

test("aborting a nested-gate waiter frees its outer slot without starting its operation", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();
  const scheduler = createHealthyScheduler(createBoundedScheduler);
  const firstRelease = deferred<void>();
  const computeRelease = deferred<void>();
  const controller = new AbortController();
  const starts: string[] = [];
  const first = scheduler.run(
    { workflowId: "shared.first", resourceClass: "shared_context" },
    async () => {
      starts.push("shared.first");
      await firstRelease.promise;
    }
  );
  const queued = scheduler.run(
    {
      workflowId: "shared.aborted",
      resourceClass: "shared_context",
      signal: controller.signal
    },
    async () => {
      starts.push("shared.aborted");
    }
  );
  const queuedRejection = assert.rejects(
    queued,
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "AUTONOMOUS_WORKFLOW_ABORTED"
  );
  const compute = scheduler.run(
    { workflowId: "compute.after-abort", resourceClass: "compute_readonly" },
    async () => {
      starts.push("compute.after-abort");
      await computeRelease.promise;
    }
  );

  await settleAdmissions();
  assert.deepEqual(starts, ["shared.first"]);
  controller.abort();
  await queuedRejection;
  await settleAdmissions();
  assert.deepEqual(starts, ["shared.first", "compute.after-abort"]);
  firstRelease.resolve();
  computeRelease.resolve();
  await Promise.all([first, compute]);
});

test("pressure telemetry bounds an injected malformed reason without exposing it", async () => {
  const { createBoundedScheduler } = await loadSchedulerModule();
  const sensitiveReason = `credential=${"x".repeat(512)}\nsecond-line`;
  const events: unknown[] = [];
  const scheduler = createBoundedScheduler({
    configuredConcurrency: 2,
    minimumConcurrency: 1,
    maximumConcurrency: 2,
    samplePressure: () => ({ pressure: true, reasons: [sensitiveReason] }),
    emit: (event) => events.push(event),
    now: () => 0
  });

  await scheduler.run(
    { workflowId: "pressure", resourceClass: "compute_readonly" },
    async () => undefined
  );
  assert.deepEqual(events, [{
    type: "AUTONOMOUS_COMPUTE_PRESSURE_FALLBACK",
    reason: "RESOURCE_PRESSURE",
    configuredLimit: 2,
    effectiveLimit: 1,
    timestamp: "1970-01-01T00:00:00.000Z"
  }]);
  assert.doesNotMatch(JSON.stringify(events), /credential|second-line/);
});

test("malformed workflow classifications become fail-closed error terminals", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const result = await executeWorkflowGraph({
    registry: [workflowDefinition("malformed")],
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async () => ({ classification: "definitely_successful" }),
    persistTerminal: async () => undefined
  });

  assert.equal(result.status, "partial");
  assert.deepEqual(result.terminals, [{
    workflowId: "malformed",
    terminal: true,
    classification: "error",
    reasonCode: "WORKFLOW_RESULT_INVALID",
    attempt: 1
  }]);
});

test("a timed-out broker mutation holds ownership until quiescent and latches later mutation", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const timeoutObserved = deferred<void>();
  const quiesce = deferred<void>();
  const runs: string[] = [];
  let graphSettled = false;
  let activeBrokerCalls = 0;
  const execution = executeWorkflowGraph({
    registry: [
      workflowDefinition("broker.timeout", {
        resourceClass: "broker_mutation",
        timeoutMs: 10
      }),
      workflowDefinition("broker.later", { resourceClass: "broker_mutation" }),
      workflowDefinition("reconcile", {
        resourceClass: "postgres_serial",
        dependencies: Object.freeze(["broker.timeout", "broker.later"])
      })
    ],
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async (definition, signal) => {
      runs.push(definition.id);
      if (definition.id !== "broker.timeout") return { classification: "success" };
      activeBrokerCalls += 1;
      signal.addEventListener("abort", () => timeoutObserved.resolve(), { once: true });
      await quiesce.promise;
      activeBrokerCalls -= 1;
      return { classification: "success" };
    },
    persistTerminal: async () => undefined
  });
  void execution.then(
    () => { graphSettled = true; },
    () => { graphSettled = true; }
  );

  await timeoutObserved.promise;
  await settleAdmissions();
  assert.equal(graphSettled, false);
  assert.equal(activeBrokerCalls, 1);
  assert.deepEqual(runs, ["broker.timeout"]);

  quiesce.resolve();
  const result = await execution;
  assert.equal(activeBrokerCalls, 0);
  assert.ok(!runs.includes("broker.later"));
  assert.ok(runs.includes("reconcile"));
  assert.equal(
    result.terminals.find(({ workflowId }) => workflowId === "broker.timeout")?.classification,
    "mutation_indeterminate"
  );
  assert.equal(
    result.terminals.find(({ workflowId }) => workflowId === "broker.timeout")?.reasonCode,
    "BROKER_MUTATION_INDETERMINATE"
  );
  assert.equal(
    result.terminals.find(({ workflowId }) => workflowId === "broker.timeout")
      ?.evidence?.sourceReasonCode,
    "WORKFLOW_TIMEOUT"
  );
});

test("a thrown broker uncertainty marker latches later mutation", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const runs: string[] = [];
  const result = await executeWorkflowGraph({
    registry: [
      workflowDefinition("broker.unknown", { resourceClass: "broker_mutation" }),
      workflowDefinition("broker.later", { resourceClass: "broker_mutation" }),
      workflowDefinition("recover", {
        resourceClass: "postgres_serial",
        dependencies: Object.freeze(["broker.unknown", "broker.later"])
      })
    ],
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async (definition) => {
      runs.push(definition.id);
      if (definition.id === "broker.unknown") {
        throw Object.assign(new Error("transport response unknown"), {
          code: "BROKER_TRANSPORT_UNKNOWN",
          submissionMayHaveOccurred: true
        });
      }
      return { classification: "success" };
    },
    persistTerminal: async () => undefined
  });

  assert.deepEqual(runs, ["broker.unknown", "recover"]);
  assert.equal(result.terminals[0]?.classification, "mutation_indeterminate");
  assert.equal(result.terminals[0]?.reasonCode, "BROKER_MUTATION_INDETERMINATE");
  assert.equal(result.terminals[0]?.evidence?.sourceReasonCode, "BROKER_TRANSPORT_UNKNOWN");
  assert.equal(result.terminals[1]?.reasonCode, "BROKER_MUTATION_LATCHED");
});

test("returned broker timeout uncertainty is normalized before later admission", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const runs: string[] = [];
  const result = await executeWorkflowGraph({
    registry: [
      workflowDefinition("broker.timeout-result", { resourceClass: "broker_mutation" }),
      workflowDefinition("broker.later", { resourceClass: "broker_mutation" })
    ],
    scheduler: createHealthyScheduler(createBoundedScheduler),
    runWorkflow: async (definition) => {
      runs.push(definition.id);
      return definition.id === "broker.timeout-result"
        ? {
          classification: "error",
          reasonCode: "WORKFLOW_TIMEOUT",
          submissionMayHaveOccurred: true
        }
        : { classification: "success" };
    },
    persistTerminal: async () => undefined
  });

  assert.deepEqual(runs, ["broker.timeout-result"]);
  assert.equal(result.terminals[0]?.classification, "mutation_indeterminate");
  assert.equal(result.terminals[0]?.reasonCode, "BROKER_MUTATION_INDETERMINATE");
  assert.equal(result.terminals[0]?.evidence?.sourceReasonCode, "WORKFLOW_TIMEOUT");
  assert.equal(result.terminals[1]?.reasonCode, "BROKER_MUTATION_LATCHED");
});

test("terminal persistence failure aborts and drains active work before graph rejection", async () => {
  const { createBoundedScheduler, executeWorkflowGraph } = await loadSchedulerModule();
  const externalController = new AbortController();
  const persistenceFailed = deferred<void>();
  const quiesce = deferred<void>();
  const runs: string[] = [];
  let activeWorkflows = 0;
  let activePersistence = 0;
  let graphSettled = false;
  let cancellationWasObserved = false;
  const execution = executeWorkflowGraph({
    registry: [
      workflowDefinition("persist.fails", { resourceClass: "postgres_serial" }),
      workflowDefinition("active.peer"),
      workflowDefinition("must.not.start")
    ],
    scheduler: createHealthyScheduler(createBoundedScheduler),
    signal: externalController.signal,
    runWorkflow: async (definition, signal) => {
      runs.push(definition.id);
      activeWorkflows += 1;
      if (definition.id === "active.peer") {
        await new Promise<void>((_, reject) => signal.addEventListener("abort", async () => {
          cancellationWasObserved = true;
          await quiesce.promise;
          activeWorkflows -= 1;
          reject(Object.assign(new Error("cycle aborted"), {
            code: "AUTONOMOUS_WORKFLOW_ABORTED"
          }));
        }, { once: true }));
      }
      activeWorkflows -= 1;
      return { classification: "success" };
    },
    persistTerminal: async (terminal) => {
      activePersistence += 1;
      try {
        if (terminal.workflowId === "persist.fails") {
          persistenceFailed.resolve();
          throw Object.assign(new Error("database unavailable"), {
            code: "POSTGRES_TRANSIENT"
          });
        }
      } finally {
        activePersistence -= 1;
      }
    }
  });
  void execution.then(
    () => { graphSettled = true; },
    () => { graphSettled = true; }
  );

  await persistenceFailed.promise;
  await settleAdmissions();
  let preDrainFailure: unknown;
  try {
    assert.equal(graphSettled, false);
    assert.equal(cancellationWasObserved, true);
    assert.deepEqual(new Set(runs), new Set(["persist.fails", "active.peer"]));
    assert.equal(activeWorkflows, 1);
    assert.equal(activePersistence, 0);
  } catch (error) {
    preDrainFailure = error;
  }

  quiesce.resolve();
  externalController.abort();
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "WORKFLOW_TERMINAL_PERSISTENCE_FAILED"
  );
  assert.equal(activeWorkflows, 0);
  assert.equal(activePersistence, 0);
  assert.ok(!runs.includes("must.not.start"));
  if (preDrainFailure) throw preDrainFailure;
});
