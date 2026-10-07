/**
 * Profile settings changed outside the worker (the web dashboard, TA-54). The web app writes
 * Profile, then queues one job so the worker re-registers the athlete's schedulers: brief and
 * close-out time, timezone and the notification chat are read when a scheduler is upserted.
 */
export const PROFILE_SETTINGS_QUEUE = 'profile-settings';
export const PROFILE_RESCHEDULE_JOB = 'profile-reschedule';

export interface ProfileRescheduleJob {
  userId: string;
}

/** Weekday names stored in Profile day preferences (`swimDays` adds a `_optional` suffix). */
export const PROFILE_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export type ProfileWeekday = (typeof PROFILE_WEEKDAYS)[number];

export const OPTIONAL_SWIM_SUFFIX = '_optional';
