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
  renderSingers(state.matches.slice(0, 7), profile);
  renderGenres(suggestGenres(state.matches, profile));
  renderSongs();
  showScreen("results");
  // The carousel measures its container, which has no width while hidden.
  layoutCarousel();
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

/* ---------- Singer carousel ---------- */

const carousel = { matches: [], profile: null, active: 0, items: [] };

// Deterministic two-hue gradient per singer, standing in for cover art.
function coverColours(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue} 75% 55%)`, `hsl(${(hue + 50) % 360} 80% 40%)`];
}

function rankLabel(i) {
  if (i === 0) return "Closest Match";
  const ordinal = ["Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh"][i - 1] || `#${i + 1}`;
  return `${ordinal} Closest`;
}

async function shareSinger(singer, matchPct, button) {
  const text = `My singing voice is a ${matchPct}% match to ${singer.name} (${singer.type}) on Recognise Voice!`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "Recognise Voice", text, url: location.href });
    } else {
      await navigator.clipboard.writeText(text + " " + location.href);
      button.textContent = "✓";
      setTimeout(() => { button.textContent = "⇪"; }, 1500);
    }
  } catch {
    /* user cancelled or clipboard blocked — nothing to do */
  }
}

function renderSingers(matches, profile) {
  carousel.matches = matches;
  carousel.profile = profile;
  carousel.active = 0;
  carousel.items = [];

  const track = $("singer-carousel");
  track.replaceChildren();

  matches.forEach(({ singer, matchPct }, i) => {
    const item = el("article", "cf-item");

    const label = el("div", "cf-label");
    label.append(el("h3", null, rankLabel(i)));
    label.append(el("p", null, `${matchPct}% match to your voice`));
    item.append(label);

    const card = el("div", "cf-card");
    const art = el("div", "cf-art");
    const cover = el("div", "cover");
    const [c1, c2] = coverColours(singer.id);
    cover.style.setProperty("--c1", c1);
    cover.style.setProperty("--c2", c2);
    art.append(cover, el("span", "initials", initials(singer.name)));
    card.append(art);
    card.append(el("h4", "cf-name singer-name", singer.name));
    card.append(el("p", "cf-type", singer.type));
    card.append(el("p", "cf-sub", `${singer.low}–${singer.high} · ${singer.genres.join(", ")}`));

    const share = el("button", "cf-share", "⇪");
    share.type = "button";
    share.title = "Share this match";
    share.setAttribute("aria-label", `Share your match with ${singer.name}`);
    share.addEventListener("click", (e) => { e.stopPropagation(); shareSinger(singer, matchPct, share); });
    card.append(share);

    item.append(card);
    item.addEventListener("click", () => {
      if (carousel.swiped) return; // the swipe already moved the carousel
      if (carousel.active !== i) setActiveSinger(i);
    });
    track.append(item);
    carousel.items.push(item);
  });

  const dots = $("singer-dots");
  dots.replaceChildren();
  matches.forEach(({ singer }, i) => {
    const dot = el("button", "dot");
    dot.type = "button";
    dot.setAttribute("aria-label", `Show ${singer.name}`);
    dot.addEventListener("click", () => setActiveSinger(i));
    dots.append(dot);
  });

  setActiveSinger(0);
}

function setActiveSinger(index) {
  carousel.active = Math.max(0, Math.min(carousel.matches.length - 1, index));
  layoutCarousel();
  renderSingerDetail();
  document.querySelectorAll("#singer-dots .dot").forEach((d, i) => d.classList.toggle("active", i === carousel.active));
}

function layoutCarousel() {
  const band = $("singer-carousel").parentElement;
  const cardW = Math.min(300, Math.round(band.clientWidth * 0.62));
  band.style.setProperty("--card-w", cardW + "px");
  const spacing = cardW * 0.9;

  carousel.items.forEach((item, i) => {
    const offset = i - carousel.active;
    const abs = Math.abs(offset);
    item.style.transform =
      `translateX(${offset * spacing}px) translateZ(${-abs * 140}px) rotateY(${-offset * 32}deg) scale(${1 - abs * 0.06})`;
    item.style.opacity = abs > 2 ? 0 : 1;
    item.style.filter = abs ? "brightness(0.72)" : "none";
    item.style.zIndex = 10 - abs;
    item.style.pointerEvents = abs > 2 ? "none" : "auto";
    item.classList.toggle("active", offset === 0);
  });
}

function renderSingerDetail() {
  const { singer } = carousel.matches[carousel.active];
  const profile = carousel.profile;
  const wrap = $("singer-detail");
  wrap.replaceChildren();

  wrap.append(el("p", null, singer.blurb));

  const bar = el("div", "mini-range");
  const sFill = el("div", "range-fill singer");
  sFill.style.left = pct(noteToMidi(singer.low)) + "%";
  sFill.style.width = (pct(noteToMidi(singer.high)) - pct(noteToMidi(singer.low))) + "%";
  const uFill = el("div", "range-fill user");
  uFill.style.left = pct(profile.lowMidi) + "%";
  uFill.style.width = Math.max(1.5, pct(profile.highMidi) - pct(profile.lowMidi)) + "%";
  bar.append(sFill, uFill);
  wrap.append(bar);
  wrap.append(el("div", "range-key", `White: ${singer.name.split(" ")[0]}'s range · Gold: yours`));

  const tags = el("div", "tag-row");
  singer.genres.forEach((g) => tags.append(el("span", "tag", g)));
  wrap.append(tags);
}

// Swipe / drag between cards.
(() => {
  const track = $("singer-carousel");
  let startX = null;
  track.addEventListener("pointerdown", (e) => { startX = e.clientX; carousel.swiped = false; });
  track.addEventListener("pointerup", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) {
      carousel.swiped = true;
      setActiveSinger(carousel.active + (dx < 0 ? 1 : -1));
    }
  });
  track.addEventListener("pointercancel", () => { startX = null; });
  document.addEventListener("keydown", (e) => {
    if (screens.results.hidden || !carousel.matches.length) return;
    if (e.key === "ArrowRight") setActiveSinger(carousel.active + 1);
    if (e.key === "ArrowLeft") setActiveSinger(carousel.active - 1);
  });
  window.addEventListener("resize", () => { if (carousel.items.length) layoutCarousel(); });
})();

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
