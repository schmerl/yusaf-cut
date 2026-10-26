/**
 * The project store is the single source of truth for the EDL.
 *
 * Every edit funnels through this store; `zundo` wraps it to give us undo/redo
 * with a 50-step ring buffer (per spec Phase 4).
 *
 * Heuristic: snapshot on every edit. We are not concerned about memory — the
 * EDL is tiny compared to the media files it references.
 */

import { temporal, type TemporalState } from "zundo";
import { create, useStore } from "zustand";
import {
  addAudioTrack,
  addChapter,
  addMediaWithTranscript,
  deleteWords,
  newProject,
  removeAudioTrack,
  removeChapter,
  removeSilences,
  renameChapter,
  updateAudioTrack,
  type AudioTrack,
  type Project,
  type SourceMedia,
  type Word,
} from "@/lib/edl";
import {
  editBlockText,
  cutOutputSpeech,
  cutTranscriptRanges,
  replaceTranscriptBatch,
  restoreTranscriptBlock,
  type TextEdit,
  type TextRange,
} from "@/lib/transcriptEdits";
import { projectTranscript, validateProjectTranscripts } from "@/lib/transcript";
import type { PauseSegment } from "@/lib/ipc";

interface ProjectState {
  project: Project;
  /** True when the project has unsaved changes since the last save. */
  dirty: boolean;
  /** Absolute path on disk; null for an unsaved project. */
  filePath: string | null;

  correctBlock: (segmentId: string, blockId: string, text: string, expected: Project) => void;
  applyTextEdits: (edits: TextEdit[], expected: Project) => void;
  cutSpeech: (ranges: TextRange[], expected: Project) => void;
  restoreOriginal: (segmentId: string, blockId: string) => void;
  commitTranscript: (next: Project, expected: Project, typingKey?: string) => void;

  // Mutations
  setProject: (p: Project) => void;
  rename: (name: string) => void;
  addMediaWithTranscript: (media: SourceMedia, words: Word[]) => void;
  deleteWords: (ids: Iterable<string>) => void;
  deleteOutputRange: (markIn: number, markOut: number) => number;
  /** Delete every word whose source-media span overlaps [srcStart, srcEnd].
   *  Use this with timestamps returned by ffmpeg silencedetect, which operates
   *  on the original source file. Returns the count of words removed. */
  deleteBySourceRange: (srcStart: number, srcEnd: number) => number;
  /**
   * Delete only words whose **full** source-media span falls within
   * [srcStart, srcEnd] (±30 ms tolerance).  Safer than `deleteBySourceRange`
   * for cutting silences because it does not accidentally delete a word that
   * merely abuts the silence boundary.  Returns the count of words removed.
   *
   * NOTE: Silent gaps themselves (the space between words in the same segment)
   * are not explicitly removed from the export timeline in Phase 1.  That
   * requires segment splitting and is planned for Phase 2.
   */
  deleteSilenceRange: (srcStart: number, srcEnd: number) => number;
  /** Delete every word whose text (case-insensitive, punctuation-stripped)
   *  matches one of the given tokens. Returns the count of words removed. */
  deleteWordsByText: (tokens: ReadonlySet<string>) => number;
  /** Replace the text of every word whose token equals `find` (case-insensitive)
   *  with `replace`. Returns the count of replacements made. */
  replaceText: (
    find: string,
    replace: string,
    opts?: { caseSensitive?: boolean; wholeWord?: boolean },
  ) => number;
  /** Cut every silence longer than `gapMs` between surviving words.
   *  Returns the count of silences removed (0 = nothing to do). */
  removeSilences: (gapMs?: number) => number;
  /** Chapter ops on the OUTPUT timeline. */
  addChapter: (outputTime: number, title?: string) => void;
  removeChapter: (id: string) => void;
  renameChapter: (id: string, title: string) => void;
  /**
   * Bulk-replace all chapters with an AI-generated set.
   *
   * Each entry needs only `title` and `outputTime`; stable UUIDs are assigned
   * here. The existing chapter list is replaced, not merged, so the user gets
   * a clean slate they can edit from.
   */
  setChapters: (chapters: Array<{ title: string; outputTime: number }>) => void;
  /** Audio-track ops (music beds / sfx mixed under the main EDL). */
  addAudioTrack: (track: Omit<AudioTrack, "id">) => void;
  removeAudioTrack: (id: string) => void;
  updateAudioTrack: (id: string, patch: Partial<Omit<AudioTrack, "id" | "mediaId">>) => void;
  /** Add a SourceMedia entry without creating a transcript segment for it.
   *  Used when importing a music file purely as an audio-track input. */
  addMediaOnly: (media: SourceMedia) => void;
  markSaved: (path: string, expected?: Project, session?: number) => void;
  closeProject: () => void;

