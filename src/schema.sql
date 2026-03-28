-- ============================================================================
-- Vector Integration Gateway — SQLite Schema
-- ============================================================================
-- This schema defines the data layer for Vector's Contract-Based Integration
-- Gateway. It stores mapping contracts, sync logs (outbox pattern), and drift
-- detection alerts.
--
-- SQLite dialect: TEXT for JSON, TEXT for UUIDs, DATETIME for timestamps.
-- Enums enforced via CHECK constraints.
--
-- Run: npm run db:init
-- ============================================================================

-- --------------------------------------------------------
-- TABLE: integration_contracts
-- --------------------------------------------------------
-- The source of truth for every customer integration.
-- Each row is a versioned contract mapping Vector's internal
-- field names to the customer's target CRM field names.
--
-- The mapping_contract TEXT column stores JSON. SQLite has
-- built-in JSON functions (json_extract, etc.) for querying.
-- --------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_contracts (
  id                    TEXT PRIMARY KEY,
  customer_id           TEXT NOT NULL,
  platform_name         TEXT NOT NULL CHECK (platform_name IN ('HUBSPOT', 'SALESFORCE', 'LINKEDIN', 'META', 'GOOGLE_ADS', 'REDDIT')),

  -- The core contract: maps Vector keys → CRM target keys
  -- Structure: { "vector_field": { "target_key": "crm_field", "target_type": "string", "required": true, "is_primary_key": true, "default_value": null } }
  mapping_contract      TEXT NOT NULL DEFAULT '{}',

  -- SHA-256 hash of the remote platform's field names + types
  -- Used for O(1) drift detection
  last_seen_schema_hash TEXT,

  -- Contract lifecycle
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'DRIFT_DETECTED')),
  version               INTEGER NOT NULL DEFAULT 1,

  -- Timestamps (ISO-8601 strings)
  created_at            DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at            DATETIME NOT NULL DEFAULT (datetime('now')),

  -- A customer can only have one active contract per platform
  UNIQUE (customer_id, platform_name)
);

-- Index for fast lookups by customer
CREATE INDEX IF NOT EXISTS idx_contracts_customer_id
  ON integration_contracts (customer_id);

-- Index for scanning active contracts during drift detection
CREATE INDEX IF NOT EXISTS idx_contracts_status
  ON integration_contracts (status);


-- --------------------------------------------------------
-- TABLE: sync_logs
-- --------------------------------------------------------
-- The outbox table. Every sync attempt is durably recorded
-- here BEFORE any external API call is made. This ensures:
--   1. Retry without re-transformation
--   2. Full audit trail of every sync attempt
--   3. Dead letter queue for permanently failed syncs
--
-- The exponential backoff schedule: +1m, +10m, +1h
-- --------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_logs (
  id                    TEXT PRIMARY KEY,
  contract_id           TEXT NOT NULL REFERENCES integration_contracts(id) ON DELETE CASCADE,

  -- The transformed payload, ready to send to the CRM (stored as JSON text)
  payload               TEXT NOT NULL,

  -- The raw Vector payload before transformation (for debugging)
  raw_payload           TEXT,

  -- Sync lifecycle
  status                TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'RETRYING')),
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 4,

  -- Retry scheduling
  next_retry_at         DATETIME,

  -- Error context
  error_message         TEXT,
  last_error_code       INTEGER,

  -- Timestamps
  created_at            DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at            DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Index for the sync worker to pick up pending/retryable jobs
CREATE INDEX IF NOT EXISTS idx_sync_logs_pending
  ON sync_logs (status, next_retry_at);

-- Index for auditing syncs by contract
CREATE INDEX IF NOT EXISTS idx_sync_logs_contract_id
  ON sync_logs (contract_id);


-- --------------------------------------------------------
-- TABLE: drift_alerts
-- --------------------------------------------------------
-- A log of every detected schema drift event. Each row
-- captures exactly WHAT drifted (missing fields, type
-- changes, new fields) so engineering can triage without
-- re-running the detector.
-- --------------------------------------------------------

CREATE TABLE IF NOT EXISTS drift_alerts (
  id                    TEXT PRIMARY KEY,
  contract_id           TEXT NOT NULL REFERENCES integration_contracts(id) ON DELETE CASCADE,

  -- Hash comparison
  previous_hash         TEXT NOT NULL,
  current_hash          TEXT NOT NULL,

  -- What specifically drifted (stored as JSON arrays)
  missing_fields        TEXT NOT NULL DEFAULT '[]',
  type_changes          TEXT NOT NULL DEFAULT '[]',
  new_fields            TEXT NOT NULL DEFAULT '[]',

  -- Resolution tracking
  resolved              INTEGER NOT NULL DEFAULT 0,
  resolved_at           DATETIME,
  resolved_by           TEXT,

  -- Timestamps
  created_at            DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Index for unresolved alerts
CREATE INDEX IF NOT EXISTS idx_drift_alerts_unresolved
  ON drift_alerts (contract_id, resolved);
