// Pushback client: landing page behavior, plus the audio and WebSocket
// plumbing for a call (mic capture -> downsample to 24kHz PCM16 -> our
// backend -> AssemblyAI, and AssemblyAI's reply audio -> our backend ->
// here, scheduled for gapless playback). All call-screen UI lives in
// workspace.js (window.wk); this file just reports what happens to it.

const TARGET_SAMPLE_RATE = 24000;

// --- Dark mode ------------------------------------------------------------
// Light is the default. Clicking a theme toggle sets an explicit
// [data-theme] attribute (also remembered in localStorage) that always wins,
// in either direction.
(function initTheme() {
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch (_) { /* localStorage unavailable (private mode, etc.) -- default light theme still applies */ }
})();

function currentEffectiveTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function toggleTheme() {
  const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch (_) { /* ignore */ }
}

const themeToggleBtn = document.getElementById("themeToggle");
if (themeToggleBtn) themeToggleBtn.addEventListener("click", toggleTheme);

const startFromLandingBtn = document.getElementById("startFromLanding");
const startFromLandingNavBtn = document.getElementById("startFromLandingNav");
const previewFromLandingBtn = document.getElementById("previewFromLanding");


// --- Hero mockup auto-play loop ---------------------------------------
// Purely decorative -- cycles the mockup panel through a canned
// sequence on a loop so the landing page demonstrates itself with no
// interaction required. A different objection type each cycle.
const HERO_VARIANTS = [
  { type: "Price", pillColor: "#c0293d", verdict: "Handled well", verdictColor: "#0b5", snippet: "Offered a concrete ROI estimate instead of a vague reassurance.", score: 72 },
  { type: "Timing", pillColor: "#c76a00", verdict: "Partially handled", verdictColor: "#d90", snippet: "Gave a rough timeline but didn't address the past bad experience.", score: 58 },
  { type: "Competitor", pillColor: "#1d4ed8", verdict: "Handled well", verdictColor: "#0b5", snippet: "Named a specific integration advantage over the competitor.", score: 81 },
  { type: "Send Info", pillColor: "#0a8a72", verdict: "Fumbled", verdictColor: "#c22", snippet: "Agreed to just send a PDF instead of pushing for a live demo.", score: 34 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Removing then re-adding a class (with a forced reflow in between)
// restarts its CSS animation from scratch -- needed since the same class
// gets reused every cycle.
function replayAnim(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // force reflow
  el.classList.add(className);
}

function animateCount(el, target, durationMs) {
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / durationMs, 1);
    el.textContent = `${Math.round(progress * target)}%`;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function runHeroLoop() {
  const chip1 = document.querySelector(".chip-1");
  const chip2 = document.querySelector(".chip-2");
  const chip2Label = chip2 && chip2.querySelector(".chip-label");
  const chip2Check = chip2 && chip2.querySelector(".chip-check");
  const floatScore = document.querySelector(".float-score");
  const scoreNum = floatScore && floatScore.querySelector(".num");
  const floatObjection = document.querySelector(".float-objection");
  const pillEl = floatObjection && floatObjection.querySelector(".pill");
  const verdictEl = floatObjection && floatObjection.querySelector(".verdict");
  const snippetEl = floatObjection && floatObjection.querySelector(".snippet");

  if (!chip1 || !chip2 || !floatScore || !floatObjection) return; // markup not present, bail quietly

  let i = 0;
  for (;;) {
    const v = HERO_VARIANTS[i % HERO_VARIANTS.length];
    i++;

    // Reset to the hidden state before populating this cycle's content.
    [chip1, chip2, floatScore, floatObjection].forEach((el) => el.classList.remove("anim-in", "anim-out"));
    scoreNum.textContent = "0%";
    chip2Label.textContent = `Objection: ${v.type}`;
    chip2Check.style.background = v.pillColor;
    chip2Check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="10" height="10"><polyline points="20 6 9 17 4 12"/></svg>';
    pillEl.textContent = v.type;
    pillEl.style.background = v.pillColor;
    verdictEl.textContent = v.verdict;
    verdictEl.style.color = v.verdictColor;
    snippetEl.textContent = v.snippet;

    replayAnim(chip1, "anim-in"); // 1. "Listening..." appears
    await sleep(1500);

    replayAnim(chip2, "anim-in"); // 2. objection pill appears
    await sleep(1000);

    replayAnim(floatObjection, "anim-in"); // 3. feedback card appears
    await sleep(500);

    replayAnim(floatScore, "anim-in"); // 4. score card appears, counts up
    animateCount(scoreNum, v.score, 1000);
    await sleep(1000);

    await sleep(2500); // hold

    [chip1, chip2, floatScore, floatObjection].forEach((el) => replayAnim(el, "anim-out"));
    await sleep(500);
  }
}

runHeroLoop();

// --- Scroll-reveal ------------------------------------------------------
// Each .reveal section (everything below the hero) fades + slides up the
// first time it enters the viewport, then stays revealed. Skipped
// entirely if IntersectionObserver isn't available (very old browser) --
// the sections just stay visible via their CSS default rather than error.
if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15 }
  );
  document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));
}

