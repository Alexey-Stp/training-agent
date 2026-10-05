import { performance } from 'node:perf_hooks';
import { UnrecoverableError } from 'bullmq';
import { GrammyError } from 'grammy';
import type { StageTimings } from './run-store';

/** Shared by the morning brief and the evening close-out. */
export interface RunLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface StageCtx {
  userId: string;
  date: string;
  timings: StageTimings;
  logger: RunLogger;
}

/**
 * Runs one stage, recording how long it took in `ctx.timings` and logging it as `msg` with
 * whether it failed.
 */
export async function timedStage<T>(
  ctx: StageCtx,
  msg: string,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  let outcome = 'ok';
  try {
    return await fn();
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    const ms = Math.round(performance.now() - start);
    ctx.timings[name] = ms;
    ctx.logger.info({ userId: ctx.userId, date: ctx.date, stage: name, ms, outcome }, msg);
  }
}

/** Telegram won't ever take this message: the bot is blocked or the chat is gone. */
function isPermanentSendError(error: unknown): boolean {
  return error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.name + ': ' + error.message : String(error);
}

/** A send Telegram will never accept fails the job without retries. */
export async function sendOrFail<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (isPermanentSendError(error)) throw new UnrecoverableError(errorText(error));
    throw error;
  }
}
