/**
 * Voice Chatbot - Main JS
 * Now uses ADK runner on backend — events arrive as raw ADK Event JSON.
 * Mic → 16kHz s16le mono PCM binary → WebSocket → ADK runner → Gemini VAD
 * Gemini → ADK Event JSON → parse inputTranscription / outputTranscription / audio
 */

const WS_BASE  = `ws://${location.host}`;
const API_BASE = `http://${location.host}`;

// ── State ──────────────────────────────────────────────────────────────────
let ws          = null;
let userId      = null;
let sessionId   = null;
let isConnected = false;

// Audio contexts — kept separate to avoid sample rate conflicts
let playbackCtx  = null;   // 24kHz — for playing agent audio output
let recordCtx    = null;   // 16kHz — for capturing mic input
let micStream    = null;
let recorderNode = null;
let playerNode   = null;
let isRecording  = false;

// Transcript bubble tracking — streaming partial updates
// Input = user speech, Output = agent speech
let currentInputBubble           = null;
let currentInputBubbleId         = null;
let currentOutputBubble          = null;
let currentOutputBubbleId        = null;
let inputTranscriptionFinished   = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
const chatBox   = document.getElementById("chat-box");
const textInput = document.getElementById("text-input");
const sendBtn   = document.getElementById("send-btn");
const micBtn    = document.getElementById("mic-btn");
const statusEl  = document.getElementById("status");

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  setStatus("Connecting…", "gray");
  try {
    const res  = await fetch(`${API_BASE}/session`);
    const data = await res.json();
    userId    = data.user_id;
    sessionId = data.session_id;
    console.log("[INIT] New session:", sessionId);
    connectWS();
  } catch (err) {
    setStatus("❌ Failed to get session from server", "red");
    console.error("[INIT] Session fetch error:", err);
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────
function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const url = `${WS_BASE}/ws/${userId}/${sessionId}?is_audio=true`;
  console.log("[WS] Connecting to:", url);

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    isConnected = true;
    console.log("[WS] Connected ✅");
    setStatus("✅ Connected — type a message or click 🎙️ Mic to speak", "green");
  };

  ws.onmessage = (e) => {
    try {
      const adkEvent = JSON.parse(e.data);
      handleADKEvent(adkEvent);
    } catch (err) {
      console.error("[WS] Parse error:", err, e.data);
    }
  };

  ws.onerror = (err) => {
    console.error("[WS] Error:", err);
    setStatus("❌ WebSocket error — check server logs", "red");
  };

  ws.onclose = (e) => {
    isConnected = false;
    console.log("[WS] Closed:", e.code, e.reason);
    setStatus(`🔌 Disconnected (${e.code}) — refresh to reconnect`, "gray");
    stopRecording();
  };
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  } else {
    console.warn("[WS] Not connected, cannot send:", obj);
    setStatus("⚠️ Not connected — refresh page", "red");
  }
}

