/**
 * Minimal test to see if Playwright works in this environment
 */
import { chromium } from '@playwright/test';

console.log('🧪 Testing Playwright setup...');
console.log('PW_CHROME:', process.env.PW_CHROME);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}),
});

console.log('✅ Browser launched successfully');

const page = await browser.newPage();
console.log('✅ Page created');

await page.goto('http://localhost:5173');
console.log('✅ Navigated to UI');

await page.waitForTimeout(2000);
console.log('✅ Waited 2s for page load');

await browser.close();
console.log('✅ Browser closed - Playwright works!');
