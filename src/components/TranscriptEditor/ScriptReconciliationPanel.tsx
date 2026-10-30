import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { computeTimeline } from "@/lib/edl";
import { projectTranscript } from "@/lib/transcript";
import type { TextRange } from "@/lib/transcriptEdits";
import { formatTimecode } from "@/lib/timecode";
import { locateScriptRecord } from "@/lib/scriptLifecycle";
import {
  bulkScriptPunctuation,
  buildOffScriptCut,
  scriptReviewAction,
  type OffScriptCutProposal,
} from "@/lib/scriptReviewActions";
import { createScriptRun, runScriptReconciliation, type ScriptRun } from "@/lib/scriptWorkflow";
import type { WhisperModel } from "@/lib/ipc";
import { endTypingGroup, projectSession, useProjectStore } from "@/stores/projectStore";
import { startReviewAudition, useFillerAuditionStore } from "@/stores/fillerAuditionStore";

type Filter = "Unreviewed" | "Applied" | "Suggestions" | "Off-script" | "History";
export function ScriptReconciliationPanel({
  selection,
  isComposing,
}: {
  selection: TextRange[];
  isComposing?: () => boolean;
}) {
  const project = useProjectStore((s) => s.project);
  const [scope, setScope] = useState<"whole" | "selected">("whole");
  const [model, setModel] = useState<WhisperModel>("large-v3-turbo");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<Filter>("Unreviewed");
  const [selected, setSelected] = useState("");
  const [proposal, setProposal] = useState<OffScriptCutProposal | null>(null);
  const [viewedProject, setViewedProject] = useState(project);
  const run = useRef<ScriptRun | null>(null);
  useEffect(
    () => () => {
      run.current?.cancel();
    },
    [],
  );
  const review = useMemo(() => {
    const timeline = computeTimeline(project);
    const blocks = projectTranscript(project);
    return (project.scriptAssistance?.records ?? [])
      .map((record) => {
        const location = locateScriptRecord(project, record, blocks);
        const position = location
          ? timeline.find((e) => e.segmentId === location.block.segmentId)!.outputStart +
            record.sourceIn -
            project.segments.find((s) => s.id === location.block.segmentId)!.sourceIn
          : Infinity;
        return { record, location, position };
      })
      .filter(({ record, location }) => {
        const active = !!location && ["applied", "suggested", "off-script"].includes(record.status);
        return filter === "History"
          ? !active
          : !active
            ? false
            : filter === "Unreviewed"
              ? true
              : filter === "Applied"
                ? record.status === "applied"
                : filter === "Suggestions"
                  ? record.status === "suggested"
                  : record.status === "off-script";
      })
      .sort((a, b) => a.position - b.position);
  }, [project, filter]);
  const index = Math.max(
    0,
    review.findIndex((item) => item.record.id === selected),
  );
  const card = review[index];
  const record = card?.record;
  const excerptScript = project.scriptAssistance?.scripts.find(
    (s) => s.revision === record?.scriptRevision,
  );
  const stop = useFillerAuditionStore((s) => s.stop);
  const availableCut = useMemo(() => {
    if (record?.status !== "off-script") return null;
    try {
      return { value: buildOffScriptCut(project, record.id) };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [project, record]);
  function attempt(action: () => void) {
    try {
      if (isComposing?.()) throw new Error("Finish typing before reviewing this passage.");
      endTypingGroup();
      setError("");
      action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function requireCurrentReview() {
    if (viewedProject !== project || useProjectStore.getState().project !== project)
      throw new Error(
        "The project changed. Refresh review or listen to the current passage before deciding.",
      );
  }
  async function reconcile() {
    const expected = project,
      session = projectSession(),
      request = createScriptRun();
    run.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    setProposal(null);
    setProgress({ completed: 0, total: 0 });
    try {
      endTypingGroup();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (useProjectStore.getState().project !== expected || projectSession() !== session)
        throw new Error("The project changed. Run reconciliation again.");
      const result = await runScriptReconciliation(
        request,
        scope === "selected" ? [...selection] : undefined,
        model,
        (completed, total) => {
          if (run.current === request) setProgress({ completed, total });
        },
        isComposing,
      );
      if (run.current === request && projectSession() === session) {
        setViewedProject(useProjectStore.getState().project);
        setNotice(
          `${result.applied} automatic corrections, ${result.pending} new suggestions, ${result.offScript} off-script passages, ${result.unsupported} unsupported mappings. Existing decisions were preserved.`,
        );
        setFilter("Unreviewed");
        setSelected("");
      }
    } catch (cause) {
      if (run.current === request && projectSession() === session)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (run.current === request) {
        run.current = null;
        setBusy(false);
      }
    }
  }
  function decide(action: "accept" | "dismiss" | "keep" | "revert") {
    if (!record) return;
    attempt(() => {
      requireCurrentReview();
      useProjectStore
        .getState()
        .commitTranscript(scriptReviewAction(project, record.id, action), project);
      setViewedProject(useProjectStore.getState().project);
    });
    setProposal(null);
  }
  function listen(preview: boolean) {
    if (!card?.location || !record) return;
    attempt(() => {
      const cut = preview
        ? proposal?.before === project
          ? proposal
          : (availableCut?.value ??
            (() => {
              throw new Error(availableCut?.error ?? "No valid cut mapping.");
            })())
        : null;
      if (cut) setProposal(cut);
      startReviewAudition({
        expected: project,
        timeline: cut?.result ?? project,
        occurrenceId: record.id,
        mode: cut ? "preview" : "before",
        from: cut?.joinOutput ?? card.position,
        to: cut?.joinOutput ?? card.position + record.sourceOut - record.sourceIn,
        before: 2,
        after: 2,
        loop: false,
        reviewLabel: "Script review playback",
      });
      setViewedProject(project);
    });
  }
  return (
    <div className="mt-3 border-t border-border pt-3" aria-label="Script reconciliation review">
      <p className="text-xs text-muted-foreground">
        This development build stages audio-backed suggestions for review. Automatic wording
        correction is not enabled yet.
      </p>
      <div className="my-2 flex flex-wrap items-center gap-2">
        <label>
          Scope{" "}
          <select
            aria-label="Reconciliation scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as "whole" | "selected")}
          >
            <option value="whole">Whole edited transcript</option>
            <option value="selected" disabled={!selection.length}>
              Selected passage
            </option>
          </select>
        </label>
        <label>
          Audio model{" "}
          <select
            aria-label="Reconciliation audio model"
            value={model}
            onChange={(e) => setModel(e.target.value as WhisperModel)}
          >
            {["large-v3-turbo", "large-v3", "medium", "small", "base", "tiny"].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          disabled={busy || (scope === "selected" && !selection.length)}
          onClick={() => void reconcile()}
        >
          Reconcile script
        </Button>
        {busy && (
          <Button size="sm" variant="outline" onClick={() => run.current?.cancel()}>
            Cancel analysis
          </Button>
        )}
      </div>
      <p className="text-xs">
        Scope:{" "}
        {scope === "whole"
          ? "all surviving transcript text"
          : `${selection.reduce((n, r) => n + r.to - r.from, 0)} selected characters`}
        . Existing cuts and hidden text are preserved.
      </p>
      {busy && (
        <p role="status">
          {progress.total
            ? `Analyzing local audio… ${progress.completed}/${progress.total} windows`
            : "Matching the current transcript to the script…"}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {viewedProject !== project && (
        <p role="status">
          The project changed. Inspect the current review list before making another decision.{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              stop();
              setViewedProject(project);
              setProposal(null);
              setSelected("");
            }}
          >
            Refresh review
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="my-2 flex flex-wrap gap-2">
        <label>
          Review filter{" "}
          <select
            aria-label="Script review filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as Filter);
              setViewedProject(project);
              setSelected("");
              setProposal(null);
            }}
          >
            {["Unreviewed", "Applied", "Suggestions", "Off-script", "History"].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            attempt(() => {
              requireCurrentReview();
              const result = bulkScriptPunctuation(project);
              useProjectStore.getState().commitTranscript(result.project, project);
              setViewedProject(useProjectStore.getState().project);
              setNotice(`Applied ${result.count} punctuation/capitalization suggestions.`);
            })
          }
        >
          Apply punctuation/capitalization
        </Button>
      </div>
      {!card ? (
        <p>No items in this review filter.</p>
      ) : (
        <article
          className={`max-h-72 overflow-y-auto border-l-4 p-2 ${record!.status === "applied" ? "border-emerald-500" : record!.kind === "off-script" ? "border-purple-500" : "border-sky-500"}`}
        >
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={index === 0}
              onClick={() => {
                stop();
                setViewedProject(project);
                setSelected(review[index - 1]!.record.id);
                setProposal(null);
              }}
            >
              Previous item
            </Button>
            <span>
              {index + 1}/{review.length} ·{" "}
              {record!.historicalReason
                ? `Historical — ${record!.status}`
                : record!.status === "applied"
                  ? "Automatic correction — unreviewed"
                  : record!.status === "suggested"
                    ? "Pending suggestion"
                    : record!.status === "off-script"
                      ? "Off-script speech"
                      : record!.status}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={index >= review.length - 1}
              onClick={() => {
                stop();
                setViewedProject(project);
                setSelected(review[index + 1]!.record.id);
                setProposal(null);
              }}
            >
              Next item
            </Button>
          </div>
          {Number.isFinite(card.position) && (
            <p>
              Output {formatTimecode(card.position, { ms: true })} · source{" "}
              {formatTimecode(record!.sourceIn, { ms: true })}
            </p>
          )}
          <p>
            <strong>Before:</strong> {record!.beforeText}
          </p>
          {record!.afterText !== record!.beforeText && (
            <p>
              <strong>Proposed/current:</strong> {record!.afterText}
            </p>
          )}
          <p>{record!.reason}</p>
          {record!.historicalReason && <p>{record!.historicalReason}</p>}
          <details>
            <summary>Script excerpt and independent audio recognition</summary>
            <pre className="whitespace-pre-wrap">
              {excerptScript?.markdown.slice(record!.scriptFrom, record!.scriptTo)}
            </pre>
            <p>Independent recognition may contain mistakes: {record!.evidence.unprompted}</p>
          </details>
          {card.location && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => listen(false)}>
                Listen
              </Button>
              {record!.status === "applied" && (
                <>
                  <Button size="sm" onClick={() => decide("keep")}>
                    Keep correction
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => decide("revert")}>
                    Revert correction
                  </Button>
                </>
              )}
              {record!.status === "suggested" && (
                <>
                  <Button
                    size="sm"
                    disabled={record!.beforeText === record!.afterText}
                    onClick={() => decide("accept")}
                  >
                    Accept suggestion
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => decide("dismiss")}>
                    Dismiss suggestion
                  </Button>
                </>
              )}
              {record!.status === "off-script" && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!availableCut?.value}
                    onClick={() => listen(true)}
                  >
                    Preview cut
                  </Button>
                  <Button
                    disabled={!availableCut?.value}
                    size="sm"
                    onClick={() =>
                      attempt(() => {
                        requireCurrentReview();
                        if (proposal && proposal.before !== project)
                          throw new Error(
                            "The cut preview is stale. Preview the current passage again before cutting.",
                          );
                        const cut =
                          proposal?.before === project
                            ? proposal
                            : (availableCut?.value ??
                              (() => {
                                throw new Error(availableCut?.error ?? "No valid cut mapping.");
                              })());
                        useProjectStore.getState().commitTranscript(cut.result, cut.before);
                        setViewedProject(useProjectStore.getState().project);
                        setProposal(null);
                      })
                    }
                  >
                    Cut speech (audio/video)
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => decide("keep")}>
                    Keep speech
                  </Button>
                  {availableCut?.value && (
                    <p>
                      Actual source cut: {formatTimecode(availableCut.value.cutStart, { ms: true })}
                      –{formatTimecode(availableCut.value.cutEnd, { ms: true })}
                    </p>
                  )}
                  {availableCut?.error && <p>{availableCut.error}</p>}
                </>
              )}
            </div>
          )}
        </article>
      )}
    </div>
  );
}
