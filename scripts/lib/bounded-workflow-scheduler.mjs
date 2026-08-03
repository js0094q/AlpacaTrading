const codedError = (code, detail) => {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
};

const abortedError = (workflowId) =>
  codedError("AUTONOMOUS_WORKFLOW_ABORTED", workflowId);

const createGate = (limit) => {
  let active = 0;
  const queue = [];
  const getLimit = typeof limit === "function" ? limit : () => limit;

  const admit = () => {
    while (queue.length > 0 && active < getLimit()) {
      const entry = queue.shift();
      entry.removeAbortListener();
      if (entry.signal?.aborted) {
        entry.reject(abortedError(entry.workflowId));
        continue;
      }
      active += 1;
      Promise.resolve()
        .then(() => {
          if (entry.signal?.aborted) throw abortedError(entry.workflowId);
          return entry.operation();
        })
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          admit();
        });
    }
  };

  return ({ workflowId, signal }, operation) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError(workflowId));
      return;
    }
    const entry = {
      workflowId,
      signal,
      operation,
      resolve,
      reject,
      removeAbortListener: () => undefined
    };
    const onAbort = () => {
      const index = queue.indexOf(entry);
      if (index === -1) return;
      queue.splice(index, 1);
      entry.removeAbortListener();
      reject(abortedError(workflowId));
      admit();
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      entry.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
    queue.push(entry);
    admit();
  });
};

const resourcePressureSample = (input) => {
  const reasons = [];
  if (input.availableMemoryBytes < 1024 ** 3) reasons.push("AVAILABLE_MEMORY_LOW");
  if (input.loadAverageOneMinute > 2.5) reasons.push("LOAD_AVERAGE_HIGH");
  if (input.postgresLatencyMs > input.configuredPostgresLatencyMs) {
    reasons.push("POSTGRES_LATENCY_HIGH");
  }
  if (input.workerStateLatencyMs > input.configuredStateLatencyMs) {
    reasons.push("WORKER_STATE_LATENCY_HIGH");
  }
  if (input.providerThrottled === true) reasons.push("PROVIDER_THROTTLED");
  if (input.priorWorkflowTimedOut === true) reasons.push("PRIOR_WORKFLOW_TIMEOUT");
  if (input.heartbeatOrFenceRisk === true) reasons.push("HEARTBEAT_OR_FENCE_RISK");
  if (input.diskFreeRatio < 0.10) reasons.push("DISK_FREE_LOW");
  if (input.fileDescriptorRatio >= 0.90) reasons.push("FILE_DESCRIPTOR_HIGH");
  return Object.freeze({
    pressure: reasons.length > 0,
    reasons: Object.freeze(reasons)
  });
};

