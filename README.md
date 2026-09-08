# Recognise Voice

A browser-based voice recognition web app. It uses the [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API)
to capture speech from your microphone and display a live transcript — no build
step, no dependencies.

## Running locally

The Web Speech API requires a secure context, so serve the files over
`http://localhost` (opening `index.html` directly with `file://` will not get
microphone access in all browsers):

```bash
# any static server works, e.g.:
python3 -m http.server 8000
# then open http://localhost:8000
```

## Usage

1. Open the page in Chrome or Edge (desktop) or Chrome (Android).
2. Pick a recognition language.
3. Click **Start listening** and allow microphone access.
4. Speak — interim results appear in grey, finalised text is added to the transcript.
5. Click **Stop listening** when done, or **Clear** to reset the transcript.

## Browser support

Speech recognition is powered by the browser's own engine
(`SpeechRecognition` / `webkitSpeechRecognition`). It is supported in
Chromium-based browsers; Firefox and some others do not support it yet, and the
page will tell you if that's the case.

## Project structure

```
index.html   # page markup
style.css    # styling
app.js       # speech recognition logic
```
