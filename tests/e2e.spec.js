import { test, expect } from '@playwright/test';

test.describe('PictoCard E2E Tests', () => {
  test('Landing page has correct SEO metadata', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // Check Title
    await expect(page).toHaveTitle(/PictoCard - Send a Greeting Card/i);

    // Check Meta Description
    const metaDescription = page.locator('meta[name="description"]');
    await expect(metaDescription).toHaveAttribute('content', /customizable greeting cards/i);

    // Check H1 and H2
    await expect(page.locator('h1')).toHaveText(/Send a PictoCard/i);
    await expect(page.locator('h2.hero-keywords')).toHaveText(/The simple way to send custom photo cards and personalized e-cards./i);
  });

  test('Form interaction pre-fills correctly', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // Fill the form
    await page.fill('#senderName', 'Test User');
    await page.fill('#senderEmail', 'test@example.com');
    await page.fill('#recipientEmail', 'friend@example.com');
    await page.fill('#cardText', 'This is a test message from Playwright.');

    // We can't easily submit without a real image/preset in this automated test environment
    // but we can verify the inputs are accepted
    await expect(page.locator('#senderName')).toHaveValue('Test User');
    await expect(page.locator('#cardText')).toHaveValue('This is a test message from Playwright.');
  });
});
