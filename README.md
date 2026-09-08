# Recognise Voice

Sing one line and find out what your singing voice can do.

Recognise Voice listens to a short sung phrase, analyses it in the browser, and tells you:

- **Your voice** — range sung, comfort zone, estimated voice type (bass → soprano), tone (dark / warm / bright), pitch steadiness and dynamics.
- **Singers with a similar voice** — matched from a curated dataset, each with their voice type, range, genres, a short profile and a match score.
- **Genres best suited to your voice.**
- **Songs to try** — with one-tap links to open on **Spotify**, watch on **YouTube**, or sing along to a **karaoke** version on YouTube. Unmatch any song (✕) and a better suggestion takes its place; unmatched songs are remembered between visits.
- **A karaoke to start with** — the top pick is featured so you can get singing straight away.

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
| `data.js` | Curated singer dataset (voice type, comfortable range, tone, genres, songs) and link builders for Spotify / YouTube / karaoke |
| `engine.js` | Web Audio recording, autocorrelation pitch detection, voice profiling, singer matching, genre and song ranking |
| `app.js` | UI flow, rendering, unmatch/refresh logic |

### Analysis

While you sing, the app samples the microphone every 50 ms, detects the fundamental pitch by
autocorrelation and measures loudness and spectral centroid. Afterwards it takes the 5th–95th
percentile of detected pitches as your sung range, the median as your comfort zone, and classifies
voice type from that comfort zone. Tone comes from the average spectral centroid (brightness),
steadiness from frame-to-frame pitch movement, and dynamics from loudness variation.

### Matching

Each singer is scored on how close your comfort zone is to the centre of their range (45%), how
much of your sung range overlaps theirs (35%) and how similar the tone is (20%). Genres are weighted
by the top matches; songs are drawn from matched singers, interleaved so the list stays varied.
Unmatching a song hides it and slightly lowers that singer so different voices surface next.

Singer ranges are approximate, commonly cited *comfortable* ranges rather than record-breaking
extremes — that suits matching against a single sung line. Voice type is an estimate from a short
sample, not a formal classification.
