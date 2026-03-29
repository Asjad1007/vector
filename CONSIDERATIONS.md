# Technical Considerations

A companion document to the README explaining the **why** behind key architectural decisions in the Vector Integration Gateway.

> *"We want people who are genuinely curious about the problem, have opinions about the solution, and take pride in shipping something that actually works for customers."*
> — Vector Engineering

---

## 1. Why JSON Mapping Contracts (Not a Flat Table)

> **Architectural Note on the Prototype:** 
> For this "Proof of Work," the system runs entirely on **SQLite** for a zero-friction, zero-infrastructure demonstration. Everything works locally out of the box. 
> However, the architecture is fundamentally designed to be backed by **PostgreSQL JSONB** in production. The reasoning below applies to both, but relies on PostgreSQL for true production scale at Vector.

### The Alternative: Flat `field_mappings` Table

```sql
CREATE TABLE field_mappings (
  id          UUID PRIMARY KEY,
  contract_id UUID REFERENCES integration_contracts(id),
  source_key  VARCHAR(255),  -- e.g., 'visitor_email'
  target_key  VARCHAR(255),  -- e.g., 'primary_contact_addr'
  target_type VARCHAR(50),
  required    BOOLEAN
);
```

This normalizes the data. Every textbook says this is "correct." But for this specific use case, it creates three problems:

### Problem 1: N Joins Per Transformation

Every time we transform a payload, we need to fetch the full mapping. With a flat table, that's a JOIN across N rows (one per field). At Vector's throughput — syncing thousands of visitor signals per hour across dozens of customers — this means thousands of multi-row JOINs per minute. 

With JSON (or JSONB in Postgres), it's one row. One query. The entire contract is loaded into memory in a single read.

### Problem 2: Complex Versioning

When a customer's schema drifts and we need to snapshot the "before" state, a flat table requires copying N rows atomically. With a single JSON document, we copy one row. `INSERT INTO integration_contracts (mapping_contract, version) SELECT mapping_contract, version + 1 FROM ...`. Copy-on-write, simple and atomic.

### Problem 3: Atomic Updates

Updating a mapping contract — say, remapping three fields at once — is a multi-row transaction in a flat table. With a JSON document, it's a single `UPDATE ... SET mapping_contract = $1`. The entire contract is always in a consistent state.

### When Flat Tables Win

If we needed to query across all customers to find "who maps `visitor_email` to what?" — a flat table would be better. But we don't have that query pattern today. If we do in the future, PostgreSQL's GIN indexes on JSONB handle it perfectly. For the SQLite prototype, the built-in `json_extract()` functions are more than sufficient.

**Decision**: A single JSON document wins for this access pattern. We use SQLite `TEXT` for the prototype and PostgreSQL `JSONB` for production.

---

## 2. Why SHA-256 Hashing for Drift Detection

### The Alternative: Full Schema Comparison

We could store the entire remote schema and diff it field-by-field on every check. This is O(n) per check, where n is the number of fields in the remote schema. For HubSpot, n can be 200+ custom properties.

### The Hash Approach

1. Sort the remote schema fields deterministically (alphabetical by field name)
2. Serialize to a canonical JSON string (sorted keys, no whitespace)
3. SHA-256 hash the string → 64-character hex digest
4. Compare two 64-character strings → O(1)

If the hashes match, we're done. Zero work. If they don't match, *then* we do the full O(n) diff to identify exactly what changed. This is the common case optimization: most checks will show no drift.

### Why Not MD5?

SHA-256 is no slower than MD5 for strings this small (a few KB of serialized schema). It avoids the theoretical collision risk. There's no reason to use a weaker hash.

### Why Not a Version Number from the CRM?

