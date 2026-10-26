import { saveProject } from "./ipc";
import { useProjectStore, projectSession } from "@/stores/projectStore";
import type { Project } from "./edl";

// Serialize writes: two atomic renames must not race on the same project.json.tmp.
let pending: Promise<unknown> = Promise.resolve();
export function saveProjectRevision(
  project: Project,
  path: string,
  session = projectSession(),
): Promise<void> {
  const write = pending
    .catch(() => undefined)
    .then(async () => {
      if (projectSession() !== session) return;
      await saveProject(project, path);
      useProjectStore.getState().markSaved(path, project, session);
    });
  pending = write;
  return write;
}
