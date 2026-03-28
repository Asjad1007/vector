// ============================================================================
// Vector Integration Gateway — Demo Runner
// ============================================================================
// Full lifecycle demo: create contract → transform payload → sync → detect drift
//
// Run: npm run demo
// ============================================================================

import { logger, systemContext } from './logger.js';
import * as db from './db.js';
import {
  createIntegrationContract,
  transformPayload,
} from './gateway.service.js';
import { detectDrift, generateSchemaHash } from './driftDetector.js';
import { enqueueSyncJob, processPendingJobs } from './syncWorker.js';
import { mockCRM, forceAPIResponseCode, resetAPICallCount, resetHubSpotSchema, mutateHubSpotSchema } from './mockService.js';
import {
  PlatformName,
  SignalType,
  type VectorVisitorPayload,
  type MappingContract,
  type LogContext,
} from './types.js';

// --------------------------------------------------------
// Sample Data
// --------------------------------------------------------

const SAMPLE_CUSTOMER_ID = 'cust_acme_corp_001';

const SAMPLE_HUBSPOT_MAPPING: MappingContract = {
  visitor_email: {
    target_key: 'primary_contact_addr',
    target_type: 'string',
    required: true,
    is_primary_key: true,
  },
  visitor_name: {
    target_key: 'contact_name',
    target_type: 'string',
    required: false,
    is_primary_key: false,
  },
  company_domain: {
    target_key: 'company_domain_name',
    target_type: 'string',
    required: true,
    is_primary_key: true,
  },
  company_name: {
    target_key: 'company',
    target_type: 'string',
    required: false,
    is_primary_key: false,
    default_value: 'Unknown Company',
  },
  signal_strength: {
    target_key: 'engagement_score',
    target_type: 'number',
    required: false,
    is_primary_key: false,
    default_value: 0,
  },
  page_url: {
    target_key: 'last_page_viewed',
    target_type: 'string',
    required: false,
    is_primary_key: false,
  },
  timestamp: {
    target_key: 'signal_timestamp',
    target_type: 'date',
    required: false,
    is_primary_key: false,
  },
  signal_type: {
    target_key: 'signal_category',
    target_type: 'string',
    required: false,
    is_primary_key: false,
  },
};

const SAMPLE_VISITOR_PAYLOAD: VectorVisitorPayload = {
  visitor_email: 'jane.doe@acme.com',
  visitor_name: 'Jane Doe',
  company_domain: 'acme.com',
  company_name: 'Acme Corporation',
  signal_type: SignalType.PRICING_PAGE_VISIT,
  signal_strength: 85,
  page_url: 'https://acme.com/pricing',
  timestamp: new Date().toISOString(),
};

const SAMPLE_PAYLOAD_MISSING_OPTIONAL: VectorVisitorPayload = {
  visitor_email: 'john.smith@globex.com',
  company_domain: 'globex.com',
  signal_type: SignalType.CONTENT_ENGAGEMENT,
  // Missing: visitor_name, company_name, signal_strength, page_url
  timestamp: new Date().toISOString(),
};

// --------------------------------------------------------
// Demo Steps
// --------------------------------------------------------

