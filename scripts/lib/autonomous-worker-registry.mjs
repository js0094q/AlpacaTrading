function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const STATE_COMMAND = "worker:state";

const BROKER_MUTATION_COMMANDS = deepFreeze([
  "paper:execute:reviewed",
  "zero-dte:engine",
  "paper:exit:execute",
  "hedge:exit:execute",
  "paper:order:cancel"
]);

const EXPECTED_COMMANDS = new Set([
  "zero-dte:reconcile",
  "research:daily",
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
  STATE_COMMAND
]);

const RESOURCE_CLASSES = new Set([
  "shared_context",
  "compute_readonly",
  "postgres_serial",
  "broker_mutation"
]);
const ENABLE_PREDICATES = new Set([
  "always",
  "options_enabled",
  "hedging_enabled"
]);
const FAILURE_SCOPES = new Set(["local", "global_mutation_block"]);
const RETRYABLE_REASON_CODES = new Set([
  "POSTGRES_TRANSIENT",
  "PROVIDER_THROTTLED",
  "WORKFLOW_TIMEOUT"
]);
const EXPECTED_NO_ACTION_REASONS = new Set([
  "NO_ELIGIBLE_POSTGRES_CANDIDATES",
  "NO_POSTGRES_EXIT_TRIGGER",
  "NO_READY_POSTGRES_ORDER_INTENTS",
  "NO_CANCELLABLE_POSTGRES_ORDERS",
  "NO_RECONCILIABLE_POSTGRES_ORDERS",
  "NO_BOUNDED_OUTCOME_SOURCES",
  "OUTCOME_LEARNING_REPLAY_UNCHANGED",
  "NO_RECOVERABLE_POSTGRES_STATE"
]);

const BASE_RUNTIME_FLAGS = deepFreeze({
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false",
  DATABASE_BACKEND: "postgres",
  POSTGRES_READS_ENABLED: "true",
  POSTGRES_WRITES_ENABLED: "true",
  POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "true",
  POSTGRES_SCHEDULER_AUTHORITY_ENABLED: "true",
  POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED: "true",
  POSTGRES_SHADOW_COMPARE_ENABLED: "false",
  POSTGRES_EXECUTION_STATE_SHADOW_ENABLED: "false",
  SQLITE_AUDIT_MIRROR_ENABLED: "false"
});

const BROKER_RUNTIME_FLAGS = deepFreeze({
  ...BASE_RUNTIME_FLAGS,
  PAPER_ORDER_EXECUTION_ENABLED: "true",
  AUTOMATED_PAPER_EXECUTION_ENABLED: "true"
});

const LOCAL_RETRY = deepFreeze({
  maxAttempts: 2,
  backoffMs: 1_000,
  retryableReasonCodes: [
    "POSTGRES_TRANSIENT",
    "PROVIDER_THROTTLED",
    "WORKFLOW_TIMEOUT"
  ]
});
const NO_MUTATION_RETRY = deepFreeze({
  maxAttempts: 1,
  backoffMs: 0,
  retryableReasonCodes: []
});

const noAction = (...reasonCodes) => reasonCodes;
const researchBinding = () => [{
  argName: "researchRunId",
  fromWorkflowId: "research.prepare",
  outputField: "researchRunId"
}];

const workflow = (definition) => deepFreeze({
  timeoutMs: 30 * 60 * 1_000,
  retryPolicy: LOCAL_RETRY,
  expectedNoActionReasons: [],
  failureScope: "local",
  sharedContextPhase: null,
  inputBindings: [],
  requiredRuntimeFlags: BASE_RUNTIME_FLAGS,
  ...definition
});