  // ---------------------------------------------------------------------------
  // Pause tokens — detected silences displayed as inline [0.6s] badges.
  //
  // Stored here (rather than uiStore) so they survive undo/redo of EDL edits
  // and can eventually be saved with the project file.
  //
  // Phase 1 limitation: pauseTokens are NOT yet written to the .scribe bundle.
  // TODO Phase 2: serialize pauseTokens into project.json so they reload.
  // ---------------------------------------------------------------------------

  /** Currently detected pause segments for the loaded project. */
  pauseTokens: PauseSegment[];
  /** Replace the pause list (e.g. after a fresh detect_pauses run). */
  setPauseTokens: (pauses: PauseSegment[]) => void;
  /** Remove a pause token by id without touching the EDL. */
  removePauseToken: (id: string) => void;
  /** Mark a pause as deleted (EDL cut already applied elsewhere). */
  markPauseDeleted: (id: string) => void;
  /** Cut the EDL source range for this pause AND remove it from the list. */
  deletePauseById: (id: string) => void;
  /**
   * Cut the source range for every pause longer than `seconds` and remove
   * those tokens.  Returns the count of pauses deleted.
   */
  deletePausesLongerThan: (seconds: number) => number;
  /**
   * Visually shorten all pauses longer than `longerThan` to `shortenTo`
   * seconds by updating `shortenedTo` on matching tokens.
   *
   * NOTE Phase 1: This updates the displayed badge only.  Actual EDL segment
   * trimming (cutting silence from the export timeline) requires segment
   * splitting and is planned for Phase 2.
   *
   * Returns the count of pauses shortened.
   */
  shortenPausesLongerThan: (opts: { longerThan: number; shortenTo: number }) => number;
}

/**
 * When cutting a silence range, only delete words whose FULL source span is
 * within [srcStart, srcEnd].  A 30 ms tolerance prevents accidentally deleting
 * a word that merely abuts the silence boundary.
 */
const SILENCE_TOLERANCE = 0.03;

function computeSilenceWordIds(project: Project, srcStart: number, srcEnd: number): string[] {
  const ids: string[] = [];
  for (const seg of project.segments) {
    for (const w of seg.words) {
      if (w.start >= srcStart - SILENCE_TOLERANCE && w.end <= srcEnd + SILENCE_TOLERANCE) {
        ids.push(w.id);
      }
    }
  }
  return ids;
}

