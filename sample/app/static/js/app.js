/**
 * Voice Form Agent — Main JS
 * - Answers tracked CLIENT-SIDE — never rely on agent to produce final JSON
 * - Agent only asks questions; JS records every user reply in order
 * - fileUpload questions: inline widget → /documents/upload → blob URL stored
 * - Final JSON auto-triggered when all questions answered
 */

const WS_BASE  = `ws://${location.host}`;
const API_BASE = `http://${location.host}`;

// ── State ──────────────────────────────────────────────────────────────────
let ws          = null;
let userId      = null;
let sessionId   = null;
let isConnected = false;

// Audio
let playbackCtx  = null;
let recordCtx    = null;
let micStream    = null;
let recorderNode = null;
let playerNode   = null;
let isRecording  = false;

// Transcript streaming
let currentInputBubble         = null;
let currentInputBubbleId       = null;
let currentOutputBubble        = null;
let currentOutputBubbleId      = null;
let inputTranscriptionFinished = false;

// Form / interview state
let formSchema       = [];
let flatQuestions    = [];   // ALL questions including fileUpload
let answers          = [];   // ordered array of {question, answer} — built client-side
let currentQIdx      = 0;    // which question we are currently on (0-based)
let interviewStarted = false;
let waitingForUpload = false;
let completionShown  = false;

// ── DOM refs ────────────────────────────────────────────────────────────────
const chatBox   = document.getElementById("chat-box");
const textInput = document.getElementById("text-input");
const sendBtn   = document.getElementById("send-btn");
const micBtn    = document.getElementById("mic-btn");
const statusEl  = document.getElementById("ws-status");

// ── Upload screen ────────────────────────────────────────────────────────────
const jsonFileInput = document.getElementById("jsonFile");
const processBtn    = document.getElementById("processBtn");
const fileNameEl    = document.getElementById("file-name");
const dropZone      = document.getElementById("drop-zone");

jsonFileInput.addEventListener("change", () => {
  const f = jsonFileInput.files[0];
  if (f) { fileNameEl.textContent = `✓ ${f.name}`; processBtn.disabled = false; }
});

dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith(".json")) {
    const dt = new DataTransfer();
    dt.items.add(file);
    jsonFileInput.files = dt.files;
    fileNameEl.textContent = `✓ ${file.name}`;
    processBtn.disabled = false;
  }
});

processBtn.addEventListener("click", () => {
  const file = jsonFileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      formSchema = JSON.parse(e.target.result);
    } catch (err) {
      alert("Invalid JSON file: " + err.message);
      return;
    }

    flatQuestions = formSchema.reduce((acc, section) => {
      const qs = section.questions.map(q => ({ ...q, sId: section.sId, sName: section.sName }));
      return [...acc, ...qs];
    }, []);

    showMainScreen();
    initSession();
  };
  reader.onerror = () => alert("Failed to read file.");
  reader.readAsText(file);
});

// ── Show main screen ─────────────────────────────────────────────────────────
function showMainScreen() {
  document.getElementById("upload-screen").style.display = "none";
  document.getElementById("main-screen").style.display = "flex";
  renderForm();
}

// ── Reset ────────────────────────────────────────────────────────────────────
document.getElementById("reset-btn").addEventListener("click", () => {
  if (!confirm("Start over with a new form?")) return;
  stopRecording();
  if (ws) ws.close();
  formSchema = []; flatQuestions = []; answers = [];
  currentQIdx = 0; interviewStarted = false; waitingForUpload = false; completionShown = false;
  chatBox.innerHTML = "";
  document.getElementById("main-screen").style.display = "none";
  document.getElementById("upload-screen").style.display = "flex";
  processBtn.disabled = true;
  processBtn.textContent = "Upload & Generate Form";
  fileNameEl.textContent = "";
  jsonFileInput.value = "";
});

