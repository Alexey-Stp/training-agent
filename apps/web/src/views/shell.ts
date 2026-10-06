import { renderPage } from './layout';

/** Authenticated empty shell (TA-53); the Today view replaces it once the plan views land. */
export function renderShell(csrf: string): string {
  return renderPage({
    title: 'Dashboard',
    nav: { current: 'today', csrf },
    body: '<div class="card"><h1>You are signed in</h1><p class="muted">Your dashboard is ready.</p></div>',
  });
}
