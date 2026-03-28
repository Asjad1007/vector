// ============================================================================
// Vector Integration Gateway — Drift Detector
// ============================================================================
// Detects schema drift by comparing the SHA-256 hash of the remote CRM schema
// against the stored hash in the integration contract.
//
// When drift is detected, the system:
// 1. Identifies exactly WHICH fields are missing, changed in type, or new
// 2. Creates a drift_alert record for observability
// 3. Sets the contract status to DRIFT_DETECTED
//
// Algorithm:
//   hash(sorted fields + types) → compare → if mismatch → full diff
// ============================================================================

import { createHash } from 'node:crypto';
import { logger } from './logger.js';
import * as db from './db.js';
import { getSchemaFetcher } from './mockService.js';
import type {
  IntegrationContract,
  RemoteSchemaField,
  DriftReport,
  TypeChange,
  LogContext,
  MappingContract,
} from './types.js';
import { ContractStatus } from './types.js';

// --------------------------------------------------------
// Schema Hashing
// --------------------------------------------------------

/**
 * Generate a deterministic SHA-256 hash of a remote schema.
 * Fields are sorted alphabetically and serialized with their types
 * to ensure consistent hashing regardless of API response ordering.
 */
export function generateSchemaHash(fields: RemoteSchemaField[]): string {
  // Sort deterministically by field name
  const sorted = [...fields].sort((a, b) => a.name.localeCompare(b.name));

  // Create a canonical representation: "name:type" pairs
  const canonical = sorted.map(f => `${f.name}:${f.type}`).join('|');

  // SHA-256 hash
  return createHash('sha256').update(canonical).digest('hex');
}

// --------------------------------------------------------
// Drift Detection
// --------------------------------------------------------

/**
 * Detect schema drift for a single integration contract.
 *
 * Returns a DriftReport with:
 * - has_drift: whether the schema has changed
 * - missing_fields: fields in the contract but gone from the CRM
 * - type_changes: fields that changed type
 * - new_fields: fields in the CRM but not in the contract
 */
export function detectDrift(contract: IntegrationContract): DriftReport {
  const ctx: LogContext = {
    customer_id: contract.customer_id,
    contract_id: contract.id,
    platform: contract.platform_name,
  };
  const log = logger.child(ctx);

  log.info('Starting drift detection');

  // 1. Fetch the current remote schema
  const fetchSchema = getSchemaFetcher(contract.platform_name);
  const remoteFields = fetchSchema(contract.customer_id);

  log.debug('Remote schema fetched', {
    field_count: remoteFields.length,
  });

  // 2. Generate hash of current remote schema
  const currentHash = generateSchemaHash(remoteFields);

  // 3. Compare to stored hash
  const previousHash = contract.last_seen_schema_hash;
  const hasDrift = previousHash !== null && previousHash !== currentHash;

  if (!hasDrift) {
    // Update the hash if this is the first scan or no drift detected
    db.updateContractSchemaHash(contract.id, currentHash);

    log.info('No schema drift detected', {
      hash: currentHash.substring(0, 12) + '...',
    });

    return {
      contract_id: contract.id,
      customer_id: contract.customer_id,
      platform: contract.platform_name,
      has_drift: false,
      previous_hash: previousHash,
      current_hash: currentHash,
      missing_fields: [],
      type_changes: [],
      new_fields: [],
      timestamp: new Date().toISOString(),
    };
  }

  // 4. Drift detected — identify EXACTLY what changed
  log.warn('Schema drift detected!', {
    previous_hash: previousHash?.substring(0, 12) + '...',
    current_hash: currentHash.substring(0, 12) + '...',
  });

  const { missingFields, typeChanges, newFields } = identifyDriftDetails(
    contract.mapping_contract as MappingContract,
    remoteFields,
    log,
  );

  // 5. Create a drift alert record
  db.createDriftAlert(
    contract.id,
    previousHash ?? '',
    currentHash,
    missingFields,
    typeChanges,
    newFields,
  );

  // 6. Update contract status
  db.updateContractStatus(contract.id, ContractStatus.DRIFT_DETECTED);
  db.updateContractSchemaHash(contract.id, currentHash);

  log.warn('Contract paused due to schema drift', {
    missing_fields: missingFields,
    type_changes: typeChanges.map(tc => `${tc.field}: ${tc.expected_type} → ${tc.actual_type}`),
    new_fields: newFields,
  });

  return {
    contract_id: contract.id,
    customer_id: contract.customer_id,
    platform: contract.platform_name,
    has_drift: true,
    previous_hash: previousHash,
    current_hash: currentHash,
    missing_fields: missingFields,
    type_changes: typeChanges,
    new_fields: newFields,
    timestamp: new Date().toISOString(),
  };
}

