import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, Extension, type Editor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { Button } from "@/components/ui/button";
import { useProjectStore, endTypingGroup, useTemporalProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { projectTranscript, type ProjectedBlock } from "@/lib/transcript";
import {
  originalTranscriptPassage,
  restoreTranscriptRange,
  applyTranscriptDocument,
  splitTranscriptBlock,
  joinTranscriptBlocks,
  type TextRange,
  type EditorParagraph,
} from "@/lib/transcriptEdits";
import { transcriptMatchContexts, type TranscriptMatch } from "@/lib/transcriptSearch";
import type { Project } from "@/lib/edl";
import { formatTimecode } from "@/lib/timecode";
import { fillerCandidates, type FillerCandidate } from "@/lib/fillerReview";
import { useUIStore } from "@/stores/uiStore";
import { projectSession } from "@/stores/projectStore";
import { useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import { FillerReviewPanel } from "./FillerReviewPanel";
import { FindReplacePanel } from "./FindReplacePanel";
import { InlineReview, selectReviewTarget } from "./InlineReview";
import { useAppCommands } from "@/lib/appCommands";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { isVocalFillerOnly } from "@/lib/scriptMatching";
import { locateScriptRecord } from "@/lib/scriptLifecycle";
import { buildTranscriptCut } from "@/lib/transcriptCut";
import { TranscriptCutPopover, type TranscriptCutSelection } from "./TranscriptCutPopover";

const TimedParagraph = Paragraph.extend({
  addAttributes() {
    return {
      segmentId: { default: null, rendered: false },
      blockId: { default: null, rendered: false },
    };
  },
});

function documentFor(blocks: ProjectedBlock[]) {
  return {
    type: "doc",
    content: blocks.map((b) => ({
      type: "paragraph",
      attrs: { segmentId: b.segmentId, blockId: b.id },
      content: b.text ? [{ type: "text", text: b.text }] : [],
    })),
  };
}
function readDocument(doc: PMNode): EditorParagraph[] {
  const blocks: EditorParagraph[] = [];
  doc.forEach((node) =>
    blocks.push({
      segmentId: node.attrs.segmentId as string,
      blockId: node.attrs.blockId as string,
      text: node.textContent,
    }),
  );
  return blocks;
}
function selectedRanges(editor: Editor): TextRange[] {
  const { from, to } = editor.state.selection;
  if (from === to) return [];
  const ranges: TextRange[] = [];
  editor.state.doc.forEach((node, pos) => {
    const start = Math.max(0, from - pos - 1),
      end = Math.min(node.content.size, to - pos - 1);
    if (end > start)
      ranges.push({
        segmentId: node.attrs.segmentId as string,
        blockId: node.attrs.blockId as string,
        from: start,
        to: end,
      });
  });
  return ranges;
}

interface TranscriptEditorProps {
  findOpen?: boolean;
  onFindOpen?: () => void;
  onFindClose?: () => void;
}

export function TranscriptEditor({
  findOpen = false,
  onFindOpen,
  onFindClose,
}: TranscriptEditorProps) {
  const project = useProjectStore((s) => s.project);
  const session = useProjectStore(() => projectSession());
  const reviewOpen = useUIStore((s) => s.fillerReviewOpen);
  const reviewId = useUIStore((s) => s.fillerReviewCandidateId);
  const reviewIdRef = useRef(reviewId);
  reviewIdRef.current = reviewId;
  const setReviewOpen = useUIStore((s) => s.setFillerReviewOpen);
  const audition = useFillerAuditionStore((s) => s.request);
  const auditionRef = useRef(audition);
  auditionRef.current = audition;
  const currentTime = usePlayerStore((s) => s.currentTime);
  const timelineMarkIn = usePlayerStore((s) => s.timelineMarkIn);
  const timelineMarkOut = usePlayerStore((s) => s.timelineMarkOut);
  const timelineSelection = useRef({ from: timelineMarkIn, to: timelineMarkOut });
  timelineSelection.current = { from: timelineMarkIn, to: timelineMarkOut };
  const projectionCache = useRef<{
    project: Project;
    blocks: Map<string, ProjectedBlock>;
    fillers: FillerCandidate[];
    scripts: {
      id: string;
      segmentId: string;
      blockId: string;
      from: number;
      to: number;
      status: string;
      label: string;
    }[];
  } | null>(null);
  const pauseTokens = useProjectStore((s) => s.pauseTokens);
  const past = useTemporalProjectStore((s) => s.pastStates);
  const blocks = useMemo(() => projectTranscript(project), [project]);
  const model = useRef(project);
  const composed = useRef(false);
  const compositionBase = useRef<Project | null>(null);
  const desiredCaret = useRef<{ segmentId: string; blockId: string; offset: number } | null>(null);
  const pending = useRef<{ expected: Project; next: Project } | null>(null);
  const local = useRef<Project | null>(null);
  const externalDuringComposition = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [error, setError] = useState("");
  const future = useTemporalProjectStore((s) => s.futureStates);
  const [selection, setSelection] = useState<TextRange[]>([]);
  const selectionRef = useRef<TextRange[]>([]);
  const leavingEditor = useRef(false);
  function rememberSelection(ranges: TextRange[]) {
    selectionRef.current = ranges;
    setSelection(ranges);
  }
  function actionRanges(editor: Editor) {
    return leavingEditor.current ? selectionRef.current : selectedRanges(editor);
  }
  const searchResults = useRef<{
    project: Project;
    matches: TranscriptMatch[];
    current: number;
  } | null>(null);
  const [inspection, setInspection] = useState<{ project: Project; range: TextRange } | null>(null);
  const [cutSelection, setCutSelection] = useState<TranscriptCutSelection | null>(null);
  const cutSelectionRef = useRef(cutSelection);
  cutSelectionRef.current = cutSelection;
  const closeCut = useCallback(() => setCutSelection(null), []);
  const onSearchResults = useCallback(
    (project: Project, matches: TranscriptMatch[], current: number) => {
      searchResults.current = { project, matches, current };
      const editor = editorRef.current;
      if (editor && !editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta("search", true));
        editor.view.dom.querySelector(".is-current-match")?.scrollIntoView?.({ block: "center" });
      }
    },
    [],
  );
  const playback = useRef(currentTime);
  playback.current = currentTime;

  function report(error: unknown) {
    setError(error instanceof Error ? error.message : String(error));
  }
  function cut(editor: Editor) {
    endTypingGroup();
    try {
      if (composed.current) throw new Error("Finish typing before cutting speech.");
      const ranges = actionRanges(editor);
      if (!ranges.length) throw new Error("Select the words or complete corrected phrase to cut.");
      buildTranscriptCut(model.current, ranges);
      let anchorPosition = editor.state.selection.from;
      editor.state.doc.forEach((node, pos) => {
        if (
          node.attrs.segmentId === ranges[0]!.segmentId &&
          node.attrs.blockId === ranges[0]!.blockId
        )
          anchorPosition = pos + 1 + ranges[0]!.from;
      });
      selectReviewTarget(null);
      useFillerAuditionStore.getState().stop();
      setCutSelection({
        project: model.current,
        session: projectSession(),
        ranges: ranges.map((range) => ({ ...range })),
        anchor: () => {
          try {
            return editor.view.coordsAtPos(anchorPosition);
          } catch {
            return editor.view.dom.getBoundingClientRect();
          }
        },
      });
      setError("");
    } catch (error) {
      report(error);
    }
  }
  function history(redo = false) {
    if (composed.current) return;
    endTypingGroup();
    const history = useProjectStore.temporal.getState();
    if (redo) history.redo();
    else history.undo();
  }

  const integration = useMemo(
    () =>
      Extension.create({
        name: "transcriptIntegration",
        addProseMirrorPlugins() {
          return [
            new Plugin({
              filterTransaction: (tr) => {
                if (!tr.docChanged || tr.getMeta("externalTranscript")) return true;
                if (composed.current) return true; // draft only; project remains valid during IME
                try {
                  const expected = model.current;
                  const selected = editorRef.current?.state.selection;
                  if (
                    selected &&
                    !selected.empty &&
                    selected.$from.parent !== selected.$to.parent
                  ) {
                    throw new Error(
                      "Replace text within one paragraph at a time. Use Cut speech to remove multiple spoken paragraphs.",
                    );
                  }
                  const next = applyTranscriptDocument(expected, readDocument(tr.doc));
                  pending.current = { expected, next };
                  setError("");
                  return true;
                } catch (error) {
                  report(error);
                  return false;
                }
              },
              props: {
                decorations: (state) => {
                  if (projectionCache.current?.project !== model.current) {
                    const scriptBlocks = projectTranscript(model.current);
                    projectionCache.current = {
                      project: model.current,
                      fillers: fillerCandidates(model.current).filter((c) => !c.hidden),
                      blocks: new Map(scriptBlocks.map((b) => [`${b.segmentId}:${b.id}`, b])),
                      scripts: (model.current.scriptAssistance?.records ?? []).flatMap((record) => {
                        if (
                          !["applied", "suggested", "off-script"].includes(record.status) ||
                          (record.status !== "applied" && isVocalFillerOnly(record.beforeText))
                        )
                          return [];
                        const location = locateScriptRecord(model.current, record, scriptBlocks);
                        return location
                          ? [
                              {
                                id: record.id,
                                label:
                                  record.beforeText !== record.afterText
                                    ? `${record.beforeText} → ${record.afterText}`
                                    : record.status === "off-script"
                                      ? "Possible off-script speech"
                                      : "Uncertain script match",
                                segmentId: location.block.segmentId,
                                blockId: location.block.id,
                                from: location.from,
                                to: location.to,
                                status:
                                  record.status === "applied"
                                    ? "applied"
                                    : record.status === "off-script"
                                      ? "off-script"
                                      : "pending",
                              },
                            ]
                          : [];
                      }),
                    };
                  }
                  const projected = projectionCache.current.blocks;
                  const decorations: Decoration[] = [];
                  state.doc.forEach((node, pos) => {
                    const block = projected.get(
                      `${String(node.attrs.segmentId)}:${String(node.attrs.blockId)}`,
                    );
                    // Draft composition text has not yet been assigned audio anchors.
                    if (!block || block.text !== node.textContent) return;
                    decorations.push(
                      Decoration.widget(
                        pos + 1,
                        () => {
                          const button = document.createElement("button");
                          button.type = "button";
                          button.className = "transcript-time";
                          button.contentEditable = "false";
                          const segment = model.current.segments.find(
                            (s) => s.id === block.segmentId,
                          );
                          const speaker =
                            segment?.transcript?.originals.find(
                              (w) => w.id === block.runs[0]!.anchorIds[0],
                            )?.speaker ??
                            segment?.words.find((w) => w.id === block.runs[0]!.anchorIds[0])
                              ?.speaker;
                          button.textContent = `${speaker ? `${speaker} · ` : ""}${formatTimecode(block.runs[0]!.outputStart, { ms: false })}`;
                          button.setAttribute("aria-label", "Seek to paragraph");
                          button.addEventListener("mousedown", (event) => event.preventDefault());
                          button.addEventListener("click", () =>
                            window.dispatchEvent(
                              new CustomEvent("yusafcut:seek-output", {
                                detail: {
                                  time: block.runs[0]!.outputStart,
                                  play: usePlayerStore.getState().playing,
                                },
                              }),
                            ),
                          );
                          return button;
                        },
                        { key: `${block.segmentId}:${block.id}:time`, side: -1 },
                      ),
                    );
                    const cutRanges =
                      cutSelectionRef.current?.project === model.current
                        ? cutSelectionRef.current.ranges
                        : null;
                    if (cutRanges || leavingEditor.current) {
                      for (const range of cutRanges ?? selectionRef.current) {
                        if (
                          range.segmentId === block.segmentId &&
                          range.blockId === block.id &&
                          range.to <= node.content.size
                        )
                          decorations.push(
                            Decoration.inline(pos + 1 + range.from, pos + 1 + range.to, {
                              class: "is-passage-selected",
                            }),
                          );
                      }
                    }
                    const search = searchResults.current;
                    for (const marker of projectionCache.current!.scripts) {
                      if (marker.segmentId === block.segmentId && marker.blockId === block.id)
                        decorations.push(
                          Decoration.inline(pos + 1 + marker.from, pos + 1 + marker.to, {
                            class: `is-script-${marker.status}`,
                            "data-script-record": marker.id,
                            role: "button",
                            tabindex: "0",
                            "aria-label": marker.label,
                            title: marker.label,
                          }),
                        );
                    }
                    if (search?.project === model.current) {
                      const matches = search.matches.filter(
                        (match) =>
                          match.segmentId === block.segmentId && match.blockId === block.id,
                      );
                      for (const context of transcriptMatchContexts(block.text, matches)) {
                        decorations.push(
                          Decoration.inline(pos + 1 + context.from, pos + 1 + context.to, {
                            class: "is-match-context",
                          }),
                        );
                      }
                      search.matches.forEach((match, index) => {
                        if (match.segmentId === block.segmentId && match.blockId === block.id)
                          decorations.push(
                            Decoration.inline(pos + 1 + match.from, pos + 1 + match.to, {
                              class: `is-match${index === search.current ? " is-current-match" : ""}`,
                            }),
                          );
                      });
                    }
                    for (const candidate of projectionCache.current!.fillers) {
                      if (candidate.segmentId === block.segmentId && candidate.blockId === block.id)
                        decorations.push(
                          Decoration.inline(pos + 1 + candidate.from, pos + 1 + candidate.to, {
                            class: `is-filler${candidate.id === reviewIdRef.current ? " is-review-current" : ""}`,
                            "data-filler-id": candidate.id,
                            role: "button",
                            tabindex: "0",
                            "aria-label": "Review filler",
                            title: "Filler candidate — click to review",
                          }),
                        );
                    }
                    for (const span of block.codeSpans ?? []) {
                      decorations.push(
                        Decoration.inline(pos + 1 + span.from, pos + 1 + span.to, {
                          class: "transcript-code",
                        }),
                      );
                      const quote = () => {
                        const element = document.createElement("span");
                        element.textContent = '"';
                        element.contentEditable = "false";
                        element.className = "transcript-code";
                        return element;
                      };
                      if (span.quote && span.open !== false)
                        decorations.push(
                          Decoration.widget(pos + 1 + span.from, quote, {
                            side: -1,
                            key: `code-open:${block.id}:${span.from}`,
                          }),
                        );
                      if (span.quote && span.close !== false)
                        decorations.push(
                          Decoration.widget(pos + 1 + span.to, quote, {
                            side: 1,
                            key: `code-close:${block.id}:${span.to}`,
                          }),
                        );
                    }
                    for (const run of block.runs) {
                      if (run.from === run.to) continue;
                      const active =
                        !auditionRef.current &&
                        playback.current >= run.outputStart &&
                        playback.current < run.outputEnd;
                      const range = timelineSelection.current;
                      const selected =
                        range.from !== null &&
                        range.to !== null &&
                        run.outputEnd > Math.min(range.from, range.to) &&
                        run.outputStart < Math.max(range.from, range.to);
                      decorations.push(
                        Decoration.inline(pos + 1 + run.from, pos + 1 + run.to, {
                          class: `word${active ? " is-playing" : ""}${selected ? " is-selected" : ""}`,
                          "data-word-id": run.id,
                          "data-run-id": run.id,
                          "data-output-start": String(run.outputStart),
                        }),
                      );
                    }
                  });
                  return DecorationSet.create(state.doc, decorations);
                },
                handlePaste: (view, event) => {
                  event.preventDefault();
                  const text = event.clipboardData?.getData("text/plain") ?? "";
                  view.dispatch(view.state.tr.insertText(text.replace(/\r?\n/g, " ")));
                  return true;
                },
                handleKeyDown: (view, event) => {
                  if (event.isComposing || composed.current) return false;
                  const mod = event.metaKey || event.ctrlKey;
                  const marker = (event.target as HTMLElement)?.closest<HTMLElement>(
                    "[data-script-record], [data-filler-id]",
                  );
                  if (!mod && marker && ["Enter", " "].includes(event.key)) {
                    event.preventDefault();
                    if (marker.dataset.scriptRecord)
                      selectReviewTarget({ kind: "script", id: marker.dataset.scriptRecord });
                    else if (marker.dataset.fillerId)
                      selectReviewTarget({ kind: "filler", id: marker.dataset.fillerId });
                    return true;
                  }
                  if (mod && event.shiftKey && event.key.toLowerCase() === "x") {
                    event.preventDefault();
                    if (editorRef.current) cut(editorRef.current);
                    return true;
                  }
                  if (mod && event.key.toLowerCase() === "z") {
                    event.preventDefault();
                    history(event.shiftKey);
                    return true;
                  }
                  if (event.key === "Enter" && !mod) {
                    event.preventDefault();
                    try {
                      const { $from, empty } = view.state.selection;
                      if (!empty)
                        throw new Error(
                          "Place the cursor between timed words to split the paragraph.",
                        );
                      const next = splitTranscriptBlock(
                        model.current,
                        $from.parent.attrs.segmentId as string,
                        $from.parent.attrs.blockId as string,
                        $from.parentOffset,
                      );
                      const projected = projectTranscript(next);
                      const index = projected.findIndex((b) => b.id === $from.parent.attrs.blockId);
                      desiredCaret.current = {
                        segmentId: projected[index + 1]!.segmentId,
                        blockId: projected[index + 1]!.id,
                        offset: 0,
                      };
                      endTypingGroup();
                      useProjectStore.getState().commitTranscript(next, model.current);
                    } catch (error) {
                      report(error);
                    }
                    return true;
                  }
                  const sel = view.state.selection;
                  const backward =
                    event.key === "Backspace" && sel.empty && sel.$from.parentOffset === 0;
                  const forward =
                    event.key === "Delete" &&
                    sel.empty &&
                    sel.$from.parentOffset === sel.$from.parent.content.size;
                  if (backward || forward) {
                    event.preventDefault();
                    try {
                      const all = projectTranscript(model.current);
                      const i = all.findIndex(
                        (b) =>
                          b.id === sel.$from.parent.attrs.blockId &&
                          b.segmentId === sel.$from.parent.attrs.segmentId,
                      );
                      const left = all[backward ? i - 1 : i],
                        right = all[backward ? i : i + 1];
                      if (!left || !right) return true;
                      if (left.segmentId !== right.segmentId)
                        throw new Error("Cannot join text across clips or cuts.");
                      const next = joinTranscriptBlocks(
                        model.current,
                        left.segmentId,
                        left.id,
                        right.id,
                      );
                      desiredCaret.current = {
                        segmentId: left.segmentId,
                        blockId: left.id,
                        offset: left.text.length,
                      };
                      endTypingGroup();
                      useProjectStore.getState().commitTranscript(next, model.current);
                    } catch (error) {
                      report(error);
                    }
                    return true;
                  }
                  return false;
                },
                handleDOMEvents: {
                  compositionstart: (view) => {
                    composed.current = true;
                    view.dom.setAttribute("data-composing", "true");
                    compositionBase.current = model.current;
                    endTypingGroup();
                    return false;
                  },
                  compositionend: (view) => {
                    // WebKit's final input may arrive after compositionend.
                    timer.current = setTimeout(() => {
                      composed.current = false;
                      view.dom.removeAttribute("data-composing");
                      try {
                        if (
                          externalDuringComposition.current ||
                          model.current !== compositionBase.current
                        ) {
                          throw new Error(
                            "The project changed while typing. Your last valid transcript has been restored.",
                          );
                        }
                        const expected = model.current;
                        const next = applyTranscriptDocument(
                          expected,
                          readDocument(view.state.doc),
                        );
                        local.current = next;
                        model.current = next;
                        useProjectStore.getState().commitTranscript(next, expected);
                        setError("");
                      } catch (error) {
                        report(error);
                        const editor = editorRef.current;
                        if (editor) sync(editor, useProjectStore.getState().project);
                      } finally {
                        compositionBase.current = null;
                        externalDuringComposition.current = false;
                      }
                    }, 0);
                    return false;
                  },
                  blur: () => {
                    endTypingGroup();
                    return false;
                  },
                },
              },
            }),
          ];
        },
        // These callbacks operate on refs, so the editor/plugin remains stable across typing.
      }),
    // Plugin callbacks intentionally read refs; recreating it per render loses editor state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const syncedSession = useRef(projectSession());
  function sync(editor: Editor, p: Project) {
    const sameSession = syncedSession.current === projectSession();
    syncedSession.current = projectSession();
    model.current = p;
    local.current = null;
    pending.current = null;
    const json = documentFor(projectTranscript(p));
    const doc = editor.schema.nodeFromJSON(
      json.content.length ? json : { type: "doc", content: [{ type: "paragraph" }] },
    );
    if (!sameSession) rememberSelection([]);
    if (!desiredCaret.current && doc.eq(editor.state.doc)) {
      editor.view.dispatch(editor.state.tr.setMeta("projection", true));
      return;
    }
    rememberSelection([]);
    const previous = editor.state.selection;
    const logical = desiredCaret.current ?? {
      segmentId: previous.$from.parent.attrs.segmentId as string,
      blockId: previous.$from.parent.attrs.blockId as string,
      offset: previous.$from.parentOffset,
    };
    desiredCaret.current = null;
    const oldIndex = sameSession ? previous.$from.index(0) : 0;
    let caret = 1;
    doc.forEach((node, pos, index) => {
      if (index === Math.min(oldIndex, doc.childCount - 1))
        caret = pos + 1 + Math.min(logical.offset, node.content.size);
    });
    doc.forEach((node, pos) => {
      if (
        sameSession &&
        node.attrs.blockId === logical.blockId &&
        node.attrs.segmentId === logical.segmentId
      ) {
        caret = pos + 1 + Math.min(logical.offset, node.content.size);
      }
    });
    const tr = editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, doc.content)
      .setMeta("externalTranscript", true);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size))));
    const scroll = editor.view.dom.closest(".transcript-scroll");
    const top = scroll?.scrollTop;
    editor.view.dispatch(tr);
    if (scroll && top !== undefined) scroll.scrollTop = sameSession ? top : 0;
  }

  const editor = useEditor({
    extensions: [Document, TimedParagraph, Text, integration],
    content: documentFor(blocks),
    editable: true,
    editorProps: {
      attributes: {
        class: "transcript-editor",
        "aria-label": "Editable transcript",
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onUpdate: () => {
      if (composed.current) return;
      const change = pending.current;
      pending.current = null;
      if (!change) return;
      try {
        local.current = change.next;
        model.current = change.next;
        const ranges = editorRef.current ? selectedRanges(editorRef.current) : [];
        useProjectStore
          .getState()
          .commitTranscript(
            change.next,
            change.expected,
            ranges.length
              ? undefined
              : `typing:${editorRef.current!.state.selection.$from.parent.attrs.blockId as string}`,
          );
      } catch (error) {
        report(error);
        if (editorRef.current) sync(editorRef.current, useProjectStore.getState().project);
      }
    },
    onBlur: ({ editor }) => {
      leavingEditor.current = true;
      const ranges = selectedRanges(editor);
      rememberSelection(ranges.length ? ranges : selectionRef.current);
    },
    onFocus: ({ editor }) => {
      leavingEditor.current = false;
      rememberSelection(selectedRanges(editor));
      editor.view.dispatch(editor.state.tr.setMeta("passageSelection", true));
    },
    onSelectionUpdate: ({ editor, transaction }) => {
      const ranges = selectedRanges(editor);
      if (ranges.length || !leavingEditor.current || transaction.docChanged)
        rememberSelection(ranges);
      if (!transaction.docChanged || !editor.state.selection.empty) endTypingGroup();
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    const capture = (event: MouseEvent) => {
      const outside = !editor.view.dom.contains(event.target as Node);
      if (!outside && leavingEditor.current) rememberSelection([]);
      leavingEditor.current = outside;
      if (outside) {
        const ranges = selectedRanges(editor);
        if (ranges.length) rememberSelection(ranges);
      }
    };
    document.addEventListener("mousedown", capture, true);
    return () => document.removeEventListener("mousedown", capture, true);
  }, [editor]);
  useEffect(() => {
    if (editor && !editor.isDestroyed)
      editor.view.dispatch(editor.state.tr.setMeta("passageSelection", true));
  }, [editor, selection, cutSelection]);
  useEffect(() => {
    if (!editor) return;
    if (composed.current) {
      if (project !== compositionBase.current) externalDuringComposition.current = true;
      return;
    }
    if (syncedSession.current === session && project === local.current) {
      model.current = project;
      editor.view.dispatch(editor.state.tr.setMeta("projection", true));
    } else if (
      syncedSession.current !== session ||
      model.current !== project ||
      readDocument(editor.state.doc)[0]?.blockId !== blocks[0]?.id
    ) {
      sync(editor, project);
    }
    // sync reads refs and stable setters; recreating it must not replace local typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, project, blocks, session]);
  useEffect(() => {
    if (editor && !editor.isDestroyed)
      editor.view.dispatch(editor.state.tr.setMeta("playback", true));
  }, [editor, currentTime, timelineMarkIn, timelineMarkOut, audition, reviewId]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!editor || !reviewId) return;
    const occurrence = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>("[data-filler-id]"),
    ).find((el) => el.dataset.fillerId === reviewId);
    occurrence?.scrollIntoView?.({ block: "nearest" });
  }, [editor, reviewId]);

  useEffect(() => {
    const reveal = (event: Event) => {
      const { segmentId, anchorIds } = (
        event as CustomEvent<{ segmentId: string; anchorIds: string[] }>
      ).detail;
      if (!editor || composed.current) return;
      const block = projectTranscript(model.current).find(
        (b) =>
          b.segmentId === segmentId &&
          b.runs.some((r) => r.anchorIds.some((id) => anchorIds.includes(id))),
      );
      const runs = block?.runs.filter((r) => r.anchorIds.some((id) => anchorIds.includes(id)));
      if (!block || !runs?.length) return;
      editor.state.doc.forEach((node, pos) => {
        if (node.attrs.segmentId === block.segmentId && node.attrs.blockId === block.id)
          editor.commands.setTextSelection({
            from: pos + 1 + runs[0]!.from,
            to: pos + 1 + runs.at(-1)!.to,
          });
      });
      Array.from(editor.view.dom.querySelectorAll<HTMLElement>("[data-run-id]"))
        .find((el) => el.dataset.runId === runs[0]!.id)
        ?.scrollIntoView?.({ block: "center" });
    };
    window.addEventListener("yusafcut:reveal-review", reveal);
    return () => window.removeEventListener("yusafcut:reveal-review", reveal);
  }, [editor]);
  function seek(event: React.MouseEvent) {
    if (
      !event.metaKey &&
      !event.ctrlKey &&
      !composed.current &&
      editorRef.current?.state.selection.empty
    ) {
      const target = event.target as HTMLElement;
      const marker = target.closest<HTMLElement>("[data-script-record], [data-filler-id]");
      if (marker) {
        if (marker.dataset.scriptRecord)
          selectReviewTarget({ kind: "script", id: marker.dataset.scriptRecord });
        else if (marker.dataset.fillerId)
          selectReviewTarget({ kind: "filler", id: marker.dataset.fillerId });
        return;
      }
    }
    if (!event.metaKey && !event.ctrlKey) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-output-start]");
    if (!target) return;
    event.preventDefault();
    window.dispatchEvent(
      new CustomEvent("yusafcut:seek-output", {
        detail: {
          time: Number(target.dataset.outputStart),
          play: usePlayerStore.getState().playing,
        },
      }),
    );
  }
  function inspect(wholeParagraph: boolean) {
    if (!editor || composed.current) {
      report("Finish typing before inspecting originals.");
      return;
    }
    const ranges = actionRanges(editor);
    const parent = editor.state.selection.$from.parent;
    const block = blocks.find(
      (b) => b.segmentId === parent.attrs.segmentId && b.id === parent.attrs.blockId,
    );
    if (!block || (!wholeParagraph && ranges.length !== 1)) {
      report("Select a passage within one paragraph to inspect its original text.");
      return;
    }
    const range = wholeParagraph
      ? { segmentId: block.segmentId, blockId: block.id, from: 0, to: block.text.length }
      : ranges[0]!;
    setInspection({ project, range });
    setError("");
  }
  const original =
    inspection && inspection.project === project
      ? originalTranscriptPassage(project, inspection.range)
      : null;
  const fullParagraphSelected = selection.some((r) => {
    const b = blocks.find((b) => b.id === r.blockId && b.segmentId === r.segmentId);
    return b && r.from === 0 && r.to === b.text.length;
  });
  useAppCommands({
    find: () => onFindOpen?.(),
    "cut-speech": () => {
      if (editor) cut(editor);
    },
    original: () => inspect(!selection.length),
  });

  return (
    <div className="flex h-full w-full flex-col">
      {findOpen && <FindReplacePanel onClose={() => onFindClose?.()} onResults={onSearchResults} />}
      {cutSelection && (
        <TranscriptCutPopover
          selection={cutSelection}
          onClose={closeCut}
          isComposing={() => composed.current}
        />
      )}
      <InlineReview
        selection={selection}
        isComposing={() => composed.current}
        onAdvancedFillers={() => setReviewOpen(true)}
        toolbarActions={
          <>
            <span className="label mr-2">Transcript</span>
            <Button size="sm" variant="ghost" disabled={!past.length} onClick={() => history()}>
              Undo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!future.length}
              onClick={() => history(true)}
            >
              Redo
            </Button>
            {selection.length > 0 && (
              <Button
                size="sm"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor && cut(editor)}
                title="Preview and adjust selected audio/video cut (⌘⇧X)"
              >
                Cut speech
              </Button>
            )}
          </>
        }
      />
      {fullParagraphSelected && (
        <p className="px-4 text-xs text-muted-foreground">
          Paragraph cut includes text-hidden speech
        </p>
      )}
      {inspection && (
        <div
          className="border-b border-border px-4 py-2 text-sm"
          aria-label="Original recognized text"
        >
          {original ? (
            <>
              <p className="font-medium">Original recognized text</p>
              <p>{original.originalText}</p>
              <p className="text-xs text-muted-foreground">
                {original.expanded ? "Includes the whole corrected timing group. " : ""}
                Restores text only. Paragraph restoration includes text-hidden words.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  try {
                    if (composed.current) throw new Error("Finish typing before restoring text.");
                    const current = useProjectStore.getState().project;
                    useProjectStore
                      .getState()
                      .commitTranscript(
                        restoreTranscriptRange(current, inspection.project, inspection.range),
                        inspection.project,
                      );
                    setInspection(null);
                    setError("");
                  } catch (error) {
                    report(error);
                  }
                }}
              >
                Restore original text
              </Button>
            </>
          ) : (
            <p>The transcript changed. Inspect the passage again before restoring.</p>
          )}
          <Button size="sm" variant="ghost" onClick={() => setInspection(null)}>
            Close original text
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {pauseTokens.some((p) => !p.deleted) && (
        <details className="px-4 text-xs">
          <summary>Detected pauses — explicit audio cuts</summary>
          {pauseTokens
            .filter((p) => !p.deleted)
            .map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant="ghost"
                onClick={() => {
                  try {
                    useProjectStore.getState().deletePauseById(p.id);
                  } catch (error) {
                    report(error);
                  }
                }}
              >
                Cut pause at {formatTimecode(p.start)} ({p.duration.toFixed(1)}s)
              </Button>
            ))}
        </details>
      )}
      <div className="transcript-review-layout">
        <div className="transcript-scroll min-w-0 flex-1" onClick={seek}>
          <EditorContent editor={editor} />
        </div>
        {reviewOpen && (
          <Dialog open onOpenChange={setReviewOpen}>
            <DialogContent
              className="max-h-[85vh] overflow-y-auto"
              onEscapeKeyDown={(event) => {
                const details = (event.target as HTMLElement)?.closest("details[open]");
                if (details) {
                  event.preventDefault();
                  details.removeAttribute("open");
                }
              }}
            >
              <DialogTitle>Filler settings and detailed review</DialogTitle>
              <DialogDescription>
                Detection settings, timing adjustments and retained audio.
              </DialogDescription>
              <FillerReviewPanel
                key={`${project.id}:${projectSession()}`}
                onClose={() => setReviewOpen(false)}
              />
            </DialogContent>
          </Dialog>
        )}
      </div>
      {!blocks.length && (
        <p className="p-4 text-sm text-muted-foreground">
          No transcribed speech. Transcribe a clip or undo a cut.
        </p>
      )}
    </div>
  );
}
