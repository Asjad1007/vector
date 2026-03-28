// ============================================================================
// Vector Integration Gateway — Mock CRM Service
// ============================================================================
// Simulates HubSpot and Salesforce API responses for development and testing.
// The schema returned by fetchHubSpotSchema() can be mutated between calls to
// simulate schema drift (field renames, deletions, type changes).
//
// Usage:
//   import { mockCRM, mutateHubSpotSchema, resetHubSpotSchema } from './mockService.js';
//   const schema = mockCRM.fetchHubSpotSchema('customer_123');
//   mutateHubSpotSchema('rename', 'primary_contact_addr', 'main_email');
// ============================================================================

import type { RemoteSchemaField, MockAPIResponse } from './types.js';

// --------------------------------------------------------
// Base Schema Definitions
// --------------------------------------------------------

const BASE_HUBSPOT_SCHEMA: RemoteSchemaField[] = [
  { name: 'primary_contact_addr', type: 'string', required: true, label: 'Primary Contact Email' },
  { name: 'contact_name', type: 'string', required: false, label: 'Full Name' },
  { name: 'company_domain_name', type: 'string', required: true, label: 'Company Domain' },
  { name: 'company', type: 'string', required: false, label: 'Company Name' },
  { name: 'engagement_score', type: 'number', required: false, label: 'Engagement Score' },
  { name: 'last_page_viewed', type: 'string', required: false, label: 'Last Page Viewed' },
  { name: 'signal_timestamp', type: 'date', required: false, label: 'Signal Timestamp' },
  { name: 'signal_category', type: 'string', required: false, label: 'Signal Category' },
  { name: 'lifecycle_stage', type: 'string', required: false, label: 'Lifecycle Stage' },
  { name: 'utm_source', type: 'string', required: false, label: 'UTM Source' },
];

const BASE_SALESFORCE_SCHEMA: RemoteSchemaField[] = [
  { name: 'Email', type: 'string', required: true, label: 'Email Address' },
  { name: 'Name', type: 'string', required: false, label: 'Full Name' },
  { name: 'Company', type: 'string', required: true, label: 'Company' },
  { name: 'Website', type: 'string', required: false, label: 'Website' },
  { name: 'LeadScore__c', type: 'number', required: false, label: 'Lead Score (Custom)' },
  { name: 'LastPageViewed__c', type: 'string', required: false, label: 'Last Page Viewed (Custom)' },
  { name: 'SignalDate__c', type: 'date', required: false, label: 'Signal Date (Custom)' },
  { name: 'SignalType__c', type: 'string', required: false, label: 'Signal Type (Custom)' },
];

// --------------------------------------------------------
// Mutable State (for drift simulation)
// --------------------------------------------------------

let currentHubSpotSchema: RemoteSchemaField[] = structuredClone(BASE_HUBSPOT_SCHEMA);
let currentSalesforceSchema: RemoteSchemaField[] = structuredClone(BASE_SALESFORCE_SCHEMA);

// API call counter — used to simulate rate limits
let apiCallCount = 0;

// Force specific response codes for testing
let forcedResponseCode: number | null = null;

// --------------------------------------------------------
// Schema Mutation Functions (for drift simulation)
// --------------------------------------------------------

export type DriftMutation = 'rename' | 'delete' | 'type_change' | 'add';

/**
 * Mutate the HubSpot schema to simulate drift.
 *
 * @param mutation - The type of drift to simulate
 * @param fieldName - The field to mutate
 * @param newValue - For 'rename': the new name. For 'type_change': the new type. For 'add': the field name to add.
 */
export function mutateHubSpotSchema(
  mutation: DriftMutation,
  fieldName: string,
  newValue?: string,
): void {
  switch (mutation) {
    case 'rename': {
      const field = currentHubSpotSchema.find(f => f.name === fieldName);
      if (field && newValue) {
        field.name = newValue;
        field.label = `${newValue} (Renamed)`;
      }
      break;
    }
    case 'delete': {
      currentHubSpotSchema = currentHubSpotSchema.filter(f => f.name !== fieldName);
      break;
    }
    case 'type_change': {
      const field = currentHubSpotSchema.find(f => f.name === fieldName);
      if (field && newValue) {
        field.type = newValue;
      }
      break;
    }
    case 'add': {
      currentHubSpotSchema.push({
        name: fieldName,
        type: newValue ?? 'string',
        required: false,
        label: `${fieldName} (New Field)`,
      });
      break;
    }
  }
}

/**
 * Reset the HubSpot schema to its original state.
 */
