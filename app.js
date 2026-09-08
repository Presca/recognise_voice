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
  songPage: 0,
  showAll: false,
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
  const blobPromise = recorder.blobPromise;
  const profile = tooShort ? null : analyseSamples(samples);

  if (!profile) {
    $("error").textContent = tooShort
      ? "That was a bit short — sing for at least a few seconds so we can hear your range."
      : "We couldn't pick up a clear singing voice. Move closer to the mic, sing a little louder, and try again.";
    $("error").hidden = false;
    showScreen("intro");
    return;
  }

  setupReplay(blobPromise);
  runAnalysis(profile);
}

/* ---------- Replay ---------- */

const replay = { url: null, audio: $("replay-audio") };

function setReplayLabel(playing) {
  $("replay-btn").innerHTML = (playing ? PAUSE_ICON : PLAY_ICON) + (playing ? " Pause" : " Replay my singing");
}

function setupReplay(blobPromise) {
  const btn = $("replay-btn");
  btn.hidden = true;
  replay.audio.pause();
  replay.audio.removeAttribute("src");
  if (replay.url) { URL.revokeObjectURL(replay.url); replay.url = null; }
  if (!blobPromise) return;
  blobPromise.then((blob) => {
    if (!blob) return;
    replay.url = URL.createObjectURL(blob);
    replay.audio.src = replay.url;
    setReplayLabel(false);
    btn.hidden = false;
  });
}

$("replay-btn").addEventListener("click", () => {
  if (replay.audio.paused) replay.audio.play(); else replay.audio.pause();
});
replay.audio.addEventListener("play", () => setReplayLabel(true));
replay.audio.addEventListener("pause", () => setReplayLabel(false));
replay.audio.addEventListener("ended", () => setReplayLabel(false));

$("stop-btn").addEventListener("click", finishRecording);
$("cancel-btn").addEventListener("click", () => { cancelRecording(); showScreen("intro"); });
$("again-btn").addEventListener("click", () => showScreen("intro"));

/* ---------- Results ---------- */

function runAnalysis(profile) {
  state.profile = profile;
  state.matches = matchSingers(profile);
  state.singerPenalty = new Map();
  state.songPage = 0;
  state.showAll = false;
  rebuildSongPool();

  // Style is derived from matched singers and kept out of the acoustic similarity.
  const genres = suggestGenres(state.matches, profile);
  profile.descriptor.style = genres.slice(0, 3);
  profile.fingerprint.style.genres = genres;
  const top = (dim) => rankBy(state.matches, dim).slice(0, 5).map((m) => ({ singer: m.singer.name, pct: m[dim], reasons: m.reasons }));
  profile.fingerprint.similarity_vectors = {
    acoustic_voice: top("acoustic"),
    technique: top("technique"),
    performance_style: top("delivery"),
    overall: state.matches.slice(0, 5).map((m) => ({ singer: m.singer.name, pct: m.matchPct, reasons: m.reasons })),
  };

  renderVoice(profile);
  renderFingerprint(profile, state.matches);
  renderSingers(state.matches.slice(0, 7), profile);
  renderGenres(genres);
  renderSongs();
  showScreen("results");
  // The carousel measures its container, which has no width while hidden.
  layoutCarousel();
}

