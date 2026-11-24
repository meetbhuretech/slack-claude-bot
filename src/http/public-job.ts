import type { Job } from "../types.js";
import { availableActions, badgeFor, stepFor } from "../workflow/status.js";

export interface PublicJob {
  id: string;
  phase: Job["phase"];
  requestText: string;
  understood: string;
  planSummary: string;
  implementationSummary: string;
  testSummary: string;
  deployUrl: string;
  errorPlain: string;
  progress: string;
  outcome: Job["outcome"] | null;
  transcript: Job["transcript"];
  step: { index: number; total: 5; label: string };
  actions: ReturnType<typeof availableActions>;
  badge: ReturnType<typeof badgeFor>;
  createdAt: string;
  updatedAt: string;
}

export function toPublicJob(job: Job): PublicJob {
  return {
    id: job.id,
    phase: job.phase,
    requestText: job.requestText,
    understood: job.understood,
    planSummary: job.planSummary,
    implementationSummary: job.implementationSummary,
    testSummary: job.testSummary,
    deployUrl: job.deployUrl,
    errorPlain: job.errorPlain,
    progress: job.progress,
    outcome: job.outcome ?? null,
    transcript: job.transcript,
    step: stepFor(job.phase),
    actions: availableActions(job),
    badge: badgeFor(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
