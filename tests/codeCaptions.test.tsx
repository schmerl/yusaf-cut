import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMediaWithTranscript, newProject, computeTimeline, type Project } from "@/lib/edl";
import { buildCues, buildVtt, buildSrt, buildUntimedTranscript } from "@/lib/captions";
import {
  normalizeProjectTranscripts,
  projectTranscript,
  validateProjectTranscripts,
} from "@/lib/transcript";
import { replaceTranscriptText, cutTranscriptRanges } from "@/lib/transcriptEdits";
import { parseScript } from "@/lib/scriptMarkdown";
import { createScriptRun, runScriptReconciliation } from "@/lib/scriptWorkflow";
import { scriptCandidates } from "@/lib/scriptMatching";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import fixture from "./fixtures/transcript-corrections.json";

function project(text: string, markdown: string): Project {
  return {
    ...addMediaWithTranscript(
      newProject("Code captions"),
      fixture.media.m1,
      text.split(/\s+/u).map((text, i) => ({
        id: `word-${i}`,
        text,
        start: i * 0.2,
        end: i * 0.2 + 0.18,
        confidence: 1,
      })),
    ),
    scriptAssistance: {
      version: 1,
      activeRevision: "a".repeat(64),
      records: [],
      scripts: [{ revision: "a".repeat(64), name: "script.md", markdown }],
    },
  };
}
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const compact = (text: string) => text.replace(/\s+/gu, " ");