const AUTONOMOUS_WORKFLOW_REGISTRY = deepFreeze([
  workflow({
    id: "reconcile.initial",
    schedulerIdentity: "reconcile.initial",
    command: "zero-dte:reconcile",
    args: ["--format=json"],
    compartment: "reconciliation",
    lane: "shared",
    phase: "initial",
    dependencies: [],
    resourceClass: "postgres_serial",
    enableWhen: "always",
    failureScope: "global_mutation_block",
    expectedNoActionReasons: noAction("NO_RECONCILIABLE_POSTGRES_ORDERS")
  }),
  workflow({
    id: "research.prepare",
    schedulerIdentity: "research.prepare",
    command: "research:daily",
    args: [
      "--stage=prepare",
      "--riskProfile=aggressive",
      "--maxCandidates=25",
      "--assetClass=all",
      "--format=json"
    ],
    compartment: "research",
    lane: "shared",
    phase: "prepare",
    dependencies: ["reconcile.initial"],
    resourceClass: "shared_context",
    enableWhen: "always",
    sharedContextPhase: "prepare"
  }),
  workflow({
    id: "options.discover",
    schedulerIdentity: "options.discover",
    command: "paper:options:discover",
    args: ["--underlying=SPY", "--dte=0", "--format=json"],
    compartment: "options_discovery",
    lane: "options_0dte",
    phase: "discover",
    dependencies: ["reconcile.initial"],
    resourceClass: "compute_readonly",
    enableWhen: "options_enabled",
    expectedNoActionReasons: noAction("NO_ELIGIBLE_POSTGRES_CANDIDATES")
  }),
  workflow({
    id: "proposal.equity",
    schedulerIdentity: "proposal.equity",
    command: "research:daily",
    args: ["--stage=lane", "--lane=equity", "--format=json"],
    compartment: "proposal",
    lane: "equity",
    phase: "lane",
    dependencies: ["research.prepare"],
    resourceClass: "compute_readonly",
    enableWhen: "always",
    sharedContextPhase: "lane",
    inputBindings: researchBinding(),
    expectedNoActionReasons: noAction("NO_ELIGIBLE_POSTGRES_CANDIDATES")
  }),
  workflow({
    id: "proposal.standard_option",
    schedulerIdentity: "proposal.standard_option",
    command: "research:daily",
    args: ["--stage=lane", "--lane=options_standard", "--format=json"],
    compartment: "proposal",
    lane: "options_standard",
    phase: "lane",
    dependencies: ["research.prepare"],
    resourceClass: "compute_readonly",
    enableWhen: "options_enabled",
    sharedContextPhase: "lane",
    inputBindings: researchBinding(),
    expectedNoActionReasons: noAction("NO_ELIGIBLE_POSTGRES_CANDIDATES")
  }),
  workflow({
    id: "proposal.zero_dte",
    schedulerIdentity: "proposal.zero_dte",
    command: "research:daily",
    args: ["--stage=lane", "--lane=options_0dte", "--format=json"],
    compartment: "proposal",
    lane: "options_0dte",
    phase: "lane",
    dependencies: ["research.prepare"],
    resourceClass: "compute_readonly",
    enableWhen: "options_enabled",
    sharedContextPhase: "lane",
    inputBindings: researchBinding(),
    expectedNoActionReasons: noAction("NO_ELIGIBLE_POSTGRES_CANDIDATES")
  }),
  workflow({
    id: "proposal.leaps",
    schedulerIdentity: "proposal.leaps",
    command: "research:daily",
    args: ["--stage=lane", "--lane=options_leaps", "--format=json"],
    compartment: "proposal",
    lane: "options_leaps",
    phase: "lane",
    dependencies: ["research.prepare"],
    resourceClass: "compute_readonly",
    enableWhen: "options_enabled",
    sharedContextPhase: "lane",
    inputBindings: researchBinding(),
    expectedNoActionReasons: noAction("NO_ELIGIBLE_POSTGRES_CANDIDATES")
  }),
  workflow({
    id: "research.finalize",
    schedulerIdentity: "research.finalize",
    command: "research:daily",
    args: ["--stage=finalize", "--format=json"],
    compartment: "research",
    lane: "shared",
    phase: "finalize",
    dependencies: [
      "research.prepare",
      "proposal.equity",
      "proposal.standard_option",
      "proposal.zero_dte",
      "proposal.leaps"
    ],
    resourceClass: "postgres_serial",
    enableWhen: "always",
    sharedContextPhase: "finalize",
    inputBindings: researchBinding()
  }),
  workflow({
    id: "exit.review.paper",
    schedulerIdentity: "exit.review.paper",
    command: "paper:exit:review",
    args: ["--format=json"],
    compartment: "exit_review",
    lane: "exits",
    phase: "paper",
    dependencies: ["reconcile.initial"],
    resourceClass: "compute_readonly",
    enableWhen: "always",
    expectedNoActionReasons: noAction("NO_POSTGRES_EXIT_TRIGGER")
  }),
  workflow({
    id: "exit.review.zero_dte",
    schedulerIdentity: "exit.review.zero_dte",
    command: "zero-dte:exit:review",
    args: ["--format=json"],
    compartment: "exit_review",
    lane: "options_0dte",
    phase: "zero_dte",
    dependencies: ["reconcile.initial"],
    resourceClass: "compute_readonly",
    enableWhen: "options_enabled",
    expectedNoActionReasons: noAction("NO_POSTGRES_EXIT_TRIGGER")
  }),
  workflow({
    id: "exit.review.hedge",
    schedulerIdentity: "exit.review.hedge",
    command: "hedge:exit:review",
    args: ["--format=json"],
    compartment: "exit_review",
    lane: "hedge",
    phase: "hedge",
    dependencies: ["reconcile.initial"],
    resourceClass: "compute_readonly",
    enableWhen: "hedging_enabled",
    expectedNoActionReasons: noAction("NO_POSTGRES_EXIT_TRIGGER")
  }),
  workflow({
    id: "review.general",
    schedulerIdentity: "review.general",
    command: "paper:review",
    args: [
      "--riskProfile=aggressive",
      "--maxCandidates=25",
      "--format=json"
    ],
    compartment: "review",
    lane: "shared",
    phase: "general",
    dependencies: ["research.finalize", "options.discover"],
    resourceClass: "postgres_serial",
    enableWhen: "always",
    expectedNoActionReasons: noAction("NO_ELIGIBLE_POSTGRES_CANDIDATES")
  }),
  workflow({
    id: "review.portfolio",
    schedulerIdentity: "review.portfolio",
    command: "paper:portfolio:review",
    args: ["--format=json"],
    compartment: "review",
    lane: "shared",
    phase: "portfolio",
    dependencies: ["review.general"],
    resourceClass: "postgres_serial",
    enableWhen: "always"
  }),
  workflow({
    id: "review.operations",
    schedulerIdentity: "review.operations",
    command: "paper:ops:review",
    args: ["--format=json"],
    compartment: "review",
    lane: "shared",
    phase: "operations",
    dependencies: ["review.portfolio"],
    resourceClass: "postgres_serial",
    enableWhen: "always"
  }),
  workflow({
    id: "review.hedge",
    schedulerIdentity: "review.hedge",
    command: "hedge:review",
    args: ["--format=json"],
    compartment: "review",
    lane: "hedge",
    phase: "hedge",
    dependencies: ["review.portfolio"],
    resourceClass: "postgres_serial",
    enableWhen: "hedging_enabled"
  }),
  workflow({
    id: "entry.paper",
    schedulerIdentity: "entry.paper",
    command: "paper:execute:reviewed",
    args: [
      "--confirmPaper",
      "--sections=equityBuys,equityAdds,optionBuys",
      "--format=json"
    ],
    compartment: "entry",
    lane: "shared",
    phase: "paper",
    dependencies: ["review.operations", "review.hedge"],
    resourceClass: "broker_mutation",
    enableWhen: "always",
    requiredRuntimeFlags: BROKER_RUNTIME_FLAGS,
    retryPolicy: NO_MUTATION_RETRY,
    failureScope: "global_mutation_block",
    expectedNoActionReasons: noAction("NO_READY_POSTGRES_ORDER_INTENTS")
  }),
  workflow({
    id: "entry.zero_dte",
    schedulerIdentity: "entry.zero_dte",
    command: "zero-dte:engine",
    args: ["--confirmPaper", "--format=json"],
    compartment: "entry",
    lane: "options_0dte",
    phase: "zero_dte",
    dependencies: ["review.operations", "review.hedge"],
    resourceClass: "broker_mutation",
    enableWhen: "options_enabled",
    requiredRuntimeFlags: BROKER_RUNTIME_FLAGS,
    retryPolicy: NO_MUTATION_RETRY,
    failureScope: "global_mutation_block",
    expectedNoActionReasons: noAction("NO_READY_POSTGRES_ORDER_INTENTS")
  }),
  workflow({
    id: "reconcile.entries",
    schedulerIdentity: "reconcile.entries",
    command: "zero-dte:reconcile",
    args: ["--format=json"],
    compartment: "reconciliation",
    lane: "shared",
    phase: "entries",
    dependencies: ["entry.paper", "entry.zero_dte"],
    resourceClass: "postgres_serial",
    enableWhen: "always",
    failureScope: "global_mutation_block",
    expectedNoActionReasons: noAction("NO_RECONCILIABLE_POSTGRES_ORDERS")
  }),
  workflow({
    id: "exit.execute.paper",
    schedulerIdentity: "exit.execute.paper",
    command: "paper:exit:execute",
    args: ["--confirmPaper", "--format=json"],
    compartment: "exit_execute",
    lane: "exits",
    phase: "paper",
    dependencies: [
      "exit.review.paper",
      "exit.review.zero_dte",
      "reconcile.entries"
    ],
    resourceClass: "broker_mutation",
    enableWhen: "always",
    requiredRuntimeFlags: BROKER_RUNTIME_FLAGS,
    retryPolicy: NO_MUTATION_RETRY,
    failureScope: "global_mutation_block",
    expectedNoActionReasons: noAction("NO_READY_POSTGRES_ORDER_INTENTS")
  }),
  workflow({
    id: "exit.execute.hedge",
    schedulerIdentity: "exit.execute.hedge",
    command: "hedge:exit:execute",
    args: ["--confirmPaper", "--format=json"],
    compartment: "exit_execute",
    lane: "hedge",
    phase: "hedge",
    dependencies: ["exit.review.hedge", "reconcile.entries"],
    resourceClass: "broker_mutation",
    enableWhen: "hedging_enabled",
    requiredRuntimeFlags: BROKER_RUNTIME_FLAGS,
    retryPolicy: NO_MUTATION_RETRY,
    failureScope: "global_mutation_block",
    expectedNoActionReasons: noAction("NO_READY_POSTGRES_ORDER_INTENTS")
  }),
  workflow({
    id: "reconcile.exits",
    schedulerIdentity: "reconcile.exits",
    command: "zero-dte:reconcile",
    args: ["--format=json"],
    compartment: "reconciliation",
    lane: "shared",
    phase: "exits",
    dependencies: ["exit.execute.paper", "exit.execute.hedge"],
    resourceClass: "postgres_serial",
    enableWhen: "always",
    failureScope: "global_mutation_block",
    expectedNoActionReasons: noAction("NO_RECONCILIABLE_POSTGRES_ORDERS")
  }),
  workflow({
    id: "cancel.orders",
    schedulerIdentity: "cancel.orders",
    command: "paper:order:cancel",
    args: ["--autonomous", "--confirmPaper", "--format=json"],
    compartment: "cancellation",
    lane: "exits",
    phase: "cancel",
    dependencies: ["reconcile.exits"],
    resourceClass: "broker_mutation",
    enableWhen: "always",
    requiredRuntimeFlags: BROKER_RUNTIME_FLAGS,
    retryPolicy: NO_MUTATION_RETRY,
    failureScope: "global_mutation_block",
    expectedNoActionReasons: noAction("NO_CANCELLABLE_POSTGRES_ORDERS")
  }),
  workflow({
    id: "reconcile.final",
    schedulerIdentity: "reconcile.final",
    command: "zero-dte:reconcile",
    args: ["--format=json"],
    compartment: "reconciliation",
    lane: "shared",
    phase: "final",
    dependencies: ["cancel.orders"],
    resourceClass: "postgres_serial",
    enableWhen: "always",
    failureScope: "global_mutation_block",
    expectedNoActionReasons: noAction("NO_RECONCILIABLE_POSTGRES_ORDERS")
  }),
  workflow({
    id: "learn.paper",
    schedulerIdentity: "learn.paper",
    command: "paper:learn",
    args: ["--format=json"],
    compartment: "learning",
    lane: "learning",
    phase: "learn",
    dependencies: ["reconcile.final", "research.finalize", "options.discover"],
    resourceClass: "postgres_serial",
    enableWhen: "always",
    expectedNoActionReasons: noAction(
      "NO_BOUNDED_OUTCOME_SOURCES",
      "OUTCOME_LEARNING_REPLAY_UNCHANGED"
    )
  }),
  workflow({
    id: "recover.final",
    schedulerIdentity: "recover.final",
    command: "system:recover",
    args: ["--format=json"],
    compartment: "recovery",
    lane: "shared",
    phase: "final",
    dependencies: [
      "reconcile.initial",
      "research.prepare",
      "options.discover",
      "proposal.equity",
      "proposal.standard_option",
      "proposal.zero_dte",
      "proposal.leaps",
      "research.finalize",
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
    ],
    resourceClass: "postgres_serial",
    enableWhen: "always",
    expectedNoActionReasons: noAction("NO_RECOVERABLE_POSTGRES_STATE")
  })
]);

