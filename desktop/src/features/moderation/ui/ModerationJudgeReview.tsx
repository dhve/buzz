import { useId, useState } from "react";
import type { ModerationReport } from "@/shared/api/moderation";
import type { RelayEvent } from "@/shared/api/types";
import type { JudgePolicy } from "@/shared/api/moderationJudge";
import { useFeatureEnabled } from "@/shared/features";
import guidelines from "@/shared/moderation/defaultGuidelines.json";
import { useModerationJudge, type JudgeScope } from "./useModerationJudge";

export type ModerationJudgeReviewProps = {
  report: ModerationReport;
  scope: JudgeScope;
  source: RelayEvent | null;
  /** Observed authorization, channel privacy, source and runtime context. */
  contextKey: string;
  eligible?: boolean;
  ineligibleReason?: string;
};
export function ModerationJudgeReview(props: ModerationJudgeReviewProps) {
  const enabled = useFeatureEnabled("moderation-judge");
  if (!enabled) return null;
  // Remounting clears temporary policy/model/result state and cancels the old lease.
  const key = JSON.stringify([
    props.report,
    props.source,
    props.scope.relayUrl,
    props.scope.signerPubkey,
    props.contextKey,
    props.eligible,
  ]);
  return <JudgeReviewSession key={key} {...props} />;
}
function JudgeReviewSession({
  report,
  scope,
  source,
  eligible = false,
  ineligibleReason,
}: ModerationJudgeReviewProps) {
  const id = useId();
  const [modelId, setModelId] = useState("");
  const [policyKind, setPolicyKind] = useState("");
  const [rules, setRules] = useState(() =>
    guidelines.rules.map((rule) => ({ ...rule })),
  );
  const effectiveRules =
    policyKind === "review_override" ? rules : guidelines.rules;
  const judge = useModerationJudge(
    scope,
    report.reportEventId,
    source?.content ?? "",
    guidelines.rules.map((rule) => rule.id),
  );
  const supportedSource =
    eligible &&
    report.status === "open" &&
    report.reportType !== "illegal" &&
    report.targetKind === "event" &&
    source?.kind === 9 &&
    source.id === report.target;
  const busy =
    judge.status?.activeRequestId &&
    judge.status.activeRequestId !== judge.activeRequestId;
  const policy: JudgePolicy | null =
    policyKind === "builtin_v1"
      ? { kind: "builtin_v1" }
      : policyKind === "review_override"
        ? { kind: "review_override", rules }
        : null;
  const canReview =
    supportedSource &&
    !!policy &&
    !!modelId &&
    judge.status?.available &&
    judge.status.localModelIds.includes(modelId) &&
    !judge.pending &&
    !busy &&
    (policy.kind !== "review_override" ||
      rules.every((rule) => rule.text.trim()));
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-lg border p-4"
      data-testid="moderation-judge-review"
    >
      <h3 id={`${id}-title`} className="font-medium">
        AI advisory review · Preview
      </h3>
      <p className="text-sm text-muted-foreground">
        AI suggestions can be wrong. You choose every decision and
        reporter-visible reason. Assessments and rule edits last only for this
        review.
      </p>
      {!supportedSource && (
        <p role="status">
          {ineligibleReason ??
            "AI review requires an open report and an accessible, unchanged kind 9 message in an open, non-DM channel."}
        </p>
      )}
      <label className="block text-sm" htmlFor={`${id}-policy`}>
        Review policy
      </label>
      <select
        id={`${id}-policy`}
        className="w-full rounded border bg-background p-2"
        value={policyKind}
        onChange={(event) => {
          judge.clear();
          setPolicyKind(event.target.value);
        }}
      >
        <option value="">Choose a policy explicitly</option>
        <option value="builtin_v1">
          Suggested Buzz template · {guidelines.version}
        </option>
        <option value="review_override">Edit a review-specific copy</option>
      </select>
      <p className="text-sm text-muted-foreground">
        This suggested template has not been adopted as community policy.
        Community rules remain authoritative. A report category alone does not
        establish a violation.
      </p>
      <details>
        <summary className="cursor-pointer text-sm">
          Suggested guidelines and fixed classification instructions
        </summary>
        <p className="whitespace-pre-wrap text-sm">{guidelines.instructions}</p>
        {effectiveRules.map((rule, index) => (
          <div key={rule.id} className="mt-3 space-y-1">
            <label
              className="block text-sm font-medium"
              htmlFor={`${id}-${rule.id}`}
            >
              {rule.id}
            </label>
            {policyKind === "review_override" ? (
              <textarea
                id={`${id}-${rule.id}`}
                value={rule.text}
                maxLength={8192}
                className="min-h-24 w-full rounded border bg-background p-2 text-sm"
                onChange={(event) => {
                  judge.clear();
                  setRules((previous) =>
                    previous.map((entry, position) =>
                      position === index
                        ? { ...entry, text: event.target.value }
                        : entry,
                    ),
                  );
                }}
              />
            ) : (
              <p className="whitespace-pre-wrap text-sm">{rule.text}</p>
            )}
          </div>
        ))}
      </details>
      <label className="block text-sm" htmlFor={`${id}-model`}>
        Local model
      </label>
      <select
        id={`${id}-model`}
        className="w-full rounded border bg-background p-2"
        value={modelId}
        onChange={(event) => {
          judge.clear();
          setModelId(event.target.value);
        }}
      >
        <option value="">Choose a locally served model</option>
        {judge.status?.localModelIds.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
      <p className="text-sm">
        Only the eligible canonical message text and selected guidelines are
        submitted through a verified local-only runtime. Reporter notes are
        excluded. No model is qualified as a moderation default.
      </p>
      <div role="status" aria-live="polite" className="text-sm">
        {judge.message ||
          (judge.statusError
            ? `AI capability unavailable (${judge.statusError}).`
            : !judge.status
              ? "Checking local AI capability…"
              : busy
                ? "Another AI review is active (busy)."
                : !judge.status.available
                  ? `AI capability unavailable (${judge.status.reason ?? "unavailable"}).`
                  : "Local AI capability available.")}
      </div>
      {judge.error && (
        <p role="alert" className="text-sm text-destructive">
          AI review failed ({judge.error}). Review manually or retry explicitly.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm disabled:opacity-50"
          disabled={!canReview}
          onClick={() => {
            if (canReview && policy) void judge.review(modelId, policy);
          }}
        >
          Review with AI
        </button>
        {judge.pending && (
          <button
            type="button"
            className="rounded border px-3 py-2 text-sm"
            onClick={() =>
              judge.clear(
                "AI review cancelled. Backend work may still be finishing.",
              )
            }
          >
            Cancel AI review
          </button>
        )}
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          onClick={() => {
            void judge.refreshStatus();
          }}
        >
          Refresh AI availability
        </button>
      </div>
      {judge.result && (
        <section className="space-y-3 border-t pt-3" aria-label="AI assessment">
          <h4 className="font-medium">
            AI suggestion: {judge.result.verdict.replaceAll("_", " ")}
          </h4>
          <p className="whitespace-pre-wrap break-words text-sm">
            Source: {source?.content}
          </p>
          {judge.result.matches.map((match) => (
            <div
              key={`${match.rule_id}:${match.evidence}:${match.reason}`}
              className="space-y-1 text-sm"
            >
              <p className="font-medium">{match.rule_id}</p>
              <p className="whitespace-pre-wrap">
                Rule:{" "}
                {effectiveRules.find((rule) => rule.id === match.rule_id)?.text}
              </p>
              <blockquote className="whitespace-pre-wrap border-l-2 pl-3">
                {match.evidence}
              </blockquote>
              <p className="whitespace-pre-wrap">{match.reason}</p>
            </div>
          ))}
          {judge.result.uncertainty && (
            <p className="whitespace-pre-wrap text-sm">
              Uncertainty: {judge.result.uncertainty}
            </p>
          )}
          <dl className="space-y-1 break-all text-xs text-muted-foreground">
            <dt>Selected policy</dt>
            <dd>
              {judge.result.provenance.policySource} ·{" "}
              {judge.result.provenance.policyVersion ?? "review-specific"}
            </dd>
            <dt>Policy digest</dt>
            <dd>{judge.result.provenance.policyDigest}</dd>
            <dt>Source digest</dt>
            <dd>{judge.result.provenance.sourceDigest}</dd>
            <dt>Requested model</dt>
            <dd>{judge.result.provenance.requestedModel}</dd>
            <dt>Provider-reported model (unverified)</dt>
            <dd>{judge.result.provenance.reportedModel ?? "unknown"}</dd>
            <dt>Runtime</dt>
            <dd>
              {judge.result.provenance.meshVersion} ·{" "}
              {judge.result.provenance.runtimeId}
            </dd>
            <dt>Prompt version</dt>
            <dd>{judge.result.provenance.promptVersion}</dd>
            <dt>Elapsed time</dt>
            <dd>{judge.result.provenance.elapsedMs} ms</dd>
          </dl>
        </section>
      )}
    </section>
  );
}
