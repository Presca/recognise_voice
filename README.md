# ReVoice

Sing one line and find out what your singing voice can do.

ReVoice listens to a short sung phrase, analyses it in the browser, and tells you:

- **Your vocal fingerprint** — range, tessitura and voice type; timbre, weight, texture, vibrato, phrasing, ornamentation and technique, each with a confidence score; a four-part descriptor (Voice · Technique · Delivery · Style) and the full measurements as JSON.
- **Singers with a similar voice** — a Shazam-style carousel of matches with separate scores for acoustic voice, technique and delivery, plus the closest singer on each dimension.
- **Genres best suited to your voice.**
- **Songs to try** — a numbered chart with one-tap links to open on **Spotify**, watch on **YouTube**, or sing along to a **karaoke** version on YouTube. Unmatch any song (✕) and a better suggestion moves up; unmatched songs are remembered between visits.
- **A karaoke to start with** — the top pick is featured so you can get singing straight away.
- **Replay** — listen back to the exact take that was analysed (kept in memory only, never uploaded).
- **Sing with friends** (`friends.html`) — record one singer after another, then get a plain description of each voice, how they fit together (spacing, shared notes, tone blend), duets with who-sings-which-part, and sing-alongs everyone can manage in their own octave.

The UI is modelled on Shazam's one-big-button flow, in electric violet.

## Running locally

Everything is plain HTML/CSS/JS — no build step, no dependencies. Microphone access needs a
secure context, so serve the folder over `localhost` (or HTTPS) rather than opening the file directly:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Chrome or Edge is recommended. Nothing is uploaded — all audio analysis runs in your browser.

## How it works

| File | Role |
| --- | --- |
| `index.html` | The three screens: intro, recording, results |
| `style.css` | Shazam-style visual design |
| `data.js` | Curated dataset of 60+ singers, classic and current (voice type, comfortable range, perceptual ratings, technique/delivery tags, genres, five songs each) and link builders for Spotify / YouTube / karaoke |
| `engine.js` | Web Audio + MediaRecorder capture, frame measurements, segmentation, vocal fingerprint, four-dimension singer matching, genre and song ranking |
| `app.js` | UI flow, rendering, unmatch/refresh logic |
| `friends.html` / `friends.js` | Sing-with-friends page: multi-singer roster, group fit description, duet and sing-along ranking (`DUETS`, `GROUP_SONGS` in `data.js`) |

### Analysis

The engine follows a measure-first, describe-second pipeline:

1. **Frame measurements** every 25 ms: fundamental frequency by autocorrelation (with a periodicity
   score used as a harmonic-to-noise proxy), RMS level, spectral centroid, roll-off, band energy
   shares, spectral tilt and H1–H2.
2. **Segmentation** into phrases (silences ≥ 250 ms) and notes (pitch steps ≥ 0.7 semitone that
   persist for two frames).
3. **Distributions**, not just averages: median, percentiles and spread for pitch, level and spectrum.
   Range is reported three ways — demonstrated (min–max), typical usable (5th–95th percentile) and
   comfortable tessitura (25th–75th).
4. **Derived scores (0–100)** for brightness, warmth, vocal weight, breathiness, roughness, plus
   vibrato rate / extent / regularity, attack and release, scoops, slides, runs, phrasing and dynamics.
   Every value carries a confidence (0–1) driven by recording quality (SNR, clipping, seconds of
   usable singing) and the reliability of the feature itself.
5. **Four separate dimensions** — *Voice* (what it physically sounds like), *Technique* (how you use
   it), *Delivery* (how the performance feels) and *Style* (where it sits musically) — shown as a
   one-line descriptor such as `dark/breathy/light · soft onset, straight tone · behind-beat, understated · alt-pop`.

Things a single a cappella line on a phone microphone cannot support — formants, perceived resonance
placement, register use (chest / mix / head / falsetto), rhythmic placement, articulation and vocal
power — are reported as `null` with a reason rather than guessed. The full machine-readable
fingerprint (JSON) is available on the results page.

### Matching

Singers are compared along the same four dimensions, and each is reported separately:

- **Acoustic voice** — pitch range and tessitura, brightness, weight, breathiness, warmth, vibrato.
- **Technique** — shared technique tags (vibrato, belt, breathy, rasp, runs, scoops, slides, onsets…)
  plus vibrato and roughness similarity.
- **Performance style** — shared delivery tags (legato, sustained, dynamic, understated, intimate…).
- **Overall** — 55% voice, 25% technique, 20% delivery; this drives the carousel order.

Genres are weighted from the top overall matches and never feed the acoustic similarity. Songs are
drawn from matched singers and interleaved so the list stays varied; unmatching a song hides it and
slightly lowers that singer so different voices surface next.

The singer ratings in `data.js` are curated perceptual estimates (0–100) and tags, not measurements —
they are only ever compared with the user's *derived* perceptual scores. Ranges are approximate,
commonly cited *comfortable* ranges rather than record-breaking extremes.
