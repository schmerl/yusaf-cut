import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteModel,
  detectPauses,
  downloadModel,
  exportVideo,
  importMedia,
  listModels,
  onModelDownloadProgress,
  startNativeRecording,
  stopNativeRecording,
  type ModelInfo,
  type RecordingMode,
  type TranscriptionEngine,
  type WhisperModel,
} from "@/lib/ipc";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  Captions,
  CheckCircle2,
  ChevronDown,
  Download,
  FilePlus2,
  FolderOpen,
  History,
  MonitorUp,
  MicVocal,
  Music,
  Power,
  Radio,
  Save,
  Scissors,
  Settings2,
  Square,
  Video,
} from "lucide-react";
import { formatDuration } from "@/lib/timecode";
import {
  addMediaWithTranscript as buildProjectWithMedia,
  newProject,
  totalDuration,
} from "@/lib/edl";
import { buildSrt, buildVtt } from "@/lib/captions";
import { usePlayerStore } from "@/stores/playerStore";
import { Toolbox } from "@/components/Toolbox/Toolbox";
import { MusicTracksDialog } from "@/components/Toolbox/MusicTracksDialog";
import { SnapshotsDialog } from "@/components/Toolbox/SnapshotsDialog";
import { readTranscriptCache } from "@/lib/transcriptCache";
import { saveProjectRevision } from "@/lib/projectSaves";
import { projectSession } from "@/stores/projectStore";
import {
  assertTranscriptionCurrent,
  captureTranscription,
  correctedOccurrences,
  runTranscription,
  snapshotBeforeTranscription,
  type TranscriptionRequest,
} from "@/lib/transcriptionWorkflow";
import { isProjectPath, openSavedProject } from "@/lib/openProject";

const MODELS: { name: WhisperModel; label: string; sizeMb: number }[] = [
  { name: "tiny", label: "Tiny (fast, lower accuracy)", sizeMb: 75 },
  { name: "base", label: "Base", sizeMb: 142 },
  { name: "small", label: "Small", sizeMb: 466 },
  { name: "medium", label: "Medium", sizeMb: 1500 },
  { name: "large-v3-turbo", label: "Large v3 Turbo (recommended)", sizeMb: 1600 },
  { name: "large-v3", label: "Large v3 (max accuracy, 3.1 GB)", sizeMb: 3100 },
];

/** ISO 639-1 languages Whisper supports well. */
const WHISPER_LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
  { code: "ko", label: "Korean" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "tr", label: "Turkish" },
  { code: "sv", label: "Swedish" },
  { code: "uk", label: "Ukrainian" },
];

const MEDIA_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "m4a", "wav"];

function mediaNameFromPath(path: string, fallback = "Untitled") {
  return (
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") || fallback
  );
}

interface ToolbarProps {
  onFindClick?: () => void;
}

function recordingLabel(mode: RecordingMode) {
  if (mode === "voiceover") return "Voice over";
  if (mode === "screen") return "Screen recording";
  return "Camera recording";
}