const codedError = (code, detail) => {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
};

const requireString = (value, code, field) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw codedError(code, field);
  }
};

const sameStringSet = (left, right) =>
  left.size === right.size && [...left].every((value) => right.has(value));

const validateGraph = (registry) => {
  const byId = new Map();
  const schedulerIdentities = new Set();
  for (const definition of registry) {
    requireString(definition?.id, "AUTONOMOUS_WORKFLOW_REGISTRY_INVALID", "id");
    if (byId.has(definition.id)) {
      throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_ID_DUPLICATE", definition.id);
    }
    byId.set(definition.id, definition);

    requireString(
      definition.schedulerIdentity,
      "AUTONOMOUS_WORKFLOW_REGISTRY_INVALID",
      `${definition.id}.schedulerIdentity`
    );
    if (schedulerIdentities.has(definition.schedulerIdentity)) {
      throw codedError(
        "AUTONOMOUS_WORKFLOW_REGISTRY_SCHEDULER_IDENTITY_DUPLICATE",
        definition.schedulerIdentity
      );
    }
    schedulerIdentities.add(definition.schedulerIdentity);
  }

  for (const definition of registry) {
    if (!Array.isArray(definition.dependencies)) {
      throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_INVALID", `${definition.id}.dependencies`);
    }
    const uniqueDependencies = new Set(definition.dependencies);
    if (uniqueDependencies.size !== definition.dependencies.length) {
      throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_DEPENDENCY_INVALID", definition.id);
    }
    for (const dependency of definition.dependencies) {
      if (!byId.has(dependency) || dependency === definition.id) {
        throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_DEPENDENCY_INVALID", definition.id);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_CYCLE", id);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);

  return byId;
};

const validateDefinition = (definition, byId) => {
  for (const field of ["command", "compartment", "lane", "phase"]) {
    requireString(
      definition[field],
      "AUTONOMOUS_WORKFLOW_REGISTRY_INVALID",
      `${definition.id}.${field}`
    );
  }
  if (!Array.isArray(definition.args) || !definition.args.every((arg) =>
    typeof arg === "string" && arg.length > 0 && arg.length <= 512
  )) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_INVALID", `${definition.id}.args`);
  }
  if (!RESOURCE_CLASSES.has(definition.resourceClass)) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_RESOURCE_CLASS_INVALID", definition.id);
  }
  if (!ENABLE_PREDICATES.has(definition.enableWhen)) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_ENABLEMENT_INVALID", definition.id);
  }
  if (!FAILURE_SCOPES.has(definition.failureScope)) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_FAILURE_SCOPE_INVALID", definition.id);
  }
  if (
    definition.sharedContextPhase !== null &&
    (typeof definition.sharedContextPhase !== "string" ||
      definition.sharedContextPhase.length === 0 ||
      definition.sharedContextPhase.length > 64)
  ) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_INVALID", `${definition.id}.sharedContextPhase`);
  }
  if (!Number.isSafeInteger(definition.timeoutMs) ||
      definition.timeoutMs < 1_000 ||
      definition.timeoutMs > 60 * 60 * 1_000) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_TIMEOUT_INVALID", definition.id);
  }

  const isBrokerCommand = BROKER_MUTATION_COMMANDS.includes(definition.command);
  if ((definition.resourceClass === "broker_mutation") !== isBrokerCommand) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_PRIVILEGE_INVALID", definition.id);
  }

  const retry = definition.retryPolicy;
  if (!retry ||
      !Number.isSafeInteger(retry.maxAttempts) ||
      retry.maxAttempts < 1 ||
      retry.maxAttempts > 3 ||
      !Number.isSafeInteger(retry.backoffMs) ||
      retry.backoffMs < 0 ||
      retry.backoffMs > 60_000 ||
      !Array.isArray(retry.retryableReasonCodes) ||
      !retry.retryableReasonCodes.every((reason) => RETRYABLE_REASON_CODES.has(reason)) ||
      new Set(retry.retryableReasonCodes).size !== retry.retryableReasonCodes.length ||
      (retry.maxAttempts > 1 && retry.retryableReasonCodes.length === 0) ||
      (definition.resourceClass === "broker_mutation" &&
        (retry.maxAttempts !== 1 || retry.retryableReasonCodes.length !== 0))) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_RETRY_INVALID", definition.id);
  }

  if (!Array.isArray(definition.expectedNoActionReasons) ||
      !definition.expectedNoActionReasons.every((reason) => EXPECTED_NO_ACTION_REASONS.has(reason)) ||
      new Set(definition.expectedNoActionReasons).size !==
        definition.expectedNoActionReasons.length) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_NO_ACTION_INVALID", definition.id);
  }

  if (!definition.requiredRuntimeFlags ||
      typeof definition.requiredRuntimeFlags !== "object" ||
      Array.isArray(definition.requiredRuntimeFlags) ||
      !Object.entries(definition.requiredRuntimeFlags).every(([key, value]) =>
        /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === "string" && value.length <= 64
      )) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_RUNTIME_FLAGS_INVALID", definition.id);
  }
  const requiredRuntimeFlags = definition.resourceClass === "broker_mutation"
    ? BROKER_RUNTIME_FLAGS
    : BASE_RUNTIME_FLAGS;
  for (const [key, value] of Object.entries(requiredRuntimeFlags)) {
    if (definition.requiredRuntimeFlags[key] !== value) {
      throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_RUNTIME_FLAGS_INVALID", definition.id);
    }
  }

  if (!Array.isArray(definition.inputBindings)) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_BINDING_INVALID", definition.id);
  }
  const bindingArgs = new Set();
  for (const binding of definition.inputBindings) {
    if (!binding ||
        typeof binding !== "object" ||
        binding.argName !== "researchRunId" ||
        binding.outputField !== "researchRunId" ||
        typeof binding.fromWorkflowId !== "string" ||
        !byId.has(binding.fromWorkflowId) ||
        !definition.dependencies.includes(binding.fromWorkflowId) ||
        bindingArgs.has(binding.argName)) {
      throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_BINDING_INVALID", definition.id);
    }
    bindingArgs.add(binding.argName);
  }
};

