// ============================================================================
// Vector Integration Gateway — Resilient Sync Worker
// ============================================================================
// Implements the Outbox Pattern for reliable data synchronization to CRMs.
//
// Flow:
//   1. Save sync attempt to sync_logs (PENDING) — durable before any API call
//   2. Transform payload using the mapping contract
//   3. Call the target CRM API
//   4. On success: mark SENT
//   5. On 429/500: schedule retry with exponential backoff
//   6. On 4xx (non-429): mark FAILED permanently
//
// Exponential Backoff Schedule:
//   Attempt 1: immediate
//   Attempt 2: +1 minute   (60,000 ms)
//   Attempt 3: +10 minutes (600,000 ms)
//   Attempt 4: +1 hour     (3,600,000 ms)
// ============================================================================

import { logger } from './logger.js';
import * as db from './db.js';
import { transformPayload } from './gateway.service.js';
import { getAPISender } from './mockService.js';
import type {
  VectorVisitorPayload,
  IntegrationContract,
  MappingContract,
  SyncLogEntry,
  LogContext,
} from './types.js';
import { SyncStatus } from './types.js';

// --------------------------------------------------------
// Retry Configuration
// --------------------------------------------------------

/** Exponential backoff delays in milliseconds: 1m, 10m, 1h */
const RETRY_DELAYS_MS = [60_000, 600_000, 3_600_000] as const;

/** Maximum number of attempts (1 initial + 3 retries) */
const MAX_ATTEMPTS = 4;

// --------------------------------------------------------
// Enqueue Sync Job (Outbox Pattern)
// --------------------------------------------------------

/**
 * Enqueue a sync job by writing the payload to the sync_logs table FIRST.
 * This is the Outbox Pattern — the payload is durably stored before any
 * external API call is made.
 *
 * @returns The created sync log entry
 */
export function enqueueSyncJob(
  contract: IntegrationContract,
  payload: VectorVisitorPayload,
): SyncLogEntry {
  const ctx: LogContext = {
    customer_id: contract.customer_id,
    contract_id: contract.id,
    platform: contract.platform_name,
  };
  const log = logger.child(ctx);

  // 1. Transform the payload using the contract's mapping
  const result = transformPayload(payload, contract.mapping_contract as MappingContract, ctx);

  if (!result.success) {
    log.error('Payload transformation failed — cannot enqueue sync job', {
      errors: result.errors.map(e => e.message),
    });
    throw new Error(
      `Transformation failed: ${result.errors.map(e => e.message).join('; ')}`,
    );
  }

  // Log any warnings from graceful degradation
  if (result.warnings.length > 0) {
    log.warn(`Transformation completed with ${result.warnings.length} warnings (graceful degradation)`, {
      warnings: result.warnings.map(w => w.message),
    });
  }

  // 2. Write to sync_logs FIRST (Outbox Pattern)
  const syncLog = db.createSyncLog(contract.id, result.transformed_payload, payload);

  log.info('Sync job enqueued (outbox)', {
    sync_log_id: syncLog.id,
    fields_mapped: Object.keys(result.transformed_payload).length,
  });

  return syncLog;
}

// --------------------------------------------------------
// Process Pending Jobs
// --------------------------------------------------------

/**
 * Process all pending and retryable sync jobs.
 * This is designed to be called on a schedule (e.g., every 30 seconds).
 */
export function processPendingJobs(): {
  processed: number;
  succeeded: number;
  failed: number;
  retrying: number;
} {
  const stats = { processed: 0, succeeded: 0, failed: 0, retrying: 0 };

  const pendingJobs = db.getPendingAndRetryableSyncLogs();

  if (pendingJobs.length === 0) {
    logger.debug('No pending sync jobs to process', {
      customer_id: 'SYSTEM',
      contract_id: 'SYSTEM',
    });
    return stats;
  }

  logger.info(`Processing ${pendingJobs.length} sync jobs`, {
    customer_id: 'SYSTEM',
    contract_id: 'SYSTEM',
    job_count: pendingJobs.length,
  });

  for (const job of pendingJobs) {
    try {
      processJob(job);
      stats.processed++;
    } catch (error) {
      logger.error(`Job processing failed unexpectedly`, {
        customer_id: 'UNKNOWN',
        contract_id: job.contract_id,
        sync_log_id: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      stats.processed++;
      stats.failed++;
    }
  }

  return stats;
}

// --------------------------------------------------------
// Individual Job Processing
// --------------------------------------------------------

function processJob(job: SyncLogEntry): void {
  // Fetch the contract to get platform info
  const contract = db.getContractById(job.contract_id);
  if (!contract) {
    logger.error('Contract not found for sync job', {
      customer_id: 'UNKNOWN',
      contract_id: job.contract_id,
      sync_log_id: job.id,
    });
    db.updateSyncLogStatus(job.id, SyncStatus.FAILED, {
      error_message: 'Contract not found',
      attempt_count: job.attempt_count + 1,
    });
    return;
  }

  const ctx: LogContext = {
    customer_id: contract.customer_id,
    contract_id: contract.id,
    platform: contract.platform_name,
    sync_log_id: job.id,
  };
  const log = logger.child(ctx);

  const currentAttempt = job.attempt_count + 1;
  log.info(`Attempting sync (attempt ${currentAttempt}/${MAX_ATTEMPTS})`, {
    attempt: currentAttempt,
    max_attempts: MAX_ATTEMPTS,
  });

  // Call the CRM API
  const sendToAPI = getAPISender(contract.platform_name);
  const response = sendToAPI(job.payload as Record<string, unknown>);

  if (response.success) {
    // ✅ SUCCESS
    db.updateSyncLogStatus(job.id, SyncStatus.SENT, {
      attempt_count: currentAttempt,
      next_retry_at: null,
      error_message: null,
    });
    log.info('Sync completed successfully', {
      status_code: response.status,
      request_id: response.request_id,
      attempt: currentAttempt,
    });
    return;
  }

  // ❌ FAILURE — determine if retryable
  const isRetryable = response.status === 429 || response.status === 500;

  if (isRetryable && currentAttempt < MAX_ATTEMPTS) {
    // Schedule retry with exponential backoff
    const delayMs = RETRY_DELAYS_MS[currentAttempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
    const nextRetry = new Date(Date.now() + delayMs);

    db.updateSyncLogStatus(job.id, SyncStatus.RETRYING, {
      attempt_count: currentAttempt,
      next_retry_at: nextRetry,
      error_message: response.message,
      last_error_code: response.status,
    });

    log.warn(`Sync failed with ${response.status}, scheduling retry`, {
      status_code: response.status,
      attempt: currentAttempt,
      next_retry_at: nextRetry.toISOString(),
      delay_ms: delayMs,
      delay_human: humanizeDelay(delayMs),
      request_id: response.request_id,
    });
    return;
  }

  // Permanent failure — either non-retryable status code or max attempts reached
  db.updateSyncLogStatus(job.id, SyncStatus.FAILED, {
    attempt_count: currentAttempt,
    next_retry_at: null,
    error_message: response.message,
    last_error_code: response.status,
  });

  if (currentAttempt >= MAX_ATTEMPTS) {
    log.error(`Sync permanently failed after ${MAX_ATTEMPTS} attempts`, {
      status_code: response.status,
      request_id: response.request_id,
      total_attempts: currentAttempt,
    });
  } else {
    log.error(`Sync permanently failed with non-retryable status ${response.status}`, {
      status_code: response.status,
      request_id: response.request_id,
      attempt: currentAttempt,
    });
  }
}

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

function humanizeDelay(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
