// User-facing language for what the bot says/writes. Everything else (code, logs, docs) is English.
// Set BOT_LANGUAGE to a locale code below; an unknown code still works (Gemini is told the raw
// value as the language name), but the bot-written strings fall back to English.
const BOT_LANGUAGE = process.env.BOT_LANGUAGE || "pt-BR";

interface Strings {
  name: string; // language name injected into the Gemini prompt
  nowPlaying: (title: string) => string;
  upcoming: string;
  queueEmpty: string;
  noUpcoming: string;
  andMore: (n: number) => string;
  geminiError: string;
  autoplay: (on: boolean) => string;
}

const LOCALES: Record<string, Strings> = {
  "pt-BR": {
    name: "Brazilian Portuguese",
    nowPlaying: (title) => `▶ Tocando: ${title}`,
    upcoming: "🎵 Próximas:",
    queueEmpty: "A fila está vazia.",
    noUpcoming: "(sem próximas na fila)",
    andMore: (n) => `… e mais ${n}`,
    geminiError: "Deu erro falando com o Gemini.",
    autoplay: (on) => (on ? "🔁 Autoplay ligado." : "⏹ Autoplay desligado."),
  },
  en: {
    name: "English",
    nowPlaying: (title) => `▶ Now playing: ${title}`,
    upcoming: "🎵 Up next:",
    queueEmpty: "The queue is empty.",
    noUpcoming: "(nothing else queued)",
    andMore: (n) => `… and ${n} more`,
    geminiError: "Something went wrong talking to Gemini.",
    autoplay: (on) => (on ? "🔁 Autoplay on." : "⏹ Autoplay off."),
  },
};

export const t: Strings = LOCALES[BOT_LANGUAGE] ?? LOCALES.en;
export const languageName: string = LOCALES[BOT_LANGUAGE]?.name ?? BOT_LANGUAGE;
