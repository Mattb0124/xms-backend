import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSION_IMPLICATIONS,
  SYSTEM_ROLES,
  catalogOf,
  describeCatalog,
  expandPermissions,
  isPermission,
} from './permissions.js';

describe('permission catalog', () => {
  it('expands implications transitively (A implies B implies C yields C)', () => {
    const closure = expandPermissions(['time:lock-period']);
    expect([...closure].sort()).toEqual([
      'time:adjust',
      'time:lock-period',
      'time:log',
    ]);
  });

  it('drops keys outside the catalog instead of granting them', () => {
    const closure = expandPermissions(['tickets:view', 'root:everything', '']);
    expect([...closure]).toEqual(['tickets:view']);
  });

  it('never implies across catalogs', () => {
    for (const [key, implied] of Object.entries(PERMISSION_IMPLICATIONS)) {
      for (const target of implied ?? []) {
        expect(catalogOf(target), `${key} implies ${target}`).toBe(
          catalogOf(key as never),
        );
      }
    }
  });

  it('only references catalog keys from implications and system roles', () => {
    for (const implied of Object.values(PERMISSION_IMPLICATIONS)) {
      for (const key of implied ?? []) expect(isPermission(key)).toBe(true);
    }
    for (const roles of Object.values(SYSTEM_ROLES)) {
      for (const permissions of Object.values(roles)) {
        for (const key of permissions) expect(isPermission(key)).toBe(true);
      }
    }
  });

  it('gives the Administrator role every operator permission after expansion', () => {
    const closure = expandPermissions(SYSTEM_ROLES.operator.Administrator);
    const operator = ALL_PERMISSIONS.filter(
      (key) => catalogOf(key) === 'operator',
    );
    expect(operator.filter((key) => !closure.has(key))).toEqual([]);
  });

  it('describes a catalog with labels and direct implications', () => {
    const rows = describeCatalog('portal');
    expect(rows.map((row) => row.key)).toContain('portal:submit');
    expect(
      rows.find((row) => row.key === 'portal:manage-users')!.implies,
    ).toEqual(['portal:view-org-tickets']);
  });
});
