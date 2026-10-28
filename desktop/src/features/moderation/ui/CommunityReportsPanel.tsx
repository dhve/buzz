import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMyRelayMembershipLookupQuery } from "@/features/community-members/hooks";
import { SettingsSectionHeader } from "@/features/settings/ui/SettingsSectionHeader";
import { canManageCommunityMembers } from "@/shared/api/relayMembers";
import type { ModerationReport } from "@/shared/api/moderation";
import type { RelayEvent } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import {
  useCommunityReportsQuery,
  useModerationReportChannelQuery,
} from "../hooks";
import { readReportTarget } from "../lib/reportActions";
import { useCommunityModerationScope } from "../useCommunityModerationScope";
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
  const channel = useModerationReportChannelQuery(
    scope,
    selected?.channelId ?? null,
    allowed && !!selected,
  );
  const [source, setSource] = useState<RelayEvent | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [reviewGeneration, setReviewGeneration] = useState(0);
  const [humanReviewBlocked, setHumanReviewBlocked] = useState(false);
  const selectionGeneration = useRef(0);
  const queryClient = useQueryClient();
  const invalidateReview = useCallback(
    () => setReviewGeneration((generation) => generation + 1),
    [],
  );

  useEffect(() => {
    const generation = ++selectionGeneration.current;
    setSource(null);
    setSourceError(null);
    invalidateReview();
    if (!selected || !scope || !allowed) return;
    setSourceLoading(selected.targetKind === "event");
    void readReportTarget(selected, scope)
      .then((event) => {
        if (generation === selectionGeneration.current && scope.isCurrent())
          setSource(event);
      })
      .catch((error) => {
        if (generation === selectionGeneration.current && scope.isCurrent())
          setSourceError(
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        if (generation === selectionGeneration.current && scope.isCurrent())
          setSourceLoading(false);
      });
    return () => {
      selectionGeneration.current++;
    };
  }, [selected, scope, allowed, invalidateReview]);

  const refresh = async () => {
    invalidateReview();
    setSelected(null);
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
    channel.data.visibility === "open" &&
    ["stream", "forum"].includes(channel.data.channelType) &&
    !channel.data.archivedAt;
  const reviewContextKey = JSON.stringify([
    scope?.relayUrl,
    scope?.signerPubkey,
    membership.data,
    selected,
    source,
    channel.data,
    channel.status,
    channel.fetchStatus,
    String(channel.error ?? ""),
    reviewGeneration,
    humanReviewBlocked,
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
                  <p>Status: {selected.status}</p>
                  <p>
                    Target ({selected.targetKind}): {selected.target}
                  </p>
                  {channel.data ? (
                    <p>Channel visibility: {channel.data.visibility}</p>
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
                    <p role="alert">Target could not be read: {sourceError}</p>
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
                </article>
                {scope ? (
                  <ModerationJudgeReview
                    report={selected}
                    source={source}
                    scope={scope}
                    contextKey={reviewContextKey}
                    eligible={
                      allowed &&
                      observedOpenChannelEligible &&
                      !!source &&
                      !sourceLoading &&
                      !sourceError &&
                      !humanReviewBlocked
                    }
                    ineligibleReason={
                      humanReviewBlocked
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
                    scope={scope}
                    onInvalidate={invalidateReview}
                    onReviewBlockedChange={setHumanReviewBlocked}
                    onComplete={(action) => {
                      invalidateReview();
                      setSelected((previous) =>
                        previous
                          ? {
                              ...previous,
                              status:
                                action === "dismiss" ? "dismissed" : "resolved",
                            }
                          : null,
                      );
                      void queryClient.invalidateQueries({
                        queryKey: [
                          "communityReports",
                          scope.relayUrl,
                          scope.signerPubkey,
                        ],
                      });
                      void queryClient.invalidateQueries({
                        queryKey: ["moderationRestrictions"],
                      });
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
