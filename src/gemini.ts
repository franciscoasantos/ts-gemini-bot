import { GoogleGenAI, Modality, Type, type Session } from "@google/genai";
import { languageName } from "./i18n.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Pinned to a specific model, not the "-latest" alias: the alias silently repoints to the newest
// Flash (e.g. gemini-3.8-flash, free-tier cap of 20 requests/day), which starves autoplay/chat.
// The lite tier has its own, larger free-tier quota.
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash-lite";
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const TZ_OFFSET = Number(process.env.TZ_OFFSET ?? -3); // users' UTC offset in hours (Brasília = -3)
const PERSONA = "You are Gemini, a bot on a TeamSpeak server. Be short and direct.";

// The users' local date/time as "YYYY-MM-DD HH:MM (UTC-3)". Gemini has no clock of its own and
// answers in UTC otherwise, so the prompt carries the time at the moment the request/session starts.
export function localTime(offsetHours: number, now = new Date()): string {
  const t = new Date(now.getTime() + offsetHours * 3_600_000).toISOString();
  const sign = offsetHours < 0 ? "-" : "+";
  return `${t.slice(0, 10)} ${t.slice(11, 16)} (UTC${sign}${Math.abs(offsetHours)})`;
}
const clock = () =>
  ` The users' current local date and time is ${localTime(TZ_OFFSET)}; always give times in this timezone.`;

export async function ask(question: string): Promise<string> {
  const res = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: question,
    config: { systemInstruction: `${PERSONA}${clock()} Respond in ${languageName}. Use plain text, no markdown.` },
  });
  return res.text?.trim() || "(no answer)";
}

