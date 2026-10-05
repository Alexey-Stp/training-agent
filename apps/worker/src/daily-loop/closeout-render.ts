import { escapeHtml, Sport, type CloseoutNotice } from '@triathlon/core';

export const CLOSEOUT_TITLE = "🌙 <b>Today's close-out</b>";

const ACTIVITY_NOUN: Record<Sport, string> = {
  [Sport.swim]: 'swim',
  [Sport.bike]: 'ride',
  [Sport.run]: 'run',
  [Sport.strength]: 'strength session',
  [Sport.rest]: 'workout',
  [Sport.other]: 'workout',
};

/** `45` → `45 min`, `180` → `3h`, `90` → `1h30`. */
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  if (total < 60) return total + ' min';
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? hours + 'h' : hours + 'h' + String(rest).padStart(2, '0');
}

function noticeLine(notice: CloseoutNotice): string {
  switch (notice.kind) {
    case 'missed_key': {
      const { session } = notice;
      const what = escapeHtml(session.title) + ' (' + formatMinutes(session.durationMin) + ')';
      return what + " didn't happen today. No problem, I'll factor it into the weekly review.";
    }
    case 'deviation': {
      const { session, activity, deviationPct } = notice;
      const direction = deviationPct < 0 ? 'shorter' : 'longer';
      const actual = Math.round(activity.durationSec / 60);
      const numbers = '(' + actual + ' of ' + session.durationMin + ' min)';
      const pct = Math.round(Math.abs(deviationPct));
      const what = escapeHtml(session.title) + ' was ' + pct + '% ' + direction + ' than planned';
      return what + ' ' + numbers + '. Noted for the weekly review.';
    }
    case 'unplanned': {
      const { activity } = notice;
      const duration = formatMinutes(activity.durationSec / 60);
      const what = 'Unplanned ' + ACTIVITY_NOUN[activity.sport] + ' (' + duration + ')';
      return what + ' logged. Flagged for the weekly review.';
    }
  }
}

/** The close-out message (Telegram HTML): one line per notice, no buttons. */
export function renderCloseout(notices: CloseoutNotice[]): string {
  const lines = notices.map((notice) => '• ' + noticeLine(notice));
  return [CLOSEOUT_TITLE, '', ...lines].join('\n');
}
