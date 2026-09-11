// Minimal relay backend for the sales-objection practice partner.
//
// Browser  <--ws, raw PCM16 binary frames-->  this server  <--wss, Authorization header-->  AssemblyAI Voice Agent
//
// This server is the only thing that holds the AssemblyAI API key. The browser
// never talks to agents.assemblyai.com directly, so no temporary-token dance
// is needed (that flow is only for browser-only apps that can't set WS headers).

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateScorecard } from "./scorecard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!API_KEY) {
  console.error(
    "Missing ASSEMBLYAI_API_KEY. Set it in your environment before starting the server, e.g.:\n" +
      "  export ASSEMBLYAI_API_KEY=your_key_here\n" +
      "  npm start"
  );
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const AGENT_WS_URL = "wss://agents.assemblyai.com/v1/ws";
const AUDIO_SAMPLE_RATE = 24000; // PCM16 mono, per AssemblyAI's audio-format docs

// --- Sales-prospect persona -------------------------------------------------
// Identity-first + permission language, per AssemblyAI's own prompting guide,
// rather than a flat list of behaviors.
const SYSTEM_PROMPT = `You are Jordan Reyes, VP of Operations at a 220-person regional logistics company. You are on a live sales call with someone pitching you their product. You are not a demo bot -- you are a real, busy buyer in the middle of your day.

Your situation, which shapes how you react:
- Budget for new vendor tools this quarter is tight and needs VP-level sign-off.
- You were burned before by a vendor who overpromised on integration timelines.
- You are also currently evaluating a competing product from a company called "RouteworksAI".
- You have maybe ten minutes before your next meeting.

Personality:
- You have real opinions and can be a little dry when someone wastes your time or talks in vague marketing language.
- You are skeptical by default, not hostile. You will engage if the person is specific, credible, and respects your time.
- Never say things like "Great question!", "That's an interesting point," or "Want me to walk you through that?" Talk like a real person on a phone call, not a chatbot.
- Keep replies short -- one to three sentences, like an actual phone conversation. Do not monologue.

How you actually talk (this matters a lot -- you are being read out loud, not printed):
- Always use contractions: I'm, you're, don't, can't, that's, we've. Never "I am" or "do not."
- Write the way people actually speak, not the way people write. Short, sometimes incomplete sentences are good. Real sentences trail off or restart sometimes.
- It's fine to open a line with "Look," "Honestly," "I mean," "Yeah, so," or "Okay, but" when it fits naturally -- don't force it into every line.
- Vary your rhythm. Not every reply is the same length or shape. Sometimes one clipped sentence is the whole response.
- Do not sound polished or rehearsed. A little impatience, a half-interrupted thought, or a blunt one-liner reads as more human than a complete, well-formed paragraph.

How to run the call:
- Raise real objections naturally over the course of the conversation: price and budget approval, why switch now versus later, "just send me some information" as a way to end the call, and the competitor RouteworksAI.
- Do not raise every objection in your first line. Let the conversation breathe -- react to what the salesperson actually says.
- If they respond to an objection with something specific and concrete, ease up a little and let the conversation move forward.
- If they're vague, pushy, or ignore what you said, stay skeptical or push back harder.
- You are not trying to be won over easily. Your job on this call is to be a realistic, moderately difficult prospect so the salesperson can practice, not to make the sale easy.

Logging (does not change how you talk, just happens alongside it):
- Call the log_objection tool the moment you raise or reference one of your real objections: price/budget, timing, wanting them to just send information instead of continuing the call, or the competitor RouteworksAI.
- Also call it, rarely, for other genuine pushback or reluctance to move forward that doesn't fit those four categories -- e.g. general distrust, wanting to think it over, needing someone else's sign-off -- tagged as "other".
- Do NOT call the tool for confusion, mishearing something, or asking a clarifying question -- e.g. "what do you mean," "what exactly is that," "can you say that again," or "what do you say." Those are a normal part of any conversation, not objections, and should never be logged, not even as "other."
- This is a background action. Never mention the tool, logging, or anything technical out loud -- you are just a person on a phone call.`;

const GREETING =
  "Hey, this is Jordan -- I've got about ten minutes before my next meeting, so let's make it count. What is this about?";

// Pinned explicitly so the sound is consistent instead of whatever the
// unset default happens to be. Full list per AssemblyAI's voices docs:
// American: alba, eve, george, jane, jean, mary, michael
// British: anna, charles, paul, vera
// Other: giovanni (IT), lola (ES), juergen (DE), rafael (PT), estelle (FR)
// No emotion/expressiveness knob is exposed beyond picking a voice ID --
// swap this if a different one sounds more natural to you.
const VOICE_ID = "michael";