Some CRMs expose a schema version. But:
- Not all do (HubSpot doesn't, as of this writing)
- We'd be trusting the CRM to accurately version its schema changes
- Our hash is platform-agnostic — same algorithm works for HubSpot, Salesforce, LinkedIn, etc.

**Decision**: Hash-based detection is platform-agnostic, O(1) in the common case, and doesn't depend on CRM versioning capabilities.

---

## 3. Why the Outbox Pattern (Not Direct API Calls)

### The Alternative: Transform → API Call → Done

```typescript
const transformed = transform(payload, contract);
await hubspotApi.send(transformed);  // If this fails, we have nothing
```

If the API call fails *after* we've consumed the event from our queue, the payload is lost. We'd have to re-derive it from the source, which may no longer be available.

### The Outbox Pattern

```typescript
const transformed = transform(payload, contract);
const syncLog = await db.insert('sync_logs', { payload: transformed, status: 'PENDING' });
// Now it's durable. Even if we crash right here, the sync_logs row exists.
const response = await hubspotApi.send(transformed);
await db.update('sync_logs', syncLog.id, { status: 'SENT' });
```

Benefits:
- **Durability**: The transformed payload survives process crashes
- **Retry without re-transformation**: The payload is already in `sync_logs`
- **Audit trail**: Every sync attempt is recorded, successful or not
- **Dead letter queue**: Failed syncs with 4+ attempts are permanently visible in the DB for manual triage

### The Exponential Backoff Schedule

| Attempt | Delay  | Rationale |
|---------|--------|-----------|
| 1       | 0      | Immediate first attempt |
| 2       | +1 min | CRM rate limit might clear quickly |
| 3       | +10 min | If still failing, give the CRM time to recover |
| 4       | +1 hour | Last attempt before marking as permanently failed |

This schedule is deliberately aggressive on the first retry (1 minute) and conservative on the last (1 hour). Most 429s resolve in under a minute. Most 500s that last longer than 10 minutes are genuine outages that won't resolve in the next hour either — but we give it one last shot.

**Decision**: Outbox pattern eliminates data loss. Exponential backoff respects CRM rate limits without giving up too quickly.

---

## 4. Why Graceful Degradation (Not All-or-Nothing)

### The Alternative: Fail the Entire Sync

If any mapped field is missing from the payload, reject the entire sync. Simple. Correct. And **catastrophically wrong** for Vector's use case.

### The Reality

Vector syncs **visitor signals** to CRMs. A signal like "Jane from Acme visited your pricing page" is valuable even if we don't have the exact page URL. The email and company domain — the primary keys — are what make the signal actionable. Everything else is enrichment data.

Killing a sync because `signal_strength` is missing means the customer's ad audiences don't update, their pipeline dries up, and they churn. All because of a metadata field they might not even use.

### The Classification

Every field in the mapping contract is classified:

| Classification | Examples | On Missing |
|---------------|----------|------------|
| **Primary Key** | `visitor_email`, `company_domain` | Throw, fail sync, call is not feasible |
| **Non-Essential** | `page_url`, `signal_strength`, `utm_source` | Log WARN, use default value, continue |

The `is_primary_key` flag in the mapping contract controls this behavior. Customers can configure which fields are essential to their workflow.

**Decision**: Graceful degradation keeps data flowing. Primary keys are non-negotiable. Everything else is best-effort.

---

## 5. Future Considerations

These are not in the current prototype but are natural extensions:

### Contract Negotiation API
An HTTP API where customers can propose mapping changes, preview the impact on their existing data, and apply the change atomically. This turns contract updates from an engineering task into a self-service operation.

### Change Data Capture (CDC)
Instead of polling for schema drift, subscribe to CRM webhook events that notify us of schema changes in real-time. HubSpot's `contact.propertyChange` webhook, Salesforce's Platform Events.

### Event Sourcing
Store every version of every contract as an immutable event. This enables time-travel debugging ("what was the mapping at 3pm on Tuesday when the sync broke?") and eliminates the need for copy-on-write versioning.

### Multi-Tenant Contract Templates
Pre-built contract templates for common CRM configurations. "Standard HubSpot B2B" gives you email, company, lifecycle stage mapped out of the box. Reduces onboarding from "build a custom mapping" to "pick a template and customize."

---

*"Own the API product roadmap, its reliability, and its trajectory."*
*— Vector Engineering*
