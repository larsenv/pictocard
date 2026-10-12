import { test, expect } from '@playwright/test';
import path from 'node:path';

const image = path.resolve('public/images/logo.png');

test('text backgrounds apply to cards and Wii attachments without changing custom colors', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[name="cardBackground"][value="dark"]').check();
  await expect(page.locator('#textColor')).toHaveValue('#f5f5f7');
  await page.locator('#textColor').fill('#ff3344');
  await page.locator('input[name="cardBackground"][value="light"]').check();
  await expect(page.locator('#textColor')).toHaveValue('#ff3344');
  await page.locator('#tabWii').click();
  await expect(page.locator('#cardBackgroundGroup')).toBeHidden();
  await page.locator('input[name="wiiAttach"][value="card"]').check();
  await expect(page.locator('#cardBackgroundGroup')).toBeVisible();
  await page.locator('input[name="cardBackground"][value="dark"]').check();
  await page.setInputFiles('#cardImage', image);
  await page.fill('#cardText', 'A letter\nwith\nseveral\nlines\nand a last line');
  await expect(page.locator('#previewStatus')).toHaveText('Preview is up to date.');
  await expect(page.locator('#wiiPage')).toHaveText('1 / 2');
  await page.locator('#wiiNext').click();
  await expect(page.locator('#wiiPage')).toHaveText('2 / 2');
  await page.locator('#wiiAttachmentTarget').click();
  await expect(page.locator('#wiiExpandedImage')).toBeVisible();
  await expect(page.locator('#wiiToggleAttachment')).toHaveCount(0);
  await expect(page.locator('#wiiExpanded')).toBeFocused();
  const attachment = await page.locator('#wiiExpanded').boundingBox();
  const desktopStage = await page.locator('.wii-preview-stage').boundingBox();
  expect(attachment.width).toBeLessThan(desktopStage.width);
  expect(attachment.height).toBeLessThan(desktopStage.height);
  await page.locator('#wiiExpandedImage').click();
  await expect(page.locator('#wiiExpandedImage')).toBeHidden();
  await expect(page.locator('#wiiAttachmentTarget')).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#openPreview').click();
  const stage = await page.locator('.wii-preview-stage').boundingBox();
  const paper = await page.locator('#liveLetterhead').boundingBox();
  expect(paper.x).toBeGreaterThanOrEqual(stage.x);
  expect(paper.x + paper.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
});

test('live preview updates for image, text, font, and color without submitting', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#previewStatus')).toHaveText('Preview is up to date.');
  const preview = page.locator('#liveCardImage');
  const initial = await preview.getAttribute('src');
  await page.setInputFiles('#cardImage', image);
  await page.fill('#cardText', 'A live message');
  await expect(page.locator('#previewStatus')).toHaveText('Preview is up to date.');
  await expect(preview).not.toHaveAttribute('src', initial);
  const first = await preview.getAttribute('src');
  await page.selectOption('#fontFamily', 'splatfont2');
  await expect(preview).not.toHaveAttribute('src', first);
  const second = await preview.getAttribute('src');
  await page.locator('#textColor').fill('#ff3344');
  await expect(preview).not.toHaveAttribute('src', second);
  await expect(page.locator('#colorLabel')).toHaveText('#ff3344');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#fontPreviewImg')).toHaveCount(0);
});

test('desktop preview sits to the right and mobile preview opens without losing the message', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const form = await page.locator('#cardForm').boundingBox();
  const preview = await page.locator('#livePreview').boundingBox();
  expect(preview.x).toBeGreaterThan(form.x + form.width);
  const desktopLogo = await page.locator('.brand').boundingBox();
  expect(desktopLogo.x).toBe(form.x);
  await page.fill('#cardText', 'Keep this message');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#livePreview')).toBeHidden();
  await page.locator('#openPreview').click();
  await expect(page.locator('#livePreview')).toBeVisible();
  await expect(page.locator('#openPreview')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#closePreview').click();
  await expect(page.locator('#livePreview')).toBeHidden();
  await expect(page.locator('#cardText')).toHaveValue('Keep this message');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 720 });
  const logo = await page.locator('.brand').boundingBox();
  const navigation = await page.locator('.header-nav').boundingBox();
  expect(navigation.x).toBeGreaterThanOrEqual(logo.x + logo.width);
  expect(navigation.x + navigation.width).toBeLessThanOrEqual(320);
});

test('overflow is explained before sending and clears when the message is shortened', async ({ page }) => {
  await page.goto('/');
  await page.fill('#cardText', 'a\n'.repeat(200));
  await expect(page.locator('#previewStatus')).toContainText('line breaks');
  await expect(page.locator('#charCounter')).toContainText('check message length');
  expect(await page.locator('#cardText').evaluate((field) => field.validity.customError)).toBe(true);
  await page.fill('#cardText', 'A shorter message');
  await expect(page.locator('#previewStatus')).toHaveText('Preview is up to date.');
  await expect(page.locator('#charCounter')).toHaveText('17 / 500');
  expect(await page.locator('#cardText').evaluate((field) => field.validity.customError)).toBe(false);
});

test('Wii guidance stays inside its tab and supports a live letter preview', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tabWii').click();
  await page.fill('#cardText', 'Hello from the Wii tab');
  await expect(page.locator('#liveLetterText')).toHaveText('Hello from the Wii tab');
  await expect(page.locator('#liveCardImage')).toBeHidden();
  await page.locator('.letterhead-details').evaluate((details) => { details.open = true; });
  await page.locator('.letterhead-gallery label[title="And-Kensaku"]').click();
  await expect(page.locator('#liveLetterhead')).toHaveAttribute('data-letterhead', '/images/letterheads/and-kensaku.png');
  expect(await page.locator('#liveLetterhead').evaluate((img) => img.naturalWidth)).toBe(512);
  await expect(page.locator('.wiilink-notice')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('@rc24.xyz');
  await expect(page.locator('main')).not.toContainText('mail@pictocard.net');
  await page.locator('#tabDiscord').click();
  await expect(page.locator('#recipientDiscord')).toHaveAttribute('placeholder', '@username');
});

test('preview recovers an expired session token without clearing the draft', async ({ page }) => {
  let expired = true;
  await page.route('**/card-preview', (route) => {
    if (expired) {
      expired = false;
      return route.fulfill({ status: 403, contentType: 'text/plain', body: 'Invalid CSRF token.' });
    }
    return route.continue();
  });
  await page.goto('/');
  await page.fill('#cardText', 'Keep this draft');
  await expect(page.locator('#previewStatus')).toHaveText('Preview is up to date.');
  await expect(page.locator('#cardText')).toHaveValue('Keep this draft');
  await expect(page.locator('#liveCardImage')).toBeVisible();
});

test('email preference controls have clear spacing and the selected action is preserved', async ({ page }) => {
  await page.goto('/optout');
  await expect(page.locator('a[aria-current="page"]')).toHaveText('Opt Out');
  const input = await page.locator('#email').boundingBox();
  const button = await page.getByRole('button', { name: 'Send Verification Code' }).boundingBox();
  expect(button.y - input.y - input.height).toBeGreaterThanOrEqual(16);
  await page.getByRole('link', { name: 'Opt Back In', exact: true }).click();
  await expect(page.locator('input[name="action"]')).toHaveValue('optin');
  await expect(page.locator('a[aria-current="page"]')).toHaveText('Opt Back In');
  await expect(page.locator('.site-footer')).toHaveText('© PictoCard');
  await expect(page.locator('.site-footer a')).toHaveCount(0);
});
