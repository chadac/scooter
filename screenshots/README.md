# Mobile UI Mockups

This directory contains HTML mockups demonstrating the mobile-friendly responsive design.

## Viewing the Mockups

### Option 1: View All States (Recommended)

Open `mobile-ui-demo.html` in your browser to see all viewport states side-by-side:

```bash
# From this directory
open mobile-ui-demo.html
# or
firefox mobile-ui-demo.html
# or
chromium mobile-ui-demo.html
```

### Option 2: View Individual States

Each file demonstrates a specific viewport and state:

- **desktop-view.html** - Desktop layout (1920x1080) with both sidebars always visible
- **mobile-default.html** - Mobile view (375x812) with sidebars hidden, hamburger menus visible
- **mobile-sidebar-open.html** - Mobile with left sidebar slid in with backdrop
- **mobile-right-panel-open.html** - Mobile with right panel slid in with backdrop

## Taking Screenshots

### Using Browser DevTools

1. Open any HTML file in Chrome/Firefox
2. Open DevTools (F12)
3. Toggle device toolbar (Ctrl+Shift+M / Cmd+Shift+M)
4. Select a device preset:
   - **Desktop**: Responsive - 1920x1080
   - **Tablet**: iPad - 768x1024  
   - **Mobile**: iPhone SE - 375x667 or iPhone 12 Pro - 390x844
5. Take screenshot (DevTools > ⋮ menu > Capture screenshot)

### Using the Screenshot Script (NixOS)

The `scripts/screenshot-mobile-ui.mts` script is designed for automated screenshots but requires
a working Playwright setup on NixOS (currently has dependency issues with chromium libraries).

On a non-NixOS system with Playwright installed:
```bash
BASE_URL=http://localhost:5173 npx tsx scripts/screenshot-mobile-ui.mts
```

## What the Mockups Show

### Desktop (≥ 1024px)
- Both sidebar and right panel always visible
- No hamburger menus
- Fixed widths: sidebar 16rem, right panel 20rem
- Full branding text in header

### Mobile (< 1024px)  
- **Default**: Sidebars hidden, full-width conversation, hamburger menus visible
- **Sidebar Open**: Left sidebar slides in from left with semi-transparent backdrop
- **Right Panel Open**: Right panel slides in from right with semi-transparent backdrop
- Compact header with abbreviated branding ("S")
- Tab labels shortened (S/A/Q/Sub instead of full names)
- Touch-optimized close buttons (✕)
- Panels constrained to max 85vw width

## Implementation Notes

These mockups use Tailwind CSS (CDN version) to demonstrate the responsive classes used in the actual implementation. The real UI uses the same Tailwind classes and breakpoints.
