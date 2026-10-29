import { relayClient } from "@/shared/api/relayClient";
import { getChannelDetails } from "@/shared/api/tauri";
import {
  assertModerationScope,
  type ModerationScope,
} from "@/shared/api/moderationScope";
import type { ModerationReport } from "@/shared/api/moderation";
import type { ChannelDetail, RelayEvent } from "@/shared/api/types";

export type ReportInspection = {
  source: RelayEvent | null;
  edits: RelayEvent[];
  channel: ChannelDetail | null;
};

/** The native missing/inaccessible response is one non-disclosing manual state. */
export async function readReportChannel(
  channelId: string,
): Promise<ChannelDetail | null> {
  try {
    return await getChannelDetails(channelId);
  } catch (error) {
    if (
      (error instanceof Error ? error.message : error) === "channel not found"
    )
      return null;
    throw error;
  }
}

/** Ordinary reader access only; unsupported or missing targets remain manually reviewable. */
export async function readReportInspection(
  report: ModerationReport,
  scope: ModerationScope,
): Promise<ReportInspection> {
  await assertModerationScope(scope);
  const source =
    report.targetKind === "event"
      ? ((
          await relayClient.fetchEvents({
            ids: [report.target],
            kinds: [9, 40002, 40008, 45001, 45003],
            limit: 1,
          })
        ).find((event) => event.id === report.target) ?? null)
      : null;
  const edits =
    report.targetKind === "event"
      ? await relayClient.fetchEvents({
          kinds: [40003],
          "#e": [report.target],
          limit: 500,
        })
      : [];
  if (edits.length >= 500)
    throw new Error(
      "Edit history could not be fully checked. Inspect the target in its conversation.",
    );
  const channel = report.channelId
    ? await readReportChannel(report.channelId)
    : null;
  await assertModerationScope(scope);
  return {
    source,
    edits: edits.sort((a, b) => a.id.localeCompare(b.id)),
    channel,
  };
}

/** Compare only channel state relevant to target access and interpretation. */
export function channelInspectionKey(
  channel: ChannelDetail | null | undefined,
) {
  return JSON.stringify(
    channel
      ? [
          channel.id,
          channel.visibility,
          channel.channelType,
          channel.archivedAt,
          channel.isMember,
        ]
      : null,
  );
}

export function reportInspectionKey(inspection: ReportInspection) {
  return JSON.stringify([
    inspection.source,
    inspection.edits,
    channelInspectionKey(inspection.channel),
  ]);
}
