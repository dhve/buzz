import { useEffect, useState } from "react";
import type {
  ModerationReport,
  ResolutionAction,
} from "@/shared/api/moderation";
import type { RelayEvent } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import type { ReportDecision } from "../lib/reportActions";
import {
  canRetryReportDecision,
  isReportAttemptLocked,
  type ReportActionAttempt,
} from "../useReportActionAttempt";

type Props = {
  report: ModerationReport;
  source: RelayEvent | null;
  attempt: ReportActionAttempt | null;
  available: boolean;
  onSubmit: (decision: ReportDecision, decisionOnly?: boolean) => Promise<void>;
  onReviewBlockedChange?: (blocked: boolean) => void;
};

export function CommunityReportActions({
  report,
  source,
  attempt,
  available,
  onSubmit,
  onReviewBlockedChange,
}: Props) {
  const [draftReason, setReason] = useState(
    () => attempt?.decision.reason ?? "",
  );
  const [minutes, setMinutes] = useState(60);
  const busy = !!attempt?.pending;
  const result = attempt?.result;
  const hasAuthor = report.targetKind === "pubkey" || !!source;
  const canUseChannel =
    report.targetKind === "event" &&
    !!source &&
    !!report.channelId &&
    source.tags.some((tag) => tag[0] === "h" && tag[1] === report.channelId);
  const locked = isReportAttemptLocked(attempt);
  const reason =
    busy || locked ? (attempt?.decision.reason ?? draftReason) : draftReason;
  useEffect(() => {
    onReviewBlockedChange?.(busy || locked || !available);
  }, [busy, locked, available, onReviewBlockedChange]);
  const retry = canRetryReportDecision(attempt) ? attempt?.decision : null;
  function submit(decision: ReportDecision, decisionOnly = false) {
    onReviewBlockedChange?.(true);
    void onSubmit(decision, decisionOnly);
  }
  const choose = (action: ResolutionAction) =>
    void submit({
      action,
      reason: reason.trim(),
      ...(action === "timeout"
        ? { expiresAt: Math.floor(Date.now() / 1000) + minutes * 60 }
        : {}),
    });
  return (
    <section
      aria-label="Human report decision"
      className="space-y-3 rounded-lg border p-4 text-sm"
    >
      <h3 className="font-semibold">Human decision</h3>
      <p>
        Enforcement runs before the decision is recorded. Escalation records a
        request for operator review.
      </p>
      <label className="block space-y-1">
        <span>Reporter-readable reason (required)</span>
        <textarea
          aria-label="Reporter-readable reason (required)"
          className="block min-h-24 w-full rounded-md border bg-background p-2 text-sm"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={busy || !!locked || !available}
          maxLength={2000}
        />
      </label>
      <p className="text-muted-foreground">
        Write this yourself. It may appear in a reporter notice or public
        message removal notice. Do not include private report notes.
      </p>
      {!available ? (
        <p role="status">
          The report could not be confirmed as open in this queue. Return to
          reports and refresh before another decision.
        </p>
      ) : null}
      {!locked && report.status === "open" ? (
        <>
          {hasAuthor ? (
            <label className="block space-x-2">
              <span>Timeout duration</span>
              <select
                aria-label="Timeout duration"
                className="rounded border bg-background p-2 text-sm"
                value={minutes}
                disabled={busy || !available}
                onChange={(event) => setMinutes(Number(event.target.value))}
              >
                <option value={60}>1 hour</option>
                <option value={1440}>24 hours</option>
                <option value={10080}>7 days</option>
              </select>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !reason.trim() || !available}
              onClick={() => choose("dismiss")}
            >
              Dismiss
            </Button>
            <Button
              disabled={busy || !reason.trim() || !available}
              onClick={() => choose("escalate")}
            >
              Escalate
            </Button>
            {hasAuthor ? (
              <>
                <Button
                  variant="destructive"
                  disabled={busy || !reason.trim() || !available}
                  onClick={() => choose("ban")}
                >
                  Ban member
                </Button>
                <Button
                  disabled={busy || !reason.trim() || !available}
                  onClick={() => choose("timeout")}
                >
                  Time out member
                </Button>
              </>
            ) : null}
            {canUseChannel ? (
              <>
                <Button
                  variant="destructive"
                  disabled={busy || !reason.trim() || !available}
                  onClick={() => choose("delete")}
                >
                  Delete message
                </Button>
                <Button
                  disabled={busy || !reason.trim() || !available}
                  onClick={() => choose("kick")}
                >
                  Kick from channel
                </Button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
      {busy ? (
        <p role="status">
          Checking current permissions and recording your choice…
        </p>
      ) : null}
      {result?.stage === "complete" ? (
        <p role="status">Decision recorded.</p>
      ) : result ? (
        <div role="alert" className="space-y-2">
          <p>
            {result.enforced
              ? "Enforcement succeeded; the decision is not confirmed."
              : result.stage === "enforcement"
                ? "Enforcement is not confirmed. The report was not resolved. Check the target state before taking any further enforcement action."
                : "No enforcement was sent."}{" "}
            {result.error}
          </p>
          {retry ? (
            <Button
              disabled={busy || !available}
              onClick={() => void submit(retry, true)}
            >
              Retry decision only
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
