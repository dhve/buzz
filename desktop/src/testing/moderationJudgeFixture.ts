import type { JudgeRequest } from "@/shared/api/moderationJudge";

/** Deterministic IPC boundary for browser tests, never a model-quality claim. */
export type ModerationJudgeFixture = {
  mode: "success" | "unsupported" | "delayed";
  delayMs?: number;
};
export function createModerationJudgeFixture() {
  let activeRequestId: string | null = null;
  return async (
    command: string,
    payload: unknown,
    fixture?: ModerationJudgeFixture,
  ) => {
    if (command === "moderation_judge_status")
      return {
        available: !!fixture && fixture.mode !== "unsupported",
        reason:
          !fixture || fixture.mode === "unsupported" ? "unsupported" : null,
        localModelIds:
          fixture && fixture.mode !== "unsupported"
            ? ["fixture-local-model"]
            : [],
        activeRequestId,
        runtimeId:
          fixture && fixture.mode !== "unsupported" ? "fixture-runtime" : null,
      };
    if (command === "cancel_moderation_review") {
      const { requestId } = payload as { requestId: string };
      if (activeRequestId === requestId) activeRequestId = null;
      return;
    }
    if (command !== "review_moderation_report")
      throw new Error("Unknown moderation fixture command");
    if (!fixture || fixture.mode === "unsupported")
      throw { code: "unsupported" };
    if (activeRequestId) throw { code: "busy" };
    const { request } = payload as { request: JudgeRequest };
    activeRequestId = request.requestId;
    if (fixture.delayMs)
      await new Promise((resolve) =>
        window.setTimeout(resolve, fixture.delayMs),
      );
    if (activeRequestId === request.requestId) activeRequestId = null;
    return {
      verdict: "no_match",
      matches: [],
      uncertainty: null,
      provenance: {
        sourceDigest: "1".repeat(64),
        policyDigest: "2".repeat(64),
        policySource:
          request.policy.kind === "builtin_v1"
            ? "builtin_template"
            : "review_override",
        policyVersion: "buzz-moderation-guidelines/v1",
        promptVersion: "buzz-moderation-judge/v1",
        requestGeneration: "1",
        requestId: request.requestId,
        runtimeId: "fixture-runtime",
        requestedModel: request.modelId,
        reportedModel: request.modelId,
        meshVersion: "browser-fixture",
        startedAtMs: 1,
        elapsedMs: 2,
      },
    };
  };
}
