import { initializeSchema, disconnectPool } from './db.js';

console.log('Initializing SQLite database schema...');

try {
  initializeSchema();
  console.log('Schema initialized successfully.');
  console.log('Database path: ./vector.db\n');
  console.log('Next step: npm run demo');
} catch (error) {
  console.error('Failed to initialize database:', error);
  process.exit(1);
} finally {
  disconnectPool();
}
