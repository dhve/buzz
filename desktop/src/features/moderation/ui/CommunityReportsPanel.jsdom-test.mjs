// Production journey: removing enforcement, authorization, or decision-only
// recovery must change the wire events or visible outcome in these tests.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, getByRole, queryByRole } from "@testing-library/react";
import { renderSettingsSection } from "@/features/settings/ui/SettingsPanels.tsx";
import { relayClient } from "@/shared/api/relayClient";

const me = "ab".repeat(32),
  author = "cd".repeat(32),
  target = "ef".repeat(32);
const reportId = "12".repeat(32),
  channelId = "7e080000-0000-4000-8000-000000000001";
const canonical = {
  id: target,
  pubkey: author,
  kind: 9,
  content: "<script>plain target</script>",
  tags: [["h", channelId]],
  created_at: 10,
  sig: "00".repeat(64),
};
const originalFetch = globalThis.fetch;
let mounted;
const rawReport = (overrides = {}) => ({
  id: "db-uuid",
  report_event_id: reportId,
  reporter_pubkey: "34".repeat(32),
  target_kind: "event",
  target,
  channel_id: channelId,
  report_type: "spam",
  note: "Private report note",
  status: "open",
  resolved_by: null,
  resolved_at: null,
  action_id: null,
  created_at: "2026-10-28T00:00:00Z",
  ...overrides,
});

async function setup({ role = "owner", rows = [rawReport()] } = {}) {
  const state = {
    rows,
    requests: [],
    signed: [],
    sent: [],
    native: [],
    failKind: null,
    failNative: false,
    identity: me,
    relay: "wss://community.example",
    beforeSign: null,
    beforeFetch: null,
    role,
    targetVisible: true,
    targetEvent: structuredClone(canonical),
    operations: [],
  };
  const deliver = (frame) =>
    relayClient.handleWsMessage(
      { type: "Text", data: JSON.stringify(frame) },
      relayClient.connectionGeneration,
    );
  relayClient.wsId = 7;
  const ipc = {
    transformCallback: () => 1,
    invoke: async (cmd, args) => {
      if (cmd === "get_identity")
        return { pubkey: state.identity, display_name: "Reviewer" };
      if (cmd === "get_relay_ws_url") return state.relay;
      if (cmd === "get_relay_http_url")
        return state.relay.replace("wss:", "https:");
      if (cmd === "relay_requires_membership") {
        if (state.membershipError)
          throw new Error("Membership lookup unavailable");
        return true;
      }
      if (cmd === "get_channel_details")
        return {
          id: channelId,
          name: "general",
          channel_type: "stream",
          visibility: "open",
          description: "",
          topic: null,
          purpose: null,
          member_count: 2,
          member_pubkeys: [me, author],
          last_message_at: null,
          archived_at: null,
          participants: [],
          participant_pubkeys: [],
          is_member: true,
          ttl_seconds: null,
          ttl_deadline: null,
          created_by: me,
          created_at: "2026-10-28T00:00:00Z",
          updated_at: "2026-10-28T00:00:00Z",
          topic_set_by: null,
          topic_set_at: null,
          purpose_set_by: null,
          purpose_set_at: null,
          topic_required: false,
          max_members: null,
          nip29_group_id: null,
        };
      if (cmd === "sign_event") {
        state.signed.push(args);
        if (state.beforeSign) await state.beforeSign(args);
        return JSON.stringify({
          ...args,
          pubkey: state.identity,
          created_at: 10,
          sig: "00".repeat(64),
          id: String(state.signed.length).padStart(64, "0"),
        });
      }
      if (cmd === "plugin:websocket|send") {
        const frame = JSON.parse(args.message.data);
        if (frame[0] === "REQ") {
          const event = frame[2].kinds?.includes(13534)
            ? { ...canonical, kind: 13534, tags: [["member", me, state.role]] }
            : state.targetVisible
              ? state.targetEvent
              : null;
          queueMicrotask(async () => {
            if (event) await deliver(["EVENT", frame[1], event]);
            await deliver(["EOSE", frame[1]]);
          });
        }
        if (frame[0] === "EVENT") {
          state.sent.push(frame[1]);
          state.operations.push(frame[1].kind);
          const ok = frame[1].kind !== state.failKind;
          queueMicrotask(() =>
            deliver(["OK", frame[1].id, ok, ok ? "" : "permission denied"]),
          );
        }
        return;
      }
      if (["delete_message", "remove_channel_member"].includes(cmd)) {
        state.native.push({ cmd, args });
        state.operations.push(cmd);
        if (state.failNative) throw new Error("Channel permission denied");
        return;
      }
      if (cmd === "plugin:websocket|disconnect") return;
      return new Promise(() => {});
    },
  };
  globalThis.__TAURI_INTERNALS__ = ipc;
  window.__TAURI_INTERNALS__ = ipc;
  globalThis.fetch = async (url, options) => {
    state.requests.push(String(url));
    const auth = JSON.parse(atob(options.headers.Authorization.slice(6)));
    assert.deepEqual(
      auth.tags.find((t) => t[0] === "u"),
      ["u", String(url)],
    );
    if (state.beforeFetch) await state.beforeFetch();
    const status = new URL(url).searchParams.get("status");
    return new Response(
      JSON.stringify(
        state.rows.filter((row) => !status || row.status === status),
      ),
      { status: 200 },
    );
  };
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  qc.setQueryData(["identity"], { pubkey: me });
  qc.setQueryData(["myRelayMembershipLookup"], {
    snapshotFound: true,
    membershipRequired: true,
    membership: role ? { pubkey: me, role } : null,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        renderSettingsSection("community-reports", {}),
      ),
    ),
  );
  mounted = { root, container, qc };
  await settle();
  return { ...mounted, state };
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}
async function click(container, name) {
  await act(async () =>
    fireEvent.click(getByRole(container, "button", { name, exact: true })),
  );
  await settle();
}
async function selectReport(view) {
  await click(view.container, /spam report/);
}
async function setReason(container) {
  await act(async () =>
    fireEvent.change(
      getByRole(container, "textbox", { name: /Reporter-readable reason/ }),
      { target: { value: "Community rules" } },
    ),
  );
}
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted.root.unmount());
    mounted.qc.clear();
    mounted.container.remove();
    mounted = null;
  }
  globalThis.fetch = originalFetch;
  relayClient.wsId = null;
});

