import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
  disposed: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, fn: (event: { payload: unknown }) => void) => {
    mock.listeners.set(name, fn);
    return () => {
      mock.listeners.delete(name);
      mock.disposed();
    };
  }),
}));
import { analyzeRetakeWindows, downloadRetakeModel, retakeOllamaModels } from "@/lib/retakeIpc";
import { retakeRecords, retakeWindows } from "@/lib/retakes";
import { speech } from "./helpers/retakeProject";
beforeEach(() => {
  mock.listeners.clear();
  mock.invoke.mockReset();
  mock.disposed.mockReset();
});
describe("native retake job cancellation", () => {
  it("lists local models and passes the selected Ollama backend to analysis", async () => {
    mock.invoke.mockResolvedValueOnce(["qwen:8b"]);
    expect(await retakeOllamaModels()).toEqual(["qwen:8b"]);
    const windows = retakeWindows(retakeRecords(speech("Use POST sorry PUT for updates.")));
    mock.invoke.mockResolvedValueOnce([]);
    await analyzeRetakeWindows(windows, new AbortController().signal, undefined, {
      kind: "ollama",
      model: "qwen:8b",
    });
    expect(mock.invoke).toHaveBeenCalledWith(
      "analyze_retake_windows",
      expect.objectContaining({ backend: { kind: "ollama", model: "qwen:8b" } }),
    );
  });
  it("cancels a job announced after the abort and ignores unrelated jobs", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    mock.invoke.mockImplementation((command: string, args: { runId: string }) => {
      if (command === "cancel_job") return Promise.resolve();
      controller.abort();
      mock.listeners.get("retakes:job")!({ payload: { runId: "other", jobId: "other-job" } });
      mock.listeners.get("retakes:job")!({ payload: { runId: args.runId, jobId: "ours" } });
      return new Promise<void>((r) => {
        finish = r;
      });
    });
    const request = downloadRetakeModel(controller.signal);
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("cancel_job", { id: "ours" }));
    finish();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.disposed).toHaveBeenCalledTimes(2);
    expect(mock.listeners.size).toBe(0);
  });
  it("does not launch an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(downloadRetakeModel(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mock.invoke).not.toHaveBeenCalled();
  });
});
