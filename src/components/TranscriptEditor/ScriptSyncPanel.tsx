import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { projectTranscript } from "@/lib/transcript";
import {
  locateScriptSync,
  removeScriptSync,
  scriptSections,
  setScriptSync,
} from "@/lib/scriptSync";
import { createScriptRun, runScriptReconciliation, type ScriptRun } from "@/lib/scriptWorkflow";
import { automaticScriptLocations, type AutomaticScriptLocation } from "@/lib/scriptMatching";
import { formatTimecode } from "@/lib/timecode";
import { endTypingGroup, projectSession, useProjectStore } from "@/stores/projectStore";
import { startReviewAudition, useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import { usePlayerStore } from "@/stores/playerStore";

export function ScriptSyncPanel({ isComposing }: { isComposing?: () => boolean }) {
  const project = useProjectStore((s) => s.project);
  const session = useProjectStore(() => projectSession());
  const blocks = useMemo(() => projectTranscript(project), [project]);
  const sections = useMemo(() => scriptSections(project), [project]);
  const key = (index: number) =>
    blocks[index] ? JSON.stringify([blocks[index]!.segmentId, blocks[index]!.id]) : "";
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sectionFrom, setSectionFrom] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [scriptSearch, setScriptSearch] = useState("");
  const initialTime = useRef(usePlayerStore.getState().currentTime);
  const transcriptList = useRef<HTMLDivElement>(null);
  const scriptList = useRef<HTMLDivElement>(null);
  const manualRange = useRef(false);
  const [busy, setBusy] = useState(false);
  const [automatic, setAutomatic] = useState<AutomaticScriptLocation[]>([]);
  const [matching, setMatching] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setAutomatic([]);
    setMatching(true);
    async function match() {
      const found: AutomaticScriptLocation[] = [];
      let lastYield = globalThis.performance.now();
      for (const location of automaticScriptLocations(project)) {
        if (cancelled) return;
        if (location) found.push(location);
        if (globalThis.performance.now() - lastYield >= 8) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (cancelled) return;
          lastYield = globalThis.performance.now();
        }
      }
      if (!cancelled) {
        setAutomatic(found);
        setMatching(false);
      }
    }
    void match();
    return () => {
      cancelled = true;
    };
  }, [project]);
  const run = useRef<ScriptRun | null>(null);
  const stop = useFillerAuditionStore((s) => s.stop);
  useEffect(
    () => () => {
      run.current?.cancel();
      run.current = null;
      stop();
    },
    [stop],
  );
  useEffect(() => {
    setFrom("");
    setTo("");
    manualRange.current = false;
    setSectionFrom(null);
    setError("");
    setNotice("");
    setTranscriptSearch("");
    setScriptSearch("");
    initialTime.current = usePlayerStore.getState().currentTime;
    run.current?.cancel();
  }, [session, project.scriptAssistance?.activeRevision]);
  const nearPlayhead = blocks.findIndex(
    (block) => block.runs.at(-1)!.outputEnd > initialTime.current,
  );
  const chosenStart = blocks.findIndex((_b, index) => key(index) === from);
  const fromIndex =
    chosenStart >= 0
      ? chosenStart
      : nearPlayhead >= 0
        ? nearPlayhead
        : Math.max(0, blocks.length - 1);
  const toIndex = Math.max(
    fromIndex,
    blocks.findIndex((_b, index) => key(index) === to),
  );
  const selected = blocks.slice(fromIndex, toIndex + 1);
  const ranges = selected.map((block) => ({
    segmentId: block.segmentId,
    blockId: block.id,
    from: 0,
    to: block.text.length,
  }));
  const locatedLinks = useMemo(
    () =>
      (project.scriptAssistance?.syncLinks ?? []).flatMap((saved) => {
        const target = sections.find((s) => s.from === saved.scriptFrom && s.to === saved.scriptTo);
        const located = locateScriptSync(project, saved, blocks);
        if (!target || !located) return [];
        const positions = located.map((range) =>
          blocks.findIndex((b) => b.segmentId === range.segmentId && b.id === range.blockId),
        );
        return [
          { sectionFrom: target.from, start: Math.min(...positions), end: Math.max(...positions) },
        ];
      }),
    [project, sections, blocks],
  );
  const navigationLinks = useMemo(() => {
    const suggested: typeof locatedLinks = [];
    for (let index = 0; index < blocks.length; index++) {
      if (locatedLinks.some((link) => link.start <= index && link.end >= index)) continue;
      const block = blocks[index]!;
      const match = automatic.find(
        (location) => location.segmentId === block.segmentId && location.blockId === block.id,
      );
      if (!match) continue;
      const previous = suggested.at(-1);
      if (
        previous &&
        previous.end === index - 1 &&
        previous.sectionFrom === match.sectionFrom &&
        blocks[index - 1]!.segmentId === block.segmentId
      )
        previous.end = index;
      else suggested.push({ sectionFrom: match.sectionFrom, start: index, end: index });
    }
    return [...locatedLinks, ...suggested];
  }, [automatic, blocks, locatedLinks]);
  const currentLink = navigationLinks.find(
    (link) => link.start <= fromIndex && link.end >= toIndex,
  );
  const section = sections.find((s) => s.from === (sectionFrom ?? currentLink?.sectionFrom));
  useEffect(() => {
    transcriptList.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [fromIndex, toIndex, transcriptSearch]);
  useEffect(() => {
    scriptList.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [section?.from, scriptSearch]);
  function selectTranscript(start: number, end: number) {
    manualRange.current = end > start;
    setFrom(key(start));
    setTo(key(end));
    setNotice("");
    const linked = navigationLinks.find((link) => link.start <= start && link.end >= end);
    if (linked) {
      setSectionFrom(linked.sectionFrom);
      setScriptSearch("");
    }
  }
  function selectSection(target: number) {
    setSectionFrom(target);
    setNotice("");
    // A slide may be recorded in multiple takes. Prefer the link nearest the
    // current transcript selection rather than combining separate occurrences.
    const distance = (link: (typeof locatedLinks)[number]) =>
      fromIndex < link.start ? link.start - fromIndex : Math.max(0, fromIndex - link.end);
    const linked = navigationLinks
      .filter((link) => link.sectionFrom === target)
      .sort(
        (a, b) =>
          Number(locatedLinks.includes(b)) - Number(locatedLinks.includes(a)) ||
          distance(a) - distance(b),
      )[0];
    const preserveRange = manualRange.current && linked && !locatedLinks.includes(linked);
    manualRange.current = false;
    if (linked && !preserveRange) {
      setFrom(key(linked.start));
      setTo(key(linked.end));
      setTranscriptSearch("");
    }
  }
  function guard() {
    if (isComposing?.() || document.querySelector('[data-composing="true"]'))
      throw new Error("Finish typing before syncing the script.");
    if (useProjectStore.getState().project !== project)
      throw new Error("The project changed. Choose the passages again.");
    endTypingGroup();
    stop();
    setError("");
  }
  function attempt(action: () => void) {
    try {
      guard();
      action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function link(find: boolean) {
    const captured = projectSession();
    let request: ScriptRun | null = null;
    try {
      guard();
      if (!section) throw new Error("Choose a script section first.");
      const next = setScriptSync(project, ranges, section);
      useProjectStore.getState().commitTranscript(next, project);
      setNotice(
        "Link saved. These transcript paragraphs correspond to this script slide. Find differences will use that pairing.",
      );
      if (!find) return;
      request = createScriptRun();
      run.current = request;
      setBusy(true);
      const result = await runScriptReconciliation(
        request,
        ranges,
        "large-v3-turbo",
        () => {},
        isComposing,
        false,
      );
      if (captured !== projectSession() || run.current !== request) return;
      setNotice(
        `Linked and checked: ${result.pending} suggestions, ${result.offScript} possible off-script passages. Close the script helper to review them in the transcript.`,
      );
    } catch (cause) {
      if (captured === projectSession() && (!request || run.current === request))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (run.current === request) {
        run.current = null;
        setBusy(false);
      }
    }
  }
  const label = (index: number) =>
    `${formatTimecode(blocks[index]!.runs[0]!.outputStart, { ms: false })} · ${blocks[index]!.text.slice(0, 65)}`;
  return (
    <section
      aria-label="Sync script and transcript"
      className="mt-3 flex min-h-0 flex-1 flex-col border-t border-border pt-3"
    >
      <h3 className="shrink-0 font-medium">Sync script and transcript</h3>
      <p className="my-2 shrink-0 text-xs text-muted-foreground">
        Select transcript paragraphs on the left and their corresponding script section on the
        right. The dialog suggests matches automatically; saved links take priority. Click either
        side to reveal its matching passage.
      </p>
      <div className="mb-3 shrink-0 border-b border-border bg-card py-2">
        <p className="mb-2 text-sm" aria-label="Selected script link">
          {selected.length ? (
            <>
              <strong>
                {selected.length} transcript {selected.length === 1 ? "paragraph" : "paragraphs"}
              </strong>{" "}
              ({formatTimecode(selected[0]!.runs[0]!.outputStart, { ms: false })}–
              {formatTimecode(selected.at(-1)!.runs.at(-1)!.outputEnd, { ms: false })})
            </>
          ) : (
            "Choose transcript paragraphs"
          )}
          {" → "}
          <strong>
            {section
              ? `Slide ${sections.indexOf(section) + 1}: ${section.title}`
              : "Choose a script slide"}
          </strong>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy || !section || !selected.length}
            onClick={() => void link(false)}
          >
            Link selected paragraphs to slide
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !section || !selected.length}
            onClick={() => void link(true)}
          >
            Link and find differences
          </Button>
          {busy && (
            <Button size="sm" variant="ghost" onClick={() => run.current?.cancel()}>
              Cancel matching
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
          {matching
            ? "Matching transcript to script…"
            : `${automatic.length} paragraphs automatically matched.`}{" "}
          Automatic matches are suggestions. Link saves your chosen pairing; Link and find
          differences also checks its wording.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-2">
            {notice}
          </p>
        )}
      </div>
      <div className="grid min-h-[36rem] flex-1 grid-cols-1 grid-rows-2 gap-4 md:min-h-0 md:grid-cols-2 md:grid-rows-1">
        <div className="flex min-h-0 min-w-0 flex-col">
          <h4 className="font-medium">Recorded transcript</h4>
          <div className="my-2 flex shrink-0 gap-2">
            <label className="min-w-0 flex-1 text-xs">
              From paragraph
              <select
                aria-label="Transcript range start"
                className="mt-1 w-full rounded border bg-background p-1"
                value={key(fromIndex)}
                disabled={busy}
                onChange={(event) => {
                  const index = blocks.findIndex((_block, i) => key(i) === event.target.value);
                  selectTranscript(index, index);
                }}
              >
                {blocks.map((_block, index) => (
                  <option key={key(index)} value={key(index)}>
                    {label(index)}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 flex-1 text-xs">
              Through paragraph
              <select
                aria-label="Transcript range end"
                className="mt-1 w-full rounded border bg-background p-1"
                value={key(toIndex)}
                disabled={busy}
                onChange={(event) =>
                  selectTranscript(
                    fromIndex,
                    blocks.findIndex((_block, i) => key(i) === event.target.value),
                  )
                }
              >
                {blocks.map(
                  (_block, index) =>
                    index >= fromIndex && (
                      <option key={key(index)} value={key(index)}>
                        {label(index)}
                      </option>
                    ),
                )}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Click a paragraph, then Shift-click another to select a range.
          </p>
          <input
            aria-label="Search transcript paragraphs"
            placeholder="Find words in the transcript…"
            className="mt-2 w-full rounded border bg-background p-2"
            value={transcriptSearch}
            onChange={(event) => setTranscriptSearch(event.target.value)}
          />
          <div
            ref={transcriptList}
            className="mt-2 min-h-0 flex-1 overflow-y-auto rounded border border-border"
            aria-label="Transcript paragraphs"
          >
            {blocks.map(
              (block, index) =>
                block.text.toLocaleLowerCase().includes(transcriptSearch.toLocaleLowerCase()) && (
                  <button
                    key={key(index)}
                    type="button"
                    disabled={busy}
                    aria-pressed={index >= fromIndex && index <= toIndex}
                    className={`block w-full border-b border-border p-2 text-left ${index >= fromIndex && index <= toIndex ? "bg-primary/15" : ""}`}
                    onClick={(event) => {
                      if (event.shiftKey) {
                        selectTranscript(Math.min(fromIndex, index), Math.max(fromIndex, index));
                      } else {
                        selectTranscript(index, index);
                      }
                    }}
                  >
                    <span className="text-xs text-muted-foreground">
                      {formatTimecode(block.runs[0]!.outputStart, { ms: false })}
                    </span>
                    <p>{block.text}</p>
                  </button>
                ),
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 shrink-0 self-start"
            disabled={busy || !selected.length}
            onClick={() =>
              attempt(() =>
                startReviewAudition({
                  expected: project,
                  timeline: project,
                  occurrenceId: "script-sync",
                  mode: "before",
                  from: selected[0]!.runs[0]!.outputStart,
                  to: selected.at(-1)!.runs.at(-1)!.outputEnd,
                  before: 0,
                  after: 0,
                  loop: false,
                  reviewLabel: "Sync passage playback",
                }),
              )
            }
          >
            Play selected passage
          </Button>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
          <h4 className="font-medium">Teleprompter script</h4>
          <p className="my-2 shrink-0 text-xs text-muted-foreground">
            Choose the section that was spoken in the selected transcript range.
          </p>
          <input
            aria-label="Search script sections"
            placeholder="Find words or headings in the script…"
            className="mb-2 w-full rounded border bg-background p-2"
            value={scriptSearch}
            onChange={(event) => setScriptSearch(event.target.value)}
          />
          <div
            ref={scriptList}
            className="min-h-0 flex-1 overflow-y-auto rounded border border-border"
            aria-label="Script sections"
          >
            {sections.map(
              (entry, index) =>
                (entry.title + " " + entry.passages.map((p) => p.text).join(" "))
                  .toLocaleLowerCase()
                  .includes(scriptSearch.toLocaleLowerCase()) && (
                  <button
                    key={entry.from}
                    type="button"
                    disabled={busy || entry.passages.some((p) => p.ambiguous)}
                    aria-pressed={section?.from === entry.from}
                    className={`block w-full border-b border-border p-2 text-left ${section?.from === entry.from ? "bg-primary/15" : ""}`}
                    onClick={() => selectSection(entry.from)}
                  >
                    <strong>
                      {index + 1}. {entry.title}
                    </strong>
                    {entry.passages.map((passage) => (
                      <p key={passage.from} className="mt-2 whitespace-pre-wrap">
                        {passage.text}
                      </p>
                    ))}
                    {entry.passages.some((p) => p.ambiguous) && (
                      <p className="text-xs text-destructive">
                        Fix the script markup warnings before linking this section.
                      </p>
                    )}
                  </button>
                ),
            )}
          </div>
        </div>
      </div>
      {!!project.scriptAssistance?.syncLinks?.length && (
        <details className="mt-3 max-h-[18vh] shrink-0 overflow-y-auto">
          <summary>Saved sync links ({project.scriptAssistance.syncLinks.length})</summary>
          {project.scriptAssistance.syncLinks.map((saved) => {
            const located = locateScriptSync(project, saved, blocks);
            const target = sections.find(
              (s) => s.from === saved.scriptFrom && s.to === saved.scriptTo,
            );
            return (
              <div
                key={saved.id}
                className="mt-2 flex items-center gap-2 rounded border border-border p-2"
              >
                <p className="flex-1">
                  {target?.title ?? "Previous script section"} ·{" "}
                  {located
                    ? `${located.length} transcript paragraphs linked`
                    : "Passage changed — relink this range"}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    attempt(() =>
                      useProjectStore
                        .getState()
                        .commitTranscript(removeScriptSync(project, saved.id), project),
                    )
                  }
                >
                  Remove link
                </Button>
              </div>
            );
          })}
        </details>
      )}
    </section>
  );
}
