# Recording

`record.mjs <out-dir> [--rehearse] [--headed] [--keep-frames] [--login-headed]` · env `DEMO_BASE_URL`, `DEMO_EMAIL`, `DEMO_PASSWORD`.

## What it does

1. Launches Chromium at the format's viewport — landscape 1280×720 @2× (frames 2560×1440), vertical 430×764 @3× mobile emulation with touch. Locale and timezone from brand.json.
2. Signs in, per `brand.login`:
   - **saved session** (`work/auth-state.json`, from an earlier `--login-headed`) → loaded, no form. If the app redirects to the login path the session expired — run `--login-headed` again.
   - **form** → opens `login.path`, fills `login.email` / `login.password` from the env vars, clicks `login.submit`, waits to leave the login path (30s).
   - **`--login-headed`** → a visible browser opens on the login page first; the user signs in by hand (OTP, SSO, captcha) and closes the window; the session is saved and used for this and later runs.
   - **`"login": false`** → no sign-in; starts at `/`.
3. Runs `setup` actions, navigates to the first shot's `goto`, **then** starts the CDP screencast. Nothing before this point is in the footage.
4. Plays each shot's actions, then dwells until the shot's visual time covers its VO (`VO duration + 0.35s lead + 0.6s tail`).
5. Writes `work/take/take.mp4` (CFR, near-lossless) and `work/take/events.json` (`shots`, `events` with on-screen boxes in CSS px, `waits` that edit.mjs cuts).

## Actions

| `do` | Fields | Recorded as | Notes |
|---|---|---|---|
| `goto` | `path` | cut wait | Full navigation; prefer clicking nav links when the click itself is worth showing. |
| `click` | `target`, `zoom`, `cue`, `moveMs` | `click` + cut wait for loading | Cursor glides (~0.6s), ripple, click, then waits for the screen to settle. |
| `type` | `target`, `text`, `delay` (55ms), `clear`, `enter` | `type` span | Clicks the field first. Keep text ≤ ~40 chars — long typing is dead air. |
| `press` | `key` | `key` | `Enter`, `Escape`, `Tab`… |
| `hover` | `target`, `ms` | `hover` | For tooltips / hover cards. |
| `focus` | `target`, `ms` (1500), `zoom` (default true) | `focus` span | No interaction — a camera push-in on a region or result. |
| `select` | `target`, `option` | `click` | Native `<select>` only; custom dropdowns are click + click. |
| `scroll` | `by` px or `target`, `container` | `scroll` | Smooth. Inner scroll areas need `container`. Never zoomed. |
| `drag` | `target`, `to` | `drag` span | Stepped mouse moves so dnd libraries register it. |
| `wait` | `for` or `gone`, `timeout` | cut wait | Waits on app state (a toast, a result list). The wait is cut from the edit. |
| `pause` | `ms` | kept | A deliberate visible beat — let a result breathe. |

Any action may set `optional: true` (skip if missing within 2.5s) and `cue: "phrase"` — the action is timed so the click lands as the VO says that phrase (phrase must appear in the shot's transcript; a warning prints otherwise).

`commit: true` marks a data-changing step (the final Save / Submit / Post / Delete). Rehearsal checks its target is visible but doesn't perform it, so a rehearse + take creates the record once. Put `commit` also on later `wait`/`focus` actions that depend on the committed result — rehearsal skips those. A later `click`/`type` on something the commit creates (open the new task, tick its checklist) takes `"commit": "after"`, so rehearsal skips it without checking for a control that doesn't exist yet. Steps after an uncommitted dialog should start with a `goto` (or tolerate the dialog still being open).

Targets only match visible elements (the app renders hidden mobile copies of many controls); `"visible": false` on a target opts out.

## Settling and cuts

After clicks, navigation and waits the recorder watches the page: it is "settled" when no request is in flight and the DOM has not changed for 450ms (cap 8s; CSS-only animation and the demo cursor are ignored). The span from 0.2–0.3s after the action until just before settle is logged as a cut, so spinners and skeletons flash for a beat and the result pops — no dead air, no fake speed-ramping.

## Brand cursor & masks

An arrow in the brand `primary` colour with a white outline (hidden on mobile, where only the tap ripple shows) is injected into every page and survives reloads. Scrollbars are hidden. `mask` selectors get `filter: blur(7px)` — use for anything that could be real PII if the demo account isn't fully synthetic. `hide` selectors get `display: none` — floating chat/support buttons, promo banners.

## Fixing a failed rehearsal

The failure prints the shot/action, URL, a screenshot path and up to 60 visible controls with their accessible names. Typical fixes:
- Name mismatch → copy the exact name from the list (case-insensitive substring by default; `exact: true` to tighten).
- Several matches → add `within` (e.g. inside a dialog `{ "role": "dialog" }`) or `nth`.
- Element appears late → add a `wait` before it.
- A popup in the way → add an `optional` dismiss in `setup` or right before. Popups that open late (after login) and remember dismissal in localStorage — welcome carousels, product tours — are better suppressed with the plan's `localStorage` seed, since every run starts from a fresh profile.
- Icon-only buttons → `{ "title": "…" }` or `{ "css": "button[aria-label='…']" }`; as last resort `css` with a stable class.

Read the screenshot before editing locators — it's usually obvious.
