const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function esc(value: string | number): string {
  return String(value).replaceAll(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** `<tag class="…">children</tag>`; children are already-safe HTML. */
export function tag(name: string, className: string | null, children: string): string {
  const open = className ? '<' + name + ' class="' + esc(className) + '">' : '<' + name + '>';
  return open + children + '</' + name + '>';
}