function handleADKEvent(adkEvent) {
  console.log("[ADK]", JSON.stringify(adkEvent).slice(0, 120));

  // ── Turn complete ──────────────────────────────────────────────────────
  if (adkEvent.turnComplete === true) {
    // Finalize any still-open streaming bubbles
    finalizeInputTranscription();
    finalizeOutputTranscription();
    inputTranscriptionFinished = false; // reset for next turn
    setStatus("✅ Ready — type or speak", "green");
    return;
  }

  // ── Interrupted ────────────────────────────────────────────────────────
  if (adkEvent.interrupted === true) {
    // Stop audio playback
    if (playerNode) {
      playerNode.port.postMessage({ command: "endOfAudio" });
    }
    finalizeOutputTranscription();
    inputTranscriptionFinished = false;
    appendSystemBubble("⚡ Response interrupted");
    setStatus("✅ Ready — type or speak", "green");
    return;
  }

  // ── Input transcription (user's spoken words → text) ──────────────────
  if (adkEvent.inputTranscription && adkEvent.inputTranscription.text) {
    const text       = adkEvent.inputTranscription.text;
    const isFinished = adkEvent.inputTranscription.finished === true;

    // Ignore late partial transcriptions if we've already marked this turn done
    if (inputTranscriptionFinished) return;

    if (!currentInputBubbleId) {
      // First chunk — create new user bubble
      currentInputBubbleId = randomId();
      currentInputBubble   = appendBubble("user", text, !isFinished);
      currentInputBubble.id = currentInputBubbleId;
      currentInputBubble.classList.add("transcription");
    } else {
      // Subsequent chunks
      const span = currentInputBubble.querySelector(".bubble-text");
      if (isFinished) {
        // Final event sends the full complete text — replace entirely
        span.textContent = text;
        removeTypingIndicator(currentInputBubble);
      } else {
        // Partial — append new words
        span.textContent = span.textContent + text;
      }
    }

    if (isFinished) {
      currentInputBubbleId = null;
      currentInputBubble   = null;
      inputTranscriptionFinished = true;
    }

    scrollToBottom();
    return;
  }

  // ── Output transcription (agent's spoken words → text) ────────────────
  if (adkEvent.outputTranscription && adkEvent.outputTranscription.text) {
    const text       = adkEvent.outputTranscription.text;
    const isFinished = adkEvent.outputTranscription.finished === true;

    // When agent starts responding, close any open input transcription
    if (currentInputBubbleId) {
      finalizeInputTranscription();
      inputTranscriptionFinished = true;
    }

    if (!currentOutputBubbleId) {
      // Create new agent bubble for this transcript
      currentOutputBubbleId = randomId();
      currentOutputBubble   = appendBubble("assistant", text, !isFinished);
      currentOutputBubble.id = currentOutputBubbleId;
      currentOutputBubble.classList.add("transcription");
    } else {
      const span = currentOutputBubble.querySelector(".bubble-text");
      if (isFinished) {
        span.textContent = text;
        removeTypingIndicator(currentOutputBubble);
      } else {
        span.textContent = span.textContent + text;
      }
    }

    if (isFinished) {
      currentOutputBubbleId = null;
      currentOutputBubble   = null;
    }

    scrollToBottom();
    return;
  }

  // ── Content: audio chunks + text parts ────────────────────────────────
  if (adkEvent.content && adkEvent.content.parts) {
    // When agent starts sending content, finalize input transcription
    if (currentInputBubbleId) {
      finalizeInputTranscription();
      inputTranscriptionFinished = true;
    }

    for (const part of adkEvent.content.parts) {
      // Play audio
      if (part.inlineData && part.inlineData.mimeType &&
          part.inlineData.mimeType.startsWith("audio/pcm")) {
        playAudio(part.inlineData.data);
      }

      // Show text response (for text-mode or fallback)
      if (part.text) {
        appendBubble("assistant", part.text, false);
        scrollToBottom();
      }
    }
  }
}

// ── Transcript bubble helpers ──────────────────────────────────────────────
function finalizeInputTranscription() {
  if (currentInputBubble) {
    removeTypingIndicator(currentInputBubble);
    currentInputBubble   = null;
    currentInputBubbleId = null;
  }
}

function finalizeOutputTranscription() {
  if (currentOutputBubble) {
    removeTypingIndicator(currentOutputBubble);
    currentOutputBubble   = null;
    currentOutputBubbleId = null;
  }
}

function removeTypingIndicator(bubbleWrapper) {
  const indicator = bubbleWrapper.querySelector(".typing-indicator");
  if (indicator) indicator.remove();
}

// ── Audio playback (agent → speaker) ──────────────────────────────────────
async function initPlayback() {
  if (playbackCtx) return;
  playbackCtx = new AudioContext({ sampleRate: 24000 });
  await playbackCtx.audioWorklet.addModule("/static/js/pcm-player-processor.js");
  playerNode = new AudioWorkletNode(playbackCtx, "pcm-player-processor");
  playerNode.connect(playbackCtx.destination);
  console.log("[AUDIO] Playback context ready at 24kHz");
}

