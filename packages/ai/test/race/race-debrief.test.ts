import { describe, expect, it } from 'vitest';
import {
  buildRaceDebriefPrompt,
  FALLBACK_DEBRIEF_TEXT,
  MockProvider,
  parseRaceDebriefText,
  runRaceDebrief,
  type RaceDebriefPromptInput,
} from '../../src';

const FACTS = [
  'NP 241 W vs target 234–246 W: within the band',
  'Split: positive (first half 255 W, second half 225 W, fade 11.8%)',
  'HR drift 4.5% (power per heartbeat)',
].join('\n');

function input(tier: RaceDebriefPromptInput['tier'] = 'power'): RaceDebriefPromptInput {
  return {
    raceName: 'Ironman 70.3 Prague',
    raceType: 'half',
    priority: 'A',
    tier,
    facts: FACTS,
    recoveryNote: 'Ten easy days follow, with rest right after the race.',
  };
}

const GOOD = [
  'You held NP 241 W, inside the band, but the split was positive.',
  '---',
  '- Start the bike closer to 225 W and keep it there.',
  '- A drift of 4.5% says fuelling held up.',
  '- Rest first, the easy block is part of the plan.',
].join('\n');

describe('race-debrief-v1 prompt', () => {
  it.each(['power', 'hr', 'none'] as const)('renders the %s tier', async (tier) => {
    const prompt = buildRaceDebriefPrompt(input(tier));
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    await expect(prompt).toMatchFileSnapshot('./__snapshots__/race-debrief-' + tier + '.md');
  });

  it('is byte-stable for the same input', () => {
    expect(buildRaceDebriefPrompt(input())).toBe(buildRaceDebriefPrompt(input()));
  });
});

describe('parseRaceDebriefText', () => {
  it('splits the narrative and three takeaways', () => {
    const text = parseRaceDebriefText(GOOD, FACTS);
    expect(text?.narrative).toContain('positive');
    expect(text?.takeaways).toHaveLength(3);
    expect(text?.takeaways[0]).toBe('Start the bike closer to 225 W and keep it there.');
  });

  it.each([
    ['no separator', 'Just text.'],
    ['two takeaways', 'Ok.\n---\n- one\n- two'],
    ['four takeaways', 'Ok.\n---\n- a\n- b\n- c\n- d'],
    ['a takeaway without a bullet', 'Ok.\n---\n- a\n- b\nc'],
    ['an invented number', 'NP was 250 W.\n---\n- a\n- b\n- c'],
    ['an empty narrative', '\n---\n- a\n- b\n- c'],
  ])('rejects %s', (_name, raw) => {
    expect(parseRaceDebriefText(raw, FACTS)).toBeNull();
  });
});

describe('runRaceDebrief', () => {
  it('uses the LLM text when it is valid', async () => {
    const provider = new MockProvider({ respond: () => GOOD });
    const result = await runRaceDebrief({ provider }, input());
    expect(result.fallbackReason).toBeNull();
    expect(result.text.takeaways).toHaveLength(3);
  });

  it('falls back on an invalid reply', async () => {
    const provider = new MockProvider({ respond: () => 'NP was 999 W.\n---\n- a\n- b\n- c' });
    const result = await runRaceDebrief({ provider }, input());
    expect(result.fallbackReason).toBe('invalid_output');
    expect(result.text).toEqual(FALLBACK_DEBRIEF_TEXT);
  });

  it('falls back when the LLM is down', async () => {
    const provider = new MockProvider({
      respond: () => {
        throw new Error('boom');
      },
    });
    const result = await runRaceDebrief({ provider }, input());
    expect(result.fallbackReason).toBe('llm_unavailable');
    expect(result.error).toContain('boom');
  });
});