function renderVoice(p) {
  $("voice-type").textContent = p.voiceType;
  $("voice-desc").textContent = `Estimated from what you sang — ${p.voiceDesc}. In short: ${p.descriptor.voice}.`;

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

/* ---------- Vocal fingerprint ---------- */

function confDot(c) {
  const level = c === 0 ? "none" : c <= 0.4 ? "low" : c <= 0.6 ? "mid" : "high";
  const dot = el("span", "conf conf-" + level);
  dot.title = confidenceWord(c) + (c ? ` (${c.toFixed(2)})` : "");
  return dot;
}

function renderFingerprint(p, matches) {
  const d = p.descriptor;
  const grid = $("dim-grid");
  grid.replaceChildren();
  [
    ["Voice", d.voice, "what it physically sounds like"],
    ["Technique", d.technique.join(", ") || "—", "how you use it"],
    ["Delivery", d.delivery.join(", ") || "—", "how the performance feels"],
    ["Style", d.style.join(" / ") || "—", "where it sits musically"],
  ].forEach(([k, v, hint]) => {
    const card = el("div", "dim-card");
    card.append(el("div", "dim-key", k), el("div", "dim-val", v), el("div", "dim-hint", hint));
    grid.append(card);
  });

  const list = $("fp-list");
  list.replaceChildren();
  p.summary.forEach((row) => {
    const wrap = el("div", "fp-row" + (row.confidence === 0 ? " unmeasured" : ""));
    const dt = el("dt");
    dt.append(confDot(row.confidence), document.createTextNode(row.label));
    wrap.append(dt, el("dd", null, row.text));
    list.append(wrap);
  });

  const dist = $("distinguish");
  dist.replaceChildren();
  const traits = distinguishingTraits(p);
  if (traits.length) {
    dist.append(el("h3", null, "What stands out"));
    const ul = el("ul");
    traits.forEach((t) => ul.append(el("li", null, t.text)));
    dist.append(ul);
  }

  const dm = $("dim-matches");
  dm.replaceChildren();
  const shared = (a, b) => a.filter((t) => b.includes(t));
  [
    ["Acoustic voice", "acoustic", (m) => `closest on ${m.reasons.slice(0, 2).join(" & ")}`],
    ["Vocal technique", "technique", (m) => { const s = shared(p.techniqueTags, m.singer.technique); return s.length ? `you both: ${s.join(", ")}` : "similar vibrato and texture"; }],
    ["Performance style", "delivery", (m) => `you both: ${shared(p.deliveryTags, m.singer.delivery).join(", ")}`],
    ["Overall", "matchPct", () => "55% voice · 25% technique · 20% delivery"],
  ].forEach(([label, dim, why]) => {
    const best = dim === "matchPct" ? matches[0] : rankBy(matches, dim)[0];
    const row = el("div", "dm-row");
    row.append(el("span", "dm-label", label));
    if (!best) {
      row.append(el("span", "dm-val", "—"), el("span", "dm-why", "not enough evidence in this line"));
    } else {
      row.append(el("span", "dm-val", `${best.singer.name} · ${best[dim]}%`), el("span", "dm-why", why(best)));
    }
    dm.append(row);
  });

  $("fp-json").textContent = JSON.stringify(p.fingerprint, null, 2);
}

$("copy-json").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("fp-json").textContent);
    $("copy-json").textContent = "Copied";
    setTimeout(() => { $("copy-json").textContent = "Copy JSON"; }, 1500);
  } catch {
    /* clipboard blocked — the JSON is still visible to select */
  }
});

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

  matches.forEach(({ singer, matchPct, acoustic, technique, delivery }, i) => {
    const item = el("article", "cf-item");

    const label = el("div", "cf-label");
    label.append(el("h3", null, rankLabel(i)));
    label.append(el("p", null, `${matchPct}% overall match`));
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
    const scores = el("div", "cf-scores");
    [["Voice", acoustic], ["Technique", technique], ["Delivery", delivery]].forEach(([k, v]) => {
      const cell = el("span");
      cell.append(el("b", null, v === null ? "—" : `${v}%`), document.createTextNode(k));
      scores.append(cell);
    });
    card.append(scores);

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
  const { singer, reasons } = carousel.matches[carousel.active];
  const profile = carousel.profile;
  const wrap = $("singer-detail");
  wrap.replaceChildren();

  wrap.append(el("p", "dm-reasons", "Closest on " + reasons.join(", ")));
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

const SPOTIFY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.3 14.5a.6.6 0 0 1-.85.2c-2.3-1.4-5.2-1.7-8.6-.95a.62.62 0 0 1-.28-1.2c3.7-.85 6.9-.5 9.5 1.1.3.18.4.58.23.85zm1.15-2.6a.78.78 0 0 1-1.07.26c-2.65-1.63-6.7-2.1-9.83-1.15a.78.78 0 1 1-.45-1.5c3.6-1.1 8.05-.56 11.1 1.32.37.23.48.7.25 1.07zm.1-2.7C14.4 9.3 9.15 9.13 6.1 10.05a.94.94 0 1 1-.55-1.8c3.5-1.06 9.3-.86 12.95 1.3a.94.94 0 0 1-.95 1.65z"/></svg>';
const MIC_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4zm6-4a6 6 0 0 1-5 5.92V20h3v2H8v-2h3v-3.08A6 6 0 0 1 6 11h2a4 4 0 0 0 8 0h2z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';

function iconLink(cls, href, label, svg) {
  const a = el("a", "icon-btn " + cls);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = label;
  a.setAttribute("aria-label", label);
  a.innerHTML = svg;
  return a;
}

function chartRow(song, rank) {
  const row = el("article", "chart-row");
  row.append(el("span", "rank", String(rank)));

  const art = el("div", "chart-art");
  const [c1, c2] = coverColours(song.singerId);
  art.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  art.append(el("span", "chart-initials", initials(song.artist)));
  const play = el("a", "play-overlay");
  play.href = youtubeUrl(song.title, song.artist);
  play.target = "_blank";
  play.rel = "noopener";
  play.title = "Watch on YouTube";
  play.setAttribute("aria-label", `Watch ${song.title} by ${song.artist} on YouTube`);
  play.innerHTML = MIC_ICON;
  art.append(play);
  row.append(art);

  const info = el("div", "chart-info");
  info.append(el("div", "song-title", song.title));
  info.append(el("div", "song-meta", `${song.artist} · ${song.voiceType}`));
  row.append(info);

  const actions = el("div", "chart-actions");
  actions.append(iconLink("spotify", spotifyUrl(song.title, song.artist), "Open on Spotify", SPOTIFY_ICON));
  actions.append(linkButton("karaoke small", "🎤 Karaoke", karaokeUrl(song.title, song.artist)));
  const x = el("button", "icon-btn unmatch", "✕");
  x.type = "button";
  x.title = "Not for me — suggest something else";
  x.setAttribute("aria-label", `Unmatch ${song.title}`);
  x.addEventListener("click", () => unmatchSong(song));
  actions.append(x);
  row.append(actions);
  return row;
}

function renderSongs() {
  const songs = activeSongs();
  const list = $("songs");
  const featuredWrap = $("featured");
  list.replaceChildren();
  featuredWrap.replaceChildren();

  if (!songs.length) {
    featuredWrap.append(el("p", "empty", "You've unmatched every suggestion — reset to see them again."));
    $("songs-pager").hidden = true;
    return;
  }

  featuredWrap.append(songCard(songs[0], { featured: true, dismissable: false }));

  const pages = Math.max(1, Math.ceil(songs.length / SONGS_PER_PAGE));
  state.songPage = Math.min(state.songPage, pages - 1);
  const offset = state.showAll ? 0 : state.songPage * SONGS_PER_PAGE;
  const shown = state.showAll ? songs : songs.slice(offset, offset + SONGS_PER_PAGE);
  shown.forEach((song, i) => list.append(chartRow(song, offset + i + 1)));

  $("songs-pager").hidden = state.showAll || pages <= 1;
  $("songs-prev").disabled = state.songPage === 0;
  $("songs-next").disabled = state.songPage >= pages - 1;
  $("songs-page").textContent = `${state.songPage + 1} / ${pages}`;
  $("see-all-btn").innerHTML = state.showAll ? "Show less <span aria-hidden=\"true\">›</span>" : "See all <span aria-hidden=\"true\">›</span>";
}

function unmatchSong(song) {
  state.dismissed.add(song.id);
  saveDismissed();
  // Nudge this singer down so the replacement is more likely to be a different voice.
  state.singerPenalty.set(song.singerId, (state.singerPenalty.get(song.singerId) || 0) + 0.06);
  rebuildSongPool();
  renderSongs();
}

$("see-all-btn").addEventListener("click", () => {
  state.showAll = !state.showAll;
  renderSongs();
});

$("songs-prev").addEventListener("click", () => { state.songPage--; renderSongs(); });
$("songs-next").addEventListener("click", () => { state.songPage++; renderSongs(); });

$("reset-btn").addEventListener("click", () => {
  state.dismissed.clear();
  saveDismissed();
  state.singerPenalty = new Map();
  state.songPage = 0;
  rebuildSongPool();
  renderSongs();
});
