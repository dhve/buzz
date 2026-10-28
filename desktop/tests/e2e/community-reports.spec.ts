import { expect, test, type Page } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import { openSettings } from "../helpers/settings";

const channelId = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const report = {
  id: "report-fixture",
  reportEventId: "a".repeat(64),
  reporterPubkey: "b".repeat(64),
  targetKind: "event",
  target: "d".repeat(64),
  channelId,
  reportType: "other",
  note: "Private reviewer note",
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  actionId: null,
  createdAt: "2026-10-28T00:00:00Z",
};
async function start(
  page: Page,
  enabled = true,
  mode: "success" | "unsupported" | "delayed" = "success",
) {
  await installMockBridge(
    page,
    {
      relayRole: "owner",
      relayRequiresMembership: true,
      moderationJudge: { mode, delayMs: mode === "delayed" ? 800 : 0 },
    },
    { seedPreviewFeatures: false },
  );
  await page.addInitScript((enabled) => {
    localStorage.setItem(
      "buzz-feature-overrides-v1",
      JSON.stringify({ "moderation-judge": enabled }),
    );
  }, enabled);
  await page.route("**/moderation/reports?**", (route) =>
    route.fulfill({
      json: [
        {
          id: report.id,
          report_event_id: report.reportEventId,
          reporter_pubkey: report.reporterPubkey,
          target_kind: report.targetKind,
          target: report.target,
          channel_id: report.channelId,
          report_type: report.reportType,
          note: report.note,
          status: report.status,
          resolved_by: null,
          resolved_at: null,
          action_id: null,
          created_at: report.createdAt,
        },
      ],
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
      },
    }),
  );
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(
    page.getByText("React to me with a custom emoji", { exact: true }).first(),
  ).toBeVisible();
  await openSettings(page, "community-reports");
  const panel = page.getByTestId("settings-community-reports");
  await panel
    .getByRole("button", { name: "other report report-fixture, open" })
    .click();
  await expect(
    panel.getByRole("region", { name: "Human report decision" }),
  ).toBeVisible();
  return panel;
}
async function selectPolicy(page: Page) {
  const judge = page.getByTestId("moderation-judge-review");
  await judge
    .getByLabel("Review policy", { exact: true })
    .selectOption("builtin_v1");
  await judge
    .getByLabel("Local model", { exact: true })
    .selectOption("fixture-local-model");
  return judge;
}
async function requests(page: Page) {
  return page.evaluate(() =>
    (
      (
        window as unknown as {
          __BUZZ_E2E_COMMAND_PAYLOADS__: Array<{
            command: string;
            payload: unknown;
          }>;
        }
      ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []
    ).filter((entry) => entry.command === "review_moderation_report"),
  );
}
test("report queue stays fully human with the AI preview off", async ({
  page,
}) => {
  const panel = await start(page, false);
  await expect(panel.getByTestId("moderation-judge-review")).toHaveCount(0);
  await expect(
    panel.getByLabel("Reporter-readable reason (required)"),
  ).toBeEditable();
  await expect.poll(() => requests(page)).toHaveLength(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/community-reports-human.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("explicit policy and local model produce temporary advice without human action", async ({
  page,
}) => {
  const panel = await start(page);
  const review = panel.getByRole("button", {
    name: "Review with AI",
    exact: true,
  });
  await expect(review).toBeDisabled();
  await expect.poll(() => requests(page)).toHaveLength(0);
  const reason = panel.getByLabel("Reporter-readable reason (required)");
  await reason.fill("My own assessment");
  const judge = await selectPolicy(page);
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(
    judge.getByRole("heading", { name: "AI suggestion: no match" }),
  ).toBeVisible();
  await expect(reason).toHaveValue("My own assessment");
  await expect(
    panel.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeEnabled();
  await expect.poll(() => requests(page)).toHaveLength(1);
  const request = (await requests(page))[0].payload as {
    request: Record<string, unknown>;
  };
  expect(request.request.reportEventId).toBe(report.reportEventId);
  expect(request.request).not.toHaveProperty("source");
  expect(request.request).not.toHaveProperty("note");
  const enforcement = await page.evaluate(() =>
    (
      (
        window as unknown as {
          __BUZZ_E2E_SIGNED_EVENTS__: Array<{ kind: number }>;
        }
      ).__BUZZ_E2E_SIGNED_EVENTS__ ?? []
    ).filter((event) => event.kind >= 9040 && event.kind <= 9044),
  );
  expect(enforcement).toHaveLength(0);
  await judge.scrollIntoViewIfNeeded();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/community-reports-advice.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("unsupported local capability keeps human decisions available", async ({
  page,
}) => {
  const panel = await start(page, true, "unsupported");
  const judge = panel.getByTestId("moderation-judge-review");
  await expect(
    judge.getByRole("status").filter({ hasText: "unsupported" }),
  ).toContainText("unsupported");
  await expect(
    judge.getByRole("button", { name: "Review with AI", exact: true }),
  ).toBeDisabled();
  await panel
    .getByLabel("Reporter-readable reason (required)")
    .fill("Human review remains available");
  await expect(
    panel.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeEnabled();
  expect(await requests(page)).toHaveLength(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/community-reports-unsupported.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("navigation cancels a delayed review and never displays its completion", async ({
  page,
}) => {
  const panel = await start(page, true, "delayed");
  await selectPolicy(page);
  await panel
    .getByRole("button", { name: "Review with AI", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Cancel AI review" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Back to reports" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            (window as unknown as { __BUZZ_E2E_COMMANDS__: string[] })
              .__BUZZ_E2E_COMMANDS__ ?? []
          ).filter((command) => command === "cancel_moderation_review").length,
      ),
    )
    .toBe(1);
  await expect(
    panel.getByRole("button", { name: "other report report-fixture, open" }),
  ).toBeVisible();
  await page.waitForTimeout(900);
  await expect(
    panel.getByRole("heading", { name: "AI suggestion: no match" }),
  ).toHaveCount(0);
});
