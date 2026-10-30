import { Info } from "lucide-react";
import { estimateFillerBoundaries } from "@/lib/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUIStore } from "@/stores/uiStore";
import { Button } from "@/components/ui/button";
import { fillerCandidates, withFillerPolicy, type FillerCandidate } from "@/lib/fillerReview";
import { OPTIONAL_FILLERS, defaultFillerPolicy, type FillerPolicy } from "@/lib/fillers";
import {
  buildFillerCutProposal,
  removeFillerText,
  setFillerDecision,
  type FillerCutProposal,
} from "@/lib/fillerActions";
import { projectTranscript } from "@/lib/transcript";
import type { Project } from "@/lib/edl";
import { formatTimecode } from "@/lib/timecode";
import {
  endTypingGroup,
  projectSession,
  useProjectStore,
  useTemporalProjectStore,
} from "@/stores/projectStore";
import { startFillerAudition, useFillerAuditionStore } from "@/stores/fillerAuditionStore";

type Filter = "Unreviewed" | "Kept" | "Audio retained" | "All";
interface Card {
  candidate: FillerCandidate;
  project: Project;
  context: string;
  status?: string;
}
interface Comparison {
  expected: Project;
  before: Project;
  proposal: FillerCutProposal;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function attempt<T>(fn: () => T): { value: T; error?: never } | { value?: never; error: string } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: message(error) };
  }
}
function cardFor(candidate: FillerCandidate | undefined, project: Project): Card | null {
  if (!candidate) return null;
  const block = projectTranscript(project).find(
    (b) => b.id === candidate.blockId && b.segmentId === candidate.segmentId,
  );
  const context = block
    ? block.text.slice(
        Math.max(0, candidate.from - 90),
        Math.min(block.text.length, candidate.to + 90),
      )
    : projectTranscript(project)
        .filter(
          (b) =>
            b.runs[0]!.outputStart <= candidate.outputEnd + 2 &&
            b.runs.at(-1)!.outputEnd >= candidate.outputStart - 2,
        )
        .map((b) => b.text)
        .join(" … ")
        .slice(0, 200);
  return { candidate, project, context: context || candidate.text };
}