// Suggests up to `count` songs (each a "Artist - Title" search query) in a style similar to
// `nowPlaying`, avoiding the given titles. Asking for several in one call keeps autoplay's Gemini
// usage low (one request per batch instead of per song). Not user-facing, so it is not localized —
// each line goes straight into a YouTube search.
export async function suggestNextSongs(nowPlaying: string, avoid: string[], count = 5): Promise<string[]> {
  const res = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents:
      `A song is playing: "${nowPlaying}".\n` +
      `Suggest ${count} other songs in a similar genre, style and mood to play next.\n` +
      `Pick well-known, popular songs (hits and fan favorites people actually know, not obscure deep cuts), ` +
      `from the same era as the playing song or newer, mixing in recent hits when the style fits. ` +
      `Only real released studio tracks that exist on YouTube — no live versions, covers, remixes or compilations.\n` +
      (avoid.length ? `Do not repeat any of these: ${avoid.join("; ")}.\n` : "") +
      `Answer with ONLY the songs, one per line as "Artist - Title", no quotes, no numbering, no extra text.`,
    config: { systemInstruction: "You are a music recommender. Reply with one song per line and nothing else." },
  });
  return (res.text || "")
    .split("\n")
    .map((l) => l.replace(/^["'\s\-\d.]+|["']+$/g, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, count);
}

export interface LiveHandlers {
  audio: (pcm24k: Buffer) => void;
  turnComplete: () => void;
  interrupted: () => void;
  closed: () => void;
  onTool?: (name: string, args: any) => Promise<any>;
}

const searchParam = {
  type: Type.OBJECT,
  properties: {
    query: {
      type: Type.STRING,
      description: "Song title AND artist to search on YouTube (e.g. 'Meteoro Luan Santana'), never the title alone",
    },
  },
  required: ["query"],
};
const songsParam = {
  type: Type.OBJECT,
  properties: {
    queries: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "One or more songs to search on YouTube, in order, each as song title AND artist (e.g. 'Meteoro Luan Santana'), never the title alone. For a request like 'the 3 best songs by X' or 'play some Y', expand it yourself into that many specific songs — never a genre or playlist search like 'top hits'.",
    },
  },
  required: ["queries"],
};
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "play_music",
        description:
          "Normal request to play one or more songs. If something is already playing, they go to the queue; otherwise the first plays now and the rest queue. Accepts several songs at once ('play the 3 best songs by X'). Use for 'play', 'put on', 'add'.",
        parameters: songsParam,
      },
      {
        name: "play_now",
        description:
          "Play a song IMMEDIATELY, interrupting the current one. Use ONLY when the user explicitly says 'play now', 'put this on now', 'interrupt and play'.",
        parameters: searchParam,
      },
      {
        name: "add_to_queue",
        description:
          "Add one or more songs to the queue without interrupting what is playing. Accepts several at once. Use when asked to add/enqueue/queue song(s).",
        parameters: songsParam,
      },
      {
        name: "play_radio",
        description:
          "Play an online radio station (streaming). Use when the user asks for a radio station, by name or genre (e.g. lofi, jazz, rock, techno).",
        parameters: {
          type: Type.OBJECT,
          properties: { name: { type: Type.STRING, description: "Radio station name or genre" } },
          required: ["name"],
        },
      },
      {
        name: "remove_from_queue",
        description:
          "Remove a song from the queue. Use when asked to remove/take out/cancel a song from the queue. When the user refers to a song by number ('remove song 1', 'take out the third'), pass `position` — the number shown by list_queue (1 = next song); otherwise pass `query` with the name.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            position: { type: Type.INTEGER, description: "Queue position as numbered by list_queue (1 = next song)" },
            query: { type: Type.STRING, description: "Song name/artist to match in the queue" },
          },
        },
      },
      {
        name: "jump_to_queue",
        description:
          "Jump to a song that is already in the queue and play it now. Use when asked to switch/go/skip to a queued song ('switch to song 2', 'play number 3 of the queue', 'go to the Daft Punk one'). When the user refers to it by number, pass `position` — the number shown by list_queue (1 = next song); otherwise pass `query` with the name. For a song that is NOT in the queue, use play_now.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            position: { type: Type.INTEGER, description: "Queue position as numbered by list_queue (1 = next song)" },
            query: { type: Type.STRING, description: "Song name/artist to match in the queue" },
          },
        },
      },
      {
        name: "list_queue",
        description:
          "List the queued songs and write them to the channel text chat. Use when asked what is in the queue or what is coming up. The result includes an `autoplay` flag; when you confirm out loud, also say whether autoplay is on or off.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "write_chat",
        description:
          "Write a message to the TeamSpeak channel text chat. Use when asked to write/send something in the chat.",
        parameters: {
          type: Type.OBJECT,
          properties: { text: { type: Type.STRING, description: "The text to write in the chat" } },
          required: ["text"],
        },
      },
      {
        name: "skip_track",
        description: "Skip to the next song in the queue.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "stop_music",
        description:
          "Stop music playback for good: cancels the current song (it can't be continued later). Use ONLY when the person explicitly says stop/end the music. If they want to pause or hold it to continue later, use pause_music instead.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "clear_queue",
        description:
          "Clear the music queue: remove all upcoming songs (the current one keeps playing). Autoplay stays ON but pauses filling (it does not refill the cleared queue; it resumes when you play something again). Use when asked to clear/empty/wipe the queue.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "pause_music",
        description:
          "Pause the current song at its current position, so it can be continued later with resume_music. Use when the person says pause, hold on, wait a moment. Prefer this over stop_music unless they explicitly want to stop/cancel the music.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "resume_music",
        description:
          "Continue the paused song from where it was paused. Use when the person says resume, continue, unpause, play again after a pause.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "autoplay_on",
        description:
          "Turn on autoplay: automatically keep the queue filled with songs similar to the one playing, so the music never stops. Use when asked to enable autoplay or 'keep playing similar songs' / 'don't let it run out'.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "autoplay_off",
        description: "Turn off autoplay (stop auto-filling the queue).",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "now_playing",
        description:
          "Get the title of the song the music bot is playing right now. Call it whenever the person asks about the current song (what song is this, who sings it, what is it about, when was it released, etc.) — the song changes over time, so call it again on each such question. Then answer from your own knowledge of that song.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "end_conversation",
        description:
          "End the voice conversation right away. Use when the person says goodbye or signals they are done (e.g. 'bye', 'that's all', 'thanks, that's it'). Then say a very short goodbye.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
    ],
  },
];

