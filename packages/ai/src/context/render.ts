import { addDaysIso, type Race } from '@triathlon/core';
import {
  datesInRange,
  daysBetween,
  HRV_BASELINE_DAYS,
  HRV_MIN_SAMPLES,
  UPCOMING_DAYS,
} from './trends';
import type {
  ActivitySummary,
  CoachContext,
  CoachDecision,
  HistoryDay,
  HrvBaseline,
  PlannedSessionSummary,
  SportCompliance,
  TrainingLoad,
  WellnessDay,
} from './types';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NO_DEVICE_DATA = 'no device data';

/** `value` with fixed decimals, or 'n/a'. Fixed precision keeps the prompt byte-stable. */
function num(value: number | null, digits = 0): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function signed(value: number | null, digits = 1): string {
  if (value === null) return 'n/a';
  return value > 0 ? '+' + value.toFixed(digits) : value.toFixed(digits);
}

function weekday(date: string): string {
  return WEEKDAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
}

function dayLabel(date: string): string {
  return date + ' ' + weekday(date);
}

function omitted(count: number, what: string): string[] {
  return count > 0 ? [`(${count.toString()} older ${what} omitted for the token budget)`] : [];
}

function sessionText(s: PlannedSessionSummary): string {
  const zone = s.intensity.toUpperCase();
  return `${s.sport} ${s.durationMin.toString()} min ${zone} "${s.title}" [${s.status}]`;
}

function activityText(a: ActivitySummary): string {
  const minutes = Math.round(a.durationSec / 60).toString();
  const load = a.load === null ? '' : ', load ' + a.load.toString();
  return `${a.sport} ${minutes} min "${a.name}"${load}`;
}

export function renderAthlete(ctx: CoachContext): string {
  const p = ctx.athlete.profile;
  const zones = ctx.athlete.zones.map((z) => {
    const range =
      z.maxWatts === null
        ? `≥${z.minWatts.toString()}`
        : `${z.minWatts.toString()}–${z.maxWatts.toString()}`;
    return `- ${z.zone.toUpperCase()} ${z.label}: ${range} W`;
  });
  return [
    `FTP: ${p.ftp.toString()} W. Timezone: ${p.timezone}.`,
    `Swim days: ${p.swimDays.join(', ')}. VO2 bike day: ${p.bikeVo2Day}. Long bike day: ${p.longBikeDay}. No long run on: ${p.noLongRunDay}.`,
    'Power zones:',
    ...zones,
  ].join('\n');
}

function aRaceLine(ctx: CoachContext): string {
  const season = ctx.season;
  if (!season?.aRace || season.daysToARace === null) return 'No A-race set.';
  const race = `${season.aRace.name} (${season.aRace.type}) on ${season.aRace.date}`;
  const days = season.daysToARace;
  if (days < 0) return `A-race: ${race}, ${(-days).toString()} days ago.`;
  return `A-race: ${race}, in ${days.toString()} days.`;
}

export function renderSeason(ctx: CoachContext): string {
  const season = ctx.season;
  if (!season) return 'No active season.';
  const span = `${season.seasonStart} → ${season.seasonEnd}`;
  const lines: string[] = [];
  if (season.block && season.seasonWeek !== null) {
    const b = season.block;
    lines.push(
      `Block ${b.order.toString()} of ${b.count.toString()}: ${b.type} (focus: ${b.focus}), week ${b.week.toString()} of ${b.weeks.toString()}.`,
      `Season week ${season.seasonWeek.toString()} of ${season.seasonWeeks.toString()} (${span}).`
    );
  } else {
    lines.push(`Today is outside the season's blocks (season runs ${span}).`);
  }
  lines.push(aRaceLine(ctx));
  return lines.join('\n');
}

function hasDeviceData(day: WellnessDay): boolean {
  return [day.hrv, day.restingHr, day.sleepHours, day.sleepScore, day.tsb].some((v) => v !== null);
}

function todayLines(today: WellnessDay | null, date: string): string[] {
  const device =
    today && hasDeviceData(today)
      ? `Today: HRV ${num(today.hrv)} ms, resting HR ${num(today.restingHr)} bpm, sleep ${num(today.sleepHours, 1)} h (score ${num(today.sleepScore)}).`
      : `Today: ${NO_DEVICE_DATA} for ${date}.`;
  const readiness = today?.subjectiveReadiness ?? null;
  const soreness = today?.soreness ?? null;
  const checkIn =
    readiness === null && soreness === null
      ? 'Check-in: none today.'
      : `Check-in: readiness ${num(readiness)}/5, soreness ${num(soreness)}.`;
  return [device, checkIn];
}

function hrvLine(hrv: HrvBaseline): string {
  if (hrv.status === 'insufficient' || hrv.mean === null || hrv.sd === null) {
    return `HRV baseline: not enough data (${hrv.samples.toString()} of ${HRV_MIN_SAMPLES.toString()} needed readings in the last ${HRV_BASELINE_DAYS.toString()} days).`;
  }
  const base = `HRV baseline (${HRV_BASELINE_DAYS.toString()} d): mean ${num(hrv.mean, 1)} ± ${num(hrv.sd, 1)} ms (n=${hrv.samples.toString()})`;
  if (hrv.today === null) return base + '; no HRV reading today.';
  const verdict = hrv.low ? 'LOW, below mean − 1 SD' : 'within range';
  return `${base}; today ${num(hrv.today)} ms, ${verdict}.`;
}

function loadLine(load: TrainingLoad | null): string {
  if (!load) return `Training load (CTL/ATL/TSB): ${NO_DEVICE_DATA}.`;
  const stale = load.daysOld > 0 ? ` (latest data, ${load.daysOld.toString()} days old)` : '';
  return `Training load on ${load.date}${stale}: CTL ${num(load.ctl, 1)}, ATL ${num(load.atl, 1)}, TSB ${signed(load.tsb)}.`;
}

