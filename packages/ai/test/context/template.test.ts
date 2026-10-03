import { describe, expect, it } from 'vitest';
import {
  assembleDailyContext,
  collectDailyData,
  DAILY_PROMPT_VERSION,
  loadPromptTemplate,
  PromptTemplateError,
  renderDailySections,
  renderTemplate,
} from '../../src';
import { DATE, fakeDeps, freshAthlete, USER_ID } from './fixtures';

describe('renderTemplate', () => {
  it('replaces every placeholder', () => {
    expect(renderTemplate('Hi {{name}}, {{name}}! {{day}}', { name: 'Ann', day: 'Sat' })).toBe(
      'Hi Ann, Ann! Sat'
    );
  });

  it('inserts values literally and never re-scans them', () => {
    expect(renderTemplate('{{a}} {{b}}', { a: '{{b}}', b: '$& $1' })).toBe('{{b}} $& $1');
  });

  it('throws on a placeholder without a value', () => {
    expect(() => renderTemplate('{{a}} {{missing}}', { a: 'x' })).toThrow(PromptTemplateError);
  });

  it('throws on a value without a placeholder', () => {
    expect(() => renderTemplate('{{a}}', { a: 'x', extra: 'y' })).toThrow(/extra/);
  });
});

describe('loadPromptTemplate', () => {
  it('loads daily-v1 with LF line endings and a placeholder for every section', async () => {
    const template = loadPromptTemplate(DAILY_PROMPT_VERSION);
    expect(template).not.toContain('\r');

    const data = await collectDailyData(fakeDeps(freshAthlete()), USER_ID, DATE);
    const sections = renderDailySections(assembleDailyContext(data, DATE));
    expect(() => renderTemplate(template, sections)).not.toThrow();
  });

  it('rejects names that could leave the prompts directory', () => {
    expect(() => loadPromptTemplate('../package')).toThrow(PromptTemplateError);
  });
});
