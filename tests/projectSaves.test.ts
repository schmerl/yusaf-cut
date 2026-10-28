import { beforeEach, expect, it, vi } from "vitest";
import { newProject } from "@/lib/edl";
import { saveProject } from "@/lib/ipc";
import { saveProjectRevision } from "@/lib/projectSaves";
import { replaceProjectBaseline, useProjectStore, projectSession } from "@/stores/projectStore";
vi.mock("@/lib/ipc", () => ({ saveProject: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  replaceProjectBaseline(newProject("initial"), { filePath: "/tmp/one.scribe" });
});
it("an old save completion cannot mark newer edits clean, and writes are serialized", async () => {
  let finish!: () => void;
  vi.mocked(saveProject)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce();
  const old = useProjectStore.getState().project;
  const first = saveProjectRevision(old, "/tmp/one.scribe");
  await vi.waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
  useProjectStore.getState().rename("newer");
  const current = useProjectStore.getState().project;
  const second = saveProjectRevision(current, "/tmp/one.scribe");
  expect(saveProject).toHaveBeenCalledTimes(1);
  finish();
  await first;
  expect(useProjectStore.getState().dirty).toBe(true);
  await second;
  expect(useProjectStore.getState().dirty).toBe(false);
  expect(saveProject).toHaveBeenLastCalledWith(current, "/tmp/one.scribe");
});
it("a switched project ignores old completion and skips queued old-session saves", async () => {
  let finish!: () => void;
  vi.mocked(saveProject).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const old = useProjectStore.getState().project,
    session = projectSession();
  const write = saveProjectRevision(old, "/tmp/one.scribe", session);
  await vi.waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
  const queued = saveProjectRevision(old, "/tmp/one.scribe", session);
  const next = newProject("another");
  replaceProjectBaseline(next);
  finish();
  await write;
  await queued;
  expect(useProjectStore.getState().project).toBe(next);
  expect(useProjectStore.getState().filePath).toBeNull();
  expect(saveProject).toHaveBeenCalledTimes(1);
});