/** Strip surrounding punctuation/whitespace and lowercase. */
function normaliseToken(s: string): string {
  return s
    .trim()
    .replace(/^[\s.,!?;:"'()[\]{}—–-]+|[\s.,!?;:"'()[\]{}—–-]+$/g, "")
    .toLowerCase();
}

let currentSession = 0;
let savedProject: Project | null = null;
let typingGroup: { key: string; project: Project; time: number } | undefined;
export const projectSession = () => currentSession;
export function endTypingGroup() {
  typingGroup = undefined;
}

export const useProjectStore = create<ProjectState>()(
  temporal(
    (set, _get) => ({
      project: newProject("Untitled"),
      dirty: false,
      filePath: null,
      pauseTokens: [],

      setProject: (p) => {
        validateProjectTranscripts(p);
        set({ project: p, dirty: true });
      },

      commitTranscript: (next, expected, typingKey) => {
        if (_get().project !== expected)
          throw new Error("The transcript changed. Select the passage again.");
        if (next === expected) return;
        validateProjectTranscripts(next);
        const temporal = useProjectStore.temporal.getState();
        const join =
          typingKey &&
          typingGroup?.key === typingKey &&
          typingGroup.project === expected &&
          Date.now() - typingGroup.time < 800 &&
          temporal.futureStates.length === 0;
        if (join) temporal.pause();
        set({ project: next, dirty: true });
        if (join) temporal.resume();
        typingGroup = typingKey ? { key: typingKey, project: next, time: Date.now() } : undefined;
      },
      correctBlock: (segmentId, blockId, text, expected) => {
        const next = editBlockText(expected, segmentId, blockId, text);
        _get().commitTranscript(next, expected, `${segmentId}:${blockId}`);
      },
      applyTextEdits: (edits, expected) =>
        _get().commitTranscript(replaceTranscriptBatch(_get().project, expected, edits), expected),
      cutSpeech: (ranges, expected) =>
        _get().commitTranscript(cutTranscriptRanges(expected, ranges), expected),
      restoreOriginal: (segmentId, blockId) => {
        const p = _get().project;
        _get().commitTranscript(restoreTranscriptBlock(p, segmentId, blockId), p);
      },

      rename: (name) =>
        set((s) => ({
          project: { ...s.project, name, updatedAt: new Date().toISOString() },
          dirty: true,
        })),

      addMediaWithTranscript: (media, words) =>
        set((s) => ({
          project: addMediaWithTranscript(s.project, media, words),
          dirty: true,
        })),

      deleteWords: (ids) =>
        set((s) => ({
          project: deleteWords(s.project, new Set(ids)),
          dirty: true,
        })),

      deleteOutputRange: (markIn, markOut) => {
        const project = _get().project;
        const next = cutOutputSpeech(project, markIn, markOut);
        if (next === project) return 0;
        _get().commitTranscript(next, project);
        return 1;
      },

      deleteBySourceRange: (srcStart, srcEnd) => {
        const project = _get().project;
        const ids: string[] = [];
        for (const seg of project.segments) {
          for (const w of seg.words) {
            // word.start / word.end are already in source-media seconds
            if (w.end > srcStart && w.start < srcEnd) {
              ids.push(w.id);
            }
          }
        }
        if (ids.length === 0) return 0;
        set({
          project: deleteWords(project, new Set(ids)),
          dirty: true,
        });
        return ids.length;
      },

      deleteSilenceRange: (srcStart, srcEnd) => {
        const project = _get().project;
        const ids = computeSilenceWordIds(project, srcStart, srcEnd);
        if (ids.length === 0) return 0;
        set({ project: deleteWords(project, new Set(ids)), dirty: true });
        return ids.length;
      },

      deleteWordsByText: (tokens) => {
        const p = _get().project;
        const ranges: TextRange[] = [];
        for (const block of projectTranscript(p))
          for (const run of block.runs) {
            if (tokens.has(normaliseToken(run.text)) && run.text.trim())
              ranges.push({
                segmentId: block.segmentId,
                blockId: block.id,
                from: run.from,
                to: run.to,
              });
          }
        if (ranges.length) _get().cutSpeech(ranges, p);
        return ranges.length;
      },

      replaceText: (find, replace, opts) => {
        if (!find) return 0;
        const p = _get().project;
        const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(escaped, opts?.caseSensitive ? "gu" : "giu");
        const edits: TextEdit[] = [];
        for (const block of projectTranscript(p)) {
          for (const match of block.text.matchAll(re)) {
            const from = match.index!,
              to = from + match[0].length;
            if (
              opts?.wholeWord !== false &&
              (/\p{L}|\p{N}|_/u.test(block.text[from - 1] ?? "") ||
                /\p{L}|\p{N}|_/u.test(block.text[to] ?? ""))
            )
              continue;
            edits.push({ segmentId: block.segmentId, blockId: block.id, from, to, text: replace });
          }
        }
        _get().applyTextEdits(edits, p);
        return edits.length;
      },

      removeSilences: (gapMs) => {
        const project = _get().project;
        const [next, removed] = removeSilences(project, gapMs ? { gapMs } : undefined);
        if (removed === 0) return 0;
        set({ project: next, dirty: true });
        return removed;
      },

      addChapter: (outputTime, title) =>
        set((s) => ({ project: addChapter(s.project, outputTime, title), dirty: true })),
      removeChapter: (id) => set((s) => ({ project: removeChapter(s.project, id), dirty: true })),
      renameChapter: (id, title) =>
        set((s) => ({ project: renameChapter(s.project, id, title), dirty: true })),
      setChapters: (chapters) =>
        set((s) => ({
          project: {
            ...s.project,
            chapters: chapters.map((c) => ({
              id: crypto.randomUUID(),
              title: c.title,
              outputTime: c.outputTime,
            })),
            updatedAt: new Date().toISOString(),
          },
          dirty: true,
        })),

      addAudioTrack: (track) =>
        set((s) => ({ project: addAudioTrack(s.project, track), dirty: true })),
      removeAudioTrack: (id) =>
        set((s) => ({ project: removeAudioTrack(s.project, id), dirty: true })),
      updateAudioTrack: (id, patch) =>
        set((s) => ({ project: updateAudioTrack(s.project, id, patch), dirty: true })),
      addMediaOnly: (media) =>
        set((s) => ({
          project: {
            ...s.project,
            media: { ...s.project.media, [media.id]: media },
            updatedAt: new Date().toISOString(),
          },
          dirty: true,
        })),

      markSaved: (path, expected = _get().project, session = currentSession) => {
        if (session !== currentSession) return;
        savedProject = expected;
        set({ dirty: _get().project !== expected, filePath: path });
      },

      closeProject: () => replaceProjectBaseline(newProject("Untitled")),

      // -----------------------------------------------------------------------
      // Pause token actions
      // -----------------------------------------------------------------------

      setPauseTokens: (pauses) => set({ pauseTokens: pauses }),

      removePauseToken: (id) =>
        set((s) => ({ pauseTokens: s.pauseTokens.filter((p) => p.id !== id) })),

      markPauseDeleted: (id) =>
        set((s) => ({
          pauseTokens: s.pauseTokens.map((p) => (p.id === id ? { ...p, deleted: true } : p)),
        })),

      deletePauseById: (id) => {
        const { pauseTokens } = _get();
        const pause = pauseTokens.find((p) => p.id === id);
        if (!pause) return;
        const project = _get().project;
        const wordIds = computeSilenceWordIds(project, pause.start, pause.end);
        set({
          project: wordIds.length > 0 ? deleteWords(project, new Set(wordIds)) : project,
          dirty: _get().dirty || wordIds.length > 0,
          pauseTokens: pauseTokens.filter((p) => p.id !== id),
        });
      },

      deletePausesLongerThan: (seconds) => {
        const { pauseTokens } = _get();
        const targets = pauseTokens.filter((p) => !p.deleted && p.duration > seconds);
        if (targets.length === 0) return 0;
        let project = _get().project;
        let anyDeleted = false;
        for (const pause of targets) {
          const wordIds = computeSilenceWordIds(project, pause.start, pause.end);
          if (wordIds.length > 0) {
            project = deleteWords(project, new Set(wordIds));
            anyDeleted = true;
          }
        }
        const targetIds = new Set(targets.map((p) => p.id));
        set({
          project,
          dirty: _get().dirty || anyDeleted,
          pauseTokens: pauseTokens.filter((p) => !targetIds.has(p.id)),
        });
        return targets.length;
      },

      shortenPausesLongerThan: ({ longerThan, shortenTo }) => {
        const { pauseTokens } = _get();
        const targets = pauseTokens.filter((p) => !p.deleted && p.duration > longerThan);
        if (targets.length === 0) return 0;
        const targetIds = new Set(targets.map((p) => p.id));
        set({
          pauseTokens: pauseTokens.map((p) =>
            targetIds.has(p.id) ? { ...p, shortenedTo: shortenTo } : p,
          ),
        });
        // TODO Phase 2: trim the source segment to remove (pause.start + shortenTo, pause.end)
        // from the export timeline.  This requires an EDL segment-splitting operation.
        return targets.length;
      },
    }),
    {
      // Per spec: cap undo at 50 steps.
      limit: 50,
      // Only snapshot the `project` field — don't churn the stack on dirty/path changes.
      partialize: (state) => ({ project: state.project }),
      equality: (a, b) => a.project === b.project,
    },
  ),
);

/**
 * Replace the project as loaded baseline state, not as an undoable edit.
 * Open/import/transcribe completion should not become "undo transcription".
 */
export function replaceProjectBaseline(
  project: Project,
  opts: { filePath?: string | null; dirty?: boolean } = {},
) {
  const temporalStore = useProjectStore.temporal.getState();
  validateProjectTranscripts(project);
  currentSession++;
  typingGroup = undefined;
  savedProject = opts.dirty ? null : project;
  temporalStore.pause();
  useProjectStore.setState({
    project,
    dirty: opts.dirty ?? false,
    filePath: opts.filePath ?? null,
  });
  temporalStore.clear();
  temporalStore.resume();
}

/** Helper for components to access undo/redo. */
export function useTemporalProjectStore<T>(
  selector: (state: TemporalState<{ project: Project }>) => T,
): T {
  // The temporal store is exposed as a method on the main store.
  return useStore(useProjectStore.temporal, selector);
}

// Undo/redo applies partial project snapshots. Recompute dirty without adding history.
useProjectStore.subscribe((state, previous) => {
  if (state.project !== previous.project) {
    useProjectStore.setState({ dirty: state.project !== savedProject });
  }
});
