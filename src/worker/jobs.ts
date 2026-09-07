import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { hostname } from 'node:os';
import { DbPools } from '../db/pool.js';

/**
 * Scheduled jobs with database leases (sys.job_leases). Every worker task
 * ticks every job on its interval; only the instance holding the lease
 * runs it, so two tasks never run the same scheduled job at once. Work
 * inside a job still claims rows with SKIP LOCKED, so a lost lease is a
 * duplicate, never a corruption.
 */
export interface Job {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<string>;
}

@Injectable()
export class JobRunner implements OnModuleDestroy {
  private readonly logger = new Logger(JobRunner.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly holder = `${hostname()}:${process.pid}`;

  constructor(private readonly pools: DbPools) {}

  schedule(job: Job): void {
    const timer = setInterval(() => void this.runOnce(job), job.intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  /** Runs the job now if the lease can be taken; returns the outcome or 'skipped'. */
  async runOnce(job: Job): Promise<string> {
    if (!(await this.acquire(job))) return 'skipped';
    let outcome: string;
    try {
      outcome = await job.run();
    } catch (error) {
      outcome = `failed: ${(error as Error).message}`;
      this.logger.error(`job ${job.name} ${outcome}`);
    }
    await this.release(job, outcome);
    return outcome;
  }

  private async acquire(job: Job): Promise<boolean> {
    const leaseSeconds = Math.max(30, Math.ceil((job.intervalMs * 2) / 1000));
    const result = await this.pools.get('worker').query(
      `insert into sys.job_leases (name, holder, leased_until) values ($1, $2, now() + make_interval(secs => $3))
       on conflict (name) do update set holder = excluded.holder, leased_until = excluded.leased_until
       where sys.job_leases.leased_until < now()
       returning holder`,
      [job.name, this.holder, leaseSeconds],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async release(job: Job, outcome: string): Promise<void> {
    await this.pools
      .get('worker')
      .query(
        `update sys.job_leases set leased_until = now(), last_run_at = now(), last_outcome = $3 where name = $1 and holder = $2`,
        [job.name, this.holder, outcome.slice(0, 500)],
      )
      .catch(() => undefined);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }
}
