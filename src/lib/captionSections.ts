import type { Project } from "./edl";
import { parseScript } from "./scriptMarkdown";

interface TimedText {
  word: { text: string };
  separatorBefore: string;
}
const tokens = (text: string): string[] =>
  Array.from(text.toLocaleLowerCase("en-US").matchAll(/[\p{L}\p{M}\p{N}]+/gu), (m) => m[0]);

function distance(a: string[], b: string[]): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + Number(a[i] !== b[j])));
    row = next;
  }
  return row[b.length]!;
}

/** Approximate spoken slide transitions, never visual frame detection. Match
 * distinctive section openers against CURRENT output text, across paragraphs
 * and cuts. No stored review mappings or source-time ordering are required. */
export function captionSectionStarts(project: Project, words: TimedText[]): Set<number> {
  const metadata = project.scriptAssistance;
  const script = metadata?.scripts.find((s) => s.revision === metadata.activeRevision);
  if (!script) return new Set();
  const passages = parseScript(script.markdown).passages;
  const sections: { from: number; text: string; ambiguous: boolean }[] = [];
  for (const passage of passages) {
    const last = sections.at(-1);
    if (last?.from === passage.sectionFrom) {
      last.text += " " + passage.text;
      last.ambiguous ||= passage.ambiguous;
    } else
      sections.push({
        from: passage.sectionFrom,
        text: passage.text,
        ambiguous: passage.ambiguous,
      });
  }
  const allScript = tokens(passages.map((p) => p.text).join(" ")).join(" ");
  const spoken: { value: string; word: number; first: boolean }[] = [];
  words.forEach((word, i) =>
    tokens(word.word.text).forEach((value, j) => spoken.push({ value, word: i, first: j === 0 })),
  );
  const values = spoken.map((t) => t.value);
  const matches = new Map<number, { section: number; cost: number }[]>();
  sections.forEach((section, sectionIndex) => {
    if (section.from < 0 || section.ambiguous) return;
    const prefix = tokens(section.text).slice(0, 12);
    if (prefix.length < 6) return;
    // Repeated openers (even inside another section) are not distinctive.
    const needle = " " + prefix.join(" ") + " ";
    const haystack = " " + allScript + " ";
    const at = haystack.indexOf(needle);
    if (at < 0 || haystack.indexOf(needle, at + 1) >= 0) return;
    const budget = Math.floor(prefix.length * 0.2);
    const candidates: { token: number; word: number; cost: number }[] = [];
    for (let i = 0; i < spoken.length; i++) {
      const token = spoken[i]!;
      // Never invent a timestamp inside a multi-anchor replacement or split
      // adjacent runs which the user joined into one word.
      if (!token.first || (token.word > 0 && !words[token.word]!.separatorBefore)) continue;
      if (token.value !== prefix[0]) continue;
      let cost = Infinity;
      for (let length = prefix.length - budget; length <= prefix.length + budget; length++) {
        if (i + length <= spoken.length)
          cost = Math.min(cost, distance(prefix, values.slice(i, i + length)));
      }
      if (cost <= budget) candidates.push({ token: i, word: token.word, cost });
    }
    // Near-duplicate matches around a restart are ambiguous; retain only a
    // strictly better alignment. Distinct reused takes can each have a break.
    for (const candidate of candidates) {
      if (
        candidates.some(
          (other) =>
            other !== candidate &&
            Math.abs(other.token - candidate.token) < prefix.length &&
            other.cost <= candidate.cost,
        )
      )
        continue;
      const entries = matches.get(candidate.word) ?? [];
      entries.push({ section: sectionIndex, cost: candidate.cost });
      matches.set(candidate.word, entries);
    }
  });
  const starts = Array.from(matches)
    .filter(([, entries]) => entries.length === 1)
    .map(([word]) => {
      // Ad-libbed lead-ins belong with the new slide, rather than becoming a
      // flashing one-word cue immediately before its matched opening speech.
      const previous = words[word - 1];
      return previous &&
        (word === 1 || previous.separatorBefore) &&
        /^(so|well|okay|ok|um|uh)[,.]?$/iu.test(previous.word.text.trim())
        ? word - 1
        : word;
    });
  return new Set(starts);
}
