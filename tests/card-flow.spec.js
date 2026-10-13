import { test, expect } from '@playwright/test';
import path from 'node:path';

const image = path.resolve('public/images/logo.png');

test('a card can be previewed, edited, and rebuilt with the retained image', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.fill('#senderName', 'Alex');
  await page.fill('#senderEmail', 'alex@example.com');
  await page.fill('#recipientEmail', 'friend@example.com');
  await page.fill('#cardText', 'Hello there');
  await page.setInputFiles('#cardImage', image);
  await page.getByRole('button', { name: 'Review your card' }).click();
  await expect(page).toHaveURL(/\/preview$/);
  const preview = page.getByAltText('Card Preview');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  const originalCard = await preview.getAttribute('src');
  await page.getByRole('link', { name: 'Edit Card' }).click();
  await expect(page.locator('#cardText')).toHaveValue('Hello there');
  await expect(page.locator('#charCounter')).toHaveText('11 / 500');
  await page.fill('#cardText', 'Updated message');
  await page.getByRole('button', { name: 'Review your card' }).click();
  await expect(page).toHaveURL(/\/preview$/);
  expect(await page.getByAltText('Card Preview').getAttribute('src')).not.toBe(originalCard);
  expect(errors).toEqual([]);
});

test('returning to a Discord draft leaves hidden sender fields disabled', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tabDiscord').click();
  await page.fill('#recipientDiscord', '@friend');
  await page.fill('#cardText', 'Hello');
  await page.setInputFiles('#cardImage', image);
  await page.getByRole('button', { name: 'Review your card' }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await page.getByRole('link', { name: 'Edit Card' }).click();
  await expect(page.locator('#recipientDiscord')).toBeVisible();
  await expect(page.locator('#recipientDiscord')).toHaveValue('friend');
  await expect(page.locator('#senderName')).toBeDisabled();
  await expect(page.locator('#senderEmail')).toBeDisabled();
  await page.fill('#cardText', 'Edited Discord message');
  await page.getByRole('button', { name: 'Review your card' }).click();
  await expect(page).toHaveURL(/\/preview$/);
});

test('an invalid email in a hidden tab cannot block Discord preview', async ({ page }) => {
  await page.goto('/');
  await page.fill('#senderEmail', 'unfinished-address');
  await page.locator('#tabDiscord').click();
  await page.fill('#recipientDiscord', 'friend');
  await page.setInputFiles('#cardImage', image);
  await page.getByRole('button', { name: 'Review your card' }).click();
  await expect(page).toHaveURL(/\/preview$/);
});

test('the form works at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#senderName')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review your card' })).toBeVisible();
  await page.locator('#tabDiscord').click();
  await expect(page.locator('#recipientDiscord')).toBeVisible();
  await expect(page.locator('#recipientEmail')).toBeDisabled();
  await page.locator('#tabEmail').click();
  await expect(page.locator('#recipientEmail')).toBeEnabled();
  await expect(page.locator('#senderEmail')).toBeEnabled();
});
