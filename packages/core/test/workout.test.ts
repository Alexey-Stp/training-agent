import { describe, it, expect } from 'vitest';
import { buildWorkoutSteps, renderIcuWorkout, workoutMinutes } from '../src/workout';
import { downgradeToEasy, Intensity, Session, Sport } from '../src/types';

function text(sport: Sport, intensity: Intensity, durationMin: number): string {
  return renderIcuWorkout(buildWorkoutSteps({ sport, intensity, durationMin }), sport);
}

describe('renderIcuWorkout', () => {
  it('run intervals: warmup, 5x (3m Z4, 2m Z1), cooldown in HR zones', () => {
    expect(text(Sport.run, Intensity.z4, 55)).toMatchInlineSnapshot(`
      "Warmup
      - 15m Z2 HR

      Main set 5x
      - 3m Z4 HR
      - 2m Z1 HR

      Cooldown
      - 15m Z1 HR"
    `);
  });

  it('bike VO2: 5x (5m Z5, 3m Z1) in power zones', () => {
    expect(text(Sport.bike, Intensity.z5, 70)).toMatchInlineSnapshot(`
      "Warmup
      - 15m Z2

      Main set 5x
      - 5m Z5
      - 3m Z1

      Cooldown
      - 15m Z1"
    `);
  });

  it('bike threshold: 3x (12m Z4, 4m Z1)', () => {
    expect(text(Sport.bike, Intensity.z4, 70)).toMatchInlineSnapshot(`
      "Warmup
      - 11m Z2

      Main set 3x
      - 12m Z4
      - 4m Z1

      Cooldown
      - 11m Z1"
    `);
  });

  it('swim intervals: 10x (2m Z4, 1m Z1) in pace zones', () => {
    expect(text(Sport.swim, Intensity.z4, 50)).toMatchInlineSnapshot(`
      "Warmup
      - 10m Z2 Pace

      Main set 10x
      - 2m Z4 Pace
      - 1m Z1 Pace

      Cooldown
      - 10m Z1 Pace"
    `);
  });

  it('run tempo: 20m Z3 main block', () => {
    expect(text(Sport.run, Intensity.z3, 50)).toMatchInlineSnapshot(`
      "Warmup
      - 15m Z2 HR

      Main set
      - 20m Z3 HR

      Cooldown
      - 15m Z1 HR"
    `);
  });

  it('long ride: one steady Z2 step', () => {
    expect(text(Sport.bike, Intensity.z2, 180)).toMatchInlineSnapshot(`
      "Main set
      - 180m Z2"
    `);
  });

  it('a downgraded interval session becomes one steady Z2 step', () => {
    const vo2: Session = {
      date: '2026-10-01',
      sport: Sport.bike,
      title: 'Bike VO2 Max',
      durationMin: 70,
      intensity: Intensity.z5,
      tags: ['vo2'],
    };
    const easy = downgradeToEasy(vo2, 'low readiness');
    expect(renderIcuWorkout(buildWorkoutSteps(easy), easy.sport)).toMatchInlineSnapshot(`
      "Main set
      - 70m Z2"
    `);
  });

  it('drops reps when the load cap shortens an interval session', () => {
    expect(text(Sport.run, Intensity.z4, 30)).toMatchInlineSnapshot(`
      "Warmup
      - 5m Z2 HR

      Main set 4x
      - 3m Z4 HR
      - 2m Z1 HR

      Cooldown
      - 5m Z1 HR"
    `);
  });
});

describe('buildWorkoutSteps', () => {
  const combos: [Sport, Intensity][] = [];
  for (const sport of [Sport.swim, Sport.bike, Sport.run, Sport.strength, Sport.other]) {
    for (const intensity of Object.values(Intensity)) combos.push([sport, intensity]);
  }

  it('blocks always add up to the session duration, with positive steps', () => {
    for (const [sport, intensity] of combos) {
      for (let durationMin = 1; durationMin <= 240; durationMin++) {
        const blocks = buildWorkoutSteps({ sport, intensity, durationMin });
        expect(workoutMinutes(blocks), `${sport} ${intensity} ${durationMin}m`).toBe(durationMin);
        for (const b of blocks) {
          if (b.kind === 'repeat') {
            expect(b.count).toBeGreaterThanOrEqual(1);
            expect(b.work.durationMin).toBeGreaterThan(0);
            expect(b.rest.durationMin).toBeGreaterThan(0);
          } else {
            // Warmup/cooldown split of a 10+ minute remainder is never empty
            expect(b.durationMin).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('falls back to one steady block when even one rep does not fit', () => {
    expect(
      buildWorkoutSteps({ sport: Sport.bike, intensity: Intensity.z4, durationMin: 20 })
    ).toEqual([{ kind: 'steady', durationMin: 20, zone: Intensity.z4 }]);
    expect(
      buildWorkoutSteps({ sport: Sport.run, intensity: Intensity.z3, durationMin: 25 })
    ).toEqual([{ kind: 'steady', durationMin: 25, zone: Intensity.z3 }]);
  });
});
