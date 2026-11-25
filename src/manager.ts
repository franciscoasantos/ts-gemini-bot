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

export interface SearchResult {
  id: string;
  title: string;
  artist: string; // uploader/channel
  duration: number; // seconds, 0 = unknown
}

// Words that mark a result as "not the song itself", unless the user asked for it.
const JUNK =
  /\b(reaction|react|reagindo|cover|karaoke|tutorial|aula|como tocar|lesson|instrumental|8d|slowed|sped up|nightcore|bass boosted|remix|live|ao vivo|1 hour|10 hours|full album|album completo|mix|playlist|podcast|review|interview|entrevista|trailer|shorts)\b/i;

// Rank results by how likely each is the song the user wants, best first. YouTube's own rank is
// the base; junk words, non-song durations, medleys ("A / B") and poor query overlap push a result
// down; official sources ("- Topic", VEVO, "official") and an uploader channel named in the query
// (the artist's own channel, not a cover channel that only names them in the title) push it up.
// ponytail: keyword heuristic, no view counts (the Manager's search drops them); add a view_count
// field upstream in the Manager if popularity ranking is ever needed.
export function rankResults(query: string, results: SearchResult[]): { result: SearchResult; score: number }[] {
  const q = query.toLowerCase();
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  const wantsLong = /\b(mix|album|hour|hora|playlist)\b/.test(q);
  const ranked: { result: SearchResult; score: number }[] = [];
  results.forEach((r, i) => {
    if (!/^[A-Za-z0-9_-]{11}$/.test(r.id)) return; // channels/playlists aren't playable songs
    const title = r.title.toLowerCase();
    const artist = r.artist.toLowerCase();
    const channel = artist.replace(/ - topic$|vevo|oficial|official/g, "");
    let s = -i; // keep YouTube's relevance order as the tie-breaker
    const junk = title.match(JUNK)?.[0];
    if (junk && !q.includes(junk.toLowerCase())) s -= 6;
    if (r.duration && !wantsLong && (r.duration < 60 || r.duration > 600)) s -= 5;
    if (title.includes(" / ") && !q.includes("/")) s -= 4; // medley of several songs
    if (/ - topic$|vevo/.test(artist)) s += 3;
    if (/official|oficial/.test(title)) s += 2;
    if (words.some((w) => channel.includes(w))) s += 2;
    if (words.length) s += (4 * words.filter((w) => title.includes(w) || artist.includes(w)).length) / words.length;
    ranked.push({ result: r, score: s });
  });
  return ranked.sort((a, b) => b.score - a.score); // stable: ties keep YouTube's order
}

export const pickBestResult = (query: string, results: SearchResult[]): SearchResult | undefined =>
  rankResults(query, results)[0]?.result;

// Search YouTube via the Manager and return the best-matching result.
async function findBest(query: string): Promise<SearchResult> {
  const { configId } = await findBot();
  const sr = await ok(
    await api(`/servers/${configId}/music-library/youtube/search`, { method: "POST", body: JSON.stringify({ query }) }),
    "search",
  );
  const results = await sr.json();
  const ranked = rankResults(query, Array.isArray(results) ? results : results.results || []);
  const best = ranked[0]?.result;
  if (!best) throw new Error("nothing found on YouTube");
  console.log(`[music] "${query}" → "${best.title}" (${best.artist})`);
  // The runners-up with their scores, to tell a picker mistake from a bad query in the logs.
  for (const { result, score } of ranked.slice(0, 3))
    console.log(`[music]   ${score.toFixed(1)} "${result.title}" (${result.artist})`);
  return best;
}

// Play now (interrupting the current one) a song by name. Returns the title.
export async function playMusic(query: string): Promise<string> {
  requireCreds();
  const { id } = await findBot();
  const best = await findBest(query);
  const url = `https://www.youtube.com/watch?v=${best.id}`;
  const r = await ok(
    await api(`/music-bots/${id}/play-url`, { method: "POST", body: JSON.stringify({ url }) }),
    "play-url",
  );
  const j: any = await r.json().catch(() => ({}));
  return j?.queueItem?.title || best.title || query;
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

// Manager queue index of an upcoming song, or -1. `target` is either the 1-based position as
// numbered by list_queue (1 = next song after the current one) or a title search.
export function findQueueIndex(titles: string[], currentIdx: number, target: string | number): number {
  if (typeof target === "number") {
    const i = currentIdx + target;
    return Number.isInteger(target) && target >= 1 && i < titles.length ? i : -1;
  }
  const n = target.toLowerCase().trim();
  for (let i = currentIdx + 1; i < titles.length; i++) if (titles[i].toLowerCase().includes(n)) return i;
  return -1;
}

// Resolve an upcoming song (list_queue position or title) to its Manager queue index + title.
async function findUpcoming(target: string | number): Promise<{ id: number; index: number; title: string }> {
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
  const index = findQueueIndex(
    items.map((i) => String(i.title || "")),
    idx,
    target,
  );
  if (index < 0) throw new Error(`"${target}" is not in the queue`);
  return { id, index, title: items[index].title || String(target) };
}

// Remove an upcoming song by its list_queue position (number) or by title (string).
export async function removeFromQueue(target: string | number): Promise<string> {
  const { id, index, title } = await findUpcoming(target);
  await ok(await api(`/music-bots/${id}/queue/${index}`, { method: "DELETE" }), "remove");
  return title;
}

// Jump to an upcoming song (list_queue position or title) and play it now. The songs jumped over
// stay behind as already played, like a skip.
export async function jumpToQueue(target: string | number): Promise<string> {
  const { id, index, title } = await findUpcoming(target);
  await ok(await api(`/music-bots/${id}/queue/${index}/play`, { method: "POST" }), "queue-play");
  return title;
}

// Clear the queue: remove every upcoming song (the current one keeps playing). Returns how many
// were removed. Deletes high → low so the indices don't shift under us.
export async function clearQueue(): Promise<number> {
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
  let removed = 0;
  for (let i = items.length - 1; i > idx; i--) {
    const r = await api(`/music-bots/${id}/queue/${i}`, { method: "DELETE" });
    if (r.ok) removed++;
  }
  return removed;
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
  const first = await findBest(query);
  const url = `https://www.youtube.com/watch?v=${first.id}`;
  const dr = await ok(await api(`${lib}/download`, { method: "POST", body: JSON.stringify({ url }) }), "download");
  const song: any = await dr.json();
  const songId = song?.id ?? song?.song?.id;
  if (!songId) throw new Error("download returned no songId");
  await ok(await api(`/music-bots/${id}/queue`, { method: "POST", body: JSON.stringify({ songId }) }), "queue");
  return first.title || query;
}

// Plays/queues each song on its own: one failing song doesn't cancel the rest of the list. Until one
// plays (when `playFirst`), the next song tries to play instead of queuing behind a failed one.
// Returns the queries that failed.
export async function playEach(
  queries: string[],
  playFirst: boolean,
  play: (q: string) => Promise<unknown> = playMusic,
  enqueue: (q: string) => Promise<unknown> = enqueueMusic,
): Promise<string[]> {
  const failed: string[] = [];
  let needPlay = playFirst;
  for (const q of queries) {
    try {
      if (needPlay) await play(q);
      else await enqueue(q);
      needPlay = false;
    } catch (e: any) {
      console.error(`[tool] "${q}" failed:`, e.message);
      failed.push(q);
    }
  }
  return failed;
}
