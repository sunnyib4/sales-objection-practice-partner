// Post-call scorecard generation via AssemblyAI's LLM Gateway. Split into
// its own module so it can be exercised standalone (see test-scorecard.js)
// without booting the WebSocket relay server in index.js.
//
// OpenAI-compatible chat completions endpoint. Note the auth header is the
// raw key with no "Bearer" prefix -- a different convention than the Voice
// Agent WebSocket, per the LLM Gateway's own docs.

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
- better_response: a concrete, ready-to-say line the salesperson could have used instead, right in that exact moment, specific to what Jordan actually said. Not generic advice like "be more specific" or "ask a follow-up question" -- an actual quotable sentence or two they could say verbatim on the call.
- next_step: a concrete action beyond just words, only if one would genuinely help (e.g. "offer to send a personalized ROI calculator," "schedule a technical demo," "follow up with a case study from a similar-sized client"). Set this to null if the fix is purely about what to say and no follow-up action is needed -- do not invent a next step just to fill the field.

For objections judged "handled_well", set both better_response and next_step to null -- there's nothing to correct.

Then, looking across the WHOLE call (not just objection responses), score two more dimensions from 0-100:
- response_specificity_score: how often the salesperson's responses included concrete numbers, real timelines, or specific commitments, versus vague reassurance ("it's usually fine," "don't worry about it," "we can figure that out"). 100 = consistently specific and concrete throughout. 0 = consistently vague, no real numbers or specifics anywhere.
- discovery_score: how often the salesperson asked genuine questions back to the prospect (about their situation, current setup, needs, timeline, budget process) instead of just defending or pitching. 100 = asked frequent, relevant discovery questions. 0 = never asked anything, purely defended or pitched the whole call.

Also give 2-4 overall strengths, 2-4 areas to improve, and a 2-3 sentence overall_summary.

Be specific and quote or closely paraphrase what was actually said. Do not default to generic positivity or a default-high score on any dimension. Honest, concrete, differentiated judgment is the entire point of this tool.

Respond with ONLY a single JSON object, no markdown code fences, no commentary before or after it. It must match exactly this shape:
{
  "overall_summary": "2-3 sentence string",
  "response_specificity_score": 0-100 integer,
  "discovery_score": 0-100 integer,
  "objections": [
    {
      "objection_type": "one of the tagged categories, exactly as given",
      "prospect_line": "the objection as the prospect raised it",
      "verdict": "handled_well" | "partially_handled" | "fumbled",
      "feedback": "specific feedback string",
      "better_response": "a ready-to-say quotable line, or null if verdict is handled_well",
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
function extractJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : content).trim();
  return JSON.parse(candidate);
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
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM Gateway ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM Gateway returned no content");

  let parsed;
  try {
    parsed = extractJson(content);
  } catch (err) {
    throw new Error(`Failed to parse scorecard JSON (${err.message}). Raw content:\n${content}`);
  }

  const objections = Array.isArray(parsed.objections) ? parsed.objections : [];
  const categories = {
    objection_resolution: objectionResolutionScore(objections),
    response_specificity: clampScore(parsed.response_specificity_score),
    discovery: clampScore(parsed.discovery_score),
  };

  return {
    overall_summary: parsed.overall_summary ?? "",
    overall_score: average(Object.values(categories)),
    categories,
    objections,
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    areas_to_improve: Array.isArray(parsed.areas_to_improve) ? parsed.areas_to_improve : [],
  };
}