// --- Hero card 3D tilt ---------------------------------------------------
// Subtle perspective tilt following cursor position within the hero's
// gradient mockup panel. Restrained on purpose -- a few degrees, not a
// gimmick. Resets smoothly on mouseleave via the CSS transition already
// set on .visual-panel.
(function initHeroTilt() {
  const panel = document.querySelector(".visual-panel");
  if (!panel) return;
  const MAX_TILT_DEG = 7;

  panel.addEventListener("mousemove", (e) => {
    const rect = panel.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width; // 0..1 left-to-right
    const y = (e.clientY - rect.top) / rect.height; // 0..1 top-to-bottom
    const rotateY = (x - 0.5) * MAX_TILT_DEG * 2;
    const rotateX = (0.5 - y) * MAX_TILT_DEG * 2;
    panel.style.transform = `perspective(900px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  });

  panel.addEventListener("mouseleave", () => {
    panel.style.transform = "perspective(900px) rotateX(0deg) rotateY(0deg)";
  });
})();


// --- Call audio state ---------------------------------------------------------
let ws = null;
let micStream = null;
let micContext = null;
let micSource = null;
let micProcessor = null;
let micAnalyser = null;
let running = false;
let starting = false;
let endRequested = false;

let micMuted = false;
function isMicMuted() { return micMuted; }
function setMicMuted(muted) { micMuted = !!muted; }

// --- Playback scheduling ----------------------------------------------------
let playbackContext = null;
let outputGainNode = null;
let playbackAnalyser = null;
let nextPlayTime = 0;
let scheduledSources = [];

// Phone-style earpiece/speaker switch, not a mute: Jordan is always audible,
// just quieter (earpiece) or louder (speakerphone). NORMAL is the default.
const NORMAL_GAIN = 0.35;
const SPEAKER_GAIN = 1.0;
let speakerOn = false;

function currentOutputGain() {
  return speakerOn ? SPEAKER_GAIN : NORMAL_GAIN;
}
function isSpeakerOn() { return speakerOn; }
function setSpeakerMode(isOn) {
  speakerOn = !!isOn;
  if (outputGainNode) outputGainNode.gain.value = currentOutputGain();
}

// Frequency data for the live visualizer: Jordan's playback or your mic.
// Null until the relevant audio graph exists.
const levelBuffers = {};
function readLevels(kind) {
  const analyser = kind === "jordan" ? playbackAnalyser : micAnalyser;
  if (!analyser) return null;
  const buf = levelBuffers[kind] || (levelBuffers[kind] = new Uint8Array(analyser.frequencyBinCount));
  analyser.getByteFrequencyData(buf);
  return buf;
}

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

// iOS Safari suspends a new AudioContext until it's both created AND
// resumed directly inside a user-gesture call stack -- created lazily on
// the first incoming audio chunk (a WebSocket message, not a gesture), it
// stays silently suspended forever on iOS. Call this eagerly from the
// Start-call click handler itself so creation+resume happen in-gesture;
// playAudioChunk then just reuses whatever this already set up.
function ensurePlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    outputGainNode = playbackContext.createGain();
    outputGainNode.gain.value = currentOutputGain();
    outputGainNode.connect(playbackContext.destination);
    // Level tap for the call screen's visualizer. Fed by each chunk directly
    // (not through the volume gain, so Normal mode doesn't shrink the bars)
    // and routed through a zero-gain node so the browser keeps processing it.
    playbackAnalyser = playbackContext.createAnalyser();
    playbackAnalyser.fftSize = 128;
    playbackAnalyser.smoothingTimeConstant = 0.6;
    const playbackTap = playbackContext.createGain();
    playbackTap.gain.value = 0;
    playbackAnalyser.connect(playbackTap);
    playbackTap.connect(playbackContext.destination);
    nextPlayTime = playbackContext.currentTime;
  }
  if (playbackContext.state === "suspended") {
    playbackContext.resume().catch(() => {});
  }
}

function playAudioChunk(arrayBuffer) {
  ensurePlaybackContext();
  const int16 = new Int16Array(arrayBuffer);
  const float32 = int16ToFloat32(int16);
  const audioBuffer = playbackContext.createBuffer(1, float32.length, TARGET_SAMPLE_RATE);
  audioBuffer.copyToChannel(float32, 0);

  const source = playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(outputGainNode);
  source.connect(playbackAnalyser);

  const startAt = Math.max(nextPlayTime, playbackContext.currentTime);
  source.start(startAt);
  nextPlayTime = startAt + audioBuffer.duration;

  scheduledSources.push(source);
  source.onended = () => {
    scheduledSources = scheduledSources.filter((s) => s !== source);
  };

  wk.onJordanAudio(Math.max(0, (nextPlayTime - playbackContext.currentTime) * 1000));
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
  // autoGainControl matters most here: a quiet laptop mic can leave real
  // speech below the VAD's energy threshold, which reads as silence
  // mid-sentence no matter how min_silence/max_silence are tuned -- this is
  // a signal-gain fix, distinct from the noise-suppression constraints
  // reverted earlier for a background-noise problem that didn't apply.
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  micContext = new (window.AudioContext || window.webkitAudioContext)();
  micSource = micContext.createMediaStreamSource(micStream);

  // AudioWorkletNode runs mic capture on the browser's dedicated real-time
  // audio thread instead of the main thread (see mic-processor.js) -- fixes
  // words/syllables silently getting dropped from what's sent to AssemblyAI
  // whenever the main thread is busy (DOM updates, JSON parsing)
  // during a call, which the ScriptProcessorNode this replaces was exposed to.
  await micContext.audioWorklet.addModule("mic-processor.js");
  micProcessor = new AudioWorkletNode(micContext, "mic-capture-processor");

  micProcessor.port.onmessage = (event) => {
    // A chunk can still be in flight after stopMic() tears the context down.
    if (!micContext || !running || micMuted || !ws || ws.readyState !== WebSocket.OPEN) return;
    const resampled = downsample(event.data, micContext.sampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatTo16BitPCM(resampled);
    ws.send(pcm16);
  };

  // Route through a muted gain node so we don't hear our own mic, while still
  // keeping the processing graph alive (some browsers require a destination
  // connection for the worklet to keep processing).
  const silentGain = micContext.createGain();
  silentGain.gain.value = 0;
  micAnalyser = micContext.createAnalyser();
  micAnalyser.fftSize = 128;
  micAnalyser.smoothingTimeConstant = 0.6;
  micSource.connect(micAnalyser);
  micAnalyser.connect(silentGain);
  micSource.connect(micProcessor);
  micProcessor.connect(silentGain);
  silentGain.connect(micContext.destination);
}

function stopMic() {
  if (micProcessor) {
    micProcessor.port.onmessage = null;
    micProcessor.disconnect();
  }
  if (micSource) micSource.disconnect();
  if (micContext) micContext.close();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micProcessor = micSource = micContext = micStream = micAnalyser = null;
}

// --- WebSocket to our backend -------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const industry = wk.state.scenario;
  const wsUrl = `${proto}//${location.host}/call?industry=${encodeURIComponent(industry)}`;
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    // The user may have hit End call while the socket was still opening.
    if (endRequested) ws.send(JSON.stringify({ type: "end_call" }));
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      playAudioChunk(event.data);
      return;
    }
    const msg = JSON.parse(event.data);
    if (msg.type === "status") {
      wk.onStatus(msg.message);
    } else if (msg.type === "transcript") {
      wk.onTranscript(msg.speaker, msg.text);
    } else if (msg.type === "reply_started") {
      wk.onReplyStarted();
    } else if (msg.type === "objection_logged") {
      wk.onObjection(msg.objection);
    } else if (msg.type === "scorecard") {
      wk.onScorecard(msg.scorecard);
    } else if (msg.type === "scorecard_error") {
      wk.onScorecardError(msg.message);
    } else if (msg.type === "barge_in") {
      flushPlayback();
      wk.onBargeIn();
    }
  };

  ws.onclose = () => {
    // The server closes the socket once (a) the call ended abruptly, or
    // (b) it finished sending the scorecard after a graceful end_call.
    // Either way, this is the real end of the call. The scorecard message
    // (if any) always arrives before the close, so by now the call screen
    // has either handled it or knows it never came.
    running = false;
    starting = false;
    stopMic();
    flushPlayback();
    wk.onWsClosed();
  };

  ws.onerror = () => wk.onStatus("connection error");
}

async function startCall() {
  if (starting || running) return;
  starting = true;
  endRequested = false;
  // Must happen synchronously in this click handler, before any await --
  // iOS Safari only allows creating/resuming an AudioContext for playback
  // while still inside the user-gesture call stack.
  ensurePlaybackContext();
  setMicMuted(false);
  wk.onCallStarting();
  try {
    await startMic();
  } catch (err) {
    starting = false;
    wk.onMicError(err);
    return;
  }
  running = true;
  starting = false;
  connect();
}

function requestEndCall() {
  // Stop capturing/playing audio immediately, but keep the socket open --
  // the backend still needs to close out the AssemblyAI session and run
  // the scorecard before this connection should close.
  endRequested = true;
  stopMic();
  flushPlayback();
  wk.onEndRequested();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_call" }));
  } else if (!ws || ws.readyState !== WebSocket.CONNECTING) {
    // Never connected (or already gone) -- nothing to wait for.
    running = false;
    starting = false;
    wk.onWsClosed();
  }
}

