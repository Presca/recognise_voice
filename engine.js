"use strict";

/*
 * Analysis engine.
 *
 * Pipeline (kept strictly in this order, per the vocal-analysis spec):
 *   1. measure acoustic properties frame by frame,
 *   2. segment into phrases / notes and build distributions,
 *   3. derive perceptual scores (0–100) from those measurements,
 *   4. derive technique / delivery tags,
 *   5. compare against the singer dataset along four separate dimensions.
 *
 * Anything that cannot be measured reliably from a single a cappella line
 * recorded on a consumer microphone is reported as { value: null, confidence: 0 }
 * with a reason, never estimated.
 */

/* ---------- Note helpers ---------- */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function midiToNote(midi) {
  const m = Math.round(midi);
  return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
}

function noteToMidi(note) {
  const match = /^([A-G]#?)(-?\d)$/.exec(note);
  if (!match) throw new Error("Bad note: " + note);
  return NOTE_NAMES.indexOf(match[1]) + (parseInt(match[2], 10) + 1) * 12;
}

/* ---------- Small maths ---------- */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const scale = (v, lo, hi) => clamp01((v - lo) / (hi - lo));

function round(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v) || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function distribution(values, digits = 1) {
  const clean = values.filter((v) => v !== null && Number.isFinite(v));
  if (!clean.length) return null;
  const s = [...clean].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: round(mean(s), digits),
    median: round(percentile(s, 0.5), digits),
    sd: round(sd(s) || 0, digits),
    min: round(s[0], digits),
    max: round(s[s.length - 1], digits),
    p10: round(percentile(s, 0.1), digits),
    p25: round(percentile(s, 0.25), digits),
    p75: round(percentile(s, 0.75), digits),
    p90: round(percentile(s, 0.9), digits),
  };
}

function slope(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}

function measured(value, confidence, method, extra = {}) {
  return { value, confidence: round(confidence, 2), method, ...extra };
}

function unmeasured(reason) {
  return { value: null, confidence: 0, reason };
}

function labelFor(score, labels) {
  // labels: five labels for 0–20, 21–40, 41–60, 61–80, 81–100
  if (score === null) return null;
  return labels[Math.min(4, Math.floor(Math.max(0, score - 0.001) / 20))];
}

/* ---------- Frame-level measurement ---------- */

// Autocorrelation pitch detector. Returns clarity = normalised autocorrelation
// at the chosen period, which behaves like a periodicity / HNR proxy.
function detectPitch(buf, sampleRate) {
  const n = buf.length;
  let energy = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = buf[i];
    energy += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(energy / n);
  if (rms < 0.01 || energy === 0) return { freq: -1, rms, clarity: 0, peak };

  const minLag = Math.floor(sampleRate / 1400);
  const maxLag = Math.min(n - 2, Math.ceil(sampleRate / 60));
  const r = new Float32Array(maxLag + 2);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let j = 0; j < n - lag; j++) sum += buf[j] * buf[j + lag];
    const v = (sum / energy) * (n / (n - lag));
    r[lag] = v;
    if (v > best) best = v;
  }
  if (best < 0.3) return { freq: -1, rms, clarity: best, peak };

  // The first peak nearly as tall as the tallest one avoids octave-low errors.
  let T0 = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] >= 0.85 * best) { T0 = lag; break; }
  }
  if (T0 < 0) return { freq: -1, rms, clarity: best, peak };

  const x1 = r[T0 - 1];
  const x2 = r[T0];
  const x3 = r[T0 + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  const period = a ? T0 - b / (2 * a) : T0;
  return { freq: sampleRate / period, rms, clarity: Math.min(1, x2), peak };
}

// Spectral descriptors from a dB magnitude spectrum.
function spectralFeatures(db, binHz, f0) {
  const nBins = db.length;
  const power = new Float32Array(nBins);
  let total = 0;
  let weighted = 0;
  let low = 0, lowMid = 0, high = 0, vhigh = 0, e100to1k = 0, e1kto4k = 0;

  for (let i = 1; i < nBins; i++) {
    const f = i * binHz;
    if (f < 60 || f > 10000) continue;
    const p = 10 ** (db[i] / 10);
    if (!Number.isFinite(p)) continue;
    power[i] = p;
    total += p;
    weighted += f * p;
    if (f < 500) low += p;
    else if (f < 2000) lowMid += p;
    else if (f < 4000) high += p;
    else if (f < 8000) vhigh += p;
    if (f >= 100 && f < 1000) e100to1k += p;
    else if (f >= 1000 && f < 4000) e1kto4k += p;
  }
  if (!total) return null;

  let cum = 0;
  let rolloff = 0;
  for (let i = 1; i < nBins; i++) {
    cum += power[i];
    if (cum >= 0.85 * total) { rolloff = i * binHz; break; }
  }

  let h1h2 = null;
  if (f0 > 0) {
    const peakDb = (f) => {
      const w = Math.max(1.5 * binHz, f * 0.12);
      const lo = Math.max(1, Math.floor((f - w) / binHz));
      const hi = Math.min(nBins - 1, Math.ceil((f + w) / binHz));
      let m = -Infinity;
      for (let i = lo; i <= hi; i++) if (db[i] > m) m = db[i];
      return m;
    };
    const h1 = peakDb(f0);
    const h2 = peakDb(2 * f0);
    if (Number.isFinite(h1) && Number.isFinite(h2)) h1h2 = h1 - h2;
  }

  return {
    centroid: weighted / total,
    rolloff,
    lowShare: low / total,
    lowMidShare: lowMid / total,
    highShare: high / total,
    vhighShare: vhigh / total,
    tilt: e100to1k > 0 && e1kto4k > 0 ? 10 * Math.log10(e100to1k / e1kto4k) : null,
    h1h2,
  };
}

/* ---------- Recorder ---------- */

const FRAME_MS = 25;

class VoiceRecorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.timer = null;
    this.samples = [];
    this.startedAt = 0;
  }

  async start(onFrame) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);

    const timeData = new Float32Array(this.analyser.fftSize);
    const freqData = new Float32Array(this.analyser.frequencyBinCount);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    // Pitch uses the most recent 2048 samples (~43 ms); the spectrum uses the
    // full 4096 window for better harmonic resolution.
    const pitchWindow = timeData.subarray(timeData.length - 2048);

    this.samples = [];
    this.startedAt = performance.now();

    // Keep the raw audio so the user can replay what was analysed.
    this.blobPromise = null;
    this.mediaRecorder = null;
    if (window.MediaRecorder) {
      const chunks = [];
      const mr = new MediaRecorder(this.stream);
      this.mediaRecorder = mr;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      this.blobPromise = new Promise((resolve) => {
        mr.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: mr.mimeType || "audio/webm" }) : null);
        mr.onerror = () => resolve(null);
      });
      mr.start();
    }

    this.timer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(timeData);
      this.analyser.getFloatFrequencyData(freqData);

      const { freq, rms, clarity, peak } = detectPitch(pitchWindow, this.ctx.sampleRate);
      const spec = spectralFeatures(freqData, binHz, freq);
      const sample = { t: performance.now() - this.startedAt, freq, rms, clarity, peak, spec };
      this.samples.push(sample);
      if (onFrame) onFrame(sample);
    }, FRAME_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop();
    this.mediaRecorder = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close();
    this.stream = null;
    this.ctx = null;
    return this.samples;
  }

  elapsed() {
    return performance.now() - this.startedAt;
  }
}

