import { useEffect, useMemo, useState } from "react";
import { loadPeaks } from "@/lib/audioPeaks";
import { computeTimeline, type Project } from "@/lib/edl";

/** Project the source peaks through the EDL, including repeats and wordless audio. */
export function waveformPath(
  project: Project,
  peaks: Record<string, number[]>,
  startPx: number,
  endPx: number,
  pxPerSecond: number,
): string {
  if (pxPerSecond <= 0) return "";
  const paths: string[] = [];
  for (const entry of computeTimeline(project)) {
    const source = peaks[entry.mediaId];
    if (!source) continue;
    const left = Math.max(startPx, entry.outputStart * pxPerSecond);
    const right = Math.min(endPx, entry.outputEnd * pxPerSecond);
    for (let x = left; x < right; x += 2) {
      const from = entry.sourceIn + (x / pxPerSecond - entry.outputStart);
      const to = Math.min(entry.sourceOut, from + 2 / pxPerSecond);
      let peak = 0;
      for (let i = Math.floor(from * 50); i < Math.ceil(to * 50); i++)
        peak = Math.max(peak, source[i] ?? 0);
      const height = Math.max(0.5, Math.sqrt(peak) * 23);
      paths.push(
        `M${(x - startPx).toFixed(1)},${(25 - height).toFixed(1)}v${(height * 2).toFixed(1)}`,
      );
    }
  }
  return paths.join("");
}

export function AudioWaveform({
  project,
  startPx,
  endPx,
  pxPerSecond,
}: {
  project: Project;
  startPx: number;
  endPx: number;
  pxPerSecond: number;
}) {
  const [peaks, setPeaks] = useState<Record<string, number[]>>({});
  const [status, setStatus] = useState("Loading waveform…");
  const sources = useMemo(() => {
    const usedMedia = new Set(project.segments.map((segment) => segment.mediaId));
    return Object.values(project.media).filter((media) => usedMedia.has(media.id));
  }, [project.media, project.segments]);
  // A cut changes the projection, but does not require re-extracting source audio.
  const sourceKey = JSON.stringify(sources.map((s) => [s.id, s.path, s.sha256, s.audioSampleRate]));
  useEffect(() => {
    let cancelled = false;
    setPeaks({});
    setStatus("Loading waveform…");
    const media = JSON.parse(sourceKey) as [string, string, string, number][];
    void Promise.allSettled(
      media.map(async ([id, path, sha, sampleRate]) => {
        const values = sampleRate === 0 ? [] : await loadPeaks(`${path}:${sha}`, path);
        if (!cancelled) setPeaks((previous) => ({ ...previous, [id]: values }));
      }),
    ).then((results) => {
      if (!cancelled)
        setStatus(
          results.some((r) => r.status === "rejected") ? "Waveform unavailable for some media" : "",
        );
    });
    return () => {
      cancelled = true;
    };
  }, [sourceKey]);
  const path = useMemo(
    () => waveformPath(project, peaks, startPx, endPx, pxPerSecond),
    [project, peaks, startPx, endPx, pxPerSecond],
  );
  return (
    <div className="timeline-audio" style={{ left: startPx, width: Math.max(1, endPx - startPx) }}>
      <svg width="100%" height="50" aria-label="Audio waveform" role="img">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
      {status && (
        <span className="timeline-waveform-status" role="status">
          {status}
        </span>
      )}
    </div>
  );
}
