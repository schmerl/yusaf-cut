import { readFile } from "@tauri-apps/plugin-fs";
import { prepareScript } from "./scriptAssistance";
import { MAX_SCRIPT_BYTES } from "./scriptMarkdown";
export async function readScriptFile(path: string) {
  const bytes = await readFile(path);
  if (bytes.length > MAX_SCRIPT_BYTES)
    throw new Error("The script exceeds 2 MB. Import a smaller file.");
  let markdown: string;
  try {
    markdown = new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The script is not valid UTF-8. Save it as UTF-8 Markdown and retry.");
  }
  return prepareScript(markdown, path.split(/[\\/]/u).at(-1) ?? "Script.md");
}
