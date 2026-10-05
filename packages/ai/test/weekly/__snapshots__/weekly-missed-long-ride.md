# Weekly review: 2026-W40 (2026-09-28 → 2026-10-04)

You are an experienced triathlon coach reviewing the athlete's training week, which ends today
(2026-10-04). Using the data below, say how the week went and whether next week's plan should change.
Base every statement on the data shown and quote the numbers (minutes, km) you rely on. Where a
section says data is missing, say so instead of guessing. Today's sessions may not be closed out
yet; treat them as pending, not missed.

## Season position

This week: block 2 of 2, build (focus: threshold), week 1 of 4.
A-race: Challenge Prague (half) on 2027-06-13, in 252 days.

## Volume, planned vs done

- swim: 120 of 120 min (0 min, 100%), 5.0 km, TSS 120; 2 activities, 2 planned.
- bike: 75 of 255 min (-180 min, 29%), 37.5 km, TSS 75; 1 activities, 2 planned.
- run: 225 of 225 min (0 min, 100%), 37.5 km, TSS 225; 3 activities, 3 planned.
- total: 420 of 600 min (-180 min, 70%), 80.0 km, TSS 420; 6 activities, 7 planned.

## Key sessions

- done: 2026-09-29 Tue bike "VO2 5x4"
- done: 2026-10-01 Thu run "Threshold run"
- done: 2026-10-04 Sun run "Long run"
- missed: 2026-10-03 Sat bike "Long ride"

## Intensity, by average heart rate

Z1-2: 300 min (100%), Z3+: 0 min (0%), unknown: 120 min.

## Training load

CTL 50.0 → 52.0 (+2.0).
ATL 50.0 (-5.0), TSB 2.0 (+7.0) at 2026-10-04.

## Wellness

1 days with data.
HRV 62.0 ms (week before 60.0, +3.3%), resting HR 47.0 bpm, sleep 7.8 h.
Check-in: readiness 4.0/5, soreness 1.0.

## Next week (2026-10-05 → 2026-10-11)

Season position: block 2 of 2, build (focus: threshold), week 2 of 4.

Sessions you can change:

- `2026-10-05/swim-1`: swim 60 min Z2 "Aerobic swim"
- `2026-10-06/bike-1`: bike 75 min Z4 "VO2 5x4"
- `2026-10-07/run-1`: run 60 min Z2 "Easy run"
- `2026-10-08/run-1`: run 60 min Z4 "Threshold run"
- `2026-10-10/bike-1`: bike 210 min Z2 "Long ride"
- `2026-10-11/run-1`: run 135 min Z2 "Long run"

## Your answer

Reply with one JSON object only, with no prose around it.

- `summary`: how the week went, in one or two short sentences. Quantify any volume gap in
  minutes, and in km where the data has distance.
- `wins`: at most two short points that went well. An empty list is fine.
- `concerns`: at most two short points to watch. An empty list is fine.
- `nextWeekChanges`: one entry per session field you change, as `sessionId`, `field`, `before`,
  `after`. `field` is `durationMin` (minutes), `intensity` (`z1` to `z5`), `date` (YYYY-MM-DD) or
  `sport`. `before` must be the current value listed above. Leave the list empty when next week's
  plan is fine as it is.
- `blockAdjustment`: `null`, or `{"kind": "scale_volume", "factor": f, "reason": "..."}` to scale
  every changeable session of next week by `f` (from 0.60 to 1.08). Use it instead
  of `nextWeekChanges`, never together with it.

How to handle a missed or short week:

- Don't cram missed training into next week. A partial catch-up is fine within the limits below;
  otherwise drop the missed work explicitly and say so in `summary`.
- A fully compliant week needs no changes: say what went well and leave next week alone.

Changes outside these limits are rejected:

- All changes together add at most 8% to next week's planned minutes.
- Only the sessions listed above can change. Leave sessions marked locked alone.
- One change removes at most 50% of a session; don't cancel sessions.
- Move sessions only onto days that already have training. Rest days stay rest days.
- No hard sessions on consecutive days.
- When readiness is 2/5 or lower, don't raise any intensity.
