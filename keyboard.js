"use strict";

/*
 * Piano-keyboard range chart, C2–C6. Each singer's range is drawn as a lane
 * above the keys with its lowest and highest note labelled, and the keys they
 * sang are lit in their colour. Shared by the solo and friends pages.
 *
 * ranges: [{ low, high, median, colour, label }]  (midi numbers)
 */

const KB_LOW = 36;  // C2
const KB_HIGH = 84; // C6
const KB_WHITE_OFFSET = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6];
const KB_IS_BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

function kbWhiteIndex(midi) {
  const rel = Math.round(midi) - KB_LOW;
  return Math.floor(rel / 12) * 7 + KB_WHITE_OFFSET[((rel % 12) + 12) % 12];
}

function renderKeyboardRange(container, ranges, { caption = true } = {}) {
  const whiteCount = kbWhiteIndex(KB_HIGH) + 1;
  const W = 1000;
  const keyW = W / whiteCount;
  // a lane is: [name row (only when labelled)] + label row + bar row
  const laneHeights = ranges.map((r) => (r.label ? 92 : 62));
  const laneTops = laneHeights.map((_, i) => laneHeights.slice(0, i).reduce((a, b) => a + b, 0) + 8);
  const lanesH = laneHeights.reduce((a, b) => a + b, 0) + 16;
  const keysTop = lanesH;
  const whiteH = 64;
  const blackH = 40;
  const H = keysTop + whiteH + 36;
  const x = (midi) => kbWhiteIndex(midi) * keyW;
  const clamp = (m) => Math.max(KB_LOW, Math.min(KB_HIGH, m));
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const inRange = (midi) => ranges.find((r) => midi >= Math.round(r.low) && midi <= Math.round(r.high));

  let svg = `<svg class="kb" viewBox="0 0 ${W} ${H}" role="img" aria-label="Piano keyboard from C2 to C6 with the sung range highlighted">`;

  // white keys
  for (let m = KB_LOW; m <= KB_HIGH; m++) {
    if (KB_IS_BLACK[m % 12]) continue;
    const r = inRange(m);
    svg += `<rect x="${x(m) + 1}" y="${keysTop}" width="${keyW - 2}" height="${whiteH}" rx="4" fill="${r ? r.colour : "#ffffff"}" fill-opacity="${r ? 0.55 : 1}" stroke="#d9d2ea" stroke-width="1.5"/>`;
  }
  // black keys
  for (let m = KB_LOW; m <= KB_HIGH; m++) {
    if (!KB_IS_BLACK[m % 12]) continue;
    const r = inRange(m);
    svg += `<rect x="${x(m) + keyW * 0.18}" y="${keysTop}" width="${keyW * 0.64}" height="${blackH}" rx="3" fill="${r ? r.colour : "#2a2140"}" stroke="#2a2140" stroke-width="1.5"/>`;
  }
  // octave labels under the C keys
  for (let m = KB_LOW; m <= KB_HIGH; m += 12) {
    svg += `<text x="${x(m) + keyW / 2}" y="${keysTop + whiteH + 28}" text-anchor="middle" font-size="26" font-weight="700" fill="#6d6486">${midiToNote(m)}</text>`;
  }

  // lanes: bar across the sung keys, labels on either side so they never collide
  ranges.forEach((r, i) => {
    const yTop = laneTops[i];
    const yName = yTop + 24;
    const yFlip = yTop + (r.label ? 54 : 24);
    const yBar = yTop + (r.label ? 66 : 36);
    const lo = clamp(r.low), hi = clamp(r.high);
    const x1 = x(lo), x2 = x(hi) + keyW;
    svg += `<rect x="${x1}" y="${yBar}" width="${Math.max(keyW, x2 - x1)}" height="14" rx="7" fill="${r.colour}"/>`;
    svg += `<line x1="${x1 + 1}" y1="${yBar + 14}" x2="${x1 + 1}" y2="${keysTop}" stroke="${r.colour}" stroke-width="2" stroke-dasharray="3 3"/>`;
    svg += `<line x1="${x2 - 1}" y1="${yBar + 14}" x2="${x2 - 1}" y2="${keysTop}" stroke="${r.colour}" stroke-width="2" stroke-dasharray="3 3"/>`;
    const fs = 30;
    const loText = `${midiToNote(r.low)} lowest`;
    const hiText = `highest ${midiToNote(r.high)}`;
    const approx = (t) => t.length * fs * 0.55;
    // lowest label to the left of the bar, highest to the right; flip inside if there is no room
    const loLeft = x1 - 10 - approx(loText) >= 0;
    const hiRight = x2 + 10 + approx(hiText) <= W;
    svg += loLeft
      ? `<text x="${x1 - 10}" y="${yBar + 12}" text-anchor="end" font-size="${fs}" font-weight="800" fill="#17102b">${esc(loText)}</text>`
      : `<text x="${x1}" y="${yFlip}" text-anchor="start" font-size="${fs}" font-weight="800" fill="#17102b">${esc(loText)}</text>`;
    svg += hiRight
      ? `<text x="${x2 + 10}" y="${yBar + 12}" text-anchor="start" font-size="${fs}" font-weight="800" fill="#17102b">${esc(hiText)}</text>`
      : `<text x="${x2}" y="${yFlip}" text-anchor="end" font-size="${fs}" font-weight="800" fill="#17102b">${esc(hiText)}</text>`;
    if (Number.isFinite(r.median)) {
      const mx = x(clamp(r.median)) + keyW / 2;
      svg += `<path d="M${mx - 9} ${yBar - 3} L${mx + 9} ${yBar - 3} L${mx} ${yBar + 9} Z" fill="#17102b"/>`;
    }
    if (r.label) {
      const nx = Math.max(60, Math.min(W - 60, (x1 + x2) / 2));
      svg += `<text x="${nx}" y="${yName}" text-anchor="middle" font-size="${fs}" font-weight="900" fill="${r.colour}" stroke="#17102b" stroke-width="0.5">${esc(r.label)}</text>`;
    }
  });
  svg += "</svg>";

  container.innerHTML = svg;
  if (caption) {
    const cap = document.createElement("p");
    cap.className = "kb-caption";
    const one = ranges.length === 1;
    const r = ranges[0];
    cap.textContent = one
      ? `Lit keys are the notes you sang: ${midiToNote(r.low)} up to ${midiToNote(r.high)}, ${Math.round(r.high - r.low)} semitones. The ▼ marks where your voice sat most comfortably (${midiToNote(r.median)}).`
      : "Each bar is one singer's range; the lit keys are the notes they sang and ▼ marks where each voice sat most comfortably.";
    container.append(cap);
  }
}