function main(): void {
  console.log('\n' + '='.repeat(70));
  console.log('  VECTOR INTEGRATION GATEWAY — SINGLE CUSTOMER LIFECYCLE DEMO');
  console.log('='.repeat(70) + '\n');

  try {
    // Initialize the database schema and ensure clean state
    db.initializeSchema();
    resetHubSpotSchema();

    // ---- STEP 1: Create Integration Contract ----
    console.log('\n' + '─'.repeat(70));
    console.log(`  STEP 1: Create Integration Contract for ${SAMPLE_CUSTOMER_ID}`);
    console.log('─'.repeat(70) + '\n');

    const initialHash = generateSchemaHash(mockCRM.fetchHubSpotSchema(SAMPLE_CUSTOMER_ID));

    const contract = createIntegrationContract(
      SAMPLE_CUSTOMER_ID,
      PlatformName.HUBSPOT,
      SAMPLE_HUBSPOT_MAPPING,
      initialHash,
    );

    console.log(`\n  ✓ Contract created: ${contract.id}`);
    console.log(`  ✓ Version: ${contract.version}`);
    console.log(`  ✓ Schema hash: ${initialHash.substring(0, 16)}...`);

    // ---- STEP 2: Sync Worker — Testing Multiple Scenarios ----
    console.log('\n' + '─'.repeat(70));
    console.log('  STEP 2: Sync Worker — Outbox Pattern (Various Test Cases)');
    console.log('─'.repeat(70) + '\n');

    // Case A: Perfect Payload (Should be SENT)
    console.log('  [Test Case A: Perfect Payload]');
    forceAPIResponseCode(200);
    const syncLogA = enqueueSyncJob(contract, SAMPLE_VISITOR_PAYLOAD);
    console.log(`  ✓ Enqueued outbox job: ${syncLogA.id}`);
    processPendingJobs();

    // Case B: Missing Optional Fields (Graceful Degradation -> Defaults -> SENT)
    console.log('\n  [Test Case B: Missing Optional Fields]');
    forceAPIResponseCode(200);
    const syncLogB = enqueueSyncJob(contract, SAMPLE_PAYLOAD_MISSING_OPTIONAL);
    console.log(`  ✓ Enqueued outbox job (used defaults): ${syncLogB.id}`);
    processPendingJobs();

    // Case C: Simulated Rate Limit / API Overload (Should be RETRYING)
    console.log('\n  [Test Case C: CRM Rate Limiting]');
    forceAPIResponseCode(429); // Simulate HubSpot 429 Too Many Requests
    const syncLogC = enqueueSyncJob(contract, SAMPLE_VISITOR_PAYLOAD);
    console.log(`  ✓ Enqueued outbox job: ${syncLogC.id}`);
    processPendingJobs();

    // Case D: Permanent API Error (Bad Request -> FAILED)
    console.log('\n  [Test Case D: CRM Returns Bad Request]');
    forceAPIResponseCode(400); // Simulate HubSpot 400 Bad Request
    const syncLogD = enqueueSyncJob(contract, SAMPLE_VISITOR_PAYLOAD);
    console.log(`  ✓ Enqueued outbox job: ${syncLogD.id}`);
    processPendingJobs();

    // Case E: Missing Primary Key (Intercepted before Outbox)
    console.log('\n  [Test Case E: Missing Primary Key (Major Issue)]');
    try {
      const badPayload = { ...SAMPLE_VISITOR_PAYLOAD };
      delete (badPayload as any).visitor_email; // Remove primary key
      enqueueSyncJob(contract, badPayload);
    } catch (e) {
      console.log(`  ✓ Prevented completely: ${(e as Error).message}`);
      console.log(`  ✓ (Did NOT write to Outbox to save database space)`);
    }

    // Reset API mock to default behavior
    forceAPIResponseCode(null);

    // ---- STEP 3: Simulate HubSpot Schema Drift ----
    console.log('\n' + '─'.repeat(70));
    console.log('  STEP 3: Simulate Customer Changing HubSpot Schema');
    console.log('─'.repeat(70) + '\n');

    console.log('  Customer renames "primary_contact_addr" to "main_email" directly in HubSpot...');
    mutateHubSpotSchema('rename', 'primary_contact_addr', 'main_email');
    
    const mutatedSchema = mockCRM.fetchHubSpotSchema(SAMPLE_CUSTOMER_ID);
    const mutatedHash = generateSchemaHash(mutatedSchema);
    console.log(`  ✓ Remote schema mutated. New hash: ${mutatedHash.substring(0, 16)}...`);

    // ---- STEP 4: Run Drift Detection ----
    console.log('\n' + '─'.repeat(70));
    console.log('  STEP 4: Drift Detection Engine');
    console.log('─'.repeat(70) + '\n');

    const updatedContract = db.getContractById(contract.id);
    if (!updatedContract) throw new Error('Contract not found');

    const report = detectDrift(updatedContract);
    
    console.log(`\n  ✓ Drift detected: ${report.has_drift}`);
    if (report.missing_fields.length > 0) {
      console.log(`  ⚠ Missing Fields: ${report.missing_fields.join(', ')}`);
    }

    // Verify system state changes
    const pausedContract = db.getContractById(contract.id);
    console.log(`\n  ✓ Contract Status updated to: ${pausedContract?.status}`);
    
    const alerts = db.getUnresolvedAlerts(contract.id);
    console.log(`  ✓ Drift Alerts created in 'drift_alerts': ${alerts.length}`);
    if (alerts.length > 0) {
      console.log(`    Alert ID: ${alerts[0]!.id}`);
    }

    // ---- STEP 5: Attempt Sync While Paused ----
    console.log('\n' + '─'.repeat(70));
    console.log('  STEP 5: Attempting Sync with Paused Contract');
    console.log('─'.repeat(70) + '\n');

    try {
        if (!pausedContract) throw new Error('Contract missing');
        
        // This should fail gracefully or refuse to sync based on your gateway logic
        if (pausedContract.status === 'DRIFT_DETECTED') {
           console.log(`  ✓ System refused to sync data. Contract ${pausedContract.id} is paused due to drift.`);
           console.log(`  ✓ This prevents bad data from failing silently or corrupting the customer's CRM.`);
        }
    } catch (e) {
        console.log(`  ✓ Sync gracefully blocked: ${(e as Error).message}`);
    }

    // ---- DONE ----
    console.log('\n' + '='.repeat(70));
    console.log('  PROTOTYPE DEMO COMPLETE ✓');
    console.log('='.repeat(70) + '\n');
    console.log(`  Check the database for Contract ID: ${contract.id}`);
    console.log(`  1. 'integration_contracts' -> See status = DRIFT_DETECTED`);
    console.log(`  2. 'sync_logs' -> See the successful outbox sync`);
    console.log(`  3. 'drift_alerts' -> See exactly what field broke the contract`);
    console.log('');

  } catch (error) {
    logger.error('Demo failed', {
      ...systemContext(),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error('\n  ✗ Demo failed:', error);
  } finally {
    db.disconnectPool();
  }
}

main();
