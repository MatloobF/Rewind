// Applies server/migrations/*.sql in name order, each once, each in its own
// transaction. Applied file names are kept in the schema_migrations table.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  // Zero-padded names (001_, 002_) make plain sort the right order.
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
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
