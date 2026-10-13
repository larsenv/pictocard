import { test, expect } from '@playwright/test';
import path from 'node:path';
import sharp from 'sharp';

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
  const source = await page.locator('#wiiExpandedImage').getAttribute('src');
  const bytes = Buffer.from(source.split(',')[1], 'base64');
  const { width, height } = await sharp(bytes).metadata();
  const pixel = await sharp(bytes).extract({ left: width - 15, top: Math.floor(height / 2), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  expect([...pixel].every((channel) => channel < 70)).toBe(true);
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
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#choosePicture').click();
  await (await chooser).setFiles(image);
  await expect(page.locator('#pictureThumbnail')).toBeVisible();
  await expect(page.locator('#pictureFileName')).toHaveText('logo.png');
  await expect(page.locator('#choosePicture')).toHaveText('Change picture');
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
  await expect(page.locator('.live-preview-content')).toBeHidden();
  await page.locator('#openPreview').click();
  await expect(page.locator('#livePreview')).toBeVisible();
  await expect(page.locator('#openPreview')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#closePreview').click();
  await expect(page.locator('.live-preview-content')).toBeHidden();
  await expect(page.locator('#cardText')).toHaveValue('Keep this message');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 720 });
  const logo = await page.locator('.brand').boundingBox();
  await page.locator('#menuToggle').click();
  const navigation = await page.locator('.header-nav').boundingBox();
  expect(navigation.y).toBeGreaterThanOrEqual(logo.y + logo.height);
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
  await expect(page.locator('#recipientDiscord')).toHaveAttribute('placeholder', 'username');
});

test('preview recovers an expired session token without clearing the draft', async ({ page }) => {
  let originalToken;
  let freshToken;
  let recovered = false;
  await page.route('**/form-token', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    freshToken = data.csrfToken + '-fresh';
    await route.fulfill({ response, json: { csrfToken: freshToken } });
  });
  await page.route('**/card-preview', async (route) => {
    const body = route.request().postDataBuffer();
    const submitted = body.toString();
    if (!originalToken) originalToken = /name="_csrf"\r\n\r\n([^\r]+)/.exec(submitted)[1];
    if (!freshToken || !submitted.includes(freshToken)) {
      return route.fulfill({ status: 403, contentType: 'text/plain', body: 'Invalid CSRF token.' });
    }
    recovered = true;
    const forwarded = Buffer.from(submitted.replace(freshToken, originalToken));
    const response = await route.fetch({ postData: forwarded });
    return route.fulfill({ response });
  });
  await page.goto('/');
  await page.fill('#cardText', 'Keep this draft');
  await expect(page.locator('#previewStatus')).toHaveText('Preview is up to date.');
  await expect(page.locator('#cardText')).toHaveValue('Keep this draft');
  await expect(page.locator('#liveCardImage')).toBeVisible();
  expect(recovered).toBe(true);
  expect(freshToken).not.toBe(originalToken);
  await expect(page.locator('input[name="_csrf"]')).toHaveValue(freshToken);
});

test('email preference controls have clear spacing and the selected action is preserved', async ({ page }) => {
  await page.goto('/optout');
  await expect(page.locator('.delivery-tabs a[aria-current="page"]')).toHaveText('Opt Out');
  const input = await page.locator('#email').boundingBox();
  const button = await page.getByRole('button', { name: 'Send Verification Code' }).boundingBox();
  expect(button.y - input.y - input.height).toBeGreaterThanOrEqual(16);
  await page.getByRole('link', { name: 'Opt Back In', exact: true }).click();
  await expect(page.locator('input[name="action"]')).toHaveValue('optin');
  await expect(page.locator('.delivery-tabs a[aria-current="page"]')).toHaveText('Opt Back In');
  await expect(page.locator('.site-footer')).toHaveText(`© ${new Date().getFullYear()} PictoCard. All rights reserved.`);
  await expect(page.locator('.site-footer a')).toHaveCount(0);
});

