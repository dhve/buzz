import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJudgeResult } from "./moderationJudge.ts";

const request = {
  reportEventId: "a".repeat(64),
  requestId: "review-1",
  modelId: "local-model",
  policy: { kind: "builtin_v1" },
};
function assessment(field, value) {
  return {
    verdict: field === "uncertainty" ? "uncertain" : "needs_review",
    matches: [
      {
        rule_id: "G2_ABUSE",
        evidence: field === "evidence" ? value : "source",
        reason: field === "reason" ? value : "reason",
      },
    ],
    uncertainty: field === "uncertainty" ? value : null,
    provenance: {
      sourceDigest: "1".repeat(64),
      policyDigest: "2".repeat(64),
      policySource: "builtin_template",
      policyVersion: "v1",
      promptVersion: "v1",
      requestGeneration: "1",
      requestId: request.requestId,
      requestedModel: request.modelId,
      reportedModel: request.modelId,
      meshVersion: "0.76.2",
      runtimeId: "runtime-1",
      startedAtMs: 1,
      elapsedMs: 1,
    },
  };
}
function validate(field, value) {
  return validateJudgeResult(
    assessment(field, value),
    request,
    field === "evidence" ? value : "source",
    ["G2_ABUSE"],
    "runtime-1",
  );
}

for (const [field, limit] of [
  ["evidence", 128],
  ["reason", 256],
  ["uncertainty", 256],
]) {
  test(`${field} accepts native Unicode scalar limits and rejects longer text`, () => {
    for (const character of ["x", "😀"]) {
      const atLimit = character.repeat(limit);
      const result = validate(field, atLimit);
      assert.equal(
        field === "uncertainty" ? result.uncertainty : result.matches[0][field],
        atLimit,
      );
      assert.throws(() => validate(field, character.repeat(limit + 1)), {
        code: "invalid_response",
      });
    }
  });
  test(`${field} rejects lone surrogates while preserving valid pairs`, () => {
    assert.doesNotThrow(() => validate(field, "before\uD83D\uDE00after"));
    for (const malformed of ["\uD83D", "\uDE00", "before\uD83Dafter"]) {
      assert.throws(() => validate(field, malformed), {
        code: "invalid_response",
      });
    }
  });
}