// ── Form rendering (read-only reference) ─────────────────────────────────────
function renderForm() {
  const scroll = document.getElementById("form-scroll");
  const nav    = document.getElementById("sections-nav");
  scroll.innerHTML = "";
  nav.innerHTML = "";

  formSchema.forEach((section, idx) => {
    const pill = document.createElement("button");
    pill.className = "section-pill" + (idx === 0 ? " active" : "");
    pill.textContent = section.sName;
    pill.dataset.sid = section.sId;
    pill.onclick = () => {
      document.querySelectorAll(".section-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      document.querySelector(`.form-section[data-sid="${section.sId}"]`)
        ?.scrollIntoView({ behavior: "smooth" });
    };
    nav.appendChild(pill);

    const card = document.createElement("div");
    card.className = "form-section";
    card.dataset.sid = section.sId;
    card.innerHTML = `
      <div class="form-section-header">
        <span class="section-dot"></span>
        <span class="section-title-text">${section.sName}</span>
      </div>
    `;
    const body = document.createElement("div");
    body.className = "form-section-body";
    section.questions.forEach(q => {
      const wrap = document.createElement("div");
      wrap.className = "form-field";
      let extra = "";
      if (q.type === "fileUpload") {
        extra = `<div class="skipped-badge"><span>📎</span> PDF upload required</div>`;
      } else if (q.options?.length) {
        extra = `<div class="options-list">${q.options.map(o => `<span class="option-chip">${o}</span>`).join("")}</div>`;
      }
      wrap.innerHTML = `
        <div class="form-field-label">
          ${q.label}
          ${q.required ? '<span class="required-star">*</span>' : ""}
          <span class="field-type-badge">${q.type}</span>
        </div>
        ${extra}
      `;
      body.appendChild(wrap);
    });
    card.appendChild(body);
    scroll.appendChild(card);
  });
}

// ── Session + WebSocket ──────────────────────────────────────────────────────
async function initSession() {
  setStatus("Connecting…", "gray");
  try {
    const res  = await fetch(`${API_BASE}/session`);
    const data = await res.json();
    userId    = data.user_id;
    sessionId = data.session_id;
    connectWS();
  } catch (err) {
    setStatus("❌ Session error", "red");
  }
}

function connectWS() {
  const url = `${WS_BASE}/ws/${userId}/${sessionId}?is_audio=true`;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    isConnected = true;
    setStatus("✅ Connected", "green");
    startInterview();
  };

  ws.onmessage = (e) => {
    try { handleADKEvent(JSON.parse(e.data)); }
    catch (err) { console.error("[WS] Parse error:", err); }
  };

  ws.onerror = () => setStatus("❌ WebSocket error", "red");
  ws.onclose = (e) => {
    isConnected = false;
    setStatus(`🔌 Disconnected (${e.code})`, "gray");
    stopRecording();
  };
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Interview flow ────────────────────────────────────────────────────────────
function startInterview() {
  if (interviewStarted || flatQuestions.length === 0) return;
  interviewStarted = true;
  currentQIdx = 0;

  const questionList = flatQuestions.map((q, i) => {
    const tag  = q.type === "fileUpload" ? " [FILE UPLOAD — PDF]" : "";
    const opts = q.options?.length ? ` (options: ${q.options.join(", ")})` : "";
    return `${i + 1}. ${q.label}${opts}${tag}`;
  }).join("\n");

  // Agent only needs to ASK questions — we handle all answer tracking & final JSON
  const prompt = `You are conducting a structured form interview. You have ${flatQuestions.length} questions to ask.

Rules:
- Ask ONE question at a time in order.
- After the user answers, say one brief acknowledgement sentence, then immediately ask the next question.
- For questions marked [FILE UPLOAD — PDF]: ask the user to upload their PDF using the upload widget below. Then STOP — do NOT ask the next question. The system will notify you when the upload is done.
- Do NOT produce a JSON summary at any point — the system handles data collection automatically.

Questions:
${questionList}

Start: one short greeting sentence, then ask question 1.`;

  sendWS({ type: "text", text: prompt });
  setStatus("⏳ Agent starting…", "green");
}

// ── Record a user answer client-side ─────────────────────────────────────────
function recordAnswer(answerText, isFileUpload = false) {
  if (currentQIdx >= flatQuestions.length) return;
  const q = flatQuestions[currentQIdx];

  // Avoid double-recording (e.g. voice transcript + typed)
  if (answers[currentQIdx] !== undefined) return;

  // ground_truth = raw user speech/text; answer = will be cleaned by OutputRefinerAgent
  // For fileUpload: both are the URL (no cleaning needed)
  answers[currentQIdx] = {
    question:     q.label,
    answer:       answerText,   // will be replaced with cleaned value after refining
    ground_truth: answerText    // always kept as-is
  };
  currentQIdx++;

  console.log(`[ANSWER] Q${currentQIdx}: "${q.label}" → "${answerText}"`);
  console.log(`[PROGRESS] ${Object.keys(answers).length} / ${flatQuestions.length}`);

  checkCompletion();
}

// ── Check if all questions answered → show final JSON ────────────────────────
async function checkCompletion() {
  if (completionShown) return;
  if (Object.keys(answers).length < flatQuestions.length) return;

  completionShown = true;

  const rawData = flatQuestions.map((q, i) => ({
    question:     q.label,
    answer:       answers[i]?.answer       ?? "",
    ground_truth: answers[i]?.ground_truth ?? ""
  }));

  // Small delay so last agent acknowledgement renders first
  setTimeout(async () => {
    setStatus("✨ Refining answers…", "gray");
    try {
      const res = await fetch("/refine-answers", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ answers: rawData })
      });
      if (!res.ok) throw new Error(`Refiner error ${res.status}`);
      const { refined } = await res.json();
      showCompletion(refined);
    } catch (err) {
      console.error("[REFINER] Failed, showing raw answers:", err);
      showCompletion(rawData);  // fallback to raw if refiner fails
    }
    setStatus("✅ Done", "green");
  }, 800);
}

