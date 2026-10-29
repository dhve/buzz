import { getRelayWsUrl } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";

/** Captured community and signer; callers invalidate the generation on unmount. */
export type ModerationScope = {
  relayUrl: string;
  signerPubkey: string;
  isCurrent: () => boolean;
};

function relayOrigin(url: string) {
  return url
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/+$/, "");
}

export function requireCurrentModerationScope(scope?: ModerationScope) {
  if (scope && !scope.isCurrent()) {
    throw new Error(
      "Community or reviewer changed. Reopen Reports before continuing.",
    );
  }
}

/** Check native state too: relay and identity can change before React remounts. */
export async function assertModerationScope(scope?: ModerationScope) {
  if (!scope) return;
  requireCurrentModerationScope(scope);
  const [relayUrl, identity] = await Promise.all([
    getRelayWsUrl(),
    getIdentity(),
  ]);
  requireCurrentModerationScope(scope);
  if (
    relayOrigin(relayUrl) !== relayOrigin(scope.relayUrl) ||
    identity.pubkey !== scope.signerPubkey
  ) {
    throw new Error(
      "Community or reviewer changed. Reopen Reports before continuing.",
    );
  }
}
