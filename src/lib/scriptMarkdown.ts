import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

export const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
export interface ScriptIssue {
  from: number;
  to: number;
  line: number;
  message: string;
}
export interface ScriptPassage {
  /** Exact enclosing Markdown source range, in UTF-16 units. */
  from: number;
  to: number;
  text: string;
  section: string[];
  ambiguous: boolean;
}
export interface ParsedScript {
  passages: ScriptPassage[];
  issues: ScriptIssue[];
}

/** Text extraction only. Never render HTML, resolve URLs, or fetch resources. */
export function parseScript(markdown: string): ParsedScript {
  if (new globalThis.TextEncoder().encode(markdown).length > MAX_SCRIPT_BYTES)
    throw new Error("The script exceeds 2 MB. Import a smaller UTF-8 Markdown file.");
  if (markdown.includes("\0")) throw new Error("The script contains invalid NUL characters.");
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const lines = [0];
  for (let i = 0; i < markdown.length; i++) if (markdown[i] === "\n") lines.push(i + 1);
  const offset = (line: number) => lines[line] ?? markdown.length;
  const issues: ScriptIssue[] = [];
  function issue(from: number, to: number, message: string) {
    issues.push({ from, to, line: lines.filter((at) => at <= from).length, message });
  }
  // Block parsing identifies code without interpreting it. Mask comments outside
  // code before inline parsing so comments can span blank lines. Keep every
  // source offset (including CRLF and astral Unicode) unchanged.
  function protectedCode(source: string) {
    const blocks: Token[] = [];
    md.block.parse(source, md, {}, blocks);
    return blocks
      .filter((t) => (t.type === "fence" || t.type === "code_block") && t.map)
      .map((t) => ({ from: offset(t.map![0]), to: offset(t.map![1]) }));
  }
  let codeRanges = protectedCode(markdown);
  let commentReparses = 0;
  const chars = markdown.split("");
  const commentLines = new Set<number>();
  for (let i = 0; i < markdown.length; ) {
    const code = codeRanges.find((r) => i >= r.from && i < r.to);
    if (code) {
      i = code.to;
      continue;
    }
    if (markdown[i] === "\\") {
      i += 2;
      continue;
    }
    if (markdown[i] === "`") {
      const marker = /^`+/u.exec(markdown.slice(i))![0];
      let end = i + marker.length;
      while ((end = markdown.indexOf(marker, end)) >= 0) {
        if (markdown[end - 1] !== "`" && markdown[end + marker.length] !== "`") break;
        end += marker.length;
      }
      if (end >= 0) {
        i = end + marker.length;
        continue;
      }
      // CommonMark treats an unmatched backtick as literal text. Report it so
      // an automatic correction cannot guess whether technical code was intended.
      issue(i, i + marker.length, "Unclosed inline code; check this script passage.");
      i += marker.length;
      continue;
    }
    if (markdown.startsWith("<!--", i)) {
      const close = markdown.indexOf("-->", i + 4);
      const newline = markdown.indexOf("\n", i);
      const end = close >= 0 ? close + 3 : newline >= 0 ? newline : markdown.length;
      if (close < 0) issue(i, end, "Unclosed comment; excluded through the end of this line.");
      for (let line = 0; line < lines.length; line++)
        if (offset(line) < end && offset(line + 1) > i) commentLines.add(line);
      for (let at = i; at < end; at++)
        if (chars[at] !== "\n" && chars[at] !== "\r") chars[at] = " ";
      // A fence inside a comment is not a real code block. Recompute only when
      // masking removed such a block opener, so it cannot hide later comments
      // or misclassify their interior as spoken text. Bound pathological nesting.
      if (codeRanges.some((range) => range.from >= i && range.from < end)) {
        if (++commentReparses > 32)
          throw new Error(
            "Too many overlapping comment/code constructs. Simplify the script markup and retry.",
          );
        codeRanges = protectedCode(chars.join(""));
      }
      i = end;
      continue;
    }
    i++;
  }
  const masked = chars.join("");
  // Comment masking must not turn trailing prose into an indented code block.
  // Keep source columns intact, but use the original indentation classification.
  md.block.ruler.before("code", "script_comment_indent", (state, startLine) => {
    if (commentLines.has(startLine)) {
      const originalIndent = /^[ \t]*/u.exec(markdown.slice(offset(startLine)))![0];
      if (originalIndent.length < 4) state.sCount[startLine] = originalIndent.length;
    }
    return false;
  });
  // Inline parsing consumes escapes and backticks at their own positions before
  // reaching '<'. Cue syntax cannot swallow literal notation inside inline code.
  md.inline.ruler.before("autolink", "script_cue", (state, silent) => {
    if (state.src[state.pos] !== "<") return false;
    const from = state.pos;
    const newline = state.src.indexOf("\n", from);
    const close = state.src.indexOf(">", from + 1);
    const end =
      close >= 0 && (newline < 0 || close < newline)
        ? close + 1
        : newline >= 0
          ? newline
          : state.posMax;
    if (!silent && (close < 0 || (newline >= 0 && close > newline))) {
      const env = state.env as { inlineOffset?: number; raw?: string; positions?: number[] };
      const raw = env.raw ?? "";
      const cue = state.src.slice(from, end);
      const at = env.positions?.[from] ?? (env.inlineOffset ?? 0) + Math.max(0, raw.indexOf(cue));
      issue(
        at,
        env.positions?.[end - 1] === undefined ? at + cue.length : env.positions[end - 1]! + 1,
        "Unclosed <...> cue; excluded through the end of this line.",
      );
    }
    state.pos = end;
    return true;
  });
  // Supply each inline parser with its enclosing raw range for issue locations.
  md.core.ruler.at("inline", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "inline") continue;
      const from = offset(token.map?.[0] ?? 0),
        to = offset(token.map?.[1] ?? 0);
      const positions: number[] = [];
      let cursor = from,
        contentOffset = 0;
      for (const line of token.content.split("\n")) {
        const found = masked.indexOf(line, cursor);
        const sourceAt = found >= cursor && found < to ? found : cursor;
        for (let i = 0; i < line.length; i++) positions[contentOffset + i] = sourceAt + i;
        contentOffset += line.length + 1;
        const newline = masked.indexOf("\n", sourceAt + line.length);
        positions[contentOffset - 1] = newline < 0 ? to : newline;
        cursor = newline < 0 ? to : newline + 1;
      }
      token.children = [];
      md.inline.parse(
        token.content,
        md,
        { inlineOffset: from, raw: markdown.slice(from, to), positions },
        token.children,
      );
    }
  });
  const tokens = md.parse(masked, {});
  for (const token of tokens) {
    if (token.type === "fence" && token.map) {
      const contentLines = token.content.match(/\n/gu)?.length ?? (token.content ? 1 : 0);
      if (token.map[1] - token.map[0] < contentLines + 2) {
        const from = offset(token.map[0]);
        issue(
          from,
          offset(token.map[0] + 1),
          "Unclosed code block; check the remaining script before automatic use.",
        );
      }
    }
  }
  issues.sort((a, b) => a.from - b.from);
  const passages: ScriptPassage[] = [];
  const section: { level: number; text: string }[] = [];
  let heading = 0;
  for (const token of tokens) {
    if (token.type === "heading_open") heading = Number(token.tag.slice(1));
    if (token.type === "heading_close") heading = 0;
    if (token.type !== "inline") continue;
    // Image children/alt text, link destinations and markup tokens contribute
    // nothing. Inline code is literal. Lists/quotes are already structural.
    const text = (token.children ?? [])
      .map((child) => {
        if (child.type === "text" || child.type === "code_inline") return child.content;
        if (child.type === "softbreak" || child.type === "hardbreak") return " ";
        return "";
      })
      .join("")
      .trim();
    if (heading) {
      while (section.length && section.at(-1)!.level >= heading) section.pop();
      section.push({ level: heading, text });
      continue;
    }
    if (!text) continue;
    const from = offset(token.map?.[0] ?? 0),
      to = offset(token.map?.[1] ?? 0);
    passages.push({
      from,
      to,
      text,
      section: section.map((s) => s.text),
      ambiguous: issues.some((i) => i.from < to && i.to > from),
    });
  }
  if (!passages.length)
    throw new Error(
      "No spoken text found. Import Markdown containing spoken paragraphs, not only headings, cues, or code.",
    );
  return { passages, issues };
}

export async function scriptHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new globalThis.TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
