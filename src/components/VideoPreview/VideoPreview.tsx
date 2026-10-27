import { useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { TimelinePlayer } from "./TimelinePlayer";

export function VideoPreview() {
  const project = useProjectStore((s) => s.project);
  return <TimelinePlayer project={project} playerStore={usePlayerStore} />;
}
