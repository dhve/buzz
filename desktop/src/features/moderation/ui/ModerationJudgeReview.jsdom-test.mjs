import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { fireEvent, within } from "@testing-library/react";
import { ModerationJudgeReview } from "./ModerationJudgeReview.tsx";
import { emitChange } from "@/shared/features/useFeatureEnabled";

const calls = [];
let completion;
let status = {
  available: true,
  reason: null,
  localModelIds: ["local-model", "other-model"],
  activeRequestId: null,
  runtimeId: "runtime1",
};
const ipc = {
  invoke(command, args) {
    calls.push({ command, args });
    if (command === "moderation_judge_status") return Promise.resolve(status);
    if (command === "cancel_moderation_review") return Promise.resolve();
    if (command === "review_moderation_report")
      return new Promise((resolve, reject) => {
        completion = { resolve, reject };
      });
    throw new Error(`Unexpected command ${command}`);
  },
};
globalThis.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ = ipc;
const report = {
  id: "database-id",
  reportEventId: "a".repeat(64),
  reporterPubkey: "b".repeat(64),
  targetKind: "event",
  target: "c".repeat(64),
  channelId: "channel",
  reportType: "other",
  note: "PRIVATE NOTE CANARY",
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  actionId: null,
  createdAt: "2026-10-28",
};
const source = {
  id: report.target,
  pubkey: "d".repeat(64),
  kind: 9,
  content: "send me your password",
  tags: [["h", "channel"]],
  created_at: 1,
  sig: "e".repeat(128),
};
const scope = {
  relayUrl: "wss://community.example",
  signerPubkey: "f".repeat(64),
  isCurrent: () => true,
};
let cleanup;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  calls.length = 0;
  completion = undefined;
  status = {
    available: true,
    reason: null,
    localModelIds: ["local-model", "other-model"],
    activeRequestId: null,
    runtimeId: "runtime1",
  };
  localStorage.clear();
  emitChange();
});
async function mount(overrides = {}, enabled = true) {
  if (enabled)
    localStorage.setItem(
      "buzz-feature-overrides-v1",
      JSON.stringify({ "moderation-judge": true }),
    );
  emitChange();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let props = {
    report,
    source,
    scope,
    contextKey: "owner:open:runtime1",
    eligible: true,
    ...overrides,
  };
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await act(async () => {
      root.render(
        React.createElement(
          "div",
          {},
          React.createElement(ModerationJudgeReview, props),
          React.createElement(
            "label",
            {},
            "Reporter-visible reason",
            React.createElement("input", {
              "aria-label": "Reporter-visible reason",
              defaultValue: "human words",
            }),
          ),
          React.createElement("button", { type: "button" }, "Dismiss report"),
        ),
      );
    });
  };
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await render();
  return { container, ui: within(container), render };
}
async function choose(ui) {
  await act(async () =>
    fireEvent.change(ui.getByLabelText("Review policy"), {
      target: { value: "builtin_v1" },
    }),
  );
  await act(async () =>
    fireEvent.change(ui.getByLabelText("Local model"), {
      target: { value: "local-model" },
    }),
  );
}
async function click(ui, name) {
  await act(async () => fireEvent.click(ui.getByRole("button", { name })));
}
function requests() {
  return calls.filter((c) => c.command === "review_moderation_report");
}
function result(requestId, extra = {}) {
  return {
    verdict: "needs_review",
    matches: [
      {
        rule_id: "G4_MALICIOUS_DECEPTION",
        evidence: "send me your password",
        reason: "A credential request.",
      },
    ],
    uncertainty: null,
    provenance: {
      sourceDigest: "1".repeat(64),
      policyDigest: "2".repeat(64),
      policySource: "builtin_template",
      policyVersion: "buzz-moderation-guidelines/v1",
      promptVersion: "buzz-moderation-judge/v1",
      requestGeneration: "1",
      requestId,
      requestedModel: "local-model",
      reportedModel: "local-model",
      meshVersion: "test",
      runtimeId: "runtime1",
      startedAtMs: 1,
      elapsedMs: 2,
    },
    ...extra,
  };
}

