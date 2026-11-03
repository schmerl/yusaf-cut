import { describe, expect, it } from "vitest";
import { parseScript } from "@/lib/scriptMarkdown";

const text = (markdown: string) =>
  parseScript(markdown)
    .passages.map((p) => p.text)
    .join("\n");
describe("spoken Markdown extraction", () => {
  it("uses ATX and Setext headings as context only", () => {
    const parsed = parseScript("# Title\n\nOpening.\n\nSection\n-------\n\nSpoken body.\n");
    expect(parsed.passages.map((p) => [p.text, p.section])).toEqual([
      ["Opening.", ["Title"]],
      ["Spoken body.", ["Title", "Section"]],
    ]);
  });
  it("retains prose immediately after a cue", () => {
    expect(text("<press> Let's look at QUERY now.")).toBe("Let's look at QUERY now.");
  });
  it("extracts lists, quotes, emphasis and visible link labels", () => {
    expect(text("- **GET** a [payment](https://example.com/secret).\n\n> _Listen_ here.")).toBe(
      "GET a payment.\nListen here.",
    );
  });
  it("never includes images or autolinks", () => {
    expect(
      text("Before ![unspoken alt](https://example.com/image.png) <https://example.com> after."),
    ).toBe("Before   after.");
  });
  it("preserves inline code, escaped brackets and Unicode", () => {
    expect(text("Use `GET /payments/P456` and `<T>` or \\<T\\> for café 👋.")).toBe(
      "Use GET /payments/P456 and <T> or <T> for café 👋.",
    );
  });
  it("excludes fenced and indented code", () => {
    expect(text("Spoken.\n\n```ts\nunspoken <bad\n```\n\n    unspoken too\n\nAfter.")).toBe(
      "Spoken.\nAfter.",
    );
  });
  it("excludes comments spanning paragraphs and keeps trailing speech", () => {
    expect(text("Before <!-- ignore\n\nignore --> after.\n\nEnd.")).toBe("Before\nafter.\nEnd.");
  });
  it("does not let a fence inside a comment expose later commented-out speech", () => {
    expect(
      text(
        "Before. <!--\n```\nnot a real fence\n-->\n\nAfter.\n\n<!-- secret\n\nmore secret --> End.",
      ),
    ).toBe("Before.\nAfter.\nEnd.");
  });
  it("parses code and escapes before comments/cues", () => {
    expect(text("`<!-- literal -->` and \\<press\\> and ``code ` <T>``.")).toBe(
      "<!-- literal --> and <press> and code ` <T>.",
    );
  });
  it("reports unclosed cues without discarding later lines", () => {
    const source = "👋 first.\n\n<bad cue\nLater spoken.\n\nLast paragraph.";
    const result = parseScript(source);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ from: source.indexOf("<bad"), line: 3 });
    expect(result.passages.some((p) => p.text.includes("Later spoken."))).toBe(true);
    expect(result.passages.some((p) => p.text === "Last paragraph." && !p.ambiguous)).toBe(true);
    expect(result.passages.find((p) => p.text.includes("Later spoken."))!.ambiguous).toBe(true);
  });
  it("reports unclosed comments locally and retains later paragraphs", () => {
    const result = parseScript("Before. <!-- unclosed\n\nAfter.");
    expect(result.issues[0]!.line).toBe(1);
    expect(result.passages.map((p) => p.text)).toEqual(["Before.", "After."]);
    expect(result.passages[0]!.ambiguous).toBe(true);
  });
  it("retains exact UTF-16 source offsets with CRLF", () => {
    const source = "# 👋\r\n\r\n<press> Café `GET /α`\r\n";
    const passage = parseScript(source).passages[0]!;
    expect(passage.from).toBe(source.indexOf("<press>"));
    expect(source.slice(passage.from, passage.to)).toBe("<press> Café `GET /α`\r\n");
    expect(passage.text).toBe("Café GET /α");
  });
  it("rejects nonspoken, empty, oversized and binary scripts", () => {
    for (const source of [
      "",
      "# Only title\n\n<press>\n\n```\ncode\n```",
      "\0hello",
      "é".repeat(1024 * 1024 + 1),
    ])
      expect(() => parseScript(source)).toThrow();
  });
  it("flags unmatched inline code and preserves following paragraphs", () => {
    const result = parseScript("Use `broken.\n\nAfter.");
    expect(result.issues[0]!.message).toMatch(/inline code/);
    expect(result.passages[0]!.ambiguous).toBe(true);
    expect(result.passages[1]!.text).toBe("After.");
  });
  it("reports an unclosed fence and keeps source offsets for a later repeated cue", () => {
    const source =
      "<bad> spoken.\n\n> Earlier <bad> fine.\n> Later <bad\n\nBefore code.\n\n```\nunclosed code";
    const result = parseScript(source);
    expect(result.issues.find((issue) => issue.message.includes("cue"))!.from).toBe(
      source.indexOf("<bad\n"),
    );
    expect(result.issues.find((issue) => issue.message.includes("code block"))!.line).toBe(8);
    expect(result.passages.some((p) => p.text === "Before code.")).toBe(true);
  });
});
