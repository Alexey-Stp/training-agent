import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

// Helpers for tests that run the real Prisma migration SQL in an in-process Postgres (PGlite)
export const PRISMA_DIR = path.resolve(__dirname, '../../../prisma');
const MIGRATIONS_DIR = path.join(PRISMA_DIR, 'migrations');

/** Migration folder names in Prisma's apply order (lexicographic). */
export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function migrationSql(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

/** Runs migrations in order as one script; a file that needs a transaction opens its own. */
function execAll(db: PGlite, names: string[]): Promise<unknown> {
  return db.exec(names.map(migrationSql).join('\n'));
}

/** Applies every migration strictly before `stop`, or all of them when `stop` is omitted. */
export function applyMigrations(db: PGlite, stop?: string): Promise<unknown> {
  return execAll(
    db,
    migrationNames().filter((n) => stop === undefined || n < stop)
  );
}

/** Applies the migrations from `from` (inclusive) to the end. */
export function applyMigrationsFrom(db: PGlite, from: string): Promise<unknown> {
  return execAll(
    db,
    migrationNames().filter((n) => n >= from)
  );
}

/** Model names declared in schema.prisma. */
export function schemaModels(): string[] {
  const schema = readFileSync(path.join(PRISMA_DIR, 'schema.prisma'), 'utf8');
  return [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
}

type Cell = string | number | boolean | bigint | Date | object | null | undefined;

function toParam(value: Cell): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Inserts Prisma-shaped rows (as `createMany` takes them) with plain SQL. Prisma fills `@updatedAt`
 * itself, so a missing `updatedAt` gets NOW() when the table has that column.
 */
export async function insertRows(
  db: PGlite,
  table: string,
  rows: ReadonlyArray<Record<string, Cell>>
): Promise<void> {
  if (rows.length === 0) return;
  const { rows: cols } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  const hasUpdatedAt = cols.some((c) => c.column_name === 'updatedAt');

  await Promise.all(
    rows.map((row) => {
      const entries = Object.entries(row).filter(([, v]) => v !== undefined);
      const names = entries.map(([k]) => `"${k}"`);
      const params = entries.map((_, i) => `$${i + 1}`);
      if (hasUpdatedAt && !('updatedAt' in row)) {
        names.push('"updatedAt"');
        params.push('NOW()');
      }
      return db.query(
        `INSERT INTO "${table}" (${names.join(', ')}) VALUES (${params.join(', ')})`,
        entries.map(([, v]) => toParam(v))
      );
    })
  );
}

/** Index key columns per table, e.g. `Wellness` → [['userId','date'], ...]; unique constraints included. */
export async function indexColumns(db: PGlite): Promise<Map<string, string[][]>> {
  const { rows } = await db.query<{ table: string; columns: string[] }>(`
    SELECT t.relname AS "table",
           array_agg(a.attname::text ORDER BY k.ord) AS "columns"
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    GROUP BY t.relname, i.indexrelid
  `);
  const byTable = new Map<string, string[][]>();
  for (const r of rows) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.columns]);
  return byTable;
}
