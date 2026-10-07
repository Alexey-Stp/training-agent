import { createHash } from 'node:crypto';

/**
 * The one stylesheet: mobile-first (~390px), system fonts, no web fonts or images, light and
 * dark. Served from /app.css with a content hash in the URL so it can be cached for a year.
 */
export const STYLESHEET = `
:root{--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#5b6270;--line:#e2e5ea;--accent:#0b5cad;
--ok:#1a7f37;--warn:#8a5a00;--bad:#c4202b;--today:#e7f0fb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#e8eaee;--muted:#a3abb9;
--line:#2a2f38;--accent:#6aaef2;--ok:#4ac26b;--warn:#d4a72c;--bad:#ff7b72;--today:#1b2a3d}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);
font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}
header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);z-index:1}
nav{display:flex;gap:4px;max-width:640px;margin:0 auto;padding:8px 16px;align-items:center}
nav a{flex:1;text-align:center;padding:10px 4px;border-radius:8px;color:var(--muted);
text-decoration:none;font-weight:600}
nav a[aria-current=page]{background:var(--today);color:var(--accent)}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font-size:1.35rem;margin:4px 0 12px}
h2{font-size:1.1rem;margin:0 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 12px}
.muted{color:var(--muted)}
.meta{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--muted);font-size:.95rem;margin:0 0 10px}
.badge{display:inline-block;font-size:.8rem;font-weight:600;padding:2px 8px;border-radius:999px;
border:1px solid currentColor;margin:0 6px 6px 0}
.badge.ok{color:var(--ok)}.badge.warn{color:var(--warn)}.badge.bad{color:var(--bad)}
ol.steps{margin:0;padding-left:1.4rem}
ol.steps li{padding:4px 0;border-bottom:1px solid var(--line)}
ol.steps li:last-child{border-bottom:0}
.zone{font-weight:700}
table{width:100%;border-collapse:collapse;font-size:.95rem}
th,td{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
.week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
.day{display:block;min-height:88px;background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:6px 2px;text-align:center;color:var(--text);text-decoration:none;font-size:.85rem}
.day.today{background:var(--today);border-color:var(--accent)}
.day .dow{display:block;color:var(--muted);font-weight:600}
.day .icons{display:block;font-size:1.05rem;min-height:1.5em}
.pager{display:flex;justify-content:space-between;margin:12px 0}
a{color:var(--accent)}
label{display:block;font-weight:600;margin:12px 0 4px}
input,select{width:100%;font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;
background:var(--bg);color:var(--text)}
fieldset{border:0;padding:0;margin:12px 0 0}
legend{font-weight:600;padding:0}
.days{display:flex;flex-wrap:wrap;gap:6px}
.days label{display:flex;gap:4px;align-items:center;font-weight:400;margin:0;padding:6px 8px;
border:1px solid var(--line);border-radius:8px}
.days input{width:auto}
button{font:inherit;font-weight:600;padding:12px 16px;border:0;border-radius:8px;background:var(--accent);
color:#fff;width:100%;margin-top:16px}
button.link{background:none;color:var(--muted);width:auto;padding:10px 4px;margin:0}
.error{color:var(--bad);font-size:.9rem;margin:4px 0 0}
.notice{border-left:4px solid var(--ok)}
.notice.bad{border-left-color:var(--bad)}
`.trim();

export const STYLESHEET_HASH = createHash('sha256').update(STYLESHEET).digest('hex').slice(0, 12);

export const STYLESHEET_PATH = '/app.css';