/* ---------- Segmentation ---------- */

function segmentPhrases(samples, dt) {
  const gapLimit = Math.round(0.25 / dt);
  const phrases = [];
  let current = null;
  let lastVoiced = -1;

  samples.forEach((s, i) => {
    if (s.voiced) {
      if (!current) current = { idxs: [], microGaps: 0 };
      else if (i - lastVoiced > 1) current.microGaps++;
      current.idxs.push(i);
      lastVoiced = i;
    } else if (current && i - lastVoiced > gapLimit) {
      phrases.push(current);
      current = null;
    }
  });
  if (current) phrases.push(current);

  phrases.forEach((p) => {
    p.startT = samples[p.idxs[0]].t / 1000;
    p.endT = samples[p.idxs[p.idxs.length - 1]].t / 1000 + dt;
    p.dur = p.endT - p.startT;
    p.groups = segmentNotes(samples, p.idxs, dt);
    p.notes = p.groups.filter((g) => g.kept);
  });
  return phrases;
}

// Groups consecutive voiced frames into notes. A new group starts when the
// pitch moves more than 0.7 semitone away from the recent frames and stays
// there for two frames (so vibrato peaks do not split a note).
// Groups shorter than three frames are transitional (slides, consonants) and
// are not kept as notes.
function segmentNotes(samples, idxs, dt) {
  const groups = [];
  let cur = null;
  idxs.forEach((idx, k) => {
    const m = samples[idx].midi;
    if (cur) {
      // Eight frames ≈ one vibrato cycle, so the reference sits at the note centre.
      const recent = cur.idxs.slice(-8).map((i) => samples[i].midi);
      const ref = mean(recent);
      const next = idxs[k + 1] !== undefined ? samples[idxs[k + 1]].midi : m;
      if (Math.abs(m - ref) > 0.7 && Math.abs(next - ref) > 0.7) {
        groups.push(cur);
        cur = null;
      }
    }
    if (!cur) cur = { idxs: [] };
    cur.idxs.push(idx);
  });
  if (cur) groups.push(cur);

  return groups.map((g) => {
    const midis = g.idxs.map((i) => samples[i].midi);
    const meanMidi = mean(midis);
    return {
      idxs: g.idxs,
      kept: g.idxs.length >= 3,
      startT: samples[g.idxs[0]].t / 1000,
      dur: g.idxs.length * dt,
      meanMidi,
      midis,
      cents: midis.map((m) => (m - meanMidi) * 100),
      rms: g.idxs.map((i) => samples[i].rms),
      clarity: g.idxs.map((i) => samples[i].clarity),
    };
  });
}

/* ---------- Vibrato ---------- */

function analyseVibrato(note, dt) {
  if (note.dur < 0.4) return null;
  const t = note.cents.map((_, k) => k * dt);
  const s = slope(t, note.cents);
  const mt = mean(t);
  const mc = mean(note.cents);
  const d = note.cents.map((v, k) => v - (mc + s * (t[k] - mt)));

  // Hysteresis peak picking: alternating extrema at least `thr` cents apart.
  const thr = 12;
  const ext = [];
  let dir = 0;
  let cand = { k: 0, v: d[0] };
  for (let k = 1; k < d.length; k++) {
    const v = d[k];
    if (dir >= 0) {
      if (v > cand.v) cand = { k, v };
      else if (cand.v - v > thr) { ext.push(cand); dir = -1; cand = { k, v }; continue; }
    }
    if (dir < 0) {
      if (v < cand.v) cand = { k, v };
      else if (v - cand.v > thr) { ext.push(cand); dir = 1; cand = { k, v }; }
    }
  }

  if (ext.length < 6) return { present: false, cycles: Math.floor(ext.length / 2) };

  const halfPeriods = [];
  const extents = [];
  for (let i = 1; i < ext.length; i++) {
    halfPeriods.push((ext[i].k - ext[i - 1].k) * dt);
    extents.push(Math.abs(ext[i].v - ext[i - 1].v));
  }
  const hp = mean(halfPeriods);
  const rateHz = 1 / (2 * hp);
  const extentCents = mean(extents);
  const regularityCv = (sd(halfPeriods) || 0) / hp;
  const present = rateHz >= 3.5 && rateHz <= 8.5 && extentCents >= 30 && regularityCv < 0.45;
  return { present, rateHz, extentCents, regularityCv, onsetDelay: ext[0].k * dt, cycles: Math.floor(ext.length / 2) };
}

/* ---------- Recording assessment ---------- */

function assessRecording(samples, voiced, dt) {
  const unvoicedRms = samples.filter((s) => !s.voiced).map((s) => s.rms).sort((a, b) => a - b);
  const noiseFloor = Math.max(0.0005, unvoicedRms.length ? percentile(unvoicedRms, 0.2) : 0.002);
  const signal = percentile(voiced.map((s) => s.rms).sort((a, b) => a - b), 0.5);
  const snrDb = 20 * Math.log10(signal / noiseFloor);
  const clipping = samples.filter((s) => s.peak > 0.98).length / samples.length;
  const usableSeconds = voiced.length * dt;
  const quality = scale(snrDb, 8, 30) * (1 - clamp01(clipping * 10));
  // A single performance context caps how much any one line can tell us.
  const base = Math.min(0.85, quality * scale(usableSeconds, 1.5, 8));
  return {
    snr_db: round(snrDb, 1),
    noise_floor_rms: round(noiseFloor, 4),
    clipping_pct: round(clipping * 100, 1),
    usable_singing_seconds: round(usableSeconds, 1),
    quality_score: round(quality, 2),
    base_confidence: round(base, 2),
    context: "single a cappella line, browser microphone, processing unknown",
    base,
  };
}

/* ---------- Voice type ---------- */

const VOICE_TYPES = [
  { max: 47, type: "Bass",          desc: "a deep, resonant low voice" },
  { max: 52, type: "Bass-baritone", desc: "a rich low voice with baritone reach" },
  { max: 56, type: "Baritone",      desc: "a warm, full mid-low voice" },
  { max: 60, type: "Tenor",         desc: "a strong mid-high voice" },
  { max: 64, type: "Alto",          desc: "a rich, grounded lower-mid voice" },
  { max: 68, type: "Mezzo-soprano", desc: "a versatile middle-to-high voice" },
  { max: Infinity, type: "Soprano", desc: "a bright, high voice" },
];

function classifyVoice(medianMidi) {
  return VOICE_TYPES.find((v) => medianMidi <= v.max);
}

// Voice type from range extremes rather than from where one line happened to
// sit. Templates are conventional comfortable ranges; a take is scored on how
// well its span fits inside a template and how close their centres are.
const VOICE_TEMPLATES = [
  { type: "Bass",          low: 40, high: 64 }, // E2–E4
  { type: "Bass-baritone", low: 43, high: 67 }, // G2–G4
  { type: "Baritone",      low: 45, high: 69 }, // A2–A4
  { type: "Tenor",         low: 48, high: 72 }, // C3–C5
  { type: "Alto",          low: 53, high: 77 }, // F3–F5
  { type: "Mezzo-soprano", low: 57, high: 81 }, // A3–A5
  { type: "Soprano",       low: 60, high: 84 }, // C4–C6
];

