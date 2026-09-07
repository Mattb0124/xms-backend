import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listMigrations, MIGRATIONS_DIR } from './migrate.js';

describe('migration files', () => {
  it('lists the repository migrations in numeric order with stable checksums', () => {
    const files = listMigrations(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.map((file) => file.id)).toEqual(files.map((file) => file.id).sort());
    expect(files[0].name).toBe('0001_foundation');
    expect(files[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores files that do not follow the NNNN_name.sql convention', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xms-mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'select 1;');
    writeFileSync(join(dir, 'README.md'), 'not a migration');
    writeFileSync(join(dir, '02_b.sql'), 'select 2;');
    expect(listMigrations(dir).map((file) => file.name)).toEqual(['0001_a']);
  });

  it('every acct table created by a migration applies the isolation block', () => {
    // Static guard next to the runtime isolation suite: a migration that
    // creates an acct.* table must call sys.apply_account_isolation on it.
    for (const file of listMigrations(MIGRATIONS_DIR)) {
      const created = [...file.sql.matchAll(/create table (acct\.[a-z_]+)/g)].map((match) => match[1]);
      for (const table of created) {
        expect(file.sql, `${file.name} creates ${table} without sys.apply_account_isolation`).toContain(
          `sys.apply_account_isolation('${table}'`,
        );
      }
    }
  });
});
