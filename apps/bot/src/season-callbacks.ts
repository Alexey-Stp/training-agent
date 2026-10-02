import {
  parseSeasonDecision,
  SEASON_CANCEL_COMMAND,
  SEASON_CONFIRM_COMMAND,
} from '@triathlon/core';

/** The job a season preview button enqueues, plus the toast shown on the tap. */
export interface DecisionJob {
  commandName: typeof SEASON_CONFIRM_COMMAND | typeof SEASON_CANCEL_COMMAND;
  args: string[];
  toast: string;
}

/** Maps a preview button (`sd:<decision>:<draftId>`) to its job, or null for other data. */
export function routeSeasonDecision(data: string): DecisionJob | null {
  const parsed = parseSeasonDecision(data);
  if (!parsed) return null;
  const { decision, draftId } = parsed;
  switch (decision) {
    case 'save':
      return { commandName: SEASON_CONFIRM_COMMAND, args: [draftId], toast: 'Saving…' };
    case 'replace':
      return {
        commandName: SEASON_CONFIRM_COMMAND,
        args: [draftId, 'replace'],
        toast: 'Replacing your season…',
      };
    case 'cancel':
      return { commandName: SEASON_CANCEL_COMMAND, args: [draftId], toast: 'Cancelled' };
  }
}
