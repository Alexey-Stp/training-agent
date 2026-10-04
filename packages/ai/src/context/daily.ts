import { fitToBudget } from './budget';
import { collectDailyData, type DailyData } from './collect';
import { renderDailySections } from './render';
import { seasonPosition } from './season';
import { loadPromptTemplate, renderTemplate } from './template';
import {
  compliance,
  hrvBaseline,
  missedKeySessions,
  powerZones,
  trainingHistory,
  trainingLoad,
  wellnessTrend,
} from './trends';
import type { CoachContext, DailyContextDeps } from './types';

/** Template file (src/prompts/<version>.md) and the `promptVersion` logged with the LLM call */
export const DAILY_PROMPT_VERSION = 'daily-v1';
/** Default budget; the worker passes `AI_CONTEXT_TOKEN_BUDGET` */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 6000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface BuildDailyContextOptions {
  tokenBudget?: number;
  /** Template text instead of the bundled `daily-v1.md` (tests) */
  template?: string;
}

export interface DailyContextResult {
  context: CoachContext;
  prompt: string;
  promptVersion: string;
}

/** Pure part of the builder: the context for `date` from data already read. */
export function assembleDailyContext(data: DailyData, date: string): CoachContext {
  const today = data.wellness.find((w) => w.date === date) ?? null;
  const upcoming = data.planned.filter((s) => s.date >= date);
  return {
    date,
    athlete: { profile: data.profile, zones: powerZones(data.profile.ftp) },
    season: seasonPosition(data.season, date),
    wellness: {
      today,
      trend: wellnessTrend(data.wellness, date),
      hrv: hrvBaseline(data.wellness, date),
      load: trainingLoad(data.wellness, date),
    },
    compliance: compliance(data.planned, data.activities, date),
    missedKeySessions: missedKeySessions(data.planned, data.activities, date),
    upcoming,
    externallyModified: data.planned.filter((s) => s.status === 'modified_externally'),
    decisions: data.decisions,
    races: data.races,
    history: trainingHistory(data.planned, data.activities, date),
    truncation: {
      budgetTokens: 0,
      estimatedTokens: 0,
      historyDaysOmitted: 0,
      decisionsOmitted: 0,
      trendDaysOmitted: 0,
      overBudget: false,
    },
  };
}

/**
 * Builds the daily coaching context for `date` (athlete-local yyyy-MM-dd) and renders the
 * `daily-v1` prompt within the token budget. `date` is the only clock, so the same data
 * always gives a byte-identical prompt.
 */
export async function buildDailyContext(
  deps: DailyContextDeps,
  userId: string,
  date: string,
  options: BuildDailyContextOptions = {}
): Promise<DailyContextResult> {
  if (!ISO_DATE.test(date)) throw new RangeError(`date must be yyyy-MM-dd, got ${date}`);
  const data = await collectDailyData(deps, userId, date);
  const template = options.template ?? loadPromptTemplate(DAILY_PROMPT_VERSION);
  const { context, prompt } = fitToBudget(
    assembleDailyContext(data, date),
    (ctx) => renderTemplate(template, renderDailySections(ctx)),
    options.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET
  );
  return { context, prompt, promptVersion: DAILY_PROMPT_VERSION };
}
