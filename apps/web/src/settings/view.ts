import { OPTIONAL_SWIM_SUFFIX, PROFILE_WEEKDAYS } from '@triathlon/core';
import { esc } from '../views/html';
import { csrfField, renderPage } from '../views/layout';
import type { SettingsView } from './store';
import type { FormBody, SettingsField } from './validate';

/** Form state as strings: the stored settings, or what the athlete just submitted. */
export interface SettingsForm {
  ftp: string;
  lthr: string;
  timezone: string;
  briefTime: string;
  closeoutTime: string;
  swimDays: string[];
  swimOptional: string;
  bikeVo2Day: string;
  longBikeDay: string;
  noLongRunDay: string;
  notifyChatId: string;
}

export type SettingsNotice = 'saved' | null;

export function formFromSettings(s: SettingsView): SettingsForm {
  const optional = s.swimDays.find((d) => d.endsWith(OPTIONAL_SWIM_SUFFIX));
  return {
    ftp: String(s.ftp),
    lthr: s.lthr === null ? '' : String(s.lthr),
    timezone: s.timezone,
    briefTime: s.briefTime ?? '',
    closeoutTime: s.closeoutTime ?? '',
    swimDays: s.swimDays.filter((d) => !d.endsWith(OPTIONAL_SWIM_SUFFIX)),
    swimOptional: optional ? optional.slice(0, -OPTIONAL_SWIM_SUFFIX.length) : '',
    bikeVo2Day: s.bikeVo2Day,
    longBikeDay: s.longBikeDay,
    noLongRunDay: s.noLongRunDay,
    notifyChatId: s.notifyChatId ?? '',
  };
}

export function formFromBody(body: FormBody): SettingsForm {
  const one = (key: string): string => {
    const v = body[key];
    return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  };
  const swim = body.swimDays;
  return {
    ftp: one('ftp'),
    lthr: one('lthr'),
    timezone: one('timezone'),
    briefTime: one('briefTime'),
    closeoutTime: one('closeoutTime'),
    swimDays: Array.isArray(swim) ? swim : [swim ?? ''].filter(Boolean),
    swimOptional: one('swimOptional'),
    bikeVo2Day: one('bikeVo2Day'),
    longBikeDay: one('longBikeDay'),
    noLongRunDay: one('noLongRunDay'),
    notifyChatId: one('notifyChatId'),
  };
}

type Errors = Partial<Record<SettingsField, string>>;

function errorLine(errors: Errors, field: SettingsField): string {
  const message = errors[field];
  return message ? '<p class="error" id="' + field + '-error">' + esc(message) + '</p>' : '';
}

function described(errors: Errors, field: SettingsField): string {
  return errors[field] ? ' aria-invalid="true" aria-describedby="' + field + '-error"' : '';
}

function option(value: string, label: string, selected: string): string {
  const attr = value === selected ? ' selected' : '';
  return '<option value="' + esc(value) + '"' + attr + '>' + esc(label) + '</option>';
}

function input(
  field: SettingsField,
  label: string,
  value: string,
  errors: Errors,
  attrs: string
): string {
  return [
    '<label for="' + field + '">' + label + '</label>',
    '<input id="' +
      field +
      '" name="' +
      field +
      '" value="' +
      esc(value) +
      '" ' +
      attrs +
      described(errors, field) +
      '>',
    errorLine(errors, field),
  ].join('');
}

function daySelect(field: SettingsField, label: string, value: string, errors: Errors): string {
  const options = PROFILE_WEEKDAYS.map((d) => option(d, d, value));
  return [
    '<label for="' + field + '">' + label + '</label>',
    '<select id="' +
      field +
      '" name="' +
      field +
      '"' +
      described(errors, field) +
      '>' +
      options.join('') +
      '</select>',
    errorLine(errors, field),
  ].join('');
}

