import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Where connector credentials live (Integration Patterns section 5): the
 * instance row stores the secret name, never the secret. In AWS the
 * provider is Secrets Manager (added with the environment); locally it is
 * a file under the local store root with owner-only permissions, so a
 * developer can run the stand-in without any cloud dependency. The value
 * is a small string map (username and password, or client id and secret).
 */
export interface SecretsProvider {
  readonly kind: 'local' | 'aws';
  put(name: string, value: Record<string, string>): Promise<void>;
  get(name: string): Promise<Record<string, string> | undefined>;
  remove(name: string): Promise<void>;
}

export const SECRETS_PROVIDER = Symbol('SECRETS_PROVIDER');

const NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;

export function assertSecretName(name: string): string {
  if (!NAME.test(name) || name.includes('..')) throw new Error(`Unsafe secret name ${name}`);
  return name;
}

export class LocalSecretsProvider implements SecretsProvider {
  readonly kind = 'local' as const;

  constructor(private readonly root: string) {}

  async put(name: string, value: Record<string, string>): Promise<void> {
    const file = this.file(name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  }

  async get(name: string): Promise<Record<string, string> | undefined> {
    const file = this.file(name);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  }

  async remove(name: string): Promise<void> {
    const file = this.file(name);
    if (existsSync(file)) unlinkSync(file);
  }

  private file(name: string): string {
    return join(this.root, 'secrets', `${assertSecretName(name).replace(/\//g, '__')}.json`);
  }
}

/** An in-memory provider for tests. */
export class MemorySecretsProvider implements SecretsProvider {
  readonly kind = 'local' as const;
  readonly values = new Map<string, Record<string, string>>();

  async put(name: string, value: Record<string, string>): Promise<void> {
    this.values.set(assertSecretName(name), value);
  }

  async get(name: string): Promise<Record<string, string> | undefined> {
    return this.values.get(name);
  }

  async remove(name: string): Promise<void> {
    this.values.delete(name);
  }
}