const createBoundedScheduler = ({
  configuredConcurrency = 2,
  minimumConcurrency = 1,
  maximumConcurrency = 2,
  samplePressure,
  emit,
  now = Date.now
} = {}) => {
  if (
    !Number.isSafeInteger(configuredConcurrency) ||
    !Number.isSafeInteger(minimumConcurrency) ||
    !Number.isSafeInteger(maximumConcurrency) ||
    minimumConcurrency !== 1 ||
    maximumConcurrency !== 2 ||
    configuredConcurrency < minimumConcurrency ||
    configuredConcurrency > maximumConcurrency
  ) {
    throw codedError("AUTONOMOUS_COMPUTE_CONCURRENCY_INVALID");
  }

  let effectiveConcurrency = configuredConcurrency;
  let pressureFreeSamples = 0;
  let lastPressureAt = null;

  const pressureReasonCodes = new Set([
    "AVAILABLE_MEMORY_LOW",
    "LOAD_AVERAGE_HIGH",
    "POSTGRES_LATENCY_HIGH",
    "WORKER_STATE_LATENCY_HIGH",
    "PROVIDER_THROTTLED",
    "PRIOR_WORKFLOW_TIMEOUT",
    "HEARTBEAT_OR_FENCE_RISK",
    "DISK_FREE_LOW",
    "FILE_DESCRIPTOR_HIGH"
  ]);
  const sanitizedPressureReason = (reasons) =>
    reasons.find((reason) => pressureReasonCodes.has(reason)) ?? "RESOURCE_PRESSURE";

  const emitLimitChange = (type, reason, effectiveLimit, timestamp) => {
    emit({
      type,
      reason,
      configuredLimit: configuredConcurrency,
      effectiveLimit,
      timestamp: new Date(timestamp).toISOString()
    });
  };

  const sampleEffectiveConcurrency = () => {
    const timestamp = now();
    const sample = samplePressure();
    const assessment = sample && typeof sample === "object" &&
      typeof sample.pressure === "boolean" && Array.isArray(sample.reasons)
      ? sample
      : resourcePressureSample(sample ?? {});

    if (assessment.pressure) {
      lastPressureAt = timestamp;
      pressureFreeSamples = 0;
      if (effectiveConcurrency !== minimumConcurrency) {
        effectiveConcurrency = minimumConcurrency;
        emitLimitChange(
          "AUTONOMOUS_COMPUTE_PRESSURE_FALLBACK",
          sanitizedPressureReason(assessment.reasons),
          effectiveConcurrency,
          timestamp
        );
      }
    } else if (effectiveConcurrency < configuredConcurrency) {
      pressureFreeSamples += 1;
      if (
        pressureFreeSamples >= 5 &&
        lastPressureAt !== null &&
        timestamp - lastPressureAt >= 60_000
      ) {
        effectiveConcurrency = configuredConcurrency;
        pressureFreeSamples = 0;
        emitLimitChange(
          "AUTONOMOUS_COMPUTE_PRESSURE_RECOVERY",
          "PRESSURE_RECOVERED",
          effectiveConcurrency,
          timestamp
        );
      }
    }
    return effectiveConcurrency;
  };

  const runBounded = createGate(sampleEffectiveConcurrency);
  const runSharedContext = createGate(1);
  const runPostgres = createGate(1);
  const runBrokerMutation = createGate(1);
  return {
    run(input, operation) {
      const { resourceClass } = input;
      if (resourceClass === "broker_mutation") {
        return runBrokerMutation(input, operation);
      }
      const nestedOperation = resourceClass === "shared_context"
        ? () => runSharedContext(input, operation)
        : resourceClass === "postgres_serial"
          ? () => runPostgres(input, operation)
          : operation;
      return runBounded(input, nestedOperation);
    }
  };
};

const ALLOWED_INPUT_BINDING_FIELDS = new Set(["researchRunId"]);
const TERMINAL_CLASSIFICATIONS = new Set([
  "success",
  "no_action",
  "deferred",
  "blocked",
  "error",
  "mutation_indeterminate"
]);
const MAX_BOUND_SCALAR_BYTES = 256;

const reasonCodeOf = (value, fallback = "WORKFLOW_FAILED") =>
  typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : fallback;

const assertNotAborted = (signal, workflowId) => {
  if (signal?.aborted) throw abortedError(workflowId);
};

const abortableSleep = (milliseconds, signal, workflowId) => new Promise((resolve, reject) => {
  assertNotAborted(signal, workflowId);
  const timer = setTimeout(() => {
    removeAbortListener();
    resolve();
  }, milliseconds);
  const onAbort = () => {
    clearTimeout(timer);
    removeAbortListener();
    reject(abortedError(workflowId));
  };
  const removeAbortListener = signal
    ? () => signal.removeEventListener("abort", onAbort)
    : () => undefined;
  signal?.addEventListener("abort", onAbort, { once: true });
});

