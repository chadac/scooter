/**
 * Take screenshots of the mobile-friendly UI for PR documentation.
 * Run with: npm run screenshot-mobile-ui
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SCREENSHOTS_DIR = 'screenshots';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';

// Use the Nix-provided Chrome binary
const CHROME_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH 
  ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium-1223/chrome-linux64/chrome`
  : undefined;

// Viewport configurations
const viewports = [
  { name: '01-desktop', width: 1920, height: 1080, description: 'Desktop view (1920x1080)' },
  { name: '02-tablet', width: 768, height: 1024, description: 'Tablet view (768x1024)' },
  { name: '03-mobile', width: 375, height: 812, description: 'Mobile portrait - iPhone (375x812)' },
];

async function main() {
  console.log('📸 Starting screenshot capture...');
  
  // Create screenshots directory
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ 
    headless: true,
    executablePath: CHROME_PATH,
  });
  
  try {
    for (const viewport of viewports) {
      console.log(`\n📱 Capturing ${viewport.description}...`);
      
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2, // Retina display
      });
      
      const page = await context.newPage();
      
      // Navigate to the app
      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      
      // Wait for the UI to be ready
      await page.waitForSelector('[data-testid="app-container"]', { timeout: 10000 }).catch(() => {
        console.log('  ⚠️  App container not found, using body');
      });
      
      // Screenshot 1: Default view
      const defaultPath = join(SCREENSHOTS_DIR, `${viewport.name}-default.png`);
      await page.screenshot({ path: defaultPath, fullPage: false });
      console.log(`  ✅ Saved: ${defaultPath}`);
      
      // For mobile/tablet: capture sidebar open state
      if (viewport.width < 1024) {
        // Click left hamburger menu to open sidebar
        const leftMenu = await page.locator('button[aria-label="Toggle sidebar"]').first();
        if (await leftMenu.isVisible()) {
          await leftMenu.click();
          await page.waitForTimeout(500); // Wait for animation
          
          const sidebarPath = join(SCREENSHOTS_DIR, `${viewport.name}-sidebar-open.png`);
          await page.screenshot({ path: sidebarPath, fullPage: false });
          console.log(`  ✅ Saved: ${sidebarPath}`);
          
          // Close sidebar
          const backdrop = await page.locator('[data-testid="sidebar-backdrop"]');
          if (await backdrop.isVisible()) {
            await backdrop.click();
            await page.waitForTimeout(500);
          }
        }
        
        // Click right hamburger menu to open right panel
        const rightMenu = await page.locator('button[aria-label="Toggle right panel"]').first();
        if (await rightMenu.isVisible()) {
          await rightMenu.click();
          await page.waitForTimeout(500);
          
          const panelPath = join(SCREENSHOTS_DIR, `${viewport.name}-right-panel-open.png`);
          await page.screenshot({ path: panelPath, fullPage: false });
          console.log(`  ✅ Saved: ${panelPath}`);
        }
      }
      
      await context.close();
    }
    
    console.log('\n✨ All screenshots captured successfully!');
    console.log(`📁 Screenshots saved to: ${SCREENSHOTS_DIR}/`);
    
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
