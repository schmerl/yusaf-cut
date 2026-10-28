import { describe, expect, it, vi } from "vitest";
import { detectRetakes, RetakeReviewRun } from "@/lib/retakeWorkflow";
import {
  hypothesisOptions,
  lexicalRetakes,
  retakeRecords,
  retakeWindows,
  semanticHypotheses,
} from "@/lib/retakes";
import { replaceProjectBaseline, useProjectStore, projectSession } from "@/stores/projectStore";
import { speech } from "./helpers/retakeProject";

describe("read-only retake workflow and ephemeral review queue", () => {
  it("requires transcription and treats an empty result normally", async () => {
    const p = speech("One sentence.");
    const analyze = vi.fn();
    expect(await detectRetakes(p, new AbortController().signal, undefined, analyze)).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
    p.segments[0]!.words = [];
    await expect(detectRetakes(p, new AbortController().signal)).rejects.toThrow(/Transcribe/);
  });
  it("running or canceling detection changes no project/history/dirty state", async () => {
    const p = speech("Use POST sorry PUT for updates.");
    replaceProjectBaseline(p);
    const before = useProjectStore.getState();
    let resolve!: (value: []) => void;
    const analysis = new Promise<[]>((r) => {
      resolve = r;
    });
    const controller = new AbortController();
    const pending = detectRetakes(p, controller.signal, undefined, () => analysis);
    controller.abort();
    resolve([]);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(useProjectStore.getState().project).toBe(before.project);
    expect(useProjectStore.getState().dirty).toBe(before.dirty);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
  });
  it("rejects missing, duplicate and invented native responses", async () => {
    const p = speech("Use POST sorry PUT for updates.");
    await expect(
      detectRetakes(p, new AbortController().signal, undefined, async () => []),
    ).rejects.toThrow(/Incomplete/);
    await expect(
      detectRetakes(p, new AbortController().signal, undefined, async (w) => [
        {
          id: w[0]!.id,
          groups: [
            {
              kind: "spoken-correction",
              attempts: [
                { start: 0, end: 1, complete: true },
                { start: 3, end: 4, complete: true },
              ],
              markers: [],
            },
          ],
        },
      ]),
    ).rejects.toThrow(/changed proposed/);
  });
  it("accepts a verified semantic correction without literal overlap", async () => {
    const p = speech("Use POST sorry PUT for updates.");
    const candidates = await detectRetakes(
      p,
      new AbortController().signal,
      undefined,
      async (w) => [
        {
          id: w[0]!.id,
          groups: [
            {
              kind: "spoken-correction",
              attempts: [
                { start: 1, end: 2, complete: true },
                { start: 3, end: 4, complete: true },
              ],
              markers: [{ start: 2, end: 3 }],
            },
          ],
        },
      ],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.suggestedAttemptId).toBe(candidates[0]!.attempts[1]!.id);
  });
  it("accepts the two interrupted restarts while rejecting post and seat wording", async () => {
    const p = speech(
      "HTTP requests and requests [UH] responses. JSON is a JSON is common. Should I post a post? Call it seat field seat num or seat.",
    );
    const candidates = await detectRetakes(
      p,
      new AbortController().signal,
      undefined,
      async (windows) =>
        windows.map((w) => ({
          id: w.id,
          groups: semanticHypotheses(w).flatMap((h) => {
            const first = w.records[h.attempts[0]!.start]!.text.toLowerCase();
            if (h.kind !== "interrupted-restart" || (first !== "requests" && first !== "json"))
              return []; // keep or uncertain
            const option = hypothesisOptions(h)[first === "json" ? 1 : 0]!;
            return [
              {
                ...option,
                attempts: option.attempts.map((a, i) => ({
                  ...a,
                  complete: first === "requests" ? i === 0 : i === 1,
                })),
              },
            ];
          }),
        })),
    );
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.suggestedAttemptId === undefined)).toBe(true);
    expect(candidates.map((c) => c.attempts.map((a) => a.recordIds.length))).toEqual([
      [1, 2],
      [3, 3],
    ]);
  });
  it("dismisses without editing and rejects accepting a resolved or stale candidate", () => {
    const p = speech("The the server responds.");
    replaceProjectBaseline(p);
    const candidates = lexicalRetakes(retakeWindows(retakeRecords(p))[0]!);
    const run = new RetakeReviewRun(p, projectSession(), candidates);
    const candidate = candidates[0]!;
    run.dismiss(candidate);
    expect(run.candidates).toEqual([]);
    expect(run.dismissed).toBe(1);
    expect(useProjectStore.getState().project).toBe(p);
    expect(() => run.plan(candidate, candidate.attempts[1]!.id, p, projectSession())).toThrow(
      /resolved/,
    );
    const stale = new RetakeReviewRun(p, projectSession(), candidates);
    expect(() => stale.check({ ...p }, projectSession())).toThrow(/changed/);
    expect(stale.invalidated).toBe(true);
  });
  it("accepts once, advances its own expected revision and rebases the remaining queue", () => {
    const p = speech("The the server responds. The the client retries.");
    replaceProjectBaseline(p);
    const candidates = lexicalRetakes(retakeWindows(retakeRecords(p))[0]!);
    const run = new RetakeReviewRun(p, projectSession(), candidates);
    const candidate = run.candidates[0]!;
    const plan = run.plan(candidate, candidate.attempts[1]!.id, p, projectSession());
    run.accept(candidate, plan, p, projectSession(), useProjectStore.getState().commitTranscript);
    expect(run.expected).toBe(plan.nextProject);
    expect(run.accepted).toBe(1);
    expect(run.candidates).toHaveLength(1);
    expect(() => run.check(plan.nextProject, projectSession())).not.toThrow();
    expect(() => run.check(plan.nextProject, projectSession() + 1)).toThrow(/changed/);
  });
});