const runWithTimeout = async ({ definition, signal, runWorkflow }) => {
  assertNotAborted(signal, definition.id);
  const controller = new AbortController();
  let started = false;
  let controlError;
  let rejectControl;
  const control = new Promise((_, reject) => {
    rejectControl = reject;
  });
  const rejectForControl = (error) => {
    if (controlError) return;
    controlError = error;
    rejectControl(error);
    controller.abort();
  };
  const onAbort = () => {
    rejectForControl(abortedError(definition.id));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    rejectForControl(codedError("WORKFLOW_TIMEOUT", definition.id));
  }, definition.timeoutMs);
  const workflow = Promise.resolve().then(() => {
    assertNotAborted(controller.signal, definition.id);
    started = true;
    return runWorkflow(definition, controller.signal);
  });
  try {
    return await Promise.race([workflow, control]);
  } catch (error) {
    if (error === controlError && started) {
      await workflow.then(
        () => undefined,
        () => undefined
      );
      if (error.code === "WORKFLOW_TIMEOUT" &&
          definition.resourceClass === "broker_mutation") {
        error.submissionMayHaveOccurred = true;
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
};

const brokerIndeterminateTerminal = (definition, attempt, sourceReasonCode) => ({
  workflowId: definition.id,
  terminal: true,
  classification: "mutation_indeterminate",
  reasonCode: "BROKER_MUTATION_INDETERMINATE",
  attempt,
  evidence: {
    sourceReasonCode: reasonCodeOf(sourceReasonCode)
  },
  submissionMayHaveOccurred: true
});

const terminalFromResult = (definition, rawResult, attempt) => {
  const result = rawResult && typeof rawResult === "object" && !Array.isArray(rawResult)
    ? rawResult
    : null;
  if (!result || !TERMINAL_CLASSIFICATIONS.has(result.classification)) {
    return {
      workflowId: definition.id,
      terminal: true,
      classification: "error",
      reasonCode: "WORKFLOW_RESULT_INVALID",
      attempt
    };
  }
  const classification = result.classification;
  if (definition.resourceClass === "broker_mutation" &&
      (result.submissionMayHaveOccurred === true ||
        (classification === "error" && result.reasonCode === "WORKFLOW_TIMEOUT"))) {
    return brokerIndeterminateTerminal(definition, attempt, result.reasonCode);
  }
  const terminal = {
    workflowId: definition.id,
    terminal: true,
    classification,
    attempt
  };
  if (typeof result.reasonCode === "string" && result.reasonCode.length > 0) {
    terminal.reasonCode = reasonCodeOf(result.reasonCode);
  }
  if (Object.prototype.hasOwnProperty.call(result, "output")) {
    terminal.output = result.output;
  }
  if (result.evidence && typeof result.evidence === "object" && !Array.isArray(result.evidence)) {
    terminal.evidence = result.evidence;
  }
  if (result.submissionMayHaveOccurred === true) {
    terminal.submissionMayHaveOccurred = true;
  }
  return terminal;
};

const terminalFromError = (definition, error, attempt) => {
  if (error?.code === "AUTONOMOUS_WORKFLOW_ABORTED") throw error;
  const submissionMayHaveOccurred = definition.resourceClass === "broker_mutation" &&
    (error?.code === "WORKFLOW_TIMEOUT" ||
      error?.submissionMayHaveOccurred === true ||
      error?.evidence?.submissionMayHaveOccurred === true);
  if (submissionMayHaveOccurred) {
    return brokerIndeterminateTerminal(definition, attempt, error?.code);
  }
  return {
    workflowId: definition.id,
    terminal: true,
    classification: "error",
    reasonCode: reasonCodeOf(error?.code),
    attempt
  };
};

const retryDisposition = (definition, terminal, attempt) => {
  const indeterminate = terminal.classification === "mutation_indeterminate" ||
    terminal.submissionMayHaveOccurred === true;
  if (indeterminate) return { retry: false, indeterminate: true, terminal };
  const retryable = terminal.classification === "error" &&
    definition.retryPolicy.retryableReasonCodes.includes(terminal.reasonCode);
  if (!retryable) return { retry: false, indeterminate: false, terminal };
  if (attempt < definition.retryPolicy.maxAttempts) {
    return { retry: true, indeterminate: false, terminal };
  }
  return {
    retry: false,
    indeterminate: false,
    terminal: {
      workflowId: definition.id,
      terminal: true,
      classification: "error",
      reasonCode: "RETRY_EXHAUSTED",
      attempt,
      evidence: {
        attempts: attempt,
        lastReasonCode: terminal.reasonCode
      }
    }
  };
};

const bindingInvalidTerminal = (definition, binding) => ({
  workflowId: definition.id,
  terminal: true,
  classification: "error",
  reasonCode: "WORKFLOW_INPUT_BINDING_INVALID",
  attempt: 0,
  evidence: {
    argName: typeof binding?.argName === "string" ? binding.argName : "unknown",
    fromWorkflowId: typeof binding?.fromWorkflowId === "string"
      ? binding.fromWorkflowId
      : "unknown",
    outputField: typeof binding?.outputField === "string" ? binding.outputField : "unknown"
  }
});

const resolveDefinitionBindings = (definition, terminals) => {
  if (!Array.isArray(definition.inputBindings) || definition.inputBindings.length === 0) {
    return { definition };
  }
  const boundInputs = {};
  const args = [...definition.args];
  for (const binding of definition.inputBindings) {
    const source = terminals.get(binding.fromWorkflowId);
    const value = source?.output && typeof source.output === "object" &&
      !Array.isArray(source.output)
      ? source.output[binding.outputField]
      : undefined;
    const scalar = typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value));
    const serialized = scalar ? String(value) : "";
    if (!ALLOWED_INPUT_BINDING_FIELDS.has(binding.outputField) ||
        binding.argName !== binding.outputField ||
        !scalar ||
        new TextEncoder().encode(serialized).byteLength > MAX_BOUND_SCALAR_BYTES) {
      return { terminal: bindingInvalidTerminal(definition, binding) };
    }
    boundInputs[binding.argName] = value;
    args.push(`--${binding.argName}=${serialized}`);
  }
  return {
    definition: Object.freeze({
      ...definition,
      args: Object.freeze(args),
      boundInputs: Object.freeze(boundInputs)
    })
  };
};

