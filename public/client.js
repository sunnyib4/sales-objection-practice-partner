// Bare-loop test client: mic capture -> downsample to 24kHz PCM16 -> our
// backend -> AssemblyAI, and AssemblyAI's reply audio -> our backend -> here,
// scheduled for gapless playback. No scorecard / tool logic yet.

const TARGET_SAMPLE_RATE = 24000;

// --- Dark mode ------------------------------------------------------------
// System preference is the default, applied purely via the
// @media(prefers-color-scheme) CSS rules with no JS involved. Clicking the
// toggle sets an explicit [data-theme] attribute that overrides the OS
// setting (in either direction) and is remembered in localStorage; visiting
// again with no stored preference falls back to system preference again.
(function initTheme() {
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch (_) { /* localStorage unavailable (private mode, etc.) -- system preference still works */ }
})();

function currentEffectiveTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit) return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const themeToggleBtn = document.getElementById("themeToggle");
if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", () => {
    const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (_) { /* ignore */ }
  });
}

const landingEl = document.getElementById("landing");
const appEl = document.getElementById("app");
const startFromLandingBtn = document.getElementById("startFromLanding");
const startFromLandingNavBtn = document.getElementById("startFromLandingNav");
const previewFromLandingBtn = document.getElementById("previewFromLanding");
const backToLandingBtn = document.getElementById("backToLanding");

const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle");
const previewBtn = document.getElementById("preview");
const transcriptEl = document.getElementById("transcript");
const transcriptDetailsEl = document.getElementById("transcriptDetails");
const scorecardEl = document.getElementById("scorecard");

const callSubtitleEl = document.getElementById("callSubtitle");
const callTimerEl = document.getElementById("callTimer");
const muteMicBtn = document.getElementById("muteMicBtn");
const muteSpeakerBtn = document.getElementById("muteSpeakerBtn");
const endCallBtn = document.getElementById("endCallBtn");

// Matches the persona titles actually sent to the Voice Agent API per
// scenario (see SYSTEM_PROMPTS in server/index.js) -- kept in sync by hand
// since the persona text itself lives server-side.
const SCENARIO_SUBTITLES = {
  logistics: "VP of Operations · Logistics",
  saas: "VP of Revenue Ops · SaaS",
  realestate: "Managing Broker · Real Estate",
};

// Reads the landing page's scenario dropdown and syncs the call card's
// name/role display to it. Purely client-side -- the dropdown value is
// already known synchronously, no need to wait on any server response.
// Called both the instant the app screen appears and again right before
// the call connects, so there's never a frame showing the hardcoded
// "Logistics" default markup from index.html for a different scenario.
function applyScenarioSubtitle() {
  const industrySelect = document.getElementById("industrySelect");
  const industry = industrySelect ? industrySelect.value : "logistics";
  if (callSubtitleEl) callSubtitleEl.textContent = SCENARIO_SUBTITLES[industry] || SCENARIO_SUBTITLES.logistics;
  return industry;
}

let micMuted = false;
let callTimerInterval = null;
let callStartTimestamp = null;