// ── File upload widget (inline in chat) ──────────────────────────────────────
function injectFileUploadWidget(qIndex) {
  const q = flatQuestions[qIndex];
  if (!q || q.type !== "fileUpload") return;

  // Don't inject twice for same question
  if (document.getElementById(`widget-${q.controlName}`)) return;

  waitingForUpload = true;
  textInput.disabled   = true;
  sendBtn.disabled     = true;
  micBtn.disabled      = true;
  textInput.placeholder = "Please upload the PDF file using the widget above…";

  const widget = document.createElement("div");
  widget.className = "file-upload-widget";
  widget.id = `widget-${q.controlName}`;
  widget.innerHTML = `
    <label>📎 Upload PDF — ${q.label}</label>
    <input type="file" accept="application/pdf" id="file-input-${q.controlName}" />
    <button class="btn-upload-send" id="upload-btn-${q.controlName}" disabled>Upload File</button>
    <div class="upload-status" id="upload-status-${q.controlName}">Select a PDF to upload…</div>
  `;

  const msgDiv = document.createElement("div");
  msgDiv.className = "msg system";
  msgDiv.appendChild(widget);
  chatBox.appendChild(msgDiv);
  scrollToBottom();

  const fileInput = widget.querySelector(`#file-input-${q.controlName}`);
  const uploadBtn = widget.querySelector(`#upload-btn-${q.controlName}`);
  const statusDiv = widget.querySelector(`#upload-status-${q.controlName}`);

  fileInput.addEventListener("change", () => {
    uploadBtn.disabled = !fileInput.files[0];
    if (fileInput.files[0]) statusDiv.textContent = `✓ ${fileInput.files[0].name} selected`;
  });

  uploadBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    uploadBtn.disabled = true;
    statusDiv.textContent = "Uploading…";

    try {
      const fd = new FormData();
      fd.append("files", file);

      const res = await fetch("/documents/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);

      const data     = await res.json();
      const blobUrl  = data.documents?.[0]?.document_url;
      if (!blobUrl) throw new Error("No URL returned");

      // Record answer client-side immediately — fileUpload: URL is both answer & ground_truth
      recordAnswer(blobUrl, true);

      statusDiv.textContent = "✅ Uploaded successfully";
      statusDiv.className   = "upload-status success";
      widget.classList.add("done");
      fileInput.disabled    = true;

      // Re-enable chat
      waitingForUpload      = false;
      textInput.disabled    = false;
      sendBtn.disabled      = false;
      micBtn.disabled       = false;
      textInput.placeholder = "Type answer or press 🎙️ to speak…";

      // Tell agent to continue
      appendBubble("user", `📎 File uploaded: ${file.name}`, false);
      sendWS({ type: "text", text: `File uploaded successfully (URL: ${blobUrl}). Please ask the next question.` });
      setStatus("⏳ Agent continuing…", "green");

    } catch (err) {
      statusDiv.textContent = `❌ ${err.message}`;
      statusDiv.className   = "upload-status error";
      uploadBtn.disabled    = false;
    }
  });
}

// ── Detect when agent asks for a file upload ──────────────────────────────────
let uploadWidgetInjected = {};  // track which q indices have been injected

