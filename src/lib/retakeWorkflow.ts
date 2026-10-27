import type { Project } from "./edl";
import { analyzeRetakeWindows, type RetakeWindowResult } from "./retakeIpc";
import {
  groupRetakes,
  lexicalRetakes,
  retakeRecords,
  retakeWindows,
  semanticHypotheses,
  validateRetakeGroups,
  type RetakeCandidate,
  type RetakeWindow,
} from "./retakes";
import { planRetakeCut, rebaseRetake, type RetakeCutPlan } from "./retakeCuts";

export async function detectRetakes(
  project: Project,
  signal: AbortSignal,
  progress?: (value: number) => void,
  analyze: (
    windows: RetakeWindow[],
    signal: AbortSignal,
    progress?: (value: number) => void,
  ) => Promise<RetakeWindowResult[]> = analyzeRetakeWindows,
) {
  signal.throwIfAborted();
  const records = retakeRecords(project);
  if (!records.length) throw new Error("Transcribe the project before finding retakes.");
  const windows = retakeWindows(records);
  const lexical = windows.flatMap(lexicalRetakes);
  const semanticWindows = windows.filter((w) => semanticHypotheses(w).length > 0);
  const results = semanticWindows.length ? await analyze(semanticWindows, signal, progress) : [];
  signal.throwIfAborted();
  if (
    results.length !== semanticWindows.length ||
    new Set(results.map((r) => r.id)).size !== results.length
  )
    throw new Error("Incomplete retake analysis. Run detection again.");
  const semantic = results.flatMap((result) => {
    const window = semanticWindows.find((w) => w.id === result.id);
    if (!window) throw new Error("Unexpected retake analysis response.");
    const proposals = semanticHypotheses(window);
    for (const group of result.groups) {
      const signature = (g: typeof group) =>
        JSON.stringify({
          kind: g.kind,
          attempts: g.attempts.map(({ start, end }) => ({ start, end })),
          markers: g.markers,
        });
      if (!proposals.some((p) => signature(p) === signature(group)))
        throw new Error("The model changed proposed speech spans.");
    }
    return validateRetakeGroups(window, result.groups);
  });
  return groupRetakes(records, [...lexical, ...semantic]);
}

/** Ephemeral queue. Only a known acceptance transaction may rebase its revision. */
export class RetakeReviewRun {
  invalidated = false;
  accepted = 0;
  dismissed = 0;
  candidates: RetakeCandidate[];
  expected: Project;
  constructor(
    project: Project,
    readonly session: number,
    candidates: RetakeCandidate[],
  ) {
    this.expected = project;
    this.candidates = [...candidates];
  }
  check(project: Project, session: number) {
    if (project !== this.expected || session !== this.session) this.invalidated = true;
    if (this.invalidated) throw new Error("The project changed. Run retake detection again.");
  }
  plan(candidate: RetakeCandidate, takeId: string, project: Project, session: number) {
    this.check(project, session);
    if (!this.candidates.includes(candidate))
      throw new Error("This candidate was already resolved.");
    return planRetakeCut(project, candidate, takeId);
  }
  dismiss(candidate: RetakeCandidate) {
    if (!this.candidates.includes(candidate)) return;
    this.candidates = this.candidates.filter((c) => c !== candidate);
    this.dismissed++;
  }
  accept(
    candidate: RetakeCandidate,
    plan: RetakeCutPlan,
    project: Project,
    session: number,
    commit: (next: Project, expected: Project) => void,
  ) {
    this.check(project, session);
    if (!this.candidates.includes(candidate) || plan.before !== project)
      throw new Error("This cut is stale. Preview it again.");
    const next = this.candidates
      .filter((c) => c !== candidate)
      .map((c) => rebaseRetake(c, plan))
      .filter((c): c is RetakeCandidate => c !== null);
    // Advance before the synchronous store notification from our own commit.
    this.expected = plan.nextProject;
    try {
      commit(plan.nextProject, project);
    } catch (error) {
      this.expected = project;
      throw error;
    }
    this.candidates = next;
    this.accepted++;
  }
}
