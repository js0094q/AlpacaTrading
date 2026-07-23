import { createHash } from "node:crypto";

import { canonicalJsonHash } from "../src/lib/canonicalJson.js";
import { loadDatabaseConfig } from "../src/lib/database/config.js";
import { createPostgresPool } from "../src/lib/database/postgres.js";
import { canonicalizePostgresNumeric } from "../src/services/controlPlaneMigrationService.js";
import { readExecutionStateSnapshot } from "../src/services/executionStateMigrationService.js";

const snapshotPath = process.env.EXECUTION_STATE_SNAPSHOT_PATH;
if (!snapshotPath) throw new Error("EXECUTION_STATE_SNAPSHOT_PATH_REQUIRED");

const hash = (value: unknown) => createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(value) ?? String(value))
  .digest("hex")
  .slice(0, 16);

const parseJson = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const utc = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
};

const timeRelation = (source: unknown, target: unknown) => {
  const sourceMs = Date.parse(String(source));
  const targetMs = Date.parse(String(target));
  if (!Number.isFinite(sourceMs) || !Number.isFinite(targetMs)) return "unparseable";
  if (sourceMs === targetMs) return "equal_after_utc_normalization";
  return sourceMs < targetMs ? "source_older" : "source_newer";
};

const numericFields = new Set([
  "cash", "portfolio_value", "equity", "buying_power", "options_buying_power"
]);

const comparable = (field: string, value: unknown) => {
  if (value === null || value === undefined) return null;
  if (field === "evidence") return canonicalJsonHash(parseJson(value));
  if (numericFields.has(field)) {
    return canonicalizePostgresNumeric(value as string | number, 28, 8);
  }
  if (field.endsWith("_at")) return utc(value);
  return value;
};

const differingJsonPaths = (source: unknown, target: unknown, prefix = ""): string[] => {
  if (Object.is(source, target)) return [];
  if (
    source === null || target === null ||
    typeof source !== "object" || typeof target !== "object" ||
    Array.isArray(source) !== Array.isArray(target)
  ) return [prefix || "<root>"];
  if (Array.isArray(source) && Array.isArray(target)) {
    const paths: string[] = [];
    for (let index = 0; index < Math.max(source.length, target.length); index += 1) {
      paths.push(...differingJsonPaths(source[index], target[index], `${prefix}[${index}]`));
    }
    return paths;
  }
  const keys = new Set([
    ...Object.keys(source as Record<string, unknown>),
    ...Object.keys(target as Record<string, unknown>)
  ]);
  return [...keys].sort().flatMap((key) => differingJsonPaths(
    (source as Record<string, unknown>)[key],
    (target as Record<string, unknown>)[key],
    prefix ? `${prefix}.${key}` : key
  ));
};

const fields = [
  "id", "account_id", "observed_at", "source", "request_id",
  "account_status", "currency", "cash", "portfolio_value", "equity",
  "buying_power", "options_buying_power", "options_approved_level",
  "trading_blocked", "account_blocked", "snapshot_fingerprint", "evidence",
  "created_at"
] as const;

const classifications: Record<string, string> = {
  id: "primary_key_provenance",
  account_id: "immutable_identity",
  snapshot_fingerprint: "immutable_identity",
  currency: "immutable_identity",
  observed_at: "observation_provenance",
  source: "observation_provenance",
  request_id: "observation_provenance",
  created_at: "observation_provenance",
  account_status: "snapshot_evidence",
  cash: "snapshot_evidence",
  portfolio_value: "snapshot_evidence",
  equity: "snapshot_evidence",
  buying_power: "snapshot_evidence",
  options_buying_power: "snapshot_evidence",
  options_approved_level: "snapshot_evidence",
  trading_blocked: "snapshot_evidence",
  account_blocked: "snapshot_evidence",
  evidence: "snapshot_evidence"
};

const downstream = [
  ["portfolio_exposure", "account_snapshot_id"],
  ["buying_power_reservations", "account_snapshot_id"],
  ["positions", "source_account_snapshot_id"]
] as const;

const pool = createPostgresPool(
  loadDatabaseConfig(process.env, { runtime: "vps", purpose: "backfill" }),
  "direct"
);

