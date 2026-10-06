import { describe, expect, it } from 'vitest';
import { reconcileRegistry, schedulerJobName } from '../src/jobs/reconcile';
import {
  JOB_REGISTRY,
  registeredJobNames,
  registeredQueues,
  type JobDef,
} from '../src/jobs/registry';
import { DAILY_BRIEF_QUEUE } from '../src/daily-loop/scheduler';
import { ICU_SYNC_QUEUE } from '../src/sync-scheduler';
import { fakeQueue } from './scheduler-fakes';

const TINY_REGISTRY: JobDef[] = [
  { name: 'alpha', queue: 'q1', kind: 'cron', schedule: 'X', owner: 'test' },
  { name: 'alpha-once', queue: 'q1', kind: 'oneoff', schedule: 'X', owner: 'test' },
  { name: 'beta', queue: 'q2', kind: 'every', schedule: 'X', owner: 'test' },
];

describe('job registry', () => {
  it('has unique (queue, name) pairs', () => {
    const keys = JOB_REGISTRY.map((job) => job.queue + '/' + job.name);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists the jobs of each queue', () => {
    expect(registeredJobNames(ICU_SYNC_QUEUE)).toEqual(
      new Set([
        'icu-activity-sync',
        'icu-wellness-sync',
        'icu-plan-reconcile',
        'season-rolling-publish',
      ])
    );
    expect(registeredJobNames(DAILY_BRIEF_QUEUE)).toEqual(
      new Set(['daily-brief', 'daily-brief-continue'])
    );
    expect(registeredQueues()).toContain('post-race');
  });
});

describe('reconcileRegistry', () => {
  it('removes a scheduler whose job is no longer registered', async () => {
    const q1 = fakeQueue([
      { key: 'alpha:u1' },
      { key: 'removed-job:u1' },
      { key: 'removed-job:u2' },
    ]);
    const q2 = fakeQueue([{ key: 'beta:u1' }]);

    const result = await reconcileRegistry({ q1, q2 }, TINY_REGISTRY);

    expect(result.removed).toEqual(['q1/removed-job:u1', 'q1/removed-job:u2']);
    expect(q1.removeJobScheduler).toHaveBeenCalledTimes(2);
    expect(q1.removeJobScheduler).toHaveBeenCalledWith('removed-job:u1');
    expect(q2.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('keeps every registered scheduler', async () => {
    const q1 = fakeQueue([{ key: 'alpha:u1' }, { key: 'alpha:u2' }]);

    const result = await reconcileRegistry({ q1, q2: fakeQueue() }, TINY_REGISTRY);

    expect(result.removed).toHaveLength(0);
    expect(q1.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('does nothing on empty queues', async () => {
    const result = await reconcileRegistry({ q1: fakeQueue(), q2: fakeQueue() }, TINY_REGISTRY);
    expect(result.removed).toHaveLength(0);
  });

  it('does not touch a queue the registry does not mention', async () => {
    const other = fakeQueue([{ key: 'stranger:u1' }]);

    await reconcileRegistry({ q1: fakeQueue(), q2: fakeQueue(), other }, TINY_REGISTRY);

    expect(other.getJobSchedulers).not.toHaveBeenCalled();
    expect(other.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('skips a registered queue that has no queue object', async () => {
    const result = await reconcileRegistry({ q1: fakeQueue([{ key: 'x:u1' }]) }, TINY_REGISTRY);
    expect(result.removed).toEqual(['q1/x:u1']);
  });
});

describe('schedulerJobName', () => {
  it('takes the part before the first colon', () => {
    expect(schedulerJobName('daily-brief:user-1')).toBe('daily-brief');
    expect(schedulerJobName('plain')).toBe('plain');
  });
});
