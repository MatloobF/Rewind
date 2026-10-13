import pg from 'pg';

// Same default as .env.example, so the server works without a .env file.
export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:rewind@localhost:5432/rewind';

// One shared pool for the whole process.
export const pool = new pg.Pool({ connectionString: DATABASE_URL });

// Runs fn(client) inside a transaction: COMMIT if it resolves, ROLLBACK if
// it throws. Use this whenever several queries must succeed or fail together.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
