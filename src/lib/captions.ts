/**
 * Build SRT and WebVTT caption strings from a Project, using output-time
 * (so deleted ranges and re-ordered segments are reflected exactly the way
 * they will play back in the exported video).
 *
 * Slide transitions and long silences delimit passages. Within each passage, choose balanced cues under the
 * duration/word limits, preferring sentence boundaries and avoiding short tails.
 * Edited runs remain indivisible: their anchors time the entire replacement,
 * rather than supplying invented timings for individual replacement words.
 */

import { type Project, type Word } from "./edl";
import { projectTranscript } from "./transcript";
import { captionSectionStarts } from "./captionSections";

const GAP_S = 2;
const MAX_CUE_S = 7;
const MAX_CUE_WORDS = 20;
const MAX_CUE_CHARS = 84;

export interface CaptionCue {
  /** 1-based index, matches the cue numbering in .srt. */
  index: number;
  /** Output-time start (seconds). */
  start: number;
  /** Output-time end (seconds). */
  end: number;
  /** Cleaned-up text, no leading/trailing whitespace. */
  text: string;
}

interface OutputWord {
  word: Word;
  separatorBefore: string;
  start: number; // output-time
  end: number;
}

/**
 * Walk the project's timeline in output order and emit every surviving word
 * with its output-time bounds. We intentionally do *not* dedupe identical
 * texts — captions need to match what's spoken, not what's unique.
 */
export function flattenWordsInOutputTime(project: Project): OutputWord[] {
  return projectTranscript(project).flatMap((block) => {
    let previousEnd = 0;
    return block.runs
      .filter((run) => run.text.trim())
      .map((run) => {
        const separatorBefore = previousEnd ? block.text.slice(previousEnd, run.from) : " ";
        previousEnd = run.to;
        return {
          word: {
            id: `${block.occurrenceId}:${run.id}`,
            text: run.text,
            start: run.sourceStart,
            end: run.sourceEnd,
            confidence: 1,
          },
          separatorBefore,
          start: run.outputStart,
          end: run.outputEnd,
        };
      });
  });
}

/** Group an output-time word list into reading-paced caption cues. */
export function buildCues(project: Project): CaptionCue[] {
  const words = flattenWordsInOutputTime(project);
  if (words.length === 0) return [];

  const slides = captionSectionStarts(project, words);
  const groups: OutputWord[][] = [];
  let passage: OutputWord[] = [];
  for (const [i, word] of words.entries()) {
    const previous = passage[passage.length - 1];
    if (previous && (slides.has(i) || word.start - previous.end >= GAP_S)) {
      groups.push(...balancePassage(passage));
      passage = [];
    }
    passage.push(word);
  }
  groups.push(...balancePassage(passage));
  return groups.map((group, i) => makeCue(i + 1, group));
}

/** Minimize fragmentation across a whole passage instead of greedily leaving
 * the last word of a sentence alone when a cue reaches its size limit. */
