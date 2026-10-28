// Integration with the TS6 Manager backend: ask the music bot to play something.
const BASE = process.env.MANAGER_URL || "http://backend:3001/api";
const USER = process.env.MANAGER_USER;
const PASS = process.env.MANAGER_PASS;
const BOT_NAME = (process.env.MUSIC_BOT_NAME || "DJ Morri").toLowerCase();

let token: string | null = null;
let botId: number | null = null;
let configId: number | null = null;

async function login(): Promise<void> {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  token = (await r.json()).accessToken;
  if (!token) throw new Error("login returned no accessToken");
}

async function api(path: string, init: RequestInit, retry = true): Promise<Response> {
  if (!token) await login();
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (r.status === 401 && retry) {
    token = null;
    return api(path, init, false);
  }
  return r;
}

async function findBot(): Promise<{ id: number; configId: number }> {
  if (botId != null && configId != null) return { id: botId, configId };
  const r = await api("/music-bots", { method: "GET" });
  if (!r.ok) throw new Error(`music-bots ${r.status}`);
  const list = await r.json();
  const bot = (Array.isArray(list) ? list : []).find((b: any) =>
    String(b.name || "")
      .toLowerCase()
      .includes(BOT_NAME),
  );
  if (!bot) throw new Error(`music bot "${process.env.MUSIC_BOT_NAME}" not found`);
  botId = bot.id;
  configId = bot.serverConfig?.id ?? bot.serverConfigId ?? null;
  return { id: botId!, configId: configId! };
}

