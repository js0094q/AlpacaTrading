import { hostname } from "node:os";

import { getDb } from "../lib/db.js";
import { runWithSqliteBusyRetry } from "../lib/sqliteConcurrency.js";
import { uuid } from "../lib/utils.js";

export const HEAVY_PERSISTENCE_LEASE_NAME =
  "research-options-and-zero-dte-engine";
export const DEFAULT_HEAVY_PERSISTENCE_LEASE_TTL_MS = 60_000;
export const DEFAULT_HEAVY_PERSISTENCE_LEASE_MAX_WAIT_MS = 15_000;
export const DEFAULT_HEAVY_PERSISTENCE_LEASE_POLL_MS = 50;

export class SqliteWriteLeaseUnavailableError extends Error {
  readonly code = "SQLITE_WRITE_LEASE_UNAVAILABLE";

  constructor(leaseName: string) {
    super(`SQLite write lease ${leaseName} was not acquired within the bounded wait.`);
    this.name = "SqliteWriteLeaseUnavailableError";
  }
}

export class SqliteWriteLeaseLostError extends Error {
  readonly code = "SQLITE_WRITE_LEASE_LOST";

  constructor(leaseName: string) {
    super(`SQLite write lease ${leaseName} is no longer owned by this process.`);
    this.name = "SqliteWriteLeaseLostError";
  }
}

export interface HeavyPersistenceLease {
  readonly leaseName: string;
  readonly ownerId: string;
  assertOwnership: () => void;
  renew: () => void;
}

interface LeaseInput<T = unknown> {
  operation: (lease: HeavyPersistenceLease) => T;
  leaseName?: string;
  runId?: string | null;
  correlationId?: string | null;
  leaseTtlMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
}

interface LeaseRow {
  owner_id: string;
  expires_at: string;
}

const clamp = (value: number | undefined, fallback: number, min: number, max: number) => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const sleepSync = (milliseconds: number) => {
  if (milliseconds <= 0) return;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
};

const leaseContext = (input: LeaseInput, operation: string) => ({
  operation,
  transaction: operation,
  runId: input.runId || null,
  correlationId: input.correlationId || null,
  idempotent: true as const
});

const acquireLease = (input: LeaseInput, ownerId: string, ttlMs: number): boolean => {
  const db = getDb();
  const leaseName = input.leaseName || HEAVY_PERSISTENCE_LEASE_NAME;
  return runWithSqliteBusyRetry(() => {
    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      const current = db
        .prepare(
          "SELECT owner_id, expires_at FROM runtime_write_leases WHERE lease_name = ?"
        )
        .get(leaseName) as LeaseRow | undefined;
      const now = Date.now();
      const currentExpiresAt = current ? Date.parse(current.expires_at) : 0;
      if (current && current.owner_id !== ownerId && currentExpiresAt > now) {
        db.exec("COMMIT;");
        transactionStarted = false;
        return false;
      }

      const acquiredAt = new Date(now).toISOString();
      const expiresAt = new Date(now + ttlMs).toISOString();
      if (current) {
        db.prepare(
          `UPDATE runtime_write_leases
           SET owner_id = ?, acquired_at = ?, expires_at = ?
           WHERE lease_name = ?`
        ).run(ownerId, acquiredAt, expiresAt, leaseName);
      } else {
        db.prepare(
          `INSERT INTO runtime_write_leases(lease_name, owner_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)`
        ).run(leaseName, ownerId, acquiredAt, expiresAt);
      }
      db.exec("COMMIT;");
      transactionStarted = false;
      return true;
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Preserve the original acquisition failure.
        }
      }
      throw error;
    }
  }, leaseContext(input, "sqlite_write_lease.acquire"));
};

const assertLeaseOwnership = (
  leaseName: string,
  ownerId: string
): void => {
  const row = getDb()
    .prepare(
      "SELECT owner_id, expires_at FROM runtime_write_leases WHERE lease_name = ?"
    )
    .get(leaseName) as LeaseRow | undefined;
  if (!row || row.owner_id !== ownerId || Date.parse(row.expires_at) <= Date.now()) {
    throw new SqliteWriteLeaseLostError(leaseName);
  }
};

const renewLease = (input: LeaseInput, leaseName: string, ownerId: string, ttlMs: number) => {
  const db = getDb();
  runWithSqliteBusyRetry(() => {
    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      const now = Date.now();
      const result = db.prepare(
        `UPDATE runtime_write_leases
         SET expires_at = ?
         WHERE lease_name = ? AND owner_id = ? AND expires_at > ?`
      ).run(
        new Date(now + ttlMs).toISOString(),
        leaseName,
        ownerId,
        new Date(now).toISOString()
      );
      if (Number(result.changes) !== 1) {
        throw new SqliteWriteLeaseLostError(leaseName);
      }
      db.exec("COMMIT;");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Preserve the original renewal failure.
        }
      }
      throw error;
    }
  }, leaseContext(input, "sqlite_write_lease.renew"));
};

const releaseLease = (input: LeaseInput, leaseName: string, ownerId: string) => {
  const db = getDb();
  runWithSqliteBusyRetry(() => {
    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      db.prepare(
        "DELETE FROM runtime_write_leases WHERE lease_name = ? AND owner_id = ?"
      ).run(leaseName, ownerId);
      db.exec("COMMIT;");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Preserve the original release failure.
        }
      }
      throw error;
    }
  }, leaseContext(input, "sqlite_write_lease.release"));
};

export const withHeavyPersistenceLease = <T>(input: {
  operation: (lease: HeavyPersistenceLease) => T;
  leaseName?: string;
  runId?: string | null;
  correlationId?: string | null;
  leaseTtlMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
}): T => {
  const normalized = input;
  const leaseName = normalized.leaseName || HEAVY_PERSISTENCE_LEASE_NAME;
  const ttlMs = clamp(
    normalized.leaseTtlMs,
    DEFAULT_HEAVY_PERSISTENCE_LEASE_TTL_MS,
    100,
    300_000
  );
  const maxWaitMs = clamp(
    normalized.maxWaitMs,
    DEFAULT_HEAVY_PERSISTENCE_LEASE_MAX_WAIT_MS,
    0,
    300_000
  );
  const pollMs = clamp(
    normalized.pollMs,
    DEFAULT_HEAVY_PERSISTENCE_LEASE_POLL_MS,
    1,
    1_000
  );
  const ownerId = `${hostname()}:${process.pid}:${uuid()}`;
  const deadline = Date.now() + maxWaitMs;
  let acquired = false;
  while (!acquired) {
    acquired = acquireLease(normalized, ownerId, ttlMs);
    if (acquired) break;
    if (Date.now() >= deadline) {
      throw new SqliteWriteLeaseUnavailableError(leaseName);
    }
    sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }

  const lease: HeavyPersistenceLease = {
    leaseName,
    ownerId,
    assertOwnership: () => assertLeaseOwnership(leaseName, ownerId),
    renew: () => renewLease(normalized, leaseName, ownerId, ttlMs)
  };
  let result!: T;
  let operationError: unknown;
  try {
    lease.assertOwnership();
    result = normalized.operation(lease);
  } catch (error) {
    operationError = error;
  }

  try {
    releaseLease(normalized, leaseName, ownerId);
  } catch (releaseError) {
    if (operationError === undefined) {
      throw releaseError;
    }
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  return result;
};

export const sqliteWriteLeaseIdentity = () => `${hostname()}:${process.pid}`;
