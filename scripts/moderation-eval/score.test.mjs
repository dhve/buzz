import assert from "node:assert/strict";
import test from "node:test";
import { RULES, score, validateCompletion } from "./score.mjs";

const example = (id, rules = [], extra = {}) => ({
  id,
  split: "development",
  language: "en",
  tags: ["benign_near_match"],
  source: `synthetic message ${id}`,
  expected: {
    verdict: rules.length ? "needs_review" : "no_match",
    ruleIds: rules,
    severeRuleIds: rules,
  },
  ...extra,
});
const completion = (rules = []) =>
  JSON.stringify({
    verdict: rules.length ? "needs_review" : "no_match",
    matches: rules.map((rule_id) => ({
      rule_id,
      evidence: "synthetic",
      reason: "test evidence",
    })),
    uncertainty: null,
  });
const output = (id, rules = [], extra = {}) => ({
  id,
  status: "completion",
  raw: completion(rules),
  elapsedMs: 100,
  ...extra,
});

// Dropping invalid or absent output from denominators must fail this test.
test("failures count as missed positives and are never clean benign predictions", () => {
  const result = score(
    [
      example("a", ["G2_ABUSE"]),
      example("b", ["G2_ABUSE"]),
      example("c"),
      example("d"),
    ],
    [
      output("a", ["G2_ABUSE"]),
      output("b", [], { raw: "bad json" }),
      output("c", ["G2_ABUSE"]),
    ],
  );
  assert.deepEqual(result.perRule.G2_ABUSE.counts, {
    tp: 1,
    fp: 1,
    fn: 1,
    tn: 1,
  });
  assert.equal(result.perRule.G2_ABUSE.precision.value, 0.5);
  assert.equal(result.perRule.G2_ABUSE.recall.value, 0.5);
  assert.equal(result.benignFalsePositiveRate.value, 0.5);
  assert.equal(result.schemaFailureRate.value, 0.25);
  assert.equal(result.missingRate.value, 0.25);
  assert.equal(result.latencyMs.samples, 3);
  assert.equal(result.qualification.qualified, false);
});

test("completion validation rejects invented spans, extra fields, refusals and duplicate rules", () => {
  const valid = JSON.parse(completion(["G2_ABUSE"]));
  for (const raw of [
    "bad json",
    JSON.stringify({ ...valid, action: "ban" }),
    JSON.stringify({ ...valid, matches: [...valid.matches, ...valid.matches] }),
    JSON.stringify({
      ...valid,
      matches: [{ ...valid.matches[0], evidence: "invented" }],
    }),
    JSON.stringify({ verdict: "no_match", matches: [] }),
  ]) {
    assert.equal(validateCompletion(raw, "synthetic message"), null);
  }
  assert.equal(
    validateCompletion(completion(), "synthetic message").verdict,
    "no_match",
  );
});

test("uncertain, refusal, backend error and missing responses are distinct", () => {
  const rows = ["a", "b", "c", "d"].map((id) => example(id));
  const result = score(rows, [
    output("a", [], {
      raw: JSON.stringify({
        verdict: "uncertain",
        matches: [],
        uncertainty: "Context missing",
      }),
    }),
    { id: "b", status: "refusal", elapsedMs: 20 },
    { id: "c", status: "error", code: "unavailable", elapsedMs: 10 },
  ]);
  assert.equal(result.uncertaintyRate.value, 0.25);
  assert.equal(result.refusalRate.value, 0.25);
  assert.equal(result.errorRate.value, 0.25);
  assert.equal(result.missingRate.value, 0.25);
  assert.equal(result.schemaFailureRate.value, 0);
  assert.equal(result.schemaValidRate.value, 0.25);
});

test("Wilson intervals keep empty categories undefined and expose small perfect samples", () => {
  const result = score([example("a")], [output("a")]);
  assert.equal(result.perRule.G1_SPAM.precision.value, null);
  assert.equal(result.perRule.G1_SPAM.precision.wilson95, null);
  assert.deepEqual(
    result.schemaValidRate.wilson95.map((n) => Math.round(n * 1000)),
    [207, 1000],
  );
});