function timezoneSelect(value: string, errors: Errors): string {
  const zones = Intl.supportedValuesOf('timeZone');
  const list = zones.includes(value) || !value ? zones : [value, ...zones];
  const options = list.map((tz) => option(tz, tz, value));
  return [
    '<label for="timezone">Timezone</label>',
    '<select id="timezone" name="timezone"' +
      described(errors, 'timezone') +
      '>' +
      options.join('') +
      '</select>',
    errorLine(errors, 'timezone'),
  ].join('');
}

function swimFieldset(form: SettingsForm, errors: Errors): string {
  const chosen = new Set(form.swimDays);
  const boxes = PROFILE_WEEKDAYS.map((d) => {
    const checked = chosen.has(d) ? ' checked' : '';
    return (
      '<label><input type="checkbox" name="swimDays" value="' +
      d +
      '"' +
      checked +
      '>' +
      d +
      '</label>'
    );
  });
  const optional = [
    option('', 'None', form.swimOptional),
    ...PROFILE_WEEKDAYS.map((d) => option(d, d, form.swimOptional)),
  ];
  return [
    '<fieldset' + described(errors, 'swimDays') + '>',
    '<legend>Swim days (up to two)</legend>',
    '<div class="days">' + boxes.join('') + '</div>',
    '<label for="swimOptional">Optional swim day</label>',
    '<select id="swimOptional" name="swimOptional">' + optional.join('') + '</select>',
    errorLine(errors, 'swimDays'),
    '</fieldset>',
  ].join('');
}

function notice(kind: SettingsNotice, hasErrors: boolean): string {
  if (hasErrors) {
    return '<div class="card notice bad" role="alert">Some settings need a fix. Nothing was saved.</div>';
  }
  if (kind === 'saved') {
    return '<div class="card notice" role="status">✅ Settings saved. The bot uses them from its next message.</div>';
  }
  return '';
}

export function renderSettings(options: {
  csrf: string;
  form: SettingsForm;
  telegramId: string;
  errors?: Errors;
  notice?: SettingsNotice;
}): string {
  const { csrf, form, telegramId } = options;
  const errors = options.errors ?? {};
  const chatHelp =
    'Empty: your private chat with the bot (id ' +
    esc(telegramId) +
    '). For a group or channel, add the bot there first (as an admin in a channel); a test message is sent when you save.';
  const body = [
    '<h1>Settings</h1>',
    notice(options.notice ?? null, Object.keys(errors).length > 0),
    '<form method="post" action="/settings" novalidate>',
    csrfField(csrf),
    '<div class="card"><h2>Training</h2>',
    input(
      'ftp',
      'FTP (W)',
      form.ftp,
      errors,
      'type="number" inputmode="numeric" min="50" max="600" required'
    ),
    input(
      'lthr',
      'Threshold heart rate (bpm, optional)',
      form.lthr,
      errors,
      'type="number" inputmode="numeric" min="100" max="220"'
    ),
    swimFieldset(form, errors),
    daySelect('bikeVo2Day', 'Bike VO2 day', form.bikeVo2Day, errors),
    daySelect('longBikeDay', 'Long bike day', form.longBikeDay, errors),
    daySelect('noLongRunDay', 'No long run on', form.noLongRunDay, errors),
    '</div>',
    '<div class="card"><h2>Schedule</h2>',
    timezoneSelect(form.timezone, errors),
    input(
      'briefTime',
      'Morning brief time (empty: default)',
      form.briefTime,
      errors,
      'type="time"'
    ),
    input(
      'closeoutTime',
      'Evening close-out time (empty: default)',
      form.closeoutTime,
      errors,
      'type="time"'
    ),
    '</div>',
    '<div class="card"><h2>Telegram</h2>',
    input(
      'notifyChatId',
      'Chat for briefs and reviews',
      form.notifyChatId,
      errors,
      'inputmode="numeric" autocomplete="off"'
    ),
    '<p class="muted">' + chatHelp + '</p>',
    '</div>',
    '<button type="submit">Save settings</button>',
    '</form>',
  ].join('\n');
  return renderPage({ title: 'Settings', body, nav: { current: 'settings', csrf } });
}
