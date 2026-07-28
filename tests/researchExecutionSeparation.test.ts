import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import test from "node:test";

const sourceRoot = resolve(process.cwd(), "src");
const roots = [
  resolve(sourceRoot, "services/researchSignalAdapterService.ts"),
  resolve(sourceRoot, "services/researchImportInputService.ts"),
  resolve(sourceRoot, "repositories/postgres/postgresResearchSignalRepository.ts")
];
const forbiddenModules = new Set([
  resolve(sourceRoot, "services/alpacaClient.ts"),
  resolve(sourceRoot, "services/autonomousPostgresExecutionService.ts"),
  resolve(sourceRoot, "services/paperReviewedPayloadExecutionService.ts"),
  resolve(sourceRoot, "services/paperOptionOrderValidationService.ts")
]);

const localImports = async (path: string) => {
  const source = await readFile(path, "utf8");
  const imports = [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)]
    .map((match) => match[1]!)
    .map((specifier) => resolve(
      dirname(path),
      extname(specifier) ? specifier.replace(/\.js$/, ".ts") : `${specifier}.ts`
    ))
    .filter((candidate) => candidate.startsWith(sourceRoot));
  return imports;
};

test("research adapter and persistence import graph cannot reach order submission", async () => {
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    assert.equal(
      forbiddenModules.has(current),
      false,
      `research import graph reached broker mutation module ${current}`
    );
    pending.push(...await localImports(current));
  }
  assert.ok(roots.every((root) => visited.has(root)));
});

test("normalized research data exposes no executable broker payload fields", async () => {
  const { normalizeResearchImport } = await import(
    "../src/services/researchSignalAdapterService.js"
  );
  const result = normalizeResearchImport({
    schema_version: 1,
    signals: [{
      provider: "manual",
      symbol: "SPY",
      as_of: "2026-07-28T12:00:00.000Z",
      horizon: "short_term",
      source_references: ["research://manual/spy"]
    }]
  }, { ingestedAt: new Date("2026-07-28T14:00:00.000Z") });
  const serialized = JSON.stringify(result.accepted[0]);

  for (const field of [
    "quantity",
    "side",
    "orderType",
    "limitPrice",
    "stopPrice",
    "clientOrderId",
    "brokerPayload",
    "executionMethod"
  ]) {
    assert.equal(serialized.includes(`"${field}"`), false, field);
  }
});

test("research scoring integration has no direct broker mutation dependency", async () => {
  const source = await readFile(
    resolve(sourceRoot, "services/postgresResearchWorkflowService.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /submitPaperOrder|cancelPaperOrder|replacePaperOrder/);
  assert.doesNotMatch(
    source,
    /autonomousPostgresExecutionService|paperReviewedPayloadExecutionService/
  );

  const cli = await readFile(resolve(sourceRoot, "postgresOnlyCli.ts"), "utf8");
  const handler = cli.match(
    /if \(command === "research:import"\) \{([\s\S]*?)\n  \}\n\n  if \(command === "research:daily"\)/
  )?.[1] ?? "";
  assert.match(handler, /importResearchSignals/);
  assert.doesNotMatch(
    handler,
    /submit|cancel|replace|closePosition|orderIntent|brokerPayload/i
  );
});