test("queue guards access, filters and refreshes a bounded list, and shows target as plain text", async () => {
  const view = await setup();
  assert.ok(view.state.requests[0]?.includes("limit=500"));
  assert.ok(view.state.requests[0]?.includes("status=open"));
  await selectReport(view);
  assert.match(view.container.textContent, /Channel visibility: open/);
  assert.match(view.container.textContent, /Private report note/);
  assert.match(view.container.textContent, /<script>plain target<\/script>/);
  assert.equal(view.container.querySelector("script"), null);
  assert.equal(view.state.sent.length, 0);
  await click(view.container, "Back to reports");
  await act(async () =>
    fireEvent.change(
      getByRole(view.container, "combobox", { name: "Report status" }),
      { target: { value: "dismissed" } },
    ),
  );
  await settle();
  assert.match(view.container.textContent, /No reports/);
  await click(view.container, "Refresh reports");
  assert.ok(
    view.state.requests.filter((url) => url.includes("status=dismissed"))
      .length >= 2,
  );
});

test("ordinary members and absent community membership cannot read the queue", async () => {
  for (const role of ["member", null]) {
    const view = await setup({ role });
    assert.match(view.container.textContent, /owner or admin/);
    assert.equal(view.state.requests.length, 0);
    await act(async () => view.root.unmount());
    view.container.remove();
    view.qc.clear();
    mounted = null;
  }
});

