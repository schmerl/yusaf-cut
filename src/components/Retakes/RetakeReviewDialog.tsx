import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { TimelinePlayer } from "@/components/VideoPreview/TimelinePlayer";
import { createPlayerStore, usePlayerStore } from "@/stores/playerStore";
import { projectSession, useProjectStore } from "@/stores/projectStore";
import { downloadRetakeModel, retakeModelStatus, type RetakeModelStatus } from "@/lib/retakeIpc";
import { detectRetakes, RetakeReviewRun } from "@/lib/retakeWorkflow";
import { retakeRecords } from "@/lib/retakes";
import { totalDuration } from "@/lib/edl";

const SCOPE = "retake-audition";
type Stage = "loading" | "ready" | "downloading" | "detecting" | "review" | "stale";
export function RetakeReviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open) return null;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <RetakeReviewContent />
    </Dialog>
  );
}
function RetakeReviewContent() {
  const project = useProjectStore((s) => s.project);
  const captured = useRef(project);
  const session = useRef(projectSession());
  const alive = useRef(true);
  const task = useRef<AbortController | null>(null);
  const runRef = useRef<RetakeReviewRun | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [model, setModel] = useState<RetakeModelStatus | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [run, setRun] = useState<RetakeReviewRun | null>(null);
  const [selected, setSelected] = useState<string>();
  const [, refresh] = useState(0);
  const [auditionStore] = useState(createPlayerStore);
  const [audition, setAudition] = useState<{ mode: "original" | "proposed"; key: number } | null>(
    null,
  );
  const auditionKey = useRef(0);
  const hasTranscript = project.segments.some((s) => s.words.length > 0);
  const candidate = run?.candidates[0];
  const records = useMemo(() => retakeRecords(project), [project]);
  const recordById = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const cut = useMemo(() => {
    if (!run || !candidate || !selected || stage !== "review") return { plan: null, message: "" };
    try {
      return { plan: run.plan(candidate, selected, project, projectSession()), message: "" };
    } catch (e) {
      return { plan: null, message: e instanceof Error ? e.message : String(e) };
    }
  }, [run, candidate, selected, project, stage]);
  const originalRange = useMemo(() => {
    if (!candidate) return null;
    const first = recordById.get(candidate.envelopeIds[0]!);
    const last = recordById.get(candidate.envelopeIds.at(-1)!);
    return first && last
      ? { start: Math.max(0, first.start - 2), end: Math.min(totalDuration(project), last.end + 2) }
      : null;
  }, [candidate, recordById, project]);
  const context = originalRange
    ? records
        .filter((r) => r.end > originalRange.start && r.start < originalRange.end)
        .map((r) => r.text)
        .join(" ")
    : "";
  const busy = stage === "detecting" || stage === "downloading";

  useEffect(() => {
    alive.current = true;
    window.dispatchEvent(new CustomEvent("yusafcut:pause"));
    usePlayerStore.getState().setPlaying(false);
    const unsubscribe = useProjectStore.subscribe((state) => {
      const expected = runRef.current?.expected ?? captured.current;
      if (state.project === expected && projectSession() === session.current) return;
      if (runRef.current) runRef.current.invalidated = true;
      task.current?.abort();
      auditionStore.getState().setPlaying(false);
      setAudition(null);
      setStage("stale");
      setError("");
    });
    return () => {
      alive.current = false;
      task.current?.abort();
      unsubscribe();
      auditionStore.getState().setPlaying(false);
    };
  }, [auditionStore]);
  useEffect(() => {
    let active = true;
    if (!hasTranscript) {
      setStage("ready");
      return;
    }
    void retakeModelStatus()
      .then((status) => {
        if (active) {
          setModel(status);
          setStage((s) => (s === "loading" ? "ready" : s));
        }
      })
      .catch((e) => {
        if (active) {
          setError(String(e));
          setStage((s) => (s === "loading" ? "ready" : s));
        }
      });
    return () => {
      active = false;
    };
  }, [hasTranscript]);

  async function download() {
    const controller = new AbortController();
    task.current = controller;
    setStage("downloading");
    setProgress(0);
    setError("");
    try {
      await downloadRetakeModel(controller.signal, setProgress);
      const status = await retakeModelStatus();
      if (alive.current && !controller.signal.aborted) {
        setModel(status);
        setStage("ready");
      }
    } catch (e) {
      if (alive.current && !controller.signal.aborted) {
        setError(String(e));
        setStage("ready");
      }
    }
  }
  async function detect() {
    captured.current = useProjectStore.getState().project;
    session.current = projectSession();
    const before = captured.current,
      generation = session.current;
    const controller = new AbortController();
    task.current?.abort();
    task.current = controller;
    runRef.current = null;
    setRun(null);
    setAudition(null);
    setStage("detecting");
    setProgress(0);
    setError("");
    try {
      const candidates = await detectRetakes(before, controller.signal, setProgress);
      if (!alive.current || controller.signal.aborted) return;
      if (useProjectStore.getState().project !== before || projectSession() !== generation) {
        setStage("stale");
        return;
      }
      const next = new RetakeReviewRun(before, generation, candidates);
      runRef.current = next;
      setRun(next);
      setSelected(candidates[0]?.suggestedAttemptId);
      setStage("review");
    } catch (e) {
      if (alive.current && !controller.signal.aborted) {
        setError(String(e));
        setStage("ready");
      }
    }
  }
  function cancel() {
    task.current?.abort();
    setStage("ready");
    setProgress(0);
    setAudition(null);
  }
  function play(mode: "original" | "proposed") {
    const range = mode === "original" ? originalRange : cut.plan?.editedAudition;
    if (!range) return;
    // Mount and register its scoped handlers while still in the user's click.
    flushSync(() => setAudition({ mode, key: ++auditionKey.current }));
    window.dispatchEvent(
      new CustomEvent(`${SCOPE}:seek-output`, { detail: { time: range.start, play: true } }),
    );
  }
  function advance() {
    setAudition(null);
    auditionStore.getState().setPlaying(false);
    setSelected(run?.candidates[0]?.suggestedAttemptId);
    refresh((v) => v + 1);
  }
  function dismiss() {
    if (run && candidate) {
      run.dismiss(candidate);
      advance();
    }
  }
  function accept() {
    if (!run || !candidate || !cut.plan) return;
    try {
      run.accept(
        candidate,
        cut.plan,
        useProjectStore.getState().project,
        projectSession(),
        useProjectStore.getState().commitTranscript,
      );
      advance();
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  function onKeyDown(event: React.KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey,
      key = event.key.toLowerCase();
    if (mod && ["s", "e", "z", "x"].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!audition || ![" ", "j", "k", "l"].includes(key)) return;
    if (key === " " && (event.target as HTMLElement).closest("button,input,select")) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === " " || key === "k")
      window.dispatchEvent(new CustomEvent(`${SCOPE}:${key === " " ? "toggle-play" : "pause"}`));
    else
      window.dispatchEvent(
        new CustomEvent(`${SCOPE}:seek-output`, {
          detail: {
            time: auditionStore.getState().currentTime + (key === "j" ? -3 : 3),
            play: true,
          },
        }),
      );
  }
  return (
    <DialogContent
      data-retake-review
      className="max-h-[90vh] max-w-3xl overflow-y-auto"
      onKeyDownCapture={onKeyDown}
    >
      <DialogHeader>
        <DialogTitle>Retakes and false starts</DialogTitle>
        <DialogDescription>
          Find nearby attempts at the same thought. Listen, choose a take, and accept each cut
          individually.
        </DialogDescription>
      </DialogHeader>
      {!hasTranscript ? (
        <p>Transcribe the project before finding retakes.</p>
      ) : (
        <>
          {stage === "loading" && <p role="status">Checking local retake model…</p>}
          {model && !model.installed && !busy && (
            <div className="space-y-3 rounded-md border border-border p-4 text-sm">
              <p>
                Download the local retake model ({(model.sizeBytes / 1e9).toFixed(1)} GB). Analysis
                runs on this Mac. Apple Silicon with 16 GB memory is recommended.
              </p>
              <Button onClick={() => void download()}>Download retake model</Button>
            </div>
          )}
          {busy && (
            <div className="space-y-3">
              <p role="status">
                {stage === "detecting" ? "Finding likely retakes…" : "Downloading retake model…"}{" "}
                {Math.round(progress * 100)}%
              </p>
              <Progress value={progress * 100} />
              <Button variant="outline" onClick={cancel}>
                Cancel
              </Button>
            </div>
          )}
          {stage === "stale" && (
            <p role="alert">The project changed. Run detection again before reviewing cuts.</p>
          )}
          {!busy && stage !== "loading" && model?.installed && (
            <Button variant="outline" onClick={() => void detect()}>
              {run || stage === "stale" ? "Run detection again" : "Find retakes"}
            </Button>
          )}
          {error && (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-red-400">
                {error}
              </p>
              {!busy && (
                <Button variant="outline" onClick={() => void download()}>
                  Download / repair retake model
                </Button>
              )}
            </div>
          )}
          {stage === "review" && run && !candidate && (
            <p role="status">
              {run.accepted + run.dismissed
                ? `All candidates reviewed. ${run.accepted} accepted, ${run.dismissed} dismissed.`
                : "No likely retakes found."}
            </p>
          )}
          {stage === "review" && candidate && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {candidate.explanation} · {run!.candidates.length} remaining · {run!.accepted}{" "}
                accepted · {run!.dismissed} dismissed
              </p>
              <p className="rounded-md bg-muted/30 p-3 text-sm" aria-label="Passage context">
                {context}
              </p>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Choose the take to keep</legend>
                {candidate.attempts.map((attempt, index) => (
                  <label
                    key={attempt.id}
                    className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-sm"
                  >
                    <input
                      type="radio"
                      name="retake-take"
                      checked={selected === attempt.id}
                      onChange={() => {
                        setSelected(attempt.id);
                        setAudition(null);
                        auditionStore.getState().setPlaying(false);
                      }}
                      aria-label={`Keep take ${index + 1}`}
                    />
                    <span>
                      <strong>Take {index + 1}</strong>
                      {attempt.id === candidate.suggestedAttemptId && (
                        <span className="ml-2 text-primary">Suggested</span>
                      )}
                      {!attempt.complete && (
                        <span className="ml-2 text-muted-foreground">Fragment / uncertain</span>
                      )}
                      <span className="mt-1 block">
                        {attempt.recordIds.map((id) => recordById.get(id)?.text ?? "").join(" ")}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {cut.message && (
                <p role="alert" className="text-sm text-amber-400">
                  {cut.message}
                </p>
              )}
              {cut.plan && (
                <p className="text-xs text-muted-foreground">
                  Proposed removal:{" "}
                  {(totalDuration(project) - totalDuration(cut.plan.nextProject)).toFixed(2)}{" "}
                  seconds. Previewing leaves the edit unchanged.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => play("original")}>
                  Play original
                </Button>
                <Button variant="outline" disabled={!cut.plan} onClick={() => play("proposed")}>
                  Preview cut
                </Button>
                <Button disabled={!cut.plan} onClick={accept}>
                  Accept cut
                </Button>
                <Button variant="ghost" onClick={dismiss}>
                  Dismiss
                </Button>
              </div>
              {audition && originalRange && (audition.mode === "original" || cut.plan) && (
                <div className="h-[300px] overflow-hidden rounded-md border border-border">
                  <TimelinePlayer
                    key={audition.key}
                    project={audition.mode === "proposed" ? cut.plan!.nextProject : project}
                    playerStore={auditionStore}
                    eventScope={SCOPE}
                    auditionRange={
                      audition.mode === "proposed" ? cut.plan!.editedAudition : originalRange
                    }
                    label={
                      audition.mode === "proposed"
                        ? "Proposed cut — not accepted"
                        : "Original passage"
                    }
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </DialogContent>
  );
}
