// Vector Integration Gateway — Demo Runner
// Full lifecycle demo: create contract → transform payload → sync → detect drift
//
// Run: npm run demo

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

// Sample Data

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

// Demo Steps

function main(): void {
  console.log('Starting Vector Integration Gateway - Demo Run');

  try {
    // Database initialization
    db.initializeSchema();
    resetHubSpotSchema();

    // STEP 1: Contract Creation
    console.log('\n[Phase 1] Contract Initialization');
    const initialHash = generateSchemaHash(mockCRM.fetchHubSpotSchema(SAMPLE_CUSTOMER_ID));

    const contract = createIntegrationContract(
      SAMPLE_CUSTOMER_ID,
      PlatformName.HUBSPOT,
      SAMPLE_HUBSPOT_MAPPING,
      initialHash,
    );

    console.log(`Created contract: ${contract.id} (Version: ${contract.version})`);
    console.log(`Initial schema hash: ${initialHash.substring(0, 16)}...\n`);

    // STEP 2: Sync Scenarios (Outbox Pattern)
    console.log('[Phase 2] Sync Worker Scenarios');

    // Case A: Ideal payload
    console.log('- Test Case A: Valid Payload');
    forceAPIResponseCode(200);
    const syncLogA = enqueueSyncJob(contract, SAMPLE_VISITOR_PAYLOAD);
    processPendingJobs();

    // Case B: Partial payload (Graceful degradation)
    console.log('- Test Case B: Missing Optional Fields');
    forceAPIResponseCode(200);
    const syncLogB = enqueueSyncJob(contract, SAMPLE_PAYLOAD_MISSING_OPTIONAL);
    processPendingJobs();

    // Case C: Rate limiting
    console.log('- Test Case C: CRM Rate Limit (429)');
    forceAPIResponseCode(429);
    const syncLogC = enqueueSyncJob(contract, SAMPLE_VISITOR_PAYLOAD);
    processPendingJobs();

    // Case D: Permanent failure
    console.log('- Test Case D: CRM Bad Request (400)');
    forceAPIResponseCode(400);
    const syncLogD = enqueueSyncJob(contract, SAMPLE_VISITOR_PAYLOAD);
    processPendingJobs();

    // Case E: Invalid payload
    console.log('- Test Case E: Missing Primary Key');
    try {
      const badPayload = { ...SAMPLE_VISITOR_PAYLOAD };
      delete (badPayload as any).visitor_email;
      enqueueSyncJob(contract, badPayload);
    } catch (e) {
      console.log(`  Rejected invalid payload: ${(e as Error).message}`);
    }

    forceAPIResponseCode(null);

    // STEP 3: Schema Drift Simulation
    console.log('\n[Phase 3] Simulating Schema Drift');
    console.log('- Renaming "primary_contact_addr" -> "main_email" in remote schema');
    mutateHubSpotSchema('rename', 'primary_contact_addr', 'main_email');
    
    const mutatedSchema = mockCRM.fetchHubSpotSchema(SAMPLE_CUSTOMER_ID);
    const mutatedHash = generateSchemaHash(mutatedSchema);
    console.log(`  New remote schema hash: ${mutatedHash.substring(0, 16)}...\n`);

    // STEP 4: Drift Detection Execution
    console.log('[Phase 4] Executing Drift Detection');
    const updatedContract = db.getContractById(contract.id);
    if (!updatedContract) throw new Error('Contract not found');

    const report = detectDrift(updatedContract);
    
    console.log(`- Drift status: ${report.has_drift}`);
    if (report.missing_fields.length > 0) {
      console.log(`- Missing mapping targets: ${report.missing_fields.join(', ')}`);
    }

    const pausedContract = db.getContractById(contract.id);
    console.log(`- Updated contract status: ${pausedContract?.status}`);
    
    const alerts = db.getUnresolvedAlerts(contract.id);
    console.log(`- Active drift alerts: ${alerts.length}`);
    if (alerts.length > 0) {
      console.log(`  Alert ID: ${alerts[0]!.id}\n`);
    }

    // STEP 5: Post-Drift Sync Attempt
    console.log('[Phase 5] Post-Drift Sync Verification');
    try {
        if (!pausedContract) throw new Error('Contract missing');
        if (pausedContract.status === 'DRIFT_DETECTED') {
           console.log(`- Sync blocked. Contract ${pausedContract.id} is paused.`);
        }
    } catch (e) {
        console.log(`- Execution error: ${(e as Error).message}`);
    }

    console.log('\nDemo execution completed.');
    console.log('Review SQLite database (vector.db) for full record state.');

  } catch (error) {
    logger.error('Demo execution failed', {
      ...systemContext(),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error('Fatal Error:', error);
  } finally {
    db.disconnectPool();
  }
}

main();
