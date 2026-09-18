# Swim FIT repair — handoff

A page in [`handy-tools`](https://github.com/ericcheng05/handy-tools) that
inspects and repairs Garmin pool-swim `.fit` files the watch recorded wrongly,
so the corrected file can be re-uploaded to Garmin Connect. It runs entirely in
the browser: no Worker, no upload, no build step.

## Why

Garmin Connect holds all activity data, but the watch sometimes records a pool
swim wrong. [swimdata.org](https://swimdata.org) fixes most cases in the
browser, but not all of them. Notably, it cannot turn a rest length back into a
swimming length, because a rest length has no stroke to change.

## Why a page, not a Worker

- Files are 2–15 KB, and decode → detect → fix → encode takes milliseconds.
  Nothing needs a server, a secret or storage.
- swimdata.org already runs `@garmin/fitsdk` client-side, so the browser is a
  proven runtime for this.
- The workflow is manual regardless: export from Connect, fix, delete the
  original, upload. Garmin has no personal API.
- Swim and heart-rate data never leave the device, in keeping with the other
  "zero upload" converters in `handy-tools`.
- Revisit only if something without a browser needs the repair (an iOS
  Shortcut, or a Dropbox webhook auto-fixing exports). `repair.js` is kept free
  of DOM code so it could move into a Worker unchanged.

## Where and how

```
handy-tools/
  swim-fit-repair/
    index.html   page + UI script, same layout as the other tools
    style.css
    repair.js    ES module, no DOM: parse → model → detect → fix → encode
```

- Follow the existing tools: `index.html` + `style.css` per folder, a
  `← myexample.work` back-nav, Google Fonts, and the shared `../style.css`
  conventions. Other tools keep their script inline. `repair.js` is the
  deliberate exception, so the logic stays testable and portable.
- Libraries from CDN as ES modules, with no bundler:
  - `@garmin/fitsdk`: `https://cdn.jsdelivr.net/npm/@garmin/fitsdk/+esm`
    (Decoder **and** Encoder)
  - `fflate` to unzip Garmin's `.zip` export in the browser
- Add an app card to the root `index.html` and a section to `README.md`.
- **Do not copy code from swimdata.org.** It is GPL-3.0
  ([source](https://github.com/PeterK-end/swim-data-analyser)). Following its
  approach (fitsdk plus a length/lap model) is fine; write the code fresh.

### Page flow

1. Drop a `.zip` or `.fit` file.
2. Summary: pool length, total distance, time, and lengths as recorded.
3. Table of laps with their lengths nested (time, strokes, pace, stroke type);
   rest shown distinctly; flagged lengths highlighted with the proposed fix.
4. Tick the fixes to apply (Issue A needs confirming; Issue B is ticked by default).
5. Preview the new totals, then download `<id>_REPAIRED.fit`.
6. Remind the user to delete the original activity in Connect before uploading.

## TODO

### 1. Spike: round-trip (0.5 day). Do this first.
- [ ] Load fitsdk from jsDelivr as ESM and decode a sample file in the page
- [ ] Re-encode it unmodified; diff message by message against the original
- [ ] Upload a re-encoded file to Garmin Connect and confirm it is accepted.
      Connect rejects a file it thinks it already has, so the original activity
      probably has to be deleted first. Find out exactly what it keys on
      (`file_id` serial / `time_created`?).

### 2. Swim model and recompute (1 day), in `repair.js`
- [ ] Model: session → laps → lengths, with lap membership from
      `first_length_index` + `num_lengths`
- [ ] After any change, recompute and rewrite:
  - lengths: `message_index` renumbered sequentially
  - laps: `first_length_index`, `num_lengths`, `num_active_lengths`,
    `total_distance`, `total_strokes`, `avg_speed` **and** `enhanced_avg_speed`,
    `swim_stroke` (set to `mixed` when the lengths differ), and stroke distance or
    SWOLF where present
  - session: the same totals, plus `num_lengths` and `num_active_lengths`
- [ ] Leave every other message untouched (device info, events, HR records,
      developer fields)

### 3. Detection and fixes (0.5 day), in `repair.js`

**Issue A: swimming length recorded as rest**
- Detect: `length_type = idle`, `total_strokes = 0`, inside a lap that has
  active lengths, and `total_elapsed_time` within ±20% of that lap's median
  active length
- Fix: set `length_type = active`; `swim_stroke` = the lap's dominant stroke;
  `total_strokes` = the lap median; `avg_speed` = pool length ÷ time
- Confidence **medium**. A genuine pause without pressing lap looks similar,
  so the user must confirm it.

**Issue B: missed turn, N lengths merged into one**
- Detect: an active length whose time **and** strokes are both about N × the
  median (N an integer ≥ 2, within about 15%)
- Fix: split evenly into N lengths (time ÷ N, strokes ÷ N, with the remainder
  going to the last). Pool swims store only per-length summaries, not stroke
  timestamps, so an even split is the only option.
- Confidence **high**. Two independent measurements agree.

### 4. UI (0.5–1 day)
- [ ] Drop zone, summary, lap/length table, fix checkboxes, download (see Page flow)
- [ ] Works at phone width. Exports are often handled on a phone.

### 5. Verify (0.5 day)
- [ ] Both sample files below come out at the expected totals
- [ ] An unmodified round-trip is lossless
- [ ] Idempotence: loading a repaired file finds no issues
- [ ] The repaired file uploads to Garmin Connect and shows the right laps
- [ ] Optional: a small `repair.test.html` that runs `repair.js` against the
      fixtures and prints pass or fail, so no Node toolchain is needed

### 6. Later
- [ ] Scan every swim file in the Dropbox folder to see how often A and B occur,
      and whether there is a third failure mode
- [ ] Manual edits (split, merge, delete, change stroke, pool length): 1–2 days,
      reusing the recompute
- [ ] Move `repair.js` into a Worker only if a non-browser client appears

**Estimate:** about 3 days for inspect + repair + UI; about 4–5 with manual edits.

## Sample files

Source: Dropbox `/Sports Activities/Mobile App Data/Garmin/`. Each Garmin export
zip holds `<id>_ACTIVITY.fit`. The `<id>_ACTIVITY_NEW.fit` next to each zip is an
earlier swimdata.org edit and has not been inspected.

Both are in a 50 m pool, and both should total **1400 m**. Garmin recorded 1350 m.

### `24340622267.zip`: Issue A
Intended: 500 / 500 / 400.

| Lap | Content | Recorded |
| --- | --- | --- |
| 0 | lengths 0–9: 9 active breast + **length 9 idle, 67.6 s, 0 strokes** | 450 m ✗ |
| 1 | rest 29.9 s | |
| 2 | lengths 11–20, 10 active free | 500 m ✓ |
| 3 | rest 15.8 s | |
| 4 | lengths 22–29, 8 active mixed | 400 m ✓ |
| 5 | rest 3.3 s | |

Neighbouring lengths are 68–74 s and 32–34 strokes. Expected after repair:
lap 0 = 500 m with 10 active lengths; session = 1400 m with 28 active lengths.

### `24357833366.zip`: Issue B
Intended: 600 / 500 / 200 / 2×50.

| Lap | Content | Recorded |
| --- | --- | --- |
| 0 | lengths 0–11, 12 active | 600 m ✓ |
| 1 | rest 33.5 s | |
| 2 | lengths 13–22, 10 active | 500 m ✓ |
| 3 | rest 38.4 s | |
| 4 | lengths 24–27, 4 active free | 200 m ✓ |
| 5 | rest 7.0 s | |
| 6 | **length 29: 139.3 s, 62 strokes, 0.36 m/s** | 50 m ✗ |
| 7 | rest 5.4 s | |

The median length is about 70 s and 33 strokes, so length 29 is 1.98× the time
and 1.9× the strokes, giving N = 2. Expected after repair: lap 6 = 2 lengths of
69.65 s and 31 strokes, 100 m in total; session = 1400 m with 28 active lengths.

## FIT reference

FIT timestamps count seconds from 1989-12-31 00:00 UTC (Unix time − 631065600).

| Message | # | Fields used |
| --- | --- | --- |
| session | 18 | 2 start_time, 7 total_elapsed_time (ms), 8 total_timer_time (ms), 9 total_distance (cm), 26 num_laps, 33 num_lengths, 44 pool_length (cm), 47 num_active_lengths |
| lap | 19 | 2 start_time, 7/8 elapsed/timer (ms), 9 total_distance (cm), 24 lap_trigger, 32 num_lengths, 35 first_length_index, 38 swim_stroke, 40 num_active_lengths, 254 message_index |
| length | 101 | 2 start_time, 3/4 elapsed/timer (ms), 5 total_strokes, 6 avg_speed (mm/s), 7 swim_stroke, 12 length_type (0 idle, 1 active), 254 message_index |
| event | 21 | 0 event, 1 event_type, 3 data |

`swim_stroke`: 0 free, 1 back, 2 breast, 3 fly, 4 drill, 5 mixed, 6 IM.

fitsdk decodes these into named fields with scaling applied (for example
`totalElapsedTime` in seconds), so the numbers above are for checking results,
not for hand-parsing. The sample files use compressed-timestamp record headers,
which fitsdk handles.
