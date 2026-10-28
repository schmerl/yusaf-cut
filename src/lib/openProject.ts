import { loadProject } from "./ipc";
import { validateProjectTranscripts } from "./transcript";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { useUIStore } from "@/stores/uiStore";

/** Project bundles are directories; their internal JSON is also a valid input. */
export function isProjectPath(path: string): boolean {
  return /(?:\.scribe|[/\\]project\.json)[/\\]*$/i.test(path);
}

/** Autosave and snapshots need the containing bundle, not project.json itself. */
export function projectBundlePath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (/[/\\]project\.json$/i.test(trimmed)) {
    const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return trimmed.slice(0, separator) || "/";
  }
  return trimmed || path;
}

/** Shared by the toolbar project picker, general Open action, and file drops. */
export async function openSavedProject(path: string): Promise<void> {
  const ui = useUIStore.getState();
  ui.setMediaLoading(true);
  try {
    const loaded = await loadProject(path);
    validateProjectTranscripts(loaded);
    const bundle = projectBundlePath(path);
    replaceProjectBaseline(loaded, { dirty: false, filePath: bundle });
    useProjectStore.getState().setPauseTokens([]);
    usePlayerStore.getState().reset();
    ui.pushToast({ title: "Project opened", description: bundle });
  } catch (err) {
    ui.pushToast({
      title: "Failed to open project",
      description: String(err),
      variant: "destructive",
    });
  } finally {
    ui.setMediaLoading(false);
  }
}
