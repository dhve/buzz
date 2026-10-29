import {
  banMember,
  listReports,
  resolveReport,
  timeoutMember,
  type ModerationReport,
  type ResolutionAction,
} from "@/shared/api/moderation";
import {
  assertModerationScope,
  type ModerationScope,
} from "@/shared/api/moderationScope";
import {
  canManageCommunityMembers,
  getMyRelayMembershipLookup,
} from "@/shared/api/relayMembers";
import { deleteMessage, removeChannelMember } from "@/shared/api/tauri";
import {
  readReportInspection,
  reportInspectionKey,
  type ReportInspection,
} from "./reportInspection";

export type ReportDecision = {
  action: ResolutionAction;
  reason: string;
  expiresAt?: number;
};
export type ReportActionResult =
  | { stage: "complete" }
  | {
      stage: "validation" | "enforcement" | "decision";
      error: string;
      decision: ReportDecision;
      enforced: boolean;
    };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Every invocation rechecks authority and the actual open row before a write. */
async function revalidate(report: ModerationReport, scope: ModerationScope) {
  await assertModerationScope(scope);
  const membership = await getMyRelayMembershipLookup();
  await assertModerationScope(scope);
  if (!canManageCommunityMembers(membership))
    throw new Error("A community owner or admin must handle reports.");
  const fresh = (await listReports({ status: "open", limit: 500 }, scope)).find(
    (row) => row.reportEventId === report.reportEventId,
  );
  if (fresh?.status !== "open")
    throw new Error(
      "This report is no longer open or is outside the current queue. Refresh reports.",
    );
  if (
    fresh.id !== report.id ||
    fresh.target !== report.target ||
    fresh.targetKind !== report.targetKind ||
    fresh.channelId !== report.channelId
  )
    throw new Error("The report changed. Refresh reports before continuing.");
  return fresh;
}

/** Enforcement and decision are deliberately separate signed operations. */
export async function applyReportDecision(
  report: ModerationReport,
  decision: ReportDecision,
  scope: ModerationScope,
  decisionOnly = false,
  inspection?: ReportInspection,
  inspectionIsCurrent: () => boolean = () => true,
): Promise<ReportActionResult> {
  let stage: "validation" | "enforcement" | "decision" = "validation";
  let enforced =
    decisionOnly && !["dismiss", "escalate"].includes(decision.action);
  try {
    const fresh = await revalidate(report, scope);
    if (!decision.reason.trim())
      throw new Error("Enter a reporter-readable reason.");
    const currentInspection = await readReportInspection(fresh, scope);
    if (
      !inspection ||
      !inspectionIsCurrent() ||
      reportInspectionKey(currentInspection) !== reportInspectionKey(inspection)
    )
      throw new Error(
        "The target or channel changed. Refresh target for inspection before deciding.",
      );
    // Keep the observed-source fence through asynchronous signing/publication.
    // Once enforcement succeeds its captured decision must remain recoverable.
    const writeScope = {
      ...scope,
      isCurrent: () => scope.isCurrent() && inspectionIsCurrent(),
    };
    const enforcement = !["dismiss", "escalate"].includes(decision.action);
    if (!decisionOnly && enforcement) {
      if (fresh.channelId && !currentInspection.channel)
        throw new Error(
          "A readable target channel is required for new enforcement.",
        );
      const event = currentInspection.source;
      const pubkey =
        fresh.targetKind === "pubkey" ? fresh.target : event?.pubkey;
      if (
        fresh.targetKind === "blob" ||
        !pubkey ||
        !/^[0-9a-f]{64}$/.test(pubkey)
      )
        throw new Error(
          "The target author is unavailable. No enforcement was sent.",
        );
      if (
        ["delete", "kick"].includes(decision.action) &&
        (!fresh.channelId ||
          (event &&
            !event.tags.some(
              (tag) => tag[0] === "h" && tag[1] === fresh.channelId,
            )))
      )
        throw new Error("A verified target channel is required.");
      if (decision.action === "delete" && fresh.targetKind !== "event")
        throw new Error("Only an event report can delete a message.");
      if (
        decision.action === "timeout" &&
        (!decision.expiresAt || decision.expiresAt <= Date.now() / 1000)
      )
        throw new Error("Choose a future timeout expiry.");
      const channelId = fresh.channelId ?? "";
      const expiresAt = decision.expiresAt ?? 0;
      await assertModerationScope(writeScope);
      stage = "enforcement";
      switch (decision.action) {
        case "ban":
          await banMember({ pubkey, reason: decision.reason }, writeScope);
          break;
        case "timeout":
          await timeoutMember(
            { pubkey, reason: decision.reason, expiresAt },
            writeScope,
          );
          break;
        case "delete":
          await deleteMessage(channelId, fresh.target, writeScope);
          break;
        case "kick":
          await removeChannelMember(channelId, pubkey, writeScope);
          break;
      }
      enforced = true;
    }
    stage = "decision";
    await resolveReport(
      {
        reportEventId: fresh.reportEventId,
        action: decision.action,
        status: decision.action === "dismiss" ? "dismissed" : "resolved",
        reason: decision.reason,
      },
      enforced && !decisionOnly ? scope : writeScope,
    );
    return { stage: "complete" };
  } catch (error) {
    return { stage, error: errorMessage(error), decision, enforced };
  }
}
