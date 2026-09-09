"use strict";

/*
 * Sing with friends: record one singer at a time, then find duets and
 * sing-alongs whose parts sit comfortably in everyone's range.
 */

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
const SINGER_COLOURS = ["#ffd166", "#4cc9f0", "#ff7b9c", "#80ed99", "#c77dff", "#ffa94d"];
const MAX_SINGERS = SINGER_COLOURS.length;

const recorder = new VoiceRecorder();
let uiTimer = null;
let selectedLine = "";
const singers = []; // { id, name, colour, profile, blobPromise, url, remote }
const ROSTER_KEY = "revoice:friends-roster";
const LANG_KEY = "revoice:lang";
let lang = "en";
try { const saved = localStorage.getItem(LANG_KEY); if (saved && (saved === "any" || LANGUAGES.some((l) => l.code === saved))) lang = saved; } catch { /* default */ }
const invite = { active: false, from: "", profile: null, name: "" };

/* ---------- Helpers ---------- */

function showScreen(name) {
  Object.entries(screens).forEach(([key, node]) => { node.hidden = key !== name; });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pct(midi) {
  const clamped = Math.min(RANGE_BAR_HIGH, Math.max(RANGE_BAR_LOW, midi));
  return ((clamped - RANGE_BAR_LOW) / (RANGE_BAR_HIGH - RANGE_BAR_LOW)) * 100;
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

function coverColours(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue} 75% 55%)`, `hsl(${(hue + 50) % 360} 80% 40%)`];
}

function listNames(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " & " + items[items.length - 1];
}

const MIC_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4zm6-4a6 6 0 0 1-5 5.92V20h3v2H8v-2h3v-3.08A6 6 0 0 1 6 11h2a4 4 0 0 0 8 0h2z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const SPOTIFY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.3 14.5a.6.6 0 0 1-.85.2c-2.3-1.4-5.2-1.7-8.6-.95a.62.62 0 0 1-.28-1.2c3.7-.85 6.9-.5 9.5 1.1.3.18.4.58.23.85zm1.15-2.6a.78.78 0 0 1-1.07.26c-2.65-1.63-6.7-2.1-9.83-1.15a.78.78 0 1 1-.45-1.5c3.6-1.1 8.05-.56 11.1 1.32.37.23.48.7.25 1.07zm.1-2.7C14.4 9.3 9.15 9.13 6.1 10.05a.94.94 0 1 1-.55-1.8c3.5-1.06 9.3-.86 12.95 1.3a.94.94 0 0 1-.95 1.65z"/></svg>';
const YOUTUBE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M21.6 7.2a2.5 2.5 0 0 0-1.76-1.77C18.3 5 12 5 12 5s-6.3 0-7.84.43A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.76 1.77C5.7 19 12 19 12 19s6.3 0 7.84-.43a2.5 2.5 0 0 0 1.76-1.77A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3z"/></svg>';

/* ---------- Sharing voices by link ---------- */

// Only what the group analysis needs, so a voice fits in a URL fragment.
function compactProfile(p, name) {
  return {
    n: name, l: +p.lowMidi.toFixed(2), h: +p.highMidi.toFixed(2), m: +p.medianMidi.toFixed(2),
    t: p.voiceType, d: p.voiceDesc, v: p.descriptor.voice, s: p.steadiness,
    k: p.techniqueTags.slice(0, 3), b: p.scores.brightness, r: p.scores.breathiness,
  };
}

function expandProfile(c) {
  return {
    lowMidi: c.l, highMidi: c.h, medianMidi: c.m,
    lowNote: midiToNote(c.l), highNote: midiToNote(c.h), medianNote: midiToNote(c.m),
    voiceType: c.t, voiceDesc: c.d, descriptor: { voice: c.v }, steadiness: c.s,
    techniqueTags: c.k || [], scores: { brightness: c.b, breathiness: c.r },
  };
}

function encodeData(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeData(str) {
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch {
    return null;
  }
}

function pageUrl() {
  return location.origin + location.pathname;
}

function saveRoster() {
  try {
    localStorage.setItem(ROSTER_KEY, JSON.stringify(singers.map((s) => ({ id: s.id, remote: !!s.remote, ...compactProfile(s.profile, s.name) }))));
  } catch {
    /* storage unavailable — the roster just won't survive a reload */
  }
}

function loadRoster() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROSTER_KEY) || "[]");
    saved.slice(0, MAX_SINGERS).forEach((c) => addSinger(expandProfile(c), c.n, { id: c.id, remote: c.remote, silent: true }));
  } catch {
    /* ignore corrupt storage */
  }
}

function addSinger(profile, name, { id, remote = false, blobPromise = null, silent = false } = {}) {
  if (singers.length >= MAX_SINGERS) return null;
  if (id && singers.some((s) => s.id === id)) return null;
  const singer = { id: id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || nextSingerLabel(), colour: SINGER_COLOURS[singers.length], profile, blobPromise, url: null, remote };
  singers.push(singer);
  if (!silent) saveRoster();
  return singer;
}

function notify(text) {
  const n = $("notice");
  n.textContent = text;
  n.hidden = false;
}

async function shareLink(url, title, text, button) {
  try {
    if (navigator.share) {
      await navigator.share({ title, text, url });
      return true;
    }
    await navigator.clipboard.writeText(url);
    if (button) { const old = button.textContent; button.textContent = "Link copied ✓"; setTimeout(() => { button.textContent = old; }, 2000); }
    return true;
  } catch {
    return false;
  }
}

function inviteLink() {
  const from = singers[0] ? singers[0].name : "A friend";
  return pageUrl() + "#invite=" + encodeData({ from, line: selectedLine, lang });
}

function enterInviteMode(data) {
  invite.active = true;
  invite.from = (data && data.from) || "A friend";
  if (data && data.lang) { lang = data.lang; $("lang-select").value = lang; }
  if (data && data.line) {
    selectedLine = data.line;
    document.querySelectorAll("#prompt-chips .chip").forEach((c) => c.classList.toggle("selected", c.dataset.line === data.line));
  }
  $("intro-title").textContent = `${invite.from} invited you to sing together`;
  $("intro-lead").textContent = "Sing the line below on your own. We'll describe your voice and give you a link to send back, so you can be matched for duets even when you're apart.";
  $("tap-label").textContent = "Tap to sing";
  $("roster").hidden = true;
  $("finish-btn").hidden = true;
  $("invite-btn").hidden = true;
  $("invite-panel").hidden = false;
}

function showInviteResult(profile) {
  invite.profile = profile;
  const result = $("invite-result");
  result.hidden = false;
  $("invite-name").value = invite.name;
  $("invite-avatar").textContent = invite.name ? initials(invite.name) : "?";
  $("invite-meta").textContent = `${profile.voiceType} · sang ${profile.lowNote}–${profile.highNote} · ${profile.descriptor.voice}`;
  $("invite-desc").textContent = describeVoice({ profile, name: "You" }).replace(/^You /, "");
  $("tap-label").textContent = "Not happy with that take? Tap to sing again";
}

$("invite-name").addEventListener("input", (e) => {
  invite.name = e.target.value.trim();
  $("invite-avatar").textContent = invite.name ? initials(invite.name) : "?";
});

$("send-voice-btn").addEventListener("click", async (e) => {
  if (!invite.profile) return;
  const name = invite.name || "Your friend";
  const url = pageUrl() + "#voice=" + encodeData({ id: Date.now().toString(36), ...compactProfile(invite.profile, name) });
  const ok = await shareLink(url, "ReVoice", `${name}'s voice for our duet — open this on ReVoice:`, e.currentTarget);
  notify(ok ? `Send that link to ${invite.from}. When they open it, your voice joins their roster.` : "Couldn't share automatically — copy the address bar link after tapping again.");
});

