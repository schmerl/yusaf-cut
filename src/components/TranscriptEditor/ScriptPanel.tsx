import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { Button } from "@/components/ui/button";
import { endTypingGroup, projectSession, useProjectStore } from "@/stores/projectStore";
import { prepareScript, replaceStoredScript } from "@/lib/scriptAssistance";
import { MAX_SCRIPT_BYTES, parseScript } from "@/lib/scriptMarkdown";

export function ScriptPanel({
  onClose,
  isComposing,
}: {
  onClose: () => void;
  isComposing?: () => boolean;
}) {
  const project = useProjectStore((state) => state.project);
  const script = project.scriptAssistance?.scripts.find(
    (s) => s.revision === project.scriptAssistance!.activeRevision,
  );
  const parsed = useMemo(() => (script ? parseScript(script.markdown) : null), [script]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  useEffect(
    () => () => {
      serial.current++;
    },
    [],
  );

  async function importScript() {
    const expected = useProjectStore.getState().project;
    const session = projectSession(),
      request = ++serial.current;
    const valid = () =>
      request === serial.current &&
      session === projectSession() &&
      useProjectStore.getState().project === expected;
    setBusy(true);
    setError("");
    try {
      endTypingGroup();
      const path = await open({
        multiple: false,
        title: script ? "Replace stored script" : "Import script",
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!path || Array.isArray(path)) return;
      if (!valid()) throw new Error("The project changed. Import the script again.");
      const bytes = await readFile(path);
      if (!valid()) throw new Error("The project changed. Import the script again.");
      if (bytes.length > MAX_SCRIPT_BYTES)
        throw new Error("The script exceeds 2 MB. Import a smaller file.");
      let markdown: string;
      try {
        markdown = new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("The script is not valid UTF-8. Save it as UTF-8 Markdown and retry.");
      }
      const prepared = await prepareScript(markdown, path.split(/[\\/]/u).at(-1) ?? "Script.md");
      if (!valid()) throw new Error("The project changed. Import the script again.");
      if (isComposing?.()) throw new Error("Finish typing before importing the script again.");
      const next = replaceStoredScript(expected, prepared);
      useProjectStore.getState().commitTranscript(next, expected);
    } catch (cause) {
      if (request === serial.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === serial.current) setBusy(false);
    }
  }

  return (
    <section
      aria-label="Presentation script"
      className="max-h-[55%] shrink-0 overflow-y-auto border-b border-border bg-card px-4 py-3 text-sm"
    >
      <div className="flex items-center gap-2">
        <h2 className="font-medium">Presentation script</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !project.segments.length}
          onClick={() => void importScript()}
        >
          {busy ? "Importing script…" : script ? "Replace script" : "Import Markdown"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close script
        </Button>
      </div>
      {busy && <p role="status">Reading and checking the Markdown script…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {script && parsed ? (
        <>
          <p>
            {script.name} · {parsed.passages.length} spoken passages
          </p>
          <p className="text-xs text-muted-foreground">
            A copy is stored with this project. Replace it explicitly to use an updated file. Import
            changes no transcript text or audio.
          </p>
          {parsed.issues.length > 0 && (
            <div role="status">
              <p>Check these script locations before reconciling:</p>
              <ul>
                {parsed.issues.map((issue) => (
                  <li key={`${issue.from}:${issue.message}`}>
                    Line {issue.line}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details className="mt-2">
            <summary>Spoken script preview</summary>
            <div className="max-h-48 overflow-y-auto whitespace-pre-wrap">
              {parsed.passages.map((passage) => (
                <p className="my-2" key={passage.from}>
                  {passage.text}
                </p>
              ))}
            </div>
          </details>
          <details className="mt-2">
            <summary>Review history</summary>
            {(project.scriptAssistance?.records ?? [])
              .filter(
                (r) =>
                  r.historicalReason || !["suggested", "off-script", "applied"].includes(r.status),
              )
              .map((r) => (
                <div key={r.id} className="my-2 border-t border-border pt-2">
                  <p>
                    {r.beforeText} → {r.afterText}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.status}
                    {r.historicalReason ? ` · ${r.historicalReason}` : ""}
                  </p>
                </div>
              ))}
          </details>
        </>
      ) : (
        <p className="text-muted-foreground">
          Import the teleprompter script for this recording. Headings, cues, images and code blocks
          are unspoken.
        </p>
      )}
    </section>
  );
}