// Walking away mid-call (back to the landing page): hard stop, no scorecard
// requested for a call that's being cut short.
function abortCall() {
  if (ws) {
    try { ws.close(); } catch (_) { /* already closing/closed */ }
    ws = null;
  }
  stopMic();
  flushPlayback();
  running = false;
  starting = false;
}

// These just navigate to the call screen -- they do NOT start the call.
// The call only actually starts (mic access, WebSocket connect) when the
// green Start practice call button is pressed, so the user always sees the
// call setup first rather than landing straight into a live call.
startFromLandingBtn.addEventListener("click", () => wk.enter());
startFromLandingNavBtn.addEventListener("click", () => wk.enter());

// Logo in the nav and footer -- scrolls to top rather than navigating
// anywhere, since this is a single-page site with no separate "home".
document.querySelectorAll(".logo-home").forEach((el) => {
  el.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
});

// --- Mobile hamburger menu ------------------------------------------------
const hamburgerBtn = document.getElementById("hamburgerBtn");
const mobileMenu = document.getElementById("mobileMenu");
if (hamburgerBtn && mobileMenu) {
  function setMobileMenuOpen(open) {
    hamburgerBtn.classList.toggle("open", open);
    mobileMenu.classList.toggle("open", open);
    hamburgerBtn.setAttribute("aria-expanded", String(open));
  }
  hamburgerBtn.addEventListener("click", () => {
    setMobileMenuOpen(!mobileMenu.classList.contains("open"));
  });
  // Closing after picking a link keeps the menu from still covering the
  // section it just jumped to.
  mobileMenu.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => setMobileMenuOpen(false));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setMobileMenuOpen(false);
  });
}

// --- Scroll-to-top button --------------------------------------------------
const scrollTopBtn = document.getElementById("scrollTopBtn");
if (scrollTopBtn) {
  window.addEventListener("scroll", () => {
    scrollTopBtn.classList.toggle("visible", window.scrollY > 400);
  });
  scrollTopBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}

previewFromLandingBtn.addEventListener("click", () => wk.runPreview());

// "See example" on each objection-type card -- same zero-cost preview.
document.querySelectorAll(".see-example").forEach((el) => {
  el.addEventListener("click", () => wk.runPreview());
});

// Footer "Start a practice call" link -- same as the landing CTAs, just navigates.
const footerStartLink = document.getElementById("footerStart");
if (footerStartLink) {
  footerStartLink.addEventListener("click", (e) => {
    e.preventDefault();
    wk.enter();
  });
}
