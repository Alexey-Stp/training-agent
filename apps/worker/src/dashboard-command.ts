import { signMagicLink } from '@triathlon/core';
import type { Reply } from './reply';

export interface DashboardCommandDeps {
  /** DASHBOARD_BASE_URL; unset turns the command off */
  baseUrl?: string;
  /** DASHBOARD_LINK_SECRET */
  secret?: string;
  /** DASHBOARD_LINK_TTL_MINUTES */
  ttlMinutes: number;
  now: () => Date;
}

export const MSG_DASHBOARD_OFF = '🖥 The web dashboard is not set up on this bot yet.';

/** Absolute `/auth?t=…` URL under the base URL, keeping any base path. */
export function dashboardAuthUrl(baseUrl: string, token: string): string {
  const url = new URL('auth', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  url.searchParams.set('t', token);
  return url.toString();
}

/**
 * `/dashboard`: a one-time sign-in link for the web dashboard, bound to User.id. The link
 * is a button so the token never shows in the chat text.
 */
export function handleDashboard(userId: string, deps: DashboardCommandDeps): Reply {
  if (!deps.baseUrl || !deps.secret) return MSG_DASHBOARD_OFF;
  const { token } = signMagicLink(userId, deps.secret, deps.ttlMinutes, deps.now());
  return {
    text: [
      '🖥 Your training dashboard',
      '',
      'Today, this week and your settings, on your phone.',
      'The link works once and expires in ' + String(deps.ttlMinutes) + ' minutes.',
    ].join('\n'),
    links: [{ text: 'Open dashboard', url: dashboardAuthUrl(deps.baseUrl, token) }],
  };
}
