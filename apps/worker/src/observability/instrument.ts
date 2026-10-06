import type { Job, Worker } from 'bullmq';
import type { FailureStreakTracker } from './failure-streak';
import type { WorkerMetrics } from './metrics';

export interface InstrumentLogger {
  error(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface InstrumentOptions {
  queue: string;
  /** Human label used in the failure log line, e.g. "Daily brief" */
  label: string;
  logger: InstrumentLogger;
  metrics: WorkerMetrics;
  /** Daily-brief queue only: feeds the consecutive-failure alert */
  streak?: FailureStreakTracker;
}

/**
 * The listeners every per-athlete worker shares: metrics, the failure log line, the worker error
 * log and (for the brief) the failure streak. A streak tracker error is logged, never thrown,
 * because BullMQ would treat a throwing listener as an unhandled error.
 */
export function instrumentWorker<T extends { userId: string }>(
  worker: Worker<T>,
  options: InstrumentOptions
): void {
  const { queue, label, logger, metrics, streak } = options;
  metrics.observeWorker(worker, queue);

  worker.on('failed', (job: Job<T> | undefined, err: Error) => {
    logger.error(
      {
        jobId: job?.id,
        job: job?.name,
        userId: job?.data.userId,
        attempt: job?.attemptsMade,
        error: err,
      },
      label + ' failed'
    );
    if (!streak || !job) return;
    streak.recordFailure(job, err).catch((error: unknown) => {
      logger.warn({ error }, 'Could not record the ' + label + ' failure streak');
    });
  });

  if (streak) {
    worker.on('completed', (job: Job<T>) => {
      const userId = job.data.userId;
      if (!userId) return;
      streak.recordSuccess(userId).catch((error: unknown) => {
        logger.warn({ error }, 'Could not reset the ' + label + ' failure streak');
      });
    });
  }

  worker.on('error', (err: Error) => {
    logger.error({ error: err }, label + ' worker error');
  });
}