test('extra Mii sources affect only the PictoCard and failed replacements keep the current Mii', async ({ page }) => {
  const data = Buffer.alloc(96, 1).toString('base64');
  const thumbnail = `data:image/png;base64,${(await import('node:fs')).readFileSync(image).toString('base64')}`;
  let fail = false;
  await page.route('**/mii-import', (route) => route.fulfill({ status: fail ? 422 : 200, contentType: 'application/json',
    body: JSON.stringify(fail ? { error: 'No Mii found.' } : { data, name: 'Jasmine', image: thumbnail }) }));
  await page.route('**/card-preview', (route) => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ image: thumbnail, wii: false }) }));
  await page.goto('/');
  await page.locator('#extrasGroup > summary').click();
  await page.selectOption('#miiSource', 'nnid');
  await expect(page.locator('#miiLookupField')).toBeVisible();
  await expect(page.locator('#miiFileField')).toBeHidden();
  await page.fill('#miiLookup', 'JasmineChlora');
  await page.locator('#loadCardMii').click();
  await expect(page.locator('#cardMiiStatus')).toHaveText('Jasmine loaded onto the PictoCard.');
  await expect(page.locator('#cardMiiData')).toHaveValue(data);
  fail = true;
  await page.selectOption('#miiSource', 'pnid');
  await page.locator('#loadCardMii').click();
  await expect(page.locator('#cardMiiStatus')).toContainText('Your current Mii is kept.');
  await expect(page.locator('#cardMiiData')).toHaveValue(data);
  await page.selectOption('#miiSource', 'qr');
  await expect(page.locator('#miiFile')).toHaveAttribute('accept', 'image/*');
  await page.selectOption('#miiSource', 'amiibo');
  await expect(page.locator('#miiSourceHint')).toContainText('532 or 540');
  await page.selectOption('#miiSource', 'data');
  await expect(page.locator('#miiCodeField')).toBeVisible();
  await page.locator('#removeCardMii').click();
  await expect(page.locator('#cardMiiData')).toHaveValue('remove');
  await expect(page.locator('#cardMiiThumbnail')).toBeHidden();
  await page.locator('#tabWii').click();
  await expect(page.locator('#miiSource')).toBeHidden();
  await expect(page.locator('#wiiMii')).toHaveAttribute('type', 'file');
  await expect(page.locator('label[for="wiiMii"]')).toHaveText('Mii Face (Optional)');
  await page.locator('input[name="wiiAttach"][value="card"]').check();
  await expect(page.locator('#miiSource')).toBeVisible();
});

test('switching backgrounds repeatedly keeps default colors readable and refreshes the preview', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#previewStatus')).toHaveText('Preview is up to date.');
  for (const background of ['dark', 'light', 'dark', 'light']) {
    const previous = await page.locator('#liveCardImage').getAttribute('src');
    await page.locator(`input[name="cardBackground"][value="${background}"]`).check();
    await expect(page.locator('#textColor')).toHaveValue(background === 'dark' ? '#f5f5f7' : '#111111');
    await expect(page.locator('#liveCardImage')).not.toHaveAttribute('src', previous);
  }
  await page.locator('#tabWii').click();
  expect(await page.locator('#cardForm').evaluate((form) => new FormData(form).get('cardBackground'))).toBe('light');
});


test('temporary rendering limits recover without clearing the preview', async ({ page }) => {
  let busy = true;
  await page.route('**/card-preview', (route) => {
    if (busy) {
      busy = false;
      return route.fulfill({ status: 429, headers: { 'Retry-After': '1' }, contentType: 'application/json',
        body: JSON.stringify({ error: 'Card rendering is busy. Please try again shortly.' }) });
    }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.locator('#previewStatus')).toHaveText('Preview is up to date.');
  await expect(page.locator('#liveCardImage')).toBeVisible();
});