$("invite-btn").addEventListener("click", async (e) => {
  const ok = await shareLink(inviteLink(), "ReVoice — sing with me", `${singers[0] ? singers[0].name : "I"} want to find a duet for us. Sing one line here:`, e.currentTarget);
  notify(ok ? "Invite link ready. When your friend sends their voice link back, open it on this device and they'll appear here." : "Couldn't share automatically — please copy the link from your browser.");
});

function handleIncomingLink() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return;
  const [key, value] = hash.split("=");
  if (key === "invite") {
    enterInviteMode(decodeData(decodeURIComponent(value)));
    return;
  }
  if (key === "voice") {
    const c = decodeData(decodeURIComponent(value));
    history.replaceState(null, "", location.pathname);
    if (!c || typeof c.l !== "number") { notify("That voice link didn't work — ask your friend to send it again."); return; }
    const added = addSinger(expandProfile(c), c.n, { id: c.id, remote: true });
    notify(added ? `${c.n}'s voice has been added — ${c.t}, ${c.v}. Record yourself if you haven't, then finish to analyse.` : `${c.n} is already in your roster.`);
  }
}

/* ---------- Language ---------- */

(() => {
  const sel = $("lang-select");
  LANGUAGES.forEach((l) => { const o = document.createElement("option"); o.value = l.code; o.textContent = l.label; sel.append(o); });
  const any = document.createElement("option");
  any.value = "any";
  any.textContent = "Any language";
  sel.append(any);
  sel.value = lang;
  sel.addEventListener("change", (e) => {
    lang = e.target.value;
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* fine */ }
  });
})();

