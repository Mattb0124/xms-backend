import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * `whitelist` only strips unknown properties on classes with decorated
 * members, so a field typed `Record<string, unknown>` with `@IsObject()`
 * alone passes through wholesale, at any depth and any size, into jsonb
 * (security review finding 16). Where the shape is genuinely open (branding,
 * external references, a saved view definition, a configuration body) the
 * bound that can still be stated is the size, and it is stated here rather
 * than left to Express's body limit three layers away.
 */
export const DEFAULT_JSON_LIMIT = 64 * 1024;

export function MaxJsonSize(bytes = DEFAULT_JSON_LIMIT, options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'maxJsonSize',
      target: target.constructor,
      propertyName: propertyName as string,
      constraints: [bytes],
      options,
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || value === null) return true;
          try {
            return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <= bytes;
          } catch {
            // Circular or otherwise unserialisable: it cannot be stored either.
            return false;
          }
        },
        defaultMessage(): string {
          return `must serialise to at most ${bytes} bytes of JSON`;
        },
      },
    });
  };
}