export async function openLive(h: LiveHandlers): Promise<Session> {
  const ref: { s?: Session } = {};
  // The caller's speech as Gemini transcribed it; arrives in chunks, logged once per turn.
  let heard = "";
  const logHeard = () => {
    if (heard.trim()) console.log(`[heard] "${heard.trim()}"`);
    heard = "";
  };
  const session = await ai.live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction:
        PERSONA +
        clock() +
        ` You are speaking over voice, so be brief. Chat normally about anything (games, questions, small talk). You ALSO have tools to control the server's music bot, but use them ONLY when the person clearly asks for something music-related (play, queue, skip, radio, etc.). Never steer the conversation toward music or suggest playing something on your own — if the conversation is not about music, do not even mention it. If a music request names a song you can't pin down (an ambiguous title shared by several artists, a vague description like "that song from the movie", or a name you didn't catch), ask ONE short question offering the likely options before calling a tool; if the answer is still vague, play the best-known match. For open requests (a genre, a mood, "some songs by X"), don't ask — pick well-known songs yourself. Every song you pass to a tool is its title plus its artist, even in a list and even if the person only said the title: add the artist of the best-known version yourself. When the person says goodbye or is done, call end_conversation. If the person asks for several actions in one request (e.g. "turn off autoplay, clear the queue and play X"), call ALL the needed tools in the SAME turn, in the order they said them, then give a single short confirmation. After using a tool, confirm with a very short sentence. Respond in ${languageName}.`,
      tools: TOOLS as any,
      inputAudioTranscription: {}, // what Gemini heard, logged as [heard] to diagnose wrong songs
    },
    callbacks: {
      onopen: () => console.log(`[live] session open (${LIVE_MODEL})`),
      onmessage: async (m) => {
        if (m.setupComplete) console.log("[live] ready (setupComplete)");

        // Tool calls (e.g. play music)
        if (m.serverContent?.inputTranscription?.text) heard += m.serverContent.inputTranscription.text;

        if (m.toolCall?.functionCalls?.length) {
          logHeard(); // before the tool lines, so the log reads speech → tool → pick
          const functionResponses = [];
          for (const fc of m.toolCall.functionCalls) {
            console.log(`[tool] ${fc.name}(${JSON.stringify(fc.args)})`);
            let response: any;
            try {
              response = (await h.onTool?.(fc.name!, fc.args)) ?? { ok: true };
            } catch (e: any) {
              console.error("[tool] error:", e.message);
              response = { error: String(e.message || e) };
            }
            functionResponses.push({ id: fc.id, name: fc.name, response });
          }
          try {
            ref.s?.sendToolResponse({ functionResponses });
          } catch {
            // the session may have been closed by the command (one-shot); that's fine
          }
          return;
        }

        const c = m.serverContent;
        if (!c) return;
        if (c.interrupted) h.interrupted();
        let bytes = 0;
        for (const p of c.modelTurn?.parts ?? []) {
          if (p.inlineData?.data) {
            const buf = Buffer.from(p.inlineData.data, "base64");
            bytes += buf.length;
            h.audio(buf);
          }
        }
        if (bytes) console.log(`[live] replying (+${bytes} bytes of audio)`);
        if (c.turnComplete) {
          logHeard();
          console.log("[live] turn complete");
          h.turnComplete();
        }
      },
      onerror: (e) => console.error("[live] error:", e.message ?? e),
      onclose: (e) => {
        console.log("[live] closed:", e?.reason || "(no reason)");
        h.closed();
      },
    },
  });
  ref.s = session;
  return session;
}
