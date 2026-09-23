// Post-call scorecard generation via AssemblyAI's LLM Gateway. Split into
// its own module so it can be exercised standalone (see test-scorecard.js)
// without booting the WebSocket relay server in index.js.
//
// OpenAI-compatible chat completions endpoint. Note the auth header is the
// raw key with no "Bearer" prefix -- a different convention than the Voice
// Agent WebSocket, per the LLM Gateway's own docs.

import { jsonrepair } from "jsonrepair";

const LLM_GATEWAY_URL = "https://llm-gateway.assemblyai.com/v1/chat/completions";
// AssemblyAI's own hosted model -- the one used in their quickstart example,
// so it should be available on every account tier without extra provider
// access. Other models (e.g. claude-sonnet-5) returned both "no access" and
// "does not support response_format" errors when tried here.
const SCORECARD_MODEL = "qwen3.5-4b-32k-fast";

const SCORER_SYSTEM_PROMPT = `You are a sales coaching assistant reviewing a practice call. You'll get the full transcript between a salesperson ("You") and a skeptical prospect named Jordan ("Prospect"), plus a list of objections Jordan raised, each tagged with a category.

For each tagged objection, find the salesperson's actual response to it in the transcript (usually the next "You:" line right after it) and judge it:
- "handled_well": specific and concrete, a real number, a real timeline, a direct answer to the actual concern.
- "partially_handled": addressed it somewhat but stayed vague or generic, or only partly resolved it.
- "fumbled": ignored the objection, was evasive, or caved/agreed to disengage instead of addressing it.

For any objection judged "partially_handled" or "fumbled", also write:
- better_response: a concrete, ready-to-say line the salesperson could have used instead, right in that exact moment, specific to what Jordan actually said. Not generic advice like "be more specific" or "ask a follow-up question" -- an actual sentence or two they could say verbatim on the call.
- next_step: a concrete action beyond just words, only if one would genuinely help (e.g. "offer to send a personalized ROI calculator," "schedule a technical demo," "follow up with a case study from a similar-sized client"). Set this to null if the fix is purely about what to say and no follow-up action is needed -- do not invent a next step just to fill the field.

For objections judged "handled_well", set both better_response and next_step to null -- there's nothing to correct.

Then, looking across the WHOLE call (not just objection responses), score two more dimensions from 0-100:
- response_specificity_score: how often the salesperson's responses included concrete numbers, real timelines, or specific commitments, versus vague reassurance ("it's usually fine," "don't worry about it," "we can figure that out"). 100 = consistently specific and concrete throughout. 0 = consistently vague, no real numbers or specifics anywhere.
- discovery_score: how often the salesperson asked genuine questions back to the prospect (about their situation, current setup, needs, timeline, budget process) instead of just defending or pitching. 100 = asked frequent, relevant discovery questions. 0 = never asked anything, purely defended or pitched the whole call.

Also give 2-4 overall strengths, 2-4 areas to improve, and a 2-3 sentence overall_summary.

Be specific and closely paraphrase what was actually said. Do not default to generic positivity or a default-high score on any dimension. Honest, concrete, differentiated judgment is the entire point of this tool.

CRITICAL JSON rule: every string value below must be PLAIN TEXT with no quotation marks inside it, even when referencing exact words someone said -- paraphrase or drop the quote marks instead of embedding them (write Jordan said the integration timeline worried her, not Jordan said "the integration timeline worried her"). The app that displays this already wraps quoted lines in its own quote marks, so a quote character inside your string value only breaks the JSON and loses the whole response. If you need an apostrophe, that's fine -- only literal " characters inside a value are forbidden.

Respond with ONLY a single JSON object, no markdown code fences, no commentary before or after it. It must match exactly this shape:
{
  "overall_summary": "2-3 sentence string, no quote characters inside it",
  "response_specificity_score": 0-100 integer,
  "discovery_score": 0-100 integer,
  "objections": [
    {
      "objection_type": "one of the tagged categories, exactly as given",
      "prospect_line": "the objection as the prospect raised it, no quote characters inside it",
      "verdict": "handled_well" | "partially_handled" | "fumbled",
      "feedback": "specific feedback string, no quote characters inside it",
      "better_response": "a ready-to-say line with no quote characters inside it, or null if verdict is handled_well",
      "next_step": "a concrete follow-up action, or null if none is needed"
    }
  ],
  "strengths": ["string", "string"],
  "areas_to_improve": ["string", "string"]
}
Include one entry in "objections" for every tagged objection given below, in the same order. Do NOT include an objection_resolution_score or overall_score field; those are computed separately, not by you.`;

// NOTE: this model doesn't support the LLM Gateway's response_format /
// json_schema structured-output feature (confirmed via a live 400:
// "model qwen3.5-4b-32k-fast does not support response_format"), so JSON
// is requested via the prompt above and parsed defensively below instead
// of being schema-enforced by the API.
//
// Across live calls this small/fast model has produced at least three
// distinct kinds of broken JSON (an escaped quote instead of a plain
// opening quote, a dropped closing brace, a dropped opening quote on an
// array element) -- hand-rolling a fix for each new pattern as it turns up
// doesn't scale, so this uses jsonrepair, a library built specifically for
// exactly this class of near-valid LLM JSON output, instead of continuing
// to write bespoke recovery logic per failure mode.
function extractJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : content).trim();
  try {
    return JSON.parse(candidate);
  } catch (err) {
    try {
      return JSON.parse(jsonrepair(candidate));
    } catch (_repairErr) {
      throw err; // report the original error -- it's the more informative one
    }
  }
}

