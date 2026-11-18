import { expect, it } from "vitest";
import { waveformPath } from "@/components/Waveform/AudioWaveform";
import type { Project } from "@/lib/edl";
import fixture from "./fixtures/transcript-corrections.json";

it("maps peaks through cuts, repeated placements, and wordless audio", () => {
  const project = {
    ...fixture,
    segments: [
      { id: "cut", mediaId: "m1", sourceIn: 1, sourceOut: 2, words: [] },
      { id: "repeat", mediaId: "m1", sourceIn: 1, sourceOut: 2, words: [] },
      { id: "silence", mediaId: "m1", sourceIn: 2, sourceOut: 3, words: [] },
    ],
  } as Project;
  const source = [...Array(50).fill(0), ...Array(50).fill(1), ...Array(50).fill(0)];
  const path = waveformPath(project, { m1: source }, 0, 300, 100);
  expect(path).toContain("M0.0,2.0v46.0");
  expect(path).toContain("M100.0,2.0v46.0");
  expect(path).toContain("M200.0,24.5v1.0");
  expect(waveformPath(project, { m1: source }, 100, 104, 100)).toBe("M0.0,2.0v46.0M2.0,2.0v46.0");
});
