import type { Profile } from '@prisma/client';
import type { UserProfile } from '@triathlon/core';

export const MSG_NO_PROFILE = '❌ No profile found. Please use /start first.';

/** Prisma Profile row → the core profile the plan generator and week expander take. */
export function toUserProfile(profile: Profile): UserProfile {
  return {
    ftp: profile.ftp,
    timezone: profile.timezone,
    swimDays: profile.swimDays as string[],
    bikeVo2Day: profile.bikeVo2Day,
    longBikeDay: profile.longBikeDay,
    noLongRunDay: profile.noLongRunDay,
  };
}
