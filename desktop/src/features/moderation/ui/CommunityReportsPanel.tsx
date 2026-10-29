import { useCallback, useRef, useState } from "react";
import { useMyRelayMembershipLookupQuery } from "@/features/community-members/hooks";
import { SettingsSectionHeader } from "@/features/settings/ui/SettingsSectionHeader";
import { canManageCommunityMembers } from "@/shared/api/relayMembers";
import type { ModerationReport } from "@/shared/api/moderation";
import { Button } from "@/shared/ui/button";
import {
  useCommunityReportsQuery,
  useModerationReportChannelQuery,
} from "../hooks";
import { channelInspectionKey } from "../lib/reportInspection";
import { useReportInspection } from "../useReportInspection";
import { useCommunityModerationScope } from "../useCommunityModerationScope";
import {
  isReportAttemptLocked,
  useReportActionAttempt,
} from "../useReportActionAttempt";
import { CommunityReportActions } from "./CommunityReportActions";
import { ModerationJudgeReview } from "./ModerationJudgeReview";

export function CommunityReportsPanel() {
  const membership = useMyRelayMembershipLookupQuery();
  const allowed =
    membership.isSuccess && canManageCommunityMembers(membership.data);
  const { scope, error: scopeError } = useCommunityModerationScope(allowed);
  const [status, setStatus] = useState("open");
  const reports = useCommunityReportsQuery(scope, status, allowed);
  const [selected, setSelected] = useState<ModerationReport | null>(null);
  const observedReport = reports.data?.find(
    (report) => report.reportEventId === selected?.reportEventId,
  );
  const selectedReportAvailable =
    reports.isSuccess &&
    !reports.isFetching &&
    observedReport?.status === "open" &&
    observedReport.targetKind === selected?.targetKind &&
    observedReport.target === selected?.target &&
    observedReport.channelId === selected?.channelId;
  const channel = useModerationReportChannelQuery(
    scope,
    selected?.channelId ?? null,
    allowed && !!selected,
  );
  const target = useReportInspection(selected, scope, allowed);
  const source = target.data?.source ?? null;
  const sourceError = target.error;
  const sourceLoading = target.isFetching;
  const inspectionReady =
    target.ready &&
    (!selected?.channelId ||
      (channel.isSuccess &&
        !channel.isFetching &&
        channelInspectionKey(channel.data) ===
          channelInspectionKey(target.inspection?.channel)));
  const [reviewGeneration, setReviewGeneration] = useState(0);
  const [humanReviewSignal, setHumanReviewBlocked] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const invalidateReview = useCallback(
    () => setReviewGeneration((generation) => generation + 1),
    [],
  );

  const { attempt, submit } = useReportActionAttempt(
    selected,
    scope,
    invalidateReview,
    (completedReportEventId, action) => {
      if (selectedRef.current?.reportEventId !== completedReportEventId) return;
      invalidateReview();
      setSelected((previous) =>
        previous?.reportEventId === completedReportEventId
          ? {
              ...previous,
              status: action === "dismiss" ? "dismissed" : "resolved",
            }
          : previous,
      );
    },
    inspectionReady ? target.inspection : undefined,
    target.inspectionIsCurrent,
  );
  const humanReviewBlocked =
    humanReviewSignal ||
    !!attempt?.pending ||
    isReportAttemptLocked(attempt) ||
    !selectedReportAvailable;

  const refresh = async () => {
    invalidateReview();
    setSelected(null);
    setHumanReviewBlocked(false);
    const currentMembership = await membership.refetch();
    if (
      currentMembership.isSuccess &&
      canManageCommunityMembers(currentMembership.data) &&
      scope?.isCurrent()
    )
      await reports.refetch();
  };
  const observedOpenChannelEligible =
    channel.isSuccess &&
    !channel.isFetching &&
    channel.data?.visibility === "open" &&
    ["stream", "forum"].includes(channel.data.channelType) &&
    !channel.data.archivedAt;
  const reviewContextKey = JSON.stringify([
    scope?.relayUrl,
    scope?.signerPubkey,
    membership.data,
    selected,
    source,
    target.observedRevision,
    inspectionReady,
    channel.data,
    channel.status,
    channel.fetchStatus,
    String(channel.error ?? ""),
    reviewGeneration,
    humanReviewBlocked,
    observedReport,
    reports.status,
    reports.fetchStatus,
    String(reports.error ?? ""),
    selectedReportAvailable,
  ]);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="settings-community-reports"
    >
      <SettingsSectionHeader
        title="Reports"
        description="Review community reports and record a human decision."
      />
      <div className="space-y-4 p-4 text-sm">
        {membership.isPending ? (
          <p role="status">Checking community management permissions…</p>
        ) : membership.isError ? (
          <div role="alert">
            Community permissions could not be checked.{" "}
            <Button onClick={() => void membership.refetch()}>
              Retry permissions
            </Button>
          </div>
        ) : !allowed ? (
          <p>A community owner or admin must handle reports.</p>
        ) : (
          <>
            {scopeError ? (
              <p role="alert">
                Community scope could not be loaded: {String(scopeError)}
              </p>
            ) : null}
            {selected ? (
              <>
                <Button
                  onClick={() => {
                    invalidateReview();
                    setSelected(null);
                    setHumanReviewBlocked(false);
                  }}
                >
                  Back to reports
                </Button>
                <article
                  className="space-y-2 break-words rounded-lg border p-4"
                  aria-label="Report details"
                >
                  <h2 className="text-base font-semibold">
                    {selected.reportType} report
                  </h2>
                  <p>
                    Status:{" "}
                    {attempt?.result?.stage === "complete"
                      ? attempt.decision.action === "dismiss"
                        ? "dismissed"
                        : "resolved"
                      : (observedReport?.status ??
                        (reports.isError
                          ? "Unavailable"
                          : "No longer in this queue"))}
                  </p>
                  <p>
                    Target ({selected.targetKind}): {selected.target}
                  </p>
                  {channel.data ? (
                    <p>Channel visibility: {channel.data.visibility}</p>
                  ) : channel.isSuccess ? (
                    <p>
                      Channel unavailable through ordinary community access.
                    </p>
                  ) : channel.isError ? (
                    <p role="status">Channel privacy could not be checked.</p>
                  ) : null}
                  <p>Reporter: {selected.reporterPubkey}</p>
                  <p>Channel: {selected.channelId ?? "None"}</p>
                  <p className="whitespace-pre-wrap">
                    Private report note: {selected.note ?? "None"}
                  </p>
                  {sourceLoading ? (
                    <p role="status">Loading target…</p>
                  ) : sourceError ? (
                    <p role="alert">
                      Target could not be read: {String(sourceError)}
                    </p>
                  ) : source ? (
                    <>
                      <p>Author: {source.pubkey}</p>
                      <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                        {source.content}
                      </pre>
                    </>
                  ) : selected.targetKind === "event" ? (
                    <p>
                      Target unavailable through ordinary community access.
                      Author actions are unavailable.
                    </p>
                  ) : null}
                  {target.data?.edits.map((edit) => (
                    <div key={edit.id} className="whitespace-pre-wrap">
                      <p>Message edit:</p>
                      <p>{edit.content}</p>
                    </div>
                  ))}
                  {!inspectionReady && !sourceLoading ? (
                    <p role="status">
                      Target context needs fresh inspection before a decision.
                    </p>
                  ) : null}
                  <Button
                    disabled={sourceLoading}
                    onClick={() => {
                      invalidateReview();
                      void Promise.all([target.refresh(), channel.refetch()]);
                    }}
                  >
                    Refresh target for inspection
                  </Button>
                </article>
                {scope ? (
                  <ModerationJudgeReview
                    report={observedReport ?? selected}
                    source={source}
                    scope={scope}
                    contextKey={reviewContextKey}
                    eligible={
                      allowed &&
                      observedOpenChannelEligible &&
                      !!source &&
                      !sourceLoading &&
                      !sourceError &&
                      inspectionReady &&
                      target.data?.edits.length === 0 &&
                      !humanReviewBlocked
                    }
                    ineligibleReason={
                      !selectedReportAvailable
                        ? "The selected report could not be confirmed as open in the current queue. Refresh reports before requesting AI advice."
                        : humanReviewBlocked
                          ? "Finish the human decision or its recovery before requesting AI advice."
                          : channel.isPending || channel.isFetching
                            ? "Checking channel eligibility for AI review…"
                            : channel.isError
                              ? "Channel eligibility could not be checked. Human review remains available."
                              : channel.data?.visibility === "private"
                                ? "AI review is unavailable for private channels."
                                : channel.data?.channelType === "dm"
                                  ? "AI review is unavailable for direct messages."
                                  : !source || sourceLoading || sourceError
                                    ? "The eligible message source could not be confirmed."
                                    : undefined
                    }
                  />
                ) : null}
                {scope ? (
                  <CommunityReportActions
                    key={`${scope.relayUrl}:${scope.signerPubkey}:${selected.reportEventId}`}
                    report={selected}
                    source={source}
                    attempt={attempt}
                    available={selectedReportAvailable && inspectionReady}
                    enforcementAvailable={
                      !selected.channelId || !!target.data?.channel
                    }
                    onSubmit={submit}
                    onReviewBlockedChange={(blocked) => {
                      if (
                        selectedRef.current?.reportEventId ===
                        selected.reportEventId
                      )
                        setHumanReviewBlocked(blocked);
                    }}
                  />
                ) : null}
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="space-x-2">
                    <span>Report status</span>
                    <select
                      aria-label="Report status"
                      className="rounded border bg-background p-2 text-sm"
                      value={status}
                      onChange={(event) => {
                        invalidateReview();
                        setStatus(event.target.value);
                      }}
                    >
                      <option value="open">Open</option>
                      <option value="resolved">Resolved</option>
                      <option value="dismissed">Dismissed</option>
                      <option value="">All statuses</option>
                    </select>
                  </label>
                  <Button
                    onClick={() => void refresh()}
                    disabled={reports.isFetching}
                  >
                    Refresh reports
                  </Button>
                </div>
                <p className="text-muted-foreground">
                  Shows up to 500 reports. Use the status filter to narrow the
                  queue.
                </p>
                {reports.isFetching ? (
                  <p role="status">Loading reports…</p>
                ) : null}
                {reports.error ? (
                  <div role="alert">
                    Reports could not be loaded: {String(reports.error)}{" "}
                    <Button onClick={() => void refresh()}>
                      Retry reports
                    </Button>
                  </div>
                ) : null}
                {!reports.isPending &&
                !reports.error &&
                !reports.data?.length ? (
                  <p>No reports for this status.</p>
                ) : null}
                <ul className="space-y-2">
                  {reports.data?.slice(0, 500).map((report) => (
                    <li key={report.id}>
                      <button
                        className="w-full rounded-lg border p-3 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring"
                        type="button"
                        aria-pressed={false}
                        aria-label={`${report.reportType} report ${report.id}, ${report.status}`}
                        onClick={() => {
                          invalidateReview();
                          setSelected(report);
                          setHumanReviewBlocked(false);
                        }}
                      >
                        <span className="font-medium">
                          {report.reportType} report
                        </span>
                        <span className="ml-2">{report.status}</span>
                        <span className="block break-all text-muted-foreground">
                          {report.targetKind}: {report.target}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
