import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { OBJECT_STORE, StorageCoreModule } from '../../common/storage/storage.module.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import { DbPools } from '../../db/pool.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import type { Job } from '../../worker/jobs.js';

export const STREAMS = ['audit', 'security', 'usage'] as const;
export type Stream = (typeof STREAMS)[number];

export interface DigestRow {
  id: string;
  stream: Stream;
  day: string;
  row_count: number;
  digest: string;
  previous_digest: string | null;
  object_key: string | null;
  created_at: string;
}

export interface VerificationRow {
  id: string;
  stream: Stream;
  day: string;
  expected: string;
  actual: string;
  matched: boolean;
  verified_by: string;
  verified_at: string;
}

/**
 * Tamper evidence (Audit & Analytics section 6, XA-04; P1.7.6 cut). The
 * nightly job computes a SHA-256 over each stream's rows for the day,
 * ordered by id, chains it with the previous day's digest, writes
 * `integrity.digest.written`, and stores the digest file in the object
 * store (the Object Lock bucket in AWS, the local store in development).
 * Verification recomputes a day and raises `integrity.digest.mismatch` on
 * any difference; the row is kept so the dashboard shows the last check.
 * The audit stream spans every account, so the job binds all of them.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly pools: DbPools,
    private readonly uow: UnitOfWork,
    private readonly security: SecurityEventsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  digestJob(intervalMs = 15 * 60_000): Job {
    return { name: 'integrity.digest', intervalMs, run: () => this.writeMissing() };
  }

  verifyJob(intervalMs = 60 * 60_000): Job {
    return { name: 'integrity.verify', intervalMs, run: () => this.verifyRecent() };
  }

  /** Writes yesterday's digests (and any earlier missing day back to the first event) for every stream. */
  async writeMissing(reference = new Date()): Promise<string> {
    const yesterday = dayOf(new Date(reference.getTime() - 86_400_000));
    let written = 0;
    for (const stream of STREAMS) {
      const last = await this.lastDigest(stream);
      const start = last ? nextDay(last.day) : await this.firstDay(stream);
      if (!start) continue;
      for (let day = start; day <= yesterday; day = nextDay(day)) {
        await this.write(stream, day);
        written += 1;
      }
    }
    return `digests ${written}`;
  }

  async write(stream: Stream, day: string, by = 'worker'): Promise<DigestRow> {
    const existing = await this.digestFor(stream, day);
    if (existing) return existing;
    const previous = await this.lastDigest(stream);
    const computed = await this.compute(stream, day, previous?.digest ?? null);
    const key = `integrity/${stream}/${day}.json`;
    const row = (
      await this.pools.get('worker').query<DigestRow>(
        `insert into sys.event_digests (stream, day, row_count, digest, previous_digest, object_key)
           values ($1, $2, $3, $4, $5, $6) returning *`,
        [stream, day, computed.count, computed.digest, previous?.digest ?? null, key],
      )
    ).rows[0];
    try {
      await this.store.putObject(
        key,
        JSON.stringify({
          stream,
          day,
          row_count: computed.count,
          digest: computed.digest,
          previous_digest: previous?.digest ?? null,
          written_at: row.created_at,
        }),
        'application/json',
      );
    } catch (error) {
      this.logger.error(`digest file ${key} not stored: ${(error as Error).message}`);
    }
    await this.security.write({
      type: 'integrity.digest.written',
      outcome: 'success',
      actorKind: 'system',
      actorId: by,
      entityKind: 'event_digest',
      entityId: row.id,
      attrs: { stream, day, row_count: computed.count, digest: computed.digest, previous: previous?.digest ?? null },
    });
    return row;
  }

  /** Verifies the last seven digested days of every stream, at most once a day. */
  async verifyRecent(reference = new Date()): Promise<string> {
    let checked = 0;
    let mismatched = 0;
    const today = dayOf(reference);
    for (const stream of STREAMS) {
      const rows = (
        await this.pools
          .get('worker')
          .query<DigestRow>(`select * from sys.event_digests where stream = $1 order by day desc limit 7`, [stream])
      ).rows;
      for (const row of rows) {
        const already = await this.pools
          .get('worker')
          .query(
            `select 1 from sys.digest_verifications where stream = $1 and day = $2 and verified_at::date = $3::date`,
            [stream, row.day, today],
          );
        if ((already.rowCount ?? 0) > 0) continue;
        const result = await this.verify(stream, row.day);
        checked += 1;
        if (!result.matched) mismatched += 1;
      }
    }
    return `verified ${checked}, mismatched ${mismatched}`;
  }

  async verify(stream: Stream, day: string, by = 'worker'): Promise<VerificationRow> {
    const expected = await this.digestFor(stream, day);
    if (!expected) throw new BadRequestException({ code: 'no_digest', stream, day });
    const computed = await this.compute(stream, day, expected.previous_digest);
    const matched = computed.digest === expected.digest && computed.count === expected.row_count;
    const row = (
      await this.pools.get('worker').query<VerificationRow>(
        `insert into sys.digest_verifications (stream, day, expected, actual, matched, verified_by)
           values ($1, $2, $3, $4, $5, $6) returning *`,
        [stream, day, expected.digest, computed.digest, matched, by],
      )
    ).rows[0];
    if (!matched) {
      // The alarm (Platform section 5) keys on this event type; the log line is the local signal.
      this.logger.error(`integrity mismatch on ${stream} ${day}: expected ${expected.digest}, got ${computed.digest}`);
      await this.security.write({
        type: 'integrity.digest.mismatch',
        outcome: 'failed',
        actorKind: 'system',
        actorId: by,
        entityKind: 'event_digest',
        entityId: expected.id,
        attrs: {
          stream,
          day,
          expected: expected.digest,
          actual: computed.digest,
          expected_rows: expected.row_count,
          actual_rows: computed.count,
        },
      });
    }
    return row;
  }

  async status(): Promise<{
    digests: DigestRow[];
    verifications: VerificationRow[];
    last_digest_at: string | null;
    last_verification_at: string | null;
    last_mismatch_at: string | null;
  }> {
    const worker = this.pools.get('worker');
    const digests = (
      await worker.query<DigestRow>(`select distinct on (stream) * from sys.event_digests order by stream, day desc`)
    ).rows;
    const verifications = (
      await worker.query<VerificationRow>(
        `select distinct on (stream) * from sys.digest_verifications order by stream, verified_at desc`,
      )
    ).rows;
    const mismatch = await worker.query<{ at: string | null }>(
      `select max(verified_at) as at from sys.digest_verifications where not matched`,
    );
    return {
      digests,
      verifications,
      last_digest_at:
        digests
          .map((row) => row.created_at)
          .sort()
          .at(-1) ?? null,
      last_verification_at:
        verifications
          .map((row) => row.verified_at)
          .sort()
          .at(-1) ?? null,
      last_mismatch_at: mismatch.rows[0]?.at ?? null,
    };
  }

  list(stream: Stream | undefined, days: number): Promise<DigestRow[]> {
    return this.pools
      .get('worker')
      .query<DigestRow>(
        `select d.*, (select matched from sys.digest_verifications v where v.stream = d.stream and v.day = d.day order by verified_at desc limit 1) as last_matched
           from sys.event_digests d
          where ($1::text is null or stream = $1) and day >= current_date - $2::int
          order by day desc, stream`,
        [stream ?? null, days],
      )
      .then((result) => result.rows);
  }

  // Computation -------------------------------------------------------------

  /**
   * SHA-256 over the canonical JSON of each row for the day, ordered by id,
   * one row per line, then chained: sha256(previous + "\n" + rows). The
   * audit stream reads acct.audit_events under a binding to every account
   * plus op.audit_events; the other two streams are operator tables.
   */
  async compute(stream: Stream, day: string, previous: string | null): Promise<{ digest: string; count: number }> {
    const rows = await this.rowsOf(stream, day);
    const inner = createHash('sha256');
    for (const row of rows) inner.update(`${row}\n`);
    const rowsDigest = inner.digest('hex');
    const outer = createHash('sha256');
    outer.update(`${previous ?? ''}\n${rowsDigest}`);
    return { digest: outer.digest('hex'), count: rows.length };
  }

  /** The first day a stream has events, for the archive's catch-up. */
  firstDayOf(stream: Stream): Promise<string | undefined> {
    return this.firstDay(stream);
  }

  /**
   * The canonical rows of a stream and day (the archive writes exactly
   * these). `acct.audit_events` and `rpt.usage_events` both carry forced
   * row-level security, so both are read under a binding covering every
   * account; an unbound read attests only the rows with no account, which
   * is a small minority of the usage stream. `sys.security_events` and
   * `op.audit_events` are not account scoped and need no binding.
   */
  async rowsOf(stream: Stream, day: string): Promise<string[]> {
    const from = `${day}T00:00:00Z`;
    const to = `${nextDay(day)}T00:00:00Z`;
    if (stream === 'security') {
      return canonical(
        this.pools.get('worker'),
        `select row_to_json(e)::text as row from sys.security_events e where occurred_at >= $1 and occurred_at < $2 order by occurred_at, id`,
        [from, to],
      );
    }
    return this.everyAccount(async (tx) => {
      if (stream === 'usage') {
        return canonical(
          tx,
          `select row_to_json(e)::text as row from rpt.usage_events e where occurred_at >= $1 and occurred_at < $2 order by occurred_at, id`,
          [from, to],
        );
      }
      const account = await canonical(
        tx,
        `select row_to_json(e)::text as row from acct.audit_events e where created_at >= $1 and created_at < $2 order by created_at, id`,
        [from, to],
      );
      const operator = await canonical(
        tx,
        `select row_to_json(e)::text as row from op.audit_events e where created_at >= $1 and created_at < $2 order by created_at, id`,
        [from, to],
      );
      return [...account, ...operator];
    });
  }

  /**
   * The digest attests a whole stream, so it is the one reader that
   * legitimately binds every account at once. Declared here in one place
   * rather than repeated at each query.
   */
  private async everyAccount<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const accounts = (await this.pools.get('worker').query<{ id: string }>('select id from op.accounts')).rows.map(
      (row) => row.id,
    );
    return this.uow.worker(accounts, fn);
  }

  private async lastDigest(stream: Stream): Promise<DigestRow | undefined> {
    return (
      await this.pools
        .get('worker')
        .query<DigestRow>(`select * from sys.event_digests where stream = $1 order by day desc limit 1`, [stream])
    ).rows[0];
  }

  private async digestFor(stream: Stream, day: string): Promise<DigestRow | undefined> {
    return (
      await this.pools
        .get('worker')
        .query<DigestRow>(`select * from sys.event_digests where stream = $1 and day = $2`, [stream, day])
    ).rows[0];
  }

  private async firstDay(stream: Stream): Promise<string | undefined> {
    if (stream === 'security') {
      const result = await this.pools
        .get('worker')
        .query<{ d: string | null }>(`select min(occurred_at)::date::text as d from sys.security_events`);
      return result.rows[0]?.d ?? undefined;
    }
    // Both remaining streams read a table with forced row-level security.
    return this.everyAccount(async (tx) => {
      const sql =
        stream === 'audit'
          ? `select least((select min(created_at) from op.audit_events), (select min(created_at) from acct.audit_events))::date::text as d`
          : `select min(occurred_at)::date::text as d from rpt.usage_events`;
      const result = await tx.query<{ d: string | null }>(sql);
      return result.rows[0]?.d ?? undefined;
    });
  }
}

