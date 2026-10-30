/**
 * StatusBar — bottom strip showing the active model, transcript metrics, and
 * the current / total timecode. Mirrors the design's footer chrome:
 *
 *   ● CoreML active · whisper-large-v3 · 1,124 words · 17 fillers · 4 deleted
 *                                                         Ready · 00:42.18 / 4:21.05
 */

import { useMemo } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { totalDuration } from "@/lib/edl";
import { formatTimecode } from "@/lib/timecode";
import { fillerCandidates } from "@/lib/fillerReview";
import { projectTranscript } from "@/lib/transcript";
import { JobsFlyout } from "@/components/StatusBar/JobsFlyout";

export function StatusBar() {
  const project = useProjectStore((s) => s.project);
  const dirty = useProjectStore((s) => s.dirty);
  const currentTime = usePlayerStore((s) => s.currentTime);

  const { wordCount, fillerCount, audioRetainedCount } = useMemo(() => {
    const words = projectTranscript(project).reduce(
      (count, block) => count + block.text.split(/\s+/u).filter(Boolean).length,
      0,
    );
    const candidates = fillerCandidates(project);
    return {
      wordCount: words,
      fillerCount: candidates.length,
      audioRetainedCount: candidates.filter((c) => c.hidden).length,
    };
  }, [project]);

  const duration = totalDuration(project);

  return (
    <div className="yusafcut-statusbar">
      <JobsFlyout />
      <span className="sep">·</span>
      <span className="chip">
        <span className="pulse" />
        CoreML active
      </span>
      <span className="sep">·</span>
      <span>whisper-large-v3</span>
      {wordCount > 0 && (
        <>
          <span className="sep">·</span>
          <span>
            {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"}
          </span>
          <span className="sep">·</span>
          <span>
            {fillerCount} filler{fillerCount === 1 ? "" : "s"}
            {audioRetainedCount ? ` (${audioRetainedCount} text hidden)` : ""}
          </span>
        </>
      )}
      <div className="spacer" />
      <span>{dirty ? "Unsaved" : "Ready"}</span>
      <span className="sep">·</span>
      <span>
        {formatTimecode(currentTime, { ms: false })}
        <span style={{ opacity: 0.5 }}> / </span>
        {formatTimecode(duration, { ms: true })}
      </span>
    </div>
  );
}
