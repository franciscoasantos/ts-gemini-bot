import { GoogleGenAI, Modality, Type, type Session } from "@google/genai";
import { languageName } from "./i18n.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-flash-latest";
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const PERSONA = "You are Gemini, a bot on a TeamSpeak server. Be short and direct.";

export async function ask(question: string): Promise<string> {
  const res = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: question,
    config: { systemInstruction: `${PERSONA} Respond in ${languageName}. Use plain text, no markdown.` },
  });
  return res.text?.trim() || "(no answer)";
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
  properties: { query: { type: Type.STRING, description: "Song name and/or artist to search on YouTube" } },
  required: ["query"],
};
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "play_music",
        description:
          "Normal request to play a song. If something is already playing, add it to the queue; if nothing is playing, play it now. Use for 'play', 'put on', 'add' a song.",
        parameters: searchParam,
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
          "Add a song to the queue without interrupting what is playing. Use when asked to add/enqueue/queue a song.",
        parameters: searchParam,
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
          "Remove a song from the queue by name. Use when asked to remove/take out/cancel a song from the queue.",
        parameters: searchParam,
      },
      {
        name: "list_queue",
        description:
          "List the queued songs and write them to the channel text chat. Use when asked what is in the queue, what is coming up, or what is playing.",
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
      { name: "stop_music", description: "Stop music playback.", parameters: { type: Type.OBJECT, properties: {} } },
      {
        name: "pause_music",
        description: "Pause the current song.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "resume_music",
        description: "Resume the paused song.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
    ],
  },
];

export async function openLive(h: LiveHandlers): Promise<Session> {
  const ref: { s?: Session } = {};
  const session = await ai.live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction:
        PERSONA +
        ` You are speaking over voice, so be brief. Chat normally about anything (games, questions, small talk). You ALSO have tools to control the server's music bot, but use them ONLY when the person clearly asks for something music-related (play, queue, skip, radio, etc.). Never steer the conversation toward music or suggest playing something on your own — if the conversation is not about music, do not even mention it. After using a tool, confirm with a very short sentence. Respond in ${languageName}.`,
      tools: TOOLS as any,
    },
    callbacks: {
      onopen: () => console.log(`[live] session open (${LIVE_MODEL})`),
      onmessage: async (m) => {
        if (m.setupComplete) console.log("[live] ready (setupComplete)");

        // Tool calls (e.g. play music)
        if (m.toolCall?.functionCalls?.length) {
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