function checkForFileUploadTrigger(text) {
  if (waitingForUpload) return;

  // currentQIdx points to the next unanswered question
  const q = flatQuestions[currentQIdx];
  if (!q || q.type !== "fileUpload") return;
  if (uploadWidgetInjected[currentQIdx]) return;

  const keywords = ["upload", "pdf", "file", "document", "attach", "button below"];
  const textLower = text.toLowerCase();
  if (keywords.some(k => textLower.includes(k))) {
    uploadWidgetInjected[currentQIdx] = true;
    injectFileUploadWidget(currentQIdx);
  }
}

// ── Completion overlay ────────────────────────────────────────────────────────
function showCompletion(data) {
  const pretty = JSON.stringify(data, null, 2);
  document.getElementById("json-output").textContent = pretty;
  document.getElementById("completion-overlay").classList.add("visible");
}

document.getElementById("copy-btn").addEventListener("click", () => {
  const text = document.getElementById("json-output").textContent;
  navigator.clipboard.writeText(text).then(() => {
    document.getElementById("copy-btn").textContent = "✓ Copied!";
    setTimeout(() => document.getElementById("copy-btn").textContent = "📋 Copy JSON", 2000);
  });
});

document.getElementById("download-btn").addEventListener("click", () => {
  const text = document.getElementById("json-output").textContent;
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "form-answers.json";
  a.click();
});

document.getElementById("close-btn").addEventListener("click", () => {
  document.getElementById("completion-overlay").classList.remove("visible");
});

// ── ADK Event handler ─────────────────────────────────────────────────────────
function handleADKEvent(adkEvent) {
  if (adkEvent.turnComplete === true) {
    finalizeInputTranscription();
    finalizeOutputTranscription();
    inputTranscriptionFinished = false;
    if (!waitingForUpload) setStatus("✅ Ready — type or speak", "green");
    return;
  }

  if (adkEvent.interrupted === true) {
    if (playerNode) playerNode.port.postMessage({ command: "endOfAudio" });
    finalizeOutputTranscription();
    inputTranscriptionFinished = false;
    appendSystemMsg("⚡ Response interrupted");
    if (!waitingForUpload) setStatus("✅ Ready — type or speak", "green");
    return;
  }

  // User speech transcript
  if (adkEvent.inputTranscription?.text) {
    const text       = adkEvent.inputTranscription.text;
    const isFinished = adkEvent.inputTranscription.finished === true;
    if (inputTranscriptionFinished) return;

    if (!currentInputBubbleId) {
      currentInputBubbleId = randomId();
      currentInputBubble   = appendBubble("user", text, !isFinished);
      currentInputBubble.id = currentInputBubbleId;
    } else {
      const span = currentInputBubble.querySelector(".bubble-text");
      if (isFinished) {
        span.textContent = text;
        removeTypingIndicator(currentInputBubble);
      } else {
        span.textContent += text;
      }
    }

    if (isFinished) {
      // Record voice answer client-side
      if (!waitingForUpload) recordAnswer(text);
      currentInputBubbleId = null;
      currentInputBubble   = null;
      inputTranscriptionFinished = true;
    }
    scrollToBottom();
    return;
  }

  // Agent speech transcript
  if (adkEvent.outputTranscription?.text) {
    const text       = adkEvent.outputTranscription.text;
    const isFinished = adkEvent.outputTranscription.finished === true;

    if (currentInputBubbleId) { finalizeInputTranscription(); inputTranscriptionFinished = true; }

    if (!currentOutputBubbleId) {
      currentOutputBubbleId = randomId();
      currentOutputBubble   = appendBubble("assistant", text, !isFinished);
      currentOutputBubble.id   = currentOutputBubbleId;
      currentOutputBubble._raw = text;
    } else {
      // finished=true → ADK resends the complete text, so replace (not append) to avoid doubling
      currentOutputBubble._raw = isFinished ? text : (currentOutputBubble._raw || "") + text;
      const span = currentOutputBubble.querySelector(".bubble-text");
      span.textContent = currentOutputBubble._raw;
      if (isFinished) {
        removeTypingIndicator(currentOutputBubble);
        checkForFileUploadTrigger(currentOutputBubble._raw);
      }
    }

    if (isFinished) { currentOutputBubbleId = null; currentOutputBubble = null; }
    scrollToBottom();
    return;
  }

  // Content parts: audio + text
  if (adkEvent.content?.parts) {
    if (currentInputBubbleId) { finalizeInputTranscription(); inputTranscriptionFinished = true; }

    for (const part of adkEvent.content.parts) {
      if (part.inlineData?.mimeType?.startsWith("audio/pcm")) playAudio(part.inlineData.data);
      if (part.text) {
        appendBubble("assistant", part.text, false);
        checkForFileUploadTrigger(part.text);
        scrollToBottom();
      }
    }
  }
}

