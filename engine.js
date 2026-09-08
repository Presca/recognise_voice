"use strict";

/* ---------- Note helpers ---------- */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
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

/* ---------- Pitch detection (autocorrelation) ---------- */

function detectPitch(buf, sampleRate) {
  const size = buf.length;
  let rms = 0;
  for (let i = 0; i < size; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) return { freq: -1, rms };

  // Trim leading/trailing silence so the correlation focuses on the signal.
  let r1 = 0;
  let r2 = size - 1;
  const thres = 0.2;
  for (let i = 0; i < size / 2; i++) {
    if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < size / 2; i++) {
    if (Math.abs(buf[size - i]) < thres) { r2 = size - i; break; }
  }
  const trimmed = buf.slice(r1, r2);
  const n = trimmed.length;

  const c = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - i; j++) c[i] += trimmed[j] * trimmed[j + i];
  }

  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;

  let maxval = -1;
  let maxpos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  if (maxpos <= 0) return { freq: -1, rms };

  let T0 = maxpos;
  const x1 = c[T0 - 1] || 0;
  const x2 = c[T0];
  const x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  return { freq: sampleRate / T0, rms };
}

/* ---------- Recorder ---------- */

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
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);

    const timeData = new Float32Array(this.analyser.fftSize);
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;

    this.samples = [];
    this.startedAt = performance.now();

    this.timer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(timeData);
      this.analyser.getByteFrequencyData(freqData);

      const { freq, rms } = detectPitch(timeData, this.ctx.sampleRate);

      let weighted = 0;
      let total = 0;
      for (let i = 0; i < freqData.length; i++) {
        weighted += i * binHz * freqData[i];
        total += freqData[i];
      }
      const centroid = total ? weighted / total : 0;

      const sample = { t: performance.now() - this.startedAt, freq, rms, centroid };
      this.samples.push(sample);
      if (onFrame) onFrame(sample);
    }, 50);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
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

/* ---------- Analysis ---------- */

function percentile(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

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

function analyseSamples(samples) {
  const voiced = samples.filter((s) => s.freq >= 60 && s.freq <= 1400 && s.rms > 0.015);
  if (voiced.length < 20) return null;

  const midis = voiced.map((s) => freqToMidi(s.freq));
  const sorted = [...midis].sort((a, b) => a - b);
  const low = percentile(sorted, 0.05);
  const high = percentile(sorted, 0.95);
  const median = percentile(sorted, 0.5);

  // Pitch steadiness: average jump between consecutive voiced frames, in cents.
  let jumps = 0;
  let count = 0;
  for (let i = 1; i < midis.length; i++) {
    const cents = Math.abs(midis[i] - midis[i - 1]) * 100;
    if (cents < 300) { jumps += cents; count++; }
  }
  const avgJump = count ? jumps / count : 0;
  const steadiness = avgJump < 25 ? "steady" : avgJump < 60 ? "expressive" : "free";

  const centroid = voiced.reduce((a, s) => a + s.centroid, 0) / voiced.length;
  const tone = centroid < 1800 ? "dark" : centroid < 3000 ? "warm" : "bright";

  const rmsValues = voiced.map((s) => s.rms);
  const rmsMean = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
  const rmsVar = rmsValues.reduce((a, b) => a + (b - rmsMean) ** 2, 0) / rmsValues.length;
  const dynamics = Math.sqrt(rmsVar) / rmsMean > 0.5 ? "dynamic" : "controlled";

  const voice = classifyVoice(median);

  return {
    lowMidi: low,
    highMidi: high,
    medianMidi: median,
    lowNote: midiToNote(low),
    highNote: midiToNote(high),
    medianNote: midiToNote(median),
    spanSemitones: Math.round(high - low),
    voiceType: voice.type,
    voiceDesc: voice.desc,
    tone,
    steadiness,
    dynamics,
    framesUsed: voiced.length,
  };
}

/* ---------- Matching ---------- */

const TONE_ORDER = ["dark", "warm", "bright"];

function toneSimilarity(a, b) {
  const diff = Math.abs(TONE_ORDER.indexOf(a) - TONE_ORDER.indexOf(b));
  return diff === 0 ? 1 : diff === 1 ? 0.5 : 0;
}

function matchSingers(profile) {
  return SINGERS.map((singer) => {
    const sLow = noteToMidi(singer.low);
    const sHigh = noteToMidi(singer.high);
    const sCenter = (sLow + sHigh) / 2;

    const overlapSpan = Math.max(0, Math.min(profile.highMidi, sHigh) - Math.max(profile.lowMidi, sLow));
    const overlap = Math.min(1, overlapSpan / Math.max(1, profile.highMidi - profile.lowMidi));
    const center = 1 - Math.min(1, Math.abs(profile.medianMidi - sCenter) / 12);
    const tone = toneSimilarity(profile.tone, singer.tone);

    const score = 0.45 * center + 0.35 * overlap + 0.2 * tone;
    return { singer, score, matchPct: Math.min(99, Math.round(score * 100)) };
  }).sort((a, b) => b.score - a.score);
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