async function ok(r: Response, what: string) {
  if (!r.ok) throw new Error(`${what} ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r;
}

// Simple controls (no body): skip, stop-playback, pause, resume, previous.
async function control(path: string): Promise<void> {
  const { id } = await findBot();
  await ok(await api(`/music-bots/${id}/${path}`, { method: "POST" }), path);
}
export const skip = () => control("skip");
export const stop = () => control("stop-playback");
export const pause = () => control("pause");
export const resume = () => control("resume");
export const previous = () => control("previous");

function requireCreds() {
  if (!USER || !PASS) throw new Error("MANAGER_USER/MANAGER_PASS not set in .env");
}

// Play now (interrupting the current one) a song by name. Returns the title.
export async function playMusic(query: string): Promise<string> {
  requireCreds();
  const { id } = await findBot();
  const r = await ok(
    await api(`/music-bots/${id}/play-url`, { method: "POST", body: JSON.stringify({ url: `ytsearch1:${query}` }) }),
    "play-url",
  );
  const j: any = await r.json().catch(() => ({}));
  return j?.queueItem?.title || query;
}

// Play the song NOW without losing the queue: snapshot the upcoming songs, add and play the new
// one, then re-enqueue the upcoming songs after it. (The Manager has no "insert as next".)
export async function playNowKeepQueue(query: string): Promise<void> {
  requireCreds();
  const { id } = await findBot();
  // snapshot of the upcoming songs (only items with a library id, which can be re-enqueued)
  const st: any = await (await ok(await api(`/music-bots/${id}/state`, { method: "GET" }), "state")).json();
  const items: any[] = st.queue || [];
  const np = st.nowPlaying?.title || null;
  let idx =
    typeof st.currentIndex === "number" && st.currentIndex >= 0
      ? st.currentIndex
      : np
        ? items.map((i) => i.title).lastIndexOf(np)
        : -1;
  const reAddIds: string[] = (idx >= 0 ? items.slice(idx + 1) : [])
    .map((i) => String(i.id))
    .filter((x) => /^\d+$/.test(x));

  await enqueueMusic(query); // add the new one at the end (library id)
  const q2: any = await (await ok(await api(`/music-bots/${id}/queue`, { method: "GET" }), "queue")).json();
  const last = (q2.items || []).length - 1;
  if (last >= 0) await ok(await api(`/music-bots/${id}/queue/${last}/play`, { method: "POST" }), "queue-play");
  for (const sid of reAddIds) {
    await api(`/music-bots/${id}/queue`, { method: "POST", body: JSON.stringify({ songId: sid }) }).catch(() => {});
  }
}

// What's playing + only the UPCOMING songs (after the current index; the Manager queue also keeps
// the ones already played).
export async function getQueue(): Promise<{ nowPlaying: string | null; upcoming: string[] }> {
  requireCreds();
  const { id } = await findBot();
  const r = await ok(await api(`/music-bots/${id}/state`, { method: "GET" }), "state");
  const s: any = await r.json();
  const titles: string[] = (s.queue || []).map((i: any) => i.title || "?");
  const nowPlaying = s.nowPlaying?.title || null;
  // currentIndex often comes as -1; locate the current song by title (the played ones come before it).
  let idx = typeof s.currentIndex === "number" && s.currentIndex >= 0 ? s.currentIndex : -1;
  if (idx < 0 && nowPlaying) idx = titles.lastIndexOf(nowPlaying);
  const upcoming = idx >= 0 ? titles.slice(idx + 1) : [];
  return { nowPlaying, upcoming };
}

// Remove from the queue (among the upcoming songs) the first one whose title matches the search.
export async function removeFromQueue(query: string): Promise<string> {
  requireCreds();
  const { id } = await findBot();
  const st: any = await (await ok(await api(`/music-bots/${id}/state`, { method: "GET" }), "state")).json();
  const items: any[] = st.queue || [];
  const np = st.nowPlaying?.title || null;
  const idx =
    typeof st.currentIndex === "number" && st.currentIndex >= 0
      ? st.currentIndex
      : np
        ? items.map((i) => i.title).lastIndexOf(np)
        : -1;
  const n = query.toLowerCase().trim();
  let found = -1;
  for (let i = idx + 1; i < items.length; i++) {
    if (
      String(items[i].title || "")
        .toLowerCase()
        .includes(n)
    ) {
      found = i;
      break;
    }
  }
  if (found < 0) throw new Error(`"${query}" is not in the queue`);
  const title = items[found].title || query;
  await ok(await api(`/music-bots/${id}/queue/${found}`, { method: "DELETE" }), "remove");
  return title;
}

// true if something is already playing/paused → a "play" should enqueue instead of overriding.
export async function shouldQueue(): Promise<boolean> {
  requireCreds();
  const { id } = await findBot();
  const r = await ok(await api(`/music-bots/${id}/state`, { method: "GET" }), "state");
  const s: any = await r.json();
  return s.status === "playing" || s.status === "paused" || !!s.nowPlaying;
}

// Play a radio station (streaming) by name or genre. Returns the station name.
export async function playRadio(name: string): Promise<string> {
  requireCreds();
  const { id, configId } = await findBot();
  const r = await ok(await api(`/servers/${configId}/radio-stations`, { method: "GET" }), "radio-stations");
  const res = await r.json();
  const list: any[] = Array.isArray(res) ? res : res.stations || [];
  const n = name.toLowerCase().trim();
  const st =
    list.find((s) =>
      String(s.name || "")
        .toLowerCase()
        .includes(n),
    ) ||
    list.find((s) =>
      String(s.genre || "")
        .toLowerCase()
        .includes(n),
    );
  if (!st) throw new Error(`radio "${name}" not found`);
  await ok(
    await api(`/music-bots/${id}/play-radio`, { method: "POST", body: JSON.stringify({ stationId: st.id }) }),
    "play-radio",
  );
  return st.name;
}

// Add to the queue (without interrupting): search on YouTube → download to library → enqueue.
export async function enqueueMusic(query: string): Promise<string> {
  requireCreds();
  const { id, configId } = await findBot();
  const lib = `/servers/${configId}/music-library/youtube`;
  const sr = await ok(await api(`${lib}/search`, { method: "POST", body: JSON.stringify({ query }) }), "search");
  const results = await sr.json();
  const first = (Array.isArray(results) ? results : results.results || [])[0];
  if (!first?.id) throw new Error("nothing found on YouTube");
  const url = `https://www.youtube.com/watch?v=${first.id}`;
  const dr = await ok(await api(`${lib}/download`, { method: "POST", body: JSON.stringify({ url }) }), "download");
  const song: any = await dr.json();
  const songId = song?.id ?? song?.song?.id;
  if (!songId) throw new Error("download returned no songId");
  await ok(await api(`/music-bots/${id}/queue`, { method: "POST", body: JSON.stringify({ songId }) }), "queue");
  return first.title || query;
}
