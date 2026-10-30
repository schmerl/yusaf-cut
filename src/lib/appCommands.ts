import { useEffect } from "react";
import { endTypingGroup, useProjectStore } from "@/stores/projectStore";

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
  | "review-next"
  | "review-previous"
  | "format-script"
  | "cut-speech"
  | "original";
export function dispatchCommand(command: AppCommand) {
  window.dispatchEvent(new CustomEvent("yusafcut:command", { detail: command }));
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
