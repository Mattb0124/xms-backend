/**
 * The permission catalog (Security & Tenancy section 3). Two catalogs, one
 * shared by the API and the web client, validated server-side. Unknown keys
 * are a build error because every route declares its key through
 * `RequirePermission`, typed against this union.
 *
 * Implications are transitive: `expandPermissions` computes the closure
 * (AIX's one-level `expandPermissions` was documented as a footgun).
 */
export const OPERATOR_PERMISSIONS = {
  'tickets:view': 'View tickets on granted accounts',
  'tickets:create': 'Create tickets',
  'tickets:work': 'Edit, transition, comment and add work notes',
  'tickets:resolve': 'Resolve and close tickets',
  'tickets:override-priority': 'Override the derived priority',
  'tickets:approve-scope': 'Approve or decline out-of-scope flags',
  'tickets:override-change-window': 'Schedule or implement a change outside its window, with a reason',
  'time:log': 'Log time on tickets and buckets',
  'time:adjust': 'Adjust or write off time entries',
  'time:lock-period': 'Lock billing periods',
  'contracts:view': 'Read contracts, rate cards, budget, account time and billing periods',
  'contracts:manage': 'Manage contracts, periods and rate cards',
  'finance:view-margin': 'Read cost rates, margin and account profitability',
  'finance:manage-cost': 'Set the cost rate of a person on the roster',
  'capacity:view': 'View the roster, skills and capacity',
  'capacity:manage': 'Manage roster, skills and allocations',
  'reports:view-portfolio': 'View portfolio dashboards',
  'reports:manage': 'Configure and approve report packs',
  'kb:author': 'Author solution articles',
  'kb:publish': 'Publish and retire solution articles',
  'ai:use': 'Use Axel suggestions and the panel',
  'ai:configure': 'Configure AI settings per account',
  'audit:read': 'Search the audit, security and usage streams',
  'audit:export': 'Export audit search results',
  'analytics:read': 'View aggregated usage analytics',
  'analytics:read-individual': 'View a named user’s activity',
  'admin:accounts': 'Create and manage accounts and their settings',
  'admin:users': 'Manage users, roles, grants and groups',
  'admin:config': 'Manage catalogs, calendars and configuration versions',
  'admin:connectors': 'Manage connectors and replay dead letters',
  'admin:migration': 'Run imports, reconcile and sign off migrations',
  'webhooks:manage': 'Register and manage webhook subscriptions (API clients)',
  'exports:read': 'Read and acknowledge finance deliveries (API clients)',
  'admin:api-clients': 'Create, scope and revoke API clients',
} as const;

export const PORTAL_PERMISSIONS = {
  'portal:submit': 'Submit requests and comment on own requests',
  'portal:view-org-tickets': 'View every request of the account',
  'portal:comment': 'Comment on visible requests',
  'portal:view-consumption': 'View contract consumption',
  'portal:manage-users': 'Invite and deactivate portal users',
  'portal:kb': 'Search and read the knowledge base',
} as const;

export type OperatorPermission = keyof typeof OPERATOR_PERMISSIONS;
export type PortalPermission = keyof typeof PORTAL_PERMISSIONS;
export type Permission = OperatorPermission | PortalPermission;
export type Catalog = 'operator' | 'portal';