async function canonical(tx: Tx, sql: string, values: unknown[]): Promise<string[]> {
  const result = await tx.query<{ row: string }>(sql, values);
  return result.rows.map((row) => row.row);
}

export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function nextDay(day: string): string {
  return dayOf(new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000));
}

/**
 * Cold storage for the three event streams (Audit & Analytics section 5,
 * XA-04): every night the previous day's rows of each stream go to the
 * object store as gzipped NDJSON under audit/<stream>/<yyyy>/<mm>/<dd>/,
 * the same canonical rows the digest hashes, so the file and the digest
 * describe one another. One append-only row per stream and day records
 * the key, the count, the size and the file checksum. Parquet and Glue
 * wait for the AWS environment; NDJSON reads anywhere and converts later.
 */
export interface ArchiveRow {
  id: string;
  stream: Stream;
  day: string;
  object_key: string;
  row_count: number;
  byte_count: number;
  checksum: string;
  digest_id: string | null;
  created_at: string;
}

export interface ArchiveSummaryRow {
  stream: Stream;
  last_day: string | null;
  last_run_at: string | null;
  days: number;
  rows: number;
  bytes: number;
}

export function archiveKey(stream: Stream, day: string): string {
  const [year, month, date] = day.split('-');
  return `audit/${stream}/${year}/${month}/${date}/rows.ndjson.gz`;
}

