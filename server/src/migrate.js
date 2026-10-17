// Applies server/migrations/*.sql in name order, each once, each in its own
// transaction. Applied file names are kept in the schema_migrations table.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// Any fixed number; every process that migrates locks the same one.
const MIGRATE_LOCK = 4000;

// Several processes can migrate at once (node --test runs each test file in
// its own process), so an advisory lock lets one apply the pending files
// while the others wait, then find them already applied.
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK]);
    return await applyPending(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK]).catch(() => {});
    client.release();
  }
}

async function applyPending(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  // Zero-padded names (001_, 002_) make plain sort the right order.
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    ran.push(file);
  }
  return ran;
}

// Run directly: `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const ran = await migrate();
    console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Already up to date.');
  } finally {
    await pool.end();
  }
}
