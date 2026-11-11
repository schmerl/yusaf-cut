import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNativeMenu } from "@/hooks/useNativeMenu";
import { useAppCommands } from "@/lib/appCommands";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { newProject } from "@/lib/edl";
import fixture from "./fixtures/transcript-corrections.json";
const native = vi.hoisted(() => ({
  items: new Map<string, { action: () => void; setEnabled: ReturnType<typeof vi.fn> }>(),
  setMenu: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@tauri-apps/api/menu", () => ({
  MenuItem: {
    new: vi.fn(async (options) => {
      const item = { ...options, setEnabled: vi.fn().mockResolvedValue(undefined) };
      native.items.set(options.id, item);
      return item;
    }),
  },
  PredefinedMenuItem: { new: vi.fn(async (options) => options) },
  Submenu: { new: vi.fn(async (options) => options) },
  Menu: { new: vi.fn(async () => ({ setAsAppMenu: native.setMenu, close: native.close })) },
}));
function Harness({ open }: { open: () => void }) {
  useNativeMenu();
  useAppCommands({ open });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  native.items.clear();
  native.setMenu.mockClear();
  native.close.mockClear();
  replaceProjectBaseline(newProject("Before"));
});
it("enables native timeline cuts for wordless media while leaving transcript commands disabled", async () => {
  render(<Harness open={vi.fn()} />);
  await waitFor(() => expect(native.setMenu).toHaveBeenCalledOnce());
  expect(native.items.get("cut-speech")!.setEnabled).toHaveBeenLastCalledWith(false);
  const p = {
    ...newProject("Untranscribed"),
    media: { m1: fixture.media.m1 },
    segments: [{ id: "untranscribed", mediaId: "m1", sourceIn: 0, sourceOut: 3, words: [] }],
  };
  act(() => replaceProjectBaseline(p));
  expect(native.items.get("cut-speech")!.setEnabled).toHaveBeenLastCalledWith(true);
  expect(native.items.get("review-script")!.setEnabled).toHaveBeenLastCalledWith(false);
  expect(native.items.get("original")!.setEnabled).toHaveBeenLastCalledWith(false);
  act(() => replaceProjectBaseline(newProject("Empty")));
  expect(native.items.get("cut-speech")!.setEnabled).toHaveBeenLastCalledWith(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("native Open invokes the shared command; native Undo/Redo track project history", async () => {
  const open = vi.fn();
  render(<Harness open={open} />);
  await waitFor(() => expect(native.setMenu).toHaveBeenCalledOnce());
  act(() => native.items.get("open")!.action());
  expect(open).toHaveBeenCalledOnce();
  const undo = native.items.get("project-undo")!,
    redo = native.items.get("project-redo")!;
  expect(undo.setEnabled).toHaveBeenLastCalledWith(false);
  expect(redo.setEnabled).toHaveBeenLastCalledWith(false);
  act(() => useProjectStore.getState().rename("After"));
  expect(undo.setEnabled).toHaveBeenLastCalledWith(true);
  act(() => undo.action());
  expect(useProjectStore.getState().project.name).toBe("Before");
  expect(redo.setEnabled).toHaveBeenLastCalledWith(true);
  act(() => redo.action());
  expect(useProjectStore.getState().project.name).toBe("After");
  expect(native.items.get("review-script")!.setEnabled).toHaveBeenLastCalledWith(false);
});
it("native history does not commit or undo an unfinished transcript composition", async () => {
  render(<Harness open={vi.fn()} />);
  await waitFor(() => expect(native.setMenu).toHaveBeenCalled());
  act(() => useProjectStore.getState().rename("After"));
  const draft = document.createElement("div");
  draft.dataset.composing = "true";
  document.body.append(draft);
  act(() => native.items.get("project-undo")!.action());
  expect(useProjectStore.getState().project.name).toBe("After");
  draft.remove();
});