const validateCommandContract = (registry, packageScripts, commandContract) => {
  const registryCommands = new Set([
    ...registry.map(({ command }) => command),
    STATE_COMMAND
  ]);
  if (!sameStringSet(registryCommands, EXPECTED_COMMANDS) ||
      !packageScripts ||
      typeof packageScripts !== "object" ||
      !commandContract ||
      commandContract.version !== 1 ||
      !commandContract.commands ||
      typeof commandContract.commands !== "object" ||
      Array.isArray(commandContract.commands)) {
    throw codedError("AUTONOMOUS_WORKFLOW_COMMAND_CONTRACT_INVALID");
  }

  const contractCommands = new Set(Object.keys(commandContract.commands));
  if (!sameStringSet(contractCommands, EXPECTED_COMMANDS)) {
    throw codedError("AUTONOMOUS_WORKFLOW_COMMAND_CONTRACT_INVALID");
  }

  const requiredContractValues = {
    allowed: true,
    persistence: "postgres",
    production: true,
    noOp: false,
    schedulerRegistered: true,
    sqliteFreeImportGraph: true,
    required: true
  };
  for (const command of EXPECTED_COMMANDS) {
    const expectedEntry = `tsx src/postgresOnlyCli.ts ${command}`;
    const entry = commandContract.commands[command];
    if (!entry ||
        typeof entry !== "object" ||
        packageScripts[command] !== expectedEntry ||
        entry.entry !== expectedEntry ||
        Object.entries(requiredContractValues).some(([key, value]) => entry[key] !== value)) {
      throw codedError("AUTONOMOUS_WORKFLOW_COMMAND_CONTRACT_INVALID", command);
    }
  }
};