const disabledDecisionRecord = (decision) => Object.freeze({
  type: "registry_decision",
  terminal: false,
  workflowId: decision.id,
  enabled: false,
  reasonCode: "WORKFLOW_DISABLED",
  enableWhen: decision.enableWhen,
  inactiveDependencyIds: Object.freeze([...(decision.inactiveDependencyIds ?? [])])
});

const executeWorkflowGraph = async ({
  registry,
  decisions = [],
  scheduler,
  signal,
  runWorkflow,
  persistTerminal,
  sleep
}) => {
  if (!Array.isArray(registry) || !scheduler ||
      typeof scheduler.run !== "function" ||
      typeof runWorkflow !== "function" ||
      typeof persistTerminal !== "function") {
    throw codedError("AUTONOMOUS_WORKFLOW_GRAPH_INVALID");
  }
  const cycleController = new AbortController();
  let cycleFailure = null;
  const abortCycle = (error) => {
    if (!cycleFailure) cycleFailure = error;
    if (!cycleController.signal.aborted) cycleController.abort();
  };
  const onExternalAbort = () => abortCycle(abortedError("workflow.graph"));
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener("abort", onExternalAbort, { once: true });
  const cycleSignal = cycleController.signal;
  const byId = new Map();
  for (const definition of registry) {
    if (!definition || typeof definition.id !== "string" || byId.has(definition.id)) {
      throw codedError("AUTONOMOUS_WORKFLOW_GRAPH_INVALID");
    }
    byId.set(definition.id, definition);
  }
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));
  const enabledDefinitions = registry.filter((definition) =>
    decisionsById.get(definition.id)?.enabled !== false
  );
  const enabledIds = new Set(enabledDefinitions.map(({ id }) => id));
  const decisionRecords = decisions
    .filter(({ enabled }) => enabled === false)
    .map(disabledDecisionRecord);
  const pending = new Map(enabledDefinitions.map((definition) => [definition.id, definition]));
  const active = new Map();
  const terminals = new Map();
  let brokerMutationLatched = false;

  const persistTerminalFailClosed = async (definition, terminal) => {
    try {
      await persistTerminal(terminal);
    } catch (cause) {
      const error = codedError("WORKFLOW_TERMINAL_PERSISTENCE_FAILED", definition.id);
      error.sourceReasonCode = reasonCodeOf(cause?.code);
      abortCycle(error);
      throw error;
    }
  };

  const persistThroughPostgresGate = (definition, terminal) => scheduler.run({
    workflowId: `${definition.id}.terminal`,
    resourceClass: "postgres_serial",
    signal: cycleSignal
  }, async () => {
    assertNotAborted(cycleSignal, definition.id);
    await persistTerminalFailClosed(definition, terminal);
  });

  const executeDefinition = async (originalDefinition) => {
    assertNotAborted(cycleSignal, originalDefinition.id);
    const bindingResolution = resolveDefinitionBindings(originalDefinition, terminals);
    if (bindingResolution.terminal) {
      await persistThroughPostgresGate(originalDefinition, bindingResolution.terminal);
      return bindingResolution.terminal;
    }
    const definition = bindingResolution.definition;
    const policy = definition.retryPolicy;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      assertNotAborted(cycleSignal, definition.id);
      const attemptResult = await scheduler.run({
        workflowId: definition.id,
        resourceClass: definition.resourceClass,
        signal: cycleSignal
      }, async () => {
        assertNotAborted(cycleSignal, definition.id);
        if (definition.resourceClass === "broker_mutation" && brokerMutationLatched) {
          return {
            disposition: {
              retry: false,
              indeterminate: false,
              terminal: {
                workflowId: definition.id,
                terminal: true,
                classification: "blocked",
                reasonCode: "BROKER_MUTATION_LATCHED",
                attempt: 0
              }
            },
            persisted: false
          };
        }
        let terminal;
        try {
          const rawResult = await runWithTimeout({
            definition,
            signal: cycleSignal,
            runWorkflow
          });
          terminal = terminalFromResult(definition, rawResult, attempt);
        } catch (error) {
          terminal = terminalFromError(definition, error, attempt);
        }
        const disposition = retryDisposition(definition, terminal, attempt);
        if (disposition.indeterminate) brokerMutationLatched = true;
        const shouldPersistInsideGate = definition.resourceClass === "postgres_serial" &&
          !disposition.retry;
        if (shouldPersistInsideGate) {
          await persistTerminalFailClosed(definition, disposition.terminal);
        }
        return { disposition, persisted: shouldPersistInsideGate };
      });

      if (attemptResult.disposition.retry) {
        const delay = sleep
          ? () => sleep(policy.backoffMs, cycleSignal)
          : () => abortableSleep(policy.backoffMs, cycleSignal, definition.id);
        await delay();
        assertNotAborted(cycleSignal, definition.id);
        continue;
      }
      if (!attemptResult.persisted) {
        await persistThroughPostgresGate(definition, attemptResult.disposition.terminal);
      }
      return attemptResult.disposition.terminal;
    }
    throw codedError("AUTONOMOUS_WORKFLOW_GRAPH_INVALID", definition.id);
  };

  const startDefinition = (id, definition) => {
    active.set(id, executeDefinition(definition).then(
      (terminal) => ({ id, terminal }),
      (error) => ({ id, error })
    ));
  };
  const takeNextActive = async () => {
    const completed = await Promise.race([...active.values()]);
    active.delete(completed.id);
    return completed;
  };
  const drainActive = async () => {
    while (active.size > 0) await takeNextActive();
  };

  try {
    while ((pending.size > 0 || active.size > 0) && !cycleFailure) {
      for (const [id, definition] of pending) {
        const dependenciesReady = definition.dependencies
          .filter((dependencyId) => enabledIds.has(dependencyId))
          .every((dependencyId) => terminals.has(dependencyId));
        if (!dependenciesReady) continue;
        pending.delete(id);
        startDefinition(id, definition);
      }
      if (active.size === 0) {
        if (pending.size === 0) break;
        abortCycle(codedError("AUTONOMOUS_WORKFLOW_GRAPH_STALLED"));
        break;
      }
      const completed = await takeNextActive();
      if (completed.error) {
        abortCycle(completed.error);
        break;
      }
      terminals.set(completed.id, completed.terminal);
    }

    if (cycleFailure) {
      await drainActive();
      throw cycleFailure;
    }

    const orderedTerminals = enabledDefinitions.map(({ id }) => terminals.get(id));
    const status = orderedTerminals.some(({ classification }) =>
      !["success", "no_action"].includes(classification)
    ) ? "partial" : "success";
    return Object.freeze({
      status,
      terminals: Object.freeze(orderedTerminals),
      decisions: Object.freeze(decisionRecords)
    });
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
  }
};

export { createBoundedScheduler, executeWorkflowGraph, resourcePressureSample };
