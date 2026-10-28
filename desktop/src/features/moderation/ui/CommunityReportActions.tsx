import { useEffect, useRef, useState } from "react";
import type {
  ModerationReport,
  ResolutionAction,
} from "@/shared/api/moderation";
import type { ModerationScope } from "@/shared/api/moderationScope";
import type { RelayEvent } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import {
  applyReportDecision,
  type ReportActionResult,
  type ReportDecision,
} from "../lib/reportActions";

type Props = {
  report: ModerationReport;
  source: RelayEvent | null;
  scope: ModerationScope;
  onInvalidate: () => void;
  onReviewBlockedChange?: (blocked: boolean) => void;
  onComplete: (action: ResolutionAction) => void;
};

export function CommunityReportActions({
  report,
  source,
  scope,
  onInvalidate,
  onReviewBlockedChange,
  onComplete,
}: Props) {
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [result, setResult] = useState<ReportActionResult | null>(null);
  const hasAuthor = report.targetKind === "pubkey" || !!source;
  const canUseChannel =
    report.targetKind === "event" &&
    !!source &&
    !!report.channelId &&
    source.tags.some((tag) => tag[0] === "h" && tag[1] === report.channelId);
  const locked =
    result?.stage === "complete" ||
    result?.stage === "enforcement" ||
    result?.stage === "decision" ||
    (result?.stage === "validation" && result.enforced);
  useEffect(() => {
    onReviewBlockedChange?.(busy || !!locked);
  }, [busy, locked, onReviewBlockedChange]);
  const retry =
    result &&
    result.stage !== "complete" &&
    (result.stage === "decision" || result.enforced)
      ? result.decision
      : null;
  async function submit(decision: ReportDecision, decisionOnly = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onReviewBlockedChange?.(true);
    onInvalidate();
    const next = await applyReportDecision(
      report,
      decision,
      scope,
      decisionOnly,
    );
    if (scope.isCurrent()) {
      setResult(next);
      if (next.stage === "complete") onComplete(decision.action);
      setBusy(false);
    }
    busyRef.current = false;
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
          disabled={busy || !!locked}
          maxLength={2000}
        />
      </label>
      <p className="text-muted-foreground">
        Write this yourself. It may appear in a reporter notice or public
        message removal notice. Do not include private report notes.
      </p>
      {!locked && report.status === "open" ? (
        <>
          {hasAuthor ? (
            <label className="block space-x-2">
              <span>Timeout duration</span>
              <select
                aria-label="Timeout duration"
                className="rounded border bg-background p-2 text-sm"
                value={minutes}
                disabled={busy}
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
              disabled={busy || !reason.trim()}
              onClick={() => choose("dismiss")}
            >
              Dismiss
            </Button>
            <Button
              disabled={busy || !reason.trim()}
              onClick={() => choose("escalate")}
            >
              Escalate
            </Button>
            {hasAuthor ? (
              <>
                <Button
                  variant="destructive"
                  disabled={busy || !reason.trim()}
                  onClick={() => choose("ban")}
                >
                  Ban member
                </Button>
                <Button
                  disabled={busy || !reason.trim()}
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
                  disabled={busy || !reason.trim()}
                  onClick={() => choose("delete")}
                >
                  Delete message
                </Button>
                <Button
                  disabled={busy || !reason.trim()}
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
            <Button disabled={busy} onClick={() => void submit(retry, true)}>
              Retry decision only
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
