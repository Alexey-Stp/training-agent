import { addDaysIso, SEASON_NEW_START_PAYLOAD } from '@triathlon/core';
import { dayLabel, formatMinutes, sportIcon } from '../plan/dates';
import type { DaySession } from '../plan/read-store';
import { stepLine } from '../plan/steps';
import { esc, tag } from '../views/html';
import { renderPage } from '../views/layout';
import type { TodayModel } from './load';

export interface TodayViewOptions {
  csrf: string;
  /** TELEGRAM_BOT_USERNAME, for the season wizard deep link */
  botUsername?: string;
}

function badge(className: string, text: string, title?: string): string {
  const titleAttr = title ? ' title="' + esc(title) + '"' : '';
  return '<span class="badge ' + className + '"' + titleAttr + '>' + esc(text) + '</span>';
}

/** Status badges: completed / missed, and the ICU edit badge (the athlete's version wins). */
export function statusBadges(session: DaySession): string {
  switch (session.status) {
    case 'completed':
      return badge('ok', 'Completed');
    case 'skipped':
      return badge('bad', 'Missed');
    case 'modified_externally':
      return badge('warn', 'edited in intervals.icu', session.externalChange ?? undefined);
    default:
      return '';
  }
}

function renderSteps(session: DaySession): string {
  if (!session.steps || session.steps.length === 0) {
    return '<p class="muted">No interval detail for this session.</p>';
  }
  const items = session.steps.map((block) => {
    const line = stepLine(block);
    return '<li>' + esc(line.label) + ' <span class="zone">' + esc(line.detail) + '</span></li>';
  });
  return '<ol class="steps">' + items.join('') + '</ol>';
}

function timeLabel(date: string, today: string): string {
  return date === today ? 'Any time today' : 'Any time';
}

function renderSession(session: DaySession, date: string, today: string): string {
  const meta = [
    '<span>🕒 ' + esc(timeLabel(date, today)) + '</span>',
    '<span>⏱ ' + esc(formatMinutes(session.durationMin)) + '</span>',
    '<span>' + esc(session.intensity.toUpperCase()) + '</span>',
  ];
  const notes = session.description
    ? '<p class="muted">💡 ' + esc(session.description) + '</p>'
    : '';
  return [
    '<article class="card">',
    tag('h2', null, esc(sportIcon(session.sport) + ' ' + session.title)),
    statusBadges(session),
    tag('div', 'meta', meta.join('')),
    renderSteps(session),
    notes,
    '</article>',
  ].join('\n');
}

function seasonLink(botUsername: string | undefined): string {
  if (!botUsername)
    return '<p>Send <strong>/season new</strong> to the coach bot to build one.</p>';
  const href =
    'https://t.me/' +
    encodeURIComponent(botUsername) +
    '?start=' +
    encodeURIComponent(SEASON_NEW_START_PAYLOAD);
  return '<p><a href="' + esc(href) + '">Set up your season in Telegram →</a></p>';
}

function renderDayNav(date: string, today: string): string {
  const prev =
    '<a href="/today?date=' +
    addDaysIso(date, -1) +
    '">← ' +
    esc(dayLabel(addDaysIso(date, -1))) +
    '</a>';
  const next =
    '<a href="/today?date=' +
    addDaysIso(date, 1) +
    '">' +
    esc(dayLabel(addDaysIso(date, 1))) +
    ' →</a>';
  const middle = date === today ? '' : '<a href="/">Today</a>';
  return '<nav class="pager" aria-label="Days">' + prev + middle + next + '</nav>';
}

function renderBody(
  model: Exclude<TodayModel, { kind: 'no_profile' }>,
  options: TodayViewOptions
): string {
  switch (model.kind) {
    case 'sessions':
      return model.sessions.map((s) => renderSession(s, model.date, model.today)).join('\n');
    case 'rest':
      return '<div class="card"><h2>😴 Rest day</h2><p class="muted">Nothing planned. Recover well.</p></div>';
    case 'no_plan':
      return [
        '<div class="card">',
        '<h2>No plan yet</h2>',
        '<p class="muted">There is no training plan for you yet.</p>',
        seasonLink(options.botUsername),
        '</div>',
      ].join('\n');
  }
}

export function renderToday(model: TodayModel, options: TodayViewOptions): string {
  const nav = { current: 'today' as const, csrf: options.csrf };
  if (model.kind === 'no_profile') {
    const body =
      '<div class="card"><h1>Welcome</h1><p>Send <strong>/start</strong> to the coach bot to set up your profile.</p></div>';
    return renderPage({ title: 'Today', body, nav });
  }
  const heading =
    model.date === model.today ? 'Today · ' + dayLabel(model.date) : dayLabel(model.date);
  const body = [
    '<h1>' + esc(heading) + '</h1>',
    renderBody(model, options),
    renderDayNav(model.date, model.today),
  ].join('\n');
  return renderPage({
    title: model.date === model.today ? 'Today' : dayLabel(model.date),
    body,
    nav,
  });
}
