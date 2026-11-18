import { createRequire } from "node:module";
import OpusScript from "opusscript";
import type { Session } from "@google/genai";
import type { Ts3Client } from "./tslib/index.js";
import { Player, beep, down48to16, parseVoice, up24to48stereo } from "./audio.js";
import { openLive } from "./gemini.js";
import { t } from "./i18n.js";
import {
  playMusic,
  playNowKeepQueue,
  shouldQueue,
  enqueueMusic,
  playRadio,
  getQueue,
  removeFromQueue,
  jumpToQueue,
  clearQueue,
  skip,
  stop,
  pause,
  resume,
} from "./manager.js";

// sherpa-onnx-node is CommonJS with a native binary (only present in the container); load via require.
const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

const env = process.env;

interface VoiceDeps {
  sendText: (targetmode: number, target: number, text: string) => void;
  isIgnored: (clid: number) => boolean;
  setAutoplay: (on: boolean) => void;
  isAutoplayOn: () => boolean;
  onUserStop: () => void;
  pauseFill: () => void; // clearing the queue pauses autoplay's filling
  resumeFill: () => void; // a user play re-arms it
}

/**
 * Wires up the voice pipeline (wake word via VAD + Whisper-PT → Gemini Live → audio back)
 * and returns the "voice" event handler plus a reset (for reconnects). Call once at boot.
 */
