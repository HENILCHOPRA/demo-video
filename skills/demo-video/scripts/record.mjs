// Drive the app per shots.json and screen-record it via CDP screencast, logging every action.
// Usage: node record.mjs <out-dir> [--rehearse] [--headed] [--keep-frames] [--login-headed]
// Env: DEMO_BASE_URL (or plan.baseUrl), DEMO_EMAIL, DEMO_PASSWORD — never written to disk.
// --login-headed: sign in by hand in a visible browser (OTP, SSO, captcha); the session is saved to
// work/auth-state.json and reused instead of the email/password form until it expires.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { args, BT709_TAGS, clamp, describe, die, ffmpeg, loadPlan, locate, r3, sleep, stripTags, TO_BT709, workDir } from './lib.mjs';

const VO_LEAD = 0.35;   // edit.mjs starts each shot's VO this far in
const SHOT_TAIL = 0.6;  // visual hold after the VO ends
const HANDLE = 0.2;     // seconds kept at each edge of a cut wait

const a = args();
const outDir = path.resolve(a._[0] || die('usage: node record.mjs <out-dir> [--rehearse]'));
const rehearse = !!a.rehearse;
const { plan, fmt, brand } = loadPlan(outDir);
const baseUrl = (process.env.DEMO_BASE_URL || plan.baseUrl || die('set DEMO_BASE_URL')).replace(/\/$/, '');
const login = brand.login;  // false = the app needs no sign-in
const onLoginPage = (u) => !!login && new URL(u).pathname.startsWith(login.path);
const authFile = path.join(outDir, 'work', 'auth-state.json');
const timingPath = path.join(outDir, 'work', 'vo', 'timing.json');
const timing = fs.existsSync(timingPath) ? JSON.parse(fs.readFileSync(timingPath, 'utf8')).shots : {};
if (!rehearse && !Object.keys(timing).length) console.warn('warning: no VO timing found — shots fall back to `hold` seconds');

const recDir = workDir(outDir, rehearse ? 'rehearsal' : 'take');
// Raw frames go to the OS temp dir: thousands of JPEGs inside the repo make dev-server file watchers lock the folder.
const framesDir = a['keep-frames'] ? path.join(recDir, 'frames') : path.join(os.tmpdir(), `demo-frames-${process.pid}`);
if (!rehearse) { fs.rmSync(framesDir, { recursive: true, force: true }); fs.mkdirSync(framesDir, { recursive: true }); }

// ---------- browser ----------
const contextOpts = { viewport: fmt.viewport, locale: brand.locale, timezoneId: brand.timezone, colorScheme: plan.colorScheme || 'light' };
if (a['login-headed']) await manualLogin();
const hasAuth = fs.existsSync(authFile);
const browser = await chromium.launch({ headless: !a.headed });
const context = await browser.newContext({
  ...contextOpts,
  deviceScaleFactor: fmt.dsf,
  isMobile: fmt.mobile,
  hasTouch: fmt.mobile,
  storageState: hasAuth ? authFile : undefined,
});
if (plan.localStorage) {
  // Seed app flags (dismissed onboarding, seen tours) before any app code runs — the profile is fresh every run.
  await context.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) {
      try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch {}
    }
  }, plan.localStorage);
}
await context.addInitScript(overlayScript, { mobile: fmt.mobile, mask: plan.mask || [], hide: plan.hide || [], color: brand.colors.primary });
const page = await context.newPage();
// Requests in flight, for settle(). Streams (SSE, long polls) never finish, so anything older than 6s is ignored.
const inflight = new Map();
let lastNetAt = Date.now();
page.on('request', (r) => { if (r.resourceType() !== 'eventsource') inflight.set(r, Date.now()); });
for (const ev of ['requestfinished', 'requestfailed']) page.on(ev, (r) => { if (inflight.delete(r)) lastNetAt = Date.now(); });
page.setDefaultTimeout(10000);

