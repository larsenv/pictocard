import { test, expect } from '@playwright/test';

async function stroke(page, from, to) {
  const box = await page.locator('#doodleCanvas').boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

test('a doodle can be drawn and used as the card picture', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.fill('#senderName', 'Alex');
  await page.fill('#senderEmail', 'alex@example.com');
  await page.fill('#recipientEmail', 'friend@example.com');
  await page.fill('#cardText', 'Hello there');

  await page.getByRole('button', { name: 'Draw a doodle' }).click();
  await expect(page.locator('#doodleDialog')).toBeVisible();
  await page.locator('#doodleColors .doodle-swatch').nth(5).click(); // red
  await stroke(page, [0.2, 0.3], [0.8, 0.7]);
  await page.screenshot({ path: 'test-results/doodle-dialog.png' });

  // the stroke left red ink, and undo removes it again
  const inked = () => page.locator('#doodleCanvas').evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0) return true;
    return false;
  });
  expect(await inked()).toBe(true);
  await page.click('#doodleUndo');
  expect(await inked()).toBe(false);
  await stroke(page, [0.2, 0.3], [0.8, 0.7]);

  await page.click('#doodleUse');
  await expect(page.locator('#doodleDialog')).not.toBeVisible();
  const file = await page.locator('#cardImage').evaluate((input) => ({ name: input.files[0]?.name, type: input.files[0]?.type, size: input.files[0]?.size }));
  expect(file).toMatchObject({ name: 'doodle.png', type: 'image/png' });
  expect(file.size).toBeGreaterThan(100);
  await expect(page.locator('#pictureThumbnail')).toBeVisible();
  await expect(page.locator('#pictureFileName')).toHaveText('doodle.png');

  await page.getByRole('button', { name: 'Review your card' }).click();
  await expect(page).toHaveURL(/\/preview$/);
  const preview = page.getByAltText('Card Preview');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('cancel leaves the picture untouched and fill works', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Draw a doodle' }).click();
  await page.locator('[data-tool="fill"]').click();
  await page.locator('#doodleColors .doodle-swatch').nth(10).click(); // green
  const box = await page.locator('#doodleCanvas').boundingBox();
  await page.mouse.click(box.x + 20, box.y + 20);
  const px = await page.locator('#doodleCanvas').evaluate((c) => Array.from(c.getContext('2d').getImageData(5, 5, 1, 1).data));
  expect(px).toEqual([0, 255, 0, 255]);
  await page.click('#doodleCancel');
  await expect(page.locator('#doodleDialog')).not.toBeVisible();
  expect(await page.locator('#cardImage').evaluate((i) => i.files.length)).toBe(0);
});
