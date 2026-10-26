import { useEffect, useMemo, useRef, useState } from "react";
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
  applyTranscriptDocument,
  splitTranscriptBlock,
  joinTranscriptBlocks,
  type TextRange,
  type EditorParagraph,
} from "@/lib/transcriptEdits";
import type { Project } from "@/lib/edl";
import { formatTimecode } from "@/lib/timecode";
import { FILLER_WORDS } from "./WordNode";
import { FindReplacePanel } from "./FindReplacePanel";

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
  const currentTime = usePlayerStore((s) => s.currentTime);
  const timelineMarkIn = usePlayerStore((s) => s.timelineMarkIn);
  const timelineMarkOut = usePlayerStore((s) => s.timelineMarkOut);
  const timelineSelection = useRef({ from: timelineMarkIn, to: timelineMarkOut });
  timelineSelection.current = { from: timelineMarkIn, to: timelineMarkOut };
  const projectionCache = useRef<{ project: Project; blocks: Map<string, ProjectedBlock> } | null>(
    null,
  );
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
  const [selection, setSelection] = useState<TextRange[]>([]);
  const playback = useRef(currentTime);
  playback.current = currentTime;

  function report(error: unknown) {
    setError(error instanceof Error ? error.message : String(error));
  }
  function cut(editor: Editor) {
    endTypingGroup();
    try {
      if (composed.current) throw new Error("Finish typing before cutting speech.");
      const ranges = selectedRanges(editor);
      if (!ranges.length) throw new Error("Select the words or complete corrected phrase to cut.");
      useProjectStore.getState().cutSpeech(ranges, model.current);
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
                    projectionCache.current = {
                      project: model.current,
                      blocks: new Map(
                        projectTranscript(model.current).map((b) => [`${b.segmentId}:${b.id}`, b]),
                      ),
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
                    for (const run of block.runs) {
                      if (run.from === run.to) continue;
                      const active =
                        playback.current >= run.outputStart && playback.current < run.outputEnd;
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
                  const mod = event.metaKey || event.ctrlKey;
                  if (event.isComposing || composed.current) return false;
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
                  compositionstart: () => {
                    composed.current = true;
                    compositionBase.current = model.current;
                    endTypingGroup();
                    return false;
                  },
                  compositionend: (view) => {
                    // WebKit's final input may arrive after compositionend.
                    timer.current = setTimeout(() => {
                      composed.current = false;
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

  function sync(editor: Editor, p: Project) {
    model.current = p;
    local.current = null;
    pending.current = null;
    const json = documentFor(projectTranscript(p));
    const doc = editor.schema.nodeFromJSON(
      json.content.length ? json : { type: "doc", content: [{ type: "paragraph" }] },
    );
    const previous = editor.state.selection;
    const logical = desiredCaret.current ?? {
      segmentId: previous.$from.parent.attrs.segmentId as string,
      blockId: previous.$from.parent.attrs.blockId as string,
      offset: previous.$from.parentOffset,
    };
    desiredCaret.current = null;
    let caret = 1;
    doc.forEach((node, pos) => {
      if (node.attrs.blockId === logical.blockId && node.attrs.segmentId === logical.segmentId)
        caret = pos + 1 + Math.min(logical.offset, node.content.size);
    });
    const tr = editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, doc.content)
      .setMeta("externalTranscript", true);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size))));
    editor.view.dispatch(tr);
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
    onSelectionUpdate: ({ editor, transaction }) => {
      setSelection(selectedRanges(editor));
      if (!transaction.docChanged || !editor.state.selection.empty) endTypingGroup();
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    if (composed.current) {
      if (project !== compositionBase.current) externalDuringComposition.current = true;
      return;
    }
    if (project === local.current) {
      model.current = project;
      editor.view.dispatch(editor.state.tr.setMeta("projection", true));
    } else if (
      model.current !== project ||
      readDocument(editor.state.doc)[0]?.blockId !== blocks[0]?.id
    ) {
      sync(editor, project);
    }
    // sync uses no reactive state; local echo must not replace the editor document.
  }, [editor, project, blocks]);
  useEffect(() => {
    if (editor && !editor.isDestroyed)
      editor.view.dispatch(editor.state.tr.setMeta("playback", true));
  }, [editor, currentTime, timelineMarkIn, timelineMarkOut]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function seek(event: React.MouseEvent) {
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
  const fullParagraphSelected = selection.some((r) => {
    const b = blocks.find((b) => b.id === r.blockId && b.segmentId === r.segmentId);
    return b && r.from === 0 && r.to === b.text.length;
  });
  return (
    <div className="flex h-full w-full flex-col">
      {findOpen && <FindReplacePanel onClose={() => onFindClose?.()} />}
      <div className="transcript-toolbar flex-wrap">
        <span className="label">Transcript</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => (findOpen ? onFindClose?.() : onFindOpen?.())}
        >
          Search
        </Button>
        <Button
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          disabled={!selection.length}
          onClick={() => editor && cut(editor)}
          title="Remove selected audio/video (⌘⇧X)"
        >
          Cut speech ⌘⇧X
        </Button>
        <Button size="sm" variant="ghost" disabled={!past.length} onClick={() => history()}>
          Undo
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            try {
              endTypingGroup();
              useProjectStore.getState().deleteWordsByText(FILLER_WORDS);
            } catch (error) {
              report(error);
            }
          }}
        >
          Cut filler speech
        </Button>
        {fullParagraphSelected && (
          <span className="text-xs text-muted-foreground">
            Paragraph cut includes text-hidden speech
          </span>
        )}
      </div>
      <p className="px-4 text-xs text-muted-foreground">
        Typing edits text only. Cmd-click seeks. Cut speech changes the video.
      </p>
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
      <div className="transcript-scroll flex-1" onClick={seek}>
        <EditorContent editor={editor} />
      </div>
      {!blocks.length && (
        <p className="p-4 text-sm text-muted-foreground">
          No transcribed speech. Transcribe a clip or undo a cut.
        </p>
      )}
    </div>
  );
}