export function Toolbar({ onFindClick }: ToolbarProps) {
  const project = useProjectStore((s) => s.project);
  const dirty = useProjectStore((s) => s.dirty);
  const filePath = useProjectStore((s) => s.filePath);

  const transcribeProgress = useUIStore((s) => s.transcribeProgress);
  const exportingProgress = useUIStore((s) => s.exportingProgress);
  const modelDownloadProgress = useUIStore((s) => s.modelDownloadProgress);
  const modelDownloadLabel = useUIStore((s) => s.modelDownloadLabel);
  const mediaLoading = useUIStore((s) => s.mediaLoading);
  const pushToast = useUIStore((s) => s.pushToast);
  const setMediaLoading = useUIStore((s) => s.setMediaLoading);
  const setExportingProgress = useUIStore((s) => s.setExportingProgress);
  const setTranscribeProgress = useUIStore((s) => s.setTranscribeProgress);
  const displayName = filePath?.split(/[\\/]/).pop() ?? `${project.name}.scribe`;

  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<WhisperModel>("large-v3-turbo");
  const [selectedEngine, setSelectedEngine] = useState<TranscriptionEngine>("whisper-cpp");
  const [crisperModel, setCrisperModel] = useState<"small" | "medium" | "large" | "turbo">("medium");
  const [crisperPython, setCrisperPython] = useState(() => localStorage.getItem("crisperPython") ?? "");
  const [transcribeLanguage, setTranscribeLanguage] = useState("auto");
  const [transcribeTranslate, setTranscribeTranslate] = useState(false);
  const [transcribeDiarize, setTranscribeDiarize] = useState(false);
  const [installedModels, setInstalledModels] = useState<ModelInfo[]>([]);
  const [exportSettings, setExportSettings] = useState({
    resolution: "original",
    customWidth: 1920,
    customHeight: 1080,
    videoBitrateKbps: 8000,
    audioBitrateKbps: 192,
    fps: "",
    codec: "auto" as "auto" | "h264" | "hevc",
    /** When true, bypass smart-cut and re-encode every frame. */
    forceReencode: false,
  });
  // Which model is currently being downloaded inside the dialog, and its progress.
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadLabel, setDownloadLabel] = useState("Downloading…");
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [musicDialogOpen, setMusicDialogOpen] = useState(false);
  const [snapshotsDialogOpen, setSnapshotsDialogOpen] = useState(false);
  const [recordingMode, setRecordingMode] = useState<RecordingMode>("voiceover");
  const [recording, setRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("Ready to record locally");
  const unlistenDownloadRef = useRef<(() => void) | null>(null);
  /** Set to true before opening the model dialog when the user clicks Re-Transcribe. */
  const forceRetranscribeRef = useRef(false);
  const [replacementRequest, setReplacementRequest] = useState<TranscriptionRequest | null>(null);
  const [replacementError, setReplacementError] = useState("");
  const [transcriptionBusy, setTranscriptionBusy] = useState(false);
  const transcriptionBusyRef = useRef(false);

  // toolbarBottomRef kept for potential future use
  const toolbarBottomRef = useRef<HTMLDivElement>(null);

  /** True when at least one segment already has transcribed words. */
  const hasTranscript = project.segments.some((s) => s.words.length > 0);
  const correctionCount = replacementRequest ? correctedOccurrences(replacementRequest) : 0;

  async function handleOpen() {
    const path = await openDialog({
      title: "Open media or a saved project",
      multiple: false,
      filters: [
        { name: "Media or project", extensions: [...MEDIA_EXTENSIONS, "scribe", "json"] },
        { name: "Media", extensions: MEDIA_EXTENSIONS },
        { name: "YusafCut project", extensions: ["scribe", "json"] },
      ],
    });
    if (typeof path !== "string") return;
    if (isProjectPath(path)) {
      await openSavedProject(path);
      return;
    }
    setMediaLoading(true);
    try {
      const media = await importMedia(path);
      const name = mediaNameFromPath(media.path);
      const cachedWords = readTranscriptCache(media);
      const nextProject = buildProjectWithMedia(newProject(name), media, cachedWords ?? []);
      resetPlayer();
      replaceProjectBaseline(nextProject, { dirty: true, filePath: null });
      pushToast({
        title: cachedWords ? "Media imported with cached transcript" : "Media imported",
        description: media.path,
      });
    } catch (err) {
      pushToast({
        title: "Failed to import media",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setMediaLoading(false);
    }
  }

  async function handleAddClip() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }],
    });
    if (typeof path !== "string") return;
    await addClipToTimeline(path);
  }

  async function addClipToTimeline(path: string) {
    setMediaLoading(true);
    try {
      const before = useProjectStore.getState().project;
      const appendAt = totalDuration(before);
      const media = await importMedia(path);
      const cachedWords = readTranscriptCache(media) ?? [];
      useProjectStore.getState().addMediaWithTranscript(media, cachedWords);
      usePlayerStore.getState().clearTimelineRange();
      usePlayerStore.getState().setSelectedWordIds(new Set());
      window.dispatchEvent(new CustomEvent("yusafcut:seek-output", { detail: { time: appendAt } }));
      pushToast({
        title: cachedWords.length > 0 ? "Clip added with cached transcript" : "Clip added",
        description:
          cachedWords.length > 0 ? media.path : "Click Transcribe to generate text for this clip.",
      });
    } catch (err) {
      pushToast({
        title: "Failed to add clip",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setMediaLoading(false);
    }
  }

  function resetPlayer() {
    usePlayerStore.getState().reset();
  }

  function handleCloseProject() {
    replaceProjectBaseline(newProject("Untitled"), { dirty: false, filePath: null });
    resetPlayer();
    pushToast({ title: "Project closed" });
  }

  function handleNewProject() {
    replaceProjectBaseline(newProject("Untitled"), { dirty: false, filePath: null });
    resetPlayer();
  }

  async function handleOpenProject() {
    const path = await openDialog({
      title: "Choose the saved .scribe project folder",
      multiple: false,
      directory: true,
    });
    if (typeof path !== "string") return;
    await openSavedProject(path);
  }

  async function ensureSelectedModelInstalled() {
    if (selectedEngine === "crisper-whisper") {
      if (!crisperPython.trim()) throw new Error("Choose your CrisperWhisper Python executable.");
      return;
    }
    const info = await listModels();
    setInstalledModels(info);
    const installed = info.find((m) => m.name === selectedModel)?.installed ?? false;
    if (installed) return;

    const modelLabel = MODELS.find((m) => m.name === selectedModel)?.label ?? selectedModel;
    pushToast({
      title: `Downloading ${modelLabel}…`,
      description: "Needed once before local transcription can run.",
    });
    await downloadModel("whisper-cpp", selectedModel);
    setInstalledModels((prev) =>
      prev.map((m) => (m.name === selectedModel ? { ...m, installed: true } : m)),
    );
  }

  async function importAndTranscribeRecording(path: string, label: string) {
    setMediaLoading(true);
    try {
      const media = await importMedia(path);
      const name = mediaNameFromPath(media.path, label);
      const projectWithMedia = buildProjectWithMedia(newProject(name), media, []);
      resetPlayer();
      replaceProjectBaseline(projectWithMedia, { dirty: true, filePath: null });
      pushToast({ title: `${label} saved`, description: media.path });

      const request = captureTranscription(false, [media.id]);
      setTranscribeProgress(0);
      await ensureSelectedModelInstalled();
      const result = await runTranscription(request, {
        engine: selectedEngine,
        modelName: selectedEngine === "crisper-whisper" ? crisperModel : selectedModel,
        pythonPath: selectedEngine === "crisper-whisper" ? crisperPython.trim() : undefined,
        language: transcribeLanguage === "auto" ? undefined : transcribeLanguage,
        translate: selectedEngine === "whisper-cpp" && transcribeTranslate,
        diarize: selectedEngine === "whisper-cpp" && transcribeDiarize,
      });
      pushToast({ title: "Recording transcribed", description: `${result.totalWords} words` });
      if (result.totalWords > 0) await autoDetectPauses(media.path, result.project);
    } catch (err) {
      pushToast({
        title: "Recording import/transcription failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setTranscribeProgress(null);
      setMediaLoading(false);
    }
  }

  async function startRecording(mode: RecordingMode) {
    setRecordingMode(mode);
    setRecordingStatus("Starting native macOS recorder…");

    try {
      await startNativeRecording(mode);
      setRecording(true);
      setRecordingStatus(`${recordingLabel(mode)} in progress`);
    } catch (err) {
      setRecording(false);
      setRecordingStatus("Ready to record locally");
      pushToast({
        title: "Recording failed to start",
        description: String(err),
        variant: "destructive",
      });
    }
  }

  async function stopRecording() {
    setRecordingStatus("Stopping recording…");
    try {
      const label = recordingLabel(recordingMode);
      const path = await stopNativeRecording();
      setRecording(false);
      setRecordingStatus("Transcribing recording…");
      await importAndTranscribeRecording(path, label);
      setRecordDialogOpen(false);
    } catch (err) {
      pushToast({
        title: "Recording failed to stop",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setRecording(false);
      setRecordingStatus("Ready to record locally");
    }
  }

  async function refreshModelList() {
    try {
      const info = await listModels();
      setInstalledModels(info);
    } catch {
      setInstalledModels([]);
    }
  }

  async function handleTranscribe() {
    const mediaIds = Array.from(new Set(project.segments.map((segment) => segment.mediaId)));
    if (mediaIds.length === 0) {
      pushToast({ title: "Open a video first", variant: "destructive" });
      return;
    }
    forceRetranscribeRef.current = false;
    await refreshModelList();
    setModelDialogOpen(true);
  }

  async function handleReTranscribe() {
    const mediaIds = Array.from(new Set(project.segments.map((segment) => segment.mediaId)));
    if (mediaIds.length === 0) return;
    forceRetranscribeRef.current = true;
    await refreshModelList();
    setModelDialogOpen(true);
  }

  /** Download a single model from within the dialog, updating inline progress. */
  async function handleDownloadModel(name: string) {
    if (downloadingModel) return; // already downloading something

    setDownloadingModel(name);
    setDownloadProgress(0);

    // Subscribe to download progress events so the inline bar updates live.
    const unlisten = await onModelDownloadProgress((p) => {
      if (p.name === name) {
        setDownloadProgress(p.progress);
        if (p.label) setDownloadLabel(p.label);
      }
    });
    unlistenDownloadRef.current = unlisten;

    try {
      await downloadModel("whisper-cpp", name);
      // Mark as installed in local state immediately.
      setInstalledModels((prev) =>
        prev.map((m) => (m.name === name ? { ...m, installed: true } : m)),
      );
      // Auto-select the freshly downloaded model.
      setSelectedModel(name as WhisperModel);
    } catch (err) {
      pushToast({
        title: "Download failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      unlisten();
      unlistenDownloadRef.current = null;
      setDownloadingModel(null);
      setDownloadProgress(0);
      setDownloadLabel("Downloading…");
    }
  }

  /** Delete a downloaded model after confirmation. */
  async function handleDeleteModel(name: string) {
    // Prevent deletion while a transcription using this model is running.
    if (transcribeProgress !== null && selectedModel === name) {
      pushToast({
        title: "Cannot remove model",
        description: "A transcription is currently running with this model. Wait for it to finish.",
        variant: "destructive",
      });
      return;
    }

    const confirmed = window.confirm("Remove this downloaded model from your computer?");
    if (!confirmed) return;

    setDeletingModel(name);
    try {
      await deleteModel("whisper-cpp", name);
      setInstalledModels((prev) =>
        prev.map((m) => (m.name === name ? { ...m, installed: false } : m)),
      );
      // If the deleted model was selected, fall back to large-v3-turbo if installed.
      if (selectedModel === name) {
        const fallback = installedModels.find((m) => m.name !== name && m.installed);
        if (fallback) setSelectedModel(fallback.name as WhisperModel);
      }
      pushToast({ title: "Model removed", description: `${name} deleted from disk.` });
    } catch (err) {
      pushToast({
        title: "Remove failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setDeletingModel(null);
    }
  }

  // Clean up progress listener if the dialog is closed mid-download.
  useEffect(() => {
    if (!modelDialogOpen && unlistenDownloadRef.current) {
      unlistenDownloadRef.current();
      unlistenDownloadRef.current = null;
      setDownloadingModel(null);
      setDownloadProgress(0);
    }
  }, [modelDialogOpen]);

  /**
   * Best-effort pause detection for a freshly-transcribed clip. Stores the
   * result in projectStore.pauseTokens (which always REPLACES, so re-running
   * never duplicates badges) and surfaces a non-blocking toast. Failures here
   * never fail transcription — they are reported but swallowed.
   */
  const autoDetectPauses = useCallback(
    async (mediaPath: string, expected = useProjectStore.getState().project) => {
      if (expected !== useProjectStore.getState().project) return;
      const session = projectSession();
      try {
        const pauses = await detectPauses({ mediaPath, noiseThreshold: -35, minDuration: 0.5 });
        if (expected !== useProjectStore.getState().project || session !== projectSession()) return;
        useProjectStore.getState().setPauseTokens(pauses);
        pushToast(
          pauses.length > 0
            ? { title: `Detected ${pauses.length} pause${pauses.length === 1 ? "" : "s"}` }
            : { title: "No pauses found" },
        );
      } catch (err) {
        // Non-fatal: transcription already succeeded.
        pushToast({ title: "Pause detection failed", description: String(err) });
      }
    },
    [pushToast],
  );

  function startTranscribe() {
    if (transcriptionBusyRef.current) return;
    setModelDialogOpen(false);
    try {
      const request = captureTranscription(forceRetranscribeRef.current);
      forceRetranscribeRef.current = false;
      if (request.force && request.project.segments.some((s) => s.words.length)) {
        setReplacementError("");
        setReplacementRequest(request);
      } else {
        void beginTranscription(request, false);
      }
    } catch (error) {
      pushToast({ title: "Cannot transcribe", description: String(error), variant: "destructive" });
    }
  }

  async function beginTranscription(request: TranscriptionRequest, snapshotFirst: boolean) {
    if (transcriptionBusyRef.current) return;
    transcriptionBusyRef.current = true;
    setTranscriptionBusy(true);
    setReplacementError("");
    const settings = {
      engine: selectedEngine,
      modelName: selectedEngine === "crisper-whisper" ? crisperModel : selectedModel,
      pythonPath: selectedEngine === "crisper-whisper" ? crisperPython.trim() : undefined,
      language: transcribeLanguage === "auto" ? undefined : transcribeLanguage,
      translate: selectedEngine === "whisper-cpp" && transcribeTranslate,
      diarize: selectedEngine === "whisper-cpp" && transcribeDiarize,
    };
    try {
      assertTranscriptionCurrent(request);
      if (snapshotFirst && !(await snapshotBeforeTranscription(request))) {
        setReplacementError(
          "Save cancelled. Your corrections are unchanged; transcription has not started.",
        );
        return;
      }
      assertTranscriptionCurrent(request);
      setReplacementRequest(null);
      setTranscribeProgress(0);
      if (settings.engine === "whisper-cpp" && !installedModels.find((m) => m.name === settings.modelName)?.installed) {
        await downloadModel("whisper-cpp", settings.modelName);
        assertTranscriptionCurrent(request);
      }
      const result = await runTranscription(request, settings);
      pushToast({
        title: request.force ? "Re-transcription complete" : "Transcription complete",
        description: result.transcribedClips
          ? `${result.totalWords} words across ${result.mediaCount} ${result.mediaCount === 1 ? "clip" : "clips"}`
          : "All clips already had transcript text",
      });
      const primaryPath = Object.values(result.project.media)[0]?.path;
      if (primaryPath && result.totalWords > 0 && result.transcribedClips > 0)
        await autoDetectPauses(primaryPath, result.project);
    } catch (error) {
      setReplacementError(String(error));
      pushToast({
        title: request.force ? "Re-transcription failed" : "Transcription failed",
        description: String(error),
        variant: "destructive",
      });
    } finally {
      setTranscribeProgress(null);
      transcriptionBusyRef.current = false;
      setTranscriptionBusy(false);
    }
  }

  const handleSave = useCallback(async () => {
    const session = projectSession();
    let path = filePath;
    if (!path) {
      const next = await saveDialog({
        defaultPath: `${project.name}.scribe`,
        filters: [{ name: "YusafCut project", extensions: ["scribe"] }],
      });
      if (!next) return;
      path = next;
    }
    try {
      await saveProjectRevision(project, path, session);
      pushToast({ title: "Saved" });
    } catch (err) {
      pushToast({
        title: "Save failed",
        description: String(err),
        variant: "destructive",
      });
    }
  }, [filePath, project, pushToast]);

  const runExport = useCallback(async () => {
    const outPath = await saveDialog({
      defaultPath: `${project.name}.mp4`,
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!outPath) return;
    const resolution = exportSettings.resolution;
    const dims =
      resolution === "original"
        ? {}
        : resolution === "720p"
          ? { width: 1280, height: 720 }
          : resolution === "1080p"
            ? { width: 1920, height: 1080 }
            : resolution === "4k"
              ? { width: 3840, height: 2160 }
              : {
                  width: Math.max(16, exportSettings.customWidth),
                  height: Math.max(16, exportSettings.customHeight),
                };

    // Show the export progress dialog immediately so the user sees feedback
    // before the first ffmpeg progress event arrives.
    setExportingProgress(0);

    try {
      await exportVideo({
        project,
        outputPath: outPath,
        preset: project.settings.exportPreset,
        ...dims,
        // "auto" means: don't specify a codec — let the smart-cut path stream-copy
        // the source rather than transcoding. Explicit h264/hevc disables smart-cut.
        codec: exportSettings.codec === "auto" ? undefined : exportSettings.codec,
        fps: exportSettings.fps ? Number(exportSettings.fps) : undefined,
        videoBitrateKbps: exportSettings.videoBitrateKbps,
        audioBitrateKbps: exportSettings.audioBitrateKbps,
        forceReencode: exportSettings.forceReencode,
      });
      pushToast({ title: "Export complete", description: outPath });
    } catch (err) {
      pushToast({
        title: "Export failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      // Always hide the progress dialog — covers both success and ffmpeg errors.
      // On success, the Rust backend already emitted progress=1.0 which would
      // also set this to null via useTranscribeProgress, but being explicit here
      // ensures the dialog closes even if the event is lost.
      setExportingProgress(null);
    }
  }, [exportSettings, project, pushToast, setExportingProgress]);

  const handleExport = useCallback(() => {
    if (Object.keys(project.media).length === 0 || project.segments.length === 0) {
      pushToast({ title: "Nothing to export", variant: "destructive" });
      return;
    }
    setExportDialogOpen(true);
  }, [project, pushToast]);

  // ── Caption export (SRT / VTT) ──────────────────────────────────────────
  // Captions reflect the *output* timeline, so deletes and clip reordering
  // carry over to the .srt/.vtt without the user having to think about it.
  const handleExportCaptions = useCallback(async () => {
    const hasWords = project.segments.some((s) => s.words.length > 0);
    if (!hasWords) {
      pushToast({
        title: "No captions to export",
        description: "Transcribe the clip first to generate word timings.",
        variant: "destructive",
      });
      return;
    }
    const outPath = await saveDialog({
      defaultPath: `${project.name}.srt`,
      filters: [
        { name: "SubRip subtitles", extensions: ["srt"] },
        { name: "WebVTT captions", extensions: ["vtt"] },
      ],
    });
    if (!outPath) return;
    const isVtt = outPath.toLowerCase().endsWith(".vtt");
    try {
      const content = isVtt ? buildVtt(project) : buildSrt(project);
      await writeTextFile(outPath, content);
      pushToast({
        title: isVtt ? "WebVTT exported" : "SRT exported",
        description: outPath,
      });
    } catch (err) {
      pushToast({
        title: "Caption export failed",
        description: String(err),
        variant: "destructive",
      });
    }
  }, [project, pushToast]);

  useEffect(() => {
    window.addEventListener("yusafcut:save", handleSave);
    window.addEventListener("yusafcut:export", handleExport);
    return () => {
      window.removeEventListener("yusafcut:save", handleSave);
      window.removeEventListener("yusafcut:export", handleExport);
    };
  }, [handleSave, handleExport]);

  return (
    <div className="editor-toolbar">
      <div className="editor-toolbar-top">
        <div className="toolbar-title">
          <span>{displayName}</span>
          <span>{dirty ? "unsaved edits" : "no edits"}</span>
        </div>

        <div className="toolbar-export">
          <span className="toolbar-duration">{formatDuration(totalDuration(project))}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleExportCaptions}
            className="h-8 gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
            title="Export captions (.srt or .vtt)"
          >
            <Captions className="h-4 w-4" /> Captions
          </Button>
          <Button
            size="sm"
            onClick={handleExport}
            className="h-8 gap-2 rounded-md px-3 font-semibold"
          >
            <Download className="h-4 w-4" /> Export .mp4
          </Button>
        </div>
      </div>

      <div className="editor-toolbar-bottom" ref={toolbarBottomRef}>
        {/* ── Left: file operations ── */}
        <div className="tool-group">
          <Button size="sm" variant="ghost" className="tool-button" onClick={handleOpen}>
            <FolderOpen className="h-4 w-4" /> Open
          </Button>
          <Button size="sm" variant="ghost" className="tool-button" onClick={handleSave}>
            <Save className="h-4 w-4" /> Save{dirty ? " *" : ""}
          </Button>
          {/* File ▾ — project management, snapshots, and lifecycle */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="tool-button">
                File <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[180px]">
              <DropdownMenuItem onClick={handleAddClip}>
                <Scissors className="h-4 w-4 mr-2" /> Add Clip
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleNewProject}>
                <FilePlus2 className="h-4 w-4 mr-2" /> New Project
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void handleOpenProject()}>
                <FolderOpen className="h-4 w-4 mr-2" /> Open Project
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSnapshotsDialogOpen(true)}>
                <History className="h-4 w-4 mr-2" /> Snapshots
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={handleCloseProject}
              >
                <Power className="h-4 w-4 mr-2" /> Close project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Toolbox onFindClick={onFindClick} />

        {/* ── Right: transcribe + capture + project lifecycle ── */}
        <div className="tool-group">
          <Button
            size="sm"
            variant="ghost"
            className="tool-button tool-button-primary"
            title={
              hasTranscript
                ? "Review snapshot options before replacing transcript text"
                : "Transcribe audio with Whisper"
            }
            onClick={hasTranscript ? handleReTranscribe : handleTranscribe}
            disabled={transcriptionBusy}
          >
            <MicVocal className="h-4 w-4" />
            {hasTranscript ? "Re-Transcribe" : "Transcribe"}
          </Button>
          {/* Capture ▾ — recording and audio inputs */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="tool-button">
                Capture <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              <DropdownMenuItem onClick={() => setRecordDialogOpen(true)}>
                <Radio className="h-4 w-4 mr-2" /> Record
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setMusicDialogOpen(true)}>
                <Music className="h-4 w-4 mr-2" /> Music tracks
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Dialog
        open={recordDialogOpen}
        onOpenChange={(open) => {
          if (!recording) setRecordDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-primary" />
              Record locally
            </DialogTitle>
            <DialogDescription>
              Capture voice, screen, or camera media on this Mac. YusafCut saves the clip locally,
              imports it, and transcribes it with Whisper.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant={recordingMode === "voiceover" ? "default" : "outline"}
                className="h-auto flex-col gap-2 py-4"
                disabled={recording}
                onClick={() => setRecordingMode("voiceover")}
              >
                <MicVocal className="h-5 w-5" />
                Voice over
              </Button>
              <Button
                variant={recordingMode === "screen" ? "default" : "outline"}
                className="h-auto flex-col gap-2 py-4"
                disabled={recording}
                onClick={() => setRecordingMode("screen")}
              >
                <MonitorUp className="h-5 w-5" />
                Screen
              </Button>
              <Button
                variant={recordingMode === "camera" ? "default" : "outline"}
                className="h-auto flex-col gap-2 py-4"
                disabled={recording}
                onClick={() => setRecordingMode("camera")}
              >
                <Video className="h-5 w-5" />
                Camera
              </Button>
            </div>

            <div className="rounded-md border border-border bg-secondary/45 px-3 py-2 text-sm text-muted-foreground">
              {recordingStatus}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRecordDialogOpen(false)}
              disabled={recording}
            >
              Cancel
            </Button>
            {recording ? (
              <Button variant="destructive" className="gap-2" onClick={() => void stopRecording()}>
                <Square className="h-4 w-4" />
                Stop recording
              </Button>
            ) : (
              <Button className="gap-2" onClick={() => void startRecording(recordingMode)}>
                <Radio className="h-4 w-4" />
                Start {recordingLabel(recordingMode)}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={replacementRequest !== null}
        onOpenChange={(open) => {
          if (!open && !transcriptionBusy) setReplacementRequest(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Replace existing transcript?</DialogTitle>
            <DialogDescription>
              New recognition will replace transcript text and originals for all current clips,
              including {correctionCount} corrected{" "}
              {correctionCount === 1 ? "occurrence" : "occurrences"}. Existing audio cuts stay in
              place. Successful transcription resets session undo history. A snapshot preserves the
              corrections for later recovery. Snapshot first saves your current project before
              creating the restore point.
            </DialogDescription>
          </DialogHeader>
          {replacementError && (
            <p role="alert" className="text-sm text-destructive">
              {replacementError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={transcriptionBusy}
              onClick={() => setReplacementRequest(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={transcriptionBusy}
              onClick={() =>
                replacementRequest && void beginTranscription(replacementRequest, false)
              }
            >
              Proceed
            </Button>
            <Button
              disabled={transcriptionBusy}
              onClick={() =>
                replacementRequest && void beginTranscription(replacementRequest, true)
              }
            >
              {transcriptionBusy ? "Preparing snapshot…" : "Snapshot first"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {forceRetranscribeRef.current ? "Re-Transcribe" : "Transcription settings"}
            </DialogTitle>
            <DialogDescription>
              {forceRetranscribeRef.current
                ? "Choose recognition settings, then review the options for protecting existing text."
                : "Choose an engine, model, and language. Larger models are more accurate but slower."}
            </DialogDescription>
          </DialogHeader>

          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Transcription engine
            <select
              className="h-8 rounded border border-input bg-background px-2 text-sm text-foreground"
              value={selectedEngine}
              onChange={(event) => setSelectedEngine(event.target.value as TranscriptionEngine)}
            >
              <option value="whisper-cpp">Whisper.cpp · Core ML</option>
              <option value="crisper-whisper">CrisperWhisper 2 · verbatim</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground rounded-md border border-border px-3 py-2">
            {selectedEngine === "crisper-whisper"
              ? "Preserves audible fillers and repeats. Runs locally through your installed Python environment; its model is downloaded by Hugging Face on first use. Model weights have a non-commercial research license."
              : "Runs locally with Apple Silicon acceleration and word-level timestamps."}
          </p>

          {/* ── Model list ── */}
          {selectedEngine === "whisper-cpp" ? <div className="flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
            {MODELS.map((m) => {
              const installed = installedModels.find((i) => i.name === m.name)?.installed ?? false;
              const isDownloading = downloadingModel === m.name;
              const isOtherDownloading = downloadingModel !== null && !isDownloading;
              const isDeleting = deletingModel === m.name;
              const isSelected = selectedModel === m.name;

              return (
                <div
                  key={m.name}
                  className={`rounded-md border p-3 transition-colors ${
                    isSelected ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                      <input
                        type="radio"
                        name="model"
                        value={m.name}
                        checked={isSelected}
                        disabled={!installed}
                        onChange={() => setSelectedModel(m.name as WhisperModel)}
                      />
                      {m.label}
                    </label>
                    {installed ? (
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Installed
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          disabled={
                            isDeleting || downloadingModel !== null || transcribeProgress !== null
                          }
                          title="Remove this model from disk"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteModel(m.name);
                          }}
                        >
                          {isDeleting ? "Removing…" : "Remove"}
                        </Button>
                      </div>
                    ) : isDownloading ? (
                      <span className="text-xs text-muted-foreground">
                        {Math.round(downloadProgress * 100)}%
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 text-xs"
                        disabled={isOtherDownloading}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDownloadModel(m.name);
                        }}
                      >
                        <Download className="h-3 w-3" />
                        {m.sizeMb >= 1000 ? `${(m.sizeMb / 1000).toFixed(1)} GB` : `${m.sizeMb} MB`}
                      </Button>
                    )}
                  </div>
                  {isDownloading && (
                    <div className="mt-2">
                      <Progress value={downloadProgress * 100} className="h-1.5" />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {downloadLabel} — {Math.round(downloadProgress * 100)}% — do not close
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div> : <div className="grid gap-3 rounded-md border border-border p-3">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              CrisperWhisper model
              <select
                className="h-8 rounded border border-input bg-background px-2 text-sm text-foreground"
                value={crisperModel}
                onChange={(event) => setCrisperModel(event.target.value as typeof crisperModel)}
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
                <option value="turbo">Turbo</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              Python executable with crisperwhisper installed
              <span className="flex gap-2">
                <input
                  className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 text-sm text-foreground"
                  placeholder="/path/to/venv/bin/python"
                  value={crisperPython}
                  onChange={(event) => {
                    setCrisperPython(event.target.value);
                    localStorage.setItem("crisperPython", event.target.value);
                  }}
                />
                <Button type="button" size="sm" variant="outline" onClick={async () => {
                  const path = await openDialog({ title: "Choose CrisperWhisper Python executable" });
                  if (typeof path === "string") {
                    setCrisperPython(path);
                    localStorage.setItem("crisperPython", path);
                  }
                }}>Browse</Button>
              </span>
            </label>
            <p className="text-xs text-muted-foreground">
              Select the Python inside the environment where you installed crisperwhisper.
            </p>
          </div>}

          {/* ── Language / options ── */}
          <div className="grid gap-3 rounded-md border border-border p-3">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              Source language
              <select
                className="h-8 rounded border border-input bg-background px-2 text-sm text-foreground"
                value={transcribeLanguage}
                onChange={(e) => setTranscribeLanguage(e.target.value)}
              >
                {WHISPER_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>

            {/* translate + diarize */}
            {selectedEngine === "whisper-cpp" && <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={transcribeTranslate}
                  onChange={(e) => setTranscribeTranslate(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Translate to English</span>
                  <span className="ml-1 text-muted-foreground">
                    — output English regardless of source
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={transcribeDiarize}
                  onChange={(e) => setTranscribeDiarize(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Speaker diarisation</span>
                  <span className="ml-1 text-muted-foreground">— label who is speaking</span>
                </span>
              </label>
            </div>}
          </div>

          <DialogFooter>
            <Button
              onClick={() => setModelDialogOpen(false)}
              variant="outline"
              disabled={downloadingModel !== null}
            >
              Cancel
            </Button>
            <Button
              onClick={startTranscribe}
              disabled={
                downloadingModel !== null ||
                (selectedEngine === "whisper-cpp"
                  ? !installedModels.find((m) => m.name === selectedModel)?.installed
                  : !crisperPython.trim())
              }
              variant={forceRetranscribeRef.current ? "destructive" : "default"}
            >
              {forceRetranscribeRef.current ? "Re-Transcribe" : "Transcribe"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Export video</DialogTitle>
            <DialogDescription>
              Choose output resolution and quality before rendering the edited timeline.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-1">
            <label className="grid gap-1.5 text-sm">
              Resolution
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={exportSettings.resolution}
                onChange={(e) => setExportSettings((s) => ({ ...s, resolution: e.target.value }))}
              >
                <option value="original">Original</option>
                <option value="720p">1280 x 720</option>
                <option value="1080p">1920 x 1080</option>
                <option value="4k">3840 x 2160</option>
                <option value="custom">Custom</option>
              </select>
            </label>

            {exportSettings.resolution === "custom" && (
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1.5 text-sm">
                  Width
                  <input
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    type="number"
                    min={16}
                    step={2}
                    value={exportSettings.customWidth}
                    onChange={(e) =>
                      setExportSettings((s) => ({ ...s, customWidth: Number(e.target.value) }))
                    }
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  Height
                  <input
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    type="number"
                    min={16}
                    step={2}
                    value={exportSettings.customHeight}
                    onChange={(e) =>
                      setExportSettings((s) => ({ ...s, customHeight: Number(e.target.value) }))
                    }
                  />
                </label>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-sm">
                Codec
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={exportSettings.codec}
                  onChange={(e) =>
                    setExportSettings((s) => ({
                      ...s,
                      codec: e.target.value as "auto" | "h264" | "hevc",
                    }))
                  }
                >
                  <option value="auto">Match source (smart-cut)</option>
                  <option value="h264">H.264 (re-encode)</option>
                  <option value="hevc">HEVC (re-encode)</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                Frame rate
                <input
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="Original"
                  value={exportSettings.fps}
                  onChange={(e) => setExportSettings((s) => ({ ...s, fps: e.target.value }))}
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-sm">
                Video bitrate
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1"
                    type="range"
                    min={1500}
                    max={30000}
                    step={500}
                    value={exportSettings.videoBitrateKbps}
                    onChange={(e) =>
                      setExportSettings((s) => ({
                        ...s,
                        videoBitrateKbps: Number(e.target.value),
                      }))
                    }
                  />
                  <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                    {(exportSettings.videoBitrateKbps / 1000).toFixed(1)} Mbps
                  </span>
                </div>
              </label>
              <label className="grid gap-1.5 text-sm">
                Audio bitrate
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={exportSettings.audioBitrateKbps}
                  onChange={(e) =>
                    setExportSettings((s) => ({
                      ...s,
                      audioBitrateKbps: Number(e.target.value),
                    }))
                  }
                >
                  <option value={128}>128 kbps</option>
                  <option value={192}>192 kbps</option>
                  <option value={256}>256 kbps</option>
                  <option value={320}>320 kbps</option>
                </select>
              </label>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={exportSettings.forceReencode}
                onChange={(e) =>
                  setExportSettings((s) => ({ ...s, forceReencode: e.target.checked }))
                }
              />
              Force full re-encode (disable smart-cut)
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setExportDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setExportDialogOpen(false);
                void runExport();
              }}
              className="gap-2"
            >
              <Settings2 className="h-4 w-4" />
              Export .mp4
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={transcribeProgress !== null} onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MicVocal className="h-4 w-4 text-primary" />
              Transcribing media
            </DialogTitle>
            <DialogDescription>
              YusafCut is building the word-level edit timeline locally on this Mac.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/*
             * Same two-phase pattern as export:
             *  transcribeProgress === 0  → Whisper model is loading / audio is being decoded,
             *                              no meaningful % yet — show indeterminate bar.
             *  transcribeProgress  > 0  → Whisper is actively transcribing; show real %.
             */}
            {(transcribeProgress ?? 0) > 0 ? (
              <>
                <Progress value={(transcribeProgress ?? 0) * 100} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Whisper running locally</span>
                  <span>{Math.round((transcribeProgress ?? 0) * 100)}%</span>
                </div>
              </>
            ) : (
              <>
                <Progress indeterminate />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Whisper running locally</span>
                  <span>Loading model…</span>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={mediaLoading} onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-primary" />
              Loading media
            </DialogTitle>
            <DialogDescription>
              Probing the file and preparing it for local playback.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Progress indeterminate />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Reading metadata</span>
              <span>Local file</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={exportingProgress !== null} onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scissors className="h-4 w-4 text-primary" />
              Exporting video
            </DialogTitle>
            <DialogDescription>
              Rendering the edited timeline with your selected export settings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/*
             * Two-phase progress UI:
             *  exportingProgress === 0  → ffmpeg is initialising (no frames encoded yet),
             *                             show an indeterminate "running" bar with no %.
             *  exportingProgress  > 0  → real frame data is flowing; switch to a
             *                             determinate bar so the user can see how far along
             *                             the render is.
             */}
            {(exportingProgress ?? 0) > 0 ? (
              <>
                <Progress value={(exportingProgress ?? 0) * 100} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Writing .mp4</span>
                  <span>{Math.round((exportingProgress ?? 0) * 100)}%</span>
                </div>
              </>
            ) : (
              <>
                <Progress indeterminate />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Preparing export…</span>
                  <span>Starting ffmpeg</span>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={modelDownloadProgress !== null} onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-4 w-4 text-primary" />
              Downloading model
            </DialogTitle>
            <DialogDescription>Preparing the local transcription model.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Progress value={(modelDownloadProgress ?? 0) * 100} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{modelDownloadLabel ?? "Downloading…"}</span>
              <span>{Math.round((modelDownloadProgress ?? 0) * 100)}%</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/*
       * Heavy-edit progress is now shown by the global <ProcessingOverlay/>
       * (driven by uiStore.isProcessingEdit), which also locks playback.
       */}

      <MusicTracksDialog open={musicDialogOpen} onOpenChange={setMusicDialogOpen} />
      <SnapshotsDialog open={snapshotsDialogOpen} onOpenChange={setSnapshotsDialogOpen} />
    </div>
  );
}
