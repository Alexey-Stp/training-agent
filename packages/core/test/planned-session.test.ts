import { describe, it, expect } from 'vitest';
import { addOptionalSundaySwim, generateDraftPlan } from '../src/plan-generator';
import { toPlannedSessions } from '../src/planned-session';
import { buildWorkoutSteps } from '../src/workout';
import { Intensity, Sport, UserProfile, WeekPlan } from '../src/types';

const PROFILE: UserProfile = {
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
};

describe('toPlannedSessions', () => {
  it('maps the generated week to one draft per training session', () => {
    const plan = addOptionalSundaySwim(generateDraftPlan(PROFILE, '2026-09-28'), PROFILE); // Monday
    const drafts = toPlannedSessions(plan);

    expect(drafts.map((d) => [d.date, d.slot, d.title])).toEqual([
      ['2026-09-28', 'bike-0', 'Bike Endurance'],
      ['2026-09-29', 'run-0', 'Run Intervals'],
      ['2026-09-30', 'swim-0', 'Swim Technique'],
      ['2026-10-01', 'bike-0', 'Bike VO2 Max'],
      ['2026-10-02', 'swim-0', 'Swim Intervals'],
      ['2026-10-03', 'run-0', 'Run Tempo'],
      ['2026-10-04', 'bike-0', 'Long Bike'],
      ['2026-10-04', 'swim-0', 'Optional Easy Swim'],
    ]);
    const tue = drafts[1];
    expect(tue).toMatchObject({
      sport: Sport.run,
      intensity: Intensity.z4,
      durationMin: 55,
      description: 'Warm up 15min, 5x3min Z4 (2min rest), cool down',
    });
    expect(tue.steps).toEqual(buildWorkoutSteps(tue));
  });

  it('skips rest days and numbers same-sport sessions on a date', () => {
    const plan: WeekPlan = {
      startDate: '2026-09-28',
      sessions: [
        {
          date: '2026-09-28',
          sport: Sport.rest,
          title: 'Rest Day',
          durationMin: 0,
          intensity: Intensity.z1,
        },
        {
          date: '2026-09-29',
          sport: Sport.run,
          title: 'AM Run',
          durationMin: 40,
          intensity: Intensity.z2,
        },
        {
          date: '2026-09-29',
          sport: Sport.swim,
          title: 'Swim',
          durationMin: 30,
          intensity: Intensity.z2,
        },
        {
          date: '2026-09-29',
          sport: Sport.run,
          title: 'PM Run',
          durationMin: 30,
          intensity: Intensity.z1,
        },
      ],
      warnings: [],
      appliedRules: [],
    };

    expect(toPlannedSessions(plan).map((d) => [d.slot, d.title, d.description])).toEqual([
      ['run-0', 'AM Run', null],
      ['swim-0', 'Swim', null],
      ['run-1', 'PM Run', null],
    ]);
  });
});
