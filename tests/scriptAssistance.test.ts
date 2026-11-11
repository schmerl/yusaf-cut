import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/script-assistance.json";
import original from "./fixtures/transcript-corrections.json";
import { prepareScript, replaceStoredScript } from "@/lib/scriptAssistance";
import { validateProjectTranscripts, projectTranscript } from "@/lib/transcript";
import { replaceTranscriptText, restoreTranscriptBlock } from "@/lib/transcriptEdits";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { computeTimeline, type Project } from "@/lib/edl";

const project = () => structuredClone(fixture) as Project;
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
describe("stored scripts and authorship", () => {
  it("validates and round-trips the shared native example without changing text/timeline", () => {
    const p = project();
    validateProjectTranscripts(p);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    expect(projectTranscript(p).map((b) => b.text)).toEqual(
      projectTranscript(original as Project).map((b) => b.text),
    );
    expect(computeTimeline(p)).toEqual(computeTimeline(original as Project));
  });
  it("hashes the exact UTF-8 Markdown copy", async () => {
    const p = project(),
      stored = p.scriptAssistance!.scripts[0]!;
    expect(await prepareScript(stored.markdown, stored.name)).toEqual(stored);
    expect((await prepareScript(stored.markdown + " ", stored.name)).revision).not.toBe(
      stored.revision,
    );
  });
  it("rejects invalid import without touching existing data", async () => {
    const p = project(),
      before = JSON.stringify(p);
    await expect(prepareScript("# Only heading", "bad.md")).rejects.toThrow(/No spoken text/);
    expect(JSON.stringify(p)).toBe(before);
  });
  it("makes replacement atomic and undoable, retaining applied evidence and archiving pending items", async () => {
    const p = project();
    replaceProjectBaseline(p, { filePath: "/tmp/test.scribe", dirty: false });
    const replacement = await prepareScript("# New\n\nA different script.", "new.md");
    const next = replaceStoredScript(p, replacement);
    useProjectStore.getState().commitTranscript(next, p);
    expect(next.segments).toBe(p.segments);
    expect(next.scriptAssistance!.records.find((r) => r.id === "automatic-example")).toEqual(
      p.scriptAssistance!.records[0],
    );
    expect(
      next.scriptAssistance!.records.find((r) => r.id === "pending-example")!.historicalReason,
    ).toMatch(/Script replaced/);
    expect(next.scriptAssistance!.scripts).toContainEqual(p.scriptAssistance!.scripts[0]);
    expect(useProjectStore.getState().dirty).toBe(true);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    useProjectStore.temporal.getState().redo();
    expect(useProjectStore.getState().project).toBe(next);
    expect(replaceStoredScript(next, replacement)).toBe(next);
  });
  it("records manual typing and restoration even when text returns to the baseline", () => {
    const p = project();
    const next = replaceTranscriptText(p, {
      segmentId: "s1",
      blockId: "block-1",
      from: 0,
      to: 11,
      text: "IDEMPOTENCY",
    });
    expect(next.segments[0]!.transcript!.blocks[0]!.runs[0]!.provenance).toEqual({
      author: "manual",
    });
    const restored = restoreTranscriptBlock(p, "s1", "block-1");
    expect(
      restored.segments[0]!.transcript!.blocks[0]!.runs.every(
        (r) => r.provenance?.author === "manual",
      ),
    ).toBe(true);
  });
  it("rejects unsupported versions, malformed ranges, missing evidence and duplicate IDs", () => {
    const mutations: ((p: Project) => void)[] = [
      (p) => {
        p.scriptAssistance!.version = 2 as 1;
      },
      (p) => {
        p.scriptAssistance!.activeRevision = "missing";
      },
      (p) => {
        p.scriptAssistance!.records[0]!.sourceOut = NaN;
      },
      (p) => {
        p.scriptAssistance!.records[0]!.scriptTo = 99999;
      },
      (p) => {
        p.scriptAssistance!.records[0]!.scriptFrom = 10;
      },
      (p) => {
        p.scriptAssistance!.records[0]!.anchorIds = ["missing-audio-anchor"];
      },
      (p) => {
        p.scriptAssistance!.records[0]!.scriptRevision = "missing";
      },
      (p) => {
        p.scriptAssistance!.records.push(p.scriptAssistance!.records[0]!);
      },
      (p) => {
        p.scriptAssistance!.records[0]!.evidence.policy = "";
      },
      (p) => {
        p.scriptAssistance!.records[0]!.evidence.windows = [];
      },
      (p) => {
        p.segments[0]!.transcript!.blocks[0]!.runs[0]!.provenance = {
          author: "unknown" as "manual",
        };
      },
    ];
    for (const mutate of mutations) {
      const p = project();
      mutate(p);
      expect(() => validateProjectTranscripts(p)).toThrow();
    }
  });
});
