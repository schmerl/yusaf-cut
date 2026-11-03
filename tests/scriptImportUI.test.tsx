import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptPanel } from "@/components/TranscriptEditor/ScriptPanel";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import type { Project } from "@/lib/edl";
import original from "./fixtures/transcript-corrections.json";

const io = vi.hoisted(() => ({ open: vi.fn(), readFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: io.open }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: io.readFile }));
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  replaceProjectBaseline(structuredClone(original) as Project);
  io.open.mockReset().mockResolvedValue("/tmp/script.md");
  io.readFile
    .mockReset()
    .mockResolvedValue(new TextEncoder().encode("# Title\n\n<press> Use `GET /payments/P456`."));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("native script import panel", () => {
  it("imports a stored copy, previews spoken text, and supports undo/redo without a timeline change", async () => {
    const before = useProjectStore.getState().project;
    render(<ScriptPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Markdown" }));
    await screen.findByText("script.md · 1 spoken passages");
    const imported = useProjectStore.getState().project;
    expect(imported.segments).toBe(before.segments);
    expect(imported.scriptAssistance!.scripts[0]!.markdown).toContain("<press>");
    expect(screen.getByText("Use GET /payments/P456.")).toBeInTheDocument();
    expect(screen.queryByText("Title")).not.toBeInTheDocument();
    act(() => useProjectStore.temporal.getState().undo());
    expect(useProjectStore.getState().project).toBe(before);
    act(() => useProjectStore.temporal.getState().redo());
    expect(useProjectStore.getState().project).toBe(imported);
  });
  it("cancelling the file dialog changes neither project nor history", async () => {
    io.open.mockResolvedValue(null);
    const before = useProjectStore.getState().project;
    render(<ScriptPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Markdown" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import Markdown" })).toBeEnabled(),
    );
    expect(useProjectStore.getState().project).toBe(before);
    expect(io.readFile).not.toHaveBeenCalled();
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
  });
  it("rejects malformed UTF-8 and nonspoken-only scripts without replacing the old script", async () => {
    render(<ScriptPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Markdown" }));
    await screen.findByRole("button", { name: "Replace script" });
    const before = useProjectStore.getState().project;
    io.readFile.mockResolvedValueOnce(new Uint8Array([0xff]));
    fireEvent.click(screen.getByRole("button", { name: "Replace script" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/UTF-8/);
    expect(useProjectStore.getState().project).toBe(before);
    io.readFile.mockResolvedValueOnce(new TextEncoder().encode("# Heading only"));
    fireEvent.click(screen.getByRole("button", { name: "Replace script" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/No spoken text/));
    expect(useProjectStore.getState().project).toBe(before);
  });
  it("rejects completion after a project switch while preserving the new project", async () => {
    let complete!: (bytes: Uint8Array) => void;
    io.readFile.mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        complete = resolve;
      }),
    );
    render(<ScriptPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Markdown" }));
    await waitFor(() => expect(io.readFile).toHaveBeenCalled());
    const next = { ...structuredClone(original), id: "switched" } as Project;
    act(() => replaceProjectBaseline(next));
    await act(async () => complete(new TextEncoder().encode("Spoken text.")));
    expect(useProjectStore.getState().project).toBe(next);
    expect(next.scriptAssistance).toBeUndefined();
    expect(screen.getByRole("alert")).toHaveTextContent(/project changed/);
  });
  it("shows precise script warnings while preserving following spoken lines", async () => {
    io.readFile.mockResolvedValue(new TextEncoder().encode("First.\n\n<bad cue\nLater spoken."));
    render(<ScriptPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Markdown" }));
    expect(await screen.findByText(/Line 3: Unclosed/)).toBeInTheDocument();
    expect(screen.getByText("Later spoken.")).toBeInTheDocument();
  });
});