describe("script code in transcripts and captions", () => {
  it("quotes and bolds inline code in VTT, keeping only quotes in SRT and plain text", () => {
    const p = project("We use GraphQL for queries.", "We use `GraphQL` for queries.");
    const original = JSON.stringify(p);
    expect(buildVtt(p)).toContain('We use <b>"GraphQL"</b> for queries.');
    expect(buildSrt(p)).toContain('We use "GraphQL" for queries.');
    expect(buildSrt(p)).not.toContain("<b>");
    expect(buildUntimedTranscript(p)).toBe('We use "GraphQL" for queries.\n');
    expect(projectTranscript(p)[0]!.text).toBe("We use GraphQL for queries.");
    expect(JSON.stringify(p)).toBe(original);
  });
  it("preserves exact code offsets after cues, Unicode, escaping and Markdown normalization", () => {
    const passage = parseScript("<press> 👋 Use `` GraphQL `` and `GET /α` now.").passages[0]!;
    expect(passage.inlineCode.map((span) => passage.text.slice(span.from, span.to))).toEqual([
      "GraphQL",
      "GET /α",
    ]);
  });
  it("styles a term according to context when the script also uses it in ordinary prose", () => {
    const p = project(
      "Explain the query today. Execute the query now.",
      "Explain the query today. Execute the `query` now.",
    );
    const vtt = compact(buildVtt(p));
    expect(vtt).toContain('Explain the query today. Execute the <b>"query"</b> now.');
    expect(vtt.match(/<b>/gu)).toHaveLength(1);
    const ambiguous = project(
      "GraphQL powers queries. GraphQL powers queries.",
      "`GraphQL` powers queries.\n\nGraphQL powers queries.",
    );
    expect(buildVtt(ambiguous)).not.toContain("<b>");
  });
  it("escapes technical symbols as literal VTT text and handles multi-word code", () => {
    const p = project("Use <T> with x & y.", "Use `<T>` with `x & y`.");
    expect(buildVtt(p)).toContain('Use <b>"&lt;T&gt;"</b> with <b>"x &amp; y"</b>.');
    expect(buildUntimedTranscript(p)).toBe('Use "<T>" with "x & y".\n');
    const literal = project("Literal <b> tags & text.", "Literal tags and text.");
    expect(buildVtt(literal)).toContain("&lt;b&gt; tags &amp; text.");
  });
  it("does not double existing quotes or include headings, comments, fenced code or malformed markup", () => {
    expect(buildVtt(project('Use "GraphQL" here.', "Use `GraphQL` here."))).toContain(
      '<b>"GraphQL"</b>',
    );
    const p = project(
      "GraphQL hidden fenced broken.",
      "# `GraphQL`\n\n<!-- `hidden` -->\n\n```\nfenced\n```\n\nUse `broken.",
    );
    expect(buildVtt(p)).not.toContain("<b>");
  });
  it("keeps formatting inside a merged replacement without inventing word timings", () => {
    let p = project("We use graph QL for queries.", "We use `GraphQL` for queries.");
    const b = projectTranscript(p)[0]!;
    p = replaceTranscriptText(p, {
      segmentId: b.segmentId,
      blockId: b.id,
      from: 0,
      to: b.text.length,
      text: "We use GraphQL for queries.",
    });
    const before = JSON.stringify(p);
    expect(buildVtt(p)).toContain('We use <b>"GraphQL"</b> for queries.');
    const cue = buildCues(p)[0]!;
    const run = projectTranscript(p)[0]!.runs[0]!;
    expect([cue.start, cue.end]).toEqual([run.outputStart, run.outputEnd]);
    expect(JSON.stringify(p)).toBe(before);
  });
  it("keeps tags balanced when code crosses cues and paragraphs", () => {
    const p = project("GET /users", "`GET /users`");
    p.segments[0]!.words[1]!.start = 3;
    p.segments[0]!.words[1]!.end = 3.2;
    const vtt = buildVtt(p);
    expect(vtt).toContain('<b>"GET</b>');
    expect(vtt).toContain('<b>/users"</b>');
    expect(vtt.match(/<b>/gu)).toHaveLength(2);
    expect(vtt.match(/<\/b>/gu)).toHaveLength(2);
    expect(buildUntimedTranscript(p)).toBe('"GET /users"\n');
  });
  it("follows reused clips and cuts, including hidden text", () => {
    let p = normalizeProjectTranscripts(
      project("We use GraphQL for queries.", "We use `GraphQL` for queries."),
    );
    const segment = structuredClone(p.segments[0]!);
    segment.id = "reuse";
    segment.transcript!.occurrenceId = "reuse";
    p = { ...p, segments: [segment, p.segments[0]!] };
    expect(buildVtt(p).match(/<b>/gu)).toHaveLength(2);
    const b = projectTranscript(p)[0]!,
      run = b.runs.find((r) => r.text === "GraphQL")!;
    p = replaceTranscriptText(p, {
      segmentId: b.segmentId,
      blockId: b.id,
      from: run.from,
      to: run.to,
      text: "",
    });
    expect(buildVtt(p).match(/<b>/gu)).toHaveLength(1);
    const other = projectTranscript(p)[1]!,
      term = other.runs.find((r) => r.text === "GraphQL")!;
    p = cutTranscriptRanges(p, [
      { segmentId: other.segmentId, blockId: other.id, from: term.from, to: term.to },
    ]);
    expect(buildVtt(p)).not.toContain("<b>");
  });
  it("shows accepted reconciliation as bold quoted code and retains styling after save/reopen", async () => {
    const p = project(
      "We use graph QL for these precise queries.",
      "We use `GraphQL` for these precise queries.",
    );
    replaceProjectBaseline(p);
    await runScriptReconciliation(
      createScriptRun(),
      undefined,
      "large-v3-turbo",
      vi.fn(),
      undefined,
      false,
    );
    let current = useProjectStore.getState().project;
    const record = current.scriptAssistance!.records.find((r) => r.afterText === "GraphQL")!;
    expect(record).toBeDefined();
    render(<TranscriptEditor />);
    fireEvent.click(
      Array.from(document.querySelectorAll<HTMLElement>("[data-script-record]")).find(
        (el) => el.dataset.scriptRecord === record.id,
      )!,
    );
    const popup = within(screen.getByRole("dialog", { name: "Review suggestion" }));
    expect(popup.getByText('"GraphQL"').tagName).toBe("STRONG");
    fireEvent.click(popup.getByRole("button", { name: "Accept" }));
    current = useProjectStore.getState().project;
    expect(
      Array.from(
        screen
          .getByRole("textbox", { name: "Editable transcript" })
          .querySelectorAll(".transcript-code"),
      )
        .map((el) => el.textContent)
        .join(""),
    ).toBe('"GraphQL"');
    expect(projectTranscript(current)[0]!.text).toBe("We use GraphQL for these precise queries.");
    expect(scriptCandidates(current)).toEqual([]);
    const saved = JSON.stringify(current);
    expect(saved).not.toContain("<b>");
    expect(saved).not.toContain('"codeSpans"');
    const reopened = JSON.parse(saved) as Project;
    validateProjectTranscripts(reopened);
    expect(compact(buildVtt(reopened))).toContain('<b>"GraphQL"</b>');
    expect(buildUntimedTranscript(reopened)).toContain('"GraphQL"');
    expect(computeTimeline(reopened)).toEqual(computeTimeline(p));
    expect(reopened.segments.map((s) => s.words)).toEqual(p.segments.map((s) => s.words));
  });
});
