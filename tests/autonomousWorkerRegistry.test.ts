import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type ResourceClass =
  | "shared_context"
  | "compute_readonly"
  | "postgres_serial"
  | "broker_mutation";

type WorkflowDefinition = {
  readonly id: string;
  readonly schedulerIdentity: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly compartment: string;
  readonly lane: string;
  readonly phase: string;
  readonly dependencies: readonly string[];
  readonly resourceClass: ResourceClass;
  readonly enableWhen: string;
  readonly requiredRuntimeFlags: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly retryPolicy: {
    readonly maxAttempts: number;
    readonly backoffMs: number;
    readonly retryableReasonCodes: readonly string[];
  };
  readonly expectedNoActionReasons: readonly string[];
  readonly failureScope: string;
  readonly sharedContextPhase: string | null;
  readonly inputBindings: readonly {
    readonly argName: string;
    readonly fromWorkflowId: string;
    readonly outputField: string;
  }[];
};

type RegistryModule = {
  readonly AUTONOMOUS_WORKFLOW_REGISTRY: readonly WorkflowDefinition[];
  readonly BROKER_MUTATION_COMMANDS: readonly string[];
  readonly STATE_COMMAND: string;
  readonly validateWorkflowRegistry: (input: {
    readonly registry?: readonly WorkflowDefinition[];
    readonly packageScripts: Readonly<Record<string, string>>;
    readonly commandContract: Readonly<Record<string, unknown>>;
  }) => true;
  readonly freezeWorkflowCycleEnablement: (input: {
    readonly registry?: readonly WorkflowDefinition[];
    readonly startupFlags: {
      readonly optionsEnabled: boolean;
      readonly hedgingEnabled: boolean;
    };
  }) => {
    readonly startupFlags: {
      readonly optionsEnabled: boolean;
      readonly hedgingEnabled: boolean;
    };
    readonly enabledNodes: readonly (WorkflowDefinition & {
      readonly dependencies: readonly string[];
    })[];
    readonly decisions: readonly {
      readonly id: string;
      readonly enableWhen: string;
      readonly enabled: boolean;
      readonly inactiveDependencyIds: readonly string[];
    }[];
  };
};

const repoRoot = process.cwd();

const loadRegistryModule = async () => {
  const url = pathToFileURL(join(repoRoot, "scripts/lib/autonomous-worker-registry.mjs"));
  return import(url.href) as Promise<RegistryModule>;
};

const readRepositoryContract = () => ({
  packageScripts: (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }).scripts,
  commandContract: JSON.parse(readFileSync(
    join(repoRoot, "scripts/autonomous-worker-command-contract.json"),
    "utf8"
  )) as Record<string, unknown>
});

const directDependencies = {
  "reconcile.initial": [],
  "research.prepare": ["reconcile.initial"],
  "options.discover": ["evidence.refresh"],
  "proposal.equity": ["research.prepare"],
  "proposal.standard_option": ["research.prepare"],
  "proposal.zero_dte": ["research.prepare"],
  "proposal.leaps": ["research.prepare"],
  "research.finalize": [
    "research.prepare",
    "proposal.equity",
    "proposal.standard_option",
    "proposal.zero_dte",
    "proposal.leaps"
  ],
  "evidence.refresh": ["research.finalize"],
  "exit.review.paper": ["reconcile.initial"],
  "exit.review.zero_dte": ["reconcile.initial"],
  "exit.review.hedge": ["reconcile.initial"],
  "review.general": ["research.finalize", "options.discover"],
  "review.portfolio": ["review.general"],
  "review.operations": ["review.portfolio"],
  "review.hedge": ["review.portfolio"],
  "entry.paper": ["review.operations", "review.hedge"],
  "entry.zero_dte": ["review.operations", "review.hedge"],
  "reconcile.entries": ["entry.paper", "entry.zero_dte"],
  "exit.execute.paper": [
    "exit.review.paper",
    "exit.review.zero_dte",
    "reconcile.entries"
  ],
  "exit.execute.hedge": ["exit.review.hedge", "reconcile.entries"],
  "reconcile.exits": ["exit.execute.paper", "exit.execute.hedge"],
  "cancel.orders": ["reconcile.exits"],
  "reconcile.final": ["cancel.orders"],
  "learn.paper": ["reconcile.final", "research.finalize", "options.discover"],
  "recover.final": [
    "reconcile.initial",
    "research.prepare",
    "options.discover",
    "proposal.equity",
    "proposal.standard_option",
    "proposal.zero_dte",
    "proposal.leaps",
    "research.finalize",
    "evidence.refresh",
    "exit.review.paper",
    "exit.review.zero_dte",
    "exit.review.hedge",
    "review.general",
    "review.portfolio",
    "review.operations",
    "review.hedge",
    "entry.paper",
    "entry.zero_dte",
    "reconcile.entries",
    "exit.execute.paper",
    "exit.execute.hedge",
    "reconcile.exits",
    "cancel.orders",
    "reconcile.final",
    "learn.paper"
  ]
} as const;

