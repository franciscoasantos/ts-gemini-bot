# CLAUDE.md

Gemini bot for TeamSpeak 6: joins the server as a real voice client, talks by voice (wake word
"ok google") and text, and voice-controls the server's music bot (via the TS6 Manager API).

The repo is in English. The language the bot *replies to users in* is set by `BOT_LANGUAGE`
(default `pt-BR`) — see `src/i18n.ts`.

## Rules

@.claude/rules/security.md
@.claude/rules/conventions.md
@.claude/rules/workflow.md
@.claude/rules/documentation.md

## Commands

```bash
npm run check        # oxlint + tsc --noEmit + vitest (run before committing)
npm run format       # Prettier
npm start            # run locally (reads .env)
```

## Architecture

Voice pipeline: TS Opus packet → decode → VAD (silero) slices the speech → Whisper-PT
transcribes → finds the wake word → opens a Gemini Live session → audio back.

- `src/index.ts` — orchestrates: connection/reconnection, text, wiring, client tracking.
- `src/voice.ts` — the voice pipeline and conversation state (locks to the caller, releases on
  silence) plus the music tool handler. Exposed via `initVoice(client, { sendText, isIgnored })`.
- `src/gemini.ts` — `ask()` (text, `generateContent`) and `openLive()` (voice, Live API).
  `PERSONA`, `TOOLS` (music functionDeclarations) and the `systemInstruction` live here.
- `src/i18n.ts` — `BOT_LANGUAGE`: the prompt's language name and the few bot-written strings.
- `src/autoplay.ts` — keeps the queue topped up with similar songs (Gemini-picked) while music
  plays, refilling in batches when it runs low (one Gemini call per batch), and restarts playback
  if it stops. Toggled by voice (`autoplay_on`/`off`), the `!autoplay [on|off]` command, or `AUTOPLAY`.
- `src/manager.ts` — TS6 Manager REST client (JWT login, play/queue/radio/etc).
- `src/audio.ts` — Opus (opusscript/WASM), resample 48↔16k and 24→48k, `Player`, `beep`.
- `src/filetransfer.ts` — avatar upload via the TS file transfer.
- `src/tslib/` — TS3 voice client (reverse-engineered, from clusterzx/ts6-manager, MIT).
  **Do not edit unless necessary**; if you do, keep the license notice.

## Hard rules

- **Secrets never enter git** (the repo is public). `.env` (Gemini key, Manager creds),
  `identity.json` and `node_modules` are gitignored — don't commit, don't paste into versioned
  files, don't put the SSH host/user here.
- `identity.json` is the bot's identity on the server; lose it and the bot becomes another
  client. Persisted in the `./data` volume in Docker.
- No toolchain build: `sherpa-onnx-node` and `opusscript` are ready binary/WASM (run on ARM64).
  `sherpa-onnx-node` is native and **only exists in the container** — locally, only lint/tsc/tests.

## Gotchas (they cost time already)

- **Live API quota**: voice uses `gemini-3.1-flash-live-preview`, which has a separate, small
  free-tier quota. Many tests in one day exhaust it ("exceeded your current quota") and voice
  dies; text (`generateContent`) has a different quota and keeps working. Resets daily (Pacific
  time) or with billing enabled.
- **Pin the text model, never a `-latest` alias**: the alias repoints to the newest Flash, which
  can carry a tiny free-tier quota (`gemini-3.8-flash` = 20 requests/day) that autoplay drains in
  minutes. `GEMINI_TEXT_MODEL` is pinned to a lite model (`gemini-3.1-flash-lite`) for a larger,
  predictable quota. Older models (2.0/2.5) are retired — if a pinned one 404s "no longer
  available", list `…/v1beta/models` for the key and pin a current one.
- **Wake word**: whisper-base can't hear "gemini"/"alfredo"/"robô" reliably (it misspells them in
  PT). Hence the trigger is "ok google", which it always gets right. `WAKE_WORDS` is a regex
  tested against the PT transcription (lowercased); moving to whisper-small improves accuracy but
  makes the reply start slower.
- **Music bot audio**: the music arrives as "voice" and disturbs detection. `index.ts` ignores the
  audio of whoever is in `IGNORE_SPEAKERS`/`MUSIC_BOT_NAME` (default "DJ Morri").
- **PID 1 / SIGTERM**: the Dockerfile `CMD` is `node --import tsx` (not `npx`) so Node gets
  SIGTERM and disconnects cleanly; otherwise the server keeps a ghost "clone" and throws error 521.
- **Conversation idle**: the silence countdown (`CONVO_IDLE_MS`) only runs after the bot stops
  talking (`keepAlive()` on every frame sent), otherwise it cuts off mid-reply.
- **YouTube music delay (~10s)**: the Manager downloads the whole audio before playing; it's
  internal to it. Mitigated with an immediate spoken confirmation. Radio is instant.
- **Avatar**: the file transfer returns "convert error" on some attempts; hence `setAvatarOnce`
  tries only once per process. It's cosmetic.

## Config (`.env`, see `.env.example`)

Required: `TS_HOST`, `GEMINI_API_KEY`, `KWS_DIR`. Reply language: `BOT_LANGUAGE` (default `pt-BR`).
Music: `MANAGER_USER`/`MANAGER_PASS` (empty disables it). Autoplay: `AUTOPLAY=1` (also by voice).
Common tweaks: `WAKE_WORDS`, `WHISPER_PREFIX` (tiny|base|small), `CONVO_IDLE_MS`, `IGNORE_SPEAKERS`,
`BEEP=0`, `DEBUG_VOICE=1`.
