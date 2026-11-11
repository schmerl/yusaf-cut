import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { prepareFillerAudition, releaseFillerAudition } from "@/lib/ipc";
import type { Project } from "@/lib/edl";
import { usePlayerStore } from "@/stores/playerStore";
import { useVideoFrameClock } from "@/hooks/useVideoFrameClock";

export interface RenderedPlaybackSession {
  project: Project;
  start: number;
  end: number;
}
// Bound decoding work even when the source recording is very long. Only the
// current window and its successor are prepared; edits use the preview renderer.
const WINDOW_SECONDS = 20;
interface WindowClip {
  id: string;
  start: number;
  end: number;
  path: string;
}

export function RenderedTimelinePlayback({
  session,
  playing,
  suspended,
  onFailure,
}: {
  session: RenderedPlaybackSession;
  playing: boolean;
  suspended: boolean;
  onFailure: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [clip, setClip] = useState<WindowClip | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const muted = usePlayerStore((s) => s.muted);
  const rate = usePlayerStore((s) => s.rate);
  const intent = useRef({ playing, suspended });
  intent.current = { playing, suspended };
  const tick = useRef<(time: number) => void>(() => {});
  const advance = useRef<(id: string) => void>(() => {});
  const requests = useRef(new Set<string>());

  useEffect(() => {
    const el = video.current;
    let cancelled = false;
    let advancing = false;
    let current: WindowClip | null = null;
    let next: Promise<WindowClip> | null = null;
    const ids = requests.current;
    const prepare = async (start: number): Promise<WindowClip> => {
      const id = crypto.randomUUID();
      const end = Math.min(session.end, start + WINDOW_SECONDS);
      ids.add(id);
      const result = await prepareFillerAudition(session.project, start, end, id);
      return { id, start, end, path: result.path };
    };
    const failed = (reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
      usePlayerStore.getState().setPlaying(false);
      onFailure();
    };
    const prefetch = () => {
      next = current && current.end < session.end - 1e-8 ? prepare(current.end) : null;
      // A successor may fail before playback reaches it. Report the error if
      // it is needed, without an unhandled rejection or resuming stale media.
      void next?.catch(() => {});
    };
    advance.current = (id) => {
      if (cancelled || advancing || !current || !intent.current.playing || intent.current.suspended)
        return;
      if (current.id !== id) return;
      usePlayerStore.getState().setCurrentTime(current.end);
      el?.pause();
      if (!next) {
        usePlayerStore.getState().setPlaying(false);
        return;
      }
      advancing = true;
      setLoading(true);
      const previous = current;
      void next
        .then((value) => {
          if (cancelled) return;
          current = value;
          setClip(value);
          prefetch();
          ids.delete(previous.id);
          void releaseFillerAudition(previous.id).catch(() => {});
          advancing = false;
        })
        .catch(failed);
    };
    setClip(null);
    setError("");
    setLoading(true);
    void prepare(session.start)
      .then((value) => {
        if (cancelled) return;
        current = value;
        setClip(value);
        prefetch();
      })
      .catch(failed);
    return () => {
      cancelled = true;
      advance.current = () => {};
      tick.current = () => {};
      el?.pause();
      for (const id of ids) void releaseFillerAudition(id).catch(() => {});
      ids.clear();
    };
  }, [session, onFailure]);

  useEffect(() => {
    const el = video.current;
    if (!el || !clip) return;
    let cancelled = false;
    let ready = false;
    const play = () => {
      if (cancelled) return;
      ready = true;
      setLoading(false);
      if (!intent.current.playing || intent.current.suspended) return;
      void el
        .play()
        .then(() => {
          if (cancelled || !intent.current.playing || intent.current.suspended) el.pause();
        })
        .catch((reason: Error) => {
          if (cancelled || !intent.current.playing || reason.name === "AbortError") return;
          setError(reason.message);
          usePlayerStore.getState().setPlaying(false);
          onFailure();
        });
    };
    tick.current = (time) => {
      if (cancelled || !ready || el.seeking || intent.current.suspended) return;
      usePlayerStore.getState().setCurrentTime(Math.min(clip.end, clip.start + time));
      if (time >= clip.end - clip.start && intent.current.playing) advance.current(clip.id);
    };
    const update = () => tick.current(el.currentTime);
    const ended = () => advance.current(clip.id);
    const failed = () => {
      if (cancelled) return;
      setError(el.error?.message || "The edited playback window could not be loaded.");
      setLoading(false);
      usePlayerStore.getState().setPlaying(false);
      onFailure();
    };
    el.addEventListener("canplay", play);
    el.addEventListener("timeupdate", update);
    el.addEventListener("ended", ended);
    el.addEventListener("error", failed);
    el.src = convertFileSrc(clip.path);
    el.load();
    if (el.readyState >= 3) play();
    return () => {
      cancelled = true;
      el.pause();
      el.removeEventListener("canplay", play);
      el.removeEventListener("timeupdate", update);
      el.removeEventListener("ended", ended);
      el.removeEventListener("error", failed);
    };
  }, [clip, onFailure]);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.muted = muted;
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
    if (!playing || suspended) el.pause();
    else if (el.getAttribute("src") && el.readyState >= 3 && !error) {
      void el
        .play()
        .then(() => {
          if (!intent.current.playing || intent.current.suspended) el.pause();
        })
        .catch((reason: Error) => {
          if (!intent.current.playing || reason.name === "AbortError") return;
          setError(reason.message);
          usePlayerStore.getState().setPlaying(false);
          onFailure();
        });
    }
  }, [playing, suspended, muted, rate, error, onFailure]);
  useVideoFrameClock(video, (time) => tick.current(time), playing && !suspended, clip?.id);
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-black"
      aria-label="Edited timeline playback"
      aria-hidden={suspended}
    >
      <video
        ref={video}
        playsInline
        preload="auto"
        className="max-h-full max-w-full object-contain"
      />
      {loading && (
        <p role="status" className="absolute rounded bg-black/75 px-4 py-3 text-sm text-white">
          Preparing edited playback…
        </p>
      )}
      {error && (
        <p role="alert" className="absolute rounded bg-black/75 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      )}
    </div>
  );
}
