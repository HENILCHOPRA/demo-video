// Shared helpers for the demo-video pipeline.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(SCRIPTS_DIR, '..');
export const ASSETS = path.join(SKILL_DIR, 'assets');

/** The app's repo: DEMO_PROJECT_ROOT, else the git toplevel of cwd, else cwd. Brand files and asset paths resolve against it. */
export const PROJECT_ROOT = (() => {
  if (process.env.DEMO_PROJECT_ROOT) return path.resolve(process.env.DEMO_PROJECT_ROOT);
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : process.cwd();
})();

// Delivery colour: limited-range BT.709 (what players and platforms assume for HD). The screencast and card
// frames are full-range BT.601 JPEGs; left as-is (yuvj420p, "pc") many players show the video washed out.
export const TO_BT709 = 'scale=out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
export const BT709_TAGS = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];

export const FORMATS = {
  landscape: { width: 1920, height: 1080, viewport: { width: 1280, height: 720 }, dsf: 2, mobile: false },
  vertical: { width: 1080, height: 1920, viewport: { width: 430, height: 764 }, dsf: 3, mobile: true },
};

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

export function loadPlan(outDir) {
  const p = path.join(outDir, 'shots.json');
  if (!fs.existsSync(p)) die(`missing ${p}`);
  const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
  plan.format ||= 'landscape';
  if (!FORMATS[plan.format]) die(`unknown format ${plan.format}`);
  plan.fps ||= 30;
  plan.voice ||= 'brian';
  plan.form ||= 'short';
  plan.captions ||= plan.form === 'short' ? 'burn' : 'sidecar';
  return { plan, fmt: FORMATS[plan.format], brand: loadBrand() };
}

const DEFAULT_BRAND = {
  name: null,
  url: null,
  tagline: null,
  colors: { primary: '#1e293b', deep: '#0f172a', accent: '#38bdf8' },
  font: null,
  fontFamily: null,
  logo: null,
  icon: null,
  locale: 'en-US',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  disclaimer: null,
  login: { path: '/login', email: 'input[type="email"]', password: 'input[type="password"]', submit: 'button[type="submit"]' },
  envFiles: ['.env', '.env.local'],
  music: null,
};

let brandCache;
/** <project>/.demo-video/brand.json merged over neutral defaults; asset paths resolved and checked. */
export function loadBrand() {
  if (brandCache) return brandCache;
  const file = path.join(PROJECT_ROOT, '.demo-video', 'brand.json');
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const b = { ...DEFAULT_BRAND, ...user, colors: { ...DEFAULT_BRAND.colors, ...user.colors } };
  if (user.login !== false) b.login = { ...DEFAULT_BRAND.login, ...user.login };
  for (const k of ['font', 'logo', 'icon', 'music']) {
    if (!b[k]) continue;
    b[k] = path.resolve(PROJECT_ROOT, b[k]);
    if (!fs.existsSync(b[k])) die(`brand.${k} not found: ${b[k]} (from ${file})`);
  }
  for (const [k, v] of Object.entries(b.colors)) if (!/^#[0-9a-f]{6}$/i.test(v)) die(`brand.colors.${k} must be #rrggbb, got ${v}`);
  if (b.font && !b.fontFamily) b.fontFamily = fontFamilyOf(b.font);
  return (brandCache = b);
}

/** Family name from a TTF/OTF `name` table (libass matches captions by family, not file name). */
function fontFamilyOf(file) {
  try {
    const buf = fs.readFileSync(file);
    const numTables = buf.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (buf.toString('latin1', rec, rec + 4) !== 'name') continue;
      const tbl = buf.readUInt32BE(rec + 8);
      const count = buf.readUInt16BE(tbl + 2), strings = tbl + buf.readUInt16BE(tbl + 4);
      const found = {};
      for (let j = 0; j < count; j++) {
        const r = tbl + 6 + j * 12;
        const platform = buf.readUInt16BE(r), nameId = buf.readUInt16BE(r + 6);
        if ((nameId !== 1 && nameId !== 16) || found[nameId]) continue;
        const at = strings + buf.readUInt16BE(r + 10);
        const raw = Buffer.from(buf.subarray(at, at + buf.readUInt16BE(r + 8)));
        found[nameId] = platform === 1 ? raw.toString('latin1') : raw.swap16().toString('utf16le');
      }
      if (found[16] || found[1]) return found[16] || found[1];
    }
  } catch {}
  die(`could not read a font family name from ${file} — set brand.fontFamily`);
}