export function FillerReviewPanel({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((s) => s.project);
  const candidates = useMemo(() => fillerCandidates(project), [project]);
  const [filter, setFilter] = useState<Filter>("Unreviewed");
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [card, setCard] = useState<Card | null>(() =>
    cardFor(
      candidates.find((c) => !c.outcome),
      project,
    ),
  );
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [before, setBefore] = useState(2);
  const [after, setAfter] = useState(2);
  const [loop, setLoop] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [boundaryEstimate, setBoundaryEstimate] = useState<{
    candidateId: string;
    status: "loading" | "applied" | "uncertain";
    message: string;
  } | null>(null);
  const estimateSerial = useRef(0);
  const manualBoundaries = useRef(false);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [custom, setCustom] = useState((project.fillerReview?.policy.custom ?? []).join("\n"));
  const latestAction = useRef<Project | null>(null);
  const session = useRef(projectSession());
  const past = useTemporalProjectStore((s) => s.pastStates);
  const stop = useFillerAuditionStore((s) => s.stop);
  const auditionMessage = useFillerAuditionStore((s) => s.message);
  const policy = project.fillerReview?.policy ?? defaultFillerPolicy();
  function queueFor(nextFilter: Filter, list = candidates, deferred = skipped) {
    return list.filter(
      (c) =>
        nextFilter === "All" ||
        (nextFilter === "Kept"
          ? c.outcome === "kept"
          : nextFilter === "Audio retained"
            ? c.hidden
            : !c.outcome && !deferred.has(c.id)),
    );
  }
  const queue = queueFor(filter);
  const current =
    card && card.project === project
      ? candidates.find((c) => c.id === card.candidate.id)
      : undefined;
  const index = card ? queue.findIndex((c) => c.id === card.candidate.id) : -1;
  const cut = useMemo(
    () =>
      current
        ? attempt(() => buildFillerCutProposal(project, current, { startMs, endMs }))
        : { error: "This occurrence no longer has surviving speech." },
    [project, current, startMs, endMs],
  );
  const text = useMemo(
    () =>
      current
        ? attempt(() => removeFillerText(project, current))
        : { error: "There is no surviving transcript text for this occurrence." },
    [project, current],
  );

  const requestAudioEstimate = useCallback(
    (expected: Project, candidate: FillerCandidate) => {
      const serial = ++estimateSerial.current;
      const capturedSession = projectSession();
      const valid = () =>
        serial === estimateSerial.current &&
        useProjectStore.getState().project === expected &&
        projectSession() === capturedSession;
      stop();
      setBoundaryEstimate({
        candidateId: candidate.id,
        status: "loading",
        message: "Estimating boundaries from audio between neighboring words…",
      });
      void Promise.resolve()
        .then(() =>
          valid()
            ? estimateFillerBoundaries(expected, candidate.segmentId, candidate.anchorIds)
            : null,
        )
        .then((estimate) => {
          if (!valid() || !estimate) return;
          if (estimate.start === null || estimate.end === null) {
            setBoundaryEstimate({
              candidateId: candidate.id,
              status: "uncertain",
              message: estimate.reason,
            });
            return;
          }
          const source = expected.segments.find((s) => s.id === candidate.segmentId)!;
          const words = source.words.filter((w) => candidate.anchorIds.includes(w.id));
          const recognizedStart = Math.min(...words.map((w) => w.start));
          const recognizedEnd = Math.max(...words.map((w) => w.end));
          // Round inward to whole milliseconds, then run the same cut validation as
          // manual offsets. Native estimates cannot bypass neighbor/group guards.
          const startMs = Math.ceil((estimate.start - recognizedStart) * 1000 - 1e-7);
          const endMs = Math.floor((estimate.end - recognizedEnd) * 1000 + 1e-7);
          buildFillerCutProposal(expected, candidate, { startMs, endMs });
          stop();
          setStartMs(startMs);
          setEndMs(endMs);
          setBoundaryEstimate({
            candidateId: candidate.id,
            status: "applied",
            message: estimate.reason,
          });
        })
        .catch((reason) => {
          if (valid())
            setBoundaryEstimate({
              candidateId: candidate.id,
              status: "uncertain",
              message: `Could not estimate audio boundaries: ${message(reason)}`,
            });
        });
    },
    [stop],
  );

  useEffect(() => {
    const generation = estimateSerial;
    if (current && !current.grouped && !current.residual && !manualBoundaries.current) {
      const source = project.segments.find((s) => s.id === current.segmentId)!;
      const words = source.words.filter((w) => current.anchorIds.includes(w.id));
      const duration =
        Math.max(...words.map((w) => w.end)) - Math.min(...words.map((w) => w.start));
      if (duration <= 0.040001 || words.some((w) => w.confidence === 0))
        requestAudioEstimate(project, current);
    }
    return () => {
      generation.current++;
    };
  }, [project, current, requestAudioEstimate]);

  useEffect(() => {
    useUIStore.getState().setFillerReviewCandidateId(card?.candidate.id ?? null);
  }, [card?.candidate.id]);
  useEffect(
    () => () => {
      stop();
      useUIStore.getState().setFillerReviewCandidateId(null);
    },
    [stop],
  );
  useEffect(() => {
    if (card && card.project !== project) {
      stop();
      setComparison(null);
      latestAction.current = null;
      estimateSerial.current++;
      manualBoundaries.current = false;
      setBoundaryEstimate(null);
      setStartMs(0);
      setEndMs(0);
      setNotice("The project changed. Previous playback comparisons were cleared.");
      const same = candidates.find((c) => c.id === card.candidate.id);
      setCard(cardFor(same ?? candidates.find((c) => !c.outcome), project));
    }
  }, [project, candidates, card, stop]);
  useEffect(() => {
    setCustom((project.fillerReview?.policy.custom ?? []).join("\n"));
  }, [project.fillerReview?.policy.custom]);

  function navigate(next: FillerCandidate | undefined) {
    estimateSerial.current++;
    manualBoundaries.current = false;
    setBoundaryEstimate(null);
    stop();
    setComparison(null);
    setCard(cardFor(next, project));
    setStartMs(0);
    setEndMs(0);
    setError("");
    setNotice("");
    latestAction.current = null;
  }
  function step(delta: number) {
    if (!queue.length) return;
    const next =
      index >= 0
        ? queue[(index + delta + queue.length) % queue.length]
        : delta > 0
          ? (queue.find((c) => c.outputStart >= (card?.candidate.outputStart ?? 0)) ?? queue[0])
          : ([...queue]
              .reverse()
              .find((c) => c.outputStart <= (card?.candidate.outputStart ?? Infinity)) ??
            queue.at(-1));
    navigate(next);
  }
  function commit(next: Project, status: string, proposal?: FillerCutProposal) {
    if (!card) return;
    if (projectSession() !== session.current)
      throw new Error("The project session changed. Reopen filler review.");
    if (next === project) return;
    stop();
    window.dispatchEvent(new CustomEvent("yusafcut:pause"));
    endTypingGroup();
    useProjectStore.getState().commitTranscript(next, project);
    const actual = useProjectStore.getState().project;
    latestAction.current = actual;
    const updated = fillerCandidates(actual).find((c) => c.id === card.candidate.id);
    setCard({ ...card, candidate: updated ?? card.candidate, project: actual, status });
    setComparison(proposal ? { expected: actual, before: project, proposal } : null);
    setError("");
    setNotice("");
  }
  function perform(fn: () => void) {
    try {
      fn();
    } catch (reason) {
      setError(message(reason));
    }
  }
  function play(mode: "before" | "preview" | "result") {
    if (!card) return;
    perform(() => {
      if (card.project !== project)
        throw new Error("The project changed. Select the occurrence again.");
      const saved = comparison?.expected === project ? comparison : null;
      const proposal = saved?.proposal ?? cut.value;
      const timeline =
        mode === "before"
          ? (saved?.before ?? project)
          : mode === "preview"
            ? proposal?.result
            : saved
              ? project
              : undefined;
      if (!timeline)
        throw new Error(
          mode === "result"
            ? "Commit this cut before playing its result."
            : (cut.error ?? "No cut proposal available."),
        );
      const join = proposal?.joinOutput ?? card.candidate.outputStart;
      startFillerAudition({
        expected: project,
        occurrenceId: card.candidate.id,
        timeline,
        mode,
        from: mode === "before" && !proposal ? card.candidate.outputStart : join,
        to:
          mode === "before"
            ? proposal
              ? join + proposal.cutEnd - proposal.cutStart
              : card.candidate.outputEnd
            : join,
        before,
        after,
        loop,
      });
    });
  }
  function changePolicy(nextPolicy: FillerPolicy) {
    perform(() => {
      stop();
      endTypingGroup();
      const next = withFillerPolicy(project, nextPolicy);
      useProjectStore.getState().commitTranscript(next, project);
      setCard(cardFor(queueFor(filter, fillerCandidates(next))[0], next));
      setComparison(null);
      setError("");
      setNotice("");
      latestAction.current = null;
    });
  }
  const canUndo = latestAction.current === project && past.length > 0;
  const saved = comparison?.expected === project ? comparison : null;
  const displayed = card?.candidate;
  const shownProposal = saved?.proposal ?? cut.value;
  const estimatePending =
    boundaryEstimate?.status === "loading" && boundaryEstimate.candidateId === current?.id;
  return (
    <aside
      className="filler-review"
      aria-label="Filler review"
      onKeyDown={(e) => {
        if (!((e.metaKey || e.ctrlKey) && ["z", "s", "e"].includes(e.key.toLowerCase())))
          e.stopPropagation();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Review fillers</h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            stop();
            onClose();
          }}
        >
          Close review
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Highlighted words are candidates for your review. Playback starts only when you ask.
      </p>
      <label className="text-xs">
        Show{" "}
        <select
          aria-label="Review filter"
          value={filter}
          onChange={(e) => {
            const next = e.target.value as Filter;
            setFilter(next);
            navigate(queueFor(next)[0]);
          }}
        >
          {(["Unreviewed", "Kept", "Audio retained", "All"] as const).map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </label>
      <p aria-live="polite" className="text-xs">
        {index >= 0
          ? `${index + 1} of ${queue.length}`
          : card
            ? `Pinned result · ${queue.length} in queue`
            : `${queue.length} in queue`}
      </p>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" disabled={!queue.length} onClick={() => step(-1)}>
          Previous
        </Button>
        <Button size="sm" variant="outline" disabled={!queue.length} onClick={() => step(1)}>
          {filter === "Unreviewed" && index < 0 && card ? "Next unreviewed" : "Next"}
        </Button>
        {skipped.size > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSkipped(new Set());
              navigate(queueFor(filter, candidates, new Set())[0]);
            }}
          >
            Review skipped ({skipped.size})
          </Button>
        )}
      </div>
      {!displayed && (
        <p className="text-sm">
          No occurrences in this queue. Choose another filter or change detection settings.
        </p>
      )}
      {displayed && (
        <>
          <div className="rounded border border-border p-3">
            <p className="text-xl font-semibold break-words">{displayed.text}</p>
            <p className="text-xs text-muted-foreground">
              Source {formatTimecode(displayed.sourceStart, { ms: true })} · Output{" "}
              {formatTimecode(displayed.outputStart, { ms: true })}
            </p>
            <p className="mt-2 text-sm" aria-label="Filler context">
              {card!.context}
            </p>
            <p className="mt-2 text-sm font-medium" aria-live="polite">
              {card?.status ??
                (displayed.hidden
                  ? "Text removed, audio retained"
                  : displayed.outcome === "kept"
                    ? "Kept"
                    : skipped.has(displayed.id)
                      ? "Skipped this session"
                      : "Unreviewed")}
            </p>
            {displayed.residual && (
              <p className="text-xs">
                Some filler edges remain audible. The entire filler text is removed from transcript
                and captions.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              disabled={!current || current.residual}
              onClick={() =>
                perform(() => commit(setFillerDecision(project, current!, "kept"), "Kept"))
              }
            >
              Keep
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!text.value}
              onClick={() => perform(() => commit(text.value!, "Text removed, audio retained"))}
            >
              Remove text only
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!cut.value || estimatePending}
              onClick={() =>
                perform(() =>
                  commit(
                    cut.value!.result,
                    cut.value!.retainedEdges
                      ? "Speech cut; some filler edges retained"
                      : "Filler speech cut",
                    cut.value!,
                  ),
                )
              }
            >
              Cut filler speech
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!current || current.residual}
              onClick={() => {
                const deferred = new Set(skipped).add(displayed.id);
                setSkipped(deferred);
                const nextQueue = queueFor(filter, candidates, deferred).filter(
                  (c) => c.id !== displayed.id,
                );
                navigate(
                  nextQueue.find((c) => c.outputStart >= displayed.outputStart) ?? nextQueue[0],
                );
              }}
            >
              Skip
            </Button>
            {current?.outcome === "kept" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  perform(() => commit(setFillerDecision(project, current, null), "Unreviewed"))
                }
              >
                Reset to unreviewed
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={!canUndo}
              onClick={() => {
                stop();
                endTypingGroup();
                useProjectStore.temporal.getState().undo();
              }}
            >
              Undo this decision
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Keep preserves text and audio. Remove text only hides transcript/caption text and keeps
            duration. Cut filler speech removes the proposed audio interval and all of this
            candidate’s text.
          </p>
          {text.error && <p className="text-xs">Text removal unavailable: {text.error}</p>}
          {cut.error && !saved && <p className="text-xs">Speech cut unavailable: {cut.error}</p>}
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={estimatePending}
              onClick={() => play("before")}
            >
              Play before
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={estimatePending || (!cut.value && !saved)}
              onClick={() => play("preview")}
            >
              Preview cut
            </Button>
            <Button size="sm" variant="outline" disabled={!saved} onClick={() => play("result")}>
              Play result
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (estimatePending) {
                  estimateSerial.current++;
                  manualBoundaries.current = true;
                  setBoundaryEstimate(null);
                }
                stop();
                window.dispatchEvent(new CustomEvent("yusafcut:pause"));
              }}
            >
              Stop
            </Button>
          </div>
          {shownProposal && (
            <div className="relative flex items-center gap-2 text-xs text-muted-foreground">
              <span aria-label="Cut duration change">
                {(shownProposal.cutEnd - shownProposal.cutStart).toFixed(3)} s removed
              </span>
              <details
                className="ml-auto"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.open = false;
                    e.currentTarget.querySelector("summary")?.focus();
                  }
                }}
              >
                <summary
                  aria-label="Cut timing details"
                  title="Cut timing details"
                  className="flex h-6 w-6 cursor-pointer list-none items-center justify-center rounded-full hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
                >
                  <Info className="h-4 w-4" aria-hidden="true" />
                </summary>
                <div className="absolute right-0 top-full z-20 mt-1 w-64 max-w-full space-y-2 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg">
                  <p>
                    Recognized span:{" "}
                    {((shownProposal.recognizedEnd - shownProposal.recognizedStart) * 1000).toFixed(
                      0,
                    )}{" "}
                    ms · {shownProposal.recognizedStart.toFixed(3)}–
                    {shownProposal.recognizedEnd.toFixed(3)} s
                  </p>
                  <p>
                    Neighbor-word limits: {shownProposal.earliestStart.toFixed(3)}–
                    {shownProposal.latestEnd.toFixed(3)} s.
                  </p>
                  {boundaryEstimate?.candidateId === displayed.id && (
                    <p>
                      {boundaryEstimate.status === "applied" ? "Audio estimate applied. " : ""}
                      {boundaryEstimate.message}
                    </p>
                  )}
                  <p>
                    Negative Start expands the cut earlier. Positive End expands it later. Preview
                    to check the join.
                  </p>
                </div>
              </details>
            </div>
          )}
          {boundaryEstimate?.candidateId === displayed.id &&
            boundaryEstimate.status !== "applied" && (
              <p
                role="status"
                aria-label="Audio boundary estimate"
                className="text-xs text-muted-foreground"
              >
                {boundaryEstimate.status === "loading"
                  ? "Estimating boundaries…"
                  : boundaryEstimate.message}
              </p>
            )}
          <details>
            <summary className="cursor-pointer text-sm">Adjust cut boundaries</summary>
            <fieldset
              disabled={!current || current.residual || Boolean(saved)}
              className="space-y-2 rounded border border-border p-2"
            >
              <legend className="sr-only">Cut boundary offsets (milliseconds)</legend>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Estimate from audio"
                  disabled={!current || current.grouped || estimatePending}
                  onClick={() => {
                    manualBoundaries.current = false;
                    requestAudioEstimate(project, current!);
                  }}
                >
                  Estimate audio
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Use recognized timing"
                  onClick={() => {
                    estimateSerial.current++;
                    manualBoundaries.current = true;
                    setBoundaryEstimate(null);
                    stop();
                    setStartMs(0);
                    setEndMs(0);
                  }}
                >
                  Original timing
                </Button>
              </div>

              {(["start", "end"] as const).map((side) => {
                const value = side === "start" ? startMs : endMs;
                const update = (n: number) => {
                  estimateSerial.current++;
                  manualBoundaries.current = true;
                  setBoundaryEstimate(null);
                  stop();
                  setComparison(null);
                  (side === "start" ? setStartMs : setEndMs)(n);
                };
                return (
                  <label key={side} className="block text-xs">
                    {side === "start" ? "Start offset (ms)" : "End offset (ms)"}
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${side} minus 10 ms`}
                        onClick={() => update(value - 10)}
                      >
                        −10
                      </Button>
                      <input
                        aria-label={`${side} offset ms`}
                        type="number"
                        step="10"
                        value={Number.isFinite(value) ? value : ""}
                        onChange={(e) =>
                          update(e.target.value === "" ? NaN : Number(e.target.value))
                        }
                        className="w-20"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${side} plus 10 ms`}
                        onClick={() => update(value + 10)}
                      >
                        +10
                      </Button>
                    </div>
                  </label>
                );
              })}
              {cut.value && (
                <p className="text-xs">
                  Cut {cut.value.cutStart.toFixed(3)}–{cut.value.cutEnd.toFixed(3)} s
                  {cut.value.retainedEdges ? " · Some filler edges will remain audible" : ""}
                </p>
              )}
            </fieldset>
          </details>
        </>
      )}
      <fieldset className="flex flex-wrap gap-2 text-xs">
        <legend>Playback context</legend>
        <label>
          Before (seconds){" "}
          <input
            aria-label="Context before seconds"
            type="number"
            min="0"
            step="0.5"
            value={Number.isFinite(before) ? before : ""}
            onChange={(e) => {
              stop();
              setBefore(e.target.value === "" ? NaN : Number(e.target.value));
            }}
            className="w-16"
          />
        </label>
        <label>
          After (seconds){" "}
          <input
            aria-label="Context after seconds"
            type="number"
            min="0"
            step="0.5"
            value={Number.isFinite(after) ? after : ""}
            onChange={(e) => {
              stop();
              setAfter(e.target.value === "" ? NaN : Number(e.target.value));
            }}
            className="w-16"
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={loop}
            onChange={(e) => {
              stop();
              setLoop(e.target.checked);
            }}
          />{" "}
          Loop
        </label>
      </fieldset>
      <details>
        <summary className="text-sm cursor-pointer">Detection settings</summary>
        <p className="my-2 text-xs text-muted-foreground">
          Vocal fillers are always enabled. Optional words are candidates, even when they carry
          meaning. These choices are saved in the project.
        </p>
        <div className="flex flex-wrap gap-2">
          {OPTIONAL_FILLERS.map((term) => (
            <label className="text-xs" key={term}>
              <input
                type="checkbox"
                checked={policy.optional.includes(term)}
                onChange={(e) =>
                  changePolicy({
                    ...policy,
                    optional: e.target.checked
                      ? [...policy.optional, term]
                      : policy.optional.filter((t) => t !== term),
                  })
                }
              />{" "}
              {term}
            </label>
          ))}
        </div>
        <label className="mt-2 block text-xs">
          Custom literal words/phrases, one per line
          <textarea
            aria-label="Custom filler phrases"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            rows={3}
            className="mt-1 w-full"
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            changePolicy({ ...policy, custom: custom.split("\n").filter((s) => s.trim()) })
          }
        >
          Apply custom phrases
        </Button>
      </details>
      {(notice || auditionMessage) && (
        <p className="text-xs" role="status">
          {notice || auditionMessage}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
