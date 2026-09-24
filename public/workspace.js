// The call screen (#app): a four-pane workspace (sections rail, list,
// center, call panel). Owns all UI state and rendering. The audio and
// WebSocket plumbing lives in client.js, which calls the wk.on* hooks below
// as things happen, and which this file calls back into (startCall,
// requestEndCall, setMicMuted, setSpeakerMode, readLevels, abortCall).
//
// Past calls are kept in localStorage only. There is no server-side storage.
(function () {
  "use strict";

  // ------------------------------------------------------------------ data
  var OBJ = {
    price:      { label: "Price",      color: "#c0293d" },
    timing:     { label: "Timing",     color: "#c76a00" },
    competitor: { label: "Competitor", color: "#1d4ed8" },
    send_info:  { label: "Send info",  color: "#0a8a72" },
    other:      { label: "Other",      color: "#666666" }
  };
  var TRACKED = ["price", "timing", "competitor", "send_info"];
  var VERDICT = {
    handled_well:      { label: "Handled well",      color: "#0a8a4a" },
    partially_handled: { label: "Partially handled", color: "#c76a00" },
    fumbled:           { label: "Fumbled",           color: "#c0293d" }
  };
  // Persona details mirror SYSTEM_PROMPTS in server/index.js (kept in sync by hand).
  var SCEN = {
    logistics:  { name: "Logistics",   short: "L", color: "#1d4ed8", role: "VP of Operations",         org: "220-person regional logistics company" },
    saas:       { name: "SaaS",        short: "S", color: "#0a8a72", role: "VP of Revenue Operations", org: "220-person B2B SaaS company" },
    realestate: { name: "Real Estate", short: "R", color: "#c76a00", role: "Managing Broker",          org: "40-agent real estate brokerage" }
  };

  var HISTORY_KEY = "pushback.calls.v1";
  var HISTORY_MAX = 30;
  var END_TIMEOUT_MS = 90000;

  // ---- sample data (the zero-cost "Preview a sample scorecard" path) ----
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

  var SAMPLE_CALL = {
    id: "sample", sample: true, ts: null, scenario: "logistics", duration: 168,
    transcript: SAMPLE_TRANSCRIPT.map(function (l) {
      return { s: l.speaker === "prospect" ? "j" : "y", t: l.text, tags: l.objection ? [l.objection.objection_type] : [] };
    }),
    card: SAMPLE_SCORECARD
  };

  // ------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function mmss(n) { return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0"); }
  function fmtDur(n) { return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0"); }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch (_) { return ""; }
  }
  function scoreColor(n) { return n >= 70 ? "#0a8a4a" : n >= 40 ? "#c76a00" : "#c0293d"; }
  function objInfo(t) { return OBJ[t] || OBJ.other; }
  function verdictInfo(v) { return VERDICT[v] || { label: String(v || "Unrated"), color: "#666666" }; }

  var IC = {
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
    micoff: '<line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M5 10a7 7 0 0 0 10.54 6.07"/><path d="M18.5 10A6.98 6.98 0 0 1 17 14.33"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
    speaker: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
    caption: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    chev: '<polyline points="6 9 12 15 18 9"/>',
    back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    up: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'
  };
  function svg(name, size, cls) {
    return '<svg class="' + (cls || "") + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + IC[name] + "</svg>";
  }
  function fillIcon(size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + IC.phone + "</svg>";
  }

  // ---------------------------------------------------------------- state
  function loadHistory() {
    try {
      var v = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(wk.history.slice(0, HISTORY_MAX))); }
    catch (_) { /* storage full or blocked (private mode): history just won't survive a reload */ }
  }

  var state = {
    tab: "practice", scenario: "logistics", callId: null, q: "", filter: "all",
    captions: true, compact: false, pane: null, showSample: false,
    error: null, notice: null
  };
  var live = null;
  var landingEl, appEl, gridEl, skipLink;

  var wk = { state: state, history: loadHistory() };
  window.wk = wk;

  function getCalls() {
    var list = wk.history.slice();
    if (state.showSample) list.unshift(SAMPLE_CALL);
    return list;
  }
  function callById(id) {
    var list = getCalls();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function selectedCall() { return callById(state.callId) || getCalls()[0] || null; }
  function matches(text) { return !state.q || String(text).toLowerCase().indexOf(state.q.toLowerCase()) !== -1; }
  function callSearchText(c) {
    return SCEN[c.scenario].name + " " + (c.sample ? "sample" : fmtDate(c.ts)) + " " + c.transcript.map(function (l) { return l.t; }).join(" ");
  }
  function overallOf(c) { return c.card && c.card.overall_score != null ? c.card.overall_score : null; }

  // -------------------------------------------------------------- status
  function setPill(kind, text) {
    var dot = $("wkStatusDot"), label = $("wkStatus");
    if (dot) dot.setAttribute("data-state", kind);
    if (label) label.textContent = text;
  }

  // ----------------------------------------------------------- navigation
  var TABS = [
    { id: "practice",    label: "Practice",    icon: "phone" },
    { id: "transcripts", label: "Transcripts", icon: "chat" },
    { id: "scorecards",  label: "Scorecards",  icon: "chart" }
  ];
  function navHTML() {
    return TABS.map(function (t) {
      return '<button class="rail-btn" data-action="tab" data-tab="' + t.id + '"' + (state.tab === t.id ? ' aria-current="page"' : "") + ' aria-label="' + t.label + '">' +
        '<span class="rpill">' + svg(t.icon, 22) + "</span>" + t.label + "</button>";
    }).join("");
  }

  // ------------------------------------------------------------ list pane
  function scoreChip(c) {
    var n = overallOf(c);
    if (!c.card) return '<span class="score-chip" style="background:#c0293d" title="No scorecard">!</span>';
    if (n == null) return '<span class="score-chip" style="background:#666666" title="No objections were raised">n/a</span>';
    return '<span class="score-chip" style="background:' + scoreColor(n) + '">' + n + "</span>";
  }
  function callRow(c, action) {
    var s = SCEN[c.scenario], sel = state.tab !== "practice" && selectedCall() && selectedCall().id === c.id;
    var sub = c.sample ? "Sample call, " + fmtDur(c.duration) : fmtDate(c.ts) + ", " + fmtDur(c.duration);
    return '<button class="row' + (sel ? " selected" : "") + '" data-action="' + action + '" data-id="' + esc(c.id) + '">' +
      '<span class="row-avatar" style="background:' + s.color + '">' + s.short + "</span>" +
      '<span class="row-body"><div class="row-title">' + s.name + (c.sample ? ' <span class="chip-sample">Sample</span>' : "") + '</div><div class="row-sub">' + esc(sub) + "</div></span>" +
      '<span class="row-trail">' + scoreChip(c) + "</span></button>";
  }

  function renderList() {
    var h = "", any = false, busy = !!live;
    if (state.tab === "practice") {
      h += '<div class="list-head">Choose a scenario</div><div class="list-scroll">';
      Object.keys(SCEN).forEach(function (k) {
        var s = SCEN[k];
        if (!matches(s.name + " " + s.role + " " + s.org)) return;
        any = true;
        h += '<button class="row' + (state.scenario === k ? " selected" : "") + '" data-action="pick-scenario" data-id="' + k + '"' + (busy ? " disabled" : "") + ">" +
          '<span class="row-avatar" style="background:' + s.color + '">' + s.short + "</span>" +
          '<span class="row-body"><div class="row-title">' + s.name + '</div><div class="row-sub">' + s.role + ", " + s.org + "</div></span>" +
          (state.scenario === k ? '<span class="row-trail" style="color:var(--accent)">' + svg("check", 18) + "</span>" : "") + "</button>";
      });
      var recent = wk.history.filter(function (c) { return matches(callSearchText(c)); }).slice(0, 5);
      if (recent.length) {
        any = true;
        h += '<div class="list-section">Recent calls</div>';
        recent.forEach(function (c) { h += callRow(c, "open-transcript"); });
      }
      if (!any) h += '<div class="empty-list">No matches for that search.</div>';
      h += "</div>";
    } else {
      var all = getCalls(), cs = all.filter(function (c) { return matches(callSearchText(c)); });
      h += '<div class="list-head"><span>' + (state.tab === "transcripts" ? "All transcripts" : "All scorecards") + "</span>" +
        (state.showSample ? '<button class="link-btn" data-action="hide-sample">Hide sample</button>' : "") + '</div><div class="list-scroll">';
      cs.forEach(function (c) { h += callRow(c, state.tab === "transcripts" ? "open-transcript" : "open-scorecard"); });
      if (!all.length) h += '<div class="empty-list">No calls yet. Finish a practice call and it shows up here, saved on this device.</div>';
      else if (!cs.length) h += '<div class="empty-list">No matches for that search.</div>';
      h += "</div>";
    }
    $("wkList").innerHTML = h;
  }

  // ---------------------------------------------------------- center pane
  function bubble(line, isNew, scenarioKey) {
    var jordan = line.s === "j", sc = SCEN[scenarioKey] || SCEN.logistics;
    var tags = (line.tags || []).map(function (t) {
      return '<span class="obj-badge" style="background:' + objInfo(t).color + '">' + esc(objInfo(t).label.toUpperCase()) + "</span>";
    }).join("");
    return '<div class="msg ' + (jordan ? "jordan" : "you") + (isNew ? " new" : "") + '">' +
      (jordan ? '<span class="msg-avatar" style="background:' + sc.color + '">J</span>' : "") +
      '<div class="bubble">' + esc(line.t) + (tags ? '<div class="bubble-badges">' + tags + "</div>" : "") + "</div></div>";
  }
  function backBtn() { return '<button class="icon-btn back-btn" data-action="back" aria-label="Back">' + svg("back", 20) + "</button>"; }

  function emptyState(icon, title, text, actions, cls) {
    return '<div class="empty-wrap"><div class="empty-card' + (cls ? " " + cls : "") + '"><div class="empty-icon">' + (icon === "spinner" ? '<div class="spinner"></div>' : svg(icon, 30)) + "</div>" +
      "<h2>" + esc(title) + "</h2><p>" + esc(text) + "</p>" + (actions || "") + "</div></div>";
  }
  function noticeBar(text, kind) {
    return '<div class="note-bar' + (kind === "error" ? " error" : "") + '" role="' + (kind === "error" ? "alert" : "status") + '">' + svg(kind === "error" ? "alert" : "info", 16) + "<span>" + esc(text) + "</span></div>";
  }

  function headerFor(c, extra) {
    var s = SCEN[c.scenario], sub = c.sample ? "Sample call, " + fmtDur(c.duration) : fmtDate(c.ts) + ", " + fmtDur(c.duration);
    return '<div class="center-head">' + backBtn() + '<span class="center-title">' + s.name + '</span><span class="center-sub">' + esc(sub) + '</span><span class="spacer"></span>' +
      '<button class="icon-btn" data-action="download" aria-label="Download transcript" title="Download transcript">' + svg("download", 20) + "</button>" +
      (c.sample ? "" : '<button class="icon-btn" data-action="delete-call" aria-label="Delete this call" title="Delete this call">' + svg("trash", 20) + "</button>") + "</div>";
  }

  function renderCenter() {
    var h = "", scr = $("wkScroller"), keep = scr ? scr.scrollTop : 0, wasBottom = scr ? (scr.scrollHeight - scr.scrollTop - scr.clientHeight < 80) : true;
    if (state.tab === "practice") {
      if (live && live.phase !== "ending") {
        var sc = SCEN[live.scenario];
        h += '<div class="center-head">' + backBtn() + '<span class="center-title">Jordan</span><span class="center-sub">' + sc.role + '</span><span class="spacer"></span>' +
          (live.phase === "active" ? '<span class="live-badge"><i></i>Live</span>' : '<span class="center-sub">Connecting</span>') + "</div>";
        if (state.captions) {
          h += '<div class="center-scroll" id="wkScroller"><div class="thread">';
          if (!live.lines.length && !live.typing) h += '<div class="sys-note">' + (live.phase === "active" ? "Jordan is about to speak." : "Connecting to Jordan.") + "</div>";
          live.lines.forEach(function (l, i) { h += bubble(l, i === live.lines.length - 1 && live.fresh, live.scenario); });
          if (live.typing) h += '<div class="msg jordan"><span class="msg-avatar" style="background:' + sc.color + '">J</span><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>';
          h += "</div></div>";
        } else {
          h += emptyState("caption", "Captions are hidden", "Jordan is still on the line. Turn captions back on from the call controls to follow along.");
        }
        var muted = window.isMicMuted && window.isMicMuted();
        h += '<div class="composer' + (muted ? " muted" : "") + '"><span class="wave"><i></i><i></i><i></i><i></i><i></i></span><span>' +
          (muted ? "Your mic is muted. Jordan cannot hear you." : "Listening. Speak naturally, Jordan replies when you pause.") + "</span></div>";
      } else if (live) {
        h += '<div class="center-head">' + backBtn() + '<span class="center-title">Call ended</span></div>' +
          emptyState("spinner", "Scoring your call", "Reviewing each objection and how you handled it. This can take a few seconds.");
      } else {
        h += '<div class="center-head">' + backBtn() + '<span class="center-title">Practice</span></div>' +
          (state.notice ? '<div class="notice-wrap">' + noticeBar(state.notice) + "</div>" : "") +
          emptyState("phone", "Ready when you are", "Pick a scenario, start the call, and pitch out loud. Jordan pushes back like a real buyer, then you get a scored breakdown.",
            '<div class="tag-row">' + Object.keys(OBJ).filter(function (k) { return k !== "other"; }).map(function (k) { return '<span class="tag"><i style="background:' + OBJ[k].color + '"></i>' + OBJ[k].label + "</span>"; }).join("") + "</div>" +
            '<p class="fine">Jordan may raise any of these.</p><button class="link-btn" data-action="preview">Preview a sample scorecard</button>');
      }
    } else {
      var c = selectedCall();
      if (!c) {
        h += '<div class="center-head">' + backBtn() + '<span class="center-title">' + (state.tab === "transcripts" ? "Transcripts" : "Scorecards") + "</span></div>" +
          emptyState(state.tab === "transcripts" ? "chat" : "chart", "Nothing here yet", "Your finished calls are saved on this device and show up here with the full transcript and scorecard.",
            '<div class="empty-actions"><button class="btn-primary" data-action="goto-practice">Start a practice call</button><button class="link-btn" data-action="preview">Preview a sample scorecard</button></div>');
      } else if (state.tab === "transcripts") {
        h += headerFor(c) + '<div class="center-scroll"><div class="thread">' + (c.transcript.length ? c.transcript.map(function (l) { return bubble(l, false, c.scenario); }).join("") : '<div class="sys-note">Nothing was said on this call.</div>') + "</div></div>";
      } else if (!c.card) {
        h += headerFor(c) + emptyState("alert", "Scorecard not available", c.error || "The scorecard could not be generated for this call.",
          '<p class="fine">Your transcript was saved, so nothing is lost.</p><div class="empty-actions"><button class="btn-primary" data-action="goto-transcript" data-id="' + esc(c.id) + '">View transcript</button><button class="link-btn" data-action="download">Download transcript</button></div>', "is-error");
      } else {
        h += headerFor(c) + '<div class="center-scroll">' + scorecardHTML(c) + "</div>";
      }
    }
    $("wkMain").innerHTML = h;
    var s2 = $("wkScroller");
    if (s2) s2.scrollTop = wasBottom ? s2.scrollHeight : keep;
  }

  function scorecardHTML(c) {
    var k = c.card, ov = k.overall_score, cats = k.categories || {}, objs = k.objections || [];
    var counts = { all: objs.length, handled_well: 0, partially_handled: 0, fumbled: 0 };
    objs.forEach(function (o) { if (counts[o.verdict] != null) counts[o.verdict]++; });
    function metric(label, v) {
      if (v == null) return '<div class="metric"><div class="mlabel">' + label + '</div><div class="mnum" style="color:var(--text-gray)">n/a</div><div class="bar"></div></div>';
      return '<div class="metric"><div class="mlabel">' + label + '</div><div class="mnum" style="color:' + scoreColor(v) + '">' + v + '%</div><div class="bar"><i style="width:' + v + "%;background:" + scoreColor(v) + '"></i></div></div>';
    }
    var C = 2 * Math.PI * 34;
    var gauge = ov == null
      ? '<div class="metric gauge-card"><div class="mlabel">Overall</div><div class="mnum" style="color:var(--text-gray)">n/a</div><div class="fine-left">No objections were raised, so there is nothing to score.</div></div>'
      : '<div class="metric gauge-card"><div class="mlabel">Overall</div><div class="gauge"><svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="34" fill="none" stroke="var(--track)" stroke-width="8"/>' +
        '<circle cx="40" cy="40" r="34" fill="none" stroke="' + scoreColor(ov) + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + (ov / 100 * C).toFixed(1) + " " + C.toFixed(1) + '" transform="rotate(-90 40 40)"/></svg>' +
        '<div class="mnum" style="color:' + scoreColor(ov) + '">' + ov + "</div></div></div>";
    var h = '<div class="sc">' + (c.sample ? noticeBar("This is a sample scorecard, not from a real call.") : "") +
      '<p class="sc-summary">' + esc(k.overall_summary || "") + "</p>" +
      '<div class="metrics">' + gauge + metric("Objections", cats.objection_resolution) + metric("Specificity", cats.response_specificity) + metric("Discovery", cats.discovery) + "</div>";
    if (objs.length) {
      h += '<div class="filters" role="group" aria-label="Filter objections">' +
        [["all", "All"], ["handled_well", "Handled well"], ["partially_handled", "Partial"], ["fumbled", "Fumbled"]].map(function (f) {
          return '<button class="filter' + (state.filter === f[0] ? " active" : "") + '" data-action="filter" data-f="' + f[0] + '" aria-pressed="' + (state.filter === f[0]) + '">' + f[1] + "<span>" + counts[f[0]] + "</span></button>";
        }).join("") + "</div>";
    }
    h += objs.map(function (o) {
      var v = verdictInfo(o.verdict), t = objInfo(o.objection_type);
      var hide = state.filter !== "all" && state.filter !== o.verdict;
      return '<details class="obj" data-verdict="' + esc(o.verdict) + '"' + (hide ? " hidden" : "") + "><summary>" +
        '<span class="pill-badge" style="background:' + t.color + '">' + esc(t.label) + '</span><span class="pill-badge" style="background:' + v.color + '">' + esc(v.label) + "</span>" +
        '<span class="quote">"' + esc(o.prospect_line) + '"</span><span class="chev">' + svg("chev", 16) + "</span></summary>" +
        '<div class="obj-body"><p>' + esc(o.feedback) + "</p>" +
        (o.better_response ? '<div class="try"><div class="lbl">' + svg("chat", 13) + 'Try this instead</div><div class="txt">"' + esc(o.better_response) + '"</div>' +
          (o.next_step ? '<div class="next">' + svg("arrow", 13) + "<span>" + esc(o.next_step) + "</span></div>" : "") + "</div>" : "") +
        "</div></details>";
    }).join("");
    var strengths = k.strengths || [], improve = k.areas_to_improve || [];
    if (strengths.length || improve.length) {
      h += '<div class="two-col">' +
        (strengths.length ? '<div class="list-block good"><h3>Strengths</h3><ul>' + strengths.map(function (s) { return "<li>" + svg("check", 16) + "<span>" + esc(s) + "</span></li>"; }).join("") + "</ul></div>" : "") +
        (improve.length ? '<div class="list-block improve"><h3>Areas to improve</h3><ul>' + improve.map(function (s) { return "<li>" + svg("up", 16) + "<span>" + esc(s) + "</span></li>"; }).join("") + "</ul></div>" : "") + "</div>";
    }
    return h + "</div>";
  }

  // ----------------------------------------------------------- call panel
  function trackerHTML(raised) {
    return '<div class="tracker"><div class="tracker-title">Objections raised</div><div class="tracker-grid">' +
      TRACKED.map(function (k) {
        return '<div class="tk' + (raised[k] ? " on" : "") + '" data-tk="' + k + '"><i style="background:' + OBJ[k].color + '"></i>' + OBJ[k].label + svg("check", 14) + "</div>";
      }).join("") + "</div></div>";
  }
  function alertHTML() {
    return state.error ? '<div class="alert" role="alert">' + svg("alert", 18) + "<span>" + esc(state.error) + "</span></div>" : "";
  }
  function lastCallCard() {
    var c = wk.history[0];
    if (!c) return "";
    var s = SCEN[c.scenario], line = "";
    if (c.card && c.card.objections) {
      var worst = null;
      c.card.objections.forEach(function (o) {
        if (o.verdict === "fumbled" && !worst) worst = o;
      });
      if (!worst) c.card.objections.forEach(function (o) { if (o.verdict === "partially_handled" && !worst) worst = o; });
      if (worst) line = "Weakest: " + objInfo(worst.objection_type).label;
    } else if (!c.card) line = "Scorecard was not available";
    return '<div class="field-label">Your last call</div><button class="last-call" data-action="open-scorecard" data-id="' + esc(c.id) + '">' +
      '<span class="row-avatar" style="background:' + s.color + '">' + s.short + '</span><span class="row-body"><div class="row-title">' + s.name + '</div><div class="row-sub">' + esc(line || fmtDate(c.ts)) + "</div></span>" +
      '<span class="row-trail">' + scoreChip(c) + "</span></button>";
  }

  function renderPanel() {
    var h = "", s = SCEN[live ? live.scenario : state.scenario], muted = !!(window.isMicMuted && window.isMicMuted()), spk = !!(window.isSpeakerOn && window.isSpeakerOn());
    if (live && live.phase !== "ending") {
      h = alertHTML() + '<div class="call-active"><div class="ring" id="wkRing"><span class="row-avatar" style="background:' + s.color + '">J</span></div>' +
        '<div class="call-name">Jordan</div><div class="call-role">' + s.role + "<br>" + s.org + '</div><div class="call-timer" id="wkTimer">' + mmss(live.secs || 0) + "</div>" +
        '<div class="status-line"><i class="conn-dot"></i><span id="wkCallStatus">Connecting</span></div>' +
        '<div class="viz" id="wkViz" data-turn="idle" aria-hidden="true">' + new Array(33).join("<i></i>") + "</div>" +
        trackerHTML(live.raised) +
        '<div class="ctrl-row">' +
        '<button class="ctrl' + (muted ? " on" : "") + '" data-action="mute" aria-pressed="' + muted + '"><b>' + svg("mic", 22, "i-main") + svg("micoff", 22, "i-alt") + "</b>Mute</button>" +
        '<button class="ctrl' + (spk ? " on" : "") + '" data-action="speaker" aria-pressed="' + spk + '" title="Normal is quieter like an earpiece. Speaker is full volume."><b>' + svg("phone", 22, "i-main") + svg("speaker", 22, "i-alt") + "</b>" + (spk ? "Speaker" : "Normal") + "</button>" +
        '<button class="ctrl' + (state.captions ? " on" : "") + '" data-action="captions" aria-pressed="' + state.captions + '"><b>' + svg("caption", 22) + "</b>Captions</button></div></div>" +
        '<div class="end-wrap"><button class="end-btn" data-action="end" aria-label="End call">' + fillIcon(26) + "</button></div>";
    } else if (live) {
      h = '<div class="working"><div class="spinner"></div><div>Call ended</div><div class="fine">Generating your scorecard</div></div>';
    } else {
      h = '<div class="panel-head"><span class="cap">Calling</span><b>Jordan, ' + s.role + '</b></div><div class="panel-scroll">' + alertHTML() +
        '<div class="field-label" style="margin-top:0">Scenario</div>' +
        '<div class="seg" role="radiogroup" aria-label="Scenario">' + Object.keys(SCEN).map(function (k) {
          return '<button role="radio" aria-checked="' + (state.scenario === k) + '" data-action="pick-scenario" data-id="' + k + '">' + SCEN[k].name + "</button>";
        }).join("") + "</div>" +
        '<div class="prospect"><span class="row-avatar" style="background:' + s.color + '">J</span><div><b>Jordan Reyes</b><span>' + s.role + "<br>" + s.org + "</span></div></div>" +
        '<div class="field-label">Call settings</div>' +
        '<div class="setting"><div>Jordan\'s volume<small>Normal is quieter like an earpiece</small></div><div class="mini-seg" role="radiogroup" aria-label="Volume mode">' +
        '<button role="radio" aria-checked="' + !spk + '" data-action="set-speaker" data-v="0">Normal</button><button role="radio" aria-checked="' + spk + '" data-action="set-speaker" data-v="1">Speaker</button></div></div>' +
        '<div class="setting"><div>Live captions<small>Show the transcript during the call</small></div><button class="switch" role="switch" aria-checked="' + state.captions + '" aria-label="Live captions" data-action="captions"></button></div>' +
        lastCallCard() + "</div>" +
        '<div class="panel-foot"><button class="start-btn" data-action="start">' + fillIcon(20) + "Start practice call</button></div>";
    }
    $("wkPanel").innerHTML = h;
    if (live) applyTurn();
  }

  function applyPane() {
    var pane = state.pane || (state.tab === "practice" ? "call" : "list");
    gridEl.setAttribute("data-pane", pane);
    gridEl.classList.toggle("compact", state.compact);
  }
  function renderAll() {
    var nav = navHTML();
    $("wkRail").innerHTML = nav; $("wkBottomNav").innerHTML = nav;
    renderList(); renderCenter(); renderPanel(); applyPane();
  }

  // ---------------------------------------------------- live call display
  function turnText() {
    if (!live) return "";
    if (live.phase === "connecting") return "Connecting";
    if (live.turn === "jordan") return live.thinking ? "Jordan is thinking" : "Jordan is speaking";
    if (live.turn === "you") return window.isMicMuted && window.isMicMuted() ? "Your mic is muted" : "Listening to you";
    return "Connected";
  }
  function applyTurn() {
    if (!live) return;
    var t = live.turn || "idle", viz = $("wkViz"), ring = $("wkRing"), st = $("wkCallStatus");
    var muted = !!(window.isMicMuted && window.isMicMuted());
    if (viz) viz.setAttribute("data-turn", t);
    if (ring) { ring.classList.toggle("speaking", t === "jordan" && !live.thinking); ring.classList.toggle("listening", t === "you" && !muted); }
    if (st) st.textContent = turnText();
  }
  function setTurn(t) { if (live) { live.turn = t; applyTurn(); } }

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Bars follow the real audio: Jordan's playback while he speaks, your mic
  // while it is your turn. Falls back to a gentle idle shimmer when no
  // analyser data is available (or the mic is muted).
  function vizLoop(ts) {
    if (!live) return;
    var viz = $("wkViz");
    if (viz) {
      var bars = viz.children, n = bars.length, t = live.turn || "idle", muted = !!(window.isMicMuted && window.isMicMuted());
      var data = null;
      if (!reduceMotion) {
        if (t === "jordan" && !live.thinking) data = window.readLevels && window.readLevels("jordan");
        else if (t === "you" && !muted) data = window.readLevels && window.readLevels("you");
      }
      live.vh = live.vh || [];
      for (var i = 0; i < n; i++) {
        var dist = Math.abs(i - (n - 1) / 2) / (n / 2), target;
        if (data) {
          var bin = Math.min(data.length - 1, Math.floor(dist * Math.min(data.length, 24)));
          target = 0.08 + Math.min(1, Math.pow(data[bin] / 255, 0.85) * (t === "you" ? 1.5 : 1.1)) * 0.92;
        } else {
          target = reduceMotion ? 0.08 : 0.08 + 0.05 * (Math.sin(ts / 420 + i * 0.5) + 1) * (1 - dist);
        }
        var cur = live.vh[i] == null ? 0.08 : live.vh[i];
        live.vh[i] = cur + (target - cur) * 0.3;
        bars[i].style.height = Math.max(5, Math.round(live.vh[i] * 52)) + "px";
      }
    }
    live.raf = requestAnimationFrame(vizLoop);
  }
  function startTick() {
    if (live.tick) return;
    live.tick = setInterval(function () {
      if (!live) return;
      live.secs = live.startedAt ? Math.floor((Date.now() - live.startedAt) / 1000) : 0;
      var t = $("wkTimer"); if (t) t.textContent = mmss(live.secs);
    }, 1000);
  }
  function stopLoops() {
    if (!live) return;
    if (live.tick) clearInterval(live.tick);
    if (live.raf) cancelAnimationFrame(live.raf);
    if (live.turnTimer) clearTimeout(live.turnTimer);
    if (live.endTimer) clearTimeout(live.endTimer);
  }

  // ------------------------------------------------- hooks called by client.js
  wk.onCallStarting = function () {
    state.error = null; state.notice = null;
    state.tab = "practice"; state.pane = "call";
    live = { phase: "connecting", scenario: state.scenario, lines: [], raised: {}, pendingTags: [], typing: false, thinking: false, turn: "idle", startedAt: null, secs: 0, fresh: false, finished: false };
    setPill("busy", "Connecting");
    renderAll();
    live.raf = requestAnimationFrame(vizLoop);
  };
  wk.onMicError = function (err) {
    var name = err && err.name;
    state.error = name === "NotAllowedError" || name === "SecurityError"
      ? "Microphone access was blocked. Allow the mic for this site in your browser settings, then try again."
      : name === "NotFoundError" ? "No microphone was found. Plug one in or check your system sound settings, then try again."
      : "Could not start the microphone" + (err && err.message ? " (" + err.message + ")" : "") + ". Check your browser settings and try again.";
    stopLoops(); live = null;
    setPill("error", "Mic unavailable");
    renderAll();
  };
  wk.onStatus = function (msg) {
    if (!live) return;
    if (msg === "connected") {
      live.phase = "active"; live.startedAt = Date.now(); startTick();
      setPill("live", "Live"); renderCenter(); applyTurn();
    } else if (/^error:|connection error|agent connection error/i.test(msg)) {
      state.error = "The call hit a problem (" + msg.replace(/^error:\s*/i, "") + "). End the call and try again.";
      setPill("error", "Problem");
      renderPanel();
    } else if (/ending call|generating scorecard/i.test(msg)) {
      setPill("busy", "Ending call");
    }
  };
  wk.onTranscript = function (speaker, text) {
    if (!live) return;
    var line = { s: speaker === "you" ? "y" : "j", t: text, tags: [] };
    live.typing = false;
    if (line.s === "j") {
      live.thinking = false;
      if (live.pendingTags.length) { line.tags = live.pendingTags.slice(); live.pendingTags = []; }
    } else if (live.turn === "jordan") {
      live.turn = "you";
    }
    live.lines.push(line); live.fresh = true;
    renderCenter(); applyTurn();
  };
  wk.onReplyStarted = function () {
    if (!live) return;
    live.typing = true; live.thinking = true; live.turn = "jordan";
    renderCenter(); applyTurn();
  };
  wk.onJordanAudio = function (msRemaining) {
    if (!live) return;
    live.thinking = false; live.turn = "jordan";
    if (live.turnTimer) clearTimeout(live.turnTimer);
    live.turnTimer = setTimeout(function () { if (live && live.turn === "jordan") setTurn("you"); }, Math.max(0, msRemaining) + 250);
    applyTurn();
  };
  wk.onBargeIn = function () {
    if (!live) return;
    live.typing = false; live.thinking = false;
    if (live.turnTimer) clearTimeout(live.turnTimer);
    live.turn = "you";
    renderCenter(); applyTurn();
  };
  wk.onObjection = function (o) {
    if (!live || !o) return;
    var type = o.objection_type || "other";
    live.raised[type] = true;
    var last = live.lines[live.lines.length - 1];
    if (last && last.s === "j" && last.tags.indexOf(type) === -1) last.tags.push(type);
    else if (!last || last.s !== "j") live.pendingTags.push(type);
    var el = document.querySelector('#wkPanel .tk[data-tk="' + type + '"]'); if (el) el.classList.add("on");
    renderCenter();
  };
  wk.onEndRequested = function () {
    if (!live || live.phase === "ending") return;
    live.phase = "ending"; live.typing = false;
    setPill("busy", "Ending call");
    live.endTimer = setTimeout(function () { finishCall(null, "The scorecard took too long to arrive. Your transcript was saved."); }, END_TIMEOUT_MS);
    renderAll();
  };
  wk.onScorecard = function (card) { finishCall(card, null); };
  wk.onScorecardError = function (message) {
    finishCall(null, "We could not generate the scorecard for this call" + (message ? " (" + message + ")" : "") + ".");
  };
  wk.onWsClosed = function () {
    if (!live || live.finished) return;
    if (live.phase === "ending") finishCall(null, "The connection closed before the scorecard arrived.");
    else finishCall(null, "The call disconnected unexpectedly.");
  };

  function finishCall(card, errorMessage) {
    if (!live || live.finished) return;
    live.finished = true;
    stopLoops();
    var rec = null;
    if (live.lines.length || card) {
      rec = {
        id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: Date.now(), scenario: live.scenario, duration: live.secs || 0,
        transcript: live.lines.map(function (l) { return { s: l.s, t: l.t, tags: l.tags }; }),
        card: card || null, error: card ? null : errorMessage
      };
      wk.history.unshift(rec); wk.history = wk.history.slice(0, HISTORY_MAX); saveHistory();
    }
    live = null;
    setPill("idle", "Ready");
    if (rec) { state.tab = "scorecards"; state.callId = rec.id; state.filter = "all"; state.pane = "main"; }
    else { state.tab = "practice"; state.pane = "call"; state.notice = "The call ended before anything was said, so nothing was saved."; }
    renderAll();
  }

  // ---------------------------------------------------------- entry / exit
  wk.enter = function () {
    var sel = $("industrySelect");
    if (!live && sel && SCEN[sel.value]) state.scenario = sel.value;
    landingEl.hidden = true; appEl.hidden = false;
    document.body.classList.add("in-app");
    if (skipLink) skipLink.setAttribute("href", "#wkMain");
    window.scrollTo(0, 0);
    state.pane = null;
    renderAll();
    $("wkMain").focus({ preventScroll: true });
  };
  wk.leave = function () {
    if (live) {
      if (window.abortCall) window.abortCall();
      stopLoops(); live = null; setPill("idle", "Ready");
    }
    state.error = null; state.notice = null;
    appEl.hidden = true; landingEl.hidden = false;
    document.body.classList.remove("in-app");
    if (skipLink) skipLink.setAttribute("href", "#main-content");
  };
  wk.runPreview = function () {
    wk.enter();
    state.showSample = true; state.tab = "scorecards"; state.callId = "sample"; state.filter = "all"; state.pane = "main";
    renderAll();
  };

  // ------------------------------------------------------------- downloads
  function downloadCall() {
    var c = selectedCall(); if (!c) return;
    var L = [], s = SCEN[c.scenario];
    L.push("Pushback call log" + (c.sample ? " (sample data)" : ""));
    if (!c.sample) L.push("Date: " + new Date(c.ts).toLocaleString());
    L.push("Scenario: " + s.name); L.push("Duration: " + fmtDur(c.duration)); L.push("");
    L.push("=== Transcript ===");
    c.transcript.forEach(function (l) { L.push((l.s === "j" ? "Jordan" : "You") + ": " + l.t + (l.tags && l.tags.length ? "  [" + l.tags.map(function (t) { return objInfo(t).label; }).join(", ") + "]" : "")); });
    var k = c.card;
    if (k) {
      var objs = k.objections || [];
      if (objs.length) {
        L.push(""); L.push("=== Objections ===");
        objs.forEach(function (o, i) {
          L.push((i + 1) + ". [" + objInfo(o.objection_type).label + "] (" + verdictInfo(o.verdict).label + ")");
          L.push("   Jordan said: \"" + o.prospect_line + "\"");
          L.push("   Feedback: " + o.feedback);
          if (o.better_response) L.push("   Try instead: \"" + o.better_response + "\"");
          if (o.next_step) L.push("   Next step: " + o.next_step);
        });
      }
      L.push(""); L.push("=== Scorecard ===");
      L.push(k.overall_score != null ? "Overall score: " + k.overall_score + "/100" : "Overall score: not scored (no objections raised)");
      if (k.overall_summary) L.push(k.overall_summary);
      if ((k.strengths || []).length) { L.push(""); L.push("Strengths:"); k.strengths.forEach(function (x) { L.push("- " + x); }); }
      if ((k.areas_to_improve || []).length) { L.push(""); L.push("Areas to improve:"); k.areas_to_improve.forEach(function (x) { L.push("- " + x); }); }
    } else {
      L.push(""); L.push("Scorecard: not available" + (c.error ? " (" + c.error + ")" : ""));
    }
    var a = document.createElement("a"), url = URL.createObjectURL(new Blob([L.join("\n")], { type: "text/plain" }));
    a.href = url; a.download = "pushback-call-" + (c.sample ? "sample" : new Date(c.ts).toISOString().replace(/[:.]/g, "-")) + ".txt";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------------------------------------------------------------- events
  function onClick(e) {
    var el = e.target.closest("[data-action]");
    if (!el || !appEl.contains(el)) return;
    var a = el.getAttribute("data-action");
    switch (a) {
      case "tab":
        state.tab = el.getAttribute("data-tab"); state.pane = null; state.q = ""; $("wkSearch").value = "";
        if (live && state.tab === "practice") state.pane = "call";
        renderAll(); break;
      case "pick-scenario":
        if (live) break;
        state.scenario = el.getAttribute("data-id");
        var sel = $("industrySelect"); if (sel) sel.value = state.scenario;
        renderList(); renderPanel(); break;
      case "set-speaker": window.setSpeakerMode(el.getAttribute("data-v") === "1"); renderPanel(); break;
      case "start": window.startCall(); break;
      case "end": window.requestEndCall(); break;
      case "mute": window.setMicMuted(!window.isMicMuted()); renderPanel(); renderCenter(); applyTurn(); break;
      case "speaker": window.setSpeakerMode(!window.isSpeakerOn()); renderPanel(); break;
      case "captions":
        if (live && window.matchMedia("(max-width: 1099px)").matches) { state.captions = true; state.pane = "main"; applyPane(); renderCenter(); }
        else { state.captions = !state.captions; renderPanel(); renderCenter(); }
        break;
      case "open-transcript": state.tab = "transcripts"; state.callId = el.getAttribute("data-id"); state.pane = "main"; renderAll(); break;
      case "open-scorecard": state.tab = "scorecards"; state.callId = el.getAttribute("data-id"); state.filter = "all"; state.pane = "main"; renderAll(); break;
      case "goto-transcript": state.tab = "transcripts"; state.callId = el.getAttribute("data-id") || state.callId; state.pane = "main"; renderAll(); break;
      case "goto-practice": state.tab = "practice"; state.pane = "call"; renderAll(); break;
      case "filter":
        state.filter = el.getAttribute("data-f");
        document.querySelectorAll("#wkMain .filter").forEach(function (b) {
          var on = b.getAttribute("data-f") === state.filter; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
        });
        document.querySelectorAll("#wkMain .obj").forEach(function (d) { d.hidden = state.filter !== "all" && d.getAttribute("data-verdict") !== state.filter; });
        break;
      case "back": state.pane = state.tab === "practice" ? "call" : "list"; applyPane(); break;
      case "download": downloadCall(); break;
      case "delete-call":
        var c = selectedCall();
        if (c && !c.sample && window.confirm("Delete this call and its scorecard from this device?")) {
          wk.history = wk.history.filter(function (x) { return x.id !== c.id; }); saveHistory();
          state.callId = null; state.pane = "list"; renderAll();
        }
        break;
      case "hide-sample": state.showSample = false; if (state.callId === "sample") state.callId = null; renderAll(); break;
      case "preview": wk.runPreview(); break;
      case "toggle-compact": state.compact = !state.compact; applyPane(); break;
      case "toggle-theme": window.toggleTheme(); break;
      case "home": wk.leave(); break;
    }
  }

  // ------------------------------------------------------------------ init
  landingEl = $("landing"); appEl = $("app"); gridEl = $("wk");
  skipLink = document.querySelector(".skip-link");
  appEl.addEventListener("click", onClick);
  $("wkSearch").addEventListener("input", function (e) { state.q = e.target.value; renderList(); });
  if (state.tab === "practice") { /* first render happens on enter() */ }
})();
