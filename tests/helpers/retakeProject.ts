import { newProject, type Project } from "@/lib/edl";
export function speech(text: string, step = 0.4): Project {
  const p = newProject("Retake fixture");
  return {
    ...p,
    media: {
      m: {
        id: "m",
        path: "/fixture.wav",
        duration: 200,
        fps: 30,
        width: 1,
        height: 1,
        audioSampleRate: 16000,
        sha256: "fixture",
      },
    },
    segments: [
      {
        id: "s",
        mediaId: "m",
        sourceIn: 0,
        sourceOut: 100,
        words: text.split(" ").map((text, i) => ({
          id: `w${i}`,
          text,
          start: i * step,
          end: i * step + 0.2,
          confidence: 1,
        })),
      },
    ],
  };
}