function trendLines(ctx: CoachContext): string[] {
  const { trend } = ctx.wellness;
  const omittedNote = omitted(ctx.truncation.trendDaysOmitted, 'days');
  if (!trend.days.some(hasDeviceData))
    return ['Last 7 days: ' + NO_DEVICE_DATA + '.', ...omittedNote];
  const rows = trend.days.map(
    (d) =>
      `| ${d.date} | ${num(d.hrv)} | ${num(d.restingHr)} | ${num(d.sleepHours, 1)} | ${signed(d.tsb)} |`
  );
  return [
    'Last 7 days (oldest first):',
    ...omittedNote,
    '| Date | HRV ms | RHR bpm | Sleep h | TSB |',
    '|---|---|---|---|---|',
    ...rows,
    `7-day averages: HRV ${num(trend.avgHrv, 1)} ms, RHR ${num(trend.avgRestingHr, 1)} bpm, sleep ${num(trend.avgSleepHours, 1)} h.`,
  ];
}

export function renderWellness(ctx: CoachContext): string {
  const w = ctx.wellness;
  return [
    ...todayLines(w.today, ctx.date),
    hrvLine(w.hrv),
    loadLine(w.load),
    '',
    ...trendLines(ctx),
  ].join('\n');
}

function complianceLine(label: string, c: Omit<SportCompliance, 'sport'>): string {
  const share = c.pct === null ? 'nothing planned' : c.pct.toString() + '%';
  return `- ${label}: ${c.actualMin.toString()} of ${c.plannedMin.toString()} planned min (${share})`;
}

export function renderCompliance(ctx: CoachContext): string {
  const c = ctx.compliance;
  if (c.bySport.length === 0) return `No sessions planned or done ${c.from} → ${c.to}.`;
  return [
    `${c.from} → ${c.to}, actual vs planned minutes:`,
    ...c.bySport.map((s) => complianceLine(s.sport, s)),
    complianceLine('total', c.total),
  ].join('\n');
}

export function renderKeySessions(ctx: CoachContext): string {
  if (ctx.missedKeySessions.length === 0) return 'None.';
  return ctx.missedKeySessions.map((s) => `- ${dayLabel(s.date)}: ${sessionText(s)}`).join('\n');
}

export function renderUpcoming(ctx: CoachContext): string {
  const days = datesInRange(ctx.date, addDaysIso(ctx.date, UPCOMING_DAYS));
  return days
    .map((date) => {
      const label = date === ctx.date ? dayLabel(date) + ' (today)' : dayLabel(date);
      const sessions = ctx.upcoming.filter((s) => s.date === date).map(sessionText);
      return `- ${label}: ${sessions.length > 0 ? sessions.join('; ') : 'nothing planned'}`;
    })
    .join('\n');
}

export function renderExternallyModified(ctx: CoachContext): string {
  if (ctx.externallyModified.length === 0) return 'None.';
  return ctx.externallyModified
    .map(
      (s) =>
        `- ${dayLabel(s.date)}: ${sessionText(s)}, ${s.externalChange ?? 'changed in intervals.icu'}`
    )
    .join('\n');
}

function raceLine(race: Race, date: string): string {
  const days = daysBetween(date, race.date);
  return `- ${race.date}: ${race.name}, ${race.priority}-race (${race.type}), in ${days.toString()} days`;
}

export function renderRaces(ctx: CoachContext): string {
  if (ctx.races.length === 0) return 'No upcoming races.';
  return ctx.races.map((r) => raceLine(r, ctx.date)).join('\n');
}

const ANSWERS = new Map<boolean | null, string>([
  [true, 'accepted'],
  [false, 'declined'],
  [null, 'no answer'],
]);

function decisionLine(d: CoachDecision): string {
  return `- ${d.date} ${d.kind}: ${d.summary} (${ANSWERS.get(d.accepted) ?? 'no answer'})`;
}

export function renderDecisions(ctx: CoachContext): string {
  const omittedNote = omitted(ctx.truncation.decisionsOmitted, 'decisions');
  if (ctx.decisions.length === 0 && omittedNote.length === 0) return 'No coach decisions yet.';
  return [...omittedNote, ...ctx.decisions.map(decisionLine)].join('\n');
}

function historyLine(day: HistoryDay): string {
  const planned = day.planned.map(sessionText);
  const actual = day.actual.map(activityText);
  if (planned.length === 0 && actual.length === 0)
    return `- ${dayLabel(day.date)}: nothing planned or done`;
  const plannedText = planned.length > 0 ? planned.join('; ') : 'nothing';
  const actualText = actual.length > 0 ? actual.join('; ') : 'nothing';
  return `- ${dayLabel(day.date)}: planned ${plannedText} | done ${actualText}`;
}

export function renderHistory(ctx: CoachContext): string {
  return [
    ...omitted(ctx.truncation.historyDaysOmitted, 'days'),
    ...ctx.history.map(historyLine),
  ].join('\n');
}

/** Values for every placeholder of the daily template. */
export function renderDailySections(ctx: CoachContext): Record<string, string> {
  return {
    date: dayLabel(ctx.date),
    athlete: renderAthlete(ctx),
    season: renderSeason(ctx),
    wellness: renderWellness(ctx),
    compliance: renderCompliance(ctx),
    keySessions: renderKeySessions(ctx),
    upcoming: renderUpcoming(ctx),
    externallyModified: renderExternallyModified(ctx),
    races: renderRaces(ctx),
    decisions: renderDecisions(ctx),
    history: renderHistory(ctx),
  };
}
