import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModerationReport } from "@/shared/api/moderation";
import type { ModerationScope } from "@/shared/api/moderationScope";
import { relayClient } from "@/shared/api/relayClient";
import {
  readReportInspection,
  reportInspectionKey,
  type ReportInspection,
} from "./lib/reportInspection";

/** Keep the inspected snapshot separate from newly observed ordinary-access state. */
export function useReportInspection(
  report: ModerationReport | null,
  scope: ModerationScope | undefined,
  enabled: boolean,
) {
  const client = useQueryClient();
  const key = JSON.stringify([
    scope?.relayUrl,
    scope?.signerPubkey,
    report?.reportEventId,
  ]);
  const queryKey = useMemo(
    () =>
      [
        "channels",
        report?.channelId ?? "none",
        "detail",
        scope?.relayUrl,
        scope?.signerPubkey,
        "reportInspection",
        report?.reportEventId,
      ] as const,
    [
      report?.channelId,
      scope?.relayUrl,
      scope?.signerPubkey,
      report?.reportEventId,
    ],
  );
  const revision = useRef(0);
  const [observedRevision, setObservedRevision] = useState(0);
  const [baseline, setBaseline] = useState<{
    key: string;
    revision: number;
    data: ReportInspection;
  } | null>(null);
  const query = useQuery({
    queryKey,
    enabled: enabled && !!report && !!scope,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: () => {
      if (!report || !scope) throw new Error("Select a report to inspect.");
      return readReportInspection(report, scope);
    },
  });
  useEffect(() => {
    if (query.data && !query.isFetching && baseline?.key !== key)
      setBaseline({ key, revision: observedRevision, data: query.data });
  }, [key, query.data, query.isFetching, observedRevision, baseline?.key]);
  useEffect(() => {
    if (!enabled || !scope || report?.targetKind !== "event") return;
    const abort = new AbortController();
    const seen = new Set<string>();
    const invalidate = () => {
      if (abort.signal.aborted || !scope.isCurrent()) return;
      setObservedRevision(++revision.current);
      void client.invalidateQueries({ queryKey });
    };
    // Subscribe through the same canonical relay client used by channel readers.
    // History overlaps the initial read, so no edit/deletion falls in a read/live gap.
    void relayClient
      .subscribeInteractive(
        { kinds: [40003, 5, 9005], "#e": [report.target], limit: 500 },
        (event) => {
          if (seen.has(event.id)) return;
          seen.add(event.id);
          if (seen.size > 500) {
            const oldest = seen.values().next().value;
            if (oldest) seen.delete(oldest);
          }
          invalidate();
        },
        abort.signal,
      )
      .catch(() => {
        if (!abort.signal.aborted) invalidate();
      });
    const reconnect = relayClient.subscribeToReconnects(invalidate);
    return () => {
      abort.abort();
      reconnect();
    };
    // These primitive identities own the subscription; render-created query keys do not.
  }, [client, queryKey, enabled, scope, report?.targetKind, report?.target]);

  const inspection = baseline?.key === key ? baseline.data : undefined;
  const ready =
    !!inspection &&
    query.isSuccess &&
    !query.isFetching &&
    baseline?.revision === observedRevision &&
    reportInspectionKey(inspection) === reportInspectionKey(query.data);
  async function refresh() {
    const before = revision.current;
    const result = await query.refetch();
    if (
      result.isSuccess &&
      result.data &&
      before === revision.current &&
      scope?.isCurrent()
    )
      setBaseline({ key, revision: before, data: result.data });
  }
  const inspectionIsCurrent = () => revision.current === baseline?.revision;
  return {
    ...query,
    inspection,
    ready,
    observedRevision,
    refresh,
    inspectionIsCurrent,
  };
}
