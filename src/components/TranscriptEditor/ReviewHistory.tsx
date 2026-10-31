import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  useProjectStore,
  useTemporalProjectStore,
  endTypingGroup,
  projectSession,
} from "@/stores/projectStore";
import { locateScriptRecord } from "@/lib/scriptLifecycle";
import { revisitScriptReview } from "@/lib/scriptReviewActions";
import { fillerCandidates, occurrenceLineage } from "@/lib/fillerReview";
import { setFillerDecision } from "@/lib/fillerActions";
import { projectTranscript } from "@/lib/transcript";
import { formatTimecode } from "@/lib/timecode";
import type { ReviewLogEntry } from "@/lib/reviewLog";

const labels: Record<string, string> = {
  accept: "Accepted",
  dismiss: "Dismissed",
  keep: "Kept",
  revert: "Reverted text",
  cut: "Cut speech",
  replace: "Changed text",
  hide: "Removed text only",
  reopen: "Reopened",
};
export function ReviewHistory({
  onClose,
  onReviewAgain,
  isComposing,
}: {
  onClose: () => void;
  onReviewAgain: (kind: "script" | "filler", id: string) => void;
  isComposing: () => boolean;
}) {
  const project = useProjectStore((s) => s.project);
  const past = useTemporalProjectStore((s) => s.pastStates);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const fillers = useMemo(() => fillerCandidates(project), [project]);
  const rows = useMemo(() => {
    const entries = (project.reviewLog?.entries ?? []).map((entry) => ({
      entry,
      label: labels[entry.action]!,
      earlier: false,
    }));
    const logged = new Set(entries.map((r) => r.entry.recordId));
    for (const record of project.scriptAssistance?.records ?? []) {
      if (
        logged.has(record.id) ||
        (!record.historicalReason && ["suggested", "off-script", "applied"].includes(record.status))
      )
        continue;
      entries.unshift({
        earlier: true,
        label: record.historicalReason ? "Archived result" : record.status,
        entry: {
          id: "earlier:" + record.id,
          createdAt: "",
          kind: "script",
          action: "reopen",
          beforeText: record.beforeText,
          afterText: record.afterText,
          mediaId: record.mediaId,
          occurrenceLineage: record.occurrenceLineage,
          anchorIds: record.anchorIds,
          sourceIn: record.sourceIn,
          sourceOut: record.sourceOut,
          recordId: record.id,
        },
      });
    }
    const loggedFillers = new Set(entries.map((r) => r.entry.candidateId));
    for (const filler of fillers)
      if (filler.outcome && !loggedFillers.has(filler.id))
        entries.unshift({
          earlier: true,
          label: filler.outcome === "kept" ? "Kept" : "Removed text only",
          entry: {
            id: "earlier:" + filler.id,
            createdAt: "",
            kind: "filler",
            action: filler.outcome === "kept" ? "keep" : "hide",
            beforeText: filler.text,
            afterText: filler.outcome === "kept" ? filler.text : "",
            mediaId: filler.mediaId,
            occurrenceLineage: filler.occurrenceLineage,
            anchorIds: filler.anchorIds,
            sourceIn: filler.sourceStart,
            sourceOut: filler.sourceEnd,
            candidateId: filler.id,
          },
        });
    return entries.reverse();
  }, [project, fillers]);
  const latest = project.reviewLog?.entries.at(-1);
  const canUndo =
    !!latest && !!past.length && past.at(-1)?.project?.reviewLog?.entries.at(-1)?.id !== latest.id;
  function attempt(fn: () => void) {
    try {
      if (isComposing()) throw new Error("Finish typing before changing review decisions.");
      setError("");
      endTypingGroup();
      fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function locate(entry: ReviewLogEntry) {
    const blocks = projectTranscript(project);
    const matches = blocks.filter(
      (b) =>
        b.mediaId === entry.mediaId &&
        occurrenceLineage(project.segments.find((s) => s.id === b.segmentId)!) ===
          entry.occurrenceLineage &&
        b.runs.some((r) => r.anchorIds.some((id) => entry.anchorIds.includes(id))),
    );
    if (matches.length !== 1)
      throw new Error(
        "This speech has been cut or its timing changed. Use Undo or a saved snapshot to restore it.",
      );
    const block = matches[0]!,
      captured = projectSession();
    onClose();
    requestAnimationFrame(() => {
      if (useProjectStore.getState().project !== project || projectSession() !== captured) return;
      window.dispatchEvent(
        new CustomEvent("yusafcut:reveal-review", {
          detail: { segmentId: block.segmentId, anchorIds: entry.anchorIds },
        }),
      );
    });
  }
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 30) - 1));
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogTitle>Review log</DialogTitle>
        <DialogDescription>
          Review decisions are saved with this project. Revisit an unchanged passage or undo the
          latest decision.
        </DialogDescription>
        {canUndo && (
          <Button
            variant="outline"
            onClick={() => attempt(() => useProjectStore.temporal.getState().undo())}
          >
            Undo latest decision
          </Button>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {!rows.length && <p>No review decisions yet.</p>}
        <div className="space-y-3">
          {rows.slice(currentPage * 30, (currentPage + 1) * 30).map(({ entry, label, earlier }) => {
            const record = project.scriptAssistance?.records.find((r) => r.id === entry.recordId);
            const location = record && locateScriptRecord(project, record);
            const filler = fillers.find((f) => f.id === entry.candidateId);
            return (
              <article
                key={entry.id}
                className="border border-border rounded p-3"
                aria-label={`${label}: ${entry.beforeText}`}
              >
                <p className="font-medium">
                  {label} · {entry.kind === "filler" ? "Filler" : "Script"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {earlier ? "Earlier result" : new Date(entry.createdAt).toLocaleString()} · source{" "}
                  {formatTimecode(entry.sourceIn, { ms: true })}–
                  {formatTimecode(entry.sourceOut, { ms: true })}
                </p>
                <p className="my-2 break-words">
                  {entry.beforeText}
                  {entry.afterText !== entry.beforeText && (
                    <>
                      {" "}
                      → <strong>{entry.afterText || "(removed)"}</strong>
                    </>
                  )}
                </p>
                {record?.historicalReason && <p className="text-xs">{record.historicalReason}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => attempt(() => locate(entry))}>
                    Locate
                  </Button>
                  {location && record?.status === "accepted" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        attempt(() =>
                          useProjectStore
                            .getState()
                            .commitTranscript(
                              revisitScriptReview(project, record.id, true),
                              project,
                            ),
                        )
                      }
                    >
                      Revert text
                    </Button>
                  )}
                  {location &&
                    record &&
                    ["dismissed", "kept", "reverted"].includes(record.status) && (
                      <Button
                        size="sm"
                        onClick={() =>
                          attempt(() => {
                            useProjectStore
                              .getState()
                              .commitTranscript(revisitScriptReview(project, record.id), project);
                            onClose();
                            onReviewAgain("script", record.id);
                          })
                        }
                      >
                        Review again
                      </Button>
                    )}
                  {filler?.outcome === "kept" && (
                    <Button
                      size="sm"
                      onClick={() =>
                        attempt(() => {
                          useProjectStore
                            .getState()
                            .commitTranscript(setFillerDecision(project, filler, null), project);
                          onClose();
                          onReviewAgain("filler", filler.id);
                        })
                      }
                    >
                      Review again
                    </Button>
                  )}
                </div>
                {entry.action === "cut" && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    To restore cut audio/video, use Undo in this session or a saved snapshot.
                    Replacing text cannot restore a cut.
                  </p>
                )}
              </article>
            );
          })}
        </div>
        {rows.length > 30 && (
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="ghost"
              disabled={!currentPage}
              onClick={() => setPage(currentPage - 1)}
            >
              Newer decisions
            </Button>
            <span>
              {currentPage + 1}/{Math.ceil(rows.length / 30)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={(currentPage + 1) * 30 >= rows.length}
              onClick={() => setPage(currentPage + 1)}
            >
              Older decisions
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