try {
  console.error("DIAGNOSTIC_PHASE:read_source_start");
  const source = await readExecutionStateSnapshot(snapshotPath);
  console.error("DIAGNOSTIC_PHASE:read_source_done");
  const sourceSnapshots = [...(source.rows.get("account_snapshots") ?? [])];
  const accountIds = [...new Set(sourceSnapshots.map((row) => String(row.account_id)))];
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120000'");
    const result = await client.query(`
      SELECT id, account_id, observed_at, source, request_id,
             account_status, currency, cash::text, portfolio_value::text,
             equity::text, buying_power::text, options_buying_power::text,
             options_approved_level, trading_blocked, account_blocked,
             snapshot_fingerprint, evidence::text AS evidence, created_at
      FROM account_snapshots
      WHERE account_id = ANY($1::text[])
      ORDER BY id
    `, [accountIds]);
    console.error("DIAGNOSTIC_PHASE:postgres_read_done");
    const targetSnapshots = result.rows as Record<string, unknown>[];
    const targetById = new Map(targetSnapshots.map((row) => [String(row.id), row]));
    const targetByIdentity = new Map(targetSnapshots.map((row) => [
      `${String(row.account_id)}\u0000${String(row.snapshot_fingerprint)}`,
      row
    ]));
    const collisions = [] as Record<string, unknown>[];

    for (const sourceRow of sourceSnapshots) {
      const identity = `${String(sourceRow.account_id)}\u0000${String(sourceRow.snapshot_fingerprint)}`;
      const targetRow = targetByIdentity.get(identity);
      if (!targetRow || String(targetRow.id) === String(sourceRow.id)) continue;
      const differences = fields.flatMap((field) => {
        if (field === "id") return [];
        const sourceValue = comparable(field, sourceRow[field]);
        const targetValue = comparable(field, targetRow[field]);
        if (Object.is(sourceValue, targetValue)) return [];
        const difference: Record<string, unknown> = {
          field,
          classification: classifications[field],
          sourceNormalizedHash: hash(sourceValue),
          targetNormalizedHash: hash(targetValue)
        };
        if (field === "observed_at" || field === "created_at") {
          difference.relation = timeRelation(sourceValue, targetValue);
        }
        if (field === "evidence") {
          difference.sourceEvidenceHash = String(sourceValue).slice(0, 16);
          difference.targetEvidenceHash = String(targetValue).slice(0, 16);
          difference.differingEvidencePaths = differingJsonPaths(
            parseJson(sourceRow[field]),
            parseJson(targetRow[field])
          ).slice(0, 100);
        }
        return [difference];
      });
      const referenceReport: Record<string, unknown> = {};
      for (const [table, column] of downstream) {
        const targetRefs = await client.query(
          `SELECT id FROM ${table} WHERE ${column} = ANY($1::text[]) ORDER BY id`,
          [[String(sourceRow.id), String(targetRow.id)]]
        );
        const sourceRefs = (source.rows.get(table) ?? []).filter((row) =>
          String(row[column]) === String(sourceRow.id)
        );
        referenceReport[table] = {
          column,
          sourceRowCount: sourceRefs.length,
          sourceRowIdHashes: sourceRefs.map((row) => hash(row.id)),
          targetRowCount: targetRefs.rowCount ?? 0,
          targetRowIdHashes: targetRefs.rows.map((row) => hash(row.id))
        };
      }
      collisions.push({
        sourceIdHash: hash(sourceRow.id),
        targetIdHash: hash(targetRow.id),
        accountIdHash: hash(sourceRow.account_id),
        snapshotFingerprintHash: hash(sourceRow.snapshot_fingerprint),
        sourceRowHash: hash(sourceRow),
        targetRowHash: hash(targetRow),
        sourcePrimaryKeyAlreadyPresent: targetById.has(String(sourceRow.id)),
        sourceObservedAt: timeRelation(utc(sourceRow.observed_at), utc(targetRow.observed_at)),
        sourceCreatedAt: timeRelation(utc(sourceRow.created_at), utc(targetRow.created_at)),
        differences,
        downstreamReferences: referenceReport
      });
    }

    const sourceIdentityCounts = new Map<string, number>();
    for (const row of sourceSnapshots) {
      const identity = `${String(row.account_id)}\u0000${String(row.snapshot_fingerprint)}`;
      sourceIdentityCounts.set(identity, (sourceIdentityCounts.get(identity) ?? 0) + 1);
    }
    console.log(JSON.stringify({
      snapshotSha256: source.snapshotSha256,
      sourceAccountIdCount: accountIds.length,
      sourceSnapshotCount: sourceSnapshots.length,
      targetSnapshotCountForSourceAccounts: targetSnapshots.length,
      sourceDuplicateIdentityCount: [...sourceIdentityCounts.values()].filter((count) => count > 1).length,
      identityCollisionCount: collisions.length,
      sameIdentityDifferentEvidenceCount: collisions.filter((collision) =>
        (collision.differences as Array<Record<string, unknown>>).some((difference) =>
          difference.classification === "snapshot_evidence"
        )
      ).length,
      identityCollisions: collisions,
      sourceIssues: source.sourceIssues
    }, null, 2));
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
