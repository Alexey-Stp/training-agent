## Your answer

Reply with one JSON object only, with no prose around it. Today is {{date}}.

- `assessment`: what the data says about today, in two or three sentences.
- `action`: one of `keep`, `reduce`, `swap`, `move`, `rest`.
- `changes`: one entry per session field you change, as `sessionId`, `field`, `before`, `after`.
  `field` is `durationMin` (minutes), `intensity` (`z1` to `z5`), `date` (YYYY-MM-DD) or `sport`.
  `before` must be the current value listed below. Leave the list empty for `keep`.
- `confidence`: how sure you are, from 0 to 1.
- `athleteMessage`: what to tell the athlete, short and in plain language.

Changes outside these limits are cut back or rejected:

- Only the sessions listed below can change, and only those dated {{date}} or later. Leave
  sessions marked locked alone; the athlete owns them.
- One change removes at most {{maxReduction}}% of a session. Cancel a session (`durationMin` 0)
  only with action `rest`.
- Move sessions only onto days that already have training. Rest days stay rest days.
- No hard sessions on consecutive days.
- When readiness is {{lowReadiness}}/5 or lower, don't raise any intensity.

Sessions you can change:

{{sessions}}
