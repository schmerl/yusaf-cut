import type { ScriptPassage } from "./scriptMarkdown";
import type { ProjectedBlock } from "./transcript";

interface TokenRange {
  from: number;
  to: number;
}
export interface MatchingPassage extends ScriptPassage {
  tokenBase: number;
  paragraphStarts: number[];
  paragraphEnds: number[];
}
export interface MatchingBlock extends ProjectedBlock {
  rangeFrom: number;
  rangeTo: number;
}

/** Paragraph and slide breaks rarely coincide with recognition paragraphs.
 * Match overlapping, bounded windows of spoken text, excluding headings.
 */
export function matchingPassages(
  passages: ScriptPassage[],
  tokenize: (text: string) => TokenRange[],
): MatchingPassage[] {
  const sections = passages.length ? [passages] : [];
  return sections.flatMap((section) => {
    let text = "";
    const pieces = section.map((passage) => {
      if (text) text += " ";
      const from = text.length;
      text += passage.text;
      return { passage, from, to: text.length };
    });
    const tokens = tokenize(text);
    const result: MatchingPassage[] = [];
    for (let base = 0; base < tokens.length; base += 300) {
      const end = Math.min(tokens.length, base + 600);
      const from = base ? tokens[base]!.from : 0;
      const to = end === tokens.length ? text.length : tokens[end]!.from;
      const touched = pieces.filter((piece) => piece.from < to && piece.to > from);
      result.push({
        ...touched[0]!.passage,
        from: touched[0]!.passage.from,
        to: touched.at(-1)!.passage.to,
        text: text.slice(from, to),
        tokenBase: base,
        paragraphStarts: touched.map((piece) => piece.from - from).filter((at) => at >= 0),
        paragraphEnds: touched.map((piece) => piece.to - from).filter((at) => at <= to - from),
        inlineCode: touched.flatMap((piece) =>
          piece.passage.inlineCode
            .map((span) => ({
              from: span.from + piece.from - from,
              to: span.to + piece.from - from,
            }))
            .filter((span) => span.from >= 0 && span.to <= to - from),
        ),
        ambiguous: touched.some((piece) => piece.passage.ambiguous),
      });
      if (end === tokens.length) break;
    }
    return result;
  });
}

/** Long recognition paragraphs get bounded batches without splitting a timed
 * word/replacement or changing its block-local UTF-16 offsets.
 */
export function matchingBlocks(
  blocks: ProjectedBlock[],
  tokenize: (text: string) => TokenRange[],
): MatchingBlock[] {
  return blocks.flatMap((block) => {
    const result: MatchingBlock[] = [];
    let runs: typeof block.runs = [],
      count = 0;
    const flush = () => {
      if (runs.length)
        result.push({ ...block, runs, rangeFrom: runs[0]!.from, rangeTo: runs.at(-1)!.to });
      runs = [];
      count = 0;
    };
    for (const run of block.runs) {
      const length = tokenize(run.text).length;
      if (count + length > 240 && runs.length) flush();
      runs.push(run);
      count += length;
    }
    flush();
    return result;
  });
}
