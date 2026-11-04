import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import type { Project } from "@/lib/edl";
import type { TextRange } from "@/lib/transcriptEdits";
import { projectTranscript } from "@/lib/transcript";
import { buildTranscriptCut } from "@/lib/transcriptCut";
import { endTypingGroup, projectSession, useProjectStore } from "@/stores/projectStore";
import { startReviewAudition, useFillerAuditionStore } from "@/stores/fillerAuditionStore";

export interface TranscriptCutSelection {
  project: Project;
  session: number;
  ranges: TextRange[];
  anchor: () => { left: number; bottom: number };
}

export function TranscriptCutPopover({
  selection,
  onClose,
  isComposing,
}: {
  selection: TranscriptCutSelection;
  onClose: () => void;
  isComposing: () => boolean;
}) {
  const project = useProjectStore((state) => state.project);
  const session = useProjectStore(() => projectSession());
  const [offsets, setOffsets] = useState(
    () => buildTranscriptCut(selection.project, selection.ranges).offsets,
  );
  const [error, setError] = useState("");
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const popup = useRef<HTMLDivElement>(null);
  const stop = useFillerAuditionStore((state) => state.stop);
  const proposal = useMemo(() => {
    try {
      return { value: buildTranscriptCut(selection.project, selection.ranges, offsets), error: "" };
    } catch (cause) {
      return { value: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [selection, offsets]);
  const text = useMemo(() => {
    const blocks = projectTranscript(selection.project);
    return selection.ranges
      .map((range) =>
        blocks
          .find((block) => block.segmentId === range.segmentId && block.id === range.blockId)!
          .text.slice(range.from, range.to),
      )
      .join(" ");
  }, [selection]);
  useEffect(() => {
    if (project !== selection.project || session !== selection.session) onClose();
  }, [project, session, selection, onClose]);
  useEffect(() => {
    setOffsets(buildTranscriptCut(selection.project, selection.ranges).offsets);
    setError("");
    popup.current?.focus();
    return () => stop();
  }, [selection, stop]);
  useEffect(() => {
    const update = () => {
      const rect = selection.anchor();
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 388)),
        top: Math.max(
          8,
          Math.min(rect.bottom + 8, window.innerHeight - (popup.current?.offsetHeight ?? 300) - 8),
        ),
      });
    };
    update();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (popup.current) resize?.observe(popup.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      resize?.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [selection]);
  function attempt(action: () => void) {
    try {
      if (isComposing()) throw new Error("Finish typing before cutting speech.");
      if (
        useProjectStore.getState().project !== selection.project ||
        projectSession() !== selection.session
      )
        throw new Error("The project changed. Select the passage again.");
      setError("");
      action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return createPortal(
    <div
      ref={popup}
      role="dialog"
      tabIndex={-1}
      aria-label="Cut selected speech"
      className="inline-review-popover"
      style={position}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <strong>Cut selected speech</strong>
      <p className="my-2 break-words">{text}</p>
      <div className="flex flex-wrap gap-2 my-2">
        {(["startMs", "endMs"] as const).map((side) => (
          <label key={side} className="text-xs">
            {side === "startMs" ? "Start offset" : "End offset"} (ms)
            <input
              type="number"
              step="10"
              className="w-20 ml-2"
              aria-label={side === "startMs" ? "Cut start offset" : "Cut end offset"}
              value={Number.isNaN(offsets[side]) ? "" : Number(offsets[side].toFixed(3))}
              onChange={(event) => {
                stop();
                setError("");
                setOffsets({
                  ...offsets,
                  [side]: event.target.value === "" ? NaN : Number(event.target.value),
                });
              }}
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Negative offsets move a boundary earlier; positive offsets move it later. Text is removed
        for the whole selection.
      </p>
      <p className="text-xs text-muted-foreground">
        Defaults include untranscribed edges while keeping padding around neighboring words.
      </p>
      {proposal.value && (
        <p className="my-2 text-xs" aria-label="Proposed cut duration">
          Removes {(proposal.value.cutEnd - proposal.value.cutStart).toFixed(3)} seconds.
        </p>
      )}
      {proposal.value?.warning && (
        <p role="status" aria-label="Cut warning" className="my-2 text-sm text-amber-400">
          {proposal.value.warning}
        </p>
      )}
      {(error || proposal.error) && (
        <p role="alert" className="my-2 text-sm text-destructive">
          {error || proposal.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 mt-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            attempt(() => {
              const original = buildTranscriptCut(selection.project, selection.ranges);
              startReviewAudition({
                expected: selection.project,
                timeline: selection.project,
                occurrenceId: "transcript-cut",
                mode: "before",
                from: original.from,
                to: original.to,
                before: 2,
                after: 2,
                loop: false,
                reviewLabel: "Selected speech playback",
              });
            })
          }
        >
          Play original
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!proposal.value}
          onClick={() =>
            attempt(() => {
              const value = proposal.value!;
              startReviewAudition({
                expected: selection.project,
                timeline: value.result,
                occurrenceId: "transcript-cut",
                mode: "preview",
                from: value.joinOutput,
                to: value.joinOutput,
                before: 2,
                after: 2,
                loop: false,
                reviewLabel: "Selected speech cut preview",
              });
            })
          }
        >
          Preview cut
        </Button>
        <Button
          size="sm"
          disabled={!proposal.value}
          onClick={() =>
            attempt(() => {
              endTypingGroup();
              stop();
              useProjectStore
                .getState()
                .commitTranscript(proposal.value!.result, selection.project);
              onClose();
            })
          }
        >
          Cut speech
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>,
    document.body,
  );
}