const validateWorkflowRegistry = ({
  registry = AUTONOMOUS_WORKFLOW_REGISTRY,
  packageScripts,
  commandContract
}) => {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_INVALID");
  }
  const byId = validateGraph(registry);
  for (const definition of registry) validateDefinition(definition, byId);
  validateCommandContract(registry, packageScripts, commandContract);
  return true;
};

const freezeWorkflowCycleEnablement = ({
  registry = AUTONOMOUS_WORKFLOW_REGISTRY,
  startupFlags
}) => {
  if (!startupFlags ||
      typeof startupFlags !== "object" ||
      Array.isArray(startupFlags) ||
      typeof startupFlags.optionsEnabled !== "boolean" ||
      typeof startupFlags.hedgingEnabled !== "boolean") {
    throw codedError("AUTONOMOUS_WORKFLOW_STARTUP_FLAGS_INVALID");
  }

  const byId = validateGraph(registry);
  const enablementByPredicate = {
    always: true,
    options_enabled: startupFlags.optionsEnabled,
    hedging_enabled: startupFlags.hedgingEnabled
  };
  const decisionsById = new Map();
  const decisions = registry.map((definition) => {
    if (!ENABLE_PREDICATES.has(definition.enableWhen)) {
      throw codedError("AUTONOMOUS_WORKFLOW_REGISTRY_ENABLEMENT_INVALID", definition.id);
    }
    const inactiveDependencyIds = definition.dependencies.filter((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return !enablementByPredicate[dependency.enableWhen];
    });
    const decision = deepFreeze({
      id: definition.id,
      enableWhen: definition.enableWhen,
      enabled: enablementByPredicate[definition.enableWhen],
      inactiveDependencyIds: deepFreeze(inactiveDependencyIds)
    });
    decisionsById.set(definition.id, decision);
    return decision;
  });
  const enabledNodes = registry
    .filter((definition) => decisionsById.get(definition.id).enabled)
    .map((definition) => deepFreeze({
      ...definition,
      dependencies: deepFreeze(definition.dependencies.filter(
        (dependencyId) => decisionsById.get(dependencyId).enabled
      ))
    }));

  return deepFreeze({
    startupFlags: deepFreeze({
      optionsEnabled: startupFlags.optionsEnabled,
      hedgingEnabled: startupFlags.hedgingEnabled
    }),
    enabledNodes: deepFreeze(enabledNodes),
    decisions: deepFreeze(decisions)
  });
};

export {
  AUTONOMOUS_WORKFLOW_REGISTRY,
  BROKER_MUTATION_COMMANDS,
  STATE_COMMAND,
  freezeWorkflowCycleEnablement,
  validateWorkflowRegistry
};
