import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Ts3Client, buildCommand, generateIdentity, restoreIdentity, type ParsedCommand } from "./tslib/index.js";
import { ask } from "./gemini.js";
import { uploadAvatar } from "./filetransfer.js";
import { initVoice } from "./voice.js";
import { initAutoplay } from "./autoplay.js";
import { t } from "./i18n.js";

const env = process.env;
for (const k of ["TS_HOST", "GEMINI_API_KEY", "KWS_DIR"]) {
  if (!env[k]) throw new Error(`Missing ${k} in .env (see .env.example)`);
}

function loadIdentity() {
  const file = env.IDENTITY_FILE || "identity.json";
  if (existsSync(file)) return restoreIdentity(JSON.parse(readFileSync(file, "utf8")));
  console.log("Generating identity (first run only)...");
  const id = generateIdentity(8);
  const { privateKeyBigInt, keyOffset, publicKeyString, uid } = id;
  writeFileSync(
    file,
    JSON.stringify({ privateKeyBigInt: String(privateKeyBigInt), keyOffset: String(keyOffset), publicKeyString, uid }),
  );
  return id;
}

const client = new Ts3Client();
const identity = loadIdentity();

// ---------- Connection ----------
let retry: NodeJS.Timeout | undefined;
const reconnect = () => {
  clearTimeout(retry);
  retry = setTimeout(connect, 5000);
};
async function connect() {
  try {
    await client.connect({
      host: env.TS_HOST!,
      port: Number(env.TS_PORT || 9987),
      identity,
      nickname: env.TS_NICK || "Gemini",
      serverPassword: env.TS_SERVER_PASSWORD || undefined,
      defaultChannel: env.TS_CHANNEL || undefined,
      channelPassword: env.TS_CHANNEL_PASSWORD || undefined,
    });
    console.log(`Connected to ${env.TS_HOST} (clid ${client.getClientId()})`);
    setTimeout(setAvatarOnce, 2500);
  } catch (e: any) {
    console.error("Failed to connect:", e.message);
    reconnect();
  }
}
// Sets the bot's profile picture once (file AVATAR_FILE, default ./avatar.png).
let avatarDone = false;
async function setAvatarOnce() {
  if (avatarDone) return;
  const file = env.AVATAR_FILE || "avatar.png";
  if (!existsSync(file)) return;
  avatarDone = true; // try once per process (don't repeat on every reconnect)
  try {
    await uploadAvatar(client, env.TS_HOST!, readFileSync(file));
    console.log("[avatar] set");
  } catch (e: any) {
    console.error("[avatar] failed:", e.message);
  }
}

client.on("error", (e: Error) => console.error("[ts]", e.message));
client.on("ts3error", (p: Record<string, string>) => p.id !== "0" && console.error("[ts]", p.id, p.msg));

// Tracks each client's nickname, to ignore the music bot's voice (it plays in the channel and the
// music would arrive as "speech", disturbing/wasting wake-word detection).
const nameByClid = new Map<number, string>();
const IGNORE = (env.IGNORE_SPEAKERS || env.MUSIC_BOT_NAME || "DJ Morri")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
client.on("command", (p: ParsedCommand) => {
  if (p.name === "notifycliententerview" || p.name === "notifyclientupdated") {
    // enterview carries clid; clientupdated (nickname change while playing) too — keeps the name fresh
    for (const g of p.groups ?? [p.params]) {
      const clid = Number(g.clid);
      if (clid && g.client_nickname !== undefined) {
        nameByClid.set(clid, String(g.client_nickname).toLowerCase());
      }
    }
  } else if (p.name === "notifyclientleftview") {
    for (const g of p.groups ?? [p.params]) nameByClid.delete(Number(g.clid));
  }
});
function isIgnored(clid: number): boolean {
  const nick = nameByClid.get(clid) || "";
  return !!nick && IGNORE.some((x) => nick.includes(x));
}

// ---------- Text: !gemini in the channel, anything in private ----------
function sendText(targetmode: number, target: number, text: string) {
  for (let i = 0; i < text.length; i += 900) {
    client.sendCommand(buildCommand("sendtextmessage", { targetmode, target, msg: text.slice(i, i + 900) }));
  }
}

client.on("textMessage", async (p: Record<string, string>) => {
  const from = Number(p.invokerid);
  if (from === client.getClientId()) return;
  const mode = Number(p.targetmode);
  const [tm, target] = mode === 1 ? [1, from] : [2, 0];

  // The music bot's own !stop (typed by a user) stops playback directly, bypassing our stop_music
  // tool — so autoplay wouldn't know and would revive the music. Watch for it and mark the stop as
  // intentional; we don't stop anything ourselves (the music bot already does).
  if (/^!stop\b/i.test(p.msg.trim())) {
    autoplay.onUserStop();
    return;
  }

  // !autoplay [on|off] — toggles if no argument. Works in channel and private, no Live quota needed.
  const ap = /^!autoplay(?:\s+(on|off|1|0))?\s*$/i.exec(p.msg.trim());
  if (ap) {
    const arg = ap[1]?.toLowerCase();
    const on = arg ? arg === "on" || arg === "1" : autoplay.toggle();
    if (arg) autoplay.setEnabled(on);
    sendText(tm, target, t.autoplay(on));
    return;
  }

  let q: string;
  if (mode === 1) q = p.msg;
  else if (mode === 2 && /^!gemini\b/i.test(p.msg)) q = p.msg.replace(/^!gemini\s*/i, "");
  else return;
  if (!q.trim()) return;
  try {
    sendText(tm, target, await ask(q));
  } catch (e: any) {
    console.error("[gemini]", e.message);
    sendText(tm, target, t.geminiError);
  }
});

// ---------- Voice: wake word + Gemini Live (pipeline in voice.ts) ----------
const autoplay = initAutoplay();
const voice = initVoice(client, {
  sendText,
  isIgnored,
  setAutoplay: autoplay.setEnabled,
  isAutoplayOn: autoplay.isEnabled,
  onUserStop: autoplay.onUserStop,
});
client.on("voice", voice.onVoice);
client.on("disconnected", () => {
  voice.reset(); // clear any stuck conversation before coming back
  reconnect();
});

// Disconnect cleanly on both Ctrl-C (SIGINT) and Docker stop (SIGTERM),
// otherwise the server keeps the client as a ghost "clone" on the next start.
function shutdown() {
  client.removeListener("disconnected", reconnect);
  client.disconnect();
  setTimeout(() => process.exit(0), 700);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await connect();