const requiredCommands = new Set([
  "zero-dte:reconcile",
  "research:daily",
  "paper:evidence:refresh",
  "paper:options:discover",
  "paper:review",
  "paper:portfolio:review",
  "paper:ops:review",
  "hedge:review",
  "paper:execute:reviewed",
  "zero-dte:engine",
  "paper:exit:review",
  "zero-dte:exit:review",
  "hedge:exit:review",
  "paper:exit:execute",
  "hedge:exit:execute",
  "paper:order:cancel",
  "paper:learn",
  "system:recover",
  "worker:state"
]);

const brokerCommands = new Set([
  "paper:execute:reviewed",
  "zero-dte:engine",
  "paper:exit:execute",
  "hedge:exit:execute",
  "paper:order:cancel"
]);

const mutableRegistry = (registry: readonly WorkflowDefinition[]) =>
  structuredClone(registry) as unknown as WorkflowDefinition[];

test("registry declares the exact immutable readiness graph and command contract", async () => {
  const module = await loadRegistryModule();
  const registry = module.AUTONOMOUS_WORKFLOW_REGISTRY;

  assert.equal(module.STATE_COMMAND, "worker:state");
  assert.deepEqual(new Set([...registry.map(({ command }) => command), module.STATE_COMMAND]), requiredCommands);
  assert.equal(new Set(registry.map(({ id }) => id)).size, registry.length);
  assert.equal(new Set(registry.map(({ schedulerIdentity }) => schedulerIdentity)).size, registry.length);
  assert.deepEqual(
    Object.fromEntries(registry.map(({ id, dependencies }) => [id, dependencies])),
    directDependencies
  );
  assert.deepEqual(new Set(module.BROKER_MUTATION_COMMANDS), brokerCommands);
  assert.deepEqual(
    new Set(registry.filter(({ resourceClass }) => resourceClass === "broker_mutation")
      .map(({ command }) => command)),
    brokerCommands
  );
  assert.equal(registry.length, Object.keys(directDependencies).length);
  assert.equal(Object.isFrozen(registry), true);
  for (const definition of registry) {
    assert.equal(Object.isFrozen(definition), true, definition.id);
    assert.equal(Object.isFrozen(definition.args), true, definition.id);
    assert.equal(Object.isFrozen(definition.dependencies), true, definition.id);
    assert.equal(Object.isFrozen(definition.requiredRuntimeFlags), true, definition.id);
    assert.equal(Object.isFrozen(definition.retryPolicy), true, definition.id);
    assert.equal(Object.isFrozen(definition.retryPolicy.retryableReasonCodes), true, definition.id);
    assert.equal(Object.isFrozen(definition.expectedNoActionReasons), true, definition.id);
    assert.equal(Object.isFrozen(definition.inputBindings), true, definition.id);
    assert.ok(definition.inputBindings.every(Object.isFrozen), definition.id);
  }

  const boundNodes = registry.filter(({ inputBindings }) => inputBindings.length > 0);
  assert.deepEqual(
    boundNodes.map(({ id }) => id),
    [
      "proposal.equity",
      "proposal.standard_option",
      "proposal.zero_dte",
      "proposal.leaps",
      "research.finalize"
    ]
  );
  assert.ok(boundNodes.every(({ inputBindings }) =>
    inputBindings.length === 1 &&
    inputBindings[0]?.argName === "researchRunId" &&
    inputBindings[0]?.fromWorkflowId === "research.prepare" &&
    inputBindings[0]?.outputField === "researchRunId"
  ));

  assert.equal(module.validateWorkflowRegistry({
    registry,
    ...readRepositoryContract()
  }), true);
});

