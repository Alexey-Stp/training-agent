import { readdirSync } from 'node:fs';
import path from 'node:path';

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');

/** Migration folder names in Prisma's apply order, up to and including `name`. */
export function migrationsUpTo(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) <= 0);
}
