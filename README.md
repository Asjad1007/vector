# Vector Integration Gateway

**Contract-Based Integration Gateway** — a production-grade backend system that eliminates integration fragility and schema drift for Vector's B2B contact-level advertising platform.

> *"Build the tooling and processes that make onboarding repeatable — not a fire drill every time."*
> — Vector Engineering

---

## Table of Contents

- [Philosophy](#philosophy)
- [The Problem: Onboarding Fire Drills](#the-problem-onboarding-fire-drills)
- [The Solution: Integrations as Contracts](#the-solution-integrations-as-contracts)
- [Architecture](#architecture)
- [Key Reliability Features](#key-reliability-features)
- [Technical Design Decisions](#technical-design-decisions)
- [Getting Started](#getting-started)
- [Scripts](#scripts)
- [Schema Overview](#schema-overview)

---

## Philosophy

Every integration Vector ships to a CRM or ad platform is a **contract** between two parties:

1. **Vector's internal schema** — the canonical visitor payload (email, company, signal type, page URL)
2. **The customer's target schema** — whatever they've named their fields in HubSpot, Salesforce, or any downstream system

When these two schemas agree, data flows. When they disagree — because a customer renamed a custom field, or a CRM deprecated a property type — the integration breaks. In a traditional hardcoded system, this break is **silent**. The first person to notice is usually the customer, days later, wondering why their ad audiences stopped updating.

This gateway treats that agreement as a **versioned, hashable, enforceable contract**. It detects disagreements proactively, degrades gracefully when the disagreement is minor, and pauses the integration cleanly when it's major. The result: no silent failures, no fire drills, no engineer-hours burned on integration babysitting.

---

## The Problem: Onboarding Fire Drills

Vector's current integration architecture suffers from three compounding issues:

### 1. Hardcoded Mappings
Every customer's field mapping is baked into code or config files. When a customer changes `primary_email` to `contact_email_address` in HubSpot, an engineer has to find the mapping, update it, test it, and deploy it. This doesn't scale.

### 2. Silent Failures
When a mapped field disappears from the CRM, the sync doesn't crash — it just drops the data. The payload lands in the CRM with missing fields, or worse, lands in the wrong fields. Nobody notices until the customer's ad audiences are stale and their pipeline reports are wrong.

### 3. Non-Repeatable Onboarding
Every new customer integration is a snowflake. The onboarding engineer has to manually discover the customer's schema, build a custom mapping, test it end-to-end, and hope it doesn't break when the customer inevitably customizes their CRM. This is the "fire drill" referenced in Vector's engineering principles.

---

## The Solution: Integrations as Contracts

This gateway introduces three concepts that make integrations **repeatable, observable, and resilient**:

### Schema Contracts
Every customer integration is stored as a JSON mapping contract in the database. The contract explicitly maps Vector's internal field names to the customer's target field names, including type coercion rules and required/optional classification.

```json
{
  "visitor_email": {
    "target_key": "primary_contact_addr",
    "target_type": "string",
    "required": true,
    "is_primary_key": true
  },
  "signal_strength": {
    "target_key": "engagement_score",
    "target_type": "number",
    "required": false,
    "is_primary_key": false,
    "default_value": 0
  }
}
```

### Drift Detection
Every contract stores a SHA-256 hash of the remote platform's schema as it was last seen. A drift detector periodically fetches the live schema, hashes it, and compares. If the hashes don't match, it identifies **exactly** which fields are missing, changed in type, or newly added — and flags the contract accordingly.

### Resilient Sync
Every sync attempt is first written to a `sync_logs` table (the **outbox pattern**) before any external API call is made. If the CRM returns a 429 (rate limit) or 500 (server error), the system schedules a retry with exponential backoff: +1 minute, +10 minutes, +1 hour. No data is lost. No sync is silently abandoned.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Vector Core Platform                         │
│                                                                  │
│  Raw Visitor Payload:                                            │
│  { visitor_email, company_domain, signal_type, page_url, ... }  │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Gateway Service (gateway.service.ts)            │
│                                                                  │
│  1. Fetch active contract for customer + platform                │
│  2. Validate payload completeness (primary vs non-essential)     │
│  3. Transform payload using JSONB mapping contract               │
│  4. Apply type coercion + default values                         │
│  5. Graceful degradation: WARN on missing non-essential fields   │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Sync Worker (syncWorker.ts)                    │
│                                                                  │
│  1. Write transformed payload to sync_logs (Outbox Pattern)      │
│  2. Attempt API call to target CRM                               │
│  3. On 429/500: schedule retry with exponential backoff           │
│  4. On success: mark SENT                                        │
│  5. On permanent failure: mark FAILED with error context          │
└──────────────────────────────────────────────────────────────────┘

                    ┌──────────────┐
                    │              │
                    ▼              │ (periodic)
┌──────────────────────────────────────────────────────────────────┐
│                  Drift Detector (driftDetector.ts)                │
│                                                                  │
│  1. Fetch live schema from CRM API (or mock)                     │
│  2. Generate SHA-256 hash of field names + types                 │
│  3. Compare to last_seen_schema_hash in integration_contracts    │
│  4. If mismatch: identify missing, changed, new fields           │
│  5. Create drift_alert record                                    │
│  6. Set contract status → DRIFT_DETECTED                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## Key Reliability Features

These three features are **architectural decisions**, not afterthoughts. They are woven into the system design from the ground up.

### 1. Graceful Degradation

Not all fields are equal. If a customer deletes `page_url` from their CRM but `visitor_email` and `company_domain` are still there, the sync **should not die**. The gateway classifies every mapped field as either a **primary key** (email, company domain — non-negotiable) or **non-essential** (page URL, signal strength — nice to have).

When a non-essential field is missing:
- The transformation engine logs a structured `WARN` with the field name, customer ID, and contract ID
- The sync continues with the available data
- The drift detector flags the discrepancy for human review — but doesn't pause the contract

When a primary key is missing:
- The transformation throws immediately
- The sync is marked `FAILED` with a clear error
- The contract is paused

This distinction prevents minor CRM customizations from cascading into full integration outages. It's the difference between a customer losing one data point and losing *all* their data for days.

### 2. Structured Observability

Every log line emitted by the system is a structured JSON object that includes:

```json
{
  "level": "WARN",
  "message": "Non-essential field missing from payload, using default",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "context": {
    "customer_id": "cust_abc123",
    "contract_id": "contract_def456",
    "platform": "HUBSPOT",
    "field": "signal_strength",
    "default_value": 0
  }
}
```

This is not optional. The `LogContext` type requires `customer_id` and `contract_id` on every call. This enables:
- **Incident response**: Filter all logs for a specific customer's integration in seconds
- **Pattern detection**: Identify which CRM platforms drift most frequently
- **Proactive support**: Surface "what's breaking, what's missing" before the customer notices

### 3. Drift Simulation

The `npm run demo` script is a purpose-built demonstration that:

1. Creates a contract with a known HubSpot schema
2. Runs the drift detector — confirms no drift (hashes match)
3. Triggers the mock service to rename `primary_contact_addr` → `main_email`
4. Runs the drift detector again — catches the drift
5. Outputs structured logs showing exactly which fields drifted and how
6. Demonstrates the contract being paused automatically

This script serves as both a **demo for stakeholders** and a **regression test** for the drift detection pipeline.

---

## Technical Design Decisions

> See [CONSIDERATIONS.md](./CONSIDERATIONS.md) for the full technical leadership document.

### Why JSONB Mapping Contracts?

A flat `field_mappings` table (one row per field) would normalize the data but introduce:
- **N joins per transformation** — expensive at high throughput
- **Complex versioning** — snapshotting a contract requires copying N rows
- **Atomic update difficulty** — updating a mapping is a multi-row transaction

JSON stores the entire contract as a single document. Versioning is copy-on-write. Reads are a single query. In production with PostgreSQL, GIN indexes provide query capability when needed. For this prototype, SQLite's built-in JSON functions handle the same access patterns.

### Why SHA-256 for Drift Detection?

Comparing two schemas field-by-field on every check is O(n). Hashing the sorted, normalized field set to a fixed-length string makes comparison O(1). The hash is regenerated only when we need to identify *which* fields drifted.

### Why the Outbox Pattern?

Direct API calls from the transformation engine create a failure mode where the payload is transformed and sent, but the CRM rejects it, and we have no record of what was sent. The outbox pattern ensures every sync attempt is durably recorded *before* the external call, enabling:
- Retry without re-transformation
- Audit trail of every sync attempt
- Dead letter queue for permanently failed syncs

---

## Getting Started

### Prerequisites

- Node.js 20+
- That's it. No Docker, no PostgreSQL, no external services.

The prototype uses **SQLite** via `better-sqlite3` for zero-infrastructure local development. The database is a single `vector.db` file created automatically in the project root.

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Run the full demo (auto-creates the database)
npm run demo
```

The database schema is applied automatically on first run. No manual setup required.

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run demo` | Full lifecycle: create contract → transform payload → sync → detect drift |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:init` | Initialize SQLite database and schema |

---

## Schema Overview

### `integration_contracts`
The source of truth for every customer integration. Each row is a contract between Vector and a customer's CRM instance.

### `sync_logs`
The outbox table. Every sync attempt is recorded here before any external API call is made. Supports retry scheduling with exponential backoff.

### `drift_alerts`
A log of every detected schema drift event. Includes the specific fields that are missing, changed in type, or newly added. Used for observability and pattern detection.

---

## Project Structure

```
src/
├── index.ts              # Demo runner — full lifecycle
├── db-init.ts            # Database initializer script
├── schema.sql            # SQLite DDL
├── types.ts              # All TypeScript interfaces & enums
├── db.ts                 # SQLite connection & query helpers
├── logger.ts             # Structured logging with mandatory context
├── gateway.service.ts    # Transformation engine + contract CRUD
├── driftDetector.ts      # Schema drift detection engine
├── syncWorker.ts         # Resilient sync with outbox pattern
└── mockService.ts        # Simulated CRM APIs with configurable drift
```

---

*Built for Vector (W23) — making onboarding repeatable, not a fire drill.*
