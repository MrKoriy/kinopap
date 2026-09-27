/**
 * Социальные e2e-флоу: поиск из шапки, голос, подписка,
 * дерево комментариев (корень → ответ → мягкое удаление),
 * страница «Мои подписки». Состояние сбрасывается через API —
 * оба проекта (webkit/chromium) идут по одним и тем же данным.
 */
import { expect, test, request as pwRequest, type Page } from "@playwright/test";

const E2E_USER = { email: "e2e@zal.dev", password: "e2e-password-123" };

async function loginApi() {
  const api = await pwRequest.newContext({ baseURL: "http://localhost:3001" });
  const login = await api.post("/v1/auth/login", { data: E2E_USER });
  expect(login.ok()).toBe(true);
  const { tokens } = (await login.json()) as { tokens: { accessToken: string } };
  return { api, auth: { authorization: `Bearer ${tokens.accessToken}` } };
}

async function loginUi(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("email-input").fill(E2E_USER.email);
  await page.getByTestId("password-input").fill(E2E_USER.password);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("header-user")).toBeVisible();
}

test("поиск из шапки находит тайтл по названию", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("search-input").fill("Тестовый");
  await page.getByTestId("search-submit").click();

  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.getByTestId("search-title")).toContainText("Тестовый");
  await expect(page.getByTestId("search-results")).toBeVisible();

  await page.getByTestId("item-card").first().click();
  await expect(page.getByTestId("item-title")).toHaveText("Тестовый фильм");
});

test("голос, подписка, дерево комментариев и страница подписок", async ({ page }, testInfo) => {
  await loginUi(page);

  // Сброс состояния прошлых прогонов через API.
  const { api, auth } = await loginApi();
  const catalog = await api.get("/v1/items?limit=5", { headers: auth });
  expect(catalog.ok()).toBe(true);
  const itemId = ((await catalog.json()) as { items: { id: number }[] }).items[0]!.id;
  await api.delete(`/v1/items/${itemId}/vote`, { headers: auth });
  await api.delete(`/v1/subscriptions/${itemId}`, { headers: auth });

  await page.goto(`/item/${itemId}`);
  await expect(page.getByTestId("item-actions")).toBeVisible();

  // Голос: оптимистичный UI, сервер подтверждает.
  await page.getByTestId("vote-up").click();
  await expect(page.getByTestId("vote-up")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("vote-positive")).toHaveText("1");

  // Подписка на новые серии.
  const subButton = page.getByTestId("subscribe-button");
  await expect(subButton).toContainText("Подписаться");
  await subButton.click();
  await expect(subButton).toContainText("Вы подписаны");

  // Комментарий: корень и вложенный ответ с уникальным текстом.
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const rootText = `e2e корень ${suffix}`;
  await page.getByTestId("comment-form-input").fill(rootText);
  await page.getByTestId("comment-form-submit").click();
  const rootItem = page.locator('[data-testid="comment-item"]').filter({ hasText: rootText });
  await expect(rootItem).toBeVisible();
  const rootId = await rootItem.getAttribute("data-comment-id");
  // Карточка узла — прямой div-li: кнопки вложенных ответов не мешают.
  const rootCard = page.locator(
    `[data-testid="comment-item"][data-comment-id="${rootId}"] > div`,
  );

  const replyText = `e2e ответ ${suffix}`;
  await rootCard.getByTestId("reply-button").click();
  await rootCard.getByTestId("reply-form-input").fill(replyText);
  await rootCard.getByTestId("reply-form-submit").click();
  const replyItem = page
    .locator('[data-testid="comment-item"]')
    .filter({ hasText: replyText })
    .last();
  await expect(replyItem).toBeVisible();
  const replyId = await replyItem.getAttribute("data-comment-id");
  const replyCard = page.locator(
    `[data-testid="comment-item"][data-comment-id="${replyId}"] > div`,
  );
  // Ответ вложен в корень.
  await expect(rootItem).toContainText(replyText);

  // Мягкое удаление: корень помечен, ветка ответа не рассыпается.
  await rootCard.getByTestId("delete-comment").click();
  await expect(rootCard.getByTestId("comment-deleted")).toBeVisible();
  await expect(replyCard).toBeVisible();

  // Страница «Мои подписки»: тайтл в списке, лента на месте.
  await page.getByTestId("subs-link").click();
  await expect(page.getByTestId("subs-list")).toContainText("Тестовый фильм");
  await expect(page.getByTestId("subs-feed")).toBeVisible();
});