test("explicit human choices publish real decision tags after the matching enforcement", async () => {
  for (const [label, action, kind, native] of [
    ["Dismiss", "dismiss", null],
    ["Escalate", "escalate", null],
    ["Ban member", "ban", 9040],
    ["Time out member", "timeout", 9042],
    ["Delete message", "delete", null, "delete_message"],
    ["Kick from channel", "kick", null, "remove_channel_member"],
  ]) {
    const view = await setup();
    await selectReport(view);
    await setReason(view.container);
    await click(view.container, label);
    assert.match(view.container.textContent, /Decision recorded/);
    const events = view.state.sent;
    assert.deepEqual(
      events.map((event) => event.kind),
      kind ? [kind, 9044] : [9044],
    );
    const decision = events.at(-1);
    assert.deepEqual(decision.tags, [
      ["report", reportId],
      ["status", action === "dismiss" ? "dismissed" : "resolved"],
      ["action", action],
      ["reason", "Community rules"],
    ]);
    if (kind) assert.deepEqual(events[0].tags[0], ["p", author]);
    if (kind === 9042)
      assert.ok(
        Number(events[0].tags.find((t) => t[0] === "expiration")[1]) >
          Date.now() / 1000,
      );
    if (native) {
      assert.deepEqual(view.state.operations, [native, 9044]);
      assert.equal(view.state.native[0].cmd, native);
      assert.equal(
        view.state.native[0].args.expectedRelayUrl,
        "wss://community.example",
      );
      assert.equal(view.state.native[0].args.expectedSignerPubkey, me);
      assert.equal(
        view.state.native[0].args[
          native === "delete_message" ? "eventId" : "pubkey"
        ],
        native === "delete_message" ? target : author,
      );
    }
    await act(async () => view.root.unmount());
    view.container.remove();
    view.qc.clear();
    mounted = null;
  }
});

test("failed enforcement stays open; partial success exposes only decision retry and never repeats enforcement", async () => {
  const view = await setup();
  await selectReport(view);
  await setReason(view.container);
  view.state.failNative = true;
  await click(view.container, "Kick from channel");
  assert.match(
    getByRole(view.container, "alert").textContent,
    /not confirmed|failed/i,
  );
  assert.equal(view.state.sent.length, 0);
  // A failed/uncertain enforcement never silently retries or offers another enforcement.
  assert.equal(
    queryByRole(view.container, "button", { name: "Kick from channel" }),
    null,
  );
  assert.match(view.container.textContent, /Check.*before/i);
});

test("successful enforcement followed by decision failure retries the same decision only", async () => {
  const view = await setup();
  await selectReport(view);
  await setReason(view.container);
  view.state.failKind = 9044;
  await click(view.container, "Ban member");
  assert.match(view.container.textContent, /Enforcement succeeded/);
  assert.equal(
    queryByRole(view.container, "button", { name: "Ban member" }),
    null,
  );
  view.state.failKind = null;
  await click(view.container, "Retry decision only");
  assert.deepEqual(
    view.state.sent.map((event) => event.kind),
    [9040, 9044, 9044],
  );
  assert.match(view.container.textContent, /Decision recorded/);
});

test("fresh validation rejects resolved reports before enforcement", async () => {
  const view = await setup();
  await selectReport(view);
  await setReason(view.container);
  view.state.rows[0].status = "dismissed";
  await click(view.container, "Ban member");
  assert.equal(view.state.sent.length, 0);
  assert.match(view.container.textContent, /no longer open/);
});

test("identity changing while signing fences publication", async () => {
  const view = await setup();
  await selectReport(view);
  await setReason(view.container);
  view.state.beforeSign = (args) => {
    if (args.kind === 9040) view.state.identity = "98".repeat(32);
  };
  await click(view.container, "Ban member");
  assert.equal(view.state.sent.length, 0);
  assert.match(view.container.textContent, /changed|stale/i);
});

