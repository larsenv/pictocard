import { test, expect } from '@playwright/test';

test('fresh messages are empty and the fixed Discord prefix is never duplicated', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#pictureThumbnail')).toBeHidden();
  await expect(page.locator('#cardText')).toHaveValue('');
  await expect(page.locator('#charCounter')).toHaveText('0 / 500');
  await expect(page.locator('#cardText')).toHaveAttribute('placeholder', 'Write your message here...');
  await page.locator('#tabDiscord').click();
  await expect(page.locator('.username-prefix')).toHaveText('@');
  await page.fill('#recipientDiscord', '@friend');
  await expect(page.locator('#recipientDiscord')).toHaveValue('friend');
  expect(await page.locator('#cardForm').evaluate((form) => new FormData(form).get('recipientDiscord'))).toBe('friend');
});

test('theme choice persists across pages and keeps the logo unchanged', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const logo = await page.locator('.brand img').getAttribute('src');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.brand img')).toHaveAttribute('src', logo);
  expect(await page.locator('.brand img').evaluate((img) => getComputedStyle(img).filter)).toBe('none');
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('phone navigation stays in one row and closes from its button, outside, and Escape', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  const button = page.locator('#menuToggle');
  const header = page.locator('.site-header');
  const initial = (await header.boundingBox()).height;
  await button.click();
  const links = await page.locator('.header-nav a').evaluateAll((elements) => elements.map((el) => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, right: rect.right };
  }));
  expect(Math.max(...links.map((link) => link.top)) - Math.min(...links.map((link) => link.top))).toBeLessThan(1);
  expect(Math.max(...links.map((link) => link.right))).toBeLessThanOrEqual(320);
  expect((await header.boundingBox()).height - initial).toBeLessThan(55);
  await button.click();
  await expect(page.locator('.header-nav')).toBeHidden();
  await button.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.header-nav')).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  await page.locator('h1').click();
  await expect(page.locator('.header-nav')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
