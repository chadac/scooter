/**
 * Capture screenshots of the mobile-friendly UI for PR documentation.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SCREENSHOTS_DIR = 'screenshots';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';

console.log('📸 Starting screenshot capture...');
console.log(`   Base URL: ${BASE_URL}`);
console.log(`   Output: ${SCREENSHOTS_DIR}/`);

await mkdir(SCREENSHOTS_DIR, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}),
});

const viewports = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
];

const states = [
  { name: 'default', action: null },
  { 
    name: 'sidebar-open',
    action: async (page: any) => {
      // Click the first ☰ button (left hamburger menu)
      const buttons = await page.locator('button:has-text("☰")').all();
      if (buttons.length > 0) {
        await buttons[0].click();
        await page.waitForTimeout(500);
      }
    }
  },
  { 
    name: 'panel-open',
    action: async (page: any) => {
      // Click the second ☰ button (right hamburger menu)
      const buttons = await page.locator('button:has-text("☰")').all();
      if (buttons.length > 1) {
        await buttons[1].click();
        await page.waitForTimeout(500);
      }
    }
  },
];

for (const viewport of viewports) {
  console.log(`\n📐 ${viewport.name} (${viewport.width}x${viewport.height})`);
  
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  for (const state of states) {
    // Only sidebar/panel states on mobile/tablet
    if ((state.name !== 'default') && viewport.name === 'desktop') {
      continue;
    }
    
    const filename = `${viewport.name}-${state.name}.png`;
    console.log(`   📷 ${filename}...`);
    
    if (state.action) {
      await state.action(page);
    }
    
    await page.screenshot({ path: join(SCREENSHOTS_DIR, filename), fullPage: false });
    
    // Reload for next state
    if (state.action) {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }
  }
  
  await context.close();
}

await browser.close();

console.log('\n✅ Screenshot capture complete!');
console.log(`   Screenshots in: ${SCREENSHOTS_DIR}/`);