export function resetHubSpotSchema(): void {
  currentHubSpotSchema = structuredClone(BASE_HUBSPOT_SCHEMA);
}

/**
 * Reset the Salesforce schema to its original state.
 */
export function resetSalesforceSchema(): void {
  currentSalesforceSchema = structuredClone(BASE_SALESFORCE_SCHEMA);
}

/**
 * Force a specific API response code for testing (e.g., 429, 500).
 * Pass null to return to normal behavior.
 */
export function forceAPIResponseCode(code: number | null): void {
  forcedResponseCode = code;
}

/**
 * Reset the API call counter.
 */
export function resetAPICallCount(): void {
  apiCallCount = 0;
}

// --------------------------------------------------------
// Mock CRM API
// --------------------------------------------------------

export const mockCRM = {
  /**
   * Simulate fetching the current schema from HubSpot's API.
   * The returned schema can be mutated between calls to simulate drift.
   */
  fetchHubSpotSchema(_customerId: string): RemoteSchemaField[] {
    // Simulate API latency would go here in a real implementation
    return structuredClone(currentHubSpotSchema);
  },

  /**
   * Simulate fetching the current schema from Salesforce's API.
   */
  fetchSalesforceSchema(_customerId: string): RemoteSchemaField[] {
    return structuredClone(currentSalesforceSchema);
  },

  /**
   * Simulate sending a payload to HubSpot's contact creation/update API.
   * Returns realistic response codes including rate limits and server errors.
   */
  sendToHubSpot(payload: Record<string, unknown>): MockAPIResponse {
    apiCallCount++;

    // If a specific response code is forced, use it
    if (forcedResponseCode !== null) {
      return mockResponse(forcedResponseCode, payload);
    }

    // Simulate realistic API behavior:
    // - 80% success (200)
    // - 10% rate limit (429)
    // - 5% server error (500)
    // - 5% bad request (400)
    const roll = Math.random();

    if (roll < 0.80) return mockResponse(200, payload);
    if (roll < 0.90) return mockResponse(429, payload);
    if (roll < 0.95) return mockResponse(500, payload);
    return mockResponse(400, payload);
  },

  /**
   * Simulate sending a payload to Salesforce's API.
   */
  sendToSalesforce(payload: Record<string, unknown>): MockAPIResponse {
    apiCallCount++;

    if (forcedResponseCode !== null) {
      return mockResponse(forcedResponseCode, payload);
    }

    const roll = Math.random();
    if (roll < 0.85) return mockResponse(200, payload);
    if (roll < 0.92) return mockResponse(429, payload);
    if (roll < 0.97) return mockResponse(500, payload);
    return mockResponse(400, payload);
  },
};

// --------------------------------------------------------
// Response Factory
// --------------------------------------------------------

function mockResponse(status: number, _payload: Record<string, unknown>): MockAPIResponse {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  switch (status) {
    case 200:
      return {
        status: 200,
        success: true,
        message: 'Contact created/updated successfully',
        request_id: requestId,
      };
    case 429:
      return {
        status: 429,
        success: false,
        message: 'Rate limit exceeded. Please retry after 60 seconds.',
        request_id: requestId,
      };
    case 500:
      return {
        status: 500,
        success: false,
        message: 'Internal server error. The request could not be processed.',
        request_id: requestId,
      };
    case 400:
      return {
        status: 400,
        success: false,
        message: 'Bad request. One or more required fields are missing or invalid.',
        request_id: requestId,
      };
    default:
      return {
        status,
        success: false,
        message: `Unexpected status code: ${status}`,
        request_id: requestId,
      };
  }
}

// --------------------------------------------------------
// Schema Fetcher Factory
// --------------------------------------------------------

/**
 * Get the appropriate schema fetcher for a given platform.
 */
export function getSchemaFetcher(
  platform: string,
): (customerId: string) => RemoteSchemaField[] {
  switch (platform) {
    case 'HUBSPOT':
      return mockCRM.fetchHubSpotSchema;
    case 'SALESFORCE':
      return mockCRM.fetchSalesforceSchema;
    default:
      throw new Error(`Unsupported platform: ${platform}. Supported: HUBSPOT, SALESFORCE`);
  }
}

/**
 * Get the appropriate API sender for a given platform.
 */
export function getAPISender(
  platform: string,
): (payload: Record<string, unknown>) => MockAPIResponse {
  switch (platform) {
    case 'HUBSPOT':
      return mockCRM.sendToHubSpot;
    case 'SALESFORCE':
      return mockCRM.sendToSalesforce;
    default:
      throw new Error(`Unsupported platform: ${platform}. Supported: HUBSPOT, SALESFORCE`);
  }
}
