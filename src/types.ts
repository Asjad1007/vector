// ============================================================================
// Vector Integration Gateway — Type Definitions
// ============================================================================
// Strongly typed interfaces for the entire gateway system.
// All types are designed for TypeScript strict mode with noUncheckedIndexedAccess.
// ============================================================================

// --------------------------------------------------------
// ENUMS
// --------------------------------------------------------

export enum PlatformName {
  HUBSPOT = 'HUBSPOT',
  SALESFORCE = 'SALESFORCE',
  LINKEDIN = 'LINKEDIN',
  META = 'META',
  GOOGLE_ADS = 'GOOGLE_ADS',
  REDDIT = 'REDDIT',
}

export enum ContractStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  DRIFT_DETECTED = 'DRIFT_DETECTED',
}

export enum SyncStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING',
}

// --------------------------------------------------------
// Signal Types — Vector's internal vocabulary
// --------------------------------------------------------

export enum SignalType {
  PAGE_VIEW = 'PAGE_VIEW',
  FORM_SUBMISSION = 'FORM_SUBMISSION',
  CONTENT_ENGAGEMENT = 'CONTENT_ENGAGEMENT',
  COMPETITOR_RESEARCH = 'COMPETITOR_RESEARCH',
  PRICING_PAGE_VISIT = 'PRICING_PAGE_VISIT',
}

// --------------------------------------------------------
// Vector Visitor Payload — the canonical internal format
// --------------------------------------------------------

export interface VectorVisitorPayload {
  /** The identified visitor's email — PRIMARY KEY, non-negotiable */
  visitor_email: string;

  /** Visitor's full name (if resolved) */
  visitor_name?: string;

  /** The company domain the visitor is associated with — PRIMARY KEY */
  company_domain: string;

  /** Company name (if resolved) */
  company_name?: string;

  /** The type of buying signal detected */
  signal_type: SignalType;

  /** Signal strength score (0-100) */
  signal_strength?: number;

  /** The page URL that generated the signal */
  page_url?: string;

  /** ISO-8601 timestamp of the signal */
  timestamp: string;

  /** Any additional custom fields from the customer's tracking setup */
  custom_fields?: Record<string, unknown>;
}

// --------------------------------------------------------
// Mapping Contract — the JSONB structure
// --------------------------------------------------------

export interface FieldMapping {
  /** The target field name in the CRM */
  target_key: string;

  /** The expected type in the CRM */
  target_type: 'string' | 'number' | 'boolean' | 'date' | 'json';

  /** Whether this field is required for a valid sync */
  required: boolean;

  /** Whether this is a primary key (email, company_domain) — controls graceful degradation */
  is_primary_key: boolean;

  /** Default value to use if the source field is missing (only for non-primary-key fields) */
  default_value?: unknown;
}

/** The full mapping contract — maps Vector internal field names to CRM target fields */
export type MappingContract = Record<string, FieldMapping>;

// --------------------------------------------------------
// Database Row Types
// --------------------------------------------------------

export interface IntegrationContract {
  id: string;
  customer_id: string;
  platform_name: PlatformName;
  mapping_contract: MappingContract;
  last_seen_schema_hash: string | null;
  status: ContractStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface SyncLogEntry {
  id: string;
  contract_id: string;
  payload: Record<string, unknown>;
  raw_payload: VectorVisitorPayload | null;
  status: SyncStatus;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: Date | null;
  error_message: string | null;
  last_error_code: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface DriftAlertRecord {
  id: string;
  contract_id: string;
  previous_hash: string;
  current_hash: string;
  missing_fields: string[];
  type_changes: TypeChange[];
  new_fields: string[];
  resolved: boolean;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Date;
}

// --------------------------------------------------------
// Drift Detection Types
// --------------------------------------------------------

export interface RemoteSchemaField {
  /** The field name as it exists in the CRM */
  name: string;

  /** The field type as reported by the CRM */
  type: string;

  /** Whether the CRM considers this field required */
  required: boolean;

  /** Human-readable label (e.g., "Primary Email Address") */
  label?: string;
}

export interface TypeChange {
  field: string;
  expected_type: string;
  actual_type: string;
}

export interface DriftReport {
  contract_id: string;
  customer_id: string;
  platform: PlatformName;
  has_drift: boolean;
  previous_hash: string | null;
  current_hash: string;
  missing_fields: string[];
  type_changes: TypeChange[];
  new_fields: string[];
  timestamp: string;
}

// --------------------------------------------------------
// Transformation Types
// --------------------------------------------------------

export interface TransformationResult {
  /** Whether the transformation succeeded */
  success: boolean;

  /** The transformed payload ready for the CRM */
  transformed_payload: Record<string, unknown>;

  /** Warnings generated during transformation (non-essential field issues) */
  warnings: TransformationWarning[];

  /** Errors that prevented transformation (primary key issues) */
  errors: TransformationError[];
}

export interface TransformationWarning {
  field: string;
  message: string;
  default_used: unknown;
}

export interface TransformationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  primary_key_errors: TransformationError[];
  non_essential_warnings: TransformationWarning[];
}

// --------------------------------------------------------
// Mock Service Types
// --------------------------------------------------------

export interface MockAPIResponse {
  status: number;
  success: boolean;
  message: string;
  request_id: string;
}

// --------------------------------------------------------
// Logger Types
// --------------------------------------------------------

export interface LogContext {
  /** REQUIRED: The customer this log pertains to */
  customer_id: string;

  /** REQUIRED: The contract this log pertains to */
  contract_id: string;

  /** Optional: The platform involved */
  platform?: PlatformName;

  /** Optional: Additional structured context */
  [key: string]: unknown;
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
