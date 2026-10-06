import type { Queue } from 'bullmq';
import { JOB_REGISTRY, registeredJobNames, registeredQueues, type JobDef } from './registry';

export type RegistryQueue = Pick<Queue, 'getJobSchedulers' | 'removeJobScheduler'>;

export interface RegistryReconcileResult {
  /** Scheduler keys that were deleted, as `<queue>/<key>` */
  removed: string[];
}

/** Scheduler ids are `<jobName>:<userId>`; the job name is everything before the first colon */
export function schedulerJobName(key: string): string {
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(0, colon);
}

/**
 * Deletes every repeatable scheduler whose job is not in the registry. The per-feature
 * reconciles create and repair the schedulers they know; this one is what removes the ones whose
 * job was dropped from the code. Queues the registry doesn't mention are left alone.
 */
export async function reconcileRegistry(
  queues: Readonly<Record<string, RegistryQueue>>,
  registry: readonly JobDef[] = JOB_REGISTRY
): Promise<RegistryReconcileResult> {
  const perQueue = await Promise.all(
    registeredQueues(registry).map(async (name) => {
      const queue = queues[name];
      if (!queue) return [];
      const known = registeredJobNames(name, registry);
      const schedulers = await queue.getJobSchedulers();
      const orphans = schedulers
        .map((s) => s.key)
        .filter((key) => !known.has(schedulerJobName(key)));
      await Promise.all(orphans.map((key) => queue.removeJobScheduler(key)));
      return orphans.map((key) => name + '/' + key);
    })
  );
  return { removed: perQueue.flat().sort((a, b) => a.localeCompare(b)) };
}
