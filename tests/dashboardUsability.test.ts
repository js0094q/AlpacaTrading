import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("dashboard puts operational state before guarded controls", () => {
  const page = readFileSync("apps/dashboard/app/page.tsx", "utf8");

  assert.match(page, /Alpaca Paper Operations/);
  assert.match(page, /className="status-rail"/);
  assert.match(page, /id="overview"/);
  assert.match(page, /id="controls"/);
  assert.match(page, /<details className="guarded-actions" id="controls">/);
  assert.ok(
    page.indexOf('className="status-rail"') < page.indexOf("<ActionPanel"),
    "runtime and safety status must render before guarded controls"
  );
});

test("dashboard separates routine workflows from paper-mutating execution", () => {
  const panel = readFileSync("apps/dashboard/app/components/ActionPanel.tsx", "utf8");

  assert.match(panel, /routineActions/);
  assert.match(panel, /executionActions/);
  assert.match(panel, /Paper-mutating execution controls/);
  assert.match(panel, /Routine paper workflows/);
});
