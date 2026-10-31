import scriptFixture from "./fixtures/script-assistance.json";
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import original from "./fixtures/transcript-corrections.json";
import { computeTimeline, type Project } from "@/lib/edl";
import { prepareScript, replaceStoredScript } from "@/lib/scriptAssistance";
import { createScriptRun, runScriptReconciliation } from "@/lib/scriptWorkflow";
import { scriptReviewAction } from "@/lib/scriptReviewActions";
import { projectTranscript } from "@/lib/transcript";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import type { ScriptAudioEvidence, ScriptAudioWindow } from "@/lib/ipc";

const native = vi.hoisted(() => ({
  analyze: vi.fn(),
  cancel: vi.fn(),
  progress: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
  analyzeScriptAudio: native.analyze,
  cancelScriptAnalysis: native.cancel,
  onScriptProgress: native.progress,
}));
let signal: ((event: { requestId: string; completed: number; total: number }) => void) | undefined;
function evidence(windows: ScriptAudioWindow[]): ScriptAudioEvidence {
  return {
    engine: "test-independent-provider",
    model: "synthetic",
    windows: windows.map((w) => ({ ...w, text: "idempotency aren't the old server" })),
  };
}
async function setup() {
  const p = structuredClone(original) as Project;
  p.segments = [p.segments[1]!];
  const stored = replaceStoredScript(
    p,
    await prepareScript("# Unspoken\n\nIdempotency aren’t the old server.", "script.md"),
  );
  replaceProjectBaseline(stored);
  return stored;
}
function deferredAnalysis() {
  let complete!: (value: ScriptAudioEvidence) => void;
  native.analyze.mockImplementation(
    () =>
      new Promise<ScriptAudioEvidence>((resolve) => {
        complete = resolve;
      }),
  );
  return () => complete(evidence(native.analyze.mock.calls[0]![1]));
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  signal = undefined;
  native.analyze
    .mockReset()
    .mockImplementation((_p: Project, windows: ScriptAudioWindow[]) =>
      Promise.resolve(evidence(windows)),
    );
  native.cancel.mockReset().mockResolvedValue(undefined);
  native.unsubscribe.mockClear();
  native.progress.mockReset().mockImplementation((handler: typeof signal) => {
    signal = handler;
    return Promise.resolve(native.unsubscribe);
  });
});
describe("staged audio reconciliation", () => {
  it("keeps unreviewed applied markers across a matching-policy refresh", async () => {
    replaceProjectBaseline(structuredClone(scriptFixture) as Project);
    await runScriptReconciliation(
      createScriptRun(),
      undefined,
      "large-v3-turbo",
      vi.fn(),
      undefined,
      false,
    );
    expect(
      useProjectStore
        .getState()
        .project.scriptAssistance!.records.find((r) => r.id === "automatic-example"),
    ).toMatchObject({ status: "applied" });
    expect(
      useProjectStore
        .getState()
        .project.scriptAssistance!.records.find((r) => r.id === "automatic-example")!
        .historicalReason,
    ).toBeUndefined();
  });
  it("archives old matching-policy suggestions in the analyzed scope before replacing them", async () => {
    await setup();
    await runScriptReconciliation(
      createScriptRun(),
      undefined,
      "large-v3-turbo",
      vi.fn(),
      undefined,
      false,
    );
    const p = structuredClone(useProjectStore.getState().project);
    p.scriptAssistance!.records = p.scriptAssistance!.records.map((r) => ({
      ...r,
      id: "legacy:" + r.id,
      policy: "script-match-v1",
    }));
    replaceProjectBaseline(p);
    await runScriptReconciliation(
      createScriptRun(),
      undefined,
      "large-v3-turbo",
      vi.fn(),
      undefined,
      false,
    );
    const records = useProjectStore.getState().project.scriptAssistance!.records;
    expect(
      records.filter((r) => r.id.startsWith("legacy:")).every((r) => !!r.historicalReason),
    ).toBe(true);
    expect(records.some((r) => !r.historicalReason && r.policy === "script-match-v2")).toBe(true);
  });
  it("retains valid audio evidence when subsequently finding text differences", async () => {
    await setup();
    await runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn());
    const afterAudio = useProjectStore.getState().project;
    native.analyze.mockClear();
    await runScriptReconciliation(
      createScriptRun(),
      undefined,
      "large-v3-turbo",
      vi.fn(),
      undefined,
      false,
    );
    expect(useProjectStore.getState().project).toBe(afterAudio);
    expect(native.analyze).not.toHaveBeenCalled();
  });
  it("creates immediate review suggestions without a recognizer, progress listener or invented audio evidence", async () => {
    const before = await setup();
    const result = await runScriptReconciliation(
      createScriptRun(),
      undefined,
      "large-v3-turbo",
      vi.fn(),
      undefined,
      false,
    );
    expect(result.pending).toBeGreaterThan(0);
    expect(result.applied).toBe(0);
    expect(native.analyze).not.toHaveBeenCalled();
    expect(native.progress).not.toHaveBeenCalled();
    const after = useProjectStore.getState().project;
    expect(after.segments).toBe(before.segments);
    expect(
      after.scriptAssistance!.records.every(
        (r) =>
          r.evidence.engine === "script-text-comparison-v1" &&
          r.evidence.unprompted === "" &&
          r.evidence.windows === undefined,
      ),
    ).toBe(true);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(before);
  });
  it("can cancel during yielded matching before starting the acoustic provider", async () => {
    const p = await setup(),
      run = createScriptRun();
    let clock = 0;
    const timer = vi.spyOn(globalThis.performance, "now").mockImplementation(() => {
      clock += 10;
      return clock;
    });
    try {
      const pending = runScriptReconciliation(run, undefined, "large-v3-turbo", vi.fn());
      run.cancel();
      await expect(pending).rejects.toThrow(/cancelled/);
      expect(native.analyze).not.toHaveBeenCalled();
      expect(useProjectStore.getState().project).toBe(p);
    } finally {
      timer.mockRestore();
    }
  });
  it("commits records together in one undo step without changing text, anchors or timeline", async () => {
    const p = await setup(),
      run = createScriptRun();
    const result = await runScriptReconciliation(run, undefined, "large-v3-turbo", vi.fn());
    const next = useProjectStore.getState().project;
    expect(result.pending).toBeGreaterThan(0);
    expect(result.applied).toBe(0); // Production automatic policy has not passed evaluation.
    expect(next.segments).toBe(p.segments);
    expect(computeTimeline(next)).toEqual(computeTimeline(p));
    expect(next.scriptAssistance!.records[0]!.evidence.unprompted).toContain("idempotency");
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(1);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    useProjectStore.temporal.getState().redo();
    expect(useProjectStore.getState().project).toBe(next);
    expect(native.unsubscribe).toHaveBeenCalledOnce();
  });
  it("cancellation ignores late results and progress without committing anything", async () => {
    const p = await setup(),
      finish = deferredAnalysis(),
      run = createScriptRun(),
      progress = vi.fn();
    const pending = runScriptReconciliation(run, undefined, "large-v3-turbo", progress);
    await vi.waitFor(() => expect(native.analyze).toHaveBeenCalled());
    run.cancel();
    const calls = progress.mock.calls.length;
    signal!({ requestId: run.id, completed: 1, total: 1 });
    expect(progress.mock.calls).toHaveLength(calls);
    finish();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(useProjectStore.getState().project).toBe(p);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
    expect(native.cancel).toHaveBeenCalledWith(run.id);
  });
  it("rejects an intervening edit even if undo restores the captured project reference", async () => {
    const p = await setup(),
      finish = deferredAnalysis(),
      run = createScriptRun();
    const pending = runScriptReconciliation(run, undefined, "large-v3-turbo", vi.fn());
    await vi.waitFor(() => expect(native.analyze).toHaveBeenCalled());
    const b = projectTranscript(p)[0]!;
    useProjectStore.getState().correctBlock(b.segmentId, b.id, "Changed " + b.text, p);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    finish();
    await expect(pending).rejects.toThrow(/changed/);
    expect(useProjectStore.getState().project).toBe(p);
    expect(useProjectStore.temporal.getState().futureStates).toHaveLength(1);
  });
  it("preserves a new session and script replacement after late completion", async () => {
    for (const change of ["session", "script"]) {
      const p = await setup(),
        finish = deferredAnalysis(),
        run = createScriptRun();
      const pending = runScriptReconciliation(run, undefined, "large-v3-turbo", vi.fn());
      await vi.waitFor(() => expect(native.analyze).toHaveBeenCalled());
      const next =
        change === "session"
          ? { ...p }
          : replaceStoredScript(p, await prepareScript("New spoken material.", "new.md"));
      if (change === "session") replaceProjectBaseline(next);
      else useProjectStore.getState().commitTranscript(next, p);
      finish();
      await expect(pending).rejects.toThrow(/changed/);
      expect(useProjectStore.getState().project).toBe(next);
      native.analyze.mockClear();
    }
  });
  it("second-window failures and missing capabilities commit no staged records", async () => {
    for (const message of ["Second clip failed", "Selected local model is not installed"]) {
      const p = await setup();
      native.analyze.mockRejectedValueOnce(new Error(message));
      await expect(
        runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn()),
      ).rejects.toThrow(message);
      expect(useProjectStore.getState().project).toBe(p);
      expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
    }
  });
  it("does not reopen a dismissed unchanged suggestion or churn history on rerun", async () => {
    await setup();
    await runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn());
    const p = useProjectStore.getState().project,
      id = p.scriptAssistance!.records[0]!.id;
    useProjectStore.getState().commitTranscript(scriptReviewAction(p, id, "dismiss"), p);
    const resolved = useProjectStore.getState().project;
    const count = useProjectStore.temporal.getState().pastStates.length;
    await runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn());
    expect(useProjectStore.getState().project).toBe(resolved);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(count);
    native.analyze.mockImplementation((_p: Project, windows: ScriptAudioWindow[]) =>
      Promise.resolve({ ...evidence(windows), model: "changed-model" }),
    );
    await runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn());
    expect(useProjectStore.getState().project).toBe(resolved);
  });
  it("explicitly regenerates a stale pending item after an edit and restoration, retaining old evidence", async () => {
    await setup();
    await runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn());
    const p = useProjectStore.getState().project,
      b = projectTranscript(p)[0]!;
    useProjectStore.getState().correctBlock(b.segmentId, b.id, "New " + b.text, p);
    const edited = useProjectStore.getState().project;
    useProjectStore.getState().correctBlock(b.segmentId, b.id, b.text, edited);
    const restored = useProjectStore.getState().project;
    expect(restored.scriptAssistance!.records[0]!.historicalReason).toBeTruthy();
    await runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn());
    const regenerated = useProjectStore.getState().project;
    expect(regenerated.scriptAssistance!.records).toHaveLength(2);
    expect(regenerated.scriptAssistance!.records[1]!.historicalReason).toBeUndefined();
    expect(regenerated.scriptAssistance!.records[1]!.id).not.toBe(
      regenerated.scriptAssistance!.records[0]!.id,
    );
    await runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn());
    expect(useProjectStore.getState().project).toBe(regenerated);
  });
  it("rejects mismatched audio bounds and composition before the final commit", async () => {
    const p = await setup();
    native.analyze.mockResolvedValueOnce({ engine: "test", model: "test", windows: [] });
    await expect(
      runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn()),
    ).rejects.toThrow(/scope/);
    await expect(
      runScriptReconciliation(createScriptRun(), undefined, "large-v3-turbo", vi.fn(), () => true),
    ).rejects.toThrow(/typing/);
    expect(useProjectStore.getState().project).toBe(p);
  });
});
