import { loadPromptTemplate, renderTemplate } from '../context/template';

export const RACE_BRIEF_PROMPT_VERSION = 'race-brief-v1';

export type RaceBriefPromptKind = 't7' | 't1';

export interface RaceBriefPromptInput {
  kind: RaceBriefPromptKind;
  raceName: string;
  raceType: string;
  priority: string;
  /** Deterministic brief content (numbers, checklist), pre-rendered as plain text */
  facts: string;
  /** One line on recent training, or an empty string */
  recentTrainingNote: string;
}

const KIND_DAYS: Record<RaceBriefPromptKind, string> = { t7: 'one week', t1: 'one day' };

export function renderRaceBriefSections(input: RaceBriefPromptInput): Record<string, string> {
  return {
    raceName: input.raceName,
    raceType: input.raceType,
    priority: input.priority,
    kind: input.kind === 't7' ? 'week-out brief' : 'day-before brief',
    daysToRace: KIND_DAYS[input.kind],
    facts: input.facts,
    recentTrainingNote: input.recentTrainingNote || 'No recent training note.',
  };
}

export function buildRaceBriefPrompt(input: RaceBriefPromptInput): string {
  return renderTemplate(
    loadPromptTemplate(RACE_BRIEF_PROMPT_VERSION),
    renderRaceBriefSections(input)
  );
}
