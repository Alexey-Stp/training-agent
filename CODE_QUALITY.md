# Code Quality Rules

SonarQube scans this repo, including `test/` directories, which ESLint ignores. These rules therefore apply to tests and fakes too. ESLint covers its own set (see `eslint.config.mjs`); the rules below are the Sonar findings that come up most often here.

## Structure

- **Cognitive complexity ≤ 15 per function.** Keep orchestrators flat: move the body of a per-item loop, and any `try`/`catch` inside it, into a named helper that returns an outcome (see `writeSession` / `deleteSession` in `apps/worker/src/plan-push.ts`). Nested `if`/`try`/`continue` inside a loop is what drives the score up.
- **No write-only collections or counters.** If a result is only pushed to and never read, remove it. If a later query already returns that data, rely on the query.
- **Don't silence an unused parameter with `void x;`.** Rename it to `_x`.

## Async

- **No `async` without `await`.** A method that only returns a promise drops the `async` keyword:

  ```ts
  replaceDraft(userId, draft) {
    return prisma.$transaction(async (tx) => { ... });
  }
  ```

- **No `await` inside a loop.** Start independent calls together, then process the results synchronously. `Promise.all` keeps the order:

  ```ts
  const contexts = await Promise.all(weeks.map((w) => getContext(w.start)));
  weeks.forEach((w, i) => expand(w, contexts[i]));
  ```

  See `seasonDraftsForRange` in `packages/core/src/season/window.ts`. Keep a sequential loop only when order matters. An example is the ICU writes in `plan-push.ts`, where each row is saved right after its call so a retry resumes. Say why in a comment.

## Arrays and collections

- **Always pass a compare function to `.sort()`**, e.g. `(a, b) => a.localeCompare(b)`, even for `yyyy-MM-dd` strings.
- **Last element:** use `arr.at(-1)`, not `arr[arr.length - 1]`. Needing the first and last date of rows is common, so reuse `dateRange()` from `apps/worker/src/plan-store.ts`.
- **Last match:** use `arr.findLast(pred)`, not `arr.filter(pred).at(-1)`. `findLast` is ES2023, but the base tsconfig `lib` is ES2022, so add `"ES2023.Array"` to the package's `lib`, as `packages/ai/tsconfig.json` does.
- **Membership checks on a fixed list use a `Set`.** Check with `.has()`, not `array.includes()`:

  ```ts
  const DECISIONS: ReadonlySet<string> = new Set(['save', 'replace', 'cancel']);
  if (!DECISIONS.has(decision)) return null;
  ```

## Expressions and strings

- **Optional chaining:** write `row?.x !== y` instead of `!row || row.x !== y`. TypeScript still narrows `row` after it.
- **Replace all:** use `s.replaceAll('\r\n', '\n')`, not `s.replace(/\r\n/g, '\n')`. Keep a regex only for real patterns, and `replaceAll` with a regex still needs the `g` flag.
  - A regex that only matches fixed text is not a real pattern, even when a character needs escaping. Write `key.replaceAll('|', ' ')`, not `key.replace(/\|/g, ' ')`. The same goes for `/\./g`, `/-/g` and `/\n/g`.
  - `s.replace('|', ' ')` with a string argument replaces only the first match. To replace every match, use `replaceAll`.
- **No nested template literals.** Build the inner part first, then join an array of lines:

  ```ts
  const lines = races.map((r) => '• ' + formatRace(r));
  return ['🏁 Upcoming races', '', ...lines].join('\n');
  ```

## SQL (migrations)

- **No comparisons against boolean literals.** Use the column itself: `WHERE "accepted"` and `WHERE NOT "accepted"`, not `= true` / `= false`. Both forms skip NULL rows, so the result is the same.
