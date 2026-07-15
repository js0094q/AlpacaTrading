import type { Pool } from "pg";

import {
  databaseConfigDiagnostics,
  loadDatabaseConfig
} from "../../../src/lib/database/config.js";
import type { PostgresConnectionMode } from "../../../src/lib/database/postgres.js";
import { checkPostgresConnectivity } from "../../../src/lib/database/postgresConnectivity.js";

export const buildVercelPostgresDatabaseHealth = async (
  environment: Record<string, string | undefined> = process.env,
  dependencies: {
    createPool?: (
      config: ReturnType<typeof loadDatabaseConfig>,
      mode: PostgresConnectionMode
    ) => Pool;
    now?: () => number;
  } = {}
) => {
  const config = loadDatabaseConfig(
    { ...environment, DATABASE_BACKEND: "postgres" },
    { runtime: "vercel", purpose: "application" }
  );
  return {
    runtime: "vercel",
    config: databaseConfigDiagnostics(config),
    connectivity: await checkPostgresConnectivity(config, {
      mode: "pooled",
      ...dependencies
    })
  };
};
