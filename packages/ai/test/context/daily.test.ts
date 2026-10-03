import { describe, expect, it } from 'vitest';
import {
  buildDailyContext,
  DAILY_PROMPT_VERSION,
  emptyWellnessDay,
  MissingProfileError,
} from '../../src';
import {
  DATE,
  emptyAthlete,
  fakeDeps,
  fatiguedAthlete,
  freshAthlete,
  preRaceAthlete,
  USER_ID,
} from './fixtures';

const SECTION_HEADINGS = [
  '## Athlete',
  '## Season position',
  '## Wellness',
  '## Compliance, last 7 days',
  '## Missed key sessions, last 14 days',
  '## Planned: today and the next 3 days',
  '## Sessions the athlete changed in intervals.icu',
  '## Upcoming races',
  '## Recent coach decisions',
  '## Training history, planned vs done',
];

describe('buildDailyContext', () => {
  it('renders a byte-identical prompt from the same data', async () => {
    const [first, second] = await Promise.all([
      buildDailyContext(fakeDeps(fatiguedAthlete()), USER_ID, DATE),
      buildDailyContext(fakeDeps(fatiguedAthlete()), USER_ID, DATE),
    ]);
    expect(second.prompt).toBe(first.prompt);
    expect(second.context).toEqual(first.context);
    expect(first.promptVersion).toBe(DAILY_PROMPT_VERSION);
  });

  it('does not depend on the order repositories return rows in', async () => {
    const results = await Promise.all(
      [freshAthlete, fatiguedAthlete, preRaceAthlete].flatMap((fixture) => [
        buildDailyContext(fakeDeps(fixture()), USER_ID, DATE),
        buildDailyContext(fakeDeps(fixture(), { reversed: true }), USER_ID, DATE),
      ])
    );
    for (let i = 0; i < results.length; i += 2) {
      expect(results[i + 1].prompt).toBe(results[i].prompt);
    }
  });

  it('states missing data explicitly instead of dropping sections', async () => {
    const { prompt, context } = await buildDailyContext(fakeDeps(emptyAthlete()), USER_ID, DATE);

    for (const heading of SECTION_HEADINGS) expect(prompt).toContain(heading);
    expect(prompt).toContain('Today: no device data for 2026-10-03.');
    expect(prompt).toContain('Last 7 days: no device data.');
    expect(prompt).toContain('Training load (CTL/ATL/TSB): no device data.');
    expect(prompt).toContain('HRV baseline: not enough data (0 of 7');
    expect(prompt).toContain('Check-in: none today.');
    expect(prompt).toContain('No active season.');
    expect(prompt).toContain('No upcoming races.');
    expect(prompt).toContain('No coach decisions yet.');
    expect(prompt).toContain('No sessions planned or done 2026-09-26 → 2026-10-02.');
    expect(prompt).toContain('2026-10-03 Sat (today): nothing planned');
    expect(prompt).not.toContain('{{');
    expect(context.wellness.today).toBeNull();
  });

  it('reports no device data when today only has a check-in', async () => {
    const fixture = emptyAthlete();
    fixture.wellness = [{ ...emptyWellnessDay(DATE), subjectiveReadiness: 3, soreness: 2 }];
    const { prompt } = await buildDailyContext(fakeDeps(fixture), USER_ID, DATE);
    expect(prompt).toContain('Today: no device data for 2026-10-03.');
    expect(prompt).toContain('Check-in: readiness 3/5, soreness 2.');
  });

  it('collects the fatigue signals of the fatigued athlete', async () => {
    const { context } = await buildDailyContext(fakeDeps(fatiguedAthlete()), USER_ID, DATE);

    expect(context.wellness.hrv).toMatchObject({ status: 'ok', today: 52, low: true });
    expect(context.wellness.load?.tsb).toBe(-25);
    expect(context.missedKeySessions.map((s) => s.title)).toEqual(['VO2 5x4']);
    expect(context.externallyModified.map((s) => s.date)).toEqual(['2026-10-04']);
    expect(context.upcoming.map((s) => s.date)).toEqual([
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ]);
    expect(context.history).toHaveLength(14);
  });

  it('keeps the latest 5 coach decisions, oldest first', async () => {
    const { context } = await buildDailyContext(fakeDeps(fatiguedAthlete()), USER_ID, DATE);
    expect(context.decisions.map((d) => d.date)).toEqual([
      '2026-09-22',
      '2026-09-25',
      '2026-09-28',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('places the pre-race athlete in the taper, 6 days from the A-race', async () => {
    const { context } = await buildDailyContext(fakeDeps(preRaceAthlete()), USER_ID, DATE);
    expect(context.season?.block).toMatchObject({ type: 'taper', week: 2, weeks: 2 });
    expect(context.season?.daysToARace).toBe(6);
    expect(context.races.map((r) => r.priority)).toEqual(['A', 'B']);
  });

  it('throws when the user has no profile', async () => {
    const fixture = { ...emptyAthlete(), profile: null };
    await expect(buildDailyContext(fakeDeps(fixture), USER_ID, DATE)).rejects.toThrow(
      MissingProfileError
    );
  });

  it('rejects a date that is not yyyy-MM-dd', async () => {
    await expect(buildDailyContext(fakeDeps(freshAthlete()), USER_ID, '2026-10-3')).rejects.toThrow(
      RangeError
    );
  });
});
