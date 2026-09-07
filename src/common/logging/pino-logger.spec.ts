import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, PinoLoggerService } from './pino-logger.js';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const env = { LOG_LEVEL: 'debug' as const, APP_VERSION: '1.2.3', NODE_ENV: 'test' as const };

describe('structured logging', () => {
  it('writes one JSON line per event with service, version, level and context', () => {
    const { stream, lines } = capture();
    const nest = new PinoLoggerService(createLogger(env, 'xms-api', stream));
    nest.log('Application started', 'Bootstrap');
    nest.warn({ account_id: 'a1', reason: 'switch_off' }, 'Axel');
    nest.error(new Error('boom'), undefined, 'Jobs');
    const [started, warned, failed] = lines();
    expect(started).toMatchObject({
      level: 'info',
      service: 'xms-api',
      version: '1.2.3',
      context: 'Bootstrap',
      msg: 'Application started',
    });
    expect(typeof started.time).toBe('string');
    expect(warned).toMatchObject({ level: 'warn', context: 'Axel', account_id: 'a1', reason: 'switch_off' });
    expect(failed).toMatchObject({ level: 'error', context: 'Jobs', msg: 'boom' });
    expect((failed.err as { stack?: string }).stack).toContain('boom');
  });

  it('redacts credentials by path and honours the level', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ ...env, LOG_LEVEL: 'info' }, 'xms-worker', stream);
    logger.info({ headers: { authorization: 'Bearer abc' }, body: { password: 'x', token: 'y' } }, 'inbound');
    logger.debug('hidden at info');
    const [inbound, ...rest] = lines();
    expect(inbound.headers).toEqual({ authorization: '[redacted]' });
    expect(inbound.body).toEqual({ password: '[redacted]', token: '[redacted]' });
    expect(rest).toEqual([]);
  });

  it('maps Nest log levels onto pino levels', () => {
    const { stream, lines } = capture();
    const logger = createLogger(env, 'xms-api', stream);
    const nest = new PinoLoggerService(logger);
    nest.setLogLevels(['error', 'warn']);
    nest.log('dropped');
    nest.warn('kept');
    expect(lines().map((line) => line.msg)).toEqual(['kept']);
  });
});
