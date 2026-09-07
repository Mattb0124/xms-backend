import type { INestApplicationContext } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import {
  METHOD_METADATA,
  PATH_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PERMISSION_KEY, REALM_KEY, AXEL_ROUTE_KEY } from './decorators.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/**
 * The route-and-permission table (Security & Tenancy 3; the studio's golden
 * route snapshot pattern). Built from controller metadata, it feeds the
 * startup check (a route without a permission or a public reason refuses
 * to boot) and the snapshot test under test/golden.
 */
export interface RouteEntry {
  readonly method: string;
  readonly path: string;
  readonly controller: string;
  readonly handler: string;
  readonly realm: 'internal' | 'portal';
  readonly permission: string | null;
  readonly public: string | null;
  readonly axel: boolean;
}

export function collectRouteTable(
  app: INestApplicationContext | ModuleRef,
): RouteEntry[] {
  const container = app as Pick<INestApplicationContext, 'get'>;
  const discovery = container.get(DiscoveryService, { strict: false });
  const scanner = container.get(MetadataScanner, { strict: false });
  const reflector = container.get(Reflector, { strict: false });
  const entries: RouteEntry[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const controllerPath = normalise(
      reflector.get<string | string[]>(PATH_METADATA, metatype) ?? '',
    );
    const controllerVersion = reflector.get<string | undefined>(
      VERSION_METADATA,
      metatype,
    );
    const prototype = Object.getPrototypeOf(instance) as object;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name] as
        ((...args: unknown[]) => unknown) | undefined;
      if (typeof handler !== 'function') continue;
      const methodCode = reflector.get<number | undefined>(
        METHOD_METADATA,
        handler,
      );
      if (methodCode === undefined) continue;
      const routePath = normalise(
        reflector.get<string | string[]>(PATH_METADATA, handler) ?? '',
      );
      const version =
        reflector.get<string | symbol | undefined>(VERSION_METADATA, handler) ??
        controllerVersion;
      const prefix =
        version === undefined
          ? '/v1'
          : typeof version === 'symbol'
            ? ''
            : `/v${version}`;
      const targets = [handler, metatype];
      entries.push({
        method: RequestMethod[methodCode],
        path: `${prefix}${join(controllerPath, routePath)}`,
        controller: metatype.name,
        handler: name,
        realm:
          reflector.getAllAndOverride<'internal' | 'portal' | undefined>(
            REALM_KEY,
            targets,
          ) ?? 'internal',
        permission:
          reflector.getAllAndOverride<string | undefined>(
            PERMISSION_KEY,
            targets,
          ) ?? null,
        public:
          reflector.getAllAndOverride<string | undefined>(
            IS_PUBLIC_KEY,
            targets,
          ) ?? null,
        axel: Boolean(
          reflector.getAllAndOverride<boolean | undefined>(
            AXEL_ROUTE_KEY,
            targets,
          ),
        ),
      });
    }
  }
  return entries.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

export function undeclaredRoutes(table: RouteEntry[]): RouteEntry[] {
  return table.filter(
    (entry) => entry.permission === null && entry.public === null,
  );
}

function normalise(path: string | string[]): string {
  const value = Array.isArray(path) ? path[0] : path;
  if (!value || value === '/') return '';
  return value.startsWith('/') ? value : `/${value}`;
}

function join(a: string, b: string): string {
  const joined = `${a}${b}`;
  return joined === '' ? '/' : joined;
}
