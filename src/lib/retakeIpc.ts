import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { JobSnapshot } from "./ipc";
import type { RawRetakeGroup, RetakeWindow } from "./retakes";
import { semanticHypotheses } from "./retakes";

export interface RetakeModelStatus {
  installed: boolean;
  modelId: string;
  revision: string;
  sizeBytes: number;
}
export const retakeModelStatus = () => invoke<RetakeModelStatus>("retake_model_status");
export const retakeOllamaModels = () => invoke<string[]>("retake_ollama_models");
export type RetakeBackend = { kind: "mlx" } | { kind: "ollama"; model: string };
export interface RetakeWindowResult {
  id: string;
  groups: RawRetakeGroup[];
}

async function jobRequest<T>(
  command: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  progress?: (value: number) => void,
): Promise<T> {
  signal.throwIfAborted();
  const runId = crypto.randomUUID();
  let jobId: string | undefined;
  const cancel = () => {
    if (jobId) void invoke("cancel_job", { id: jobId }).catch(() => {});
  };
  const unlisten = await listen<{ runId: string; jobId: string }>("retakes:job", ({ payload }) => {
    if (payload.runId !== runId) return;
    jobId = payload.jobId;
    if (signal.aborted) cancel();
  });
  let stopProgress: (() => void) | undefined;
  try {
    stopProgress = await listen<JobSnapshot[]>("jobs:update", ({ payload }) => {
      const job = payload.find((j) => j.id === jobId);
      if (job) progress?.(job.progress);
    });
    signal.throwIfAborted();
    signal.addEventListener("abort", cancel, { once: true });
    const result = await invoke<T>(command, { ...args, runId });
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    unlisten();
    stopProgress?.();
  }
}
export function downloadRetakeModel(signal: AbortSignal, progress?: (value: number) => void) {
  return jobRequest<void>("download_retake_model", {}, signal, progress);
}
export function analyzeRetakeWindows(
  windows: RetakeWindow[],
  signal: AbortSignal,
  progress?: (value: number) => void,
  backend: RetakeBackend = { kind: "mlx" },
) {
  return jobRequest<RetakeWindowResult[]>(
    "analyze_retake_windows",
    {
      backend,
      windows: windows.map((w) => ({
        id: w.id,
        records: w.records.map(({ text, start, end }) => ({ text, start, end })),
        hypotheses: semanticHypotheses(w),
      })),
    },
    signal,
    progress,
  );
}
