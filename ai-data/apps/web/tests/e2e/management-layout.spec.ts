import { test, expect, type Page } from "@playwright/test";
import { managementFixture } from "../support/management-fixture";

async function login(page: Page, path: string) {
  const fixture = await managementFixture(page);
  await page.goto(path);
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page).toHaveURL((url) => url.pathname === path);
  return fixture;
}

test("模型历史版本和 Agent 固定版本详情可从地址恢复", async ({ page }) => {
  const fixture = await login(page, "/settings/models");
  await expect(page.getByRole("button", { name: /院内模型 rj/ })).toBeVisible();
  fixture.models.push({ ...fixture.models[0]!, version: 2, name: "院内模型第二版" });
  fixture.agents.push({ ...fixture.agents[0]!, version: 2, name: "住院分析助手第二版" });
  await page.getByRole("button", { name: /院内模型 rj/ }).click();
  await expect(page.getByRole("heading", { name: "院内模型第二版", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "版本记录", exact: true }).click();
  await page.getByRole("spinbutton", { name: "查看版本", exact: true }).fill("1");
  await page.getByRole("button", { name: "读取版本", exact: true }).click();
  await expect(page).toHaveURL(/version=1/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "院内模型", exact: true })).toBeVisible();
  await page.goto("/settings/agents?resource=clinical&version=1");
  await expect(page.getByRole("heading", { name: "住院分析助手", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "住院分析助手", exact: true })).toBeVisible();
});

test("模型卡片筛选、地址恢复与浏览器返回", async ({ page }) => {
  await login(page, "/settings/models");
  await page.getByRole("textbox", { name: "搜索模型" }).fill("不存在");
  await expect(page.getByText("没有匹配的模型")).toBeVisible();
  await page.getByRole("textbox", { name: "搜索模型" }).fill("rj");
  await page.getByRole("button", { name: /院内模型 rj/ }).click();
  await expect(page).toHaveURL(/resource=rj/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "院内模型", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回模型列表" }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("resource"));
  await expect(page.getByRole("button", { name: /院内模型 rj/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "院内模型", exact: true })).toBeVisible();
});

test("模型编辑返回时确认丢弃认证草稿", async ({ page }) => {
  await login(page, "/settings/models");
  await page.getByRole("button", { name: /院内模型 rj/ }).click();
  await page.getByRole("button", { name: "以此版本为基础发布" }).click();
  await page.getByLabel("API Key", { exact: true }).fill("temporary-key");
  await page.getByRole("button", { name: "返回模型列表" }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("temporary-key");
  await page.getByRole("button", { name: "返回模型列表" }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await page.getByRole("button", { name: /院内模型 rj/ }).click();
  await page.getByRole("button", { name: "以此版本为基础发布" }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
});

test("用户表格选中后打开详情，关闭详情保留账号列表", async ({ page }) => {
  await login(page, "/settings/users");
  const table = page.getByRole("table", { name: "用户账号" });
  await expect(table).toBeVisible();
  await table.getByRole("button", { name: "住院业务员", exact: true }).click();
  await expect(page.getByRole("region", { name: "用户详情" })).toBeVisible();
  await page.getByRole("button", { name: "关闭用户详情" }).click();
  await expect(page.getByRole("region", { name: "用户详情" })).toHaveCount(0);
  await expect(table).toBeVisible();
});

test("数据源入口只展开所选配置，白名单按需切换", async ({ page }) => {
  await login(page, "/settings/data");
  await page.getByRole("combobox", { name: "DAS 实例", exact: true }).click();
  await page.getByRole("option", { name: "das-demo · 在线" }).click();
  await expect(page.getByRole("heading", { name: "数据源配置", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /clinical clinical 启用/ }).click();
  await expect(page.getByRole("heading", { name: "数据源配置", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /visits visits 可查询/ })).toHaveCount(0);
  await page.getByRole("button", { name: "对象白名单", exact: true }).click();
  await expect(page.getByRole("button", { name: /visits visits 可查询/ })).toBeVisible();
  await page.getByRole("button", { name: "返回数据源列表" }).click();
  await expect(page.getByRole("button", { name: /clinical clinical 启用/ })).toBeVisible();
});