test("registry validation rejects graph, retry, binding, and privilege drift", async () => {
  const module = await loadRegistryModule();
  const contract = readRepositoryContract();

  const duplicate = mutableRegistry(module.AUTONOMOUS_WORKFLOW_REGISTRY);
  duplicate[1] = { ...duplicate[1]!, id: duplicate[0]!.id };
  assert.throws(
    () => module.validateWorkflowRegistry({ registry: duplicate, ...contract }),
    /AUTONOMOUS_WORKFLOW_REGISTRY_ID_DUPLICATE/
  );

  const cyclic = mutableRegistry(module.AUTONOMOUS_WORKFLOW_REGISTRY);
  cyclic[0] = { ...cyclic[0]!, dependencies: ["recover.final"] };
  assert.throws(
    () => module.validateWorkflowRegistry({ registry: cyclic, ...contract }),
    /AUTONOMOUS_WORKFLOW_REGISTRY_CYCLE/
  );

  const unsafePrivilege = mutableRegistry(module.AUTONOMOUS_WORKFLOW_REGISTRY);
  const equityIndex = unsafePrivilege.findIndex(({ id }) => id === "proposal.equity");
  unsafePrivilege[equityIndex] = {
    ...unsafePrivilege[equityIndex]!,
    resourceClass: "broker_mutation"
  };
  assert.throws(
    () => module.validateWorkflowRegistry({ registry: unsafePrivilege, ...contract }),
    /AUTONOMOUS_WORKFLOW_REGISTRY_PRIVILEGE_INVALID/
  );

  const unboundedRetry = mutableRegistry(module.AUTONOMOUS_WORKFLOW_REGISTRY);
  unboundedRetry[0] = {
    ...unboundedRetry[0]!,
    retryPolicy: { maxAttempts: 4, backoffMs: 1_000, retryableReasonCodes: [] }
  };
  assert.throws(
    () => module.validateWorkflowRegistry({ registry: unboundedRetry, ...contract }),
    /AUTONOMOUS_WORKFLOW_REGISTRY_RETRY_INVALID/
  );

  const missingBindingDependency = mutableRegistry(module.AUTONOMOUS_WORKFLOW_REGISTRY);
  const proposalIndex = missingBindingDependency.findIndex(({ id }) => id === "proposal.equity");
  missingBindingDependency[proposalIndex] = {
    ...missingBindingDependency[proposalIndex]!,
    dependencies: [],
    inputBindings: [{
      argName: "researchRunId",
      fromWorkflowId: "research.prepare",
      outputField: "researchRunId"
    }]
  };
  assert.throws(
    () => module.validateWorkflowRegistry({ registry: missingBindingDependency, ...contract }),
    /AUTONOMOUS_WORKFLOW_REGISTRY_BINDING_INVALID/
  );

  const missingCommand = {
    ...contract.commandContract,
    commands: {
      ...(contract.commandContract.commands as Record<string, unknown>)
    }
  };
  delete (missingCommand.commands as Record<string, unknown>)["system:recover"];
  assert.throws(
    () => module.validateWorkflowRegistry({
      registry: module.AUTONOMOUS_WORKFLOW_REGISTRY,
      packageScripts: contract.packageScripts,
      commandContract: missingCommand
    }),
    /AUTONOMOUS_WORKFLOW_COMMAND_CONTRACT_INVALID/
  );
});

test("registry validation rejects a broker mutation missing either execution enablement flag", async () => {
  const module = await loadRegistryModule();
  const contract = readRepositoryContract();

  for (const missingFlag of [
    "PAPER_ORDER_EXECUTION_ENABLED",
    "AUTOMATED_PAPER_EXECUTION_ENABLED"
  ]) {
    const incompleteBrokerFlags = mutableRegistry(module.AUTONOMOUS_WORKFLOW_REGISTRY);
    const brokerIndex = incompleteBrokerFlags.findIndex(({ id }) => id === "entry.paper");
    const requiredRuntimeFlags = { ...incompleteBrokerFlags[brokerIndex]!.requiredRuntimeFlags };
    delete requiredRuntimeFlags[missingFlag];
    incompleteBrokerFlags[brokerIndex] = {
      ...incompleteBrokerFlags[brokerIndex]!,
      requiredRuntimeFlags
    };

    assert.throws(
      () => module.validateWorkflowRegistry({ registry: incompleteBrokerFlags, ...contract }),
      /AUTONOMOUS_WORKFLOW_REGISTRY_RUNTIME_FLAGS_INVALID/
    );
  }
});

