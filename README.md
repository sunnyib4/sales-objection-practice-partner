# Pushback

A voice-based practice partner for sales objection handling, built for the
AssemblyAI Voice Agent Hackathon. You pitch out loud to a skeptical AI
prospect ("Jordan"), it pushes back with real objections (price, timing,
"send me info," a competitor mention), and after the call you get a
scorecard on which objections you handled well vs. fumbled.

**Live demo:** https://server-serene-blossom-6604.fly.dev/ (mic access
required -- allow it when the browser prompts)

Verified end to end: mic input, persona voice round-trip, live objection
tagging via tool-calling, and post-call scorecard generation, all in one run.

## Architecture

```
Browser (mic + speaker)
  <--ws, raw PCM16 frames-->
Node backend
  <--wss + Authorization header-->  AssemblyAI Voice Agent (persona, STT, TTS, tool-calling)
  <--https, raw key auth-->         AssemblyAI LLM Gateway (post-call scorecard)
```

The backend is the only thing that holds the AssemblyAI API key. It:

- Opens `wss://agents.assemblyai.com/v1/ws` with `Authorization: Bearer <key>`
  (the trusted-server auth path -- no temporary token needed since the
  browser never talks to AssemblyAI directly).
- Sends a `session.update` with the sales-prospect persona, a pinned voice,
  and a `log_objection` client-side tool.
- Relays audio + transcript events between the browser and the agent, and
  logs each tagged objection as `tool.call` events arrive.
- On a graceful "End Call," closes out the AssemblyAI session, sends the
  full transcript + tagged objections to AssemblyAI's LLM Gateway
  (`llm-gateway.assemblyai.com`, OpenAI-compatible chat completions) for
  scoring, and pushes the resulting scorecard back to the browser before
  closing the connection.

Audio is PCM16 mono at 24,000 Hz end to end, per AssemblyAI's documented
default. The browser downsamples mic input to 24kHz before sending; playback
audio arrives already at 24kHz.

## Files

- `server/index.js` -- the relay server: WebSocket bridge, persona/tool
  config, objection logging, graceful end-call handling.
- `server/scorecard.js` -- standalone module that calls the LLM Gateway and
  parses its response. Split out so it's testable without the WS server.
- `server/test-scorecard.js` -- feeds a canned sample transcript into
  `scorecard.js` directly, for testing scorecard quality without doing a
  live call.
- `public/index.html` -- the landing page and the call screen's markup and
  styles.
- `public/client.js` -- landing page behavior plus the audio and WebSocket
  plumbing: mic capture, playback scheduling, and reporting call events.
- `public/workspace.js` -- the call screen itself: live transcript, objection
  tracker, scorecard, and past calls. Finished calls (transcript and
  scorecard) are saved in the browser's localStorage only; there is no
  server-side storage.
- `public/mic-processor.js` -- AudioWorklet that captures mic audio off the
  main thread.

## Local setup

```bash
cd server
npm install
export ASSEMBLYAI_API_KEY=your_key_here
npm start
```

Open http://localhost:3000, click **Start Call**, allow mic access, and
pitch something that touches price, a timeline, a competitor, or leaves room
for a "just send me info" brush-off. When you're done, click **End Call**
(not close the tab) -- that's what triggers scorecard generation.

To test just the scorecard step without a live call:

```bash
node test-scorecard.js
```

## What to check if something's wrong

- **No audio, but transcript works**: check browser console for playback
  errors; verify speakers aren't muted; backend should log `[agent]
  session.ready`.
- **Nothing happens at all**: check the terminal for `session.error` or a
  WebSocket auth failure (closes with code 1008 if the API key is
  missing/invalid).
- **Choppy or garbled audio**: sample-rate mismatch -- both directions must
  stay at 24kHz PCM16 mono, little-endian.
- **No scorecard after End Call**: check terminal for `[scorecard]
  generation failed` -- the LLM Gateway model set in `scorecard.js`
  (`SCORECARD_MODEL`) may not be enabled on your account; error body will
  say so explicitly.

## Known limitations

- `SCORECARD_MODEL` is currently `qwen3.5-4b-32k-fast` -- the only model
  confirmed accessible on the tested account. It doesn't support the LLM
  Gateway's schema-enforced `response_format`, so JSON is requested via
  prompt text and parsed defensively instead. If a larger model becomes
  available on your account, swapping `SCORECARD_MODEL` should work as-is
  since the fallback parsing doesn't depend on any particular model.
- No emotion/expressiveness control on the TTS voice beyond picking a voice
  ID (`VOICE_ID` in `server/index.js`) -- AssemblyAI doesn't expose that knob.

## Deploying (Fly.io)

This needs a persistent process (long-lived WebSocket connections in both
directions, plus a secret key) -- not a static host or serverless functions.
Fly runs an actual VM, so it fits without workarounds.

Prerequisites: a [Fly.io](https://fly.io) account and the `flyctl` CLI
installed (`curl -L https://fly.io/install.sh | sh`, or see Fly's docs for
your platform).

> **Note if you're deploying your own copy:** `fly.toml`'s `app =
> "server-serene-blossom-6604"` is tied to the original author's Fly
> account. Change it to a new unique name (or delete the line and let `fly
> launch` assign one) before running these commands, otherwise deploys will
> fail since you don't own that app.
>
> Also run every command below from this `Assembly_AI/` directory
> specifically, not from `server/` -- `server/index.js` serves the frontend
> via a relative path to the sibling `public/` folder, and Docker can't
> copy files from outside its build context. Running from `server/` will
> cause `fly launch` to auto-detect a Node app there instead and generate
> its own Dockerfile that silently omits `public/` entirely.

From the `Assembly_AI/` project root (where `Dockerfile` and `fly.toml`
already live):

```bash
fly auth login

# Creates/registers the app from fly.toml without deploying yet -- if the
# app name in fly.toml is taken, it'll prompt you to pick another (or edit
# fly.toml's `app = "..."` line yourself first).
fly launch --no-deploy

# Store the API key as a secret -- never committed to the repo.
fly secrets set ASSEMBLYAI_API_KEY=your_key_here

# Build and deploy.
fly deploy
```

`fly.toml` is already configured with `min_machines_running = 1` and
`auto_stop_machines = false` so the app stays warm -- no cold-start delay
when a judge opens the link, unlike a free tier that sleeps on idle.

Once deployed, `fly status` shows the live URL (`https://<app-name>.fly.dev`).
Open it the same way as localhost -- mic permissions require HTTPS for a
non-localhost origin, which Fly provides automatically (`force_https = true`
in `fly.toml`).

To ship a code change later: `fly deploy` again from this directory.
