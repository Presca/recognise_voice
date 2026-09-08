"use strict";

const $ = (id) => document.getElementById(id);

const screens = {
  intro: $("screen-intro"),
  record: $("screen-record"),
  results: $("screen-results"),
};

const MAX_RECORD_MS = 15000;
const MIN_RECORD_MS = 2000;
const RANGE_BAR_LOW = noteToMidi("C2");
const RANGE_BAR_HIGH = noteToMidi("C6");
const SONGS_PER_PAGE = 6;
const DISMISSED_KEY = "recognise-voice:unmatched";

const recorder = new VoiceRecorder();
let uiTimer = null;
let selectedLine = "";
let state = {
  profile: null,
  matches: [],
  songPool: [],
  singerPenalty: new Map(),
  dismissed: loadDismissed(),
  visibleSongs: SONGS_PER_PAGE,
};

/* ---------- Helpers ---------- */

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => { el.hidden = key !== name; });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function loadDismissed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveDismissed() {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...state.dismissed]));
  } catch {
    /* storage unavailable — dismissals just won't persist */
  }
}

function pct(midi) {
  const clamped = Math.min(RANGE_BAR_HIGH, Math.max(RANGE_BAR_LOW, midi));
  return ((clamped - RANGE_BAR_LOW) / (RANGE_BAR_HIGH - RANGE_BAR_LOW)) * 100;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function linkButton(cls, label, href) {
  const a = el("a", "link-btn " + cls, label);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

/* ---------- Intro ---------- */

$("prompt-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#prompt-chips .chip").forEach((c) => c.classList.remove("selected"));
  chip.classList.add("selected");
  selectedLine = chip.dataset.line;
});
selectedLine = document.querySelector("#prompt-chips .chip.selected").dataset.line;

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
  $("unsupported").hidden = false;
  $("start-btn").disabled = true;
}

$("start-btn").addEventListener("click", startRecording);

/* ---------- Recording ---------- */

async function startRecording() {
  $("error").hidden = true;
  $("lyric").textContent = selectedLine;
  $("live-note").textContent = "—";
  $("stop-btn").style.setProperty("--pulse", 1);
  $("elapsed").textContent = "0.0";

  try {
    await recorder.start(onFrame);
  } catch (err) {
    const msg = err && err.name === "NotAllowedError"
      ? "Microphone access was denied. Please allow the microphone and try again."
      : "Couldn't start the microphone: " + (err && err.message ? err.message : err);
    $("error").textContent = msg;
    $("error").hidden = false;
    return;
  }

  showScreen("record");
  uiTimer = setInterval(() => {
    const ms = recorder.elapsed();
    $("elapsed").textContent = (ms / 1000).toFixed(1);
    if (ms >= MAX_RECORD_MS) finishRecording();
  }, 100);
}

function onFrame({ freq, rms }) {
  // Core swells with volume, Shazam-style.
  const pulse = 1 + Math.min(0.12, rms * 0.6);
  $("stop-btn").style.setProperty("--pulse", pulse.toFixed(3));
  if (freq > 0 && rms > 0.015) {
    $("live-note").textContent = midiToNote(freqToMidi(freq));
  }
}

function cancelRecording() {
  clearInterval(uiTimer);
  uiTimer = null;
  if (recorder.timer) recorder.stop();
}

function finishRecording() {
  clearInterval(uiTimer);
  uiTimer = null;
  const tooShort = recorder.elapsed() < MIN_RECORD_MS;
  const samples = recorder.stop();
  const profile = tooShort ? null : analyseSamples(samples);

  if (!profile) {
    $("error").textContent = tooShort
      ? "That was a bit short — sing for at least a few seconds so we can hear your range."
      : "We couldn't pick up a clear singing voice. Move closer to the mic, sing a little louder, and try again.";
    $("error").hidden = false;
    showScreen("intro");
    return;
  }

  runAnalysis(profile);
}

$("stop-btn").addEventListener("click", finishRecording);
$("cancel-btn").addEventListener("click", () => { cancelRecording(); showScreen("intro"); });
$("again-btn").addEventListener("click", () => showScreen("intro"));

/* ---------- Results ---------- */

function runAnalysis(profile) {
  state.profile = profile;
  state.matches = matchSingers(profile);
  state.singerPenalty = new Map();
  state.visibleSongs = SONGS_PER_PAGE;
  rebuildSongPool();

  renderVoice(profile);
  renderSingers(state.matches.slice(0, 5), profile);
  renderGenres(suggestGenres(state.matches, profile));
  renderSongs();
  showScreen("results");
}

function renderVoice(p) {
  $("voice-type").textContent = p.voiceType;
  $("voice-desc").textContent = `Estimated from what you sang — ${p.voiceDesc}, with a ${p.tone} tone.`;

  const fill = $("user-range-fill");
  fill.style.left = pct(p.lowMidi) + "%";
  fill.style.width = Math.max(1.5, pct(p.highMidi) - pct(p.lowMidi)) + "%";
  $("user-range-median").style.left = pct(p.medianMidi) + "%";

  const stats = [
    ["Range sung", `${p.lowNote} – ${p.highNote}`],
    ["Span", `${p.spanSemitones} semitones`],
    ["Comfort zone", p.medianNote],
    ["Tone", p.tone],
    ["Pitch", p.steadiness],
    ["Dynamics", p.dynamics],
  ];
  const dl = $("stats");
  dl.replaceChildren();
  stats.forEach(([k, v]) => {
    const wrap = el("div");
    wrap.append(el("dt", null, k), el("dd", null, v));
    dl.append(wrap);
  });
}

