import { create } from "zustand";
import { totalDuration, type Project } from "@/lib/edl";
import { projectSession, useProjectStore } from "./projectStore";
import { useUIStore } from "./uiStore";
import { usePlayerStore } from "./playerStore";

export interface FillerAuditionRequest {
  token: number;
  session: number;
  expected: Project;
  occurrenceId: string;
  timeline: Project;
  mode: "before" | "preview" | "result";
  start: number;
  end: number;
  loop: boolean;
}
interface AuditionState {
  request: FillerAuditionRequest | null;
  message: string;
  stop: (message?: string) => void;
}
export const useFillerAuditionStore = create<AuditionState>((set) => ({
  request: null,
  message: "",
  stop: (message = "") => set({ request: null, message }),
}));
let token = 0;
export function startFillerAudition(
  args: Omit<FillerAuditionRequest, "token" | "session" | "start" | "end"> & {
    from: number;
    to: number;
    before: number;
    after: number;
  },
) {
  if (useUIStore.getState().isProcessingEdit)
    throw new Error("Wait for the timeline update to finish before listening.");
  if (useProjectStore.getState().project !== args.expected)
    throw new Error("The project changed. Select the occurrence again.");
  if (
    ![args.from, args.to, args.before, args.after].every(Number.isFinite) ||
    args.before < 0 ||
    args.after < 0
  )
    throw new Error("Enter nonnegative context in seconds.");
  const start = Math.max(0, args.from - args.before);
  const end = Math.min(totalDuration(args.timeline), args.to + args.after);
  if (end <= start)
    throw new Error(
      "No surviving media in this playback window. Increase the surrounding context.",
    );
  window.dispatchEvent(new CustomEvent("yusafcut:pause"));
  usePlayerStore.getState().setPlaying(false);
  useFillerAuditionStore.setState({
    request: { ...args, token: ++token, session: projectSession(), start, end },
    message: "",
  });
}
useProjectStore.subscribe((state) => {
  const audition = useFillerAuditionStore.getState();
  if (
    audition.request &&
    (audition.request.expected !== state.project || audition.request.session !== projectSession())
  )
    audition.stop("Playback stopped because the project changed.");
});
