// Bare-loop test client: mic capture -> downsample to 24kHz PCM16 -> our
// backend -> AssemblyAI, and AssemblyAI's reply audio -> our backend -> here,
// scheduled for gapless playback. No scorecard / tool logic yet.

const TARGET_SAMPLE_RATE = 24000;

const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle");
const transcriptEl = document.getElementById("transcript");
const scorecardEl = document.getElementById("scorecard");

let ws = null;
let micStream = null;
let micContext = null;
let micSource = null;
let micProcessor = null;
let running = false;

// --- Playback scheduling ----------------------------------------------------
let playbackContext = null;
let nextPlayTime = 0;
let scheduledSources = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function appendTranscript(speaker, text) {
  const div = document.createElement("div");
  div.className = `line ${speaker}`;
  div.innerHTML = `<b>${speaker === "you" ? "You:" : "Prospect:"}</b> ${escapeHtml(text)}`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function appendObjectionTag(objection) {
  const div = document.createElement("div");
  div.className = "line tag";
  const type = escapeHtml(objection.objection_type || "unknown");
  const line = objection.your_line ? `: "${escapeHtml(objection.your_line)}"` : "";
  div.innerHTML = `<b>Tagged:</b> ${type}${line}`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

const VERDICT_LABEL = {
  handled_well: "Handled well",
  partially_handled: "Partially handled",
  fumbled: "Fumbled",
};

function renderScorecard(scorecard) {
  scorecardEl.innerHTML = "";
  scorecardEl.hidden = false;

  const summary = document.createElement("p");
  summary.className = "sc-summary";
  summary.textContent = scorecard.overall_summary || "";
  scorecardEl.appendChild(summary);

  for (const obj of scorecard.objections || []) {
    const row = document.createElement("div");
    row.className = `sc-objection sc-${obj.verdict}`;
    row.innerHTML = `
      <div class="sc-objection-head">
        <span class="sc-type">${escapeHtml(obj.objection_type)}</span>
        <span class="sc-verdict">${escapeHtml(VERDICT_LABEL[obj.verdict] || obj.verdict)}</span>
      </div>
      <div class="sc-prospect-line">"${escapeHtml(obj.prospect_line)}"</div>
      <div class="sc-feedback">${escapeHtml(obj.feedback)}</div>
    `;
    scorecardEl.appendChild(row);
  }

  if ((scorecard.strengths || []).length) {
    scorecardEl.appendChild(buildList("Strengths", scorecard.strengths));
  }
  if ((scorecard.areas_to_improve || []).length) {
    scorecardEl.appendChild(buildList("Areas to improve", scorecard.areas_to_improve));
  }

  scorecardEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildList(title, items) {
  const wrap = document.createElement("div");
  wrap.className = "sc-list";
  const h = document.createElement("b");
  h.textContent = title;
  wrap.appendChild(h);
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Linear-interpolation resample, mono Float32 -> mono Float32 at targetRate.
function downsample(float32Array, inputRate, outputRate) {
  if (inputRate === outputRate) return float32Array;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(float32Array.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const idx0 = Math.floor(srcIndex);
    const idx1 = Math.min(idx0 + 1, float32Array.length - 1);
    const frac = srcIndex - idx0;
    result[i] = float32Array[idx0] + (float32Array[idx1] - float32Array[idx0]) * frac;
  }
  return result;
}

function floatTo16BitPCM(float32Array) {
  const buf = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buf);
  for (let i = 0, offset = 0; i < float32Array.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true); // little-endian
  }
  return buf;
}

function int16ToFloat32(int16Array) {
  const out = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    out[i] = int16Array[i] / (int16Array[i] < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

function playAudioChunk(arrayBuffer) {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    nextPlayTime = playbackContext.currentTime;
  }
  const int16 = new Int16Array(arrayBuffer);
  const float32 = int16ToFloat32(int16);
  const audioBuffer = playbackContext.createBuffer(1, float32.length, TARGET_SAMPLE_RATE);
  audioBuffer.copyToChannel(float32, 0);

  const source = playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playbackContext.destination);

  const startAt = Math.max(nextPlayTime, playbackContext.currentTime);
  source.start(startAt);
  nextPlayTime = startAt + audioBuffer.duration;

  scheduledSources.push(source);
  source.onended = () => {
    scheduledSources = scheduledSources.filter((s) => s !== source);
  };
}

function flushPlayback() {
  // Barge-in: the user started talking, cut the prospect off immediately.
  for (const s of scheduledSources) {
    try { s.stop(); } catch (_) { /* already stopped */ }
  }
  scheduledSources = [];
  if (playbackContext) nextPlayTime = playbackContext.currentTime;
}

// --- Mic capture -------------------------------------------------------------
async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micContext = new (window.AudioContext || window.webkitAudioContext)();
  micSource = micContext.createMediaStreamSource(micStream);

  // ScriptProcessorNode is deprecated but universally supported; fine for an
  // MVP loop test. bufferSize 4096 @ typical 48kHz input is ~85ms per chunk.
  micProcessor = micContext.createScriptProcessor(4096, 1, 1);

  micProcessor.onaudioprocess = (event) => {
    if (!running || !ws || ws.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const resampled = downsample(input, micContext.sampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatTo16BitPCM(resampled);
    ws.send(pcm16);
  };

  // Route through a muted gain node so we don't hear our own mic, while still
  // keeping the processing graph alive (some browsers require a destination
  // connection for onaudioprocess to fire).
  const silentGain = micContext.createGain();
  silentGain.gain.value = 0;
  micSource.connect(micProcessor);
  micProcessor.connect(silentGain);
  silentGain.connect(micContext.destination);
}

function stopMic() {
  if (micProcessor) micProcessor.disconnect();
  if (micSource) micSource.disconnect();
  if (micContext) micContext.close();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micProcessor = micSource = micContext = micStream = null;
}

// --- WebSocket to our backend -------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/call`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => setStatus("connecting to prospect...");

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      playAudioChunk(event.data);
      return;
    }
    const msg = JSON.parse(event.data);
    if (msg.type === "status") {
      setStatus(msg.message);
    } else if (msg.type === "transcript") {
      appendTranscript(msg.speaker, msg.text);
    } else if (msg.type === "objection_logged") {
      appendObjectionTag(msg.objection);
    } else if (msg.type === "scorecard") {
      renderScorecard(msg.scorecard);
    } else if (msg.type === "barge_in") {
      flushPlayback();
    }
  };

  ws.onclose = () => {
    // The server closes the socket once (a) the call ended abruptly, or
    // (b) it finished sending the scorecard after a graceful end_call.
    // Either way, this is the real end of the call -- reset the UI here
    // rather than in requestEndCall, so we don't reset before the
    // scorecard has had a chance to arrive.
    running = false;
    stopMic();
    flushPlayback();
    toggleBtn.textContent = "Start Call";
    toggleBtn.classList.remove("stop");
    toggleBtn.disabled = false;
    if (statusEl.textContent === "connected" || statusEl.textContent.startsWith("connecting")) {
      setStatus("disconnected");
    }
  };

  ws.onerror = () => setStatus("connection error -- check server logs");
}

async function startCall() {
  scorecardEl.hidden = true;
  scorecardEl.innerHTML = "";
  transcriptEl.innerHTML = "";
  try {
    await startMic();
  } catch (err) {
    setStatus(`mic access failed: ${err.message}`);
    return;
  }
  running = true;
  connect();
  toggleBtn.textContent = "End Call";
  toggleBtn.classList.add("stop");
}

function requestEndCall() {
  // Stop capturing/playing audio immediately, but keep the socket open --
  // the backend still needs to close out the AssemblyAI session and run
  // the scorecard before this connection should close.
  stopMic();
  flushPlayback();
  toggleBtn.disabled = true;
  setStatus("ending call...");
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_call" }));
  } else {
    // Already disconnected somehow -- nothing to wait for.
    running = false;
    toggleBtn.disabled = false;
    toggleBtn.textContent = "Start Call";
    toggleBtn.classList.remove("stop");
  }
}

toggleBtn.addEventListener("click", () => {
  if (running) {
    requestEndCall();
  } else {
    startCall();
  }
});
