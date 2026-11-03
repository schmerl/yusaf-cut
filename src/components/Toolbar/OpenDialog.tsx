import { projectSession, useProjectStore } from "@/stores/projectStore";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { StoredScript } from "@/lib/scriptAssistance";
import { readScriptFile } from "@/lib/scriptFiles";

export function OpenDialog({
  onClose,
  onProject,
  onMedia,
}: {
  onClose: () => void;
  onProject: () => Promise<void>;
  onMedia: (path: string, script?: StoredScript) => Promise<void>;
}) {
  const [video, setVideo] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const name = (path: string) => path.split(/[\\/]/u).at(-1);
  async function choose(script: boolean) {
    setError("");
    try {
      const path = await open({
        multiple: false,
        title: script ? "Choose optional script" : "Choose video or audio",
        filters: [
          {
            name: script ? "Markdown" : "Media",
            extensions: script
              ? ["md", "markdown"]
              : ["mp4", "mov", "m4v", "mkv", "webm", "m4a", "wav"],
          },
        ],
      });
      if (typeof path === "string") (script ? setScriptPath : setVideo)(path);
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function start() {
    setBusy(true);
    setError("");
    const expected = useProjectStore.getState().project,
      session = projectSession();
    try {
      const script = scriptPath ? await readScriptFile(scriptPath) : undefined;
      if (!active.current) return;
      if (useProjectStore.getState().project !== expected || projectSession() !== session)
        throw new Error("The project changed while opening. Try again.");
      await onMedia(video, script);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) {
          active.current = false;
          onClose();
        }
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogTitle>Open</DialogTitle>
        <DialogDescription>Continue a saved project, or start with a recording.</DialogDescription>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void onProject()
              .then(onClose)
              .catch((cause) => setError(String(cause)));
          }}
        >
          Open saved project…
        </Button>
        <fieldset disabled={busy} className="space-y-3 border-t border-border pt-4">
          <legend className="sr-only">New project from recording</legend>
          <Button variant="outline" onClick={() => void choose(false)}>
            {video ? name(video) : "Choose video or audio…"}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => void choose(true)}>
              {scriptPath ? name(scriptPath) : "Add script (optional)…"}
            </Button>
            {scriptPath && (
              <Button variant="ghost" onClick={() => setScriptPath("")}>
                Remove script
              </Button>
            )}
          </div>
          <Button disabled={!video} onClick={() => void start()}>
            {busy ? "Opening…" : "Start editing"}
          </Button>
        </fieldset>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
