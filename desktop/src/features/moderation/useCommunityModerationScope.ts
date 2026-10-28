import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIdentityQuery } from "@/shared/api/hooks";
import { getRelayWsUrl } from "@/shared/api/tauri";
import type { ModerationScope } from "@/shared/api/moderationScope";

export function useCommunityModerationScope(enabled: boolean) {
  const identity = useIdentityQuery();
  const relay = useQuery({
    queryKey: ["communityModerationRelay", identity.data?.pubkey],
    queryFn: getRelayWsUrl,
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  const current = useRef({
    enabled,
    relay: relay.data,
    signer: identity.data?.pubkey,
    mounted: true,
    generation: 0,
  });
  const generation =
    current.current.generation +
    Number(
      current.current.enabled !== enabled ||
        current.current.relay !== relay.data ||
        current.current.signer !== identity.data?.pubkey,
    );
  current.current = {
    enabled,
    relay: relay.data,
    signer: identity.data?.pubkey,
    mounted: current.current.mounted,
    generation,
  };
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
    };
  }, []);
  const scope = useMemo<ModerationScope | undefined>(() => {
    if (!relay.data || !identity.data?.pubkey) return undefined;
    const relayUrl = relay.data,
      signerPubkey = identity.data.pubkey;
    return {
      relayUrl,
      signerPubkey,
      isCurrent: () =>
        current.current.generation === generation &&
        current.current.mounted &&
        current.current.enabled &&
        current.current.relay === relayUrl &&
        current.current.signer === signerPubkey,
    };
  }, [relay.data, identity.data?.pubkey, generation]);
  return { scope, error: relay.error ?? identity.error };
}
