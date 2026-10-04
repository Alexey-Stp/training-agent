import { describe, it, expect } from 'vitest';
import { buildWorkoutSteps, Intensity, Sport, type PlannedSessionDraft } from '@triathlon/core';
import { buildCoachPatches } from '../src/coach-plan';
import { MemoryPlanRepo } from './planned-session-fakes';

function draft(date: string, slot: string, sport: Sport, title = 'Session'): PlannedSessionDraft {
  const base = {
    date,
    slot,
    sport,
    title,
    description: null,
    durationMin: 60,
    intensity: Intensity.z2,
  };
  return { ...base, steps: buildWorkoutSteps(base) };
}

describe('buildCoachPatches', () => {
  it('moves a session to the first free slot on the new day, counting tombstones', () => {
    const repo = new MemoryPlanRepo();
    const ride = repo.insert(draft('2026-10-11', 'bike-0', Sport.bike, 'Long ride'));
    const saturday = [
      repo.insert(draft('2026-10-10', 'bike-0', Sport.bike)),
      repo.insert(draft('2026-10-10', 'bike-1', Sport.bike), { deletedAt: new Date() }),
    ];

    const patches = buildCoachPatches(
      [ride, ...saturday],
      [{ sessionId: '2026-10-11/bike-0', field: 'date', before: '2026-10-11', after: '2026-10-10' }]
    );

    expect(patches).toMatchObject([
      { kind: 'update', id: ride.id, session: { date: '2026-10-10', slot: 'bike-2' } },
      { kind: 'tombstone', session: { date: '2026-10-11', slot: 'bike-0', title: 'Long ride' } },
    ]);
  });

  it('combines several changes to one session and renames a sport swap', () => {
    const repo = new MemoryPlanRepo();
    const run = repo.insert(draft('2026-10-07', 'run-0', Sport.run, 'Easy run'));

    const [patch] = buildCoachPatches(
      [run],
      [
        { sessionId: '2026-10-07/run-0', field: 'sport', before: Sport.run, after: Sport.bike },
        { sessionId: '2026-10-07/run-0', field: 'durationMin', before: 60, after: 45 },
      ]
    );

    expect(patch).toMatchObject({
      kind: 'update',
      session: { sport: Sport.bike, durationMin: 45, title: 'bike instead of Easy run' },
    });
  });

  it('cancels at 0 minutes and skips sessions that are not stored', () => {
    const repo = new MemoryPlanRepo();
    const run = repo.insert(draft('2026-10-07', 'run-0', Sport.run));

    const patches = buildCoachPatches(
      [run],
      [
        { sessionId: '2026-10-07/run-0', field: 'durationMin', before: 60, after: 0 },
        { sessionId: '2026-10-08/run-0', field: 'durationMin', before: 60, after: 30 },
      ]
    );

    expect(patches).toEqual([{ kind: 'cancel', id: run.id }]);
  });
});
