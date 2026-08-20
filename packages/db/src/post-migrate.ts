#!/usr/bin/env tsx
/**
 * Apply the SQL Prisma's schema language cannot express: the GiST spatial index, the append-only
 * audit triggers, and the gap-analysis views.
 *
 * Run automatically after `prisma migrate deploy` (see package.json). Every statement in
 * prisma/sql/post-migrate.sql is idempotent, so this is safe to run repeatedly.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = resolve(HERE, '../prisma/sql/post-migrate.sql');

/**
 * Split on semicolons that terminate a statement, while leaving `$$ ... $$` function bodies
 * intact — those contain semicolons that are not statement boundaries.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollar = false;

  for (const line of sql.split('\n')) {
    const dollarCount = (line.match(/\$\$/g) ?? []).length;
    current += line + '\n';
    if (dollarCount % 2 === 1) inDollar = !inDollar;

    if (!inDollar && line.trimEnd().endsWith(';')) {
      const trimmed = current.trim();
      // Skip fragments that are only comments.
      if (trimmed && !trimmed.split('\n').every((l) => l.trim().startsWith('--') || !l.trim())) {
        statements.push(trimmed);
      }
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const sql = await readFile(SQL_PATH, 'utf8');
  const statements = splitStatements(sql);

  console.log(`applying ${statements.length} post-migration statements`);
  try {
    for (const [i, statement] of statements.entries()) {
      const label = statement.split('\n').find((l) => !l.trim().startsWith('--'))?.slice(0, 70);
      try {
        await prisma.$executeRawUnsafe(statement);
      } catch (err) {
        console.error(`\nstatement ${i + 1} failed:\n${statement}\n`);
        throw err;
      }
      console.log(`  ${String(i + 1).padStart(2)} ok  ${label ?? ''}`);
    }
    console.log('post-migration complete');
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly, so the splitter can be unit tested.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