/* ---------- Intro / roster ---------- */

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

function nextSingerLabel() {
  return `Singer ${singers.length + 1}`;
}

function renderRoster() {
  const roster = $("roster");
  roster.replaceChildren();
  singers.forEach((s, i) => {
    const card = el("div", "roster-card");
    card.style.setProperty("--singer-colour", s.colour);
    card.append(el("span", "roster-dot"));

    const info = el("div");
    const name = el("input", "roster-name");
    name.type = "text";
    name.value = s.name;
    name.maxLength = 24;
    name.setAttribute("aria-label", `Name for singer ${i + 1}`);
    name.addEventListener("input", () => { s.name = name.value.trim() || `Singer ${i + 1}`; saveRoster(); });
    info.append(name);
    info.append(el("div", "roster-meta", `${s.remote ? "📨 shared by link · " : ""}${s.profile.voiceType} · sang ${s.profile.lowNote}–${s.profile.highNote} · ${s.profile.descriptor.voice}`));
    card.append(info);

    const actions = el("div", "roster-actions");
    if (s.blobPromise) {
      const play = el("button", "roster-btn");
      play.type = "button";
      play.title = "Replay";
      play.innerHTML = PLAY_ICON;
      play.addEventListener("click", () => replaySinger(s, play));
      actions.append(play);
    }
    const remove = el("button", "roster-btn", "✕");
    remove.type = "button";
    remove.title = "Remove this singer";
    remove.addEventListener("click", () => { singers.splice(i, 1); saveRoster(); renderRoster(); });
    actions.append(remove);
    card.append(actions);
    roster.append(card);
  });

  if (invite.active) return;
  const full = singers.length >= MAX_SINGERS;
  $("tap-label").textContent = full ? "That's the maximum — finish to analyse" : `${nextSingerLabel()} — tap to sing`;
  $("start-btn").disabled = full;
  $("finish-btn").hidden = singers.length < 2;
  $("finish-btn").textContent = `Finish & analyse ${singers.length} voices`;
}

/* ---------- Replay ---------- */

const player = new Audio();
let playing = null; // { singer, button }

