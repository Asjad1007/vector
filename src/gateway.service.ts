// Vector Integration Gateway — Gateway Service
// The Dynamic Transformation Engine. Takes a raw Vector visitor payload,
// applies the JSONB mapping contract, and outputs a formatted JSON object
// ready for the target CRM's API.
//
// Key Feature: GRACEFUL DEGRADATION
// - Primary key fields (email, company_domain) → THROW on missing
// - Non-essential fields (page_url, signal_strength) → WARN + use default

import { logger } from './logger.js';
import * as db from './db.js';
import type {
  VectorVisitorPayload,
  MappingContract,
  FieldMapping,
  IntegrationContract,
  TransformationResult,
  TransformationWarning,
  TransformationError,
  ValidationResult,
  LogContext,
  PlatformName,
} from './types.js';
import { ContractStatus } from './types.js';

// Type Coercion

function coerceValue(
  value: unknown,
  targetType: FieldMapping['target_type'],
  fieldName: string,
  ctx: LogContext,
): unknown {
  if (value === null || value === undefined) return value;

  switch (targetType) {
    case 'string':
      return String(value);

    case 'number': {
      const num = Number(value);
      if (Number.isNaN(num)) {
        logger.warn(`Type coercion failed: cannot convert "${String(value)}" to number`, {
          ...ctx,
          field: fieldName,
          original_value: String(value),
          target_type: targetType,
        });
        return 0;
      }
      return num;
    }

    case 'boolean':
      if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value === '1';
      }
      return Boolean(value);

    case 'date': {
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) {
        logger.warn(`Type coercion failed: cannot parse "${String(value)}" as date`, {
          ...ctx,
          field: fieldName,
          original_value: String(value),
          target_type: targetType,
        });
        return new Date().toISOString();
      }
      return date.toISOString();
    }

    case 'json':
      return value;

    default:
      return value;
  }
}

// Payload Validation

/**
 * Pre-flight validation that distinguishes primary key errors from non-essential warnings.
 * This powers the Graceful Degradation feature.
 */
export function validatePayloadCompleteness(
  payload: VectorVisitorPayload,
  contract: MappingContract,
): ValidationResult {
  const primaryKeyErrors: TransformationError[] = [];
  const nonEssentialWarnings: TransformationWarning[] = [];

  for (const [vectorField, mapping] of Object.entries(contract)) {
    const value = getPayloadValue(payload, vectorField);
    const isMissing = value === undefined || value === null || value === '';

    if (isMissing && mapping.required) {
      if (mapping.is_primary_key) {
        // Primary key missing — this is a hard failure
        primaryKeyErrors.push({
          field: vectorField,
          message: `Primary key field "${vectorField}" (→ "${mapping.target_key}") is missing from payload. Sync cannot proceed.`,
        });
      } else if (mapping.default_value === undefined) {
        // Required non-essential field with no default — warn
        nonEssentialWarnings.push({
          field: vectorField,
          message: `Required field "${vectorField}" (→ "${mapping.target_key}") is missing and has no default value.`,
          default_used: null,
        });
      }
    }
  }

  return {
    valid: primaryKeyErrors.length === 0,
    primary_key_errors: primaryKeyErrors,
    non_essential_warnings: nonEssentialWarnings,
  };
}

// Dynamic Transformation Engine

/**
 * Transform a raw Vector visitor payload using the mapping contract.
 *
 * GRACEFUL DEGRADATION:
 * - If a primary key field is missing → the transform fails with errors
 * - If a non-essential field is missing → logs a WARN, uses default, continues
 */