function classifyVoiceRange(low, high) {
  const centre = (low + high) / 2;
  const span = Math.max(1, high - low);
  let best = null;
  VOICE_TEMPLATES.forEach((t) => {
    const overlap = Math.max(0, Math.min(high, t.high) - Math.max(low, t.low));
    const coverage = overlap / span;
    const centreFit = 1 - Math.min(1, Math.abs(centre - (t.low + t.high) / 2) / 12);
    const belowPenalty = low < t.low - 2 ? (t.low - 2 - low) / 12 : 0;
    const abovePenalty = high > t.high + 2 ? (high - t.high - 2) / 12 : 0;
    const score = 0.5 * centreFit + 0.5 * coverage - belowPenalty - abovePenalty;
    if (!best || score > best.score) best = { type: t.type, score };
  });
  return { type: best.type, desc: VOICE_TYPES.find((v) => v.type === best.type).desc };
}

// Lowest / highest reliably sung notes in a take (3rd–97th percentile).
function takeExtremes(samples) {
  const midis = samples
    .filter((s) => s.freq >= 60 && s.freq <= 1400 && s.rms > 0.015 && s.clarity >= 0.6)
    .map((s) => freqToMidi(s.freq))
    .sort((a, b) => a - b);
  if (midis.length < 12) return null;
  return { low: percentile(midis, 0.03), high: percentile(midis, 0.97) };
}

/* ---------- Main analysis ---------- */

const BRIGHTNESS_LABELS = ["very dark", "dark", "neutral", "bright", "very bright"];
const WEIGHT_LABELS = ["very light", "light", "medium", "heavy", "very heavy"];
const WARMTH_LABELS = ["cold", "cool", "neutral", "warm", "very warm"];
const BREATHINESS_LABELS = ["clear", "slightly breathy", "moderately breathy", "breathy", "very breathy"];
const ROUGHNESS_LABELS = ["smooth", "mostly smooth", "slightly rough", "raspy", "very raspy"];

