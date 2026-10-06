import { format, parseISO } from 'date-fns';
import { formatMinutes, sportIcon, weekdayShort } from '../plan/dates';
import { esc } from '../views/html';
import { renderPage } from '../views/layout';
import type { DayCell, WeekModel } from './load';

function cellLabel(day: DayCell): string {
  const when = format(parseISO(day.date), 'EEEE d MMMM');
  if (day.sessions.length === 0) return when + ': rest';
  const parts = day.sessions.map((s) => s.sport + ' ' + formatMinutes(s.durationMin));
  return when + ': ' + parts.join(', ') + (day.done ? ', done' : '');
}

/** One tappable day: weekday, date, sport icons, total time; opens that day's Today view. */
function renderCell(day: DayCell): string {
  const className = day.isToday ? 'day today' : 'day';
  const current = day.isToday ? ' aria-current="date"' : '';
  const icons = day.sports.map(sportIcon).join('');
  const amount = day.sessions.length === 0 ? 'Rest' : formatMinutes(day.totalMin);
  const done = day.done ? ' ✓' : '';
  return [
    '<a class="' + className + '" href="/today?date=' + day.date + '"' + current,
    ' aria-label="' + esc(cellLabel(day)) + '">',
    '<span class="dow">' + esc(weekdayShort(day.date)) + '</span>',
    '<span>' + esc(format(parseISO(day.date), 'd')) + '</span>',
    '<span class="icons" aria-hidden="true">' + icons + '</span>',
    '<span>' + esc(amount + done) + '</span>',
    '</a>',
  ].join('');
}

function rangeLabel(from: string, to: string): string {
  const start = parseISO(from);
  const end = parseISO(to);
  const sameMonth = format(start, 'MMM') === format(end, 'MMM');
  return sameMonth
    ? format(start, 'd') + '–' + format(end, 'd MMM')
    : format(start, 'd MMM') + ' – ' + format(end, 'd MMM');
}

export function renderWeek(model: WeekModel, csrf: string): string {
  const nav = { current: 'week' as const, csrf };
  if (model.kind === 'no_profile') {
    const body =
      '<div class="card"><h1>Welcome</h1><p>Send <strong>/start</strong> to the coach bot to set up your profile.</p></div>';
    return renderPage({ title: 'Week', body, nav });
  }
  const weekNo = model.key.slice(model.key.indexOf('W') + 1);
  const heading =
    'Week ' + String(Number(weekNo)) + ' · ' + rangeLabel(model.range.from, model.range.to);
  const isCurrent = model.today >= model.range.from && model.today <= model.range.to;
  const pager = [
    '<nav class="pager" aria-label="Weeks">',
    '<a href="/week?week=' + model.previous + '">← Previous</a>',
    isCurrent ? '' : '<a href="/week">This week</a>',
    '<a href="/week?week=' + model.next + '">Next →</a>',
    '</nav>',
  ].join('');
  const body = [
    '<h1>' + esc(heading) + '</h1>',
    '<div class="week">' + model.days.map(renderCell).join('') + '</div>',
    '<p class="muted">Planned: ' + esc(formatMinutes(model.totalMin)) + '</p>',
    pager,
  ].join('\n');
  return renderPage({ title: 'Week', body, nav });
}