@Injectable()
export class ArchiveService {
  private readonly logger = new Logger(ArchiveService.name);

  constructor(
    private readonly pools: DbPools,
    private readonly digests: DigestService,
    private readonly security: SecurityEventsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  archiveJob(intervalMs = 60 * 60_000): Job {
    return { name: 'integrity.archive', intervalMs, run: () => this.exportMissing() };
  }

  /** Exports every day from the last archive (or the first event) up to yesterday, per stream. */
  async exportMissing(reference = new Date()): Promise<string> {
    const yesterday = dayOf(new Date(reference.getTime() - 86_400_000));
    let exported = 0;
    for (const stream of STREAMS) {
      const last = await this.last(stream);
      const start = last ? nextDay(last.day) : await this.digests.firstDayOf(stream);
      if (!start) continue;
      for (let day = start; day <= yesterday; day = nextDay(day)) {
        await this.export(stream, day);
        exported += 1;
      }
    }
    return `archived ${exported}`;
  }

  async export(stream: Stream, day: string, by = 'worker'): Promise<ArchiveRow> {
    const existing = await this.archiveFor(stream, day);
    if (existing) return existing;
    const rows = await this.digests.rowsOf(stream, day);
    const body = gzipSync(Buffer.from(rows.map((row) => `${row}\n`).join(''), 'utf8'));
    const checksum = createHash('sha256').update(body).digest('hex');
    const key = archiveKey(stream, day);
    await this.store.putObject(key, body, 'application/gzip');
    const digest = await this.pools
      .get('worker')
      .query<{ id: string }>('select id from sys.event_digests where stream = $1 and day = $2', [stream, day]);
    const row = (
      await this.pools.get('worker').query<ArchiveRow>(
        `insert into sys.event_archives (stream, day, object_key, row_count, byte_count, checksum, digest_id)
           values ($1, $2, $3, $4, $5, $6, $7) returning id, stream, day::text as day, object_key, row_count, byte_count, checksum, digest_id, created_at`,
        [stream, day, key, rows.length, body.byteLength, checksum, digest.rows[0]?.id ?? null],
      )
    ).rows[0];
    await this.security.write({
      type: 'integrity.archive.written',
      outcome: 'success',
      actorKind: 'system',
      actorId: by,
      entityKind: 'event_archive',
      entityId: row.id,
      attrs: { stream, day, row_count: rows.length, byte_count: body.byteLength, checksum, object_key: key },
    });
    this.logger.log(`archived ${stream} ${day}: ${rows.length} rows, ${body.byteLength} bytes`);
    return row;
  }

  list(limit = 100): Promise<ArchiveRow[]> {
    return this.pools
      .get('app')
      .query<ArchiveRow>(
        'select id, stream, day::text as day, object_key, row_count, byte_count, checksum, digest_id, created_at from sys.event_archives order by day desc, stream limit $1',
        [Math.min(Math.max(1, limit), 1000)],
      )
      .then((result) => result.rows);
  }

  /**
   * What the archive holds, per stream, for the Security screen's integrity
   * panel: the last day exported, when that export ran, and how many days,
   * rows and bytes are in cold storage altogether. Every figure is an
   * aggregate of `sys.event_archives`, the append-only row the export
   * writes, so a stream with nothing archived is simply absent.
   */
  summary(): Promise<ArchiveSummaryRow[]> {
    return this.pools
      .get('app')
      .query<ArchiveSummaryRow>(
        `select stream, max(day)::text as last_day, max(created_at) as last_run_at, count(*)::int as days,
                sum(row_count)::int as rows, sum(byte_count)::int as bytes
           from sys.event_archives group by stream order by stream`,
      )
      .then((result) => result.rows);
  }

  private async last(stream: Stream): Promise<ArchiveRow | undefined> {
    return (
      await this.pools
        .get('worker')
        .query<ArchiveRow>(
          'select id, stream, day::text as day, object_key, row_count, byte_count, checksum, digest_id, created_at from sys.event_archives where stream = $1 order by day desc limit 1',
          [stream],
        )
    ).rows[0];
  }

  private async archiveFor(stream: Stream, day: string): Promise<ArchiveRow | undefined> {
    return (
      await this.pools
        .get('worker')
        .query<ArchiveRow>(
          'select id, stream, day::text as day, object_key, row_count, byte_count, checksum, digest_id, created_at from sys.event_archives where stream = $1 and day = $2',
          [stream, day],
        )
    ).rows[0];
  }
}

class VerifyDto {
  @IsIn(STREAMS)
  stream!: Stream;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  day!: string;
}

class ListQueryDto {
  @IsOptional()
  @IsIn(STREAMS)
  stream?: Stream;