function startCallTimer() {
  callStartTimestamp = Date.now();
  updateCallTimerDisplay();
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = setInterval(updateCallTimerDisplay, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = null;
  callStartTimestamp = null;
  if (callTimerEl) callTimerEl.textContent = "00:00";
}

function updateCallTimerDisplay() {
  if (!callTimerEl || !callStartTimestamp) return;
  const elapsed = Math.floor((Date.now() - callStartTimestamp) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  callTimerEl.textContent = `${mm}:${ss}`;
}

function enterApp() {
  applyScenarioSubtitle();
  landingEl.hidden = true;
  appEl.hidden = false;
}

function leaveApp() {
  if (running) {
    // Abandoning an active call to go back -- hard stop rather than the
    // graceful end_call handshake, since walking away isn't a request for
    // a scorecard on a call that's being cut short mid-conversation.
    if (ws) {
      try { ws.close(); } catch (_) { /* already closing/closed */ }
      ws = null;
    }
    stopMic();
    flushPlayback();
    stopCallTimer();
    hideTypingIndicator();
    running = false;
    showStartControl();
    setStatus("idle");
  }
  appEl.hidden = true;
  landingEl.hidden = false;
}

// --- Hero mockup auto-play loop ---------------------------------------
// Purely decorative -- cycles the purple mockup panel through a canned
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

let ws = null;
let micStream = null;
let micContext = null;
let micSource = null;
let micProcessor = null;
let running = false;

// --- Inline objection-tag correlation ---------------------------------------
// The `objection_logged` tool-call event and the prospect's `transcript`
// line for the same utterance arrive as two independent WS messages with
// no guaranteed order -- AssemblyAI can emit the tool call before the
// final transcript text, or after. `currentProspectLineEl` tracks the most
// recent prospect line that hasn't been superseded by a "you" line yet; if
// a tag arrives while one is current, it attaches immediately, otherwise
// it's queued and attached to the next prospect line that renders.
let currentProspectLineEl = null;
let pendingObjectionTags = [];

const OBJECTION_COLORS = {
  price: "#c0293d",
  timing: "#c76a00",
  competitor: "#1d4ed8",
  send_info: "#0a8a72",
  other: "#666",
};

// --- Playback scheduling ----------------------------------------------------
let playbackContext = null;
let outputGainNode = null;
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

function setStatus(text) {
  statusEl.textContent = text;
}

let typingIndicatorEl = null;

function showTypingIndicator() {
  if (typingIndicatorEl) return; // already showing
  typingIndicatorEl = document.createElement("div");
  typingIndicatorEl.className = "typing-indicator";
  typingIndicatorEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  transcriptEl.appendChild(typingIndicatorEl);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function hideTypingIndicator() {
  if (typingIndicatorEl) {
    typingIndicatorEl.remove();
    typingIndicatorEl = null;
  }
}

function appendTranscript(speaker, text) {
  hideTypingIndicator(); // the real message is here, drop the "typing..." bubble
  const div = document.createElement("div");
  div.className = `line ${speaker}`;

  const label = document.createElement("b");
  label.textContent = speaker === "you" ? "You" : "Jordan";
  div.appendChild(label);

  div.appendChild(document.createTextNode(text));

  const badges = document.createElement("span");
  badges.className = "line-badges";
  div.appendChild(badges);

  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  if (speaker === "prospect") {
    currentProspectLineEl = div;
    if (pendingObjectionTags.length) {
      for (const tag of pendingObjectionTags) attachObjectionBadge(div, tag);
      pendingObjectionTags = [];
    }
  } else {
    // Conversation moved on -- this prospect line is no longer "current"
    // for the purpose of attaching a late-arriving tag.
    currentProspectLineEl = null;
  }
}

function attachObjectionBadge(lineEl, objection) {
  const badge = document.createElement("span");
  badge.className = "obj-badge";
  const type = objection.objection_type || "other";
  badge.style.background = OBJECTION_COLORS[type] || OBJECTION_COLORS.other;
  badge.textContent = type.replace("_", " ").toUpperCase();
  if (objection.your_line) badge.title = objection.your_line;
  lineEl.querySelector(".line-badges").appendChild(badge);
}

function handleObjectionLogged(objection) {
  if (currentProspectLineEl) {
    attachObjectionBadge(currentProspectLineEl, objection);
  } else {
    pendingObjectionTags.push(objection);
  }
  markObjectionTracked(objection.objection_type);
}

// --- Live objection tracker ---------------------------------------------
// Scoped to the current call only -- resetObjectionTracker() clears it at
// the start of every new call/preview. "other" isn't one of the four
// tracked categories, so it's left unmarked here.
function markObjectionTracked(type) {
  const item = document.querySelector(`.tracker-item[data-type="${type}"]`);
  if (item) item.classList.add("raised");
}

function resetObjectionTracker() {
  document.querySelectorAll(".tracker-item.raised").forEach((el) => el.classList.remove("raised"));
}

const VERDICT_LABEL = {
  handled_well: "Handled well",
  partially_handled: "Partially handled",
  fumbled: "Fumbled",
};

const VERDICT_COLOR = {
  handled_well: "#0b5",
  partially_handled: "#d90",
  fumbled: "#c22",
};

const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>';
const ARROW_UP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';


function scoreColor(score) {
  if (score === null || score === undefined) return "#999";
  if (score >= 70) return "#0b5";
  if (score >= 40) return "#d90";
  return "#c22";
}

let gaugeChartInstance = null;

function renderScoreSection(scorecard) {
  const categories = scorecard.categories || {};
  const color = scoreColor(scorecard.overall_score);
  scorecardEl.style.setProperty("--score-color", color); // tints #scorecard's top accent bar

  const objections = scorecard.objections || [];
  const countByVerdict = (v) => objections.filter((o) => o.verdict === v).length;

  const grid = document.createElement("div");
  grid.className = "stat-grid";

  // --- Overall card: arc gauge + handled/partial/fumbled counts, full width ---
  const overallCard = document.createElement("div");
  overallCard.className = "stat-card stat-overall";
  overallCard.innerHTML = `
    <div class="stat-label">Overall</div>
    <div class="stat-gauge-row">
      <div class="sc-gauge-wrap">
        <canvas></canvas>
        <div class="sc-gauge-center"><div class="sc-overall-num" style="color:${color}">0%</div></div>
      </div>
      <div class="stat-substats">
        <div class="stat-substat"><b>${countByVerdict("handled_well")}</b><span>Handled well</span></div>
        <div class="stat-substat"><b>${countByVerdict("partially_handled")}</b><span>Partially handled</span></div>
        <div class="stat-substat"><b>${countByVerdict("fumbled")}</b><span>Fumbled</span></div>
      </div>
    </div>
  `;
  grid.appendChild(overallCard);
  const overallNumEl = overallCard.querySelector(".sc-overall-num");
  const gaugeCanvas = overallCard.querySelector("canvas");

  // --- One card per category: big number + fill bar, same row ---
  const categoryDefs = [
    { key: "objection_resolution", label: "Objection Resolution" },
    { key: "response_specificity", label: "Response Specificity" },
    { key: "discovery", label: "Discovery" },
  ];
  const categoryEls = categoryDefs.map((def) => {
    const value = categories[def.key] ?? 0;
    const barColor = scoreColor(categories[def.key]);
    const card = document.createElement("div");
    card.className = "stat-card";
    card.innerHTML = `
      <div class="stat-label">${escapeHtml(def.label)}</div>
      <div class="stat-num-big" style="color:${barColor}">0%</div>
      <div class="stat-bar"><div class="stat-bar-fill" style="background:${barColor}"></div></div>
    `;
    grid.appendChild(card);
    return { value, numEl: card.querySelector(".stat-num-big"), fillEl: card.querySelector(".stat-bar-fill") };
  });

  scorecardEl.appendChild(grid);

  // Animate the overall number/arc immediately; stagger the three category
  // cards slightly afterward so the grid doesn't all snap in identically.
  animateCount(overallNumEl, scorecard.overall_score, 800);
  categoryEls.forEach(({ numEl, fillEl, value }, i) => {
    setTimeout(() => {
      animateCount(numEl, value, 700);
      fillEl.style.width = `${value}%`;
    }, i * 120);
  });

  if (gaugeChartInstance) { gaugeChartInstance.destroy(); gaugeChartInstance = null; }

  if (window.Chart) {
    gaugeChartInstance = new Chart(gaugeCanvas.getContext("2d"), {
      type: "doughnut",
      data: {
        datasets: [
          {
            data: [scorecard.overall_score, 100 - scorecard.overall_score],
            backgroundColor: [color, getComputedStyle(document.documentElement).getPropertyValue("--track").trim() || "#e2e5ec"],
            borderWidth: 0,
          },
        ],
      },
      options: {
        cutout: "78%",
        rotation: -90,
        circumference: 360,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        animation: { duration: 600 },
      },
    });
  }
}
function renderScorecard(scorecard) {
  scorecardEl.innerHTML = "";
  scorecardEl.hidden = false;
  // The score/feedback is the headline info -- collapse the transcript
  // back down so it doesn't compete for scroll space with it.
  if (transcriptDetailsEl) transcriptDetailsEl.open = false;

  const summary = document.createElement("p");
  summary.className = "sc-summary";
  summary.textContent = scorecard.overall_summary || "";
  scorecardEl.appendChild(summary);

  if (scorecard.overall_score !== null && scorecard.overall_score !== undefined) {
    renderScoreSection(scorecard);
  }

  const objections = scorecard.objections || [];

  if (objections.length) {
    scorecardEl.appendChild(buildFilterRow(objections));
  }

  objections.forEach((obj, i) => {
    const row = document.createElement("details");
    row.className = `sc-objection sc-${obj.verdict}`;
    row.dataset.verdict = obj.verdict;
    row.style.animationDelay = `${i * 0.08}s`;
    // Collapsed by default for every verdict -- the summary line below
    // already shows the badges + quoted objection, which is enough to
    // scan the whole call without expanding anything.
    const typeColor = OBJECTION_COLORS[obj.objection_type] || OBJECTION_COLORS.other;
    const verdictColor = VERDICT_COLOR[obj.verdict] || "#999";
    row.innerHTML = `
      <summary class="sc-objection-head">
        <span class="sc-objection-head-left">
          <span class="sc-type-badge" style="background:${typeColor}">${escapeHtml(
            (obj.objection_type || "other").replace("_", " ")
          )}</span>
          <span class="sc-verdict" style="background:${verdictColor}">${escapeHtml(VERDICT_LABEL[obj.verdict] || obj.verdict)}</span>
          <span class="sc-prospect-line-inline">"${escapeHtml(obj.prospect_line)}"</span>
        </span>
        <svg class="sc-objection-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="sc-objection-body">
        <div class="sc-feedback">${escapeHtml(obj.feedback)}</div>
        ${obj.better_response ? `
        <div class="sc-better-response">
          <div class="sc-better-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
            Try this instead
          </div>
          <div class="sc-better-text">"${escapeHtml(obj.better_response)}"</div>
          ${obj.next_step ? `
          <div class="sc-next-step">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            <span>${escapeHtml(obj.next_step)}</span>
          </div>` : ""}
        </div>` : ""}
      </div>
    `;
    scorecardEl.appendChild(row);
  });

  if ((scorecard.strengths || []).length) {
    scorecardEl.appendChild(buildList("Strengths", scorecard.strengths, CHECK_ICON, "strengths"));
  }
  if ((scorecard.areas_to_improve || []).length) {
    scorecardEl.appendChild(buildList("Areas to improve", scorecard.areas_to_improve, ARROW_UP_ICON, "improve"));
  }

  scorecardEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildList(title, items, iconSvg, modifierClass) {
  const wrap = document.createElement("div");
  wrap.className = `sc-list${modifierClass ? " " + modifierClass : ""}`;
  const h = document.createElement("b");
  h.className = "sc-list-title";
  h.textContent = title;
  wrap.appendChild(h);
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    if (iconSvg) li.innerHTML = iconSvg;
    const span = document.createElement("span");
    span.textContent = item;
    li.appendChild(span);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

// Verdict filter pills above the objection list -- click one to show only
// that verdict, click "All" (or the active one again) to clear the filter.
// Purely a display toggle: .sc-filtered-out just collapses the row via
// CSS, nothing gets removed from the DOM or re-fetched.
function buildFilterRow(objections) {
  const counts = { handled_well: 0, partially_handled: 0, fumbled: 0 };
  for (const obj of objections) {
    if (obj.verdict in counts) counts[obj.verdict]++;
  }

  const row = document.createElement("div");
  row.className = "sc-filter-row";

  const options = [
    { verdict: null, label: "All" },
    { verdict: "handled_well", label: "Handled well" },
    { verdict: "partially_handled", label: "Partially handled" },
    { verdict: "fumbled", label: "Fumbled" },
  ];

  for (const opt of options) {
    const count = opt.verdict ? counts[opt.verdict] : objections.length;
    if (opt.verdict && count === 0) continue; // don't show a filter for a verdict that didn't occur
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sc-filter-btn" + (opt.verdict === null ? " active" : "");
    btn.dataset.verdict = opt.verdict || "";
    btn.innerHTML = `${escapeHtml(opt.label)} <span class="count">${count}</span>`;
    btn.addEventListener("click", () => applyVerdictFilter(opt.verdict, row));
    row.appendChild(btn);
  }

  return row;
}

function applyVerdictFilter(verdict, filterRowEl) {
  filterRowEl.querySelectorAll(".sc-filter-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.verdict === (verdict || ""));
  });
  scorecardEl.querySelectorAll(".sc-objection").forEach((row) => {
    const show = !verdict || row.dataset.verdict === verdict;
    row.classList.toggle("sc-filtered-out", !show);
  });
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
  // whenever the main thread is busy (DOM updates, Chart.js, JSON parsing)
  // during a call, which the ScriptProcessorNode this replaces was exposed to.
  await micContext.audioWorklet.addModule("mic-processor.js");
  micProcessor = new AudioWorkletNode(micContext, "mic-capture-processor");

  micProcessor.port.onmessage = (event) => {
    if (!running || micMuted || !ws || ws.readyState !== WebSocket.OPEN) return;
    const resampled = downsample(event.data, micContext.sampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatTo16BitPCM(resampled);
    ws.send(pcm16);
  };

  // Route through a muted gain node so we don't hear our own mic, while still
  // keeping the processing graph alive (some browsers require a destination
  // connection for the worklet to keep processing).
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
  const industry = applyScenarioSubtitle();
  const wsUrl = `${proto}//${location.host}/call?industry=${encodeURIComponent(industry)}`;
  console.log("[DIAGNOSTIC] industry used for WS URL:", industry, "| WS URL:", wsUrl);
  ws = new WebSocket(wsUrl);
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
      if (msg.message === "connected") startCallTimer();
    } else if (msg.type === "transcript") {
      hideTypingIndicator(); // covers both sides -- a "you" line also means Jordan's turn is over
      appendTranscript(msg.speaker, msg.text);
    } else if (msg.type === "reply_started") {
      showTypingIndicator();
    } else if (msg.type === "objection_logged") {
      handleObjectionLogged(msg.objection);
    } else if (msg.type === "scorecard") {
      renderScorecard(msg.scorecard);
    } else if (msg.type === "barge_in") {
      hideTypingIndicator();
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
    stopCallTimer();
    showStartControl();
    if (statusEl.textContent === "connected" || statusEl.textContent.startsWith("connecting")) {
      setStatus("disconnected");
    }
  };

  ws.onerror = () => setStatus("connection error, check server logs");
}

function showActiveControls() {
  toggleBtn.hidden = true;
  endCallBtn.hidden = false;
  muteMicBtn.hidden = false;
  muteSpeakerBtn.hidden = false;
  // Reset in case they were left disabled by a previous call's end-call sequence.
  endCallBtn.disabled = false;
  muteMicBtn.disabled = false;
  muteSpeakerBtn.disabled = false;
}

function showStartControl() {
  toggleBtn.hidden = false;
  toggleBtn.disabled = false;
  endCallBtn.hidden = true;
  muteMicBtn.hidden = true;
  muteSpeakerBtn.hidden = true;
  setMicMuted(false);
  setSpeakerMode(false);
}

function setMicMuted(muted) {
  micMuted = muted;
  muteMicBtn.classList.toggle("muted", muted);
}

// Toggles between "Normal" (quiet, earpiece-style) and "Speaker" (full
// volume) -- unlike the mic mute button, Jordan is never silenced.
function setSpeakerMode(isSpeakerOn) {
  speakerOn = isSpeakerOn;
  muteSpeakerBtn.classList.toggle("speaker-on", isSpeakerOn);
  muteSpeakerBtn.title = isSpeakerOn ? "Switch to Normal" : "Switch to Speaker";
  muteSpeakerBtn.setAttribute("aria-label", isSpeakerOn ? "Switch to Normal" : "Switch to Speaker");
  if (outputGainNode) outputGainNode.gain.value = currentOutputGain();
}

async function startCall() {
  // Must happen synchronously in this click handler, before any await --
  // iOS Safari only allows creating/resuming an AudioContext for playback
  // while still inside the user-gesture call stack.
  ensurePlaybackContext();
  scorecardEl.hidden = true;
  scorecardEl.innerHTML = "";
  transcriptEl.innerHTML = "";
  currentProspectLineEl = null;
  pendingObjectionTags = [];
  typingIndicatorEl = null; // transcriptEl.innerHTML reset already dropped the DOM node
  resetObjectionTracker();
  // Open live captions for the call itself; renderScorecard() collapses
  // this back down once the call ends and the scorecard takes over.
  if (transcriptDetailsEl) transcriptDetailsEl.open = true;
  try {
    await startMic();
  } catch (err) {
    setStatus(`mic access failed: ${err.message}`);
    return;
  }
  running = true;
  connect();
  showActiveControls();
}

function requestEndCall() {
  // Stop capturing/playing audio immediately, but keep the socket open --
  // the backend still needs to close out the AssemblyAI session and run
  // the scorecard before this connection should close.
  stopMic();
  flushPlayback();
  endCallBtn.disabled = true;
  muteMicBtn.disabled = true;
  muteSpeakerBtn.disabled = true;
  setStatus("ending call...");
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_call" }));
  } else {
    // Already disconnected somehow -- nothing to wait for.
    running = false;
    showStartControl();
  }
}

toggleBtn.addEventListener("click", startCall);
endCallBtn.addEventListener("click", requestEndCall);
muteMicBtn.addEventListener("click", () => setMicMuted(!micMuted));
muteSpeakerBtn.addEventListener("click", () => setSpeakerMode(!speakerOn));

// --- Zero-cost UI preview -----------------------------------------------
// Replays canned sample data through the exact same rendering functions a
// real call uses -- no WebSocket, no mic, no AssemblyAI usage. For
// iterating on layout/styling without burning API calls on every check.
// The transcript below mirrors what test-scorecard.js sends the LLM
// Gateway, and SAMPLE_SCORECARD is verbatim real output from that script,
// not invented data.
const SAMPLE_TRANSCRIPT = [
  { speaker: "prospect", text: "Hey, this is Jordan, I've got about ten minutes before my next meeting, so let's make it count. What is this about?" },
  { speaker: "you", text: "Hi Jordan, I'm calling about RouteSync. We help logistics companies cut delivery costs by optimizing driver routes in real time. How many trucks are you running right now?" },
  { speaker: "prospect", text: "About forty trucks. What's this going to cost me?" },
  { speaker: "you", text: "For a fleet your size it's about $2,500 a month, and most customers make that back in fuel savings within six to eight weeks." },
  {
    speaker: "prospect",
    text: "That's a tough sell right now. Budget for new tools needs VP sign-off and we're tight this quarter.",
    objection: { objection_type: "price", your_line: "That's a tough sell right now. Budget for new tools needs VP sign-off and we're tight this quarter." },
  },
  { speaker: "you", text: "Makes sense, want me to put together a quick ROI estimate off your actual fuel spend so you've got real numbers for that budget conversation?" },
  {
    speaker: "prospect",
    text: "Sure. How fast could we actually get this running? Last vendor we used took months to integrate and it was a mess.",
    objection: { objection_type: "timing", your_line: "How fast could we actually get this running? Last vendor we used took months to integration and it was a mess." },
  },
  { speaker: "you", text: "Yeah, it's usually a pretty smooth process for most companies." },
  {
    speaker: "prospect",
    text: "We're also looking at RouteworksAI, so I want to see how you compare.",
    objection: { objection_type: "competitor", your_line: "We're also looking at RouteworksAI, so I want to see how you compare." },
  },
  { speaker: "you", text: "RouteworksAI's solid, but we integrate directly with your existing dispatch software instead of requiring a swap, and support is 24/7. I can send over a side-by-side comparison if that helps." },
  {
    speaker: "prospect",
    text: "I've got another meeting starting soon, just send me some information instead.",
    objection: { objection_type: "send_info", your_line: "I've got another meeting starting soon, just send me some information instead." },
  },
  { speaker: "you", text: "I can send it over, but a lot gets lost in a PDF. Could we grab fifteen minutes later this week so I can actually show you the routing in action?" },
];

const SAMPLE_SCORECARD = {
  overall_summary: "The salesperson successfully opened with a relevant hook and a specific price point, but significantly underperformed when handling three of four objections. While they initiatively offered an ROI estimate for the budget concern, they failed to provide a timeline for integration, made a vague claim about competitor support, and ultimately fumbled the request for materials by offering a call instead of delivering the requested info before the next meeting.",
  overall_score: 43,
  categories: { objection_resolution: 25, response_specificity: 55, discovery: 50 },
  objections: [
    {
      objection_type: "price",
      prospect_line: "That's a tough sell right now. Budget for new tools needs VP sign-off and we're tight this quarter.",
      verdict: "partially_handled",
      feedback: "The salesperson jumped immediately to offering a solution (ROI estimate) without first validating the price as the actual blocker or understanding the VP's decision criteria. They missed an opportunity to drill into the 'tight this quarter' constraint to find a flexibility or a pilot program path.",
      better_response: "Is the budget itself the blocker, or is it more about getting something concrete enough for VP sign-off? If it's the latter, could we run a trial with your actual weekly data to build the ROI case without needing full budget approval first?",
      next_step: null,
    },
    {
      objection_type: "timing",
      prospect_line: "How fast could we actually get this running? Last vendor we used took months to integrate and it was a mess.",
      verdict: "fumbled",
      feedback: "The response was evasive and unhelpful, saying 'it's usually a pretty smooth process' which directly contradicted the prospect's fear without backing it up with a specific timeline or referencing integration timeframes.",
      better_response: "The integration is typically done in under a week, so you should see the dashboard populated and driving your first optimized route within ten days of signing.",
      next_step: "Offer to share a 2-page case study of a similar 40-truck client showing their specific implementation timeline to reduce their integration anxiety.",
    },
    {
      objection_type: "competitor",
      prospect_line: "We're also looking at RouteworksAI, so I want to see how you compare.",
      verdict: "partially_handled",
      feedback: "The response provided two advantages (direct integration vs swap, 24/7 support) but focused on feature comparison rather than business value. It failed to connect these specific differentiators back to Jordan's pain points, like the 'messy integration' mentioned earlier or cost avoidance on software replacement.",
      better_response: "Sounds like you want to avoid the integration mess your last vendor created. Our direct API connection means you can plug in your current dispatch software in under 48 hours, without the re-entry costs a full swap usually creates.",
      next_step: null,
    },
    {
      objection_type: "send_info",
      prospect_line: "I've got another meeting starting soon, just send me some information instead.",
      verdict: "fumbled",
      feedback: "This was a missed opportunity. Instead of simply agreeing and sending the info immediately to keep momentum, the salesperson pushed for a meeting ('could we grab fifteen minutes later this week') which works against the prospect's stated urgency ('meeting starting soon').",
      better_response: "Got it, I'll email you the side-by-side comparison and integration timeline by noon today so you have the concrete data ready for your next meeting.",
      next_step: null,
    },
  ],
  strengths: [
    "Opened with a strong value proposition and a specific price point that established credibility immediately.",
    "Initiatively offered a personalized ROI calculation in response to the budget objection, avoiding a flat refusal.",
    "Asked a discovery question early on about fleet size before pitching.",
  ],
  areas_to_improve: [
    "Frequently avoided giving concrete timelines, letting the prospect fill the gap with worst-case assumptions (e.g. the generic 'usually smooth process' on integration).",
    "Failed to connect specific feature comparisons back to the prospect's stated pain points when addressing the competitor.",
    "Gave up too quickly on delivering requested materials directly, instead complicating the process with a future meeting request.",
  ],
};

function runPreview() {
  scorecardEl.hidden = true;
  scorecardEl.innerHTML = "";
  transcriptEl.innerHTML = "";
  currentProspectLineEl = null;
  pendingObjectionTags = [];
  resetObjectionTracker();

  for (const line of SAMPLE_TRANSCRIPT) {
    appendTranscript(line.speaker, line.text);
    if (line.objection) handleObjectionLogged(line.objection);
  }

  renderScorecard(SAMPLE_SCORECARD);
}

previewBtn.addEventListener("click", runPreview);

// These just navigate to the call screen -- they do NOT start the call.
// The call only actually starts (mic access, WebSocket connect) when the
// green call button inside the call card itself is clicked, so the user
// always sees the idle call card first rather than landing straight into
// an already-active call.
startFromLandingBtn.addEventListener("click", enterApp);
startFromLandingNavBtn.addEventListener("click", enterApp);
backToLandingBtn.addEventListener("click", leaveApp);

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

previewFromLandingBtn.addEventListener("click", () => {
  enterApp();
  runPreview();
});

// "See example" on each objection-type card -- same zero-cost preview.
document.querySelectorAll(".see-example").forEach((el) => {
  el.addEventListener("click", () => {
    enterApp();
    runPreview();
  });
});

// Footer "Start a practice call" link -- same as the landing CTAs, just navigates.
const footerStartLink = document.getElementById("footerStart");
if (footerStartLink) {
  footerStartLink.addEventListener("click", (e) => {
    e.preventDefault();
    enterApp();
  });
}
