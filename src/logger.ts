// Vector Integration Gateway — Structured Logger
// Every log line is a structured JSON object with mandatory customer_id and
// contract_id context. Designed for piping into observability platforms
// (Datadog, Grafana Loki, CloudWatch).
//
// Usage:
//   const ctx: LogContext = { customer_id: 'cust_123', contract_id: 'contract_456' };
//   logger.info('Sync completed', ctx);
//   logger.warn('Non-essential field missing', { ...ctx, field: 'page_url' });

import type { LogContext, LogLevel } from './types.js';

// Log Level Hierarchy

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// Configuration

const CURRENT_LOG_LEVEL: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) ?? 'DEBUG';

// Structured Log Entry

interface StructuredLogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context: LogContext;
}

// Logger Implementation

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[CURRENT_LOG_LEVEL];
}

function formatLogEntry(level: LogLevel, message: string, context: LogContext): string {
  const entry: StructuredLogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    context,
  };
  return JSON.stringify(entry);
}

function log(level: LogLevel, message: string, context: LogContext): void {
  if (!shouldLog(level)) return;

  const formatted = formatLogEntry(level, message, context);

  switch (level) {
    case 'ERROR':
      console.error(formatted);
      break;
    case 'WARN':
      console.warn(formatted);
      break;
    default:
      console.log(formatted);
      break;
  }
}

// Public API

export const logger = {
  debug(message: string, context: LogContext): void {
    log('DEBUG', message, context);
  },

  info(message: string, context: LogContext): void {
    log('INFO', message, context);
  },

  warn(message: string, context: LogContext): void {
    log('WARN', message, context);
  },

  error(message: string, context: LogContext): void {
    log('ERROR', message, context);
  },

  /**
   * Create a child logger with pre-bound context.
   * Useful when a service method needs to log multiple times with the same context.
   *
   * Usage:
   *   const log = logger.child({ customer_id: 'cust_123', contract_id: 'contract_456', platform: PlatformName.HUBSPOT });
   *   log.info('Starting transform');
   *   log.warn('Missing optional field', { field: 'page_url' });
   */
  child(baseContext: LogContext) {
    return {
      debug: (message: string, extra?: Record<string, unknown>) =>
        log('DEBUG', message, { ...baseContext, ...extra }),
      info: (message: string, extra?: Record<string, unknown>) =>
        log('INFO', message, { ...baseContext, ...extra }),
      warn: (message: string, extra?: Record<string, unknown>) =>
        log('WARN', message, { ...baseContext, ...extra }),
      error: (message: string, extra?: Record<string, unknown>) =>
        log('ERROR', message, { ...baseContext, ...extra }),
    };
  },
};

/**
 * Create a system-level log context for operations that aren't tied to a specific customer/contract.
 * Use sparingly — most logs should have real customer/contract IDs.
 */
export function systemContext(additional?: Record<string, unknown>): LogContext {
  return {
    customer_id: 'SYSTEM',
    contract_id: 'SYSTEM',
    ...additional,
  };
}
