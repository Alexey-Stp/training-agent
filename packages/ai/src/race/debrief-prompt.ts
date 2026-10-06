import { loadPromptTemplate, renderTemplate } from '../context/template';

export const RACE_DEBRIEF_PROMPT_VERSION = 'race-debrief-v1';

export type RaceDebriefDataTier = 'power' | 'hr' | 'none';

export interface RaceDebriefPromptInput {
  raceName: string;
  raceType: string;
  priority: string;
  tier: RaceDebriefDataTier;
  /** Deterministic metrics, pre-rendered as plain text lines */
  facts: string;
  /** One line on the recovery block that follows the race, or an empty string */
  recoveryNote: string;
}

const DATA_NOTES: Record<RaceDebriefDataTier, string> = {
  power: 'power, heart rate and speed streams',
  hr: 'heart rate and speed streams, no power',
  none: 'whole-activity averages only, no streams',
};

export function renderRaceDebriefSections(input: RaceDebriefPromptInput): Record<string, string> {
  return {
    raceName: input.raceName,
    raceType: input.raceType,
    priority: input.priority,
    dataNote: DATA_NOTES[input.tier],
    facts: input.facts,
    recoveryNote: input.recoveryNote || 'No recovery plan was set.',
  };
}

export function buildRaceDebriefPrompt(input: RaceDebriefPromptInput): string {
  return renderTemplate(
    loadPromptTemplate(RACE_DEBRIEF_PROMPT_VERSION),
    renderRaceDebriefSections(input)
  );
}