// ---------- login (before the screencast starts, so it is never recorded) ----------
await page.goto(`${baseUrl}${login && !hasAuth ? login.path : '/'}`, { waitUntil: 'domcontentloaded' });
if (onLoginPage(page.url())) {
  if (hasAuth) await fail('login', null, new Error('saved session expired — re-run with --login-headed'));
  const email = process.env.DEMO_EMAIL || die('set DEMO_EMAIL (or sign in once with --login-headed)');
  const password = process.env.DEMO_PASSWORD || die('set DEMO_PASSWORD (or sign in once with --login-headed)');
  await page.locator(login.email).first().fill(email);
  await page.locator(login.password).first().fill(password);
  await page.locator(login.submit).first().click();
  try { await page.waitForURL((u) => !onLoginPage(u.href), { timeout: 30000 }); }
  catch { await fail('login', null, new Error(`still on ${login.path} after 30s — wrong credentials, OTP/SSO (use --login-headed), brand.login selectors, or base URL`)); }
}
await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

// ---------- screencast ----------
const frames = [];
let t0 = Date.now() / 1000;
let cdp;
if (!rehearse) {
  cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = `f${String(frames.length).padStart(6, '0')}.jpg`;
    fs.writeFileSync(path.join(framesDir, file), Buffer.from(data, 'base64'));
    frames.push({ file, ts: metadata.timestamp ?? Date.now() / 1000 });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
}

const events = [], waits = [], shots = [];
const now = () => Date.now() / 1000 - t0;
let shotCtx = null;

// Setup runs after the timing helpers exist (a setup `goto` uses them) but before the screencast starts.
for (const act of plan.setup || []) await perform(act, { shot: 'setup', setup: true });

const firstGoto = plan.shots[0]?.goto;
if (firstGoto) await gotoPath(firstGoto, false);
if (!rehearse) {
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: fmt.viewport.width * fmt.dsf, maxHeight: fmt.viewport.height * fmt.dsf, everyNthFrame: 1 });
  t0 = Date.now() / 1000;
  await sleep(400);
}

for (const [i, shot] of plan.shots.entries()) {
  const vo = timing[shot.id];
  const target = (vo ? vo.duration + VO_LEAD : (shot.hold ?? 3)) + SHOT_TAIL;
  shotCtx = { id: shot.id, start: now(), waited: 0, words: vo?.words || [] };
  console.log(`${shot.id}${shot.chapter ? ` [${shot.chapter}]` : ''}: ${stripTags(shot.vo || '').slice(0, 70)}`);
  if (shot.goto && i > 0) await gotoPath(shot.goto, true);
  for (const [j, act] of (shot.actions || []).entries()) await perform(act, { shot: shot.id, index: j });
  if (!rehearse) await dwellUntil(target);
  shots.push({ id: shot.id, start: r3(shotCtx.start), end: r3(now()) });
}

// ---------- finish ----------
if (rehearse) {
  console.log(`\nREHEARSAL OK — every locator resolved across ${plan.shots.length} shots.`);
  await browser.close();
  process.exit(0);
}
await sleep(300);
await cdp.send('Page.stopScreencast');
const end = now();
await browser.close();

const rel = frames.map((f) => ({ ...f, t: f.ts - t0 })).filter((f) => f.t <= end);
if (!rel.length) die('no frames captured');
const list = [];
for (let k = 0; k < rel.length; k++) {
  const from = k === 0 ? 0 : rel[k].t;
  const to = k + 1 < rel.length ? rel[k + 1].t : end;
  list.push(`file '${rel[k].file}'`, `duration ${Math.max(0.001, to - from).toFixed(4)}`);
}
list.push(`file '${rel.at(-1).file}'`);
fs.writeFileSync(path.join(framesDir, 'list.txt'), list.join('\n'));
const takeMp4 = path.join(recDir, 'take.mp4');
console.log(`\nencoding ${rel.length} frames → ${path.relative(outDir, takeMp4)}`);
ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-vf', `fps=${plan.fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,${TO_BT709}`,
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '12', ...BT709_TAGS, takeMp4], { cwd: framesDir });
fs.writeFileSync(path.join(recDir, 'events.json'), JSON.stringify({
  viewport: fmt.viewport, dsf: fmt.dsf, duration: r3(end), shots, events, waits,
}, null, 2));
if (!a['keep-frames']) fs.rmSync(framesDir, { recursive: true, force: true });
console.log(`take ${r3(end)}s · ${events.length} events · ${waits.length} cuttable waits`);

// ======================================================================

