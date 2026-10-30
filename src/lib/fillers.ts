/** Literal candidate policy. These matches describe words, not their linguistic role. */
export const VOCAL_FILLERS = [
  "um",
  "umm",
  "uh",
  "uhh",
  "ah",
  "ahh",
  "er",
  "err",
  "erm",
  "hm",
  "hmm",
] as const;
export const OPTIONAL_FILLERS = [
  "mm",
  "mhm",
  "like",
  "so",
  "right",
  "okay",
  "basically",
  "actually",
  "you know",
  "i mean",
  "sort of",
  "kind of",
  "literally",
  "honestly",
  "ok",
  "well",
  "anyway",
  "i guess",
  "you see",
] as const;

export interface FillerPolicy {
  optional: string[];
  custom: string[];
}
export const defaultFillerPolicy = (): FillerPolicy => ({ optional: [], custom: [] });
export interface LiteralToken {
  value: string;
  from: number;
  to: number;
}

/** Unicode words, preserving apostrophes/hyphens inside a token and UTF-16 offsets. */
export function fillerTokens(text: string): LiteralToken[] {
  return Array.from(text.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu), (m) => ({
    value: m[0].toLowerCase(),
    from: m.index,
    to: m.index + m[0].length,
  }));
}

export function normalizeFillerTerm(text: string): string {
  return fillerTokens(text)
    .map((t) => t.value)
    .join(" ");
}

export function normalizeFillerPolicy(policy: FillerPolicy): FillerPolicy {
  if (
    !Array.isArray(policy.optional) ||
    !Array.isArray(policy.custom) ||
    policy.optional.length > 100 ||
    policy.custom.length > 100
  )
    throw new Error("Choose at most 100 custom filler phrases.");
  const normalize = (terms: string[]) =>
    [
      ...new Set(
        terms.map((term) => {
          if (typeof term !== "string" || term.length > 200 || !term.trim())
            throw new Error("Filler phrases must contain 1–200 characters.");
          // Require words separated by whitespace, with optional surrounding punctuation.
          // No user input is compiled as a regular expression.
          const tokens = fillerTokens(term);
          const value = normalizeFillerTerm(term);
          if (
            !value ||
            tokens.length > 20 ||
            tokens.some(
              (token, i) => i > 0 && /\S/u.test(term.slice(tokens[i - 1]!.to, token.from)),
            ) ||
            /[^\p{L}\p{N}\s'’\-.,!?;:"()[\]{}]/u.test(term)
          )
            throw new Error("Enter literal filler words or phrases, not regular expressions.");
          return value;
        }),
      ),
    ].sort();
  const optional = normalize(policy.optional);
  if (optional.some((t) => !(OPTIONAL_FILLERS as readonly string[]).includes(t)))
    throw new Error("Unknown optional filler phrase.");
  return { optional, custom: normalize(policy.custom) };
}

export interface FillerMatch {
  rule: string;
  from: number;
  to: number;
  tokenFrom: number;
  tokenTo: number;
}

/** One block/run of uninterrupted text. Longest match wins; ties favor earlier text. */
export function matchFillers(text: string, policy = defaultFillerPolicy()): FillerMatch[] {
  const normalized = normalizeFillerPolicy(policy);
  const rules = [...new Set([...VOCAL_FILLERS, ...normalized.optional, ...normalized.custom])];
  const tokens = fillerTokens(text);
  const matches: FillerMatch[] = [];
  for (const rule of rules) {
    const parts = rule.split(" ");
    for (let i = 0; i + parts.length <= tokens.length; i++) {
      if (!parts.every((part, j) => tokens[i + j]!.value === part)) continue;
      const last = tokens[i + parts.length - 1]!;
      const first = tokens[i]!;
      // Phrases cannot bridge sentence punctuation or arbitrary intervening syntax.
      if (parts.length > 1 && /[^\p{L}\p{N}\s'’-]/u.test(text.slice(first.from, last.to))) continue;
      let from = first.from,
        to = last.to;
      if (text[from - 1] === "[" && text[to] === "]") {
        from--;
        to++;
      }
      matches.push({ rule, from, to, tokenFrom: i, tokenTo: i + parts.length });
    }
  }
  matches.sort(
    (a, b) =>
      b.tokenTo - b.tokenFrom - (a.tokenTo - a.tokenFrom) ||
      a.from - b.from ||
      a.rule.localeCompare(b.rule),
  );
  const accepted: FillerMatch[] = [];
  for (const match of matches)
    if (!accepted.some((m) => m.from < match.to && m.to > match.from)) accepted.push(match);
  return accepted.sort((a, b) => a.from - b.from);
}
