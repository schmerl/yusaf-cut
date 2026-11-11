import { expect, it } from "vitest";
import type { Project } from "@/lib/edl";
import type { ReviewLog } from "@/lib/reviewLog";
import { appendReviewLog, validateReviewLog } from "@/lib/reviewLog";
import projectFixture from "./fixtures/script-assistance.json";
import logFixture from "./fixtures/review-log.json";
it("shares a bounded durable schema with native project persistence", () => {
  const p = structuredClone(projectFixture) as Project;
  p.reviewLog = structuredClone(logFixture) as ReviewLog;
  expect(() => validateReviewLog(p)).not.toThrow();
  expect(JSON.parse(JSON.stringify(p)).reviewLog).toEqual(logFixture);
});
it("appends an immutable audit entry without touching transcript or source ranges", () => {
  const p = structuredClone(projectFixture) as Project;
  const { id: _id, createdAt: _date, ...entry } = logFixture.entries[0]!;
  const next = appendReviewLog(p, entry as Parameters<typeof appendReviewLog>[1]);
  expect(next.segments).toBe(p.segments);
  expect(p.reviewLog).toBeUndefined();
  expect(next.reviewLog!.entries).toHaveLength(1);
});
it("rejects future versions, duplicate entries, invalid values and unbounded text", () => {
  for (const change of [
    (log: ReviewLog) => {
      log.version = 2 as 1;
    },
    (log: ReviewLog) => {
      log.entries.push(log.entries[0]!);
    },
    (log: ReviewLog) => {
      log.entries[0]!.sourceOut = NaN;
    },
    (log: ReviewLog) => {
      log.entries[0]!.afterText = "x".repeat(100001);
    },
  ]) {
    const p = structuredClone(projectFixture) as Project;
    p.reviewLog = structuredClone(logFixture) as ReviewLog;
    change(p.reviewLog);
    expect(() => validateReviewLog(p)).toThrow(/review log/);
  }
});
