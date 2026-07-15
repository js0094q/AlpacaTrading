import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";

import { buildVercelPostgresDatabaseHealth } from "../apps/dashboard/lib/databaseHealth.js";

test("Vercel database health uses the pooled variable and emits no connection value", async () => {
  const client = {
    query: async () => ({
      rows: [{
        server_version_num: "170004",
        transaction_timeout: "0"
      }],
      rowCount: 1
    } as unknown as QueryResult),
    connection: { stream: { encrypted: true } },
    release: () => undefined
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
    end: async () => undefined
  } as unknown as Pool;
  const result = await buildVercelPostgresDatabaseHealth(
    {
      DATABASE_URL: "postgresql://synthetic:synthetic-password@host.invalid/db",
      DATABASE_URL_UNPOOLED: "postgresql://synthetic:synthetic-password@direct.invalid/db"
    },
    { createPool: () => pool, now: () => 100 }
  );

  assert.equal(result.runtime, "vercel");
  assert.equal(result.config.pool.maxConnections, 1);
  assert.equal(result.connectivity.variable, "DATABASE_URL");
  assert.equal(result.connectivity.connectionTest, "passed");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-password|host\.invalid|direct\.invalid/);
});

test("Vercel database health fails closed when the integration variable is absent", async () => {
  await assert.rejects(
    () => buildVercelPostgresDatabaseHealth({}),
    /DATABASE_URL/
  );
});
