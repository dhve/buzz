import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelModerationReview,
  judgeErrorCode,
  moderationJudgeStatus,
  reviewModerationReport,
  validateJudgeResult,
  type JudgeErrorCode,
  type JudgePolicy,
  type JudgeResult,
  type JudgeStatus,
} from "@/shared/api/moderationJudge";

export type JudgeScope = {
  relayUrl: string;
  signerPubkey: string;
  isCurrent: () => boolean;
};
function statusKey(status: JudgeStatus | null) {
  return JSON.stringify(
    status && [
      status.available,
      status.reason,
      status.localModelIds,
      status.runtimeId,
    ],
  );
}
export function useModerationJudge(
  scope: JudgeScope,
  reportEventId: string,
  source: string,
  ruleIds: string[],
) {
  const [status, setStatus] = useState<JudgeStatus | null>(null);
  const [statusError, setStatusError] = useState<JudgeErrorCode | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<JudgeErrorCode | null>(null);
  const [result, setResult] = useState<JudgeResult | null>(null);
  const active = useRef<{ id: string; generation: number } | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const currentStatus = useRef<JudgeStatus | null>(null);
  const statusSequence = useRef(0);
  const clear = useCallback((cancelMessage = "") => {
    generation.current += 1;
    const previous = active.current;
    active.current = null;
    if (previous) void cancelModerationReview(previous.id).catch(() => {});
    setPending(false);
    setResult(null);
    setError(null);
    setMessage(cancelMessage);
  }, []);
  const refreshStatus = useCallback(async () => {
    const sequence = ++statusSequence.current;
    try {
      const next = await moderationJudgeStatus();
      if (
        !mounted.current ||
        sequence !== statusSequence.current ||
        !scope.isCurrent()
      )
        return null;
      if (
        currentStatus.current &&
        (statusKey(currentStatus.current) !== statusKey(next) ||
          (next.activeRequestId !== null &&
            next.activeRequestId !== active.current?.id &&
            next.activeRequestId !== currentStatus.current.activeRequestId))
      )
        clear();
      currentStatus.current = next;
      setStatus(next);
      setStatusError(null);
      return next;
    } catch (failure) {
      if (mounted.current && sequence === statusSequence.current) {
        clear();
        currentStatus.current = null;
        setStatus(null);
        setStatusError(judgeErrorCode(failure));
      }
      return null;
    }
  }, [clear, scope]);
  useEffect(() => {
    mounted.current = true;
    void refreshStatus();
    const interval = window.setInterval(() => {
      void refreshStatus();
    }, 2000);
    return () => {
      mounted.current = false;
      generation.current += 1;
      window.clearInterval(interval);
      const request = active.current;
      active.current = null;
      if (request) void cancelModerationReview(request.id).catch(() => {});
    };
  }, [refreshStatus]);
  const review = async (modelId: string, policy: JudgePolicy) => {
    const before = currentStatus.current;
    if (
      active.current ||
      !scope.isCurrent() ||
      !before?.available ||
      !before.localModelIds.includes(modelId) ||
      before.activeRequestId
    )
      return;
    const id = crypto.randomUUID();
    const requestGeneration = ++generation.current;
    active.current = { id, generation: requestGeneration };
    setPending(true);
    setResult(null);
    setError(null);
    setMessage("Reviewing with AI…");
    const request = {
      reportEventId,
      modelId,
      policy,
      requestId: id,
      expectedRelayUrl: scope.relayUrl,
      expectedSignerPubkey: scope.signerPubkey,
    };
    const isCurrent = () =>
      mounted.current &&
      scope.isCurrent() &&
      generation.current === requestGeneration &&
      active.current?.id === id;
    try {
      const response = await reviewModerationReport(request);
      if (!isCurrent()) return;
      const fresh = await refreshStatus();
      if (!isCurrent()) return;
      if (!fresh?.available || statusKey(before) !== statusKey(fresh))
        throw { code: "stale" };
      const validated = validateJudgeResult(
        response,
        request,
        source,
        ruleIds,
        before.runtimeId,
      );
      if (isCurrent()) {
        setResult(validated);
        setMessage("AI review complete. A human must decide.");
      }
    } catch (failure) {
      if (isCurrent()) {
        setError(judgeErrorCode(failure));
        setMessage("");
      }
    } finally {
      if (isCurrent()) {
        active.current = null;
        setPending(false);
      }
    }
  };
  return {
    status,
    statusError,
    pending,
    message,
    error,
    result,
    review,
    clear,
    refreshStatus,
    activeRequestId: active.current?.id ?? null,
  };
}