test("startup enablement freezes one sanitized decision per node and removes disabled dependency edges", async () => {
  const module = await loadRegistryModule();
  const plan = module.freezeWorkflowCycleEnablement({
    startupFlags: { optionsEnabled: false, hedgingEnabled: false }
  });

  assert.deepEqual(plan.startupFlags, { optionsEnabled: false, hedgingEnabled: false });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.startupFlags), true);
  assert.equal(Object.isFrozen(plan.enabledNodes), true);
  assert.equal(Object.isFrozen(plan.decisions), true);
  assert.equal(plan.decisions.length, module.AUTONOMOUS_WORKFLOW_REGISTRY.length);
  assert.ok(plan.decisions.every(Object.isFrozen));
  assert.deepEqual(
    plan.enabledNodes.map(({ id }) => id),
    module.AUTONOMOUS_WORKFLOW_REGISTRY
      .filter(({ enableWhen }) => enableWhen === "always")
      .map(({ id }) => id)
  );
  assert.deepEqual(
    Object.fromEntries(plan.decisions.map(({ id, enableWhen, enabled, inactiveDependencyIds }) => [
      id,
      { enableWhen, enabled, inactiveDependencyIds }
    ])),
    Object.fromEntries(module.AUTONOMOUS_WORKFLOW_REGISTRY.map(({ id, enableWhen, dependencies }) => [
      id,
      {
        enableWhen,
        enabled: enableWhen === "always",
        inactiveDependencyIds: dependencies.filter((dependencyId) => {
          const dependency = module.AUTONOMOUS_WORKFLOW_REGISTRY.find(({ id }) => id === dependencyId)!;
          return dependency.enableWhen !== "always";
        })
      }
    ]))
  );
  assert.deepEqual(
    plan.enabledNodes.find(({ id }) => id === "research.finalize")!.dependencies,
    ["research.prepare", "proposal.equity"]
  );
  assert.deepEqual(
    plan.enabledNodes.find(({ id }) => id === "review.general")!.dependencies,
    ["research.finalize"]
  );
  assert.deepEqual(
    plan.enabledNodes.find(({ id }) => id === "entry.paper")!.dependencies,
    ["review.operations"]
  );
});

test("startup enablement uses validated option flags without hard-coded always-stage options args", async () => {
  const module = await loadRegistryModule();
  const plan = module.freezeWorkflowCycleEnablement({
    startupFlags: { optionsEnabled: true, hedgingEnabled: false }
  });

  assert.ok(plan.enabledNodes.some(({ id }) => id === "options.discover"));
  assert.ok(plan.enabledNodes.some(({ id }) => id === "entry.zero_dte"));
  assert.ok(!plan.enabledNodes.some(({ id }) => id === "review.hedge"));
  assert.ok(module.AUTONOMOUS_WORKFLOW_REGISTRY
    .filter(({ enableWhen }) => enableWhen === "always")
    .every(({ args }) => !args.includes("--optionsEnabled=true")));
  assert.throws(
    () => module.freezeWorkflowCycleEnablement({
      startupFlags: { optionsEnabled: "false" as unknown as boolean, hedgingEnabled: false }
    }),
    /AUTONOMOUS_WORKFLOW_STARTUP_FLAGS_INVALID/
  );
});

test("runtime code cannot mutate registry metadata", async () => {
  const { AUTONOMOUS_WORKFLOW_REGISTRY: registry } = await loadRegistryModule();
  const first = registry[0]!;
  const originalId = first.id;
  const originalDependencyCount = first.dependencies.length;

  assert.throws(() => {
    (first as { id: string }).id = "runtime.override";
  }, TypeError);
  assert.throws(() => {
    (first.dependencies as string[]).push("runtime.override");
  }, TypeError);
  assert.equal(first.id, originalId);
  assert.equal(first.dependencies.length, originalDependencyCount);
});