test("fresh native scope and membership validation fences writes before signing", async () => {
  for (const change of [
    (state) => {
      state.role = "member";
    },
    (state) => {
      state.relay = "wss://other.example";
    },
    (state) => {
      state.identity = "98".repeat(32);
    },
  ]) {
    const view = await setup();
    await selectReport(view);
    await setReason(view.container);
    change(view.state);
    await click(view.container, "Ban member");
    assert.equal(view.state.sent.length, 0);
    assert.equal(view.state.native.length, 0);
    assert.equal(
      view.state.signed.filter(
        (event) => event.kind === 9040 || event.kind === 9044,
      ).length,
      0,
    );
    assert.match(
      getByRole(view.container, "alert").textContent,
      /owner or admin|changed/,
    );
    await act(async () => view.root.unmount());
    view.container.remove();
    view.qc.clear();
    mounted = null;
  }
});

test("target author is read again before enforcement; inaccessible targets cannot supply an event ID as a pubkey", async () => {
  const view = await setup();
  await selectReport(view);
  await setReason(view.container);
  view.state.targetEvent.pubkey = "56".repeat(32);
  await click(view.container, "Ban member");
  assert.deepEqual(view.state.sent[0].tags[0], ["p", "56".repeat(32)]);
});

test("pubkey and blob reports expose only applicable actions; an unreadable event has no author actions", async () => {
  for (const [kind, readable, hasBan] of [
    ["pubkey", true, true],
    ["blob", true, false],
    ["event", false, false],
  ]) {
    const view = await setup({ rows: [rawReport({ target_kind: kind })] });
    view.state.targetVisible = readable;
    await selectReport(view);
    assert.equal(
      !!queryByRole(view.container, "button", { name: "Ban member" }),
      hasBan,
    );
    assert.equal(
      queryByRole(view.container, "button", { name: "Delete message" }),
      null,
    );
    assert.equal(
      queryByRole(view.container, "button", { name: "Kick from channel" }),
      null,
    );
    await setReason(view.container);
    await click(view.container, "Dismiss");
    assert.deepEqual(
      view.state.sent.map((event) => event.kind),
      [9044],
    );
    await act(async () => view.root.unmount());
    view.container.remove();
    view.qc.clear();
    mounted = null;
  }
});

test("the rendered queue stays bounded even if the endpoint returns excess rows", async () => {
  const rows = Array.from({ length: 501 }, (_, i) =>
    rawReport({ id: `row-${i}` }),
  );
  const view = await setup({ rows });
  assert.equal(
    view.container.querySelectorAll('button[aria-label^="spam report"]').length,
    500,
  );
});

test("decision-only recovery never claims enforcement for a dismissal", async () => {
  const view = await setup();
  await selectReport(view);
  await setReason(view.container);
  view.state.failKind = 9044;
  await click(view.container, "Dismiss");
  view.state.role = "member";
  await click(view.container, "Retry decision only");
  assert.doesNotMatch(view.container.textContent, /Enforcement succeeded/);
  assert.match(view.container.textContent, /No enforcement was sent/);
  assert.deepEqual(
    view.state.sent.map((event) => event.kind),
    [9044],
  );
});

test("a failed permission refresh never reuses cached owner authority to read reports", async () => {
  const view = await setup();
  const before = view.state.requests.length;
  view.state.membershipError = true;
  await click(view.container, "Refresh reports");
  assert.equal(view.state.requests.length, before);
  assert.match(
    view.container.textContent,
    /Community permissions could not be checked/,
  );
});

test("an observed identity switch permanently invalidates an older signed action even after switching back", async () => {
  const view = await setup();
  await selectReport(view);
  await setReason(view.container);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  view.state.beforeSign = (args) => (args.kind === 9040 ? gate : undefined);
  await click(view.container, "Ban member");
  await act(async () => {
    view.state.identity = "98".repeat(32);
    view.qc.setQueryData(["identity"], { pubkey: view.state.identity });
  });
  await settle();
  await act(async () => {
    view.state.identity = me;
    view.qc.setQueryData(["identity"], { pubkey: me });
  });
  await settle();
  await act(async () => release());
  await settle();
  assert.equal(view.state.sent.length, 0);
});