async function perform(act, where) {
  try {
    if (act.cue && !rehearse && !where.setup) await waitForCue(act);
    if (rehearse && act.commit) {
      // Data-changing step: check the control is there, but don't create anything twice.
      // commit: "after" marks a step on something an earlier commit creates — nothing to check yet.
      if (act.target && act.do !== 'focus' && act.commit !== 'after') await locate(page, act.target).waitFor({ state: 'visible', timeout: act.optional ? 2500 : 10000 });
      console.log(`  · commit ${act.do} ${describe(act.target || act.for || act.gone)} — not performed in rehearsal`);
      return;
    }
    await run(act, where);
  } catch (err) {
    if (act.optional) { console.log(`  · skipped optional ${act.do} ${describe(act.target)}`); return; }
    await fail(`${where.shot}#${where.index ?? 0}`, act, err);
  }
}

async function run(act, where) {
  const ev = (type, extra) => !where.setup && events.push({ shot: where.shot, type, zoom: !!act.zoom, ...extra });
  switch (act.do) {
    case 'goto': return gotoPath(act.path, !where.setup);
    case 'click': {
      const box = await approach(act);
      const t = now();
      await press();
      await locate(page, act.target).click({ timeout: act.optional ? 2500 : 10000 });
      ev('click', { t: r3(t), bbox: box });
      return settle(t + 0.3);
    }
    case 'type': {
      const box = await approach(act);
      await locate(page, act.target).click();
      if (act.clear) await locate(page, act.target).fill('');
      const t = now();
      await locate(page, act.target).pressSequentially(act.text, { delay: rehearse ? 0 : (act.delay ?? 55) });
      ev('type', { t: r3(t), tEnd: r3(now()), chars: act.text.length, bbox: box });
      if (act.enter) { await page.keyboard.press('Enter'); return settle(now() + 0.3); }
      return;
    }
    case 'press': { const t = now(); await page.keyboard.press(act.key); ev('key', { t: r3(t) }); return settle(t + 0.3); }
    case 'hover': { const box = await approach(act); ev('hover', { t: r3(now()), bbox: box }); return pause(act.ms ?? 600); }
    case 'focus': {
      const loc = locate(page, act.target);
      await loc.waitFor({ state: 'visible' });
      await scrollIntoView(loc);
      const box = await bbox(loc);
      const t = now();
      await pause(act.ms ?? 1500);
      ev('focus', { t: r3(t), tEnd: r3(now()), bbox: box, zoom: act.zoom ?? true });
      return;
    }
    case 'select': {
      const box = await approach(act);
      const t = now();
      await locate(page, act.target).selectOption(act.option);
      ev('click', { t: r3(t), bbox: box });
      return settle(t + 0.3);
    }
    case 'scroll': {
      const t = now();
      if (act.target) await scrollIntoView(locate(page, act.target), true);
      else {
        const by = act.by ?? 500;
        const container = act.container ? await locate(page, act.container).elementHandle() : null;
        await page.evaluate(([el, dy]) => (el || window).scrollBy({ top: dy, behavior: 'smooth' }), [container, by]);
        await pause(900);
      }
      ev('scroll', { t: r3(t), tEnd: r3(now()) });
      return;
    }
    case 'drag': {
      const from = await approach(act);
      const to = await bbox(locate(page, act.to));
      const t = now();
      await page.mouse.move(from.cx, from.cy);
      await page.mouse.down();
      const steps = rehearse ? 5 : 24;
      for (let s = 1; s <= steps; s++) {
        const x = from.cx + ((to.cx - from.cx) * s) / steps, y = from.cy + ((to.cy - from.cy) * s) / steps;
        await page.mouse.move(x, y);
        await page.evaluate(([x, y]) => window.__demoCursor?.moveTo(x, y, 0), [x, y]);
        if (!rehearse) await sleep(28);
      }
      await page.mouse.up();
      const union = unionBox(from, to);
      ev('drag', { t: r3(t), tEnd: r3(now()), bbox: union });
      return settle(now() + 0.2);
    }
    case 'wait': {
      const t = now();
      if (act.for) await locate(page, act.for).waitFor({ state: 'visible', timeout: act.timeout ?? 20000 });
      else if (act.gone) await locate(page, act.gone).waitFor({ state: 'hidden', timeout: act.timeout ?? 20000 });
      return settle(t + HANDLE, true);
    }
    case 'pause': return pause(act.ms ?? 800);
    default: throw new Error(`unknown action "${act.do}"`);
  }
}