/** A permission implies the ones listed; the closure is computed at resolution. */
export const PERMISSION_IMPLICATIONS: Partial<Record<Permission, readonly Permission[]>> = {
  'tickets:create': ['tickets:view'],
  'tickets:work': ['tickets:view', 'tickets:create'],
  'tickets:resolve': ['tickets:work'],
  'tickets:override-priority': ['tickets:work'],
  'tickets:approve-scope': ['tickets:work'],
  'tickets:override-change-window': ['tickets:work'],
  'time:adjust': ['time:log'],
  'time:lock-period': ['time:adjust'],
  'capacity:manage': ['capacity:view'],
  'contracts:view': ['tickets:view'],
  'contracts:manage': ['contracts:view'],
  // Margin is revenue against cost, and revenue comes off the rate cards, so
  // reading a margin means reading the commercial terms it stands on.
  'finance:view-margin': ['contracts:view'],
  'finance:manage-cost': ['finance:view-margin'],
  'reports:manage': ['reports:view-portfolio'],
  'kb:publish': ['kb:author'],
  'ai:configure': ['ai:use'],
  'audit:export': ['audit:read'],
  'analytics:read-individual': ['analytics:read'],
  // Managing users is not managing accounts: the widening was not
  // intended and account administration binds every live account
  // (Security & Tenancy section 3, recorded as a deviation).
  'admin:users': ['admin:api-clients'],
  'admin:api-clients': ['webhooks:manage', 'exports:read'],
  'portal:view-org-tickets': ['portal:submit'],
  'portal:comment': ['portal:submit'],
  'portal:manage-users': ['portal:view-org-tickets'],
};

export const ALL_PERMISSIONS: readonly Permission[] = [
  ...(Object.keys(OPERATOR_PERMISSIONS) as OperatorPermission[]),
  ...(Object.keys(PORTAL_PERMISSIONS) as PortalPermission[]),
];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

export function catalogOf(permission: Permission): Catalog {
  return permission in PORTAL_PERMISSIONS ? 'portal' : 'operator';
}

/** Transitive closure over the implications; input keys outside the catalog are dropped. */
export function expandPermissions(granted: Iterable<string>): Set<Permission> {
  const result = new Set<Permission>();
  const stack: Permission[] = [];
  for (const key of granted) {
    if (isPermission(key)) stack.push(key);
  }
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    for (const implied of PERMISSION_IMPLICATIONS[current] ?? []) {
      if (!result.has(implied)) stack.push(implied);
    }
  }
  return result;
}

/** Catalog rows for the admin screens: key, label, direct implications. */
export function describeCatalog(catalog: Catalog): { key: Permission; label: string; implies: Permission[] }[] {
  const source = catalog === 'portal' ? PORTAL_PERMISSIONS : OPERATOR_PERMISSIONS;
  return (Object.entries(source) as [Permission, string][]).map(([key, label]) => ({
    key,
    label,
    implies: [...(PERMISSION_IMPLICATIONS[key] ?? [])],
  }));
}

/** System roles seeded at bootstrap (Domain Model 3.1). */
export const SYSTEM_ROLES: Record<Catalog, Record<string, readonly Permission[]>> = {
  operator: {
    Administrator: [
      'tickets:resolve',
      'tickets:override-priority',
      'tickets:approve-scope',
      'tickets:override-change-window',
      'time:lock-period',
      'contracts:manage',
      'capacity:manage',
      'reports:manage',
      'kb:publish',
      'ai:configure',
      'audit:export',
      'analytics:read-individual',
      'admin:accounts',
      'admin:users',
      'admin:config',
      'admin:connectors',
      'admin:migration',
      'finance:manage-cost',
    ],
    Consultant: ['tickets:resolve', 'time:log', 'kb:author', 'ai:use'],
    Dispatcher: ['tickets:work', 'tickets:override-priority', 'reports:view-portfolio', 'capacity:view', 'ai:use'],
    // Consultants and dispatchers work tickets; rate cards, budget, contract
    // position and account time are commercial and stay behind
    // contracts:view, which contracts:manage implies.
    'Account Owner': [
      'tickets:resolve',
      'tickets:override-priority',
      'tickets:approve-scope',
      'tickets:override-change-window',
      'time:adjust',
      'contracts:manage',
      'reports:manage',
      'kb:publish',
      'capacity:view',
      'ai:use',
      'analytics:read',
    ],
    Finance: ['time:lock-period', 'contracts:manage', 'reports:view-portfolio', 'capacity:view', 'finance:manage-cost'],
  },
  portal: {
    Requester: ['portal:submit', 'portal:kb'],
    'Account Admin': ['portal:manage-users', 'portal:comment', 'portal:view-consumption', 'portal:kb'],
    'Read Only': ['portal:view-org-tickets', 'portal:kb'],
  },
};