// Removing the preview gate would expose controls and issue status IPC by default.
test("preview defaults off and leaves human decisions usable", async () => {
  const { ui } = await mount({}, false);
  assert.equal(ui.queryByRole("button", { name: "Review with AI" }), null);
  assert.equal(calls.length, 0);
  assert.ok(ui.getByRole("button", { name: "Dismiss report" }));
});
// Removing either explicit selection or forwarding reporter text would fail this contract.
test("explicit selections start one scoped request with no private content or signed actions", async () => {
  const { ui } = await mount();
  const review = ui.getByRole("button", { name: "Review with AI" });
  assert.equal(review.disabled, true);
  assert.equal(requests().length, 0);
  await choose(ui);
  await click(ui, "Review with AI");
  await click(ui, "Review with AI");
  assert.equal(requests().length, 1);
  const request = requests()[0].args.request;
  assert.deepEqual(
    Object.keys(request).sort(),
    [
      "expectedRelayUrl",
      "expectedSignerPubkey",
      "modelId",
      "policy",
      "reportEventId",
      "requestId",
    ].sort(),
  );
  assert.equal(request.reportEventId, report.reportEventId);
  assert.deepEqual(request.policy, { kind: "builtin_v1" });
  assert.equal(request.expectedRelayUrl, scope.relayUrl);
  await act(async () => completion.resolve(result(request.requestId)));
  assert.ok(ui.getByText("A credential request."));
  assert.equal(
    ui.getByLabelText("Reporter-visible reason").value,
    "human words",
  );
  assert.equal(
    calls.some((c) => /sign|publish|resolve_report|ban_member/.test(c.command)),
    false,
  );
});
// Suppressing stale promises must survive every observed context change.
for (const [boundary, changes] of Object.entries({
  report: { report: { ...report, reportEventId: "9".repeat(64) } },
  community: { scope: { ...scope, relayUrl: "wss://other.example" } },
  identity: { scope: { ...scope, signerPubkey: "8".repeat(64) } },
  source: { source: { ...source, content: "edited text" } },
  privacy: { contextKey: "owner:private:runtime1", eligible: false },
  role: { eligible: false },
  runtime: { contextKey: "owner:open:runtime2" },
  resolved: { report: { ...report, status: "resolved" } },
})) {
  test(`discard and cancel delayed result after ${boundary} changes`, async () => {
    const { ui, render } = await mount();
    await choose(ui);
    await click(ui, "Review with AI");
    const pending = completion;
    const requestId = requests()[0].args.request.requestId;
    await render(changes);
    await act(async () => pending.resolve(result(requestId)));
    assert.equal(!!ui.queryByText("A credential request."), false);
    assert.ok(
      calls.some(
        (c) =>
          c.command === "cancel_moderation_review" &&
          c.args.requestId === requestId,
      ),
    );
  });
}
test("model and policy changes cancel and clear a pending review", async () => {
  const { ui } = await mount();
  await choose(ui);
  await click(ui, "Review with AI");
  const pending = completion;
  const id = requests()[0].args.request.requestId;
  await act(async () =>
    fireEvent.change(ui.getByLabelText("Local model"), {
      target: { value: "other-model" },
    }),
  );
  await act(async () => pending.resolve(result(id)));
  assert.equal(!!ui.queryByText("A credential request."), false);
  assert.ok(calls.some((c) => c.command === "cancel_moderation_review"));
  await act(async () =>
    fireEvent.change(ui.getByLabelText("Review policy"), {
      target: { value: "review_override" },
    }),
  );
  assert.equal(ui.getAllByRole("textbox").length, 7);
});
test("cancel then explicit retry ignores older completion", async () => {
  const { ui } = await mount();
  await choose(ui);
  await click(ui, "Review with AI");
  const old = completion;
  const id = requests()[0].args.request.requestId;
  await click(ui, "Cancel AI review");
  assert.ok(ui.getByRole("status").textContent.includes("cancel"));
  await click(ui, "Review with AI");
  const current = completion;
  await act(async () => old.resolve(result(id)));
  assert.equal(!!ui.queryByText("A credential request."), false);
  await act(async () =>
    current.resolve(result(requests()[1].args.request.requestId)),
  );
  assert.ok(ui.getByText("A credential request."));
});
for (const code of [
  "unsupported",
  "unavailable",
  "timeout",
  "invalid_response",
  "cancelled",
  "stale",
  "busy",
  "inaccessible",
  "invalid_request",
]) {
  test(`${code} is an error, preserves human controls and requires explicit retry`, async () => {
    const { ui } = await mount();
    await choose(ui);
    await click(ui, "Review with AI");
    await act(async () => completion.reject({ code }));
    assert.ok(ui.getByRole("alert").textContent.includes(code));
    assert.ok(ui.getByRole("button", { name: "Dismiss report" }));
    assert.equal(requests().length, 1);
    assert.equal(
      ui.getByLabelText("Reporter-visible reason").value,
      "human words",
    );
  });
}
test("malformed and mismatched completions never become advice", async () => {
  const { ui } = await mount();
  await choose(ui);
  for (const malformed of [
    { verdict: "no_match" },
    result("wrong"),
    result("", {
      matches: [
        {
          rule_id: "UNKNOWN",
          evidence: "fake",
          reason: "A credential request.",
        },
      ],
    }),
  ]) {
    await click(ui, "Review with AI");
    await act(async () => completion.resolve(malformed));
    assert.ok(ui.getByRole("alert"));
    assert.equal(!!ui.queryByText("A credential request."), false);
  }
});
test("unavailable native capability never offers generic catalog models or inference", async () => {
  status = {
    available: false,
    reason: "unsupported",
    localModelIds: [],
    activeRequestId: null,
    runtimeId: "runtime1",
  };
  const { ui } = await mount();
  assert.ok(ui.getByRole("status").textContent.includes("unsupported"));
  assert.equal(
    ui.getByRole("button", { name: "Review with AI" }).disabled,
    true,
  );
  assert.equal(requests().length, 0);
});