/** Move the visible cursor to the target (and hover it), returning its box. */
async function approach(act) {
  const loc = locate(page, act.target);
  await loc.waitFor({ state: 'visible', timeout: act.optional ? 2500 : 10000 });
  await scrollIntoView(loc);
  const box = await bbox(loc);
  if (!rehearse) {
    const ms = act.moveMs ?? 600;
    await page.evaluate(([x, y, ms]) => window.__demoCursor?.moveTo(x, y, ms), [box.cx, box.cy, ms]);
    if (!fmt.mobile) await page.mouse.move(box.cx, box.cy, { steps: 8 });
    await sleep(ms + 60);
  }
  return box;
}

async function press() {
  if (rehearse) return;
  await page.evaluate(() => window.__demoCursor?.press());
  await sleep(90);
}

async function bbox(loc) {
  const b = await loc.boundingBox();
  if (!b) throw new Error('element has no box (hidden or detached)');
  return { x: r3(b.x), y: r3(b.y), w: r3(b.width), h: r3(b.height), cx: r3(b.x + b.width / 2), cy: r3(b.y + b.height / 2) };
}

function unionBox(p, q) {
  const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
  const w = Math.max(p.x + p.w, q.x + q.w) - x, h = Math.max(p.y + p.h, q.y + q.h) - y;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

async function scrollIntoView(loc, always = false) {
  const inView = await loc.evaluate((el, always) => {
    const r = el.getBoundingClientRect();
    const ok = r.top >= 60 && r.bottom <= innerHeight - 40;
    if (!ok || always) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return ok && !always;
  }, always);
  if (!inView) await pause(rehearse ? 150 : 750);
}

async function gotoPath(p, record) {
  const t = now();
  await page.goto(`${baseUrl}${p.startsWith('/') ? p : `/${p}`}`, { waitUntil: 'domcontentloaded' });
  if (onLoginPage(page.url())) throw new Error(`redirected to ${login.path} while opening ${p}${hasAuth ? ' — saved session expired, re-run with --login-headed' : ''}`);
  await settle(t + HANDLE, true, record);
}

/** Wait for the screen to stop changing; the dead time becomes a cuttable span. */
async function settle(keepUntil, force = false, record = true) {
  const t = now();
  if (rehearse) { await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); return; }
  // Settled = no request in flight and no DOM change for 450ms. Frame arrival alone can't tell:
  // a CSS animation anywhere on the page keeps the screencast streaming forever.
  const deadline = Date.now() + 8000;
  await sleep(120);
  while (Date.now() < deadline) {
    const busy = [...inflight.values()].some((at) => Date.now() - at < 6000);
    const lastDom = await page.evaluate(() => window.__demoLastMutation || 0).catch(() => Date.now());
    if (!busy && Date.now() - Math.max(lastDom, lastNetAt) >= 450) break;
    await sleep(50);
  }
  const end = now() - 0.25;  // last change + a beat of settled screen stays in
  const start = Math.max(keepUntil, t);
  if (record && end - start > HANDLE && (force || end - start > 0.3)) {
    waits.push({ shot: shotCtx?.id, start: r3(start), end: r3(end) });
    if (shotCtx) shotCtx.waited += end - start;
  }
}

async function pause(ms) { await sleep(rehearse ? Math.min(ms, 150) : ms); }

/** Effective shot time = wall time minus the waits edit.mjs will cut. */
function effective() { return now() - shotCtx.start - shotCtx.waited; }
async function dwellUntil(target) {
  const remaining = target - effective();
  if (remaining > 0) await sleep(remaining * 1000);
}

async function waitForCue(act) {
  const words = shotCtx.words.map((w) => w.w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  const cue = stripTags(act.cue).toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  let hit = -1;
  for (let k = 0; k + cue.length <= words.length && hit < 0; k++)
    if (cue.every((c, m) => words[k + m] === c)) hit = k;
  if (hit < 0) { console.warn(`  ⚠ cue "${act.cue}" not found in ${shotCtx.id} VO; acting immediately`); return; }
  const moveLead = act.do === 'click' || act.do === 'type' || act.do === 'hover' || act.do === 'drag' ? (act.moveMs ?? 600) / 1000 + 0.1 : 0;
  await dwellUntil(clamp(VO_LEAD + shotCtx.words[hit].start - moveLead, 0, 999));
}

async function fail(where, act, err) {
  const shotFile = path.join(recDir, `fail-${where.replace(/[^\w-]/g, '_')}.png`);
  await page.screenshot({ path: shotFile }).catch(() => {});
  const names = await page.evaluate(() => {
    const out = new Set();
    for (const el of document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],input,textarea,select,h1,h2,h3')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
      if (label) out.add(`${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}: ${label.slice(0, 60)}`);
    }
    return [...out].slice(0, 60);
  }).catch(() => []);
  console.error(`\nFAILED at ${where}${act ? ` (${act.do} ${describe(act.target || act.for || act.gone)})` : ''}: ${err.message.split('\n')[0]}`);
  console.error(`url: ${page.url()}\nscreenshot: ${shotFile}\nvisible controls:\n  ${names.join('\n  ')}`);
  await browser.close();
  process.exit(2);
}