/** #rrggbb → ffmpeg colour (0xrrggbb). */
export const ffColor = (hex) => `0x${hex.slice(1)}`;
/** #rrggbb + alpha (0 opaque … 255 clear) → ASS &HAABBGGRR. */
export const assColor = (hex, alpha = 0) =>
  `&H${[alpha.toString(16).padStart(2, '0'), hex.slice(5, 7), hex.slice(3, 5), hex.slice(1, 3)].join('').toUpperCase()}`;

export function workDir(outDir, ...sub) {
  const d = path.join(outDir, 'work', ...sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** OPENROUTER_API_KEY from the environment, else the brand's envFiles in the project. Never printed. */
export function openrouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  const files = loadBrand().envFiles.map((f) => path.resolve(PROJECT_ROOT, f));
  for (const envFile of files) {
    if (!fs.existsSync(envFile)) continue;
    const m = fs.readFileSync(envFile, 'utf8').match(/^\s*OPENROUTER_API_KEY\s*=\s*["']?([^"'\r\n]+)/m);
    if (m) return m[1].trim();
  }
  die(`OPENROUTER_API_KEY not set (env or ${files.map((f) => path.relative(PROJECT_ROOT, f)).join(', ')})`);
}

export function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) {
    const tail = (r.stderr || '').split('\n').slice(-25).join('\n');
    die(`${cmd} failed (${r.status}):\n${tail}`);
  }
  return r.stdout;
}

export function ffmpeg(argv, opts) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], opts);
}

export function duration(file) {
  return parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const r3 = (n) => Math.round(n * 1000) / 1000;

/** Brag's music library, resolved from the installed plugin (not redistributed here). */
export function bragMusicDir() {
  const base = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'brag', 'brag');
  if (!fs.existsSync(base)) return null;
  const versions = fs.readdirSync(base).sort().reverse();
  for (const v of versions) {
    const d = path.join(base, v, 'skills', 'brag', 'assets', 'music');
    if (fs.existsSync(d)) return d;
  }
  return null;
}

/**
 * Turn a shots.json target into a Playwright locator.
 * { role, name, exact } | { text } | { placeholder } | { label } | { title } | { css }
 * plus optional { within: <target>, nth: n, hasText }. Hidden matches (e.g. the
 * mobile copy of a desktop control) are skipped unless { visible: false }.
 */
export function locate(page, t) {
  if (!t) throw new Error('action has no target');
  let root = t.within ? locate(page, t.within) : page;
  let loc;
  if (t.role) loc = root.getByRole(t.role, { name: t.name, exact: t.exact ?? false });
  else if (t.text) loc = root.getByText(t.text, { exact: t.exact ?? false });
  else if (t.placeholder) loc = root.getByPlaceholder(t.placeholder, { exact: t.exact ?? false });
  else if (t.label) loc = root.getByLabel(t.label, { exact: t.exact ?? false });
  else if (t.title) loc = root.getByTitle(t.title, { exact: t.exact ?? false });
  else if (t.css) loc = root.locator(t.css);
  else throw new Error(`unrecognised target ${JSON.stringify(t)}`);
  if (t.hasText) loc = loc.filter({ hasText: t.hasText });
  if (t.visible !== false) loc = loc.filter({ visible: true });
  return t.nth !== undefined ? loc.nth(t.nth) : loc.first();
}

export function describe(t) {
  if (!t) return '';
  const base = t.role ? `${t.role}("${t.name ?? ''}")` : t.text ? `text("${t.text}")` : t.placeholder ? `placeholder("${t.placeholder}")`
    : t.label ? `label("${t.label}")` : t.title ? `title("${t.title}")` : `css(${t.css})`;
  return t.within ? `${describe(t.within)} >> ${base}` : base;
}

/** Strip eleven-v4 inline audio tags like [warmly] for display/captions. */
export const stripTags = (s) => s.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