function balancePassage(words: OutputWord[]): OutputWord[][] {
  const costs = Array<number>(words.length + 1).fill(Infinity);
  const next = Array<number>(words.length).fill(0);
  costs[words.length] = 0;
  for (let from = words.length - 1; from >= 0; from--) {
    for (let to = from + 1; to <= words.length; to++) {
      const duration = words[to - 1]!.end - words[from]!.start;
      const text = cueText(words.slice(from, to));
      const count = text.split(/\s+/u).length;
      // A single edited timing group may exceed the limits. Export it intact.
      if (
        to > from + 1 &&
        (duration > MAX_CUE_S || count > MAX_CUE_WORDS || text.length > MAX_CUE_CHARS)
      )
        break;
      // Adjacent runs can spell one word (e.g. a manual removal of a space).
      if (to < words.length && !words[to]!.separatorBefore) continue;
      const sentenceEnd = /[.!?]["'”’)]*$/u.test(words[to - 1]!.word.text.trim());
      // Base cost favors fewer cues; squared spare capacity balances them.
      // Penalize single words and sub-1.2s flashes more than sentence splits.
      const cost =
        4 +
        Math.pow(Math.max(0, MAX_CUE_S - duration) / MAX_CUE_S, 2) +
        Math.pow(Math.max(0, MAX_CUE_WORDS - count) / MAX_CUE_WORDS, 2) +
        (count === 1 ? 25 : 0) +
        4 * Math.max(0, 1.2 - duration) +
        Math.max(0, text.length / 20 - duration) * 3 +
        (sentenceEnd ? 0 : 2) +
        // Ordinary pauses favor a boundary without forcing orphaned phrases.
        (to < words.length && words[to]!.start - words[to - 1]!.end >= 0.7 ? 0 : 1) +
        costs[to]!;
      if (cost < costs[from]!) {
        costs[from] = cost;
        next[from] = to;
      }
    }
    // A joined word can span several runs: never split it or drop its text,
    // even if that word alone exceeds a limit.
    if (!next[from]) {
      let to = from + 1;
      while (to < words.length && !words[to]!.separatorBefore) to++;
      next[from] = to;
      costs[from] = 35 + costs[to]!;
    }
  }
  const groups: OutputWord[][] = [];
  for (let from = 0; from < words.length; from = next[from]!) {
    groups.push(words.slice(from, next[from]!));
  }
  return groups;
}

function cueText(words: OutputWord[]): string {
  return words
    .map((w, i) => (i ? w.separatorBefore : "") + w.word.text)
    .join("")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function makeCue(index: number, words: OutputWord[]): CaptionCue {
  return {
    index,
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: wrapCaption(cueText(words)),
  };
}

/** Two balanced display lines, preferably at punctuation. Never strand a
 * single word on a line when a two-word alternative fits. */
function wrapCaption(text: string): string {
  if (text.length <= 42) return text;
  const words = text.split(" ");
  let best = text;
  let score = Infinity;
  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(" "),
      right = words.slice(i).join(" ");
    const cost =
      Math.abs(left.length - right.length) +
      10 * (Math.max(0, left.length - 42) + Math.max(0, right.length - 42)) +
      (i === 1 || i === words.length - 1 ? 50 : 0) +
      (/[.,!?;:]$/u.test(left) ? 0 : 4);
    if (cost < score) {
      score = cost;
      best = left + "\n" + right;
    }
  }
  return best;
}

/** Untimed YouTube transcript: only confident slide transitions insert blank
 * lines. Editor paragraphs, pauses and caption-size limits do not carry over. */
export function buildUntimedTranscript(project: Project): string {
  const words = flattenWordsInOutputTime(project);
  const slides = captionSectionStarts(project, words);
  const sections: string[] = [];
  let start = 0;
  for (let i = 1; i < words.length; i++) {
    if (!slides.has(i)) continue;
    sections.push(cueText(words.slice(start, i)));
    start = i;
  }
  if (words.length) sections.push(cueText(words.slice(start)));
  return sections.length ? sections.join("\n\n") + "\n" : "";
}

// ── Formatters ─────────────────────────────────────────────────────────────

/** SRT uses comma as the decimal separator: 00:00:01,234 */
export function formatSrtTimestamp(t: number): string {
  return formatHmsMs(t, ",");
}

/** WebVTT uses dot: 00:00:01.234 */
export function formatVttTimestamp(t: number): string {
  return formatHmsMs(t, ".");
}

function formatHmsMs(t: number, msSep: "," | "."): string {
  const clamped = Math.max(0, t);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSep}${pad(ms, 3)}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Serialise to a complete .srt string. */
export function buildSrt(project: Project): string {
  const cues = buildCues(project);
  if (cues.length === 0) return "";
  return cues
    .map(
      (c) =>
        `${c.index}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${c.text}\n`,
    )
    .join("\n");
}

/** Serialise to a complete .vtt string. */
export function buildVtt(project: Project): string {
  const cues = buildCues(project);
  const header = "WEBVTT\n\n";
  if (cues.length === 0) return header;
  return (
    header +
    cues
      .map((c) => `${formatVttTimestamp(c.start)} --> ${formatVttTimestamp(c.end)}\n${c.text}\n`)
      .join("\n")
  );
}
