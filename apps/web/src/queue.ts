import type { Queue } from 'bullmq';
import { PROFILE_RESCHEDULE_JOB, type ProfileRescheduleJob } from '@triathlon/core';
import type { ProfileEvents } from './settings/store';

/** Queues `profile-reschedule` for the worker (see apps/worker profile-reschedule.ts). */
export function createProfileEvents(
  queue: Pick<Queue<ProfileRescheduleJob>, 'add'>
): ProfileEvents {
  return {
    async changed(userId) {
      await queue.add(
        PROFILE_RESCHEDULE_JOB,
        { userId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600, count: 100 },
          removeOnFail: { age: 86400 },
        }
      );
    },
  };
}
