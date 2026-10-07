import { describe, expect, it } from 'vitest';
import { validateSettings, type FormBody } from '../src/settings/validate';

const VALID: FormBody = {
  ftp: '280',
  lthr: '168',
  timezone: 'Europe/Prague',
  briefTime: '06:15',
  closeoutTime: '',
  swimDays: ['Fri', 'Tue'],
  swimOptional: 'Sun',
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sat',
  noLongRunDay: 'Sat',
  notifyChatId: '',
};

describe('validateSettings', () => {
  it('accepts a full form and normalizes it', () => {
    const result = validateSettings(VALID);
    expect(result).toEqual({
      ok: true,
      value: {
        ftp: 280,
        lthr: 168,
        timezone: 'Europe/Prague',
        briefTime: '06:15',
        closeoutTime: null,
        swimDays: ['Tue', 'Fri', 'Sun_optional'],
        bikeVo2Day: 'Thu',
        longBikeDay: 'Sat',
        noLongRunDay: 'Sat',
        notifyChatId: null,
      },
    });
  });

  it('accepts optional fields left empty and a single swim day', () => {
    const result = validateSettings({ ...VALID, lthr: '', swimDays: 'Wed', swimOptional: '' });
    expect(result.ok && result.value).toMatchObject({ lthr: null, swimDays: ['Wed'] });
  });

  it('accepts a channel id', () => {
    const result = validateSettings({ ...VALID, notifyChatId: '-1001234567890' });
    expect(result.ok && result.value.notifyChatId).toBe('-1001234567890');
  });

  it.each([
    ['ftp', { ftp: '49' }],
    ['ftp', { ftp: '601' }],
    ['ftp', { ftp: '250.5' }],
    ['ftp', { ftp: '' }],
    ['lthr', { lthr: '99' }],
    ['timezone', { timezone: 'Mars/Olympus' }],
    ['timezone', { timezone: '' }],
    ['briefTime', { briefTime: '6:30' }],
    ['closeoutTime', { closeoutTime: '24:00' }],
    ['swimDays', { swimDays: ['Mon', 'Wed', 'Fri'] }],
    ['swimDays', { swimDays: ['Funday'] }],
    ['swimDays', { swimOptional: 'Fri' }],
    ['bikeVo2Day', { bikeVo2Day: 'thu' }],
    ['longBikeDay', { longBikeDay: '' }],
    ['notifyChatId', { notifyChatId: '@mychannel' }],
    ['notifyChatId', { notifyChatId: '12345678901234567' }],
  ])('rejects an invalid %s', (field, patch) => {
    const result = validateSettings({ ...VALID, ...patch });
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors)).toEqual([field]);
  });

  it('reports every invalid field at once', () => {
    const result = validateSettings({ ...VALID, ftp: 'x', timezone: 'nope', briefTime: 'x' });
    expect(!result.ok && Object.keys(result.errors).sort((a, b) => a.localeCompare(b))).toEqual([
      'briefTime',
      'ftp',
      'timezone',
    ]);
  });
});
