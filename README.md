# ts-gemini-bot

A Gemini bot for TeamSpeak 6. It joins the server as a regular client and talks by voice and
text, and can also voice-control the server's music bot (via the TS6 Manager).

## What it does

**Voice.** Say the wake word (**"gemini"** or **"ok google"**) and then speak, in any language.
Gemini replies out loud in the channel and keeps the conversation context. Say goodbye ("bye",
"that's all") to end it right away; otherwise, after a few seconds of silence the session ends on
its own and releases for someone else. The language Gemini *replies
in* is set by `BOT_LANGUAGE` (default Brazilian Portuguese).

Audio cues: a short rising sound when it hears you, a "tururum" when it recognizes a music
command, and a falling sound when the conversation is released.

**Text.** `!gemini <question>` in the channel chat, or any direct message to the bot.

**Music (by voice, controlling the Manager's music bot).** After the wake word:

| You say | What happens |
|---|---|
| "play *X*" | If something is playing, it queues; if stopped, it plays now |
| "play *X* now" | Plays immediately **without losing** the existing queue |
| "add *X* to the queue" | Enqueues without interrupting |
| "remove *X* from the queue" / "remove song 1" | Removes the song by name, or by its number in the queue list (1 = next) |
| "switch to song 2" / "go to the *X* one" | Jumps to that queued song (by number or name) and plays it now |
| "skip" / "stop" / "pause" / "resume" | Controls playback |
| "play the *X* radio" | Plays a radio station (by name or genre) — streaming, no wait |
| "what's in the queue?" | Writes the upcoming songs to the channel chat |
| "what song is this?" / "who sings it?" | Looks up the song playing now and answers about it; the conversation stays open for more questions |
| "write *X* in the chat" | Posts a message to the channel chat |

(The examples are in English, but the bot understands requests in any language and replies in
`BOT_LANGUAGE`.)

## How it works

- **TS3 voice client** (`src/tslib`): reverse-engineered protocol, copied from
  [ts6-manager](https://github.com/clusterzx/ts6-manager) (MIT). It's the same client the music
  bots use, so they coexist on the server without conflict.
- **Wake word**: VAD (silero) slices the speech and **multilingual Whisper** transcribes it; the
  bot looks for the wake word in the text. The music bot's audio is ignored so it neither
  interferes nor wastes CPU.
- **Voice conversation**: Gemini Live API (`@google/genai`). Text uses `generateContent`.
- **Music**: the bot calls the TS6 Manager backend API, which drives the music bot.
- **Opus audio**: `opusscript` (WASM); speech models via `sherpa-onnx` (native binary, runs on
  ARM64). None of it needs compiling.

## Run (Docker)

```bash
cp .env.example .env     # fill at least TS_HOST and GEMINI_API_KEY
docker compose up -d --build
docker compose logs -f
```

The Gemini key comes from [Google AI Studio](https://aistudio.google.com/apikey). On the first
run the bot generates an identity and saves it to `data/identity.json` (volume) — that's what the
server uses to recognize it; keep that file.

For the **music** commands, fill `MANAGER_USER`/`MANAGER_PASS` with a TS6 Manager login and
confirm `MUSIC_BOT_NAME`. The container must reach the Manager backend — `docker-compose.yml`
already connects it to the external `teamspeak-net` network; adjust the name if your Manager project uses
another.

## Settings (`.env`)

- `BOT_LANGUAGE` — language the bot replies in (e.g. `pt-BR`, `en`). Default `pt-BR`.
- `TZ_OFFSET` — users' UTC offset in hours, used when Gemini tells the time/date. Default `-3`.
- `WAKE_WORDS` — regex of accepted wake-word transcriptions. Default `ok(ay)?,? google|gemini`.
- `WAKE_LANGUAGE` — language Whisper transcribes in to spot the wake word (default `en`, where
  whisper-base is most accurate). It translates speech in other languages, so pick a name as the
  wake word, not a common word.
- `WHISPER_PREFIX` — `tiny`/`base`/`small`. Larger = more accurate and slower; must match the
  model downloaded in the `Dockerfile`.
- `CONVO_IDLE_MS` — silence (ms) until the conversation ends.
- `IGNORE_SPEAKERS` — nicknames whose audio is ignored (default: the music bot).
- `BEEP=0` turns off the audio cues; `DEBUG_VOICE=1` logs what the bot hears.

## Known limitations

- Playing **YouTube** music has a ~10s wait: the Manager downloads the whole audio before
  playing. Radio is instant (streaming). The bot confirms by voice right away so it isn't silent
  during the wait.
- The wake word uses a general-purpose model; pronunciations far off the norm can slip through —
  `WAKE_WORDS` is adjustable.
- Uploading the bot's own avatar is flaky (the TS file transfer returns "convert error" on some
  attempts).

## Verification

- `npm run check` — lint (oxlint) + `tsc --noEmit` + tests (Vitest).
- In TeamSpeak: `!gemini hi` in the channel; a direct message; "gemini" + a command.
