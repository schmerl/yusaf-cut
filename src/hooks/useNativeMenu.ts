import { useEffect } from "react";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { dispatchCommand, projectHistory, type AppCommand } from "@/lib/appCommands";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";

/** Native actions share the same frontend commands as toolbar controls. */
export function useNativeMenu() {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const items: MenuItem[] = [];
      const command = async (id: AppCommand, text: string, accelerator?: string) => {
        const item = await MenuItem.new({
          id,
          text,
          accelerator,
          action: () => dispatchCommand(id),
        });
        items.push(item);
        return item;
      };
      const undo = await MenuItem.new({
        id: "project-undo",
        text: "Undo",
        accelerator: "CmdOrCtrl+Z",
        action: () => projectHistory(),
      });
      const redo = await MenuItem.new({
        id: "project-redo",
        text: "Redo",
        accelerator: "CmdOrCtrl+Shift+Z",
        action: () => projectHistory(true),
      });
      const predefined = (item: Parameters<typeof PredefinedMenuItem.new>[0]) =>
        PredefinedMenuItem.new(item);
      const menu = await Menu.new({
        items: [
          await Submenu.new({
            text: "YusafCut",
            items: [
              await predefined({ item: { About: null } }),
              await predefined({ item: "Services" }),
              await predefined({ item: "Hide" }),
              await predefined({ item: "HideOthers" }),
              await predefined({ item: "ShowAll" }),
              await predefined({ item: "Quit" }),
            ],
          }),
          await Submenu.new({
            text: "File",
            items: [
              await command("open", "Open…", "CmdOrCtrl+O"),
              await command("new", "New Project"),
              await command("save", "Save", "CmdOrCtrl+S"),
              await command("add-clip", "Add Clip…"),
              await command("script", "Add / Replace Script…"),
              await command("snapshots", "Snapshots…"),
              await command("export", "Export Video…", "CmdOrCtrl+E"),
              await command("captions", "Export Captions…"),
              await command("close-project", "Close Project"),
            ],
          }),
          await Submenu.new({
            text: "Edit",
            items: [
              undo,
              redo,
              await predefined({ item: "Separator" }),
              await predefined({ item: "Cut" }),
              await predefined({ item: "Copy" }),
              await predefined({ item: "Paste" }),
              await predefined({ item: "SelectAll" }),
              await command("find", "Find / Replace…", "CmdOrCtrl+F"),
              await command("cut-speech", "Cut Selected Speech", "CmdOrCtrl+Shift+X"),
              await command("original", "View Original Text"),
            ],
          }),
          await Submenu.new({
            text: "Review",
            items: [
              await command("review-script", "Find Script Differences"),
              await command("review-selected", "Find Differences in Selection"),
              await command("review-fillers", "Review Fillers"),
              await command("review-log", "Review Log…"),
              await command("review-next", "Next Suggestion", "Alt+ArrowDown"),
              await command("review-previous", "Previous Suggestion", "Alt+ArrowUp"),
              await command("format-script", "Apply Simple Formatting"),
            ],
          }),
          await Submenu.new({
            text: "Window",
            items: [
              await predefined({ item: "Minimize" }),
              await predefined({ item: "Fullscreen" }),
              await predefined({ item: "BringAllToFront" }),
            ],
          }),
        ],
      });
      if (disposed) {
        await menu.close();
        return;
      }
      await menu.setAsAppMenu();
      const update = () => {
        const project = useProjectStore.getState().project;
        const history = useProjectStore.temporal.getState();
        const textField = document.activeElement?.matches("input, textarea") ?? false;
        void undo.setEnabled(textField || history.pastStates.length > 0);
        void redo.setEnabled(textField || history.futureStates.length > 0);
        const hasWords = project.segments.some((s) => s.words.length);
        for (const item of items) {
          const enabled =
            item.id.startsWith("review-") ||
            ["format-script", "original", "cut-speech"].includes(item.id)
              ? hasWords && (!["format-script"].includes(item.id) || !!project.scriptAssistance)
              : ["export", "captions", "script"].includes(item.id)
                ? project.segments.length > 0
                : true;
          void item.setEnabled(
            item.id === "review-log"
              ? !!project.reviewLog?.entries.length ||
                  !!project.scriptAssistance?.records.length ||
                  !!project.fillerReview?.decisions.length
              : enabled,
          );
        }
      };
      const unsub = useProjectStore.subscribe(update);
      const unhistory = useProjectStore.temporal.subscribe(update);
      document.addEventListener("focusin", update);
      document.addEventListener("focusout", update);
      update();
      cleanup = () => {
        unsub();
        unhistory();
        document.removeEventListener("focusin", update);
        document.removeEventListener("focusout", update);
        void menu.close();
      };
      if (disposed) cleanup();
    })().catch((error) => {
      if (!disposed)
        useUIStore.getState().pushToast({
          title: "Could not initialize application menus",
          description: String(error),
          variant: "destructive",
        });
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
}