// --- Objection-logging tool ---------------------------------------------
// Client-side tool: the agent emits tool.call, we log it and reply with
// tool.result. Confirmed against AssemblyAI's AsyncAPI spec
// (api-spec/voice-agent-api.yaml): ToolDefinition requires "type": "function"
// (this was missing and caused a session.error/invalid_value on session.update),
// and the wire shape for both tool.call and tool.result is flat
// (call_id/name/arguments, call_id/result) -- no nested "tool" object.
const TOOLS = [
  {
    type: "function",
    name: "log_objection",
    description:
      "Call this immediately whenever you (Jordan) raise or reference a real sales objection in the conversation -- price or budget, timing/why switch now, wanting them to just send information instead of continuing the call, the competitor RouteworksAI, or other genuine pushback/reluctance to move forward. Call it every single time you do this, right as you say it. Do NOT call this for confusion, mishearing something, or clarifying questions like 'what do you mean' or 'can you repeat that' -- those are not objections. This never changes how you speak -- it's a silent background action.",
    parameters: {
      type: "object",
      properties: {
        objection_type: {
          type: "string",
          enum: ["price", "timing", "send_info", "competitor", "other"],
          description:
            "Pick exactly one. 'price' = cost, budget, ROI, or approval-to-spend concerns. " +
            "'timing' = anything about when/how fast -- why now vs. later, onboarding or " +
            "implementation schedule, being too busy right now, wanting to wait. " +
            "'send_info' = asking them to just send materials/a one-pager instead of continuing " +
            "the call or deciding now. 'competitor' = mentioning another vendor, especially " +
            "RouteworksAI, or comparing options. 'other' = genuine pushback or reluctance to " +
            "move forward that doesn't fit the above -- e.g. general distrust, wanting to think " +
            "it over, needing someone else's approval. Use this rarely. Never use 'other' -- or " +
            "call this tool at all -- for confusion, mishearing, or clarifying questions (e.g. " +
            "'what do you mean,' 'what exactly is that,' asking them to repeat themselves). " +
            "Those are not objections.",
        },
        your_line: {
          type: "string",
          description: "A short paraphrase of what you just said to raise this objection.",
        },
      },
      required: ["objection_type", "your_line"],
    },
  },
];

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/call" });

