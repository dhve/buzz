import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ModerationReport,
  ResolutionAction,
} from "@/shared/api/moderation";
import type { ModerationScope } from "@/shared/api/moderationScope";
import {
  applyReportDecision,
  type ReportActionResult,
  type ReportDecision,
} from "./lib/reportActions";

import type { ReportInspection } from "./lib/reportInspection";

export type ReportActionAttempt = {
  token: string;
  decision: ReportDecision;
  decisionOnly: boolean;
  pending: boolean;
  result: ReportActionResult | null;
};

export function isReportAttemptLocked(attempt: ReportActionAttempt | null) {
  const result = attempt?.result;
  return (
    !!attempt?.decisionOnly ||
    result?.stage === "complete" ||
    result?.stage === "enforcement" ||
    result?.stage === "decision" ||
    !!result?.enforced
  );
}

export function canRetryReportDecision(attempt: ReportActionAttempt | null) {
  const result = attempt?.result;
  return (
    !!result &&
    result.stage !== "complete" &&
    (attempt?.decisionOnly || result.stage === "decision" || result.enforced)
  );
}

/**
 * Human attempts live in the community QueryClient, not the selected child.
 * Retain this narrow cache for that client's session, including while Settings
 * is hidden. The community provider owns its lifetime. No source or AI result
 * is stored here, and all keys include the captured relay, signer and report.
 */
export function useReportActionAttempt(
  report: ModerationReport | null,
  scope: ModerationScope | undefined,
  onInvalidate: () => void,
  onComplete: (reportEventId: string, action: ResolutionAction) => void,
  inspection?: ReportInspection,
  inspectionIsCurrent?: () => boolean,
) {
  const queryClient = useQueryClient();
  const queryKey = [
    "communityReportAttempt",
    scope?.relayUrl,
    scope?.signerPubkey,
    report?.reportEventId,
  ] as const;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { data: attempt } = useQuery<ReportActionAttempt | null>({
    queryKey,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  async function submit(decision: ReportDecision, decisionOnly = false) {
    if (!report || !scope?.isCurrent()) return;
    const previous =
      queryClient.getQueryData<ReportActionAttempt | null>(queryKey) ?? null;
    // Read synchronously before the first await. Reopening or double-clicking
    // cannot start another operation before React observes the pending state.
    if (
      previous?.pending ||
      (decisionOnly
        ? !canRetryReportDecision(previous)
        : isReportAttemptLocked(previous))
    )
      return;
    const captured = decisionOnly && previous ? previous.decision : decision;
    const token = crypto.randomUUID();
    const pending: ReportActionAttempt = {
      token,
      decision: captured,
      decisionOnly,
      pending: true,
      result: previous?.result ?? null,
    };
    queryClient.setQueryData(queryKey, pending);
    onInvalidate();
    const result = await applyReportDecision(
      report,
      captured,
      scope,
      decisionOnly,
      inspection,
      inspectionIsCurrent,
    );
    if (
      queryClient.getQueryData<ReportActionAttempt>(queryKey)?.token !== token
    )
      return;
    // Preserve a known/uncertain outcome even after the panel unmounts. The
    // captured key cannot update a different community, signer or report.
    queryClient.setQueryData(queryKey, { ...pending, pending: false, result });
    if (result.stage !== "complete") return;
    void queryClient.invalidateQueries({
      queryKey: ["communityReports", scope.relayUrl, scope.signerPubkey],
    });
    void queryClient.invalidateQueries({
      queryKey: ["moderationRestrictions"],
    });
    if (mounted.current && scope.isCurrent())
      onComplete(report.reportEventId, captured.action);
  }

  return { attempt: attempt ?? null, submit };
}