function renderSingers(matches, profile) {
  const grid = $("singers");
  grid.replaceChildren();

  matches.forEach(({ singer, matchPct }) => {
    const card = el("article", "singer-card");

    const top = el("div", "singer-top");
    top.append(el("div", "avatar", initials(singer.name)));
    const nameWrap = el("div");
    nameWrap.append(el("div", "singer-name", singer.name));
    nameWrap.append(el("div", "singer-meta", `${singer.type} · ${singer.low}–${singer.high}`));
    top.append(nameWrap);
    top.append(el("span", "match-pill", `${matchPct}% match`));
    card.append(top);

    card.append(el("p", "singer-blurb", singer.blurb));

    const bar = el("div", "mini-range");
    const sFill = el("div", "range-fill singer");
    sFill.style.left = pct(noteToMidi(singer.low)) + "%";
    sFill.style.width = (pct(noteToMidi(singer.high)) - pct(noteToMidi(singer.low))) + "%";
    const uFill = el("div", "range-fill user");
    uFill.style.left = pct(profile.lowMidi) + "%";
    uFill.style.width = Math.max(1.5, pct(profile.highMidi) - pct(profile.lowMidi)) + "%";
    bar.append(sFill, uFill);
    card.append(bar);
    card.append(el("div", "singer-meta", "Grey: their range · Purple: yours"));

    const tags = el("div", "tag-row");
    singer.genres.forEach((g) => tags.append(el("span", "tag", g)));
    card.append(tags);

    grid.append(card);
  });
}

function renderGenres(genres) {
  const wrap = $("genres");
  wrap.replaceChildren();
  genres.forEach((g, i) => wrap.append(el("span", "chip" + (i === 0 ? " selected" : ""), g)));
}

/* ---------- Songs ---------- */

function rebuildSongPool() {
  const adjusted = state.matches.map((m) => ({
    ...m,
    score: m.score - (state.singerPenalty.get(m.singer.id) || 0),
  })).sort((a, b) => b.score - a.score);

  // Interleave one song per singer per round so the list isn't three
  // songs from the same artist in a row.
  const perSinger = adjusted.map((m) => buildSongPool([m]));
  const pool = [];
  const rounds = Math.max(...perSinger.map((s) => s.length));
  for (let i = 0; i < rounds; i++) {
    perSinger.forEach((songs) => { if (songs[i]) pool.push(songs[i]); });
  }
  state.songPool = pool;
}

function activeSongs() {
  return state.songPool.filter((s) => !state.dismissed.has(s.id));
}

function songCard(song, { featured = false, dismissable = true } = {}) {
  const card = el("article", "song-card" + (featured ? " featured" : ""));

  const info = el("div");
  info.append(el("div", "song-title", song.title));
  info.append(el("div", "song-meta", `${song.artist} · ${song.voiceType} · ${song.genres.join(", ")}`));
  card.append(info);

  if (dismissable) {
    const x = el("button", "unmatch", "✕");
    x.type = "button";
    x.title = "Not for me — suggest something else";
    x.setAttribute("aria-label", `Unmatch ${song.title}`);
    x.addEventListener("click", () => unmatchSong(song));
    card.append(x);
  } else {
    card.append(el("span"));
  }

  const links = el("div", "links");
  links.append(linkButton("karaoke" + (featured ? " big" : ""), "🎤 Karaoke on YouTube", karaokeUrl(song.title, song.artist)));
  links.append(linkButton("spotify", "Open on Spotify", spotifyUrl(song.title, song.artist)));
  links.append(linkButton("youtube", "Watch on YouTube", youtubeUrl(song.title, song.artist)));
  card.append(links);

  return card;
}

function renderSongs() {
  const songs = activeSongs();
  const list = $("songs");
  const featuredWrap = $("featured");
  list.replaceChildren();
  featuredWrap.replaceChildren();

  if (!songs.length) {
    featuredWrap.append(el("p", "empty", "You've unmatched every suggestion — reset to see them again."));
    return;
  }

  featuredWrap.append(songCard(songs[0], { featured: true, dismissable: false }));

  songs.slice(0, state.visibleSongs).forEach((song) => list.append(songCard(song)));
  $("more-btn").hidden = songs.length <= state.visibleSongs;
}

function unmatchSong(song) {
  state.dismissed.add(song.id);
  saveDismissed();
  // Nudge this singer down so the replacement is more likely to be a different voice.
  state.singerPenalty.set(song.singerId, (state.singerPenalty.get(song.singerId) || 0) + 0.06);
  rebuildSongPool();
  renderSongs();
}

$("more-btn").addEventListener("click", () => {
  state.visibleSongs += SONGS_PER_PAGE;
  renderSongs();
});

$("reset-btn").addEventListener("click", () => {
  state.dismissed.clear();
  saveDismissed();
  state.singerPenalty = new Map();
  state.visibleSongs = SONGS_PER_PAGE;
  rebuildSongPool();
  renderSongs();
});
