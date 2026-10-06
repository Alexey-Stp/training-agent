import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** The slice of a BullMQ job the metrics need */
export interface MetricJob {
  name: string;
  processedOn?: number;
  finishedOn?: number;
}

/** The slice of a BullMQ worker the metrics need */
export interface ObservableWorker {
  on(event: 'completed', listener: (job: MetricJob) => void): unknown;
  on(event: 'failed', listener: (job: MetricJob | undefined, err: Error) => void): unknown;
}

/** Job runs take from milliseconds (a skipped brief) to minutes (an LLM-backed review) */
const DURATION_BUCKETS = [0.05, 0.25, 1, 2.5, 5, 15, 30, 60, 120, 300];

export interface WorkerMetrics {
  registry: Registry;
  /** Records duration, completions and failures of every job the worker processes */
  observeWorker(worker: ObservableWorker, queue: string): void;
}

export function createMetrics(): WorkerMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const duration = new Histogram({
    name: 'job_duration_seconds',
    help: 'Time a job attempt spent in the processor',
    labelNames: ['job', 'queue', 'status'] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });
  const completed = new Counter({
    name: 'job_completed_total',
    help: 'Job attempts that finished successfully',
    labelNames: ['job', 'queue'] as const,
    registers: [registry],
  });
  const failures = new Counter({
    name: 'job_failures_total',
    help: 'Job attempts that threw (retries count)',
    labelNames: ['job', 'queue'] as const,
    registers: [registry],
  });

  function seconds(job: MetricJob): number | null {
    if (job.processedOn === undefined || job.finishedOn === undefined) return null;
    return Math.max(0, job.finishedOn - job.processedOn) / 1000;
  }

  return {
    registry,
    observeWorker(worker, queue) {
      worker.on('completed', (job) => {
        const labels = { job: job.name, queue };
        completed.inc(labels);
        const took = seconds(job);
        if (took !== null) duration.observe({ ...labels, status: 'completed' }, took);
      });
      worker.on('failed', (job, _err) => {
        // A failed event without a job (a stalled job that was already removed) has no name
        const labels = { job: job?.name ?? 'unknown', queue };
        failures.inc(labels);
        const took = job ? seconds(job) : null;
        if (took !== null) duration.observe({ ...labels, status: 'failed' }, took);
      });
    },
  };
}