// ── Audio playback ────────────────────────────────────────────────────────────
async function initPlayback() {
  if (playbackCtx) return;
  playbackCtx = new AudioContext({ sampleRate: 24000 });
  await playbackCtx.audioWorklet.addModule("/static/js/pcm-player-processor.js");
  playerNode = new AudioWorkletNode(playbackCtx, "pcm-player-processor");
  playerNode.connect(playbackCtx.destination);
}

async function playAudio(b64) {
  if (!playerNode) await initPlayback();
  try {
    let s = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const raw = atob(s);
    const buf = new ArrayBuffer(raw.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
    playerNode.port.postMessage(buf, [buf]);
  } catch (err) { console.error("[AUDIO]", err); }
}

// ── Mic recording ─────────────────────────────────────────────────────────────
async function startRecording() {
  if (isRecording || waitingForUpload) return;
  try {
    await initPlayback();
    if (playbackCtx.state === "suspended") await playbackCtx.resume();

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    recordCtx = new AudioContext({ sampleRate: 16000 });
    await recordCtx.audioWorklet.addModule("/static/js/pcm-recorder-processor.js");

    const micSource = recordCtx.createMediaStreamSource(micStream);
    recorderNode    = new AudioWorkletNode(recordCtx, "pcm-recorder-processor");

    recorderNode.port.onmessage = (e) => {
      if (!isRecording) return;
      const float32 = (e.data instanceof Float32Array) ? e.data : new Float32Array(e.data);
      const int16   = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s  = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(int16.buffer);
    };

    micSource.connect(recorderNode);
    isRecording = true;
    micBtn.textContent = "⏹ Stop";
    micBtn.classList.add("recording");
    setStatus("🎤 Speaking…", "red");
  } catch (err) {
    appendSystemMsg(`❌ Mic error: ${err.message}`);
    setStatus("❌ Mic error", "red");
  }
}

function stopRecording() {
  if (!isRecording) return;
  if (recorderNode) { try { recorderNode.disconnect(); } catch(_) {} recorderNode = null; }
  if (recordCtx)    { try { recordCtx.close(); } catch(_) {} recordCtx = null; }
  if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  isRecording = false;
  micBtn.textContent = "🎙️ Mic";
  micBtn.classList.remove("recording");
  setStatus("⏳ Processing…", "green");
  sendWS({ type: "end_of_turn" });
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function appendBubble(role, text, isPartial) {
  const wrapper = document.createElement("div");
  wrapper.className = `msg ${role}`;

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = role === "user" ? "You" : "Agent";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const textSpan = document.createElement("span");
  textSpan.className = "bubble-text";
  textSpan.textContent = text;

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

function appendSystemMsg(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  div.appendChild(b);
  chatBox.appendChild(div);
  scrollToBottom();
}

function finalizeInputTranscription() {
  if (currentInputBubble) {
    removeTypingIndicator(currentInputBubble);
    currentInputBubble = null; currentInputBubbleId = null;
  }
}

function finalizeOutputTranscription() {
  if (currentOutputBubble) {
    removeTypingIndicator(currentOutputBubble);
    currentOutputBubble = null; currentOutputBubbleId = null;
  }
}

function removeTypingIndicator(wrapper) { wrapper?.querySelector(".typing-indicator")?.remove(); }
function scrollToBottom() { chatBox.scrollTop = chatBox.scrollHeight; }
function randomId() { return Math.random().toString(36).substring(7); }

function setStatus(msg, color) {
  statusEl.textContent = msg;
  statusEl.style.color = color === "green" ? "#22c55e" : color === "red" ? "#ef4444" : "#9ca3af";
}

// ── Controls ──────────────────────────────────────────────────────────────────
sendBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (!text || !isConnected || waitingForUpload) return;
  // Record answer client-side before sending
  recordAnswer(text);
  appendBubble("user", text, false);
  sendWS({ type: "text", text });
  textInput.value = "";
  setStatus("⏳ Agent is thinking…", "green");
});

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
});

micBtn.addEventListener("click", async () => {
  if (isRecording) stopRecording();
  else await startRecording();
});