test("unknown, duplicated or inconsistent data cannot silently affect a score", () => {
  for (const [rows, results] of [
    [[example("a"), example("a")], []],
    [[example("a")], [output("a"), output("a")]],
    [[example("a")], [output("unknown")]],
    [[example("a", ["G9"])], []],
    [[example("a")], [output("a", [], { elapsedMs: -1 })]],
  ])
    assert.throws(() => score(rows, results));
});

test("200 synthetic development cases and claimed reviewers cannot qualify a model", () => {
  const rows = Array.from({ length: 200 }, (_, i) =>
    example(String(i), [RULES[i % 6]], {
      reviews: [
        { reviewerId: "a", human: true, independent: true },
        { reviewerId: "b", human: true, independent: true },
      ],
    }),
  );
  const result = score(
    rows,
    rows.map((row) => output(row.id, row.expected.ruleIds)),
  );
  assert.equal(result.qualification.qualified, false);
  assert.ok(
    result.qualification.blockers.includes(
      "requires_at_least_200_heldout_examples",
    ),
  );
});

test("heldout cases require complete independent human labels and development separation", () => {
  const row = example("held", ["G2_ABUSE"], {
    split: "heldout",
    reviews: [
      { reviewerId: "a", human: true, independent: true },
      { reviewerId: "b", human: true, independent: true },
    ],
  });
  const result = score([row], [output("held", ["G2_ABUSE"])], {
    development: [example("dev", [], { source: row.source })],
  });
  assert.ok(
    result.qualification.blockers.includes(
      "incomplete_independent_human_adjudication",
    ),
  );
  assert.ok(result.qualification.blockers.includes("development_overlap"));
});

test("development corpus covers the six rules and all required difficult categories", async () => {
  const { readJsonl } = await import("./score.mjs");
  const rows = readJsonl(
    new URL("./fixtures/development.jsonl", import.meta.url),
  );
  assert.equal(rows.length, 24);
  for (const rule of RULES)
    assert.ok(rows.some((row) => row.expected.ruleIds.includes(rule)));
  for (const tag of [
    "benign_near_match",
    "quotes_counterspeech",
    "profanity",
    "code_security",
    "uncertain_context",
    "prompt_injection",
  ])
    assert.ok(rows.some((row) => row.tags.includes(tag)));
  assert.ok(
    rows.every(
      (row) => row.split === "development" && row.reviews.length === 0,
    ),
  );
  assert.equal(score(rows, []).qualification.qualified, false);
});

test("production invalid_response errors count in schema failures", () => {
  const result = score(
    [example("a")],
    [{ id: "a", status: "error", code: "invalid_response", elapsedMs: 10 }],
  );
  assert.equal(result.schemaFailureRate.value, 1);
  assert.equal(result.errorRate.value, 0);
});

test("tool/refusal metadata and Unicode code-point evidence limits match native validation", () => {
  for (const field of ["tool_calls", "function_call", "refusal"])
    assert.equal(
      validateCompletion(
        JSON.stringify({ ...JSON.parse(completion()), [field]: [] }),
        "synthetic",
      ),
      null,
    );
  const match = {
    rule_id: "G2_ABUSE",
    evidence: "😀".repeat(128),
    reason: "reason",
  };
  assert.equal(
    validateCompletion(
      JSON.stringify({
        verdict: "needs_review",
        matches: [match],
        uncertainty: null,
      }),
      match.evidence,
    ).matches.length,
    1,
  );
  assert.equal(
    validateCompletion(
      JSON.stringify({
        verdict: "needs_review",
        matches: [{ ...match, evidence: "😀".repeat(129) }],
        uncertainty: null,
      }),
      "😀".repeat(129),
    ),
    null,
  );
});

test("severe recall is exposed separately for each rule", () => {
  const rows = [
    example("a", ["G2_ABUSE"]),
    example("b", ["G2_ABUSE"], {
      expected: {
        verdict: "needs_review",
        ruleIds: ["G2_ABUSE"],
        severeRuleIds: [],
      },
    }),
  ];
  const result = score(rows, [output("a"), output("b", ["G2_ABUSE"])]);
  assert.equal(result.perRule.G2_ABUSE.severeRecall.value, 0);
  assert.equal(result.perRule.G2_ABUSE.severeRecall.denominator, 1);
  assert.equal(result.perRule.G2_ABUSE.recall.value, 0.5);
});
