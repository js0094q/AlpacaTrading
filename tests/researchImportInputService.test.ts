import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

import {
  RESEARCH_IMPORT_MAX_BYTES,
  readBoundedResearchImportJson
} from "../src/services/researchImportInputService.js";

test("reads structured JSON from bounded stdin chunks", async () => {
  const result = await readBoundedResearchImportJson(
    Readable.from([
      Buffer.from('{"schema_version":1,'),
      Buffer.from('"signals":[]}')
    ])
  );

  assert.deepEqual(result, { schema_version: 1, signals: [] });
});

test("rejects empty, malformed, and oversized input without echoing content", async () => {
  await assert.rejects(
    readBoundedResearchImportJson(Readable.from([])),
    /RESEARCH_IMPORT_INPUT_REQUIRED/
  );
  await assert.rejects(
    readBoundedResearchImportJson(
      Readable.from([Buffer.from('{"secret":"must-not-appear"')])
    ),
    (error) =>
      error instanceof Error &&
      error.message === "RESEARCH_IMPORT_JSON_INVALID"
  );
  await assert.rejects(
    readBoundedResearchImportJson(
      Readable.from([Buffer.alloc(RESEARCH_IMPORT_MAX_BYTES + 1)])
    ),
    /RESEARCH_IMPORT_INPUT_TOO_LARGE/
  );
});

test("production import is stdin-only and does not accept a file or browser surface", async () => {
  const source = await readFile(
    new URL("../src/postgresOnlyCli.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /command === "research:import"/);
  assert.match(source, /readBoundedResearchImportJson\(process\.stdin\)/);
  assert.doesNotMatch(source, /researchImportPath|researchFile|readFileSync/);
  assert.doesNotMatch(source, /chatgpt|playwright|browser/i);
});
