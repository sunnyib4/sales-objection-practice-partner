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
- "handled_well": specific and concrete -- a real number, a real timeline, a direct answer to the actual concern.
- "partially_handled": addressed it somewhat but stayed vague or generic, or only partly resolved it.
- "fumbled": ignored the objection, was evasive, or caved/agreed to disengage instead of addressing it.

Also give 2-4 overall strengths, 2-4 areas to improve, and a 2-3 sentence overall_summary.

Be specific and quote or closely paraphrase what was actually said. Do not default to generic positivity -- honest, concrete feedback is the entire point of this tool.

Respond with ONLY a single JSON object -- no markdown code fences, no commentary before or after it. It must match exactly this shape:
{
  "overall_summary": "2-3 sentence string",
  "objections": [
    {
      "objection_type": "one of the tagged categories, exactly as given",
      "prospect_line": "the objection as the prospect raised it",
      "verdict": "handled_well" | "partially_handled" | "fumbled",
      "feedback": "specific feedback string"
    }
  ],
  "strengths": ["string", "string"],
  "areas_to_improve": ["string", "string"]
}
Include one entry in "objections" for every tagged objection given below, in the same order.`;

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

export async function generateScorecard(apiKey, objectionLog, transcriptLog) {
  if (objectionLog.length === 0) {
    return {
      overall_summary:
        "No objections were tagged during this call, so there's nothing to score yet. Try a pitch that mentions a price, a timeline, a competitor, or leaves room for a 'just send me info' brush-off.",
      objections: [],
      strengths: [],
      areas_to_improve: [],
    };
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

  try {
    return extractJson(content);
  } catch (err) {
    throw new Error(`Failed to parse scorecard JSON (${err.message}). Raw content:\n${content}`);
  }
}
