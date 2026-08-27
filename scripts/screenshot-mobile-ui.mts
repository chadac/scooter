/**
 * Take screenshots of the mobile-friendly UI for PR documentation.
 * Run with: npm run screenshot-mobile-ui
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SCREENSHOTS_DIR = 'screenshots';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';

// Viewport configurations
const viewports = [
  { name: '01-desktop', width: 1920, height: 1080, description: 'Desktop view (1920x1080)' },
  { name: '02-tablet', width: 768, height: 1024, description: 'Tablet view (768x1024)' },
  { name: '03-mobile', width: 375, height: 812, description: 'Mobile portrait - iPhone (375x812)' },
];

async function main() {
  console.log('📸 Starting screenshot capture...\n');
  
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  
  const browser = await chromium.launch();
  const context = await browser.newContext();
  
  for (const viewport of viewports) {
    console.log(`📱 Capturing: ${viewport.description}`);
    
    const page = await context.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    
    try {
      // Navigate to the app
      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      
      // Wait for the app to load
      await page.waitForSelector('[data-testid="new-session"]', { timeout: 10000 });
      
      // Take screenshot of default view
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, `${viewport.name}-default.png`),
        fullPage: false,
      });
      console.log(`  ✓ ${viewport.name}-default.png`);
      
      // For mobile/tablet, also capture with sidebar open
      if (viewport.width < 1024) {
        // Click hamburger menu to open left sidebar
        const leftMenu = page.locator('[data-testid="mobile-menu-left"]');
        if (await leftMenu.isVisible()) {
          await leftMenu.click();
          await page.waitForTimeout(500); // Wait for slide-in animation
          
          await page.screenshot({
            path: join(SCREENSHOTS_DIR, `${viewport.name}-sidebar-open.png`),
            fullPage: false,
          });
          console.log(`  ✓ ${viewport.name}-sidebar-open.png`);
          
          // Close sidebar by clicking backdrop or close button
          const closeBtn = page.locator('[data-testid="sidebar-close"]');
          if (await closeBtn.isVisible()) {
            await closeBtn.click();
            await page.waitForTimeout(500);
          }
        }
        
        // Click hamburger menu to open right panel
        const rightMenu = page.locator('[data-testid="mobile-menu-right"]');
        if (await rightMenu.isVisible()) {
          await rightMenu.click();
          await page.waitForTimeout(500); // Wait for slide-in animation
          
          await page.screenshot({
            path: join(SCREENSHOTS_DIR, `${viewport.name}-panel-open.png`),
            fullPage: false,
          });
          console.log(`  ✓ ${viewport.name}-panel-open.png`);
        }
      }
      
    } catch (error) {
      console.error(`  ✗ Error capturing ${viewport.name}:`, error);
    } finally {
      await page.close();
    }
    
    console.log('');
  }
  
  await browser.close();
  
  console.log('✅ Screenshot capture complete!');
  console.log(`📁 Screenshots saved to: ${SCREENSHOTS_DIR}/\n`);
  console.log('Next steps:');
  console.log('  1. Review the screenshots');
  console.log('  2. Add them to the PR description or as PR comments');
}

main().catch(console.error);
