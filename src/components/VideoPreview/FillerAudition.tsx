import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { prepareFillerAudition, releaseFillerAudition } from "@/lib/ipc";
import { useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import { useUIStore } from "@/stores/uiStore";
import { usePlayerStore } from "@/stores/playerStore";
import { useVideoFrameClock } from "@/hooks/useVideoFrameClock";
import { formatTimecode } from "@/lib/timecode";
import { Button } from "@/components/ui/button";

/** Audition one rendered passage. There are no source seeks at internal joins. */
export function FillerAudition() {
  const request = useFillerAuditionStore((s) => s.request);
  const stop = useFillerAuditionStore((s) => s.stop);
  const processing = useUIStore((s) => s.isProcessingEdit);
  const muted = usePlayerStore((s) => s.muted);
  const rate = usePlayerStore((s) => s.rate);
  const ref = useRef<HTMLVideoElement>(null);
  const tick = useRef<(time: number) => void>(() => {});
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState("");
  useVideoFrameClock(
    ref,
    useCallback((time) => tick.current(time), []),
    playing,
    request?.token,
  );

  useEffect(() => {
    const el = ref.current;
    if (!request || !el) return;
    const requestId = crypto.randomUUID();
    let cancelled = false;
    let ready = false;
    let intent = true;
    let duration = request.end - request.start;
    const valid = () => !cancelled && useFillerAuditionStore.getState().request === request;
    const play = () => {
      if (!valid() || !ready || !intent) return;
      setPlaying(true);
      void el
        .play()
        .then(() => {
          if (!valid() || !intent) el.pause();
        })
        .catch((reason: Error) => {
          if (!valid() || !intent || reason.name === "AbortError") return;
          intent = false;
          setPlaying(false);
          setError(reason.message || "Playback failed.");
        });
    };
    tick.current = (time) => {
      if (!valid() || !ready || !intent) return;
      setPosition(request.start + Math.min(time, duration));
      if (time >= duration) {
        if (request.loop) {
          el.currentTime = 0;
          play();
        } else {
          intent = false;
          el.pause();
          setPlaying(false);
          setFinished(true);
        }
      }
    };
    const update = () => tick.current(el.currentTime);
    const ended = () => tick.current(duration);
    const failed = () => {
      if (!valid()) return;
      intent = false;
      el.pause();
      setPlaying(false);
      setError(el.error?.message || "The rendered passage could not be loaded.");
    };
    setError("");
    setFinished(false);
    setPlaying(false);
    setPosition(request.start);
    el.addEventListener("canplay", play);
    el.addEventListener("timeupdate", update);
    el.addEventListener("ended", ended);
    el.addEventListener("error", failed);
    void Promise.resolve()
      .then(() => prepareFillerAudition(request.timeline, request.start, request.end, requestId))
      .then((clip) => {
        if (!valid()) return;
        duration = clip.duration;
        ready = true;
        el.src = convertFileSrc(clip.path);
        el.load();
        // Cached local clips can already be ready without another canplay event.
        if (el.readyState >= 3) play();
      })
      .catch((reason: unknown) => {
        if (!valid()) return;
        intent = false;
        setError(String(reason));
        setPlaying(false);
      });
    return () => {
      cancelled = true;
      intent = false;
      ready = false;
      tick.current = () => {};
      el.pause();
      setPlaying(false);
      el.removeEventListener("canplay", play);
      el.removeEventListener("timeupdate", update);
      el.removeEventListener("ended", ended);
      el.removeEventListener("error", failed);
      el.removeAttribute("src");
      el.load();
      void Promise.resolve()
        .then(() => releaseFillerAudition(requestId))
        .catch(() => {});
      if (useFillerAuditionStore.getState().request === request)
        useFillerAuditionStore.getState().stop();
    };
  }, [request]);

  useEffect(() => {
    if (ref.current) {
      ref.current.muted = muted;
      ref.current.defaultPlaybackRate = rate;
      ref.current.playbackRate = rate;
    }
  }, [muted, rate, request]);
  useEffect(() => {
    if (processing) stop("Playback stopped for a timeline update.");
  }, [processing, stop]);
  useEffect(() => {
    const exit = () => stop();
    const events = [
      "yusafcut:seek-output",
      "yusafcut:seek-source",
      "yusafcut:play",
      "yusafcut:toggle-play",
      "yusafcut:pause",
    ];
    events.forEach((event) => window.addEventListener(event, exit));
    return () => events.forEach((event) => window.removeEventListener(event, exit));
  }, [stop]);
  if (!request) return null;
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-black" aria-label="Filler audition">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-amber-950 px-3 py-2 text-xs text-amber-100">
        <span>
          {request.mode === "preview"
            ? "Preview cut — project unchanged"
            : request.mode === "before"
              ? "Play before"
              : "Play committed result"}{" "}
          · {formatTimecode(position, { ms: true })}
          {finished ? " · Finished" : !playing && !error ? " · Preparing continuous playback…" : ""}
        </span>
        <Button size="sm" variant="outline" onClick={() => stop()}>
          Stop audition
        </Button>
      </div>
      <video
        key={request.token}
        ref={ref}
        playsInline
        preload="auto"
        className="min-h-0 flex-1 object-contain"
      />
      {error && (
        <p role="alert" className="p-3 text-sm text-red-200">
          {error}
        </p>
      )}
    </div>
  );
}