test("runtime replacement and capability loss clear displayed advice", async () => {
  const { ui } = await mount();
  await choose(ui);
  await click(ui, "Review with AI");
  await act(async () =>
    completion.resolve(result(requests()[0].args.request.requestId)),
  );
  assert.ok(ui.getByText("A credential request."));
  status = { ...status, runtimeId: "runtime2" };
  await click(ui, "Refresh AI availability");
  assert.equal(!!ui.queryByText("A credential request."), false);
  status = {
    ...status,
    available: false,
    reason: "unsupported",
    localModelIds: [],
  };
  await click(ui, "Refresh AI availability");
  assert.equal(
    ui.getByRole("button", { name: "Review with AI" }).disabled,
    true,
  );
});
test("native busy guard and empty model list prevent requests", async () => {
  status = { ...status, activeRequestId: "other-review" };
  const { ui } = await mount();
  await choose(ui);
  assert.equal(
    ui.getByRole("button", { name: "Review with AI" }).disabled,
    true,
  );
  assert.equal(requests().length, 0);
});
test("editing fixed rule text cancels pending override and preserves rule IDs", async () => {
  const { ui } = await mount();
  await choose(ui);
  await act(async () =>
    fireEvent.change(ui.getByLabelText("Review policy"), {
      target: { value: "review_override" },
    }),
  );
  await act(async () =>
    fireEvent.change(ui.getByLabelText("G1_SPAM"), {
      target: { value: "A review-specific spam rule." },
    }),
  );
  await click(ui, "Review with AI");
  const { request } = requests()[0].args;
  assert.equal(request.policy.kind, "review_override");
  assert.deepEqual(
    request.policy.rules.map((rule) => rule.id),
    [
      "G1_SPAM",
      "G2_ABUSE",
      "G3_PRIVACY",
      "G4_MALICIOUS_DECEPTION",
      "G5_SEXUAL_ABUSE",
      "G6_IMMEDIATE_HARM",
    ],
  );
  assert.equal(request.policy.rules[0].text, "A review-specific spam rule.");
  const pending = completion;
  await act(async () =>
    fireEvent.change(ui.getByLabelText("G1_SPAM"), {
      target: { value: "A second rule." },
    }),
  );
  await act(async () => pending.resolve(result(request.requestId)));
  assert.equal(!!ui.queryByText("A credential request."), false);
  assert.ok(calls.some((c) => c.command === "cancel_moderation_review"));
});
test("unmount cancels pending inference", async () => {
  const { ui } = await mount();
  await choose(ui);
  await click(ui, "Review with AI");
  const requestId = requests()[0].args.request.requestId;
  await cleanup();
  cleanup = undefined;
  assert.ok(
    calls.some(
      (c) =>
        c.command === "cancel_moderation_review" &&
        c.args.requestId === requestId,
    ),
  );
});
test("a scope becoming stale suppresses a response without another request", async () => {
  let current = true;
  const { ui } = await mount({ scope: { ...scope, isCurrent: () => current } });
  await choose(ui);
  await click(ui, "Review with AI");
  current = false;
  await act(async () =>
    completion.resolve(result(requests()[0].args.request.requestId)),
  );
  assert.equal(!!ui.queryByText("A credential request."), false);
  assert.equal(requests().length, 1);
});
test("plaintext evidence renders safely and unknown fields or fake evidence are rejected", async () => {
  const content = '<img src=x onerror="alert(1)">';
  const { ui, container } = await mount({ source: { ...source, content } });
  await choose(ui);
  await click(ui, "Review with AI");
  const id = requests()[0].args.request.requestId;
  await act(async () =>
    completion.resolve(
      result(id, {
        matches: [
          {
            rule_id: "G4_MALICIOUS_DECEPTION",
            evidence: content,
            reason: "Quoted content.",
          },
        ],
      }),
    ),
  );
  assert.equal(container.querySelector("img"), null);
  assert.ok(ui.getByText(content));
  for (const change of [
    {
      matches: [
        {
          rule_id: "G4_MALICIOUS_DECEPTION",
          evidence: "fake evidence",
          reason: "Explanation",
        },
      ],
    },
    { action: "ban" },
    { verdict: "no_match", matches: [], uncertainty: null, provenance: null },
  ]) {
    await click(ui, "Review with AI");
    await act(async () =>
      completion.resolve(
        result(requests().at(-1).args.request.requestId, change),
      ),
    );
    assert.ok(ui.getByRole("alert"));
    assert.equal(ui.queryByText("Quoted content."), null);
  }
});