// options.rangeSamples: frames from a low-to-high "ahh" slide (range check)
// options.history:      { low, high } extremes remembered from earlier takes
function analyseSamples(samples, options = {}) {
  if (samples.length < 4) return null;
  const dts = [];
  for (let i = 1; i < samples.length; i++) dts.push(samples[i].t - samples[i - 1].t);
  const dt = (percentile(dts.sort((a, b) => a - b), 0.5) || FRAME_MS) / 1000;

  samples.forEach((s) => {
    s.voiced = s.freq >= 60 && s.freq <= 1400 && s.rms > 0.015 && s.clarity >= 0.6 && !!s.spec;
    s.midi = s.voiced ? freqToMidi(s.freq) : null;
  });
  const voiced = samples.filter((s) => s.voiced);
  if (voiced.length < 20) return null;

  const rec = assessRecording(samples, voiced, dt);
  const base = rec.base;
  const phrases = segmentPhrases(samples, dt);
  const notes = phrases.flatMap((p) => p.notes);
  const sungSeconds = voiced.length * dt;
  const limitations = [
    "Measured from one short a cappella line; singer-level stability across songs is unknown.",
    "Microphone frequency response, room and browser audio processing are uncorrected, so spectral scores are relative, not absolute.",
  ];

  /* --- 1. F0, range, tessitura --- */
  const midis = voiced.map((s) => s.midi);
  const sortedMidi = [...midis].sort((a, b) => a - b);
  const p = (q) => percentile(sortedMidi, q);
  const low5 = p(0.05), high95 = p(0.95), median = p(0.5), q1 = p(0.25), q3 = p(0.75);
  const minMidi = sortedMidi[0], maxMidi = sortedMidi[sortedMidi.length - 1];
  const thirds = { lower: 0, middle: 0, upper: 0 };
  midis.forEach((m) => {
    const pos = (m - low5) / Math.max(0.01, high95 - low5);
    if (pos < 1 / 3) thirds.lower++; else if (pos < 2 / 3) thirds.middle++; else thirds.upper++;
  });

  // Within-note pitch stability (cents), excluding note edges.
  const noteDeviations = [];
  const jitters = [];
  const claritySds = [];
  notes.forEach((n) => {
    const inner = n.cents.slice(1, -1);
    inner.forEach((c) => noteDeviations.push(Math.abs(c)));
    // Second difference removes slow drift and vibrato, leaving cycle-to-cycle irregularity.
    for (let k = 2; k < n.midis.length; k++) {
      const f0 = midiToFreq(n.midis[k - 1]);
      const second = midiToFreq(n.midis[k]) - 2 * f0 + midiToFreq(n.midis[k - 2]);
      jitters.push(Math.abs(second) / 2 / f0);
    }
    if (n.clarity.length >= 3) claritySds.push(sd(n.clarity));
  });
  const stabilityCents = noteDeviations.length ? percentile([...noteDeviations].sort((a, b) => a - b), 0.5) : null;
  const steadiness = stabilityCents === null ? "unknown" : stabilityCents < 20 ? "steady" : stabilityCents < 45 ? "expressive" : "free";

  /* --- 2. Spectral / harmonic --- */
  const specs = voiced.map((s) => s.spec);
  const centroidDist = distribution(specs.map((s) => s.centroid), 0);
  const hfShare = specs.map((s) => s.highShare + s.vhighShare);
  const lowShare = specs.map((s) => s.lowShare);
  const lowMidShare = specs.map((s) => s.lowMidShare);
  const tilts = specs.map((s) => s.tilt).filter((v) => v !== null);
  const h1h2s = specs.map((s) => s.h1h2).filter((v) => v !== null);
  const hnrs = voiced.map((s) => {
    const r = Math.min(0.999, s.clarity);
    return Math.max(-5, Math.min(30, 10 * Math.log10(r / (1 - r))));
  });
  const med = (arr) => percentile([...arr].sort((a, b) => a - b), 0.5);
  const centroidMed = centroidDist.median;
  const hfMed = med(hfShare), lowMed = med(lowShare), lowMidMed = med(lowMidShare);
  const tiltMed = tilts.length ? med(tilts) : null;
  const h1h2Med = h1h2s.length ? med(h1h2s) : null;
  const hnrMed = med(hnrs);

  /* --- 3. Vibrato --- */
  const sustained = notes.filter((n) => n.dur >= 0.4);
  const vibratos = sustained.map((n) => ({ note: n, v: analyseVibrato(n, dt) })).filter((x) => x.v);
  const withVib = vibratos.filter((x) => x.v.present);
  const vibPct = sustained.length ? (withVib.length / sustained.length) * 100 : null;
  const vibRate = withVib.length ? med(withVib.map((x) => x.v.rateHz)) : null;
  const vibExtent = withVib.length ? med(withVib.map((x) => x.v.extentCents)) : null;
  const vibOnsetShare = withVib.length ? mean(withVib.map((x) => x.v.onsetDelay / x.note.dur)) : null;
  const vibratoStyle = [];
  if (sustained.length) {
    if (vibPct < 25) vibratoStyle.push("straight-tone dominant");
    else {
      vibratoStyle.push(vibExtent < 60 ? "subtle vibrato" : vibExtent < 120 ? "moderate vibrato" : "pronounced vibrato");
      vibratoStyle.push(vibRate < 5 ? "slow vibrato" : vibRate > 6.5 ? "fast vibrato" : "medium-rate vibrato");
      if (vibOnsetShare > 0.4) vibratoStyle.push("delayed vibrato");
    }
  }
  const vibratoStrength = sustained.length
    ? Math.round(100 * clamp01((vibPct / 100) * 0.6 + (vibExtent ? scale(vibExtent, 20, 140) : 0) * 0.4))
    : null;

  /* --- 4. Dynamics, attack, release --- */
  const dbs = voiced.map((s) => 20 * Math.log10(s.rms));
  const dbDist = distribution(dbs, 1);
  const dynamicRange = dbDist.p90 - dbDist.p10;
  const expressiveness = Math.round(100 * scale(dynamicRange, 4, 18));
  let crescendos = 0, decrescendos = 0;
  phrases.forEach((ph) => {
    if (ph.dur < 0.6) return;
    const xs = ph.idxs.map((i) => samples[i].t / 1000);
    const ys = ph.idxs.map((i) => 20 * Math.log10(samples[i].rms));
    const sl = slope(xs, ys);
    if (sl > 3) crescendos++; else if (sl < -3) decrescendos++;
  });

  const onsets = [];
  const releases = [];
  phrases.forEach((ph) => {
    const first = ph.idxs[0];
    const win = samples.slice(Math.max(0, first - 2), first + 8);
    const peakRms = Math.max(...win.map((s) => s.rms));
    const i20 = win.findIndex((s) => s.rms >= 0.2 * peakRms);
    const i80 = win.findIndex((s) => s.rms >= 0.8 * peakRms);
    const aspirated = samples[first].clarity < 0.7 || (samples[first - 1] && samples[first - 1].rms > 0.015 && samples[first - 1].clarity < 0.5);
    onsets.push({ riseMs: Math.max(0, i80 - i20) * dt * 1000 + dt * 500, aspirated });

    const last = ph.idxs[ph.idxs.length - 1];
    const tail = samples.slice(Math.max(0, last - 7), last + 4);
    const peakTail = Math.max(...tail.map((s) => s.rms));
    let k80 = -1, k20 = -1;
    tail.forEach((s, k) => { if (s.rms >= 0.8 * peakTail) k80 = k; });
    for (let k = k80; k < tail.length; k++) if (tail[k].rms <= 0.2 * peakTail) { k20 = k; break; }
    const fallMs = k20 < 0 ? tail.length * dt * 1000 : (k20 - k80) * dt * 1000;
    const lastNote = ph.notes[ph.notes.length - 1];
    let endSlide = null;
    if (lastNote && lastNote.cents.length >= 6) {
      const tailCents = lastNote.cents.slice(-6);
      const drop = tailCents[tailCents.length - 1] - tailCents[0];
      endSlide = drop < -80 ? "down" : drop > 80 ? "up" : null;
    }
    const vibEnd = lastNote && withVib.some((x) => x.note === lastNote);
    releases.push({ fallMs, endSlide, vibEnd });
  });
  const riseMs = onsets.length ? med(onsets.map((o) => o.riseMs)) : null;
  const softOnsetPct = onsets.length ? (onsets.filter((o) => o.riseMs > 100).length / onsets.length) * 100 : null;
  const aspiratedPct = onsets.length ? (onsets.filter((o) => o.aspirated).length / onsets.length) * 100 : null;
  const attackLabel = riseMs === null ? null : riseMs > 100 ? (aspiratedPct > 50 ? "breathy" : "soft") : riseMs > 50 ? "balanced" : "firm";
  const fallMs = releases.length ? med(releases.map((r) => r.fallMs)) : null;
  const releaseLabels = [];
  if (fallMs !== null) {
    releaseLabels.push(fallMs < 60 ? "abrupt" : fallMs < 150 ? "clean" : "fading");
    const downs = releases.filter((r) => r.endSlide === "down").length;
    if (downs / releases.length >= 0.4) releaseLabels.push("downward slide");
    if (releases.filter((r) => r.vibEnd).length / releases.length >= 0.4) releaseLabels.push("vibrato-ending");
  }

  /* --- 5. Pitch expression & ornamentation --- */
  let scoops = 0, overshoots = 0, slidesUp = 0, slidesDown = 0, runs = 0;
  notes.forEach((n) => {
    if (n.dur < 0.2 || n.cents.length < 6) return;
    const steady = mean(n.midis.slice(Math.min(4, n.midis.length - 2)));
    const head = mean(n.midis.slice(0, 3));
    const diff = (head - steady) * 100;
    if (diff < -70) scoops++;
    else if (diff > 60) overshoots++;
  });
  phrases.forEach((ph) => {
    const g = ph.groups;
    for (let i = 0, prevKept = -1; i < g.length; i++) {
      if (!g[i].kept) continue;
      if (prevKept >= 0) {
        const transitional = g.slice(prevKept + 1, i).reduce((a, x) => a + x.idxs.length, 0);
        const delta = g[i].meanMidi - g[prevKept].meanMidi;
        if (transitional >= 1 && Math.abs(delta) >= 1.5) { if (delta > 0) slidesUp++; else slidesDown++; }
      }
      prevKept = i;
    }
    // A run: three or more short, distinct consecutive notes.
    let streak = 0;
    ph.notes.forEach((n, i) => {
      const short = n.dur <= 0.18 && (i === 0 || Math.abs(n.meanMidi - ph.notes[i - 1].meanMidi) >= 0.8);
      streak = short ? streak + 1 : 0;
      if (streak === 3) runs++;
    });
  });
  const ornamentEvents = scoops + slidesUp + slidesDown + 2 * runs + overshoots;
  const ornamentPer10s = ornamentEvents / Math.max(1, sungSeconds / 10);
  const ornamentationDensity = Math.round(100 * scale(ornamentPer10s, 0, 12));
  const ornamentationStyle = ornamentationDensity < 15 ? "minimal" : ornamentationDensity < 35 ? "restrained" : ornamentationDensity < 60 ? "moderate" : "melismatic";

  /* --- 6. Phrasing --- */
  const noteCount = notes.length;
  const microGaps = phrases.reduce((a, ph) => a + ph.microGaps, 0);
  const legatoRatio = noteCount > 1 ? clamp01(1 - microGaps / (noteCount - 1)) : null;
  const notesPerSec = noteCount / Math.max(0.5, sungSeconds);
  const meanNoteDur = noteCount ? mean(notes.map((n) => n.dur)) : null;
  const phrasingLabel = legatoRatio === null ? null : legatoRatio >= 0.8 ? "legato" : legatoRatio >= 0.6 ? "flowing" : legatoRatio >= 0.4 ? "conversational" : "clipped";

  /* --- 7. Perceptual derivations (0–100) --- */
  const centroidRatio = centroidMed / midiToFreq(median); // centroid in multiples of the sung pitch
  const brightness = Math.round(100 * (0.55 * scale(centroidRatio, 2.5, 9) + 0.45 * scale(hfMed, 0.03, 0.4)));
  const weight = Math.round(100 * (
    0.45 * scale(lowMed, 0.15, 0.75) +
    0.25 * (tiltMed === null ? 0.5 : scale(tiltMed, -5, 25)) +
    0.30 * (1 - scale(median, 45, 72))
  ));
  const breathInputs = [
    [0.5, 1 - scale(hnrMed, 4, 18)],
    [0.2, scale(med(specs.map((s) => s.vhighShare)), 0.02, 0.3)],
  ];
  if (h1h2Med !== null) breathInputs.push([0.3, scale(h1h2Med, 0, 12)]);
  const breathW = breathInputs.reduce((a, [w]) => a + w, 0);
  const breathiness = Math.round(100 * breathInputs.reduce((a, [w, v]) => a + w * v, 0) / breathW);
  const jitterMed = jitters.length ? med(jitters) : null;
  const claritySdMed = claritySds.length ? med(claritySds) : null;
  const roughness = jitterMed === null ? null : Math.round(100 * (
    0.6 * scale(jitterMed, 0.003, 0.03) + 0.4 * (claritySdMed === null ? 0 : scale(claritySdMed, 0.02, 0.15))
  ));
  const warmth = Math.round(100 * (
    0.45 * scale(lowMidMed, 0.15, 0.6) +
    0.30 * (1 - Math.abs(brightness - 45) / 55) +
    0.25 * (1 - (roughness ?? 30) / 100)
  ));
  const airiness = softOnsetPct === null ? null : Math.round(0.6 * breathiness + 0.4 * softOnsetPct);
  const clarityScore = Math.round(100 * scale(hnrMed, 5, 20));
  const fryPct = (samples.filter((s) => s.rms > 0.015 && s.freq > 0 && s.freq < 85 && s.clarity < 0.75).length / voiced.length) * 100;
  const intimacy = Math.round(100 * clamp01(0.4 * breathiness / 100 + 0.35 * ((softOnsetPct ?? 50) / 100) + 0.25 * (1 - expressiveness / 100)));
  const intensity = Math.round(100 * clamp01(0.5 * expressiveness / 100 + 0.3 * ((roughness ?? 20) / 100) + 0.2 * scale(dbDist.p90, -30, -8)));

  // Belt-like: the loudest 15% of frames sit well above the comfort zone with bright spectra.
  const loudCut = percentile([...voiced.map((s) => s.rms)].sort((a, b) => a - b), 0.85);
  const loudHigh = voiced.filter((s) => s.rms >= loudCut);
  const beltLike = loudHigh.length >= 6 &&
    mean(loudHigh.map((s) => s.midi)) > median + 4 &&
    mean(loudHigh.map((s) => s.spec.highShare + s.spec.vhighShare)) > hfMed * 1.2;

  /* --- 8. Tags (shared vocabulary with data.js) --- */
  const techniqueTags = [];
  if (sustained.length) techniqueTags.push(vibPct >= 25 ? "vibrato" : "straight tone");
  if (breathiness >= 55) techniqueTags.push("breathy");
  if (roughness !== null && roughness >= 55) techniqueTags.push("rasp");
  if (attackLabel === "soft" || attackLabel === "breathy") techniqueTags.push("soft onset");
  if (attackLabel === "firm") techniqueTags.push("firm onset");
  if (scoops >= 2) techniqueTags.push("scoops");
  if (slidesUp + slidesDown >= 2) techniqueTags.push("slides");
  if (runs >= 1) techniqueTags.push("runs");
  if (beltLike) techniqueTags.push("belt");
  if (fryPct >= 5) techniqueTags.push("vocal fry");

  const deliveryTags = [];
  if (phrasingLabel) deliveryTags.push(phrasingLabel);
  if (meanNoteDur !== null) deliveryTags.push(meanNoteDur > 0.55 ? "sustained" : notesPerSec > 3 ? "conversational" : null);
  deliveryTags.push(expressiveness >= 55 ? "dynamic" : expressiveness < 30 ? "understated" : "controlled");
  if (intimacy >= 60) deliveryTags.push("intimate");
  if (intensity >= 65) deliveryTags.push("dramatic");
  const delivery = [...new Set(deliveryTags.filter(Boolean))];

  const brightLabel5 = labelFor(brightness, BRIGHTNESS_LABELS);
  const weightLabel5 = labelFor(weight, WEIGHT_LABELS);
  const bright3 = brightness <= 40 ? "dark" : brightness > 60 ? "bright" : "neutral";
  const weight3 = weight <= 40 ? "light" : weight > 60 ? "heavy" : "medium";
  const texture = breathiness >= 55 ? "breathy" : roughness !== null && roughness >= 55 ? "raspy" : warmth >= 55 ? "warm" : warmth <= 40 ? "clear" : "smooth";

  // Range for the voice type: this line, widened by the range check and by
  // earlier takes. The line alone shows the key you picked, not your voice.
  const glide = options.rangeSamples ? takeExtremes(options.rangeSamples) : null;
  const takeLow = Math.min(low5, glide ? glide.low : low5);
  const takeHigh = Math.max(high95, glide ? glide.high : high95);
  const hist = options.history && Number.isFinite(options.history.low) ? options.history : null;
  const rangeLow = Math.min(takeLow, hist ? hist.low : takeLow);
  const rangeHigh = Math.max(takeHigh, hist ? hist.high : takeHigh);
  const rangeSources = [];
  if (glide) rangeSources.push("range check");
  if (hist && hist.takes) rangeSources.push(`${hist.takes} earlier take${hist.takes === 1 ? "" : "s"}`);
  const voice = classifyVoiceRange(rangeLow, rangeHigh);
  const voiceConfident = rangeHigh - rangeLow >= 14;
  const specConf = base * 0.7;

  /* --- 9. Machine-readable fingerprint --- */
  const fingerprint = {
    singer: { name: "You", sex_or_voice_category: voice.type + (voiceConfident ? " (from range extremes)" : " (provisional — narrow evidence)"), age_at_recording: null, analysis_period: new Date().toISOString().slice(0, 10), sample_count: 1 + (hist && hist.takes ? hist.takes : 0) },
    acoustic_profile: {
      f0: measured({ hz: distribution(voiced.map((s) => s.freq), 1), midi: distribution(midis, 2), frames: voiced.length, frame_ms: round(dt * 1000, 1) }, base, "autocorrelation pitch tracking on 43 ms windows"),
      range: measured({
        demonstrated: { low: midiToNote(minMidi), high: midiToNote(maxMidi), semitones: round(maxMidi - minMidi, 1) },
        typical_usable_p5_p95: { low: midiToNote(low5), high: midiToNote(high95), semitones: round(high95 - low5, 1) },
        comfortable_tessitura_p25_p75: { low: midiToNote(q1), high: midiToNote(q3), semitones: round(q3 - q1, 1) },
        range_check: glide ? { low: midiToNote(glide.low), high: midiToNote(glide.high), semitones: round(glide.high - glide.low, 1) } : null,
        combined_for_voice_type: { low: midiToNote(rangeLow), high: midiToNote(rangeHigh), semitones: round(rangeHigh - rangeLow, 1), sources: ["this line", ...rangeSources], confident: voiceConfident },
      }, base * 0.9, "percentiles of voiced-frame pitch", { note: "voice type is classified from the combined extremes, not from where this line sat" }),
      tessitura: measured({
        median_note: midiToNote(median), median_midi: round(median, 2), lower_midi: round(q1, 2), upper_midi: round(q3, 2), width_semitones: round(q3 - q1, 1),
        share_of_own_range: { lower_third: round(thirds.lower / midis.length * 100, 0), middle_third: round(thirds.middle / midis.length * 100, 0), upper_third: round(thirds.upper / midis.length * 100, 0) },
      }, base * 0.9, "median / interquartile range of voiced pitch"),
      pitch_stability: measured({ within_note_deviation_cents_median: round(stabilityCents, 1), frame_jitter_pct_median: round(jitterMed === null ? null : jitterMed * 100, 2), label: steadiness }, base * 0.8, "deviation from note mean, excluding note edges"),
      spectral: measured({
        centroid_hz: centroidDist, rolloff85_hz: distribution(specs.map((s) => s.rolloff), 0),
        low_share_below_500hz: distribution(lowShare, 3), low_mid_share_500_2000hz: distribution(lowMidShare, 3),
        high_share_above_2000hz: distribution(hfShare, 3), spectral_tilt_db_100_1k_vs_1k_4k: tilts.length ? distribution(tilts, 1) : null,
      }, specConf, "FFT 4096, per voiced frame", { caveat: "uncorrected microphone / browser response" }),
      harmonic: measured({ hnr_db_estimate: distribution(hnrs, 1), h1_h2_db: h1h2s.length ? distribution(h1h2s, 1) : null },
        base * 0.5, "HNR from autocorrelation periodicity; H1-H2 from spectral peaks near f0 and 2f0", { caveat: "11.7 Hz bin resolution limits H1-H2 accuracy for low voices" }),
      formants: unmeasured("Formant tracking (LPC) with vowel identification is not implemented; single-line values would be unreliable."),
      voice_quality: {
        breathiness: measured({ acoustic_score: breathiness, inputs: { hnr_db: round(hnrMed, 1), h1_h2_db: round(h1h2Med, 1), share_above_4khz: round(med(specs.map((s) => s.vhighShare)), 3) } }, base * 0.5, "weighted HNR, H1-H2 and high-frequency noise"),
        roughness: roughness === null ? unmeasured("No notes long enough to measure cycle-to-cycle irregularity.") : measured({ score: roughness, inputs: { jitter_pct: round(jitterMed * 100, 2), periodicity_sd: round(claritySdMed, 3) } }, base * 0.4, "second-difference F0 jitter and periodicity variability"),
        vocal_fry: measured({ frames_pct: round(fryPct, 1) }, base * 0.4, "irregular low-frequency (< 85 Hz) voiced frames"),
        pressed_phonation: unmeasured("Requires controlled intensity and airflow indicators not available from a phone recording."),
      },
      vibrato: sustained.length === 0
        ? unmeasured("No note was held for 0.4 s or longer, so vibrato could not be assessed.")
        : measured({
          sustained_notes: sustained.length, notes_with_vibrato_pct: round(vibPct, 0),
          rate_hz: withVib.length ? distribution(withVib.map((x) => x.v.rateHz), 1) : null,
          extent_cents_peak_to_peak: withVib.length ? distribution(withVib.map((x) => x.v.extentCents), 0) : null,
          regularity_cv: withVib.length ? distribution(withVib.map((x) => x.v.regularityCv), 2) : null,
          onset_delay_s: withVib.length ? distribution(withVib.map((x) => x.v.onsetDelay), 2) : null,
          style: vibratoStyle, strength_0_100: vibratoStrength,
        }, base * 0.6 * scale(sustained.length, 0, 4), "detrended cents contour extrema on notes ≥ 0.4 s", { caveat: "40 Hz frame rate quantises rates above ~7 Hz" }),
    },
    perceptual_profile: {
      brightness: measured({ score: brightness, label: brightLabel5, centroid_to_pitch_ratio: round(centroidRatio, 2) }, specConf * 0.85, "spectral centroid relative to sung pitch + share above 2 kHz"),
      warmth: measured({ score: warmth, label: labelFor(warmth, WARMTH_LABELS) }, base * 0.35, "500–2 kHz share, mid brightness, low roughness"),
      breathiness: measured({ score: breathiness, label: labelFor(breathiness, BREATHINESS_LABELS) }, base * 0.5, "see acoustic_profile.voice_quality.breathiness"),
      roughness: roughness === null ? unmeasured("Not enough sustained phonation.") : measured({ score: roughness, label: labelFor(roughness, ROUGHNESS_LABELS) }, base * 0.4, "see voice_quality.roughness"),
      airiness: airiness === null ? unmeasured("Needs phrase onsets.") : measured({ score: airiness }, base * 0.3, "breathiness blended with soft-onset share (perceived softness)"),
      vocal_weight: measured({ score: weight, label: weightLabel5 }, base * 0.45, "low-frequency share, spectral tilt and tessitura combined"),
      resonance: unmeasured("Perceived resonance placement needs formant evidence or human rating; no claim made."),
      clarity: measured({ score: clarityScore }, base * 0.5, "harmonic-to-noise estimate"),
      intimacy: measured({ score: intimacy }, base * 0.3, "derived heuristic: breathiness, soft onsets, narrow dynamics"),
      power: unmeasured("Microphone distance and gain are unknown, so loudness cannot be read as vocal power."),
      emotional_intensity: measured({ score: intensity }, base * 0.3, "derived heuristic: dynamic range, roughness, loud-frame level"),
    },
    technique: {
      register_usage: unmeasured("Chest/mix/head/falsetto classification is not reliable from pitch and spectrum alone."),
      belt: measured({ detected: beltLike }, base * 0.3, "loudest 15% of frames well above comfort zone with brighter spectra"),
      falsetto: unmeasured("See register_usage."),
      head_voice: unmeasured("See register_usage."),
      chest_voice: unmeasured("See register_usage."),
      rasp: roughness === null ? unmeasured("Not enough sustained phonation.") : measured({ score: roughness, present: roughness >= 55 }, base * 0.4, "roughness score"),
      grit: unmeasured("Covered by roughness; not separated."),
      growl: unmeasured("Covered by roughness; not separated."),
      melisma: measured({ runs: runs, per_10s: round(runs / Math.max(1, sungSeconds / 10), 2) }, base * 0.5, "≥ 3 consecutive notes ≤ 180 ms with distinct pitches"),
      runs: measured({ count: runs }, base * 0.5, "as melisma"),
      slides: measured({ up: slidesUp, down: slidesDown, per_10s: round((slidesUp + slidesDown) / Math.max(1, sungSeconds / 10), 2) }, base * 0.5, "glides ≥ 1.5 semitones passing through transitional frames"),
      scoops: measured({ count: scoops }, base * 0.5, "note starts ≥ 70 cents below the settled pitch"),
      pitch_bends: measured({ overshoots: overshoots }, base * 0.4, "note starts ≥ 60 cents above the settled pitch"),
      tags: techniqueTags,
    },
    delivery: {
      phrasing: measured({ phrases: phrases.length, mean_phrase_s: round(mean(phrases.map((x) => x.dur)), 2), longest_phrase_s: round(Math.max(...phrases.map((x) => x.dur)), 2), notes: noteCount, notes_per_second: round(notesPerSec, 2), mean_note_s: round(meanNoteDur, 2), legato_ratio: round(legatoRatio, 2), label: phrasingLabel }, base * 0.6, "phrases split at silences ≥ 250 ms; legato = 1 − micro-gaps per note transition"),
      rhythmic_placement: unmeasured("No reference beat: the line was sung a cappella."),
      articulation: measured({ syllable_rate_proxy_per_s: round(notesPerSec, 2), label: null }, base * 0.2, "note rate only; consonant/vowel analysis needs lyric alignment", { reason: "Categorical articulation not assigned." }),
      dynamics: measured({ level_dbfs: dbDist, range_db_p10_p90: round(dynamicRange, 1), expressiveness_0_100: expressiveness, crescendo_phrases: crescendos, decrescendo_phrases: decrescendos, perceived_power: null }, base * 0.55, "RMS in dBFS over voiced frames", { caveat: "relative dynamics only; absolute level is not vocal power" }),
      attack: measured({ median_rise_ms: round(riseMs, 0), soft_onset_pct: round(softOnsetPct, 0), aspirated_pct: round(aspiratedPct, 0), label: attackLabel }, base * 0.45, "20 % → 80 % RMS rise at phrase starts"),
      release: measured({ median_fall_ms: round(fallMs, 0), labels: releaseLabels }, base * 0.4, "80 % → 20 % RMS fall and pitch movement at phrase ends"),
      ornamentation: measured({ density_0_100: ornamentationDensity, style: ornamentationStyle, events_per_10s: round(ornamentPer10s, 1), counts: { scoops, slides_up: slidesUp, slides_down: slidesDown, runs, overshoots } }, base * 0.5, "sum of pitch-expression events per 10 s of singing"),
      tags: delivery,
    },
    style: { genres: [], eras: null, stylistic_descriptors: [], note: "Style is inferred from matched singers and kept separate from acoustic similarity." },
    similarity_vectors: {},
    confidence: { base: round(base, 2), scale: "0–0.2 unusable · 0.21–0.4 very uncertain · 0.41–0.6 moderate · 0.61–0.8 reasonably reliable · 0.81–1 high" },
    recording_quality: { snr_db: rec.snr_db, noise_floor_rms: rec.noise_floor_rms, clipping_pct: rec.clipping_pct, usable_singing_seconds: rec.usable_singing_seconds, quality_score: rec.quality_score, context: rec.context },
    limitations,
  };
  if (rec.clipping_pct > 1) limitations.push("Clipping detected on " + rec.clipping_pct + "% of frames; spectral and breathiness scores are less reliable.");
  if (sungSeconds < 4) limitations.push("Under 4 s of voiced singing — distributions are coarse.");

  const descriptor = {
    voice: `${bright3}/${texture}/${weight3}`,
    technique: techniqueTags.slice(0, 4),
    delivery: delivery.slice(0, 4),
    style: [],
  };

  const scores = { brightness, warmth, weight, breathiness, roughness, vibrato: vibratoStrength, intimacy, intensity };

  return {
    // fields used by the UI
    lowMidi: rangeLow, highMidi: rangeHigh, medianMidi: median,
    lowNote: midiToNote(rangeLow), highNote: midiToNote(rangeHigh), medianNote: midiToNote(median),
    lineLowNote: midiToNote(low5), lineHighNote: midiToNote(high95),
    takeLow, takeHigh, rangeSources,
    spanSemitones: Math.round(rangeHigh - rangeLow),
    voiceType: voice.type, voiceDesc: voice.desc, voiceConfident,
    tone: bright3, steadiness,
    dynamics: expressiveness >= 55 ? "dynamic" : expressiveness < 30 ? "understated" : "controlled",
    framesUsed: voiced.length,
    // structured results
    fingerprint, descriptor, scores, techniqueTags, deliveryTags: delivery, base,
    summary: summariseFingerprint(fingerprint, { descriptor, scores, voiceType: voice.type, voiceConfident, rangeLow, rangeHigh, rangeSources, stabilityCents, steadiness, sungSeconds }),
  };
}