wss.on("connection", (browserWs) => {
  console.log("[browser] connected");

  let agentWs = null;
  let agentReady = false;
  // Set once the browser explicitly asks to end the call, so the close
  // handlers know a scorecard is expected and shouldn't race to tear down
  // the browser connection early.
  let endingGracefully = false;
  // Buffer any browser audio frames that arrive before session.ready so we
  // don't silently drop the first ~100-200ms of speech.
  const pendingAudio = [];
  // Objections tagged by the log_objection tool during this call, and the
  // full spoken transcript -- both feed the post-call scorecard.
  const objectionLog = [];
  const transcriptLog = [];

  function sendToAgent(obj) {
    if (agentWs && agentWs.readyState === WebSocket.OPEN) {
      agentWs.send(JSON.stringify(obj));
    }
  }

  function sendToBrowser(obj) {
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify(obj));
    }
  }

  agentWs = new WebSocket(AGENT_WS_URL, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  agentWs.on("open", () => {
    console.log("[agent] connected, sending session.update");
    sendToAgent({
      type: "session.update",
      session: {
        system_prompt: SYSTEM_PROMPT,
        greeting: GREETING,
        input: {
          format: { encoding: "audio/pcm" },
        },
        output: {
          voice: VOICE_ID,
          format: { encoding: "audio/pcm" },
          volume: 100,
        },
        tools: TOOLS,
      },
    });
  });

  agentWs.on("message", (data, isBinary) => {
    if (isBinary) return; // AssemblyAI sends JSON text frames, not binary

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error("[agent] failed to parse message:", err);
      return;
    }

    switch (msg.type) {
      case "session.ready":
        agentReady = true;
        console.log("[agent] session.ready", msg.session_id);
        sendToBrowser({ type: "status", message: "connected", sessionId: msg.session_id });
        // Flush any audio the browser sent before we were ready.
        for (const chunk of pendingAudio) {
          sendToAgent({ type: "input.audio", audio: chunk });
        }
        pendingAudio.length = 0;
        break;

      case "reply.audio":
        // Forward as a raw binary frame to the browser (decode base64 -> Buffer).
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(Buffer.from(msg.data, "base64"));
        }
        break;

      case "input.speech.started":
        // Prospect should stop talking immediately (barge-in) -- tell the
        // browser to flush its playback queue.
        sendToBrowser({ type: "barge_in" });
        break;

      case "transcript.user":
        transcriptLog.push({ speaker: "you", text: msg.text });
        sendToBrowser({ type: "transcript", speaker: "you", text: msg.text, final: true });
        break;

      case "transcript.agent":
        transcriptLog.push({ speaker: "prospect", text: msg.text });
        sendToBrowser({ type: "transcript", speaker: "prospect", text: msg.text, final: true });
        break;

      case "tool.call": {
        // Confirmed flat shape per the AsyncAPI spec: { call_id, name, arguments }.
        const { call_id: callId, name: toolName, arguments: toolArgs = {} } = msg;

        if (toolName === "log_objection") {
          const entry = { ...toolArgs, at: new Date().toISOString() };
          objectionLog.push(entry);
          console.log("[objection logged]", entry);
          sendToBrowser({ type: "objection_logged", objection: entry });
        } else {
          console.warn("[agent] unknown tool called:", toolName);
        }

        sendToAgent({
          type: "tool.result",
          call_id: callId,
          result: JSON.stringify({ status: "logged" }),
        });
        break;
      }

      case "session.error":
        console.error("[agent] session.error", msg);
        sendToBrowser({ type: "status", message: `error: ${msg.message || msg.error_code || msg.code}` });
        break;

      case "session.ended":
        console.log("[agent] session.ended", msg);
        console.log("[objection log for this call]", JSON.stringify(objectionLog, null, 2));
        sendToBrowser({ type: "status", message: "call ended -- generating scorecard..." });
        console.log("[scorecard] requesting from LLM Gateway...");
        generateScorecard(API_KEY, objectionLog, transcriptLog)
          .then((scorecard) => {
            console.log("[scorecard] generated successfully, sending to browser");
            sendToBrowser({ type: "scorecard", scorecard });
          })
          .catch((err) => {
            console.error("[scorecard] generation failed:", err);
            sendToBrowser({ type: "status", message: "call ended (scorecard generation failed -- see server log)" });
          })
          .finally(() => {
            if (browserWs.readyState === WebSocket.OPEN) browserWs.close();
          });
        break;

      default:
        // transcript.user.delta / transcript.agent.delta / reply.started /
        // reply.done etc. -- ignore for the bare-loop test.
        break;
    }
  });

  agentWs.on("error", (err) => {
    console.error("[agent] websocket error:", err.message);
    sendToBrowser({ type: "status", message: `agent connection error: ${err.message}` });
  });

  agentWs.on("close", (code, reason) => {
    console.log("[agent] closed", code, reason.toString());
    // If the browser explicitly asked to end the call, the session.ended
    // handler above owns closing browserWs (after the scorecard is sent) --
    // don't race it by closing early here.
    if (!endingGracefully && browserWs.readyState === WebSocket.OPEN) browserWs.close();
  });

  browserWs.on("message", (data, isBinary) => {
    if (isBinary) {
      const b64 = Buffer.from(data).toString("base64");
      if (agentReady) {
        sendToAgent({ type: "input.audio", audio: b64 });
      } else {
        pendingAudio.push(b64);
      }
      return;
    }

    // Text control message from the browser.
    let ctrl;
    try {
      ctrl = JSON.parse(data.toString());
    } catch (err) {
      console.error("[browser] failed to parse control message:", err);
      return;
    }
    if (ctrl.type === "end_call") {
      console.log("[browser] received End Call click -- ending gracefully");
      endingGracefully = true;
      sendToBrowser({ type: "status", message: "ending call..." });
      sendToAgent({ type: "session.end" });
      // Don't close agentWs here -- wait for its session.ended reply so the
      // scorecard can be generated first.
    }
  });

  browserWs.on("close", () => {
    console.log("[browser] disconnected");
    // Abrupt disconnect (tab closed, network drop) with no graceful
    // end_call -- clean up AssemblyAI's side, but there's no scorecard to
    // deliver since the browser is already gone.
    if (!endingGracefully && agentWs && agentWs.readyState === WebSocket.OPEN) {
      sendToAgent({ type: "session.end" });
      agentWs.close();
    }
  });

  browserWs.on("error", (err) => {
    console.error("[browser] websocket error:", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Objection-practice backend listening on http://localhost:${PORT}`);
  console.log(`Audio sample rate expected end-to-end: ${AUDIO_SAMPLE_RATE} Hz PCM16 mono`);
});
