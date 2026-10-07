import { renderPage } from './layout';

/** 401 page for a missing, tampered, expired or used link or session. Never shows athlete data. */
export function renderExpired(): string {
  return renderPage({
    title: 'Link expired',
    body: [
      '<div class="card notice bad">',
      '<h1>Link expired</h1>',
      '<p>This sign-in link is invalid, expired or was already used.</p>',
      '<p>Send <strong>/dashboard</strong> to the coach bot in Telegram to get a new one.</p>',
      '</div>',
    ].join('\n'),
  });
}

export function renderSignedOut(): string {
  return renderPage({
    title: 'Signed out',
    body: [
      '<div class="card">',
      '<h1>Signed out</h1>',
      '<p>Send <strong>/dashboard</strong> to the coach bot when you want to sign in again.</p>',
      '</div>',
    ].join('\n'),
  });
}

export function renderNotFound(): string {
  return renderPage({
    title: 'Not found',
    body: '<div class="card"><h1>Not found</h1><p><a href="/">Back to today</a></p></div>',
  });
}