// --------------------------------------------------------
// Full Schema Diff
// --------------------------------------------------------

/**
 * Identify exactly which fields are missing, changed in type, or newly added.
 * This runs only when the hash comparison shows drift (O(n) fallback).
 */
function identifyDriftDetails(
  mappingContract: MappingContract,
  remoteFields: RemoteSchemaField[],
  log: ReturnType<typeof logger.child>,
): {
  missingFields: string[];
  typeChanges: TypeChange[];
  newFields: string[];
} {
  const missingFields: string[] = [];
  const typeChanges: TypeChange[] = [];

  // Build a lookup of remote fields by name
  const remoteFieldMap = new Map<string, RemoteSchemaField>();
  for (const field of remoteFields) {
    remoteFieldMap.set(field.name, field);
  }

  // Build a set of all target keys in the mapping contract
  const contractTargetKeys = new Set<string>();

  // Check each mapped field against the remote schema
  for (const [vectorField, mapping] of Object.entries(mappingContract)) {
    contractTargetKeys.add(mapping.target_key);

    const remoteField = remoteFieldMap.get(mapping.target_key);

    if (!remoteField) {
      // Field exists in contract but not in remote schema — MISSING
      missingFields.push(mapping.target_key);
      log.warn(`Field missing from remote schema: "${mapping.target_key}"`, {
        vector_field: vectorField,
        target_key: mapping.target_key,
      });
    } else if (remoteField.type !== mapping.target_type) {
      // Field exists but type has changed
      typeChanges.push({
        field: mapping.target_key,
        expected_type: mapping.target_type,
        actual_type: remoteField.type,
      });
      log.warn(`Field type changed: "${mapping.target_key}"`, {
        vector_field: vectorField,
        expected: mapping.target_type,
        actual: remoteField.type,
      });
    }
  }

  // Check for new fields in remote that aren't in the contract
  const newFields: string[] = [];
  for (const remoteField of remoteFields) {
    if (!contractTargetKeys.has(remoteField.name)) {
      newFields.push(remoteField.name);
    }
  }

  if (newFields.length > 0) {
    log.info('New fields detected in remote schema', {
      new_fields: newFields,
    });
  }

  return { missingFields, typeChanges, newFields };
}

// --------------------------------------------------------
// Batch Drift Scan
// --------------------------------------------------------

/**
 * Scan ALL active contracts for schema drift.
 * Designed to be run on a schedule (e.g., every 15 minutes via cron).
 */
export function runDriftScan(): DriftReport[] {
  logger.info('Starting full drift scan', {
    customer_id: 'SYSTEM',
    contract_id: 'SYSTEM',
  });

  const activeContracts = db.getAllActiveContracts();

  logger.info(`Found ${activeContracts.length} active contracts to scan`, {
    customer_id: 'SYSTEM',
    contract_id: 'SYSTEM',
    contract_count: activeContracts.length,
  });

  const reports: DriftReport[] = [];

  for (const contract of activeContracts) {
    try {
      const report = detectDrift(contract);
      reports.push(report);
    } catch (error) {
      logger.error(`Drift detection failed for contract ${contract.id}`, {
        customer_id: contract.customer_id,
        contract_id: contract.id,
        platform: contract.platform_name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const driftCount = reports.filter(r => r.has_drift).length;
  logger.info(`Drift scan complete: ${driftCount}/${reports.length} contracts have drift`, {
    customer_id: 'SYSTEM',
    contract_id: 'SYSTEM',
    total_scanned: reports.length,
    drift_detected: driftCount,
  });

  return reports;
}
