import type { Project } from "./edl";
import { parseScript } from "./scriptMarkdown";

export interface CodeSpan {
  from: number;
  to: number;
  /** Add quotation marks unless the displayed text already has them. */
  quote: boolean;
  open?: boolean;
  close?: boolean;
}

/** Plain display/export representation; bold is supplied by the renderer. */
export function quoteCodeText(text: string, spans: CodeSpan[]): string {
  let result = "",
    from = 0;
  for (const span of spans) {
    result += text.slice(from, span.from);
    if (span.quote && span.open !== false) result += '"';
    result += text.slice(span.from, span.to);
    if (span.quote && span.close !== false) result += '"';
    from = span.to;
  }
  return result + text.slice(from);
}
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const wordCharacter = (value: string) => /[\p{L}\p{M}\p{N}_]/u.test(value);
function occurrences(text: string, term: string) {
  const pattern = new RegExp(escapePattern(term).replace(/\s+/gu, "\\s+"), "giu");
  return Array.from(text.matchAll(pattern)).filter((match) => {
    const at = match.index!,
      end = at + match[0].length;
    return (
      !(wordCharacter(term[0]!) && at > 0 && wordCharacter(text[at - 1]!)) &&
      !(wordCharacter(term.at(-1)!) && end < text.length && wordCharacter(text[end]!))
    );
  });
}
interface Context {
  before: string[];
  after: string[];
}
function context(text: string) {
  const tokens = Array.from(text.matchAll(/[\p{L}\p{M}\p{N}]+/gu), (match) => ({
    from: match.index!,
    to: match.index! + match[0].length,
    value: match[0].toLocaleLowerCase("en-US"),
  }));
  const count = (test: (token: (typeof tokens)[number]) => boolean) => {
    let low = 0,
      high = tokens.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (test(tokens[middle]!)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return (from: number, to: number): Context => {
    const before = count((token) => token.to <= from),
      after = count((token) => token.from < to);
    return {
      before: tokens.slice(Math.max(0, before - 4), before).map((t) => t.value),
      after: tokens.slice(after, after + 4).map((t) => t.value),
    };
  };
}
function score(a: Context, b: Context) {
  let result = 0;
  for (let i = 1; i <= Math.min(a.before.length, b.before.length); i++) {
    if (a.before.at(-i) !== b.before.at(-i)) break;
    result++;
  }
  for (let i = 0; i < Math.min(a.after.length, b.after.length); i++) {
    if (a.after[i] !== b.after[i]) break;
    result++;
  }
  return result;
}
const cache = new WeakMap<Project, { text: string; spans: CodeSpan[] }>();

/** Match literal code in CURRENT transcript text, including accepted corrections.
 * Mixed prose/code uses require a strictly better context match for code. No
 * markup is written into wording, so reconciliation and anchor offsets stay valid.
 */
export function scriptCodeSpans(project: Project, text: string): CodeSpan[] {
  const saved = cache.get(project);
  if (saved?.text === text) return saved.spans;
  const metadata = project.scriptAssistance;
  const script = metadata?.scripts.find((s) => s.revision === metadata.activeRevision);
  if (!script) return [];
  const passages = parseScript(script.markdown).passages;
  const terms = new Set(
    passages
      .filter((p) => !p.ambiguous)
      .flatMap((p) =>
        p.inlineCode.map((span) => p.text.slice(span.from, span.to).replace(/\s+/gu, " ").trim()),
      )
      .filter(Boolean),
  );
  const candidates: CodeSpan[] = [];
  const spokenContext = context(text);
  const scriptContexts = new Map(passages.map((passage) => [passage, context(passage.text)]));
  for (const term of terms) {
    const references = passages.flatMap((passage) =>
      occurrences(passage.text, term).map((match) => ({
        code:
          !passage.ambiguous &&
          passage.inlineCode.some(
            (span) => span.from <= match.index! && span.to >= match.index! + match[0].length,
          ),
        context: scriptContexts.get(passage)!(match.index!, match.index! + match[0].length),
      })),
    );
    for (const match of occurrences(text, term)) {
      let from = match.index!,
        to = from + match[0].length;
      const here = spokenContext(from, to);
      const codeScore = Math.max(
        -1,
        ...references.filter((r) => r.code).map((r) => score(here, r.context)),
      );
      const proseScore = Math.max(
        -1,
        ...references.filter((r) => !r.code).map((r) => score(here, r.context)),
      );
      if (codeScore <= proseScore) continue;
      let quote = !(text[from] === '"' && text[to - 1] === '"');
      if (text[from - 1] === '"' && text[to] === '"') {
        from--;
        to++;
        quote = false;
      }
      candidates.push({ from, to, quote });
    }
  }
  // Prefer a complete code phrase to a term embedded within it.
  const spans: CodeSpan[] = [];
  for (const candidate of candidates.sort((a, b) => b.to - b.from - (a.to - a.from)))
    if (!spans.some((span) => span.from < candidate.to && span.to > candidate.from))
      spans.push(candidate);
  spans.sort((a, b) => a.from - b.from);
  cache.set(project, { text, spans });
  return spans;
}
