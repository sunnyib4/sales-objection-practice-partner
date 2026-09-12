// Standalone test for the scorecard step ONLY -- no voice call needed.
// Feeds a canned sample transcript + objection log (mirroring the real
// price/timing/competitor/send_info categories already verified live)
// straight into generateScorecard() and prints the result.
//
// Run from server/, with the same env var used for npm start:
//   export ASSEMBLYAI_API_KEY=your_key_here
//   node test-scorecard.js

import { generateScorecard } from "./scorecard.js";

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!API_KEY) {
  console.error("Missing ASSEMBLYAI_API_KEY, export it first, same as for npm start.");
  process.exit(1);
}

// One deliberately weak response (timing) and three solid ones, so the
// verdicts should come back mixed rather than uniformly positive -- a
// useful check that the model is actually differentiating.
const transcriptLog = [
  { speaker: "prospect", text: "Hey, this is Jordan, I've got about ten minutes before my next meeting, so let's make it count. What is this about?" },
  { speaker: "you", text: "Hi Jordan, I'm calling about RouteSync. We help logistics companies cut delivery costs by optimizing driver routes in real time. How many trucks are you running right now?" },
  { speaker: "prospect", text: "About forty trucks. What's this going to cost me?" },
  { speaker: "you", text: "For a fleet your size it's about $2,500 a month, and most customers make that back in fuel savings within six to eight weeks." },
  { speaker: "prospect", text: "That's a tough sell right now. Budget for new tools needs VP sign-off and we're tight this quarter." },
  { speaker: "you", text: "Makes sense, want me to put together a quick ROI estimate off your actual fuel spend so you've got real numbers for that budget conversation?" },
  { speaker: "prospect", text: "Sure. How fast could we actually get this running? Last vendor we used took months to integrate and it was a mess." },
  { speaker: "you", text: "Yeah, it's usually a pretty smooth process for most companies." },
  { speaker: "prospect", text: "We're also looking at RouteworksAI, so I want to see how you compare." },
  { speaker: "you", text: "RouteworksAI's solid, but we integrate directly with your existing dispatch software instead of requiring a swap, and support is 24/7. I can send over a side-by-side comparison if that helps." },
  { speaker: "prospect", text: "I've got another meeting starting soon, just send me some information instead." },
  { speaker: "you", text: "I can send it over, but a lot gets lost in a PDF. Could we grab fifteen minutes later this week so I can actually show you the routing in action?" },
];

const objectionLog = [
  {
    objection_type: "price",
    your_line: "That's a tough sell right now. Budget for new tools needs VP sign-off and we're tight this quarter.",
    at: new Date().toISOString(),
  },
  {
    objection_type: "timing",
    your_line: "How fast could we actually get this running? Last vendor we used took months to integrate and it was a mess.",
    at: new Date().toISOString(),
  },
  {
    objection_type: "competitor",
    your_line: "We're also looking at RouteworksAI, so I want to see how you compare.",
    at: new Date().toISOString(),
  },
  {
    objection_type: "send_info",
    your_line: "I've got another meeting starting soon, just send me some information instead.",
    at: new Date().toISOString(),
  },
];

console.log("Requesting scorecard from AssemblyAI's LLM Gateway...\n");

try {
  const scorecard = await generateScorecard(API_KEY, objectionLog, transcriptLog);
  console.log(JSON.stringify(scorecard, null, 2));
} catch (err) {
  console.error("Scorecard generation failed:", err.message);
  process.exit(1);
}
