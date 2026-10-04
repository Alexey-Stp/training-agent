import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PromptTemplateError } from './errors';

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const TEMPLATE_NAME = /^[a-z0-9-]+$/;
const cache = new Map<string, string>();

/**
 * Replaces every `{{name}}` with `vars[name]` in one pass, so values are never re-scanned.
 * Throws on a placeholder without a value and on a value without a placeholder, so a template
 * and the code filling it can't drift apart.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.hasOwn(vars, name)) {
      throw new PromptTemplateError('Unknown placeholder {{' + name + '}}');
    }
    used.add(name);
    return vars[name];
  });
  const unused = Object.keys(vars)
    .filter((name) => !used.has(name))
    .sort((a, b) => a.localeCompare(b));
  if (unused.length > 0) {
    throw new PromptTemplateError('Template has no placeholder for: ' + unused.join(', '));
  }
  return rendered;
}

/**
 * Loads `prompts/<name>.md` (copied next to dist/ at build time). Line endings are normalised
 * to LF so the prompt is byte-identical on every platform.
 */
export function loadPromptTemplate(name: string): string {
  if (!TEMPLATE_NAME.test(name)) throw new PromptTemplateError(`Invalid template name: ${name}`);
  let template = cache.get(name);
  if (template === undefined) {
    const file = join(__dirname, '..', 'prompts', `${name}.md`);
    template = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    cache.set(name, template);
  }
  return template;
}