async function playAudio(b64) {
  if (!playerNode) await initPlayback();
  try {
    // Handle both standard base64 and base64url encoding
    let standard = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (standard.length % 4) standard += "=";
    const raw  = atob(standard);
    const buf  = new ArrayBuffer(raw.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
    // pcm-player-processor expects Int16Array buffer
    playerNode.port.postMessage(buf, [buf]);
  } catch (err) {
    console.error("[AUDIO] Playback error:", err);
  }
}

// ── Audio recording (mic → Gemini via ADK) ────────────────────────────────
async function startRecording() {
  if (isRecording) return;

  try {
    await initPlayback();
    if (playbackCtx.state === "suspended") {
      await playbackCtx.resume();
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    console.log("[MIC] Got mic stream");

    // Separate 16kHz context for recording — Gemini needs 16kHz PCM mono
    recordCtx = new AudioContext({ sampleRate: 16000 });
    await recordCtx.audioWorklet.addModule("/static/js/pcm-recorder-processor.js");
    console.log("[MIC] Record context ready at 16kHz");

    const micSource = recordCtx.createMediaStreamSource(micStream);
    recorderNode    = new AudioWorkletNode(recordCtx, "pcm-recorder-processor");

    recorderNode.port.onmessage = (e) => {
      // FIX 1: Gate on isRecording — worklet keeps firing briefly after disconnect
      if (!isRecording) return;

      // FIX 2: pcm-recorder-processor.js posts Float32Array (raw floats [-1,1])
      // but Gemini/ADK expects Int16 PCM. Must convert or VAD sees garbage
      // and never detects speech — causing mic to appear broken.
      const float32 = (e.data instanceof Float32Array) ? e.data : new Float32Array(e.data);
      const int16   = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s  = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(int16.buffer);
      }
    };

    micSource.connect(recorderNode);

    isRecording = true;
    micBtn.textContent = "⏹ Stop";
    micBtn.classList.add("recording");
    setStatus("🎤 Speaking… ADK VAD will detect when you stop", "red");
    console.log("[MIC] Recording started — ADK VAD handles turn detection");

  } catch (err) {
    console.error("[MIC] Error:", err);
    appendSystemBubble(`❌ Mic error: ${err.message}`);
    setStatus("❌ Mic error — check browser permissions", "red");
  }
}

function stopRecording() {
  if (!isRecording) return;
  console.log("[MIC] Stopping recording");

  if (recorderNode) {
    try { recorderNode.disconnect(); } catch (_) {}
    recorderNode = null;
  }
  if (recordCtx) {
    try { recordCtx.close(); } catch (_) {}
    recordCtx = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }

  isRecording = false;
  micBtn.textContent = "🎙️ Mic";
  micBtn.classList.remove("recording");
  setStatus("⏳ Processing… ADK VAD responding", "green");

  // With ADK runner + VAD, we don't need to send end_of_turn.
  // Optionally notify server for logging only — server ignores it.
  sendWS({ type: "end_of_turn" });
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function appendBubble(role, text, isPartial) {
  const wrapper = document.createElement("div");
  wrapper.className = `msg ${role}`;

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = role === "user" ? "You" : role === "assistant" ? "Agent" : "System";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const textSpan = document.createElement("span");
  textSpan.className = "bubble-text";
  textSpan.textContent = text;

  // Typing indicator for partial streaming bubbles
  if (isPartial && role === "assistant") {
    const indicator = document.createElement("span");
    indicator.className = "typing-indicator";
    textSpan.appendChild(indicator);
  }

  bubble.appendChild(textSpan);
  wrapper.appendChild(label);
  wrapper.appendChild(bubble);
  chatBox.appendChild(wrapper);
  scrollToBottom();
  return wrapper;
}

function appendSystemBubble(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  div.appendChild(bubble);
  chatBox.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  chatBox.scrollTop = chatBox.scrollHeight;
}

function setStatus(msg, color) {
  statusEl.textContent = msg;
  statusEl.style.color =
    color === "green" ? "#22c55e" :
    color === "red"   ? "#ef4444" : "#9ca3af";
}

function randomId() {
  return Math.random().toString(36).substring(7);
}

// ── Event listeners ────────────────────────────────────────────────────────
sendBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (!text || !isConnected) return;
  appendBubble("user", text, false);
  sendWS({ type: "text", text });
  textInput.value = "";
  setStatus("⏳ Agent is thinking…", "green");
});

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

micBtn.addEventListener("click", async () => {
  if (isRecording) stopRecording();
  else await startRecording();
});

// ── Boot ───────────────────────────────────────────────────────────────────
init();