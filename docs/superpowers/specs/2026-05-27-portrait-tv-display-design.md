# Portrait TV slideshow display — design

**Date:** 2026-05-27
**Status:** Approved (design); implementation pending

## Problem

The office has widescreen TVs hung in **portrait** orientation that run a
slideshow. We want a kaffe-skam slide that shows the live coffee-CO₂ dashboard
in a single tall column, readable from across a room during a ~30-second slide.
The existing `/` dashboard is a landscape two-column wall display with nav,
status chips, and a phone-responsive mode — none of which suit a non-interactive
portrait TV slide.

Because the slideshow **circulates** (slides rotate away and come back), the
display does not need to convey everything in one glance — a fuller, denser
stack is acceptable.

## Goal

A new non-interactive `/tv` route: the full dashboard content stacked in one
portrait column, with a title and methodology caveat, reusing the existing
visual language and all existing rendering logic.

## Approach (chosen)

**New `/tv` route that reuses `app.js` unchanged.** A new `public/tv.html`
provides a single-column portrait structure carrying the **same element IDs**
that `app.js` already writes to, so the existing fetch/format/ticker logic
drives it with no JS changes. Portrait styling is added to `public/style.css`
scoped under `body.page-tv`. A one-line static route is added to `src/server.ts`.

Rejected alternatives:
- A `?display=tv` mode on `/` — overloads the wall-display page with a second
  mode and query-param branching; the two displays have different chrome needs.
- A standalone self-contained page (own inline JS, like `device.html`) —
  duplicates the multiplier phrase, equivalence ticker, and number formatting,
  which would drift from `/`.

## Reusing `app.js` unchanged

`app.js` polls `/api/state` every 3 s and writes into a fixed set of element
IDs (no null guards on most). `tv.html` MUST include every ID `app.js` writes
to, or it will throw:

`brand`, `today-co2`, `today-cups-line`, `today-equiv`, `month-header`,
`month-cups`, `month-co2`, `chip-time`, `chip-status`, `stale-badge`,
`last-label`, `drink-name`, `drink-floor`, `composition`, `brew-co2`,
`delta`, `vs`, `previous-list`.

The chrome-only elements not wanted on the TV slide — `chip-status`,
`chip-time` — are present but hidden via CSS (`display: none`). `stale-badge`
is kept and shown subtly (a small "signal mistet" indicator, useful on an
unattended screen) — its existing default styling already renders it small and
unobtrusive, only visible when `app.js` un-hides it on a failed fetch.

`tv.html` sets `<body class="page-tv">`; all new CSS is scoped under that class
so it cannot affect `/` or the sub-pages. `app.js` is loaded unchanged.

## Layout (single column, top → bottom)

Sized in `vh`/`vmin` so it fills any portrait resolution (1080×1920 up to 4K
portrait) and reads from across a room. Reuses `--bg` paper tone, the grain
overlay, General Sans, hairline dividers, and the terracotta `--up` accent.

1. **Title** — "Kaffe og Carbon" + location label (`brand`, env-driven via
   `s.locationName`). Small, uppercase-spaced, top of screen.
2. **Today (hero)** — `DAGENS CO₂EQ` label, giant `today-co2` hero number
   (kg + "CO₂" tail), `today-cups-line` ("142 kopper i dag"), and the rotating
   `today-equiv` equivalence line ("≈ 11 km i bil").
3. hairline · **Month** — `month-header` ("Maj 2026"), then two stats side by
   side: `ANTAL KOPPER` (`month-cups`) and `CO₂ UDLEDT` (`month-co2`).
4. hairline · **Latest brew** — `last-label` ("Seneste bryg · 27. maj · 4
   minutter siden"), `drink-name` + `drink-floor`, `composition` ("10,5 g kaffe
   · 130 ml mælk · + 1 skvæt"), big `brew-co2`, and the `delta` + `vs`
   multiplier phrase ("Godt 19 gange så meget som en kop sort kaffe") in the
   up/down accent colour.
5. hairline · **Previous** — `TIDLIGERE` + `previous-list` (the ~3 rows
   `app.js` renders: floor · time · drink · CO₂). The number of rows shown is a
   CSS concern; default ~3, trivially tunable.
6. **Caveat footnote** — the methodology disclaimer (beans + cow's milk only;
   electricity, water, packaging not counted), small at the bottom.

Type scale: hero ≈ 11–14 vh at weight 200; section numbers smaller; labels
weight 500 uppercase with wide letter-spacing — matching the existing dashboard.

## Behaviour

- Reuses `app.js`: 3 s `/api/state` poll, the 10 s equivalence-ticker and
  relative-time refreshers. Whenever the slide is on screen it is live.
- Fully non-interactive: no nav, no links, no clicks; `body` scroll locked
  (default), content fits one screen.
- Portrait viewport assumed (the TV reports a tall viewport when physically
  rotated) — no CSS rotation transform needed.
- Stale feed: `app.js` already toggles `stale-badge`/`chip-status` on fetch
  failure; on the TV the badge styling is the only surfaced signal.

## Files

- `public/tv.html` — **new**. Single-column portrait structure with the IDs
  above; `<body class="page-tv">`; loads `app.js`.
- `public/style.css` — **modified**. Add a `body.page-tv { … }` block (layout,
  type scale, hidden chrome). No changes to existing rules.
- `src/server.ts` — **modified**. Add `if (path === "/tv") return
  serveStatic(res, opts.publicDir, "tv.html");` alongside the other page routes.
- `public/app.js` — **unchanged**.

## Out of scope / non-goals

- No changes to `/`, `/device`, or the other pages.
- No new API endpoint — `/api/state` already provides everything.
- No automated tests: this is a presentational HTML/CSS page; verification is
  visual at a 9:16 viewport and on the real TV. (`server.ts`'s existing
  static-route test coverage already exercises the routing pattern.)
- No slideshow integration on our side — the TV's slideshow software just points
  at the `/tv` URL as one slide.

## Verification

- Load `/tv` in a 1080×1920 (9:16) browser viewport; confirm the stacked
  layout, large legible type, live data, rotating equivalence, and the
  multiplier phrase render correctly with real data.
- Confirm `/`, `/device`, and sub-pages are visually unchanged (shared
  stylesheet + shared `app.js`).
