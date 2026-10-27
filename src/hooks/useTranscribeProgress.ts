/**
 * Wires Tauri-emitted transcribe/export/model-download progress events into the
 * UI store so the toolbar progress bars can react.
 */

import { useEffect } from "react";
import { onExportProgress, onModelDownloadProgress, onTranscribeProgress } from "@/lib/ipc";
import { useUIStore } from "@/stores/uiStore";

export function useTranscribeProgress() {
  const setTranscribeProgress = useUIStore((s) => s.setTranscribeProgress);
  const setExportingProgress = useUIStore((s) => s.setExportingProgress);
  const setModelDownloadProgress = useUIStore((s) => s.setModelDownloadProgress);
  const setModelDownloadLabel = useUIStore((s) => s.setModelDownloadLabel);

  useEffect(() => {
    let unlistenTranscribe: (() => void) | undefined;
    let unlistenExport: (() => void) | undefined;
    let unlistenModel: (() => void) | undefined;

    void onTranscribeProgress((p) => {
      // A native completion covers one clip. The workflow owns completion of
      // the entire staged batch, including validation and commit. Ignore late
      // events after it has finished instead of reopening the progress dialog.
      if (useUIStore.getState().transcribeProgress !== null) setTranscribeProgress(p.progress);
    }).then((fn) => {
      unlistenTranscribe = fn;
    });

    void onExportProgress((p) => {
      setExportingProgress(p.progress >= 1 ? null : p.progress);
    }).then((fn) => {
      unlistenExport = fn;
    });

    void onModelDownloadProgress((p) => {
      const done = p.progress >= 1;
      setModelDownloadProgress(done ? null : p.progress);
      setModelDownloadLabel(done ? null : (p.label ?? null));
    }).then((fn) => {
      unlistenModel = fn;
    });

    return () => {
      unlistenTranscribe?.();
      unlistenExport?.();
      unlistenModel?.();
    };
  }, [
    setTranscribeProgress,
    setExportingProgress,
    setModelDownloadProgress,
    setModelDownloadLabel,
  ]);
}