/* ---------- Human-readable summary ---------- */

function confidenceWord(c) {
  return c === 0 ? "not measured" : c <= 0.4 ? "low confidence" : c <= 0.6 ? "moderate confidence" : "reasonably reliable";
}

function summariseFingerprint(fp, ctx) {
  const ap = fp.acoustic_profile;
  const pp = fp.perceptual_profile;
  const te = fp.technique;
  const de = fp.delivery;
  const row = (key, label, text, confidence) => ({ key, label, text, confidence: confidence || 0 });
  const rows = [];

  const spec = ap.spectral.value;
  rows.push(row("timbre", "Timbre",
    `${cap(pp.brightness.value.label)} timbre, ${pp.warmth.value.label} warmth — spectral centroid around ${spec.centroid_hz.median} Hz, ${Math.round(spec.high_share_above_2000hz.median * 100)}% of energy above 2 kHz.`,
    pp.brightness.confidence));

  const r = ap.range.value;
  rows.push(row("pitch", "Pitch / range",
    `This line: ${r.typical_usable_p5_p95.low}–${r.typical_usable_p5_p95.high}, comfortable around ${ap.tessitura.value.median_note}. Range so far ${midiToNote(ctx.rangeLow)}–${midiToNote(ctx.rangeHigh)} (${Math.round(ctx.rangeHigh - ctx.rangeLow)} semitones${ctx.rangeSources.length ? ", incl. " + ctx.rangeSources.join(" and ") : ""}) → ${ctx.voiceConfident ? ctx.voiceType : "likely " + ctx.voiceType}${ctx.voiceConfident ? "" : " — run the range check to confirm"}. Pitch held within ±${Math.round(ctx.stabilityCents ?? 0)} cents inside notes (${ctx.steadiness}).`,
    ap.range.confidence));

  rows.push(row("weight", "Weight",
    `${cap(pp.vocal_weight.value.label)} (${pp.vocal_weight.value.score}/100) — ${Math.round(spec.low_share_below_500hz.median * 100)}% of energy below 500 Hz${spec.spectral_tilt_db_100_1k_vs_1k_4k ? `, spectral tilt ${spec.spectral_tilt_db_100_1k_vs_1k_4k.median} dB` : ""}.`,
    pp.vocal_weight.confidence));

  const rough = pp.roughness.value ? `${pp.roughness.value.label} (${pp.roughness.value.score}/100)` : "roughness not measurable";
  rows.push(row("texture", "Texture",
    `${cap(pp.breathiness.value.label)} (${pp.breathiness.value.score}/100), ${rough}. Harmonic-to-noise estimate ${ap.harmonic.value.hnr_db_estimate.median} dB.`,
    Math.min(pp.breathiness.confidence, pp.roughness.confidence || pp.breathiness.confidence)));

  rows.push(row("resonance", "Resonance", pp.resonance.reason, 0));

  const vib = ap.vibrato;
  if (vib.value === null) rows.push(row("vibrato", "Vibrato", vib.reason + " Try holding one note for a couple of seconds.", 0));
  else if (vib.value.notes_with_vibrato_pct < 25) rows.push(row("vibrato", "Vibrato", `Straight-tone dominant — no regular vibrato on ${vib.value.sustained_notes} sustained note${vib.value.sustained_notes === 1 ? "" : "s"}.`, vib.confidence));
  else rows.push(row("vibrato", "Vibrato", `${cap(vib.value.style.join(", "))}: about ${vib.value.rate_hz.median} Hz, ${vib.value.extent_cents_peak_to_peak.median} cents peak-to-peak, on ${vib.value.notes_with_vibrato_pct}% of sustained notes.`, vib.confidence));

  const ph = de.phrasing.value;
  rows.push(row("phrasing", "Phrasing",
    `${cap(ph.label || "unclassified")}: ${ph.phrases} phrase${ph.phrases === 1 ? "" : "s"} averaging ${ph.mean_phrase_s} s, ${ph.notes_per_second} notes per second, legato ratio ${ph.legato_ratio ?? "—"}. Attack ${de.attack.value.label || "—"}, release ${de.release.value.labels.join(", ") || "—"}.`,
    de.phrasing.confidence));

  rows.push(row("rhythm", "Rhythm", de.rhythmic_placement.reason + " Sing along to a karaoke track to measure timing.", 0));
  rows.push(row("articulation", "Articulation", `Not classified — needs lyric alignment. Syllable-rate proxy: ${de.articulation.value.syllable_rate_proxy_per_s} notes per second.`, de.articulation.confidence));

  const orn = de.ornamentation.value;
  rows.push(row("ornamentation", "Ornamentation",
    `${cap(orn.style)} (${orn.density_0_100}/100): ${orn.counts.scoops} scoop${orn.counts.scoops === 1 ? "" : "s"}, ${orn.counts.slides_up + orn.counts.slides_down} slide${orn.counts.slides_up + orn.counts.slides_down === 1 ? "" : "s"}, ${orn.counts.runs} run${orn.counts.runs === 1 ? "" : "s"} in ${Math.round(ctx.sungSeconds)} s of singing.`,
    de.ornamentation.confidence));

  rows.push(row("technique", "Technique",
    (te.tags.length ? cap(te.tags.join(", ")) : "No distinctive technique markers detected") + ". Register use (chest / mix / head / falsetto) is not estimated.",
    ap.vibrato.confidence || fp.confidence.base * 0.4));

  rows.push(row("emotion", "Emotional delivery",
    `Perceived character (heuristic, not a measurement): intimacy ${pp.intimacy.value.score}/100, intensity ${pp.emotional_intensity.value.score}/100 — reads as ${ctx.descriptor.delivery.join(", ") || "neutral"}.`,
    pp.intimacy.confidence));

  rows.push(row("style", "Style", "Inferred from the singers you match — see genres below. Kept separate from how your voice physically sounds.", fp.confidence.base * 0.5));
  return rows;
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/* ---------- Similarity (four separate dimensions) ---------- */

const sim = (a, b, span = 60) => (a === null || b === null ? null : 1 - clamp01(Math.abs(a - b) / span));

function dice(a, b) {
  if (!a.length || !b.length) return null;
  const inter = a.filter((x) => b.includes(x)).length;
  return (2 * inter) / (a.length + b.length);
}

function matchSingers(profile, pool = SINGERS) {
  const s = profile.scores;
  return pool.map((singer) => {
    const sLow = noteToMidi(singer.low);
    const sHigh = noteToMidi(singer.high);
    const sCenter = (sLow + sHigh) / 2;
    const overlapSpan = Math.max(0, Math.min(profile.highMidi, sHigh) - Math.max(profile.lowMidi, sLow));
    const overlap = Math.min(1, overlapSpan / Math.max(1, profile.highMidi - profile.lowMidi));
    const center = 1 - Math.min(1, Math.abs(profile.medianMidi - sCenter) / 12);

    const components = [
      { name: "pitch range", w: 0.30, v: 0.6 * center + 0.4 * overlap },
      { name: "brightness", w: 0.20, v: sim(s.brightness, singer.voice.brightness) },
      { name: "vocal weight", w: 0.15, v: sim(s.weight, singer.voice.weight) },
      { name: "breathiness", w: 0.15, v: sim(s.breathiness, singer.voice.breathiness) },
      { name: "warmth", w: 0.10, v: sim(s.warmth, singer.voice.warmth) },
      { name: "vibrato", w: 0.10, v: sim(s.vibrato, singer.voice.vibrato, 70) },
    ].filter((c) => c.v !== null);
    const wSum = components.reduce((a, c) => a + c.w, 0);
    const acoustic = components.reduce((a, c) => a + c.w * c.v, 0) / wSum;

    const techTags = dice(profile.techniqueTags, singer.technique);
    const techParts = [
      techTags === null ? null : [0.5, techTags],
      [0.25, sim(s.vibrato, singer.voice.vibrato, 70)],
      [0.25, sim(s.roughness, singer.voice.roughness)],
    ].filter((x) => x && x[1] !== null);
    const technique = techParts.length ? techParts.reduce((a, [w, v]) => a + w * v, 0) / techParts.reduce((a, [w]) => a + w, 0) : null;

    const delivery = dice(profile.deliveryTags, singer.delivery);

    const overall = 0.55 * acoustic + 0.25 * (technique ?? acoustic) + 0.20 * (delivery ?? acoustic);
    const reasons = [...components].sort((a, b) => b.v - a.v).slice(0, 2).map((c) => c.name);
    if (technique !== null && technique >= 0.7) reasons.push("technique");
    if (delivery !== null && delivery >= 0.6) reasons.push("delivery");

    const pctOf = (v) => (v === null ? null : Math.min(99, Math.round(v * 100)));
    return {
      singer, score: overall, matchPct: pctOf(overall),
      acoustic: pctOf(acoustic), technique: pctOf(technique), delivery: pctOf(delivery),
      reasons: reasons.slice(0, 3),
    };
  }).sort((a, b) => b.score - a.score);
}

function rankBy(matches, dim) {
  return matches.filter((m) => m[dim] !== null).sort((a, b) => b[dim] - a[dim]);
}

// What stands out. Only pitch can honestly be compared with the singer set
// (a note is a note); the curated tone/texture ratings live on a different
// scale from microphone measurements, so those are described on their own
// absolute 0–100 scale and only when clearly extreme.
function distinguishingTraits(profile) {
  const traits = [];
  const centers = SINGERS.map((x) => (noteToMidi(x.low) + noteToMidi(x.high)) / 2);
  const below = centers.filter((c) => c < profile.medianMidi).length / centers.length;
  if (Math.abs(below - 0.5) >= 0.2) {
    traits.push({ strength: Math.abs(below - 0.5) + 1, text: below >= 0.5
      ? `Your comfort zone (${profile.medianNote}) sits higher than ${Math.round(below * 100)}% of the singers in our set`
      : `Your comfort zone (${profile.medianNote}) sits lower than ${Math.round((1 - below) * 100)}% of the singers in our set` });
  }
  const span = profile.highMidi - profile.lowMidi;
  if (span >= 14) traits.push({ strength: 0.9, text: `You covered ${Math.round(span)} semitones in one line — a wide, flexible range` });

  const s = profile.scores;
  const axes = [
    ["brightness", "Very dark timbre", "Very bright timbre", "brightness"],
    ["warmth", "A cool, lean tone", "An unusually warm tone", "warmth"],
    ["weight", "A very light voice", "A very heavy, full voice", "weight"],
    ["breathiness", "A very clear, focused sound", "A very breathy, airy sound", "breathiness"],
    ["roughness", "A very smooth, even texture", "A very raspy texture", "roughness"],
    ["vibrato", "Almost no vibrato — straight-tone singing", "Strong, prominent vibrato", "vibrato"],
  ];
  axes.forEach(([key, lowText, highText, label]) => {
    const v = s[key];
    if (v === null || v === undefined) return;
    if (v <= 20) traits.push({ strength: (20 - v) / 20, text: `${lowText} (${label} ${v}/100)` });
    else if (v >= 80) traits.push({ strength: (v - 80) / 20, text: `${highText} (${label} ${v}/100)` });
  });
  return traits.sort((a, b) => b.strength - a.strength).slice(0, 5);
}

function suggestGenres(matches, profile, top = 5) {
  const weights = new Map();
  matches.slice(0, top).forEach(({ singer, score }) => {
    singer.genres.forEach((g, i) => {
      weights.set(g, (weights.get(g) || 0) + score * (1 - i * 0.2));
    });
  });
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  return ranked.slice(0, 4);
}

function buildSongPool(matches) {
  return matches.flatMap(({ singer, score }) =>
    singer.songs.map((title) => ({
      id: singer.id + "::" + title,
      title,
      artist: singer.name,
      singerId: singer.id,
      voiceType: singer.type,
      genres: singer.genres,
      score,
    }))
  );
}
