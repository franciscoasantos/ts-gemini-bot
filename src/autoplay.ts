// Autoplay: while a song is playing, keep the queue topped up with similar songs (chosen by
// Gemini) so playback never stops. It stays AHEAD of the current song, so the next one is already
// downloaded before the current ends — no silent gap. Toggled by voice (autoplay_on/off).
import { getQueue, enqueueMusic, playMusic } from "./manager.js";
import { suggestNextSongs } from "./gemini.js";

const env = process.env;

export function initAutoplay() {
  const AHEAD = Number(env.AUTOPLAY_QUEUE_AHEAD || 2); // refill once the queue drops below this
  const BATCH = Number(env.AUTOPLAY_BATCH || 5); // songs fetched per Gemini call (fewer calls)
  const POLL_MS = Number(env.AUTOPLAY_POLL_MS || 15000);
  let enabled = env.AUTOPLAY === "1";
  const recent: string[] = []; // titles played/added, lowercased — to avoid repeats (bounded)
  let running = false; // skip a tick while a download from the previous one is still in flight

  function remember(title: string) {
    const t = title.toLowerCase();
    if (!recent.includes(t)) recent.push(t);
    while (recent.length > 40) recent.shift();
  }

  // Enqueue one song, remembering its real title; a bad/unplayable suggestion is logged and skipped
  // so it doesn't abort the rest of the batch. Returns whether it was queued.
  async function enqueueSafe(query: string): Promise<boolean> {
    try {
      remember(await enqueueMusic(query));
      return true;
    } catch (e: any) {
      console.error("[autoplay] enqueue failed:", e.message);
      return false;
    }
  }

  async function tick() {
    if (!enabled || running) return;
    running = true;
    try {
      const { nowPlaying, upcoming } = await getQueue();
      if (nowPlaying) remember(nowPlaying);
      upcoming.forEach(remember);

      if (!nowPlaying) {
        // Playback stopped (a song ended/failed, or the queue ran out). The Manager advances on
        // its own while playing but stays stopped once it halts, so restart it with a fresh
        // similar song and queue the rest of the batch behind it. Seed from the last thing we
        // heard; on a cold start with no history, stay silent until someone plays something first
        // (don't blast music out of nowhere on boot).
        // ponytail: while autoplay is on this also "fights" an explicit stop (resumes within a
        // poll); turning autoplay off is the way to get silence.
        const seed = recent[recent.length - 1];
        if (!seed) return;
        const [first, ...rest] = await suggestNextSongs(seed, recent.slice(-20), BATCH);
        if (!first) return;
        remember(first);
        remember(await playMusic(first));
        for (const s of rest) await enqueueSafe(s);
        console.log(`[autoplay] restarted with "${first}" + queued ${rest.length} (seed: "${seed}")`);
        return;
      }

      // Playing: refill in one batch when the queue runs low, so the next songs are ready before
      // the current ends and Gemini is called once per batch rather than once per song.
      if (upcoming.length >= AHEAD) return;
      const picks = await suggestNextSongs(nowPlaying, recent.slice(-20), BATCH);
      let queued = 0;
      for (const s of picks) {
        remember(s); // avoid re-picking it before it shows up in the queue
        if (await enqueueSafe(s)) queued++;
      }
      if (queued) console.log(`[autoplay] queued ${queued} (seed: "${nowPlaying}")`);
    } catch (e: any) {
      console.error("[autoplay]", e.message);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, POLL_MS);
  timer.unref?.();

  function setEnabled(on: boolean) {
    enabled = on;
    console.log(`[autoplay] ${on ? "on" : "off"}`);
  }
  return {
    setEnabled,
    toggle: () => (setEnabled(!enabled), enabled),
    isEnabled: () => enabled,
    stop: () => clearInterval(timer),
  };
}
