import { describe, expect, it } from 'vitest';
import {
  buildRaceBriefPrompt,
  fallbackRaceBriefText,
  MockProvider,
  parseRaceBriefText,
  runRaceBrief,
  type RaceBriefPromptInput,
} from '../../src';

const FACTS = [
  'Bike: 78–82% of FTP = 234–246 W (from FTP 300)',
  'Run: no recent data — race by feel/HR',
  'Fueling: 60–80 g carbs/h',
].join('\n');

function input(kind: 't7' | 't1', raceName = 'Ironman 70.3 Prague'): RaceBriefPromptInput {
  return {
    kind,
    raceName,
    raceType: 'half',
    priority: 'A',
    facts: FACTS,
    recentTrainingNote: 'Last week 9 h, all key sessions done.',
  };
}

describe('race-brief-v1 prompt', () => {
  it.each(['t7', 't1'] as const)('renders the %s brief', async (kind) => {
    const prompt = buildRaceBriefPrompt(input(kind));
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    await expect(prompt).toMatchFileSnapshot('./__snapshots__/race-brief-' + kind + '.md');
  });

  it('is byte-stable for the same input', () => {
    expect(buildRaceBriefPrompt(input('t1'))).toBe(buildRaceBriefPrompt(input('t1')));
  });
});

describe('parseRaceBriefText', () => {
  it('splits intro and outro', () => {
    expect(parseRaceBriefText('You are ready.\n---\nTrust it.', 'Race')).toEqual({
      intro: 'You are ready.',
      outro: 'Trust it.',
    });
  });

  it.each([
    ['no separator', 'Just one paragraph.'],
    ['empty part', 'Intro.\n---\n'],
    ['a digit', 'Hold 240 W.\n---\nGo.'],
  ])('rejects %s', (_name, raw) => {
    expect(parseRaceBriefText(raw, 'Race')).toBeNull();
  });

  it('allows digits that belong to the race name', () => {
    expect(parseRaceBriefText('Enjoy Ironman 70.3.\n---\nGo.', 'Ironman 70.3')).not.toBeNull();
  });
});

describe('runRaceBrief', () => {
  it('uses the LLM text', async () => {
    const provider = new MockProvider({ respond: () => 'Calm week ahead.\n---\nBelieve it.' });
    const result = await runRaceBrief({ provider }, input('t7'));
    expect(result).toEqual({
      text: { intro: 'Calm week ahead.', outro: 'Believe it.' },
      fallbackReason: null,
      error: null,
    });
    expect(provider.calls[0].opts.purpose).toBe('race-brief');
    expect(provider.calls[0].opts.promptVersion).toBe('race-brief-v1');
  });

  it('falls back when the reply contains a number', async () => {
    const provider = new MockProvider({ respond: () => 'Ride at 250 W.\n---\nGo.' });
    const result = await runRaceBrief({ provider }, input('t1'));
    expect(result.fallbackReason).toBe('invalid_output');
    expect(result.text).toEqual(fallbackRaceBriefText('t1'));
  });

  it('falls back when the LLM is down', async () => {
    const provider = new MockProvider({
      respond: () => {
        throw new TypeError('network');
      },
    });
    const result = await runRaceBrief({ provider }, input('t7'));
    expect(result).toEqual({
      text: fallbackRaceBriefText('t7'),
      fallbackReason: 'llm_unavailable',
      error: 'TypeError: network',
    });
  });
});
