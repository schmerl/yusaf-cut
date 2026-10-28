import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { projectSession, replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import type { Project, Word } from "./edl";
import { createSnapshot, recordTranscriptionApplication, transcribe, type TranscribeOptions } from "./ipc";
import { saveProjectRevision } from "./projectSaves";
import { normalizeTranscript, validateProjectTranscripts } from "./transcript";
import { readTranscriptCache, writeTranscriptCache } from "./transcriptCache";

export interface TranscriptionRequest {
  project: Project;
  session: number;
  mediaIds: string[];
  force: boolean;
}
export function captureTranscription(force: boolean, mediaIds?: string[]): TranscriptionRequest {
  const project = useProjectStore.getState().project;
  const surviving = new Set(project.segments.map((s) => s.mediaId));
  const ids = [...new Set(mediaIds ?? surviving)];
  if (!ids.length || ids.some((id) => !surviving.has(id) || !project.media[id]))
    throw new Error("Select existing media to transcribe.");
  return { project, session: projectSession(), mediaIds: ids, force };
}
export function assertTranscriptionCurrent(request: TranscriptionRequest) {
  if (
    projectSession() !== request.session ||
    useProjectStore.getState().project !== request.project
  )
    throw new Error(
      "The project changed. Your current edits were preserved. Start transcription again.",
    );
}

/** Conservative detection includes grouping/paragraph edits as well as visible text. */
export function correctedOccurrences(request: TranscriptionRequest): number {
  return request.project.segments.filter((segment) => {
    if (!request.mediaIds.includes(segment.mediaId) || !segment.transcript) return false;
    const baseline = normalizeTranscript({ ...segment, transcript: undefined });
    const shape = (metadata: typeof baseline) =>
      metadata.blocks.map((b) =>
        b.runs.map((r, index) => ({
          text: r.text,
          // A cut can promote a run to paragraph start; its separator is invisible.
          separatorBefore: index ? r.separatorBefore : "",
          anchorIds: r.anchorIds,
        })),
      );
    return JSON.stringify(shape(segment.transcript)) !== JSON.stringify(shape(baseline));
  }).length;
}

/** Return false on Save cancellation. Failures never authorize recognition. */
export async function snapshotBeforeTranscription(request: TranscriptionRequest): Promise<boolean> {
  assertTranscriptionCurrent(request);
  let path = useProjectStore.getState().filePath;
  if (!path) {
    const selected = await saveDialog({
      title: "Save project before snapshot",
      defaultPath: `${request.project.name}.scribe`,
      filters: [{ name: "YusafCut project", extensions: ["scribe"] }],
    });
    assertTranscriptionCurrent(request);
    if (!selected) return false;
    path = selected;
  }
  await saveProjectRevision(request.project, path, request.session);
  assertTranscriptionCurrent(request);
  await createSnapshot(request.project, path, "Before re-transcription");
  assertTranscriptionCurrent(request);
  return true;
}

type RecognitionSettings = Omit<TranscribeOptions, "mediaId" | "mediaPath" | "mediaDuration">;

/** Stage every clip, then replace one baseline. No project/cache mutation on failure.
 * Session history resets on success; persisted snapshots are the recovery path.
 */
export async function runTranscription(
  request: TranscriptionRequest,
  settings: RecognitionSettings,
) {
  assertTranscriptionCurrent(request);
  const expected = request.project;
  let next = expected;
  const cacheWrites: { mediaId: string; words: Word[] }[] = [];
  const diagnosticRuns: { runId: string; mediaId: string }[] = [];
  let transcribedClips = 0;
  for (const mediaId of request.mediaIds) {
    assertTranscriptionCurrent(request);
    const targets = expected.segments.filter(
      (s) => s.mediaId === mediaId && (request.force || !s.words.length),
    );
    if (!targets.length) continue;
    const media = expected.media[mediaId]!;
    // The legacy raw cache contains whisper.cpp output without engine metadata.
    // Never reuse or overwrite it for the opt-in CrisperWhisper provider.
    const cached = request.force || settings.engine === "crisper-whisper"
      ? null
      : readTranscriptCache(media);
    const result = cached
      ? { mediaId, words: cached }
      : await transcribe({
          ...settings,
          mediaId,
          mediaPath: media.path,
          mediaDuration: media.duration,
        });
    if ("diagnosticRunId" in result && result.diagnosticRunId) {
      diagnosticRuns.push({ runId: result.diagnosticRunId, mediaId });
      await recordTranscriptionApplication(result.diagnosticRunId, "received", result.words.length).catch(() => {});
    }
    assertTranscriptionCurrent(request);
    if (result.mediaId !== mediaId)
      throw new Error("Recognition returned a different clip. No transcript was replaced.");
    if (!result.words.length && settings.engine === "crisper-whisper")
      throw new Error("CrisperWhisper returned no words. See transcription diagnostics in the app data directory.");
    next = {
      ...next,
      segments: next.segments.map((segment) => {
        if (!targets.some((s) => s.id === segment.id)) return segment;
        const updated = {
          ...segment,
          transcript: undefined,
          words: result.words.filter(
            (word) => word.end > segment.sourceIn && word.start < segment.sourceOut,
          ),
        };
        return { ...updated, transcript: normalizeTranscript(updated) };
      }),
      updatedAt: new Date().toISOString(),
    };
    validateProjectTranscripts(next);
    if (!cached && settings.engine !== "crisper-whisper")
      cacheWrites.push({ mediaId, words: result.words });
    transcribedClips++;
  }
  assertTranscriptionCurrent(request);
  if (next !== expected) {
    replaceProjectBaseline(next, { dirty: true, filePath: useProjectStore.getState().filePath });
    useProjectStore.getState().setPauseTokens([]);
    usePlayerStore.getState().reset();
    for (const { mediaId, words } of cacheWrites)
      writeTranscriptCache(expected.media[mediaId]!, words);
    for (const { runId, mediaId } of diagnosticRuns) {
      const appliedWords = next.segments.filter((s) => s.mediaId === mediaId).reduce((n, s) => n + s.words.length, 0);
      await recordTranscriptionApplication(runId, "applied", appliedWords).catch(() => {});
    }
  }
  const totalWords = next.segments
    .filter((s) => request.mediaIds.includes(s.mediaId))
    .reduce((n, s) => n + s.words.length, 0);
  return { project: next, totalWords, transcribedClips, mediaCount: request.mediaIds.length };
}
