import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { loadPeaks } from "@/lib/audioPeaks";
import type { Project, Word } from "@/lib/edl";
import {
  cancelScriptAnalysis,
  listModels,
  transcribeTimelineAudio,
  type WhisperModel,
} from "@/lib/ipc";
import {
  extendSentenceStart,
  extendSentenceEnd,
  findUnattributedSpeech,
  insertGapTranscript,
  type UnattributedSpeech,
} from "@/lib/timelineAnalysis";
import { projectSession, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { formatTimecode } from "@/lib/timecode";

interface Report {
  project: Project;
  session: number;
  peaks: Record<string, number[]>;
}
interface Preview {
  finding: UnattributedSpeech;
  words: Word[];
  project: Project;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useTimelineAnalysis() {
  const project = useProjectStore((s) => s.project);
  const [selection, setSelection] = useState<{ id: string; left: number; bottom: number } | null>(
    null,
  );
  const [transcribing, setTranscribing] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [model, setModel] = useState<WhisperModel | "">("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const request = useRef<{ id: string; cancelled: boolean; native: boolean } | null>(null);
  const stale = !!report && (project !== report.project || projectSession() !== report.session);
  const findings = useMemo(
    () =>
      report && !stale
        ? findUnattributedSpeech(report.project, report.peaks).filter((f) => !dismissed.has(f.id))
        : [],
    [report, stale, dismissed],
  );
  const selected = findings.find((finding) => finding.id === selection?.id);
  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId) return;
    popover.current?.focus({ preventScroll: true });
    const outside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (popover.current?.contains(target) || target.closest("[data-timeline-gap]")) return;
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
    // Selection changes close any existing request through selectFinding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  useEffect(() => {
    if (!transcribing || !selectedId) return;
    let cancelled = false;
    void listModels()
      .then((available) => {
        if (cancelled) return;
        const installed = available
          .filter((m) => m.engine === "whisper-cpp" && m.installed)
          .map((m) => m.name as WhisperModel);
        setModels(installed);
        setModel((previous) =>
          installed.includes(previous as WhisperModel) ? previous : (installed[0] ?? ""),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setModel("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [transcribing, selectedId]);
  useEffect(
    () => () => {
      if (request.current) {
        request.current.cancelled = true;
        if (request.current.native) void cancelScriptAnalysis(request.current.id).catch(() => {});
      }
    },
    [],
  );
  function cancel() {
    if (request.current) {
      request.current.cancelled = true;
      if (request.current.native) void cancelScriptAnalysis(request.current.id).catch(() => {});
      request.current = null;
    }
    setBusy("");
  }
  function begin(label: string, native = false) {
    const run = { id: crypto.randomUUID(), cancelled: false, native };
    request.current = run;
    setBusy(label);
    setError("");
    setNotice("");
    setPreview(null);
    return run;
  }
  async function analyze() {
    const expected = useProjectStore.getState().project,
      session = projectSession();
    const run = begin("Analyzing audio…");
    try {
      const sources = Object.values(expected.media).filter((media) =>
        expected.segments.some((s) => s.mediaId === media.id),
      );
      const entries = await Promise.all(
        sources.map(
          async (media) =>
            [media.id, await loadPeaks(`${media.path}:${media.sha256}`, media.path)] as const,
        ),
      );
      if (run.cancelled) return;
      if (useProjectStore.getState().project !== expected || projectSession() !== session)
        throw new Error("The project changed during analysis. Analyze the timeline again.");
      const peaks = Object.fromEntries(entries);
      findUnattributedSpeech(expected, peaks); // Validate before publishing a report.
      setReport({ project: expected, session, peaks });
      setDismissed(new Set());
    } catch (caught) {
      if (!run.cancelled) setError(message(caught));
    } finally {
      if (request.current === run) {
        request.current = null;
        setBusy("");
      }
    }
  }
  function listen(finding: UnattributedSpeech) {
    const player = usePlayerStore.getState();
    player.setTimelineRange(finding.outputStart, finding.outputEnd);
    player.setCurrentTime(finding.outputStart);
    window.dispatchEvent(
      new CustomEvent("yusafcut:seek-output", {
        detail: { time: finding.outputStart, play: true },
      }),
    );
  }
  async function recognize(finding: UnattributedSpeech) {
    if (!report || stale || !model) return;
    const run = begin("Transcribing selected speech…", true);
    const expected = report.project,
      session = report.session;
    let invalidated = false;
    const unsubscribe = useProjectStore.subscribe((state) => {
      if (state.project !== expected || projectSession() !== session) {
        invalidated = true;
        void cancelScriptAnalysis(run.id).catch(() => {});
      }
    });
    try {
      const result = await transcribeTimelineAudio(
        expected,
        [
          {
            segmentId: finding.segmentId,
            sourceIn: finding.sourceIn,
            sourceOut: finding.sourceOut,
          },
        ],
        run.id,
        model,
      );
      if (run.cancelled) return;
      if (
        invalidated ||
        projectSession() !== session ||
        useProjectStore.getState().project !== expected
      )
        throw new Error("The project changed during transcription. Analyze the timeline again.");
      const window = result.windows[0];
      if (
        !window ||
        window.segmentId !== finding.segmentId ||
        window.sourceIn !== finding.sourceIn ||
        window.sourceOut !== finding.sourceOut
      )
        throw new Error("Recognition did not match the selected audio range. Retry transcription.");
      insertGapTranscript(expected, finding, window.words); // Check recognition before offering Apply.
      setPreview({ project: expected, finding, words: window.words });
    } catch (caught) {
      if (!run.cancelled) setError(message(caught));
    } finally {
      unsubscribe();
      if (request.current === run) {
        request.current = null;
        setBusy("");
      }
    }
  }
  function apply(next: () => Project, text: string) {
    if (!report || stale) return;
    try {
      const result = next();
      useProjectStore.getState().commitTranscript(result, report.project);
      setReport({ ...report, project: useProjectStore.getState().project });
      setPreview(null);
      setSelection(null);
      setTranscribing(false);
      setError("");
      setNotice(text);
      usePlayerStore.getState().clearTimelineRange();
    } catch (caught) {
      setError(message(caught));
    }
  }
  function close() {
    cancel();
    setSelection(null);
    setTranscribing(false);
    setPreview(null);
    window.dispatchEvent(new CustomEvent("yusafcut:pause"));
  }
  function selectFinding(finding: UnattributedSpeech, element: HTMLElement) {
    cancel();
    const rect = element.getBoundingClientRect();
    setSelection({
      id: finding.id,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 388)),
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
    });
    setTranscribing(false);
    setPreview(null);
    setError("");
    setNotice("");
  }
  const controls = (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!!busy}
        onClick={() => {
          close();
          void analyze();
        }}
      >
        Analyze timeline{findings.length ? ` (${findings.length})` : ""}
      </Button>
      {busy && !selected && (
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      )}
      <span className="timeline-analysis-status" role={error && !selected ? "alert" : "status"}>
        {selected
          ? ""
          : error ||
            busy ||
            notice ||
            (stale
              ? "Timeline changed · analyze again"
              : report
                ? findings.length
                  ? "Click a highlighted gap"
                  : "No unattributed audio found"
                : "")}
      </span>
    </>
  );
  const actions =
    selected && selection
      ? createPortal(
          <div
            ref={popover}
            tabIndex={-1}
            role="dialog"
            aria-label="Unattributed audio actions"
            className="timeline-gap-actions"
            style={{ left: selection.left, bottom: selection.bottom }}
          >
            <div className="flex items-center justify-between gap-3">
              <strong className="text-sm">Audio without words</strong>
              <Button size="sm" variant="ghost" aria-label="Close gap actions" onClick={close}>
                ×
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {formatTimecode(selected.outputStart, { ms: true })} –{" "}
              {formatTimecode(selected.outputEnd, { ms: true })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => listen(selected)}
              >
                Listen
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => setTranscribing(true)}
              >
                Transcribe
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  setDismissed((previous) => new Set([...previous, selected.id]));
                  close();
                }}
              >
                Dismiss
              </Button>
            </div>
            <div className="space-y-2">
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                disabled={!!busy || !selected.previousBlockId}
                title={
                  selected.previousSentence
                    ? `Keep wording: ${selected.previousSentence}`
                    : "No preceding sentence shares continuous audio with this gap"
                }
                onClick={() =>
                  apply(
                    () => extendSentenceEnd(report!.project, selected),
                    "Previous sentence timing extended · Undo to restore",
                  )
                }
              >
                Extend previous sentence
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                disabled={!!busy || !selected.nextBlockId}
                title={
                  selected.nextSentence
                    ? `Keep wording: ${selected.nextSentence}`
                    : "No following sentence shares continuous audio with this gap"
                }
                onClick={() =>
                  apply(
                    () => extendSentenceStart(report!.project, selected),
                    "Next sentence timing extended · Undo to restore",
                  )
                }
              >
                Extend next sentence
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Extensions change timing only; sentence text stays the same.
            </p>
            {transcribing && (
              <div className="space-y-2 border-t pt-3">
                <label className="block text-xs">
                  Transcription model
                  <select
                    aria-label="Timeline transcription model"
                    className="mt-1 w-full rounded border bg-background p-2"
                    value={model}
                    disabled={!!busy}
                    onChange={(event) => setModel(event.target.value as WhisperModel)}
                  >
                    {!models.length && <option value="">No local Whisper model installed</option>}
                    {models.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                {!models.length && (
                  <p className="text-xs text-muted-foreground">
                    Install a Whisper model in the toolbar’s transcription settings to transcribe
                    this gap.
                  </p>
                )}
                <Button
                  size="sm"
                  disabled={!!busy || !model}
                  onClick={() => void recognize(selected)}
                >
                  Transcribe speech
                </Button>
              </div>
            )}
            {preview?.finding.id === selected.id && preview.project === project && (
              <div className="space-y-2 border-t pt-3">
                <p className="text-sm">{preview.words.map((word) => word.text).join(" ")}</p>
                <Button
                  size="sm"
                  onClick={() =>
                    apply(
                      () => insertGapTranscript(preview.project, selected, preview.words),
                      "Transcript added · Undo to remove",
                    )
                  }
                >
                  Add to transcript
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                  Discard
                </Button>
              </div>
            )}
            {(error || busy) && (
              <p role={error ? "alert" : "status"} className="text-xs">
                {error || busy}
              </p>
            )}
            {busy && (
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            )}
          </div>,
          document.body,
        )
      : null;
  return { findings, controls, actions, selectFinding };
}
