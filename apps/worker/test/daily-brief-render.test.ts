import { describe, it, expect } from 'vitest';
import { Intensity, Sport, parseCoachDecision } from '@triathlon/core';
import type { CoachDecisionRecord, PlannedSessionSummary, SessionDiff } from '@triathlon/ai';
import { renderBrief, type BriefInput } from '../src/daily-loop/render';

const TODAY = '2026-10-05';
const DECISION_ID = 'dec1';

function planned(
  date: string,
  sport: Sport,
  title: string,
  durationMin: number,
  intensity: Intensity
): PlannedSessionSummary {
  return {
    date,
    slot: sport + '-0',
    sport,
    title,
    durationMin,
    intensity,
    status: 'pushed',
    externalChange: null,
  };
}

const PLAN: PlannedSessionSummary[] = [
  planned(TODAY, Sport.bike, 'VO2 5x4', 70, Intensity.z5),
  planned(TODAY, Sport.swim, 'Aerobic swim', 45, Intensity.z2),
  planned('2026-10-06', Sport.run, 'Easy run', 45, Intensity.z2),
];

const CHANGES: SessionDiff[] = [
  { sessionId: TODAY + '/bike-0', field: 'durationMin', before: 70, after: 50 },
  { sessionId: TODAY + '/bike-0', field: 'intensity', before: Intensity.z5, after: Intensity.z3 },
];

function decision(changes: SessionDiff[], athleteMessage: string): CoachDecisionRecord {
  return {
    userId: 'user-1',
    origin: 'daily',
    date: TODAY,
    promptVersion: 'daily-v1',
    suggestionPromptVersion: 'suggestion-v1',
    contextHash: 'abc',
    source: 'llm',
    fallbackReason: null,
    attempts: 1,
    rawResponses: [],
    suggestion: null,
    verdict: 'accept',
    reasons: [],
    finalAction: changes.length === 0 ? 'keep' : 'reduce',
    finalChanges: changes,
    summary: '',
    athleteMessage,
  };
}

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    date: TODAY,
    timezone: 'Europe/Berlin',
    decision: decision(CHANGES, 'HRV is low & sleep was short. Take the VO2 set down a notch.'),
    decisionId: DECISION_ID,
    planned: PLAN,
    readiness: { emoji: '🟡', sentence: 'HRV is below your 30-day baseline: listen to your body.' },
    stale: false,
    dataAsOf: null,
    ...overrides,
  };
}

function buttons(reply: ReturnType<typeof renderBrief>) {
  return reply.keyboard?.map((row) =>
    row.map((b) => ({ text: b.text, data: parseCoachDecision(b.data) }))
  );
}

describe('renderBrief', () => {
  it('renders a brief with a suggestion', () => {
    const reply = renderBrief(input());
    expect(reply.html).toBe(true);
    expect(reply.text).toMatchSnapshot();
    expect(buttons(reply)).toEqual([
      [
        { text: '✅ Apply', data: { answer: 'apply', decisionId: DECISION_ID } },
        { text: '➡️ Keep plan', data: { answer: 'keep', decisionId: DECISION_ID } },
      ],
      [{ text: '💬 Discuss', data: { answer: 'discuss', decisionId: DECISION_ID } }],
    ]);
  });

  it('renders a brief without a suggestion', () => {
    const reply = renderBrief(
      input({
        decision: decision([], 'You are fresh. Go and enjoy the VO2 set.'),
        readiness: { emoji: '🟢', sentence: 'Recovered: good to train as planned.' },
      })
    );
    expect(reply.text).toMatchSnapshot();
    expect(reply.text).not.toContain('Proposed');
    expect(buttons(reply)).toEqual([
      [{ text: '💬 Discuss', data: { answer: 'discuss', decisionId: DECISION_ID } }],
    ]);
  });

  it('renders a rest day with stale data', () => {
    const reply = renderBrief(
      input({
        decision: decision([], 'Rest well.'),
        planned: PLAN.filter((s) => s.date !== TODAY),
        readiness: { emoji: '⚪', sentence: 'No readiness data today: go by how you feel.' },
        stale: true,
        dataAsOf: new Date('2026-10-04T18:00:00Z'),
      })
    );
    expect(reply.text).toMatchSnapshot();
  });
});