// A newly observed native request replaces the context of displayed advice.
test("another active native review invalidates existing advice", async () => {
  const { ui } = await mount();
  await choose(ui);
  await click(ui, "Review with AI");
  await act(async () =>
    completion.resolve(result(requests()[0].args.request.requestId)),
  );
  assert.ok(ui.getByText("A credential request."));
  status = { ...status, activeRequestId: "external-review" };
  await click(ui, "Refresh AI availability");
  assert.equal(!!ui.queryByText("A credential request."), false);
  assert.equal(
    ui.getByRole("button", { name: "Review with AI" }).disabled,
    true,
  );
});

// The displayed builtin rules must match the actual native builtin policy.
test("switching an edited copy back to the template shows the original policy", async () => {
  const { ui } = await mount();
  await choose(ui);
  await act(async () =>
    fireEvent.change(ui.getByLabelText("Review policy"), {
      target: { value: "review_override" },
    }),
  );
  await act(async () =>
    fireEvent.change(ui.getByLabelText("G1_SPAM"), {
      target: { value: "Only my edited copy" },
    }),
  );
  await act(async () =>
    fireEvent.change(ui.getByLabelText("Review policy"), {
      target: { value: "builtin_v1" },
    }),
  );
  assert.equal(!!ui.queryByText("Only my edited copy"), false);
  await click(ui, "Review with AI");
  assert.deepEqual(requests()[0].args.request.policy, { kind: "builtin_v1" });
});

test("observed private channel eligibility explains why AI cannot start", async () => {
  const { ui } = await mount({
    eligible: false,
    ineligibleReason: "AI review is unavailable for private channels.",
  });
  assert.ok(ui.queryByText("AI review is unavailable for private channels."));
  assert.equal(
    ui.getByRole("button", { name: "Review with AI" }).disabled,
    true,
  );
  assert.equal(requests().length, 0);
});