export function transformPayload(
  payload: VectorVisitorPayload,
  contract: MappingContract,
  ctx: LogContext,
): TransformationResult {
  const log = logger.child(ctx);
  const transformed: Record<string, unknown> = {};
  const warnings: TransformationWarning[] = [];
  const errors: TransformationError[] = [];

  log.info('Starting payload transformation', {
    field_count: Object.keys(contract).length,
  });

  for (const [vectorField, mapping] of Object.entries(contract)) {
    const rawValue = getPayloadValue(payload, vectorField);
    const isMissing = rawValue === undefined || rawValue === null || rawValue === '';

    if (isMissing) {
      if (mapping.is_primary_key) {
        // PRIMARY KEY MISSING — hard failure, do not proceed
        const error: TransformationError = {
          field: vectorField,
          message: `Primary key "${vectorField}" is missing. Cannot sync without it.`,
        };
        errors.push(error);
        log.error(`Primary key field missing: ${vectorField}`, {
          target_key: mapping.target_key,
        });
        continue;
      }

      if (mapping.default_value !== undefined) {
        // Non-essential with default — use the default, log a warning
        transformed[mapping.target_key] = coerceValue(
          mapping.default_value,
          mapping.target_type,
          vectorField,
          ctx,
        );
        const warning: TransformationWarning = {
          field: vectorField,
          message: `Non-essential field "${vectorField}" missing, using default value.`,
          default_used: mapping.default_value,
        };
        warnings.push(warning);
        log.warn(`Non-essential field missing, using default`, {
          field: vectorField,
          target_key: mapping.target_key,
          default_value: mapping.default_value,
        });
        continue;
      }

      if (mapping.required) {
        // Required but non-essential with no default — warn and skip
        const warning: TransformationWarning = {
          field: vectorField,
          message: `Required non-essential field "${vectorField}" missing with no default. Skipping.`,
          default_used: null,
        };
        warnings.push(warning);
        log.warn(`Required non-essential field missing, no default available`, {
          field: vectorField,
          target_key: mapping.target_key,
        });
        continue;
      }

      // Optional and missing — just skip silently
      continue;
    }

    // Field is present — coerce and map
    transformed[mapping.target_key] = coerceValue(rawValue, mapping.target_type, vectorField, ctx);
  }

  const success = errors.length === 0;

  if (success) {
    log.info('Payload transformation completed', {
      fields_mapped: Object.keys(transformed).length,
      warnings_count: warnings.length,
    });
  } else {
    log.error('Payload transformation failed due to missing primary keys', {
      error_count: errors.length,
    });
  }

  return {
    success,
    transformed_payload: transformed,
    warnings,
    errors,
  };
}

// Contract CRUD

/**
 * Create or update an integration contract for a customer + platform.
 */
export function createIntegrationContract(
  customerId: string,
  platform: PlatformName,
  mapping: MappingContract,
  schemaHash: string | null = null,
): IntegrationContract {
  const ctx: LogContext = {
    customer_id: customerId,
    contract_id: 'CREATING',
    platform,
  };

  logger.info('Creating integration contract', ctx);

  const contract = db.createContract(customerId, platform, mapping, schemaHash);

  logger.info('Integration contract created', {
    customer_id: customerId,
    contract_id: contract.id,
    platform,
    version: contract.version,
    field_count: Object.keys(mapping).length,
  });

  return contract;
}

/**
 * Get the active contract for a customer + platform.
 */
export function getActiveContract(
  customerId: string,
  platform: PlatformName,
): IntegrationContract | null {
  return db.getActiveContract(customerId, platform);
}

/**
 * Pause a contract (e.g., when drift is detected on primary keys).
 */
export function pauseContract(
  contractId: string,
  reason: string,
  ctx: LogContext,
): void {
  logger.warn(`Pausing contract: ${reason}`, { ...ctx, reason });
  db.updateContractStatus(contractId, ContractStatus.DRIFT_DETECTED);
}

// Helpers

/**
 * Extract a value from the Vector payload by field name.
 * Checks top-level properties first, then custom_fields.
 */
function getPayloadValue(payload: VectorVisitorPayload, field: string): unknown {
  // Check top-level payload fields
  if (field in payload) {
    return (payload as unknown as Record<string, unknown>)[field];
  }

  // Check custom_fields
  if (payload.custom_fields && field in payload.custom_fields) {
    return payload.custom_fields[field];
  }

  return undefined;
}
