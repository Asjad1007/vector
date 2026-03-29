// Vector Integration Gateway — Database Layer (SQLite)
// SQLite database using `better-sqlite3` for zero-infrastructure local dev.
// Provides typed query execution, transaction support, and structured logging.
//
// The database file is created at the path specified by DATABASE_PATH env var
// (defaults to ./vector.db in the project root).

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { logger, systemContext } from './logger.js';
import type {
  IntegrationContract,
  MappingContract,
  PlatformName,
  SyncLogEntry,
  SyncStatus,
  DriftAlertRecord,
  ContractStatus,
  VectorVisitorPayload,
  TypeChange,
} from './types.js';

// Database Initialization

const DATABASE_PATH = process.env['DATABASE_PATH'] ?? resolve(process.cwd(), 'vector.db');

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DATABASE_PATH);
    // Enable WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');
    // Enable foreign keys (off by default in SQLite)
    db.pragma('foreign_keys = ON');

    logger.info('Database connection established', {
      ...systemContext(),
      path: DATABASE_PATH,
    });
  }
  return db;
}

/**
 * Initialize the database schema from schema.sql.
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export function initializeSchema(): void {
  const schemaPath = join(process.cwd(), 'src', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  getDb().exec(schema);
  logger.info('Database schema initialized', systemContext());
}

// Contract Operations

export function createContract(
  customerId: string,
  platformName: PlatformName,
  mappingContract: MappingContract,
  schemaHash: string | null = null,
): IntegrationContract {
  const d = getDb();
  const id = randomUUID();

  // Check if contract already exists for this customer + platform
  const existing = d.prepare(
    `SELECT id, version FROM integration_contracts WHERE customer_id = ? AND platform_name = ?`,
  ).get(customerId, platformName) as { id: string; version: number } | undefined;

  if (existing) {
    // Update existing contract (upsert behavior)
    d.prepare(
      `UPDATE integration_contracts
       SET mapping_contract = ?, last_seen_schema_hash = ?, status = 'ACTIVE',
           version = version + 1, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(JSON.stringify(mappingContract), schemaHash, existing.id);

    return getContractById(existing.id)!;
  }

  // Insert new contract
  d.prepare(
    `INSERT INTO integration_contracts (id, customer_id, platform_name, mapping_contract, last_seen_schema_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, customerId, platformName, JSON.stringify(mappingContract), schemaHash);

  return getContractById(id)!;
}

export function getActiveContract(
  customerId: string,
  platformName: PlatformName,
): IntegrationContract | null {
  const row = getDb().prepare(
    `SELECT * FROM integration_contracts
     WHERE customer_id = ? AND platform_name = ? AND status = 'ACTIVE'
     LIMIT 1`,
  ).get(customerId, platformName) as RawContractRow | undefined;

  return row ? deserializeContract(row) : null;
}

export function getContractById(contractId: string): IntegrationContract | null {
  const row = getDb().prepare(
    `SELECT * FROM integration_contracts WHERE id = ? LIMIT 1`,
  ).get(contractId) as RawContractRow | undefined;

  return row ? deserializeContract(row) : null;
}

export function getAllActiveContracts(): IntegrationContract[] {
  const rows = getDb().prepare(
    `SELECT * FROM integration_contracts WHERE status = 'ACTIVE' ORDER BY customer_id`,
  ).all() as RawContractRow[];

  return rows.map(deserializeContract);
}

export function updateContractStatus(
  contractId: string,
  status: ContractStatus,
): void {
  getDb().prepare(
    `UPDATE integration_contracts SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(status, contractId);
}

export function updateContractSchemaHash(
  contractId: string,
  schemaHash: string,
): void {
  getDb().prepare(
    `UPDATE integration_contracts SET last_seen_schema_hash = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(schemaHash, contractId);
}

// Sync Log Operations

export function createSyncLog(
  contractId: string,
  transformedPayload: Record<string, unknown>,
  rawPayload: VectorVisitorPayload | null = null,
): SyncLogEntry {
  const id = randomUUID();

  getDb().prepare(
    `INSERT INTO sync_logs (id, contract_id, payload, raw_payload, status)
     VALUES (?, ?, ?, ?, 'PENDING')`,
  ).run(id, contractId, JSON.stringify(transformedPayload), rawPayload ? JSON.stringify(rawPayload) : null);

  return getSyncLogById(id)!;
}

export function getPendingAndRetryableSyncLogs(): SyncLogEntry[] {
  const rows = getDb().prepare(
    `SELECT * FROM sync_logs
     WHERE (status = 'PENDING')
        OR (status = 'RETRYING' AND next_retry_at <= datetime('now'))
     ORDER BY created_at ASC
     LIMIT 50`,
  ).all() as RawSyncLogRow[];

  return rows.map(deserializeSyncLog);
}

export function updateSyncLogStatus(
  syncLogId: string,
  status: SyncStatus,
  updates: {
    attempt_count?: number;
    next_retry_at?: Date | null;
    error_message?: string | null;
    last_error_code?: number | null;
  } = {},
): void {
  getDb().prepare(
    `UPDATE sync_logs
     SET status = ?,
         attempt_count = COALESCE(?, attempt_count),
         next_retry_at = ?,
         error_message = ?,
         last_error_code = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    status,
    updates.attempt_count ?? null,
    updates.next_retry_at?.toISOString() ?? null,
    updates.error_message ?? null,
    updates.last_error_code ?? null,
    syncLogId,
  );
}

function getSyncLogById(id: string): SyncLogEntry | null {
  const row = getDb().prepare(
    `SELECT * FROM sync_logs WHERE id = ? LIMIT 1`,
  ).get(id) as RawSyncLogRow | undefined;

  return row ? deserializeSyncLog(row) : null;
}

// Drift Alert Operations

export function createDriftAlert(
  contractId: string,
  previousHash: string,
  currentHash: string,
  missingFields: string[],
  typeChanges: TypeChange[],
  newFields: string[],
): DriftAlertRecord {
  const id = randomUUID();

  getDb().prepare(
    `INSERT INTO drift_alerts (id, contract_id, previous_hash, current_hash, missing_fields, type_changes, new_fields)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    contractId,
    previousHash,
    currentHash,
    JSON.stringify(missingFields),
    JSON.stringify(typeChanges),
    JSON.stringify(newFields),
  );

  return getDriftAlertById(id)!;
}

export function getUnresolvedAlerts(contractId: string): DriftAlertRecord[] {
  const rows = getDb().prepare(
    `SELECT * FROM drift_alerts
     WHERE contract_id = ? AND resolved = 0
     ORDER BY created_at DESC`,
  ).all(contractId) as RawDriftAlertRow[];

  return rows.map(deserializeDriftAlert);
}

function getDriftAlertById(id: string): DriftAlertRecord | null {
  const row = getDb().prepare(
    `SELECT * FROM drift_alerts WHERE id = ? LIMIT 1`,
  ).get(id) as RawDriftAlertRow | undefined;

  return row ? deserializeDriftAlert(row) : null;
}

// Transaction Support

export function withTransaction<T>(fn: () => T): T {
  const d = getDb();
  const transaction = d.transaction(fn);
  return transaction();
}

// Lifecycle

export function disconnectPool(): void {
  if (db) {
    db.close();
    logger.info('Database connection closed', systemContext());
  }
}

// For backwards compat with async callers
export { disconnectPool as disconnectPoolAsync };

// Raw Row Types (what SQLite actually returns)

interface RawContractRow {
  id: string;
  customer_id: string;
  platform_name: string;
  mapping_contract: string;
  last_seen_schema_hash: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface RawSyncLogRow {
  id: string;
  contract_id: string;
  payload: string;
  raw_payload: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  error_message: string | null;
  last_error_code: number | null;
  created_at: string;
  updated_at: string;
}

interface RawDriftAlertRow {
  id: string;
  contract_id: string;
  previous_hash: string;
  current_hash: string;
  missing_fields: string;
  type_changes: string;
  new_fields: string;
  resolved: number;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

// Deserializers (raw SQLite rows → typed objects)

function deserializeContract(row: RawContractRow): IntegrationContract {
  return {
    id: row.id,
    customer_id: row.customer_id,
    platform_name: row.platform_name as PlatformName,
    mapping_contract: JSON.parse(row.mapping_contract) as MappingContract,
    last_seen_schema_hash: row.last_seen_schema_hash,
    status: row.status as ContractStatus,
    version: row.version,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function deserializeSyncLog(row: RawSyncLogRow): SyncLogEntry {
  return {
    id: row.id,
    contract_id: row.contract_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    raw_payload: row.raw_payload ? (JSON.parse(row.raw_payload) as VectorVisitorPayload) : null,
    status: row.status as SyncStatus,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    next_retry_at: row.next_retry_at ? new Date(row.next_retry_at) : null,
    error_message: row.error_message,
    last_error_code: row.last_error_code,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function deserializeDriftAlert(row: RawDriftAlertRow): DriftAlertRecord {
  return {
    id: row.id,
    contract_id: row.contract_id,
    previous_hash: row.previous_hash,
    current_hash: row.current_hash,
    missing_fields: JSON.parse(row.missing_fields) as string[],
    type_changes: JSON.parse(row.type_changes) as TypeChange[],
    new_fields: JSON.parse(row.new_fields) as string[],
    resolved: row.resolved === 1,
    resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
    resolved_by: row.resolved_by,
    created_at: new Date(row.created_at),
  };
}
