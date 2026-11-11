import { ReviewHistory } from "./ReviewHistory";
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import type { TextRange } from "@/lib/transcriptEdits";
import { computeTimeline, type Project } from "@/lib/edl";
import { projectTranscript } from "@/lib/transcript";
import { isVocalFillerOnly } from "@/lib/scriptMatching";
import { locateScriptRecord } from "@/lib/scriptLifecycle";
import { fillerCandidates, type FillerCandidate } from "@/lib/fillerReview";
import {
  replaceFillerText,
  buildFillerCutProposal,
  removeFillerText,
  setFillerDecision,
} from "@/lib/fillerActions";
import {
  buildOffScriptCut,
  bulkScriptPunctuation,
  scriptReviewAction,
  replaceScriptReviewText,
} from "@/lib/scriptReviewActions";
import { createScriptRun, runScriptReconciliation, type ScriptRun } from "@/lib/scriptWorkflow";
import { estimateFillerBoundaries } from "@/lib/ipc";
import { endTypingGroup, projectSession, useProjectStore } from "@/stores/projectStore";
import { startReviewAudition, useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import { dispatchCommand, useAppCommands } from "@/lib/appCommands";
import type { ScriptReviewRecord } from "@/lib/scriptAssistance";
import { quoteCodeText, scriptCodeSpans } from "@/lib/scriptCodeFormatting";

export interface ReviewTarget {
  kind: "script" | "filler";
  id: string;
}
export function selectReviewTarget(target: ReviewTarget | null) {
  window.dispatchEvent(new CustomEvent("yusafcut:review-item", { detail: target }));
}
type Item = ReviewTarget & {
  time: number;
  segmentId: string;
  blockId: string;
  from: number;
  to: number;
  record?: ScriptReviewRecord;
  filler?: FillerCandidate;
};
export function InlineReview({
  selection,
  isComposing,
  onAdvancedFillers,
  toolbarActions,
}: {
  selection: TextRange[];
  isComposing: () => boolean;
  onAdvancedFillers: () => void;
  toolbarActions?: ReactNode;
}) {
  const project = useProjectStore((s) => s.project);
  const [filter, setFilter] = useState("all");
  const [historyOpen, setHistoryOpen] = useState(false);
  const advance = useRef<{ project: Project; ids: ReviewTarget[]; time: number } | null>(null);
  const [scope, setScope] = useState<TextRange[] | undefined>();
  const [selected, setSelected] = useState<ReviewTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [customText, setCustomText] = useState("");
  const [offsets, setOffsets] = useState({ startMs: 0, endMs: 0 });
  const [estimateBusy, setEstimateBusy] = useState(false);
  const [estimateNotice, setEstimateNotice] = useState("");
  const [manualTiming, setManualTiming] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 160 });
  const [preview, setPreview] = useState<{
    before: Project;
    result: Project;
    joinOutput: number;
    cutStart: number;
    cutEnd: number;
  } | null>(null);
  const run = useRef<ScriptRun | null>(null);
  const estimateSerial = useRef(0);
  const popup = useRef<HTMLDivElement>(null);
  const navigationTime = useRef(0);
  const stop = useFillerAuditionStore((s) => s.stop);
  const session = useProjectStore(() => projectSession());
  useEffect(
    () => () => {
      run.current?.cancel();
      estimateSerial.current++;
      stop();
    },
    [stop],
  );
  useEffect(() => {
    setSelected(null);
    setHistoryOpen(false);
    advance.current = null;
    setScope(undefined);
    setPreview(null);
    setError("");
  }, [session]);
  const items = useMemo(() => {
    const blocks = projectTranscript(project),
      timeline = computeTimeline(project);
    const list: Item[] = [];
    for (const record of project.scriptAssistance?.records ?? []) {
      if (
        !["suggested", "off-script", "applied"].includes(record.status) ||
        (record.status !== "applied" && isVocalFillerOnly(record.beforeText))
      )
        continue;
      const location = locateScriptRecord(project, record, blocks);
      if (!location) continue;
      const segment = project.segments.find((s) => s.id === location.block.segmentId)!;
      list.push({
        kind: "script",
        id: record.id,
        record,
        segmentId: segment.id,
        blockId: location.block.id,
        from: location.from,
        to: location.to,
        time:
          timeline.find((t) => t.segmentId === segment.id)!.outputStart +
          record.sourceIn -
          segment.sourceIn,
      });
    }
    for (const filler of fillerCandidates(project)) {
      if (!filler.outcome && !filler.hidden)
        list.push({
          kind: "filler",
          id: filler.id,
          filler,
          segmentId: filler.segmentId,
          blockId: filler.blockId,
          from: filler.from,
          to: filler.to,
          time: filler.outputStart,
        });
    }
    return list.sort((a, b) => a.time - b.time);
  }, [project]);
  const queue = items.filter(
    (item) =>
      (filter === "all" || item.kind === filter) &&
      (!scope ||
        scope.some(
          (r) =>
            r.segmentId === item.segmentId &&
            r.blockId === item.blockId &&
            r.from < item.to &&
            r.to > item.from,
        )),
  );
  useEffect(() => {
    const pending = advance.current;
    if (!pending) return;
    advance.current = null;
    if (project !== pending.project) return;
    const next =
      pending.ids
        .map((id) => queue.find((item) => item.id === id.id && item.kind === id.kind))
        .find(Boolean) ??
      queue.find((item) => item.time >= pending.time) ??
      queue[0];
    setSelected(next ?? null);
    setPreview(null);
    setOffsets({ startMs: 0, endMs: 0 });
    if (!next) setNotice("Review complete for this queue. Decisions are in the Review log.");
  }, [project, queue]);
  const current = items.find((i) => i.id === selected?.id && i.kind === selected.kind);
  useEffect(() => {
    if (current) navigationTime.current = current.time;
  }, [current]);
  const index = queue.findIndex((i) => i.id === current?.id && i.kind === current?.kind);
  useEffect(() => {
    const listener = (event: Event) => {
      estimateSerial.current++;
      setSelected((event as CustomEvent<ReviewTarget>).detail);
      setError("");
      setPreview(null);
      setOffsets({ startMs: 0, endMs: 0 });
    };
    window.addEventListener("yusafcut:review-item", listener);
    return () => window.removeEventListener("yusafcut:review-item", listener);
  }, []);
  // Every decision is rebuilt against the current project and checked by pure
  // anchor/text guards. Undo restores a valid occurrence without a refresh step.
  useEffect(() => {
    setPreview(null);
    setError("");
    estimateSerial.current++;
    setEstimateBusy(false);
  }, [project]);
  useEffect(() => {
    if (!selected) return;
    const locate = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          selected.kind === "script" ? "[data-script-record]" : "[data-filler-id]",
        ),
      ).find(
        (el) =>
          (selected.kind === "script" ? el.dataset.scriptRecord : el.dataset.fillerId) ===
          selected.id,
      );
    locate()?.scrollIntoView?.({ block: "nearest" });
    const update = () => {
      const rect = locate()?.getBoundingClientRect();
      if (!rect) return;
      const height = popup.current?.offsetHeight ?? 260;
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 388)),
        top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8)),
      });
    };
    update();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (popup.current) resize?.observe(popup.current);
    const frame = requestAnimationFrame(update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      resize?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [selected, project]);
  useEffect(() => {
    if (!selected) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        stop();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected, stop]);
  useEffect(() => {
    if (!selected) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (
        !popup.current?.contains(target) &&
        !target.closest(
          "[data-script-record], [data-filler-id], .inline-review-toolbar, .transcript-toolbar",
        )
      ) {
        setSelected(null);
        stop();
      }
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [selected, stop]);
  function attempt(action: () => void) {
    try {
      if (isComposing()) throw new Error("Finish typing before reviewing.");
      setError("");
      endTypingGroup();
      action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function choose(item: Item | undefined) {
    estimateSerial.current++;
    stop();
    setSelected(item ?? null);
    setPreview(null);
    setOffsets({ startMs: 0, endMs: 0 });
    setError("");
  }
  function step(delta: number) {
    if (!queue.length) {
      choose(undefined);
      return;
    }
    choose(
      index >= 0
        ? queue[(index + delta + queue.length) % queue.length]
        : delta > 0
          ? (queue.find((item) => item.time >= navigationTime.current) ?? queue[0])
          : ([...queue].reverse().find((item) => item.time <= navigationTime.current) ??
            queue.at(-1)),
    );
  }

  function commit(next: Project, moveNext = false) {
    stop();
    useProjectStore.getState().commitTranscript(next, project);
    if (moveNext)
      advance.current = {
        project: useProjectStore.getState().project,
        ids: (index >= 0
          ? queue.slice(index + 1)
          : queue.filter((item) => item.time > (current?.time ?? 0))
        ).map((item) => ({ kind: item.kind, id: item.id })),
        time: current?.time ?? navigationTime.current,
      };
  }
  function proposal() {
    if (!current) throw new Error("Select a surviving suggestion.");
    return current.filler
      ? buildFillerCutProposal(project, current.filler, offsets)
      : buildOffScriptCut(project, current.id, {
          beforeMs: -offsets.startMs,
          afterMs: offsets.endMs,
        });
  }
  function listen(cut: boolean) {
    attempt(() => {
      if (!current) return;
      const value = cut ? proposal() : null;
      if (value) setPreview(value);
      const duration = current.filler
        ? current.filler.outputEnd - current.time
        : current.record!.sourceOut - current.record!.sourceIn;
      startReviewAudition({
        expected: project,
        timeline: value?.result ?? project,
        occurrenceId: current.id,
        mode: cut ? "preview" : "before",
        from: value?.joinOutput ?? current.time,
        to: value?.joinOutput ?? current.time + duration,
        before: 2,
        after: 2,
        loop: false,
        reviewLabel: "Review playback",
      });
    });
  }
  const selectedFiller = current?.filler;
  const estimate = useCallback(async () => {
    if (!selectedFiller || selectedFiller.grouped || selectedFiller.residual) return;
    stop();
    const candidate = selectedFiller,
      expected = project,
      captured = projectSession(),
      serial = ++estimateSerial.current;
    setEstimateBusy(true);
    setEstimateNotice("");
    try {
      const result = await estimateFillerBoundaries(
        expected,
        candidate.segmentId,
        candidate.anchorIds,
      );
      if (
        serial !== estimateSerial.current ||
        useProjectStore.getState().project !== expected ||
        projectSession() !== captured
      )
        return;
      if (result.start === null || result.end === null) {
        setEstimateNotice(
          `Audio boundaries are uncertain: ${result.reason} Preview or adjust the current cut.`,
        );
        return;
      }
      const words = expected.segments
        .find((s) => s.id === candidate.segmentId)!
        .words.filter((w) => candidate.anchorIds.includes(w.id));
      const next = {
        startMs: Math.ceil((result.start - Math.min(...words.map((w) => w.start))) * 1000 - 1e-7),
        endMs: Math.floor((result.end - Math.max(...words.map((w) => w.end))) * 1000 + 1e-7),
      };
      buildFillerCutProposal(expected, candidate, next);
      setOffsets(next);
      setPreview(null);
      setEstimatedFor({ id: candidate.id, project: expected });
    } catch (cause) {
      if (serial === estimateSerial.current)
        setEstimateNotice(
          `Audio estimate unavailable: ${cause instanceof Error ? cause.message : String(cause)} Current timing is retained; preview or adjust the cut.`,
        );
    } finally {
      if (serial === estimateSerial.current) setEstimateBusy(false);
    }
  }, [selectedFiller, project, stop]);
  // Very short recognition anchors need estimated or manually reviewed boundaries.
  const tinyTiming =
    !!current?.filler && current.filler.sourceEnd - current.filler.sourceStart <= 0.040001;
  const [estimatedFor, setEstimatedFor] = useState<{ id: string; project: Project } | null>(null);
  useEffect(() => {
    estimateSerial.current++;
    setEstimateBusy(false);
    setEstimatedFor(null);
    setManualTiming(false);
    setEstimateNotice("");
    setOffsets({ startMs: 0, endMs: 0 });
  }, [selected?.id, project]);
  useEffect(() => {
    if (!selectedFiller || selectedFiller.grouped || selectedFiller.residual) return;
    const generation = estimateSerial;
    void estimate();
    return () => {
      generation.current++;
    };
  }, [selectedFiller, estimate]);
  async function find(selectedOnly: boolean, audio = false) {
    if (busy) return;
    if (!project.scriptAssistance) {
      dispatchCommand("script");
      setNotice("Add a script, then check this passage. Your selection is retained.");
      return;
    }
    if (selectedOnly && !selection.length) {
      setError("Select a passage first.");
      return;
    }
    if (!selectedOnly && !audio && !project.scriptAssistance.syncLinks?.length) {
      stop();
      dispatchCommand("script-sync");
      setNotice(
        "Review the automatic slide matches and save a pairing before finding differences.",
      );
      return;
    }
    const request = createScriptRun(),
      captured = projectSession();
    run.current = request;
    setBusy(true);
    setError("");
    setNotice(audio ? "Checking audio…" : "Finding differences…");
    const ranges = selectedOnly ? [...selection] : undefined;
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (useProjectStore.getState().project !== project || projectSession() !== captured)
        throw new Error("The project changed. Find differences again.");
      const result = await runScriptReconciliation(
        request,
        ranges,
        "large-v3-turbo",
        (done, total) => setNotice(`Checking audio ${done}/${total}…`),
        isComposing,
        audio,
      );
      if (projectSession() !== captured) return;
      setScope(ranges);
      setFilter("all");
      setSelected(null);
      setNotice(
        `${result.pending + result.offScript} new suggestions${selectedOnly ? " in selection" : ""}.`,
      );
    } catch (cause) {
      if (projectSession() === captured) setError(String(cause));
    } finally {
      if (run.current === request) {
        run.current = null;
        setBusy(false);
      }
    }
  }
  function format() {
    attempt(() => {
      const result = bulkScriptPunctuation(
        project,
        new Set(queue.filter((item) => item.kind === "script").map((item) => item.id)),
      );
      commit(result.project);
      setNotice(`Applied ${result.count} formatting suggestions.`);
    });
  }
  useAppCommands({
    "review-log": () => {
      stop();
      setHistoryOpen(true);
    },
    "review-script": () => {
      void find(false);
    },
    "review-selected": () => {
      void find(true);
    },
    "review-fillers": () => {
      setFilter("filler");
      setScope(undefined);
      choose(items.find((i) => i.kind === "filler"));
    },
    "review-next": () => step(1),
    "review-previous": () => step(-1),
    "format-script": format,
  });
  useEffect(() => {
    setCustomText(current?.record?.afterText ?? current?.filler?.text ?? "");
  }, [current?.id, current?.record?.afterText, current?.filler?.text]);
  const record = current?.record;
  const afterText = useMemo(() => {
    if (!record || !current) return record?.afterText ?? "";
    const block = projectTranscript(project).find(
      (b) => b.segmentId === current.segmentId && b.id === current.blockId,
    );
    if (!block) return record.afterText;
    const proposed =
      block.text.slice(0, current.from) + record.afterText + block.text.slice(current.to);
    const end = current.from + record.afterText.length;
    const spans = scriptCodeSpans(project, proposed)
      .filter((span) => span.from >= current.from && span.to <= end)
      .map((span) => ({ ...span, from: span.from - current.from, to: span.to - current.from }));
    return quoteCodeText(record.afterText, spans);
  }, [record, current, project]);
  const canCut = !!current?.filler || record?.status === "off-script";
  const title = current?.filler ? current.filler.text : record?.beforeText;
  const followingText = useMemo(
    () =>
      current
        ? projectTranscript(project)
            .find((b) => b.segmentId === current.segmentId && b.id === current.blockId)
            ?.text.slice(current.to, current.to + 90)
            .trim()
        : "",
    [project, current],
  );
  return (
    <>
      <div className="inline-review-toolbar" aria-label="Transcript review">
        {toolbarActions}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void find(false)}>
          {project.scriptAssistance ? "Find differences" : "Add script…"}
        </Button>
        {selection.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void find(true)}
          >
            {project.scriptAssistance ? "Check selection" : "Add script to check selection…"}
          </Button>
        )}
        <select
          aria-label="Review category"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setScope(undefined);
            setSelected(null);
          }}
        >
          <option value="all">All suggestions</option>
          <option value="script">Script differences</option>
          <option value="filler">Fillers</option>
        </select>
        <Button size="sm" variant="ghost" disabled={!queue.length} onClick={() => step(-1)}>
          Previous
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => dispatchCommand("script-sync")}
        >
          Sync script…
        </Button>
        <span className="text-xs text-muted-foreground">
          {index >= 0 ? `${index + 1} / ${queue.length}` : `${queue.length} remaining`}
          {scope ? " in passage" : ""}
        </span>
        <Button size="sm" variant="ghost" disabled={!queue.length} onClick={() => step(1)}>
          Next
        </Button>
        {busy && (
          <Button size="sm" variant="ghost" onClick={() => run.current?.cancel()}>
            Cancel
          </Button>
        )}
        <details
          className="review-options"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button"))
              event.currentTarget.removeAttribute("open");
          }}
        >
          <summary>Options</summary>
          <div className="review-options-menu">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                stop();
                setHistoryOpen(true);
              }}
            >
              Review log…
            </Button>
            <Button size="sm" variant="ghost" onClick={format}>
              Apply simple formatting
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void find(!!selection.length, true)}
            >
              Check audio (slower)
            </Button>
            <Button size="sm" variant="ghost" onClick={onAdvancedFillers}>
              Filler settings…
            </Button>
            <p className="text-xs text-muted-foreground">
              Typing changes text. Cut speech changes audio/video. Suggestions require approval;
              automatic wording changes are disabled.
            </p>
          </div>
        </details>
      </div>
      {notice && (
        <p role="status" className="px-4 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {error && !selected && (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {selected &&
        createPortal(
          <div
            ref={popup}
            role="dialog"
            aria-label="Review suggestion"
            className="inline-review-popover"
            style={position}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSelected(null);
                stop();
              }
              if (!(e.metaKey || e.ctrlKey)) e.stopPropagation();
            }}
          >
            <div className="flex justify-between items-center">
              <strong>
                {current?.filler
                  ? "Filler"
                  : record?.status === "off-script"
                    ? "Possible off-script speech"
                    : record?.beforeText === record?.afterText
                      ? "Needs review"
                      : "Script suggestion"}
              </strong>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Close suggestion"
                onClick={() => {
                  setSelected(null);
                  stop();
                }}
              >
                ×
              </Button>
            </div>
            {current ? (
              <>
                <p className="my-2 break-words">
                  {title}
                  {record && record.afterText !== record.beforeText && (
                    <>
                      {" "}
                      <span aria-hidden>→</span> <strong>{afterText}</strong>
                    </>
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => listen(false)}>
                    Play
                  </Button>
                  {record?.status === "suggested" && (
                    <>
                      {record.beforeText !== record.afterText && (
                        <Button
                          size="sm"
                          onClick={() =>
                            attempt(() =>
                              commit(scriptReviewAction(project, record.id, "accept"), true),
                            )
                          }
                        >
                          Accept
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          attempt(() =>
                            commit(scriptReviewAction(project, record.id, "dismiss"), true),
                          )
                        }
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
                  {record?.status === "applied" && (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          attempt(() =>
                            commit(scriptReviewAction(project, record.id, "keep"), true),
                          )
                        }
                      >
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          attempt(() =>
                            commit(scriptReviewAction(project, record.id, "revert"), true),
                          )
                        }
                      >
                        Revert
                      </Button>
                    </>
                  )}
                  {canCut && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={estimateBusy}
                        onClick={() => listen(true)}
                      >
                        Preview cut
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          estimateBusy ||
                          (tinyTiming &&
                            !manualTiming &&
                            (estimatedFor?.id !== current.id || estimatedFor.project !== project))
                        }
                        onClick={() =>
                          attempt(() => {
                            const value = preview?.before === project ? preview : proposal();
                            commit(value.result, true);
                          })
                        }
                      >
                        Cut speech
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          attempt(() =>
                            commit(
                              current.filler
                                ? setFillerDecision(project, current.filler, "kept")
                                : scriptReviewAction(project, current.id, "keep"),
                              true,
                            ),
                          )
                        }
                      >
                        Keep speech
                      </Button>
                    </>
                  )}
                </div>
                {canCut && (
                  <details className="mt-2">
                    <summary>Adjust cut</summary>
                    <div className="flex flex-wrap gap-2 my-2">
                      {current.filler && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={estimateBusy}
                          onClick={() => void estimate()}
                        >
                          {estimateBusy ? "Estimating…" : "Estimate from audio"}
                        </Button>
                      )}
                      {(["startMs", "endMs"] as const).map((side) => (
                        <label key={side} className="text-xs">
                          {current.filler
                            ? side === "startMs"
                              ? "Start"
                              : "End"
                            : side === "startMs"
                              ? "Buffer before"
                              : "Buffer after"}{" "}
                          (ms)
                          <input
                            aria-label={
                              current.filler
                                ? side === "startMs"
                                  ? "Cut start offset"
                                  : "Cut end offset"
                                : side === "startMs"
                                  ? "Cut buffer before"
                                  : "Cut buffer after"
                            }
                            type="number"
                            step="10"
                            min={current.filler ? undefined : 0}
                            value={
                              !current.filler && side === "startMs" ? -offsets[side] : offsets[side]
                            }
                            className="w-20"
                            onChange={(e) => {
                              estimateSerial.current++;
                              setEstimateBusy(false);
                              setManualTiming(true);
                              stop();
                              setOffsets({
                                ...offsets,
                                [side]:
                                  Number(e.target.value) *
                                  (!current.filler && side === "startMs" ? -1 : 1),
                              });
                              setPreview(null);
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    {current.filler && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          attempt(() => commit(removeFillerText(project, current.filler!), true))
                        }
                      >
                        Remove text only
                      </Button>
                    )}
                  </details>
                )}
                {estimateBusy && (
                  <p role="status" className="mt-2 text-xs">
                    Estimating filler cut from audio…
                  </p>
                )}
                {!estimateBusy && estimateNotice && (
                  <p role="status" className="mt-2 text-xs">
                    {estimateNotice}
                  </p>
                )}
                {canCut && followingText && (
                  <p className="mt-2 text-xs" aria-label="Retained following text">
                    Keeps following text: {followingText}
                  </p>
                )}
                {preview?.before === project && (
                  <p className="text-xs" aria-label="Proposed cut duration">
                    Removes {(preview.cutEnd - preview.cutStart).toFixed(3)} seconds; neighboring
                    words are retained.
                  </p>
                )}
                {record && record.beforeText === record.afterText && (
                  <p className="mt-2 text-xs">
                    No replacement was inferred. Listen, enter your own wording, or dismiss this
                    item.
                  </p>
                )}
                <details className="mt-2">
                  <summary>Edit text</summary>
                  <label className="block text-xs">
                    Your replacement
                    <input
                      aria-label="Your replacement"
                      className="w-full my-2"
                      value={customText}
                      onChange={(e) => setCustomText(e.target.value)}
                    />
                  </label>
                  <Button
                    size="sm"
                    disabled={
                      customText ===
                      (record
                        ? record.status === "applied"
                          ? record.afterText
                          : record.beforeText
                        : current.filler!.text)
                    }
                    onClick={() =>
                      attempt(() => {
                        commit(
                          record
                            ? replaceScriptReviewText(project, record.id, customText)
                            : replaceFillerText(project, current.filler!, customText),
                          true,
                        );
                      })
                    }
                  >
                    Save text
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Changes transcript and captions only.
                  </p>
                </details>
                {tinyTiming &&
                  !manualTiming &&
                  (estimatedFor?.id !== current.id || estimatedFor.project !== project) && (
                    <p className="text-xs">
                      Estimate or manually adjust the boundaries in Adjust cut before cutting this
                      short anchor.
                    </p>
                  )}
                {record && (
                  <details className="mt-2">
                    <summary>Details</summary>
                    <p className="text-xs">{record.reason}</p>
                    <p className="text-xs">
                      {record.evidence.engine === "script-text-comparison-v1"
                        ? "Compared with the script. Audio has not been checked."
                        : `Independent recognition: ${record.evidence.unprompted}`}
                    </p>
                  </details>
                )}
              </>
            ) : (
              <p>
                This item is resolved or its passage changed. Undo to restore it, or move to the
                next suggestion.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="mt-2 flex justify-between">
              <Button size="sm" variant="ghost" disabled={!queue.length} onClick={() => step(-1)}>
                Previous
              </Button>
              <Button size="sm" variant="ghost" disabled={!queue.length} onClick={() => step(1)}>
                Next
              </Button>
            </div>
          </div>,
          document.body,
        )}
      {historyOpen && (
        <ReviewHistory
          isComposing={isComposing}
          onClose={() => setHistoryOpen(false)}
          onReviewAgain={(kind, id) => {
            setFilter("all");
            setScope(undefined);
            setSelected({ kind, id });
            setPreview(null);
          }}
        />
      )}
    </>
  );
}
