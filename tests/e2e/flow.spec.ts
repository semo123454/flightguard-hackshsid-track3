import { test, expect } from '@playwright/test';

test('creates a new structured event and shows a rules report', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('机场').selectOption({ index: 1 });
  await page.getByLabel('事件描述').fill('模拟天气变化，当前正式状态未知');
  await page.getByLabel('天气风险').selectOption('true');
  await page.getByLabel('已知事实（每行一项）').fill('已收到模拟天气风险提示');
  await page.getByLabel('未知信息（每行一项）').fill('逐航班状态');
  await page.getByRole('button', { name: '创建事件并生成报告' }).click();
  await expect(page.getByText(/系统模式 · 规则回退/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '沟通草案' })).toBeVisible();
  await expect(page.getByText(/不会自动发送/)).toBeVisible();

  await page.getByPlaceholder('例如：这个判断的依据是什么？').fill('这个判断的依据是什么？');
  await page.getByRole('button', { name: '提交追问' }).click();
  await expect(page.getByText(/当前判断由规则/)).toBeVisible();

  await page.getByLabel('复核结论').selectOption('modified');
  await page.getByLabel('原因').fill('补充现场人工确认信息');
  await page.getByLabel('已确认补充事实（每行一项）').fill('现场保障资源充足');
  await page.getByRole('button', { name: '保存反馈' }).click();
  await expect(page.getByText(/补充事实已创建事件修订并生成关联报告/)).toBeVisible();
  await expect(page.getByText(/REPORT · REVISION 2/)).toBeVisible();

  const exportLink = page.getByRole('link', { name: '导出 17 字段' });
  const exportUrl = await exportLink.getAttribute('href');
  expect(exportUrl).toBeTruthy();
  const exported = await page.request.get(exportUrl!);
  expect(exported.ok()).toBeTruthy();
  expect(Object.keys(await exported.json())).toHaveLength(17);
});

test('keeps free text visible when rules mode requests structured clarification', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '自由文本' }).click();
  const input = page.getByLabel('事件原文');
  await input.fill('模拟新事件：某机场出现风雨，正式状态未知。');
  await page.getByRole('button', { name: '提取候选字段' }).click();
  await expect(page.getByRole('alert')).toContainText('当前为规则模式');
  await expect(input).toHaveValue('模拟新事件：某机场出现风雨，正式状态未知。');
});

test('keeps the primary navigation readable at laptop and narrow widths', async ({ page }) => {
  for (const viewport of [{ width: 1366, height: 768 }, { width: 768, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /新事件/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '新事件研判' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
});
