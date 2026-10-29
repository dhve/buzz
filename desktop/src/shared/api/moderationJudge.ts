import { z } from "zod";
import { invokeTauri, TauriInvokeError } from "@/shared/api/tauri";

export type JudgeRule = { id: string; text: string };
export type JudgePolicy =
  | { kind: "builtin_v1" }
  | { kind: "review_override"; rules: JudgeRule[] };
export type JudgeRequest = {
  reportEventId: string;
  modelId: string;
  requestId: string;
  policy: JudgePolicy;
  expectedRelayUrl?: string;
  expectedSignerPubkey?: string;
};
export type JudgeErrorCode =
  | "unsupported"
  | "unavailable"
  | "timeout"
  | "invalid_response"
  | "cancelled"
  | "stale"
  | "busy"
  | "inaccessible"
  | "invalid_request";
const errorCodes = new Set<JudgeErrorCode>([
  "unsupported",
  "unavailable",
  "timeout",
  "invalid_response",
  "cancelled",
  "stale",
  "busy",
  "inaccessible",
  "invalid_request",
]);
export function judgeErrorCode(error: unknown): JudgeErrorCode {
  const payload = error instanceof TauriInvokeError ? error.payload : error;
  if (
    payload &&
    typeof payload === "object" &&
    "code" in payload &&
    typeof payload.code === "string" &&
    errorCodes.has(payload.code as JudgeErrorCode)
  ) {
    return payload.code as JudgeErrorCode;
  }
  return "unavailable";
}
const text = (max: number) => z.string().min(1).max(max);
// Match Rust's Unicode scalar bounds; lone UTF-16 surrogates are not scalars.
const scalarText = (max: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        Array.from(value).length <= max && !/[\uD800-\uDFFF]/u.test(value),
    );
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const resultSchema = z
  .object({
    verdict: z.enum(["needs_review", "no_match", "uncertain"]),
    matches: z
      .array(
        z
          .object({
            rule_id: text(64),
            evidence: scalarText(128),
            reason: scalarText(256),
          })
          .strict(),
      )
      .max(3),
    uncertainty: scalarText(256).nullable(),
    provenance: z
      .object({
        sourceDigest: digest,
        policyDigest: digest,
        policySource: z.enum(["builtin_template", "review_override"]),
        policyVersion: z.string().nullable(),
        promptVersion: text(128),
        requestGeneration: z.string().regex(/^[0-9]+$/),
        requestId: text(128),
        requestedModel: text(1024),
        reportedModel: z.string().nullable(),
        meshVersion: text(128),
        runtimeId: text(256),
        startedAtMs: z.number().nonnegative(),
        elapsedMs: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type JudgeResult = z.infer<typeof resultSchema>;
export type JudgeStatus = {
  available: boolean;
  reason: string | null;
  localModelIds: string[];
  activeRequestId: string | null;
  runtimeId: string | null;
};
export function validateJudgeResult(
  value: unknown,
  request: JudgeRequest,
  source: string,
  ruleIds: string[],
  runtimeId: string | null,
): JudgeResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw { code: "invalid_response" };
  const result = parsed.data;
  const provenance = result.provenance;
  if (
    provenance.requestId !== request.requestId ||
    provenance.requestedModel !== request.modelId ||
    provenance.runtimeId !== runtimeId ||
    provenance.policySource !==
      (request.policy.kind === "builtin_v1"
        ? "builtin_template"
        : "review_override")
  ) {
    throw { code: "stale" };
  }
  if (
    (result.verdict === "needs_review" && !result.matches.length) ||
    (result.verdict === "no_match" && result.matches.length > 0) ||
    (result.verdict === "uncertain" && !result.uncertainty) ||
    result.matches.some(
      (match) =>
        !ruleIds.includes(match.rule_id) || !source.includes(match.evidence),
    )
  ) {
    throw { code: "invalid_response" };
  }
  return result;
}
export function reviewModerationReport(
  request: JudgeRequest,
): Promise<unknown> {
  return invokeTauri("review_moderation_report", { request });
}
export function cancelModerationReview(requestId: string): Promise<void> {
  return invokeTauri("cancel_moderation_review", { requestId });
}
export function moderationJudgeStatus(): Promise<JudgeStatus> {
  return invokeTauri("moderation_judge_status");
}
