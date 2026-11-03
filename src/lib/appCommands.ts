import { useEffect } from "react";
import { endTypingGroup, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { useUIStore } from "@/stores/uiStore";

export type AppCommand =
  | "open"
  | "save"
  | "add-clip"
  | "new"
  | "close-project"
  | "export"
  | "captions"
  | "snapshots"
  | "script"
  | "find"
  | "review-script"
  | "review-selected"
  | "review-fillers"
  | "review-log"
  | "review-next"
  | "review-previous"
  | "format-script"
  | "cut-speech"
  | "original";
export function dispatchCommand(command: AppCommand) {
  if (command === "cut-speech" && document.activeElement?.closest(".timeline-panel")) {
    cutTimelineSelection();
    return;
  }
  window.dispatchEvent(new CustomEvent("yusafcut:command", { detail: command }));
}

/** Shared by the timeline button, keyboard shortcut and native Edit menu. */
export function cutTimelineSelection() {
  const player = usePlayerStore.getState();
  try {
    if (useUIStore.getState().isProcessingEdit)
      throw new Error("Wait for the timeline update to finish before cutting.");
    endTypingGroup();
    if (player.timelineMarkIn === null || player.timelineMarkOut === null)
      throw new Error(
        "Select a timeline range by dragging, or mark its start and end with I and O.",
      );
    if (player.timelineMarkIn === player.timelineMarkOut)
      throw new Error("Select a timeline range with a different start and end.");
    const changed = useProjectStore
      .getState()
      .deleteOutputRange(player.timelineMarkIn, player.timelineMarkOut);
    if (!changed) {
      useUIStore
        .getState()
        .pushToast({
          title: "Nothing to cut",
          description: "This range contains no media to remove.",
        });
      return;
    }
    window.dispatchEvent(new CustomEvent("yusafcut:pause"));
    player.setPlaying(false);
    player.clearTimelineRange();
    player.setSelectedWordIds([]);
  } catch (error) {
    useUIStore
      .getState()
      .pushToast({
        title: "Cannot cut speech",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
  }
}
export function useAppCommands(handlers: Partial<Record<AppCommand, () => void>>) {
  useEffect(() => {
    const listener = (event: Event) => handlers[(event as CustomEvent<AppCommand>).detail]?.();
    window.addEventListener("yusafcut:command", listener);
    return () => window.removeEventListener("yusafcut:command", listener);
  }, [handlers]);
}
export function projectHistory(redo = false) {
  if (document.querySelector('[data-composing="true"]')) return;
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    document.execCommand(redo ? "redo" : "undo");
    return;
  }
  endTypingGroup();
  const history = useProjectStore.temporal.getState();
  if (redo) history.redo();
  else history.undo();
}
