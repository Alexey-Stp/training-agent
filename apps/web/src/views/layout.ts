import { esc } from './html';
import { STYLESHEET_HASH, STYLESHEET_PATH } from './style';

export type NavItem = 'today' | 'week' | 'settings';

export interface PageOptions {
  title: string;
  body: string;
  /** Signed-in pages show the nav and the sign-out form (needs the session's CSRF token) */
  nav?: { current: NavItem | null; csrf: string };
}

const NAV_LINKS: readonly { item: NavItem; href: string; label: string }[] = [
  { item: 'today', href: '/', label: 'Today' },
  { item: 'week', href: '/week', label: 'Week' },
  { item: 'settings', href: '/settings', label: 'Settings' },
];

/** Hidden CSRF field for every signed-in POST form */
export function csrfField(csrf: string): string {
  return '<input type="hidden" name="csrf" value="' + esc(csrf) + '">';
}

function renderNav(current: NavItem | null, csrf: string): string {
  const links = NAV_LINKS.map((link) => {
    const active = link.item === current ? ' aria-current="page"' : '';
    return '<a href="' + link.href + '"' + active + '>' + link.label + '</a>';
  });
  const signOut = [
    '<form method="post" action="/logout">',
    csrfField(csrf),
    '<button class="link" type="submit" aria-label="Sign out">⏻</button>',
    '</form>',
  ].join('');
  return '<header><nav>' + links.join('') + signOut + '</nav></header>';
}

/** Full HTML document: viewport meta, the hashed stylesheet, no scripts. */
export function renderPage(options: PageOptions): string {
  const cssHref = STYLESHEET_PATH + '?v=' + STYLESHEET_HASH;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<title>' + esc(options.title) + ' · Triathlon Coach</title>',
    '<link rel="stylesheet" href="' + cssHref + '">',
    '</head>',
    '<body>',
    options.nav ? renderNav(options.nav.current, options.nav.csrf) : '',
    '<main>',
    options.body,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}
