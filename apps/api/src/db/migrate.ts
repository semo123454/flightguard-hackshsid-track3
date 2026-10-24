import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FlightGuardDb } from './connection.js';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

export function migrate(db: FlightGuardDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map((row) => row.version),
  );
  const files = readdirSync(migrationsDir).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const run = db.transaction((file: string) => {
    db.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
  });
  for (const file of files) if (!applied.has(file)) run(file);
}
