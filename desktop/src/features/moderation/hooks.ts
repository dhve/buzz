import {
  assertModerationScope,
  type ModerationScope,
} from "@/shared/api/moderationScope";
import { readReportChannel } from "./lib/reportInspection";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import {
  banMember,
  listRestrictions,
  listReports,
  resolveReport,
  type ReportType,
  submitReport,
  timeoutMember,
  unbanMember,
  untimeoutMember,
} from "@/shared/api/moderation";

export const moderationRestrictionsQueryKey = [
  "moderationRestrictions",
] as const;
export const relaySelfQueryKey = ["relaySelf"] as const;

/**
 * The active relay's NIP-11 `self` pubkey (hex), or `null` when it advertises
 * none. Used to recognize relay-signed state and moderation DMs. Community-
 * scoped and effectively static for a session, so it is cached indefinitely;
 * a `null` result is a valid answer, while request failures remain query errors.
 */
export function useRelaySelfQuery(enabled = true) {
  return useQuery({
    enabled,
    queryKey: relaySelfQueryKey,
    queryFn: getRelaySelf,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// --- Reads (mod-authz gated; consumed by the members-sidebar surfaces) ---

export function useModerationRestrictionsQuery(enabled = true) {
  return useQuery({
    enabled,
    queryKey: moderationRestrictionsQueryKey,
    queryFn: listRestrictions,
    staleTime: 15_000,
  });
}

// --- Writes ---
//
// Moderation writes are relay-validated command events whose effects surface in
// the restriction reads after processing, so mutations invalidate the affected
// read queries on success rather than fabricating optimistic rows.

function useInvalidateModerationReads() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: moderationRestrictionsQueryKey,
    });
}

/** Submit a NIP-56 report. Does not touch the mod-gated read caches. */
export function useSubmitReportMutation() {
  return useMutation({
    mutationFn: (input: {
      authorPubkey: string;
      eventId: string;
      reportType: ReportType;
      note?: string;
    }) => submitReport(input),
  });
}

export function useBanMemberMutation() {
  const invalidate = useInvalidateModerationReads();
  return useMutation({
    mutationFn: (input: {
      pubkey: string;
      expiresAt?: number;
      reason?: string;
    }) => banMember(input),
    onSuccess: invalidate,
  });
}

export function useUnbanMemberMutation() {
  const invalidate = useInvalidateModerationReads();
  return useMutation({
    mutationFn: (pubkey: string) => unbanMember(pubkey),
    onSuccess: invalidate,
  });
}

export function useTimeoutMemberMutation() {
  const invalidate = useInvalidateModerationReads();
  return useMutation({
    mutationFn: (input: {
      pubkey: string;
      expiresAt: number;
      reason?: string;
    }) => timeoutMember(input),
    onSuccess: invalidate,
  });
}

export function useUntimeoutMemberMutation() {
  const invalidate = useInvalidateModerationReads();
  return useMutation({
    mutationFn: (pubkey: string) => untimeoutMember(pubkey),
    onSuccess: invalidate,
  });
}

export type { ReportType };

// The key includes both the community and signer even inside the community
// QueryClient. No queued response can become another community's report list.
export function useCommunityReportsQuery(
  scope: ModerationScope | undefined,
  status: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "communityReports",
      scope?.relayUrl,
      scope?.signerPubkey,
      status,
    ],
    enabled: enabled && !!scope,
    queryFn: () => listReports({ status, limit: 500 }, scope),
    staleTime: 0,
    retry: false,
  });
}

export function useResolveReportMutation(scope: ModerationScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof resolveReport>[0]) =>
      resolveReport(input, scope),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["communityReports", scope.relayUrl, scope.signerPubkey],
      }),
  });
}

export function useModerationReportChannelQuery(
  scope: ModerationScope | undefined,
  channelId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "channels",
      channelId ?? "none",
      "detail",
      scope?.relayUrl,
      scope?.signerPubkey,
    ],
    enabled: enabled && !!scope && !!channelId,
    retry: false,
    staleTime: 0,
    queryFn: async () => {
      if (!scope || !channelId) throw new Error("No report channel selected.");
      await assertModerationScope(scope);
      const channel = await readReportChannel(channelId);
      await assertModerationScope(scope);
      return channel;
    },
  });
}
