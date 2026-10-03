import type { CoachContext } from './types';

/** Rough token count (≈4 characters per token). Deterministic and needs no tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type TruncationStep = (ctx: CoachContext) => CoachContext | null;

function dropOldestHistoryDay(ctx: CoachContext): CoachContext | null {
  if (ctx.history.length === 0) return null;
  const truncation = {
    ...ctx.truncation,
    historyDaysOmitted: ctx.truncation.historyDaysOmitted + 1,
  };
  return { ...ctx, history: ctx.history.slice(1), truncation };
}

function dropOldestDecision(ctx: CoachContext): CoachContext | null {
  if (ctx.decisions.length === 0) return null;
  const truncation = { ...ctx.truncation, decisionsOmitted: ctx.truncation.decisionsOmitted + 1 };
  return { ...ctx, decisions: ctx.decisions.slice(1), truncation };
}

function dropOldestTrendDay(ctx: CoachContext): CoachContext | null {
  const { trend } = ctx.wellness;
  if (trend.days.length === 0) return null;
  const truncation = { ...ctx.truncation, trendDaysOmitted: ctx.truncation.trendDaysOmitted + 1 };
  const wellness = { ...ctx.wellness, trend: { ...trend, days: trend.days.slice(1) } };
  return { ...ctx, wellness, truncation };
}

/**
 * Truncation order, oldest entries first within each step: training history, then coach
 * decisions, then wellness trend days. Everything else (athlete, season, today's wellness,
 * compliance, missed key sessions, upcoming and externally changed sessions, races) is kept.
 */
const TRUNCATION_STEPS: readonly TruncationStep[] = [
  dropOldestHistoryDay,
  dropOldestDecision,
  dropOldestTrendDay,
];

function truncateOnce(ctx: CoachContext): CoachContext | null {
  for (const step of TRUNCATION_STEPS) {
    const next = step(ctx);
    if (next) return next;
  }
  return null;
}

export interface FittedPrompt {
  context: CoachContext;
  prompt: string;
}

/**
 * Drops the oldest truncatable entry and re-renders until the prompt fits `budgetTokens`.
 * When nothing is left to drop, returns the smallest prompt with `truncation.overBudget` set.
 */
export function fitToBudget(
  context: CoachContext,
  render: (ctx: CoachContext) => string,
  budgetTokens: number
): FittedPrompt {
  let ctx: CoachContext = { ...context, truncation: { ...context.truncation, budgetTokens } };
  let prompt = render(ctx);
  let overBudget = false;
  while (estimateTokens(prompt) > budgetTokens) {
    const next = truncateOnce(ctx);
    if (!next) {
      overBudget = true;
      break;
    }
    ctx = next;
    prompt = render(ctx);
  }
  const truncation = { ...ctx.truncation, estimatedTokens: estimateTokens(prompt), overBudget };
  return { context: { ...ctx, truncation }, prompt };
}
