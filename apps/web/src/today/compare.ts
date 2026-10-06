import type { DaySession, MatchedActivity } from '../plan/read-store';
import { formatMinutes, localTime } from '../plan/dates';
import { esc } from '../views/html';

const NONE = '—';

function signedPct(pct: number): string {
  const rounded = Math.round(pct);
  if (rounded === 0) return '±0%';
  return (rounded > 0 ? '+' : '−') + String(Math.abs(rounded)) + '%';
}

function row(label: string, planned: string, actual: string): string {
  return (
    '<tr><th scope="row">' +
    esc(label) +
    '</th><td>' +
    esc(planned) +
    '</td><td>' +
    esc(actual) +
    '</td></tr>'
  );
}

function optionalRows(activity: MatchedActivity): string[] {
  const rows: string[] = [];
  if (activity.distanceM !== null) {
    rows.push(row('Distance', NONE, (activity.distanceM / 1000).toFixed(1) + ' km'));
  }
  if (activity.avgPower !== null)
    rows.push(row('Avg power', NONE, String(Math.round(activity.avgPower)) + ' W'));
  if (activity.avgHr !== null)
    rows.push(row('Avg HR', NONE, String(Math.round(activity.avgHr)) + ' bpm'));
  return rows;
}

/**
 * Planned vs actual of a session the evening close-out matched: duration (with the stored
 * deviation), zone (the close-out's guess from power or HR, when it had one) and start time.
 */
export function renderComparison(session: DaySession, timezone: string): string {
  const activity = session.activity;
  if (!activity) return '';
  const actualMin = formatMinutes(activity.durationSec / 60);
  const deviation =
    session.deviationPct === null ? '' : ' (' + signedPct(session.deviationPct) + ')';
  const rows = [
    row('Duration', formatMinutes(session.durationMin), actualMin + deviation),
    row('Zone', session.intensity.toUpperCase(), session.actualIntensity?.toUpperCase() ?? NONE),
    row('Start', 'Any time', localTime(activity.startTime, timezone)),
    ...optionalRows(activity),
  ];
  return [
    '<table>',
    '<caption class="muted">Planned vs actual: ' + esc(activity.name) + '</caption>',
    '<thead><tr><th></th><th scope="col">Planned</th><th scope="col">Actual</th></tr></thead>',
    '<tbody>' + rows.join('') + '</tbody>',
    '</table>',
  ].join('');
}
