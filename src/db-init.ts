// ============================================================================
// Vector Integration Gateway — Database Initializer
// ============================================================================
// Run: npm run db:init
// Creates the SQLite database and applies the schema.
// ============================================================================

import { initializeSchema, disconnectPool } from './db.js';

console.log('Initializing Vector Integration Gateway database...\n');

try {
  initializeSchema();
  console.log('✓ Database schema initialized successfully.');
  console.log('✓ Database file: vector.db');
  console.log('\nYou can now run:');
  console.log('  npm run demo            — Full lifecycle demo');
} catch (error) {
  console.error('✗ Failed to initialize database:', error);
  process.exit(1);
} finally {
  disconnectPool();
}