function stopReplay() {
  player.pause();
  if (playing) playing.button.innerHTML = PLAY_ICON;
  playing = null;
}

async function replaySinger(singer, button) {
  if (playing && playing.singer === singer) { stopReplay(); return; }
  stopReplay();
  if (!singer.url) {
    const blob = singer.blobPromise ? await singer.blobPromise : null;
    if (!blob) return;
    singer.url = URL.createObjectURL(blob);
  }
  player.src = singer.url;
  playing = { singer, button };
  button.innerHTML = PAUSE_ICON;
  player.play().catch(stopReplay);
}
player.addEventListener("ended", stopReplay);

/* ---------- Recording ---------- */

async function startRecording() {
  $("error").hidden = true;
  $("lyric").textContent = selectedLine;
  $("live-note").textContent = "—";
  $("record-label").textContent = `${nextSingerLabel()} — listening… tap to finish`;
  $("stop-btn").style.setProperty("--pulse", 1);
  $("elapsed").textContent = "0.0";
  stopReplay();

  try {
    await recorder.start(onFrame);
  } catch (err) {
    $("error").textContent = err && err.name === "NotAllowedError"
      ? "Microphone access was denied. Please allow the microphone and try again."
      : "Couldn't start the microphone: " + (err && err.message ? err.message : err);
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
  const pulse = 1 + Math.min(0.12, rms * 0.6);
  $("stop-btn").style.setProperty("--pulse", pulse.toFixed(3));
  if (freq > 0 && rms > 0.015) $("live-note").textContent = midiToNote(freqToMidi(freq));
}

function finishRecording() {
  clearInterval(uiTimer);
  uiTimer = null;
  const tooShort = recorder.elapsed() < MIN_RECORD_MS;
  const samples = recorder.stop();
  const blobPromise = recorder.blobPromise;
  const profile = tooShort ? null : analyseSamples(samples);

  showScreen("intro");
  if (!profile) {
    $("error").textContent = tooShort
      ? "That was a bit short — sing for at least a few seconds so we can hear the range."
      : "We couldn't pick up a clear singing voice. Move closer to the mic, sing a little louder, and try again.";
    $("error").hidden = false;
    return;
  }

  if (invite.active) {
    showInviteResult(profile);
    return;
  }
  addSinger(profile, nextSingerLabel(), { blobPromise });
  renderRoster();
}

$("start-btn").addEventListener("click", startRecording);
$("stop-btn").addEventListener("click", finishRecording);
$("cancel-btn").addEventListener("click", () => {
  clearInterval(uiTimer);
  uiTimer = null;
  if (recorder.timer) recorder.stop();
  showScreen("intro");
});
$("finish-btn").addEventListener("click", () => { if (singers.length >= 2) runGroupAnalysis(); });
$("add-btn").addEventListener("click", () => { stopReplay(); showScreen("intro"); renderRoster(); });
$("again-btn").addEventListener("click", () => {
  stopReplay();
  singers.forEach((s) => { if (s.url) URL.revokeObjectURL(s.url); });
  singers.length = 0;
  saveRoster();
  renderRoster();
  showScreen("intro");
});

/* ---------- Group analysis ---------- */

const clamp01f = (v) => Math.max(0, Math.min(1, v));

// How well a singer's usable range covers a written part, allowing the part
// to be sung an octave up or down. Returns { fit 0–1, shift }.
function partFit(profile, lowNote, highNote, { allowShift = true, shiftPenalty = 0.9 } = {}) {
  const pLow = noteToMidi(lowNote);
  const pHigh = noteToMidi(highNote);
  const shifts = allowShift ? [0, 12, -12] : [0];
  let best = { fit: 0, shift: 0 };
  shifts.forEach((shift) => {
    const lo = pLow + shift;
    const hi = pHigh + shift;
    const overlap = Math.max(0, Math.min(profile.highMidi, hi) - Math.max(profile.lowMidi, lo));
    // One sung line rarely shows a full range, so a singer whose sung notes sit
    // inside the part counts as covering it; a wider part is not held against them.
    const target = Math.min(hi - lo, profile.highMidi - profile.lowMidi + 5);
    const coverage = overlap / Math.max(1, target);
    const comfort = 1 - clamp01f(Math.abs(profile.medianMidi - (lo + hi) / 2) / 8);
    let fit = 0.65 * coverage + 0.35 * comfort;
    if (shift !== 0) fit *= shiftPenalty;
    if (fit > best.fit) best = { fit, shift };
  });
  return best;
}

function groupScore(fits) {
  const min = Math.min(...fits);
  const mean = fits.reduce((a, b) => a + b, 0) / fits.length;
  return 0.5 * min + 0.5 * mean;
}

function rankDuets(a, b) {
  const { list, fellBack } = byLanguage(DUETS, lang, 3);
  $("duets-sub").textContent = (fellBack ? `Not many ${languageLabel(lang)} duets yet, so these span all languages. ` : lang === "any" ? "" : `${languageLabel(lang)} duets. `) + "Tap the artwork for the karaoke version. Each row says who takes which part.";
  return list.map((duet) => {
    const [p0, p1] = duet.parts;
    const straight = [partFit(a.profile, p0.low, p0.high), partFit(b.profile, p1.low, p1.high)];
    const swapped = [partFit(a.profile, p1.low, p1.high), partFit(b.profile, p0.low, p0.high)];
    const sStraight = groupScore(straight.map((f) => f.fit));
    const sSwapped = groupScore(swapped.map((f) => f.fit));
    const useSwap = sSwapped > sStraight;
    const fits = useSwap ? swapped : straight;
    return {
      duet,
      score: useSwap ? sSwapped : sStraight,
      assignment: [
        { singer: a, part: useSwap ? p1 : p0, shift: fits[0].shift },
        { singer: b, part: useSwap ? p0 : p1, shift: fits[1].shift },
      ],
    };
  }).sort((x, y) => y.score - x.score);
}

function rankGroupSongs(list) {
  const { list: songs, fellBack } = byLanguage(GROUP_SONGS, lang, 5);
  $("group-sub").textContent = (fellBack ? `Not many ${languageLabel(lang)} sing-alongs yet, so these span all languages. ` : lang === "any" ? "" : `${languageLabel(lang)} songs. `) + "Melodies that sit comfortably in all your voices — everyone sings in their own octave.";
  return songs.map((song) => {
    const fits = list.map((s) => partFit(s.profile, song.low, song.high, { shiftPenalty: 0.97 }));
    return { song, score: groupScore(fits.map((f) => f.fit)), fits };
  }).sort((x, y) => y.score - x.score);
}

function describeVoice(s) {
  const p = s.profile;
  const bits = [
    `${p.voiceDesc.charAt(0).toUpperCase() + p.voiceDesc.slice(1)}.`,
    `Sang ${p.lowNote}–${p.highNote}, most comfortable around ${p.medianNote}.`,
    `Sounds ${p.descriptor.voice.replace(/\//g, ", ")}, with ${p.steadiness === "steady" ? "steady" : p.steadiness === "expressive" ? "expressive, moving" : "loose, free-moving"} pitch` +
      (p.techniqueTags.length ? ` and a touch of ${p.techniqueTags.slice(0, 2).join(" and ")}.` : "."),
  ];
  return bits.join(" ");
}

function describeFit(list) {
  const rows = [];
  const medians = list.map((s) => s.profile.medianMidi);
  const spread = Math.max(...medians) - Math.min(...medians);
  const lowestName = list[medians.indexOf(Math.min(...medians))].name;
  const highestName = list[medians.indexOf(Math.max(...medians))].name;

  if (list.length === 2) {
    const d = Math.round(spread);
    if (d < 3) rows.push(["🎯", "Your comfort zones almost coincide — sing in unison, or split into a simple harmony a third apart."]);
    else if (d < 7) rows.push(["🎶", `Your comfort zones sit about ${d} semitones apart — close enough to harmonise easily, with ${highestName} naturally taking the upper line.`]);
    else if (d < 10) rows.push(["🎵", `About ${d} semitones between you — a comfortable gap for call-and-response verses and shared choruses.`]);
    else rows.push(["🎼", `Roughly an octave apart (${d} semitones) — classic duet spacing, with ${lowestName} on the lower part and ${highestName} on the higher one.`]);
  } else {
    rows.push(["🎼", `Comfort zones span ${Math.round(spread)} semitones from ${lowestName} (lowest) to ${highestName} (highest) — everyone can sing the same melody in their own octave.`]);
  }

  const sharedLow = Math.max(...list.map((s) => s.profile.lowMidi));
  const sharedHigh = Math.min(...list.map((s) => s.profile.highMidi));
  if (sharedHigh - sharedLow >= 3) {
    rows.push(["🤝", `You all share the notes from ${midiToNote(sharedLow)} to ${midiToNote(sharedHigh)} — a melody that lives there works for everyone at once.`]);
  } else {
    rows.push(["↕️", "Your ranges barely overlap, so pick songs with separate parts, or sing the same tune an octave apart."]);
  }

  const bright = list.map((s) => s.profile.scores.brightness);
  const bSpread = Math.max(...bright) - Math.min(...bright);
  if (bSpread < 15) rows.push(["✨", "Similar tone colours — your voices will blend into one sound rather than stand apart."]);
  else {
    const bi = bright.indexOf(Math.max(...bright));
    rows.push(["🌗", `Contrasting tones — ${list[bi].name}'s brighter voice will naturally sit on top, giving the blend definition.`]);
  }

  const breathy = list.filter((s) => s.profile.scores.breathiness >= 55).map((s) => s.name);
  if (breathy.length && breathy.length < list.length) rows.push(["🌬️", `${listNames(breathy)} ${breathy.length === 1 ? "has" : "have"} a softer, breathier delivery — gentle ballads and acoustic duets will flatter the mix.`]);
  return rows;
}

function runGroupAnalysis() {
  stopReplay();
  const list = singers.slice();
  const types = list.map((s) => s.profile.voiceType);
  $("group-title").textContent = listNames(types);
  const fitRows = describeFit(list);
  $("group-desc").textContent = `${list.length} voices — ${listNames(list.map((s) => s.name))}. ${fitRows[0][1]}`;

  // combined range
  const lanes = $("multi-range");
  lanes.replaceChildren();
  list.forEach((s) => {
    const lane = el("div", "lane");
    lane.style.setProperty("--singer-colour", s.colour);
    const fill = el("div", "range-fill");
    fill.style.left = pct(s.profile.lowMidi) + "%";
    fill.style.width = Math.max(1.5, pct(s.profile.highMidi) - pct(s.profile.lowMidi)) + "%";
    const marker = el("div", "range-marker");
    marker.style.left = pct(s.profile.medianMidi) + "%";
    lane.title = `${s.name}: ${s.profile.lowNote}–${s.profile.highNote}`;
    lane.append(fill, marker);
    lanes.append(lane);
  });

  const voices = $("voice-list");
  voices.replaceChildren();
  list.forEach((s) => {
    const card = el("article", "voice-card");
    card.style.setProperty("--singer-colour", s.colour);
    card.append(el("div", "voice-avatar", initials(s.name)));
    const body = el("div");
    const head = el("h3", null, s.name + " ");
    head.append(el("span", "voice-type", s.profile.voiceType));
    body.append(head, el("p", null, describeVoice(s)));
    card.append(body);
    if (s.blobPromise) {
      const play = el("button", "voice-replay");
      play.type = "button";
      play.title = `Replay ${s.name}`;
      play.innerHTML = PLAY_ICON;
      play.addEventListener("click", () => replaySinger(s, play));
      card.append(play);
    } else {
      card.append(el("span"));
    }
    voices.append(card);
  });

  const fitList = $("fit-list");
  fitList.replaceChildren();
  fitRows.forEach(([icon, text]) => {
    const row = el("div", "fit-row");
    row.append(el("span", "fit-icon", icon), el("span", null, text));
    fitList.append(row);
  });

  // duets (exactly two singers)
  const duetsBlock = $("duets-block");
  duetsBlock.hidden = list.length !== 2;
  if (list.length === 2) {
    const wrap = $("duets");
    wrap.replaceChildren();
    rankDuets(list[0], list[1]).slice(0, 8).forEach((r, i) => wrap.append(duetRow(r, i + 1)));
  }

  $("group-heading").textContent = list.length === 2 ? "Sing together in unison" : "Sing-alongs for everyone";
  const gs = $("group-songs");
  gs.replaceChildren();
  rankGroupSongs(list).slice(0, 8).forEach((r, i) => gs.append(groupRow(r, list, i + 1)));

  showScreen("results");
}

/* ---------- Song rows ---------- */

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

function artTile(title, artist, seed) {
  const art = el("div", "chart-art");
  const [c1, c2] = coverColours(seed);
  art.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  art.append(el("span", "chart-initials", initials(artist)));
  const play = el("a", "play-overlay");
  play.href = karaokeUrl(title, artist);
  play.target = "_blank";
  play.rel = "noopener";
  play.title = "Sing the karaoke version on YouTube";
  play.setAttribute("aria-label", `Karaoke: ${title}`);
  play.innerHTML = MIC_ICON;
  art.append(play);
  return art;
}

function partTag(singer, text) {
  const tag = el("span", "part-tag");
  tag.style.setProperty("--singer-colour", singer.colour);
  tag.append(el("i"), document.createTextNode(text));
  return tag;
}

function songRow(rank, title, artist, seed, metaNode, fitPct) {
  const row = el("article", "chart-row");
  row.append(el("span", "rank", String(rank)));
  row.append(artTile(title, artist, seed));
  const info = el("div", "chart-info");
  info.append(el("div", "song-title", title));
  const meta = el("div", "song-meta wrap");
  meta.append(document.createTextNode(artist + " · "), el("span", "fit-pill", `${fitPct}% fit`));
  info.append(meta, metaNode);
  row.append(info);
  const actions = el("div", "chart-actions");
  actions.append(iconLink("spotify", spotifyUrl(title, artist), "Open on Spotify", SPOTIFY_ICON));
  actions.append(iconLink("youtube", youtubeUrl(title, artist), "Watch on YouTube", YOUTUBE_ICON));
  row.append(actions);
  return row;
}

function duetRow(r, rank) {
  const tags = el("div", "part-tags");
  r.assignment.forEach(({ singer, part, shift }) => {
    tags.append(partTag(singer, `${singer.name}: ${part.name}'s part${shift ? (shift > 0 ? " (an octave up)" : " (an octave down)") : ""}`));
  });
  return songRow(rank, r.duet.title, r.duet.artists, r.duet.title, tags, Math.min(99, Math.round(r.score * 100)));
}

function groupRow(r, list, rank) {
  const tags = el("div", "part-tags");
  r.fits.forEach((f, i) => {
    tags.append(partTag(list[i], `${list[i].name}${f.shift ? (f.shift > 0 ? " · octave up" : " · octave down") : ""}`));
  });
  return songRow(rank, r.song.title, r.song.artist, r.song.title, tags, Math.min(99, Math.round(r.score * 100)));
}

renderRoster();

loadRoster();
handleIncomingLink();
renderRoster();
// A voice link opened while this page is already showing only changes the hash.
window.addEventListener("hashchange", () => { handleIncomingLink(); renderRoster(); });
