import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  collectRouteTable,
  undeclaredRoutes,
  type RouteEntry,
} from '../src/common/auth/route-table.js';
import { isPermission } from '../src/contracts/permissions.js';

/**
 * The route-and-permission snapshot (P1.3.5, Security & Tenancy 3). Every
 * route of the real application, with its realm, permission or public
 * reason, pinned in test/golden/routes.json. A new route without a
 * permission fails here (and at boot); a changed route fails until the
 * snapshot is regenerated with UPDATE_SNAPSHOT=1, which the pull request
 * then shows.
 */
const GOLDEN = join(process.cwd(), 'test', 'golden', 'routes.json');

let app: INestApplication;
let table: RouteEntry[];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  table = collectRouteTable(app);
});

afterAll(async () => {
  await app.close();
});

describe('route and permission snapshot', () => {
  it('has no route without a permission or a public reason', () => {
    expect(undeclaredRoutes(table)).toEqual([]);
  });

  it('uses only permissions from the catalog', () => {
    for (const entry of table) {
      if (entry.permission && entry.permission !== 'authenticated') {
        expect(
          isPermission(entry.permission),
          `${entry.method} ${entry.path} uses ${entry.permission}`,
        ).toBe(true);
      }
    }
  });

  it('keeps portal routes under /v1/portal and internal routes outside it', () => {
    for (const entry of table) {
      if (entry.public) continue;
      const underPortal = entry.path.startsWith('/v1/portal');
      expect(
        entry.realm === 'portal',
        `${entry.method} ${entry.path} realm ${entry.realm}`,
      ).toBe(underPortal);
    }
  });

  it('matches the golden snapshot', () => {
    const current = JSON.stringify(table, null, 2) + '\n';
    if (process.env.UPDATE_SNAPSHOT === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, current);
    }
    const golden = readFileSync(GOLDEN, 'utf8');
    expect(current).toBe(golden);
  });
});
