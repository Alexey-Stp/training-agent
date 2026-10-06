import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createScriptClient } from './prisma-client';
import { DEMO_DAYS, DEMO_TELEGRAM_ID } from './seed-demo-data';
import { hasIndexPrefix, INDEX_ACCESS_PATHS } from './db-expectations';

/**
 * Smoke checks for a database after `prisma migrate deploy` and `npm run db:seed` (the CI
 * "migrations" job runs it against Postgres). Prints every failed check and exits 1.
 */
const PRISMA_DIR = path.resolve(__dirname, '../prisma');

function migrationFolders(): string[] {
  return readdirSync(path.join(PRISMA_DIR, 'migrations'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function schemaModels(): string[] {
  const schema = readFileSync(path.join(PRISMA_DIR, 'schema.prisma'), 'utf8');
  return [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
}

async function checkMigrations(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const expected = migrationFolders().length;
  return rows[0].n === expected ? [] : [`${rows[0].n} migrations applied, expected ${expected}`];
}

async function checkTables(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`;
  const tables = new Set(rows.map((r) => r.name));
  return schemaModels()
    .filter((m) => !tables.has(m))
    .map((m) => `missing table ${m}`);
}

async function checkNoLegacyFatigue(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ t: string | null }[]>`
    SELECT to_regclass('"Fatigue"')::text AS t`;
  return rows[0].t === null ? [] : ['legacy table Fatigue still exists'];
}

async function checkIndexes(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ table: string; columns: string[] }[]>`
    SELECT t.relname AS "table", array_agg(a.attname::text ORDER BY k.ord) AS "columns"
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    GROUP BY t.relname, i.indexrelid`;
  const byTable = new Map<string, string[][]>();
  for (const r of rows) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.columns]);

  return INDEX_ACCESS_PATHS.filter(
    ([table, cols]) => !hasIndexPrefix(byTable.get(table) ?? [], cols)
  ).map(([table, cols]) => `no index on ${table}(${cols.join(', ')})`);
}

async function checkSeed(prisma: PrismaClient): Promise<string[]> {
  const where = { user: { telegramId: DEMO_TELEGRAM_ID } };
  const [users, wellness, activities, planned] = await Promise.all([
    prisma.user.count({ where: { telegramId: DEMO_TELEGRAM_ID } }),
    prisma.wellness.count({ where }),
    prisma.activity.count({ where }),
    prisma.plannedSession.count({ where }),
  ]);
  const problems: string[] = [];
  if (users !== 1) problems.push(`${users} demo users, expected 1`);
  if (wellness !== DEMO_DAYS)
    problems.push(`${wellness} demo wellness rows, expected ${DEMO_DAYS}`);
  if (activities === 0) problems.push('no demo activities');
  if (planned === 0) problems.push('no demo planned sessions');
  return problems;
}

async function main(): Promise<void> {
  const prisma = createScriptClient();
  try {
    const results = await Promise.all([
      checkMigrations(prisma),
      checkTables(prisma),
      checkNoLegacyFatigue(prisma),
      checkIndexes(prisma),
      checkSeed(prisma),
    ]);
    const problems = results.flat();
    if (problems.length > 0) {
      console.error(`Database verification failed:\n - ${problems.join('\n - ')}`);
      process.exit(1);
    }
    console.warn('Database verification passed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