export function initVoice(client: Ts3Client, deps: VoiceDeps) {
  const { sendText, isIgnored, setAutoplay, isAutoplayOn, onUserStop, pauseFill, resumeFill } = deps;

  // ---------- Wake word via VAD + Whisper-PT (transcribe and look for the trigger word) ----------
  const MODEL = env.KWS_DIR!;
  // Fires when the PT transcription contains one of these words.
  const WAKE = new RegExp(
    env.WAKE_WORDS || "gemini|gemin|jemin|jimin|jimi|zemain|gize|gêmeos|ok google|\\bgoogle\\b",
    "i",
  );
  const WP = env.WHISPER_PREFIX || "base"; // tiny | base | small
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: `${MODEL}/${WP}-encoder.int8.onnx`,
        decoder: `${MODEL}/${WP}-decoder.int8.onnx`,
        language: "pt",
        task: "transcribe",
      },
      tokens: `${MODEL}/${WP}-tokens.txt`,
      numThreads: Number(env.ASR_THREADS || 2),
      provider: "cpu",
      debug: 0,
    },
  });
  const VAD_WINDOW = 512;
  function makeVad() {
    return new sherpa.Vad(
      {
        sileroVad: {
          model: `${MODEL}/silero_vad.onnx`,
          threshold: 0.5,
          minSpeechDuration: 0.2,
          minSilenceDuration: 0.4,
          maxSpeechDuration: 6,
          windowSize: VAD_WINDOW,
        },
        sampleRate: 16000,
        numThreads: 1,
        debug: false,
      },
      12,
    );
  }

  type Speaker = { dec: OpusScript; vad: any };
  // ponytail: one decoder+VAD per clid ever seen, never freed; prune on notifyclientleftview if it grows.
  const speakers = new Map<number, Speaker>();
  function speaker(clid: number): Speaker {
    let s = speakers.get(clid);
    if (!s) {
      s = { dec: new OpusScript(48000, 1), vad: makeVad() };
      speakers.set(clid, s);
    }
    return s;
  }

  const voiceDbg: Record<number, number> = {};
  let lastVoiceLog = 0;

  const player = new Player(
    (o) => {
      client.sendVoice(o);
      if (listener !== null) keepAlive(); // while the bot talks, the silence countdown does not run
    },
    () => {
      client.sendVoiceStop();
      if (listener !== null) keepAlive(); // Gemini just stopped talking → start counting silence now
    },
  );
  let session: Session | null = null;
  let listener: number | null = null; // null = idle; clid of whoever triggered = ongoing conversation
  let pending: Int16Array[] = []; // audio captured while the Live session connects
  let silenceTimer: NodeJS.Timeout | undefined; // marks the end of each utterance
  let convoTimer: NodeJS.Timeout | undefined; // ends the conversation after a long silence
  let closeAfterTurn = false; // close the session after a command's confirmation is spoken
  const CONVO_IDLE_MS = Number(env.CONVO_IDLE_MS || 12000); // auto-unlock after this much silence
  // Music actions run through this chain so a compound request ("clear the queue then play X")
  // executes in the order received instead of racing. Each step catches its own error so one
  // failure never stalls the next.
  let actionChain: Promise<unknown> = Promise.resolve();

  function toLive(pcm: Int16Array) {
    const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
    session!.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } });
  }

  // End of conversation: stop listening and close the session (resets context).
  function endConversation() {
    console.log("[voice] conversation ended (silence)");
    listener = null;
    clearTimeout(silenceTimer);
    player.clear();
    session?.close();
    if (env.BEEP !== "0")
      player.push(
        beep([
          { f: 784, ms: 110 },
          { f: 587, ms: 170 },
        ]),
      ); // falling = "released"
  }

  // End the conversation immediately, without the exit beep and without clearing the audio queue
  // (used after a music command, to stop listening and let the sounds play out).
  function endConversationQuiet() {
    listener = null;
    clearTimeout(silenceTimer);
    clearTimeout(convoTimer);
    session?.close();
  }

  // Resets all voice state (used on reconnect, to avoid getting stuck).
  function resetVoice() {
    listener = null;
    clearTimeout(silenceTimer);
    clearTimeout(convoTimer);
    pending = [];
    player.clear();
    session?.close();
    session = null;
  }

  // Re-armed on each utterance; if CONVO_IDLE_MS passes with nobody talking, it ends.
  function keepAlive() {
    clearTimeout(convoTimer);
    convoTimer = setTimeout(endConversation, CONVO_IDLE_MS);
  }

  async function startListening(clid: number) {
    console.log(`[voice] triggered by clid ${clid} — conversing`);
    listener = clid;
    player.clear();
    if (env.BEEP !== "0")
      player.push(
        beep([
          { f: 587, ms: 110 },
          { f: 784, ms: 170 },
        ]),
      ); // rising = "I heard you"
    keepAlive();
    if (!session) {
      try {
        session = await openLive({
          audio: (pcm) => player.push(up24to48stereo(pcm)),
          turnComplete: () => {
            // After a music command, Gemini speaks the confirmation and THEN the session closes.
            if (closeAfterTurn) {
              closeAfterTurn = false;
              endConversationQuiet();
            } else keepAlive();
          },
          interrupted: () => player.clear(),
          onTool: async (name, args) => {
            const beeps = env.BEEP !== "0";
            // "tururum" = command recognized (instant feedback until the voice comes out)
            if (beeps)
              player.push(
                beep([
                  { f: 659, ms: 80 },
                  { f: 784, ms: 80 },
                  { f: 1047, ms: 130 },
                ]),
              );
            const q = String(args?.query ?? args?.name ?? "");
            // play_music/add_to_queue take a list of songs; the single-song tools use `query`.
            const queries: string[] = Array.isArray(args?.queries)
              ? args.queries.map(String).filter(Boolean)
              : q
                ? [q]
                : [];
            // A user-initiated play/queue re-arms autoplay filling if a queue-clear had paused it.
            if (name === "play_music" || name === "play_now" || name === "add_to_queue" || name === "play_radio")
              resumeFill();
            // Pick the action and return a short English status; Gemini phrases the spoken
            // confirmation in the configured language. "play_music" decides queue vs. now from
            // current state so the confirmation matches what actually happened.
            let run: () => Promise<unknown> = async () => {};
            let result: Record<string, unknown>;
            if (name === "play_music") {
              const queueModeNow = await shouldQueue().catch(() => false); // for the spoken confirmation
              // Re-decided at run time (after any clear/stop ahead of us in the chain has run), so
              // "clear the queue then play X" actually plays X instead of queuing it behind nothing.
              run = async () => {
                const queueMode = await shouldQueue().catch(() => false);
                for (let i = 0; i < queries.length; i++) {
                  if (i === 0 && !queueMode) await playMusic(queries[i]);
                  else await enqueueMusic(queries[i]);
                }
              };
              result = { ok: true, action: queueModeNow ? "queued" : "playing_now", count: queries.length, queries };
            } else if (name === "add_to_queue") {
              run = async () => {
                for (const s of queries) await enqueueMusic(s);
              };
              result = { ok: true, action: "queued", count: queries.length, queries };
            } else if (name === "remove_from_queue") {
              // fast (no download): do it now and report the real outcome
              const target = args?.position != null ? Number(args.position) : q;
              const title = await removeFromQueue(target).catch(() => null);
              result = title
                ? { ok: true, action: "removed", title }
                : { ok: false, reason: "not_found_in_queue", target };
            } else if (name === "jump_to_queue") {
              // fast (the queued song is already downloaded): do it now and report the real outcome
              const target = args?.position != null ? Number(args.position) : q;
              const title = await jumpToQueue(target).catch(() => null);
              result = title
                ? { ok: true, action: "playing_now", title }
                : { ok: false, reason: "not_found_in_queue", target };
            } else if (name === "list_queue") {
              const { nowPlaying, upcoming } = await getQueue();
              const LIMIT = 15;
              let msg = nowPlaying ? `${t.nowPlaying(nowPlaying)}\n` : "";
              if (upcoming.length) {
                msg +=
                  `${t.upcoming}\n` +
                  upcoming
                    .slice(0, LIMIT)
                    .map((title, i) => `${i + 1}. ${title}`)
                    .join("\n");
                if (upcoming.length > LIMIT) msg += `\n${t.andMore(upcoming.length - LIMIT)}`;
              } else if (!nowPlaying) {
                msg = t.queueEmpty;
              } else {
                msg += t.noUpcoming;
              }
              const autoplay = isAutoplayOn();
              msg += `\n${t.autoplay(autoplay)}`;
              sendText(2, 0, msg);
              // return autoplay in the data so Gemini also says it out loud in the spoken confirmation
              result = { ok: true, action: "listed_in_chat", autoplay };
            } else if (name === "write_chat") {
              const text = String(args?.text || "");
              if (text) sendText(2, 0, text);
              result = { ok: true, action: "wrote_in_chat" };
            } else if (name === "autoplay_on" || name === "autoplay_off") {
              const on = name === "autoplay_on";
              setAutoplay(on);
              result = { ok: true, action: on ? "autoplay_on" : "autoplay_off" };
            } else if (name === "stop_music") {
              onUserStop(); // explicit stop: tell autoplay to stay stopped, don't auto-restart
              run = stop;
              result = { ok: true, action: "stopped" };
            } else if (name === "clear_queue") {
              pauseFill(); // pause autoplay's filling (it resumes when you play again) so it doesn't refill what was just cleared
              run = clearQueue;
              result = { ok: true, action: "queue_cleared", autoplayPaused: true };
            } else {
              const actions: Record<string, { run: () => Promise<unknown>; action: string }> = {
                play_now: { run: () => playNowKeepQueue(q), action: "playing_now" },
                play_radio: { run: () => playRadio(q), action: "playing_radio" },
                skip_track: { run: skip, action: "skipped" },
                pause_music: { run: pause, action: "paused" },
                resume_music: { run: resume, action: "resumed" },
              };
              const a = actions[name];
              if (!a) return { ok: false, error: "unknown function" };
              run = a.run;
              result = { ok: true, action: a.action, ...(q ? { query: q } : {}) };
            }
            // Heavy action (download ~10s) runs in the background; Gemini confirms by voice now and
            // the session closes right after that confirmation (closeAfterTurn), not during the download.
            actionChain = actionChain
              .then(() => run())
              .catch((e) => {
                console.error(`[tool] ${name} error:`, e.message);
                if (beeps)
                  player.push(
                    beep([
                      { f: 392, ms: 150 },
                      { f: 294, ms: 200 },
                    ]),
                  ); // only on failure
              });
            closeAfterTurn = true;
            clearTimeout(convoTimer);
            convoTimer = setTimeout(endConversationQuiet, 10000); // safety, in case turnComplete never arrives
            return result;
          },
          closed: () => {
            session = null;
            listener = null;
            clearTimeout(convoTimer);
          },
        });
      } catch (e: any) {
        console.error("[live] failed to connect:", e.message);
        listener = null;
        return;
      }
    }
    pending.forEach(toLive);
    pending = [];
  }

  function onVoice(data: Buffer) {
    const v = parseVoice(data);
    if (!v || v.opus.length === 0 || (v.codec !== 4 && v.codec !== 5)) return; // 4/5 = Opus voice/music
    if (v.clientId !== listener && isIgnored(v.clientId)) return; // ignore the music bot's voice
    const s = speaker(v.clientId);
    let pcm: Int16Array;
    try {
      pcm = down48to16(Buffer.from(s.dec.decode(v.opus)));
    } catch {
      return;
    }

    // Conversation locked to whoever triggered it: only their voice goes to Gemini (avoids a mess).
    if (listener === v.clientId) {
      if (session) toLive(pcm);
      else pending.push(pcm);
      keepAlive(); // the caller spoke → keep the conversation alive
      // TS sends nothing during silence, so tell the Live API the utterance ended (closes the turn).
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => session?.sendRealtimeInput({ audioStreamEnd: true }), 800);
      return;
    }

    // Someone else talking while a conversation is active → ignore (don't disturb, don't trigger).
    if (listener !== null) return;
    if (env.DEBUG_VOICE === "1") {
      voiceDbg[v.clientId] = (voiceDbg[v.clientId] || 0) + pcm.length;
      const now = Date.now();
      if (now - lastVoiceLog > 1500) {
        lastVoiceLog = now;
        console.log(`[audio] receiving voice:`, JSON.stringify(voiceDbg));
        for (const k in voiceDbg) voiceDbg[+k] = 0;
      }
    }
    // VAD segments the speech; each segment is transcribed (PT) and we look for the wake word in the text.
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
    for (let i = 0; i < samples.length; i += VAD_WINDOW) {
      s.vad.acceptWaveform(samples.subarray(i, i + VAD_WINDOW));
    }
    while (!s.vad.isEmpty()) {
      const seg = s.vad.front();
      s.vad.pop();
      if (listener !== null) continue; // already triggered in the meantime
      const st = recognizer.createStream();
      st.acceptWaveform({ sampleRate: 16000, samples: seg.samples });
      recognizer.decode(st);
      const text = (recognizer.getResult(st).text || "").toLowerCase().trim();
      if (text && env.DEBUG_VOICE === "1") console.log(`[asr ${v.clientId}] ${text}`);
      if (text && WAKE.test(text)) {
        console.log(`[wake] ${v.clientId}: "${text}"`);
        void startListening(v.clientId);
      }
    }
  }

  return { onVoice, reset: resetVoice };
}