  @IsOptional()
  @Matches(/^\d{1,3}$/)
  days?: string;
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/integrity')
export class IntegrityController {
  constructor(
    private readonly digests: DigestService,
    private readonly archives: ArchiveService,
  ) {}

  @Get('status')
  @RequirePermission('audit:read')
  status() {
    return this.digests.status();
  }

  @Get('archives')
  @RequirePermission('audit:read')
  listArchives(@Query('limit') limit?: string) {
    return this.archives.list(limit ? Number(limit) : 100);
  }

  @Get('digests')
  @RequirePermission('audit:read')
  list(@Query() query: ListQueryDto) {
    return this.digests.list(query.stream, Math.min(Number(query.days ?? 30), 365));
  }

  @Post('verify')
  @RequirePermission('audit:export')
  verify(@CurrentPrincipal() principal: Principal, @RequestCtx() _ctx: RequestContext, @Body() dto: VerifyDto) {
    return this.digests.verify(dto.stream, dto.day, principal.userId);
  }
}

@Module({
  imports: [StorageCoreModule],
  providers: [DigestService, ArchiveService],
  exports: [DigestService, ArchiveService],
})
export class IntegrityCoreModule {}

@Module({
  imports: [IntegrityCoreModule],
  controllers: [IntegrityController],
  exports: [IntegrityCoreModule],
})
export class IntegrityModule {}