const VERDICT_POINTS = { handled_well: 100, partially_handled: 50, fumbled: 0 };

// Coerce to a 0-100 integer, or null if the model returned something unusable
// (missing, non-numeric, out of range) -- defensive since this isn't
// schema-enforced by the API.
function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function average(numbers) {
  const valid = numbers.filter((n) => n !== null && n !== undefined);
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((sum, n) => sum + n, 0) / valid.length);
}

// Deterministic, not trusted to the LLM: average verdict points across all
// tagged objections. Same formula the spec calls the "overall score" --
// here it's one of three category scores instead, with the true overall
// score being the average of all three categories (see below), so the two
// numbers aren't just a duplicate of each other on screen.
function objectionResolutionScore(objections) {
  return average(objections.map((o) => VERDICT_POINTS[o.verdict] ?? null));
}

const NO_OBJECTIONS_RESULT = {
  overall_summary:
    "No objections were tagged during this call, so there's nothing to score yet. Try a pitch that mentions a price, a timeline, a competitor, or leaves room for a 'just send me info' brush-off.",
  overall_score: null,
  categories: { objection_resolution: null, response_specificity: null, discovery: null },
  objections: [],
  strengths: [],
  areas_to_improve: [],
};

// One request + parse attempt. Marks parse-related failures (as opposed to
// a real HTTP/auth error) with `.retryable = true` so the caller can decide
// whether trying again is worthwhile -- a fresh generation often just
// avoids whatever glitch produced broken JSON the first time.
async function requestScorecardOnce(apiKey, transcriptText, objectionsText) {
  const res = await fetch(LLM_GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: apiKey,
    },
    body: JSON.stringify({
      model: SCORECARD_MODEL,
      messages: [
        { role: "system", content: SCORER_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Full call transcript:\n${transcriptText}\n\nTagged objections, in order:\n${objectionsText}`,
        },
      ],
      // Raised from 2000 -- with up to 4 objections each now carrying a
      // better_response/next_step on top of the original fields, the JSON
      // output can run well past 2000 tokens and get cut off mid-object,
      // which throws a JSON parse error below and loses the whole
      // scorecard. This gives real headroom for a busy call.
      max_tokens: 4000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM Gateway ${res.status}: ${body}`); // not retryable -- a fresh attempt won't fix a 4xx/5xx
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error("LLM Gateway returned no content");
  if (choice?.finish_reason === "length") {
    const err = new Error(
      "LLM Gateway response was truncated (hit max_tokens) before finishing the JSON -- raise max_tokens further."
    );
    err.retryable = true;
    throw err;
  }

  try {
    return extractJson(content);
  } catch (err) {
    const wrapped = new Error(`Failed to parse scorecard JSON (${err.message}). Raw content:\n${content}`);
    wrapped.retryable = true;
    throw wrapped;
  }
}

export async function generateScorecard(apiKey, objectionLog, transcriptLog) {
  if (objectionLog.length === 0) {
    return NO_OBJECTIONS_RESULT;
  }

  const transcriptText = transcriptLog
    .map((t) => `${t.speaker === "you" ? "You" : "Prospect"}: ${t.text}`)
    .join("\n");
  const objectionsText = objectionLog
    .map((o, i) => `${i + 1}. [${o.objection_type}] Prospect said: "${o.your_line}"`)
    .join("\n");

  let parsed;
  try {
    parsed = await requestScorecardOnce(apiKey, transcriptText, objectionsText);
  } catch (err) {
    if (!err.retryable) throw err;
    console.warn(`[scorecard] first attempt failed (${err.message.split("\n")[0]}), retrying once...`);
    parsed = await requestScorecardOnce(apiKey, transcriptText, objectionsText); // let a second failure propagate as-is
  }

  const objections = Array.isArray(parsed.objections) ? parsed.objections : [];
  const categories = {
    objection_resolution: objectionResolutionScore(objections),
    response_specificity: clampScore(parsed.response_specificity_score),
    discovery: clampScore(parsed.discovery_score),
  };

  // Seen live: the model occasionally writes "areas_to-improve" (hyphen)
  // instead of the requested "areas_to_improve" -- valid JSON either way,
  // just the wrong key, so it wouldn't be caught by JSON repair. Fall back
  // to the misspelled form rather than silently rendering an empty section.
  const areasToImprove = Array.isArray(parsed.areas_to_improve)
    ? parsed.areas_to_improve
    : Array.isArray(parsed["areas_to-improve"])
      ? parsed["areas_to-improve"]
      : [];

  return {
    overall_summary: parsed.overall_summary ?? "",
    overall_score: average(Object.values(categories)),
    categories,
    objections,
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    areas_to_improve: areasToImprove,
  };
}
