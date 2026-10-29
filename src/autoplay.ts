// Autoplay: while a song is playing, keep the queue topped up with similar songs (chosen by
// Gemini) so playback never stops. It stays AHEAD of the current song, so the next one is already
// downloaded before the current ends — no silent gap. Toggled by voice (autoplay_on/off).
import { getQueue, enqueueMusic, playMusic } from "./manager.js";
import { suggestNextSong } from "./gemini.js";

const env = process.env;

export function initAutoplay() {
  const AHEAD = Number(env.AUTOPLAY_QUEUE_AHEAD || 1); // keep this many songs queued ahead
  const POLL_MS = Number(env.AUTOPLAY_POLL_MS || 15000);
  let enabled = env.AUTOPLAY === "1";
  const recent: string[] = []; // titles played/added, lowercased — to avoid repeats (bounded)
  let running = false; // skip a tick while a download from the previous one is still in flight

  function remember(title: string) {
    const t = title.toLowerCase();
    if (!recent.includes(t)) recent.push(t);
    while (recent.length > 40) recent.shift();
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
        // similar song. Seed from the last thing we heard; on a cold start with no history, stay
        // silent until someone plays something first (don't blast music out of nowhere on boot).
        // ponytail: while autoplay is on this also "fights" an explicit stop (resumes within a
        // poll); turning autoplay off is the way to get silence.
        const seed = recent[recent.length - 1];
        if (!seed) return;
        const pick = await suggestNextSong(seed, recent.slice(-20));
        if (!pick) return;
        remember(pick);
        const title = await playMusic(pick);
        remember(title);
        console.log(`[autoplay] restarted playback with "${title}" (seed: "${seed}")`);
        return;
      }

      // Playing: keep the queue one song ahead so the next is ready before the current ends.
      if (upcoming.length >= AHEAD) return;
      const pick = await suggestNextSong(nowPlaying, recent.slice(-20));
      if (!pick) return;
      remember(pick); // avoid re-picking it before it shows up in the queue
      const title = await enqueueMusic(pick);
      remember(title);
      console.log(`[autoplay] queued "${title}" (seed: "${nowPlaying}")`);
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
