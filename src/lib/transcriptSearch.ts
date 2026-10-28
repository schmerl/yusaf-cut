import type { Project } from "./edl";
import { projectTranscript } from "./transcript";
import type { TextRange } from "./transcriptEdits";

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}
export interface TranscriptMatch extends TextRange {
  /** Full paragraph context; offsets use JavaScript/ProseMirror UTF-16 units. */
  context: string;
}

/** Literal, nonoverlapping matches within projected paragraphs in output order.
 * Whole-word boundaries use Unicode letters, marks, numbers and connector
 * punctuation. No normalization or locale expansion changes display offsets.
 */
export function findTranscriptMatches(
  project: Project,
  query: string,
  options: SearchOptions = {},
): TranscriptMatch[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, options.caseSensitive ? "gu" : "giu");
  const word = /[\p{L}\p{M}\p{N}\p{Pc}]/u;
  return projectTranscript(project).flatMap((block) => {
    const matches: TranscriptMatch[] = [];
    for (const match of block.text.matchAll(pattern)) {
      const from = match.index!,
        to = from + match[0].length;
      // Array.from respects astral code points on both sides of the match.
      if (
        options.wholeWord !== false &&
        (word.test(Array.from(block.text.slice(0, from)).at(-1) ?? "") ||
          word.test(Array.from(block.text.slice(to))[0] ?? ""))
      )
        continue;
      matches.push({
        segmentId: block.segmentId,
        blockId: block.id,
        from,
        to,
        context: block.text,
      });
    }
    return matches;
  });
}

/** Light token context around exact matches; never changes replacement offsets.
 * This follows displayed Unicode words rather than possibly multiword timing groups.
 */
export function transcriptMatchContexts(text: string, matches: Pick<TextRange, "from" | "to">[]) {
  const tokens = Array.from(text.matchAll(/[\p{L}\p{M}\p{N}\p{Pc}]+/gu), (token) => ({
    from: token.index!,
    to: token.index! + token[0].length,
  }));
  const ranges = matches
    .map((match) => {
      const overlapping = tokens.filter((token) => token.to > match.from && token.from < match.to);
      return {
        from: Math.min(match.from, overlapping[0]?.from ?? match.from),
        to: Math.max(match.to, overlapping.at(-1)?.to ?? match.to),
      };
    })
    .sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}
