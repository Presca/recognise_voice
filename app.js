"use strict";

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const toggleBtn = document.getElementById("toggle-btn");
const toggleLabel = document.getElementById("toggle-label");
const languageSelect = document.getElementById("language-select");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const interimEl = document.getElementById("interim");
const clearBtn = document.getElementById("clear-btn");
const unsupportedEl = document.getElementById("unsupported");

let recognition = null;
let listening = false;

if (!SpeechRecognition) {
  unsupportedEl.hidden = false;
  toggleBtn.disabled = true;
  statusEl.textContent = "Speech recognition unavailable";
} else {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    listening = true;
    toggleBtn.classList.add("recording");
    toggleLabel.textContent = "Stop listening";
    statusEl.textContent = "Listening…";
  };

  recognition.onend = () => {
    listening = false;
    toggleBtn.classList.remove("recording");
    toggleLabel.textContent = "Start listening";
    statusEl.textContent = "Idle";
    interimEl.textContent = "";
  };

  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "Microphone access was denied. Allow it and try again.",
      "no-speech": "No speech detected.",
      network: "Network error — speech service unreachable.",
      "audio-capture": "No microphone found.",
    };
    statusEl.textContent = messages[event.error] || `Error: ${event.error}`;
  };

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        appendFinal(result[0].transcript.trim());
      } else {
        interim += result[0].transcript;
      }
    }
    interimEl.textContent = interim;
  };
}

function appendFinal(text) {
  if (!text) return;
  transcriptEl.textContent += (transcriptEl.textContent ? " " : "") + text;
}

toggleBtn.addEventListener("click", () => {
  if (!recognition) return;
  if (listening) {
    recognition.stop();
  } else {
    recognition.lang = languageSelect.value;
    recognition.start();
  }
});

languageSelect.addEventListener("change", () => {
  // A language change only applies on the next start.
  if (listening) recognition.stop();
});

clearBtn.addEventListener("click", () => {
  transcriptEl.textContent = "";
  interimEl.textContent = "";
});