/** Visible browser for a hand sign-in; the session is snapshotted every second and saved when the window closes. */
async function manualLogin() {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext(contextOpts);
  const p = await ctx.newPage();
  await p.goto(`${baseUrl}${login ? login.path : '/'}`);
  console.log('Sign in to the app in the browser window, then close the window (waiting up to 10 min)…');
  let state = null;
  const timer = setInterval(() => ctx.storageState().then((s) => { state = s; }).catch(() => {}), 1000);
  await p.waitForEvent('close', { timeout: 600000 }).catch(() => {});
  clearInterval(timer);
  await b.close().catch(() => {});
  if (!state) die('no session captured — keep the window open until you are signed in');
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify(state));
  console.log(`session saved → ${path.relative(outDir, authFile)} (treat it like a password; keep the output folder git-ignored)`);
}

// Runs inside every page: brand cursor, click ripple, PII masks, hidden elements and scrollbars.
function overlayScript({ mobile, mask, hide, color }) {
  const install = () => {
    if (document.getElementById('__demo_style')) return;
    const st = document.createElement('style');
    st.id = '__demo_style';
    st.textContent = `
      ::-webkit-scrollbar{width:0!important;height:0!important}
      ${mask.length ? `${mask.join(',')}{filter:blur(7px)!important}` : ''}
      ${hide.length ? `${hide.join(',')}{display:none!important}` : ''}
      #__demo_cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;
        transition-property:transform;transition-timing-function:cubic-bezier(.22,.61,.36,1);will-change:transform}
      #__demo_cursor svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.25))}
      .__demo_ripple{position:fixed;z-index:2147483646;pointer-events:none;border-radius:50%;width:16px;height:16px;margin:-8px 0 0 -8px;
        background:${color}33;border:2px solid ${color}aa;animation:__demo_r .5s ease-out forwards}
      @keyframes __demo_r{to{transform:scale(3.4);opacity:0}}`;
    document.documentElement.appendChild(st);
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.innerHTML = mobile ? '' : `<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2.5l15.5 9.2-6.8 1.4 3.9 7.3-2.6 1.3-3.9-7.3L4.8 19z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    document.documentElement.appendChild(c);
    let pos;
    try { pos = JSON.parse(sessionStorage.getItem('__demo_pos')); } catch { pos = null; }
    pos ||= { x: innerWidth * 0.55, y: innerHeight * 0.6 };
    const set = (x, y, ms) => {
      c.style.transitionDuration = `${ms}ms`;
      c.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
      pos = { x, y };
      try { sessionStorage.setItem('__demo_pos', JSON.stringify(pos)); } catch {}
    };
    set(pos.x, pos.y, 0);
    window.__demoCursor = {
      moveTo: (x, y, ms = 600) => set(x, y, ms),
      press: () => {
        const r = document.createElement('div');
        r.className = '__demo_ripple';
        r.style.left = `${pos.x}px`; r.style.top = `${pos.y}px`;
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 600);
        c.animate([{ scale: 1 }, { scale: 0.82 }, { scale: 1 }], { duration: 180 });
      },
    };
  };
  if (document.documentElement) install();
  document.addEventListener('DOMContentLoaded', install);
  // Last time the app's DOM changed (our cursor/ripple excluded) — read by settle().
  window.__demoLastMutation = Date.now();
  const ours = (m) => {
    if (m.target.id === '__demo_cursor' || m.target.closest?.('#__demo_cursor')) return true;
    const nodes = [...m.addedNodes, ...m.removedNodes];
    return nodes.length > 0 && nodes.every((n) => n.classList?.contains('__demo_ripple') || n.id === '__demo_style' || n.id === '__demo_cursor');
  };
  new MutationObserver((list) => { if (!list.every(ours)) window.__demoLastMutation = Date.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}
