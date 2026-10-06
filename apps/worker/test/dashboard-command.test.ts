import { describe, expect, it } from 'vitest';
import { verifyMagicLink } from '@triathlon/core';
import { dashboardAuthUrl, handleDashboard, MSG_DASHBOARD_OFF } from '../src/dashboard-command';
import { toTelegramMessage, type RichReply } from '../src/reply';

const SECRET = 's'.repeat(32);
const NOW = new Date('2026-10-06T08:00:00Z');

const deps = {
  baseUrl: 'https://coach.example/app',
  secret: SECRET,
  ttlMinutes: 15,
  now: () => NOW,
};

describe('/dashboard', () => {
  it('is off without a base URL or secret', () => {
    expect(handleDashboard('user-1', { ...deps, baseUrl: undefined })).toBe(MSG_DASHBOARD_OFF);
    expect(handleDashboard('user-1', { ...deps, secret: undefined })).toBe(MSG_DASHBOARD_OFF);
  });

  it('sends a URL button with a token for the user', () => {
    const reply = handleDashboard('user-1', deps) as RichReply;
    expect(reply.links).toHaveLength(1);
    const url = new URL(reply.links?.[0].url ?? '');
    expect(url.origin + url.pathname).toBe('https://coach.example/app/auth');
    const result = verifyMagicLink(url.searchParams.get('t'), SECRET, NOW);
    expect(result.ok && result.payload.uid).toBe('user-1');
    expect(reply.text).not.toContain(url.searchParams.get('t'));
  });

  it('renders links as url buttons', () => {
    const reply = handleDashboard('user-1', deps);
    const { options } = toTelegramMessage(reply);
    expect(options.reply_markup?.inline_keyboard[0][0]).toMatchObject({ text: 'Open dashboard' });
    expect(options.reply_markup?.inline_keyboard[0][0]).toHaveProperty('url');
  });

  it('builds the auth URL with or without a trailing slash', () => {
    expect(dashboardAuthUrl('https://a.example', 'x')).toBe('https://a.example/auth?t=x');
    expect(dashboardAuthUrl('https://a.example/', 'x')).toBe('https://a.example/auth?t=x');
  });
});
