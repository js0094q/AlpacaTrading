import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("outcome modules are structurally separated from execution and Alpaca clients", async () => {
  const files = [
    "src/services/outcomeLearningModel.ts",
    "src/services/postgresOutcomeLearningService.ts",
    "src/services/historicalOutcomeEvidenceService.ts"
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:alpacaClient|ExecutionService|OrderManager|orderSubmission|submitOrder)[^"']*["']/i,
      file
    );
    assert.doesNotMatch(
      source,
      /\b(?:submitPaperOrder|cancelPaperOrder|replacePaperOrder|createOrderIntent|clientOrderId\s*=)\b/,
      file
    );
    assert.doesNotMatch(
      source,
      /\b(?:UPDATE|DELETE FROM)\s+(?:candidates|portfolio_arbitration_decisions|execution_reviews|order_intents|orders|positions|broker_events)\b/i,
      file
    );
  }
});

test("production CLI routes paper learning to the bounded fenced service, not generic recovery inspection", async () => {
  const cli = await readFile(
    new URL("../src/postgresOnlyCli.ts", import.meta.url),
    "utf8"
  );
  assert.match(cli, /runPostgresOutcomeLearningRefresh/);
  assert.match(cli, /readBoundedOutcomeLearningRecords/);
  assert.match(cli, /readBoundedHistoricalOutcomeAggregates/);
  assert.match(cli, /command === "paper:learn"/);
  assert.match(cli, /command === "paper:outcomes"/);
  assert.doesNotMatch(
    cli,
    /AUTONOMOUS_INSPECTION_COMMANDS = new Set\(\[\s*"paper:learn"/
  );

  const genericInspection = await readFile(
    new URL(
      "../src/services/autonomousPostgresCommandService.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(genericInspection, /"paper:learn"/);
});

test("historical outcome evidence cannot rewrite score, thresholds, priority, or configuration", async () => {
  const evidence = await readFile(
    new URL(
      "../src/services/historicalOutcomeEvidenceService.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(evidence, /\b(?:scoreAdjustment|thresholdRewrite|strategyPriority|capitalAllocation|leapsCeiling)\b/);
  assert.match(evidence, /historicalOutcomeEvidence: evidence/);

  const workflow = await readFile(
    new URL(
      "../src/services/postgresResearchWorkflowService.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(
    workflow,
    /baseCandidateScore\.total \+ researchInfluence\.scoreAdjustment/
  );
  assert.doesNotMatch(
    workflow,
    /baseCandidateScore\.total \+ historicalEvidence/
  );
  assert.match(workflow, /attachHistoricalOutcomeEvidence/);
});
