// Voiceover: shots.json → per-shot TTS (elevenlabs/eleven-v4) + word timings (elevenlabs/scribe-v2) via OpenRouter.
// Usage: node voice.mjs <out-dir> [--only s3,s4] [--force]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { args, die, duration, ffmpeg, loadPlan, openrouterKey, r3, stripTags, workDir } from './lib.mjs';

const TTS_MODEL = 'elevenlabs/eleven-v4';
const STT_MODEL = 'elevenlabs/scribe-v2';
const API = 'https://openrouter.ai/api/v1';

const a = args();
const outDir = path.resolve(a._[0] || die('usage: node voice.mjs <out-dir>'));
const { plan } = loadPlan(outDir);
const only = a.only ? new Set(String(a.only).split(',')) : null;
const voDir = workDir(outDir, 'vo');
const key = openrouterKey();
const timingPath = path.join(voDir, 'timing.json');
const timing = fs.existsSync(timingPath) ? JSON.parse(fs.readFileSync(timingPath, 'utf8')) : { shots: {} };

async function post(endpoint, body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${API}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    const text = await res.text();
    if (attempt === 3 || ![429, 500, 502, 503].includes(res.status)) die(`${endpoint} ${res.status}: ${text.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

async function tts(text, file) {
  const res = await post('/audio/speech', { model: TTS_MODEL, input: text, voice: plan.voice, response_format: 'mp3' });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Returns [{w,start,end}] or null when the provider gives no word timestamps. */
async function stt(file) {
  const data = fs.readFileSync(file).toString('base64');
  const res = await post('/audio/transcriptions', {
    model: STT_MODEL,
    input_audio: { data, format: 'mp3' },
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
  });
  const j = await res.json();
  const raw = j.words || (j.segments || []).flatMap((s) => s.words || []);
  const words = raw
    .filter((w) => (w.type ?? 'word') === 'word')
    .map((w) => ({ w: String(w.word ?? w.text ?? '').trim(), start: +w.start, end: +w.end }))
    .filter((w) => w.w && Number.isFinite(w.start));
  return { text: j.text || words.map((w) => w.w).join(' '), words: words.length ? words : null };
}

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
function similarity(a, b) {
  const A = norm(a), B = norm(b);
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++)
    for (let j = 1; j <= B.length; j++)
      dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return A.length ? dp[A.length][B.length] / Math.max(A.length, B.length) : 1;
}

/** Fallback: spread script words across the speech span, weighted by length. */
function estimateWords(text, dur) {
  const ws = stripTags(text).split(/\s+/).filter(Boolean);
  const total = ws.reduce((s, w) => s + w.length + 1, 0);
  let t = 0.1;
  const span = Math.max(0.5, dur - 0.25);
  return ws.map((w) => {
    const d = ((w.length + 1) / total) * span;
    const o = { w, start: r3(t), end: r3(t + d * 0.9) };
    t += d;
    return o;
  });
}

let warnings = 0;
for (const shot of plan.shots) {
  if (!shot.vo || (only && !only.has(shot.id))) continue;
  const hash = crypto.createHash('sha1').update(`${plan.voice}|${shot.vo}`).digest('hex').slice(0, 12);
  const mp3 = path.join(voDir, `${shot.id}.mp3`);
  const prev = timing.shots[shot.id];
  if (!a.force && prev?.hash === hash && fs.existsSync(mp3)) {
    console.log(`${shot.id}: cached (${prev.duration}s)`);
    continue;
  }
  process.stdout.write(`${shot.id}: tts… `);
  const rawMp3 = path.join(voDir, `${shot.id}.raw.mp3`);
  await tts(shot.vo, rawMp3);
  // Trim leading/trailing silence so shot pacing is driven by speech, not padding.
  ffmpeg(['-i', rawMp3, '-af',
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.12,areverse',
    '-c:a', 'libmp3lame', '-q:a', '2', mp3]);
  fs.rmSync(rawMp3);
  const dur = r3(duration(mp3));
  process.stdout.write(`${dur}s · stt… `);
  const tr = await stt(mp3);
  const sim = r3(similarity(stripTags(shot.vo), tr.text));
  const words = tr.words || estimateWords(shot.vo, dur);
  timing.shots[shot.id] = { hash, file: `work/vo/${shot.id}.mp3`, duration: dur, similarity: sim, wordsSource: tr.words ? 'scribe' : 'estimated', transcript: tr.text, words };
  const flag = sim < 0.85 ? '  ⚠ transcript differs from script — listen and re-run with --only ' + shot.id + ' --force' : '';
  if (flag) warnings++;
  console.log(`match ${Math.round(sim * 100)}%${tr.words ? '' : ' (no word timestamps; estimated)'}${flag}`);
  fs.writeFileSync(timingPath, JSON.stringify(timing, null, 2));
}

const total = plan.shots.reduce((s, sh) => s + (timing.shots[sh.id]?.duration || 0), 0);
console.log(`\nVO total ${r3(total)}s across ${Object.keys(timing.shots).length} shots → ${path.relative(process.cwd(), timingPath)}`);
if (warnings) console.log(`${warnings} shot(s) need a listen.`);
