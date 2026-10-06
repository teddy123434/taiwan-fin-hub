import { expect, test } from "@playwright/test";

const width = 1440;
test(`activity API failure can recover without misleading empty data at ${width}px`, async ({
  page,
}) => {
  await page.setViewportSize({ width, height: 900 });
  let bankFailed = true;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (path === "/api/bank" && bankFailed) {
      await route.fulfill({
        status: 500,
        json: { error: { code: "TEST_FAILURE", message: "暫時無法載入" } },
      });
      return;
    }
    await route.fulfill({
      json:
        path === "/api/runtime"
          ? { demoMode: true }
          : path === "/api/bank"
            ? { accounts: [], transactions: [] }
            : [],
    });
  });
  await page.goto("/#/activity");
  await expect(page.getByRole("alert")).toContainText("部分資料載入失敗", {
    timeout: 15000,
  });
  await expect(
    page.getByText("沒有符合條件的活動。", { exact: true }),
  ).not.toBeVisible();
  bankFailed = false;
  await page.getByRole("button", { name: /重試|重新載入/ }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page
      .getByText("沒有符合條件的活動。", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
});
