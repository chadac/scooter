# Mobile UI Visual Guide

This guide documents the mobile-friendly responsive design added to Scooter.

## Overview

The UI now adapts to three main breakpoints:
- **Mobile** (< 1024px): Collapsible sidebars with hamburger menus
- **Desktop** (≥ 1024px): Always-visible sidebars (original layout)

## Desktop View (≥ 1024px)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Header: Scooter — your agent, running in a Nix sandbox    [⚙️] [👤] │
├──────────┬─────────────────────────────────────────────┬────────────┤
│ SIDEBAR  │          CONVERSATION AREA                  │   RIGHT    │
│          │                                              │   PANEL    │
│ [+ New]  │  User: Can you help me with...             │            │
│          │                                              │ [Sandbox]  │
│ Conv 1   │  Assistant: Sure! Let me...                 │ [Approvals]│
│ Conv 2   │                                              │ [Queue]    │
│ Conv 3   │  [Tool Call: bash]                          │ [Subagents]│
│   Sub 1  │  $ ls -la                                   │            │
│          │                                              │  Status:   │
│          │  [Tool Result]                              │  Running   │
│          │  total 48...                                │            │
│          │                                              │  Services: │
│          │                                              │  • marimo  │
│ (filters)│                                              │            │
│          │                                              │            │
└──────────┴─────────────────────────────────────────────┴────────────┘
    16rem              flex-1 (grows)                        20rem
```

**Key Features:**
- Sidebar fixed at 16rem (w-64)
- Right panel fixed at 20rem (w-80)
- No hamburger menus visible
- Full text labels everywhere

## Mobile View - Default (< 1024px)

```
┌────────────────────────────────────────────────────┐
│ [☰] S                               [⚙️] [👤] [☰] │  <- Header
├────────────────────────────────────────────────────┤
│                                                     │
│          CONVERSATION AREA (Full Width)            │
│                                                     │
│  User: Can you help me with...                    │
│                                                     │
│  Assistant: Sure! Let me...                        │
│                                                     │
│  [Tool Call: bash]                                 │
│  $ ls -la                                          │
│                                                     │
│  [Tool Result]                                     │
│  total 48...                                       │
│                                                     │
│                                                     │
│                                                     │
│                                                     │
└────────────────────────────────────────────────────┘
    ^                                            ^
 Left menu                                  Right menu
 (opens sidebar)                          (opens panel)
```

**Key Features:**
- Both sidebars hidden by default
- Hamburger menu buttons visible: `☰` on left and right
- Compact branding: "S" instead of "Scooter — your agent..."
- Conversation takes full width
- Touch-optimized buttons with `touch-manipulation` CSS

## Mobile View - Sidebar Open

```
┌────────────────────────────────────────────────────┐
│ [☰] S                               [⚙️] [👤] [☰] │
├────────────────────────────────────────────────────┤
│▓▓▓▓▓▓▓▓▓▓▓┌──────────┐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ <- Backdrop
│▓▓▓▓▓▓▓▓▓▓▓│ SIDEBAR  │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│    (semi-
│▓▓▓▓▓▓▓▓▓▓▓│ [+ New] ✕│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│    transparent
│▓▓▓▓▓▓▓▓▓▓▓│          │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│    overlay)
│▓▓▓▓▓▓▓▓▓▓▓│ Conv 1   │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓│ Conv 2   │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓│ Conv 3   │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓│   Sub 1  │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓│          │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓│ (filters)│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓│          │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓│          │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
└▓▓▓▓▓▓▓▓▓▓▓└──────────┘▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┘
  Slides in from left edge, max-w-[85vw]
  300ms transition
  Click backdrop or ✕ to close
```

**Key Features:**
- Sidebar slides in from left with smooth 300ms transition
- Semi-transparent dark backdrop (bg-black/50)
- Close button (✕) in top-right of sidebar
- Click backdrop to close
- **Auto-close:** Clicking a conversation closes the sidebar automatically
- Sidebar constrained to max 85% viewport width to prevent overflow

## Mobile View - Right Panel Open

```
┌────────────────────────────────────────────────────┐
│ [☰] S                               [⚙️] [👤] [☰] │
├────────────────────────────────────────────────────┤
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┌───────────┐▓▓▓▓▓▓▓▓▓▓▓▓│ <- Backdrop
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  ✕ RIGHT  │▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│   PANEL   │▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ [S][A][Q] │▓▓▓▓▓▓▓▓▓▓▓▓│  <- Shortened
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  [Sub]    │▓▓▓▓▓▓▓▓▓▓▓▓│     tab labels
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│           │▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ Sandbox   │▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ Status:   │▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ Running   │▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│           │▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ Services: │▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ • marimo  │▓▓▓▓▓▓▓▓▓▓▓▓│
└▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓└───────────┘▓▓▓▓▓▓▓▓▓▓▓▓┘
   Slides in from right edge, max-w-[85vw]
   Click backdrop or ✕ to close
```

**Key Features:**
- Right panel slides in from right with 300ms transition
- Close button (✕) in top-left of panel
- Shortened tab labels on mobile:
  - "S" = Sandbox
  - "A" = Approvals
  - "Q" = Queue
  - "Sub" = Subagents
- Full tab labels restored on wider screens (≥ 640px via `sm:` modifier)

## Tablet View (768px - 1023px)

Similar to mobile view:
- Hamburger menus still visible
- Sidebars slide in/out
- Panels constrained to max 85vw
- Full tab labels visible (≥ 640px)
- More breathing room than phone

## Implementation Details

### Responsive Classes Used

```tsx
// Sidebar
className="flex h-full w-64 sm:w-64 flex-col border-r bg-muted/30 max-w-[85vw]"
//                      ↑ fixed width on sm+              ↑ prevent overflow

// Right Panel  
className="flex h-full w-80 sm:w-80 ... max-w-[85vw]"

// Hamburger Menus
className="lg:hidden touch-manipulation"
//         ↑ hide on large screens  ↑ better touch response

// Tab Labels
<span className="hidden sm:inline">Sandbox</span>
<span className="sm:hidden">S</span>
//               ↑ full label on sm+  ↑ short on mobile

// Header Branding
<span className="hidden md:inline">Scooter — your agent...</span>
<span className="md:hidden">S</span>
```

### Overlay Behavior

- **Z-index layering:** overlay (z-20), panels (z-30)
- **Transitions:** `transition-transform duration-300` for smooth slides
- **Positioning:** `fixed inset-0` for overlay, `left-0`/`right-0` for panels
- **Click-outside to close:** overlay `onClick` closes the panel

### Auto-close Logic

When a conversation is selected in the mobile sidebar:
```tsx
onClick={() => {
  sessionStore.switchTo(s.id);
  onClose?.();  // Auto-close sidebar after selection
}}
```

## Testing the Mobile UI

### Manual Testing Checklist

**Desktop (≥ 1024px):**
- [ ] Sidebar and right panel always visible
- [ ] No hamburger menus
- [ ] Full branding text in header
- [ ] Fixed panel widths (16rem, 20rem)

**Mobile (< 1024px):**
- [ ] Both panels hidden by default
- [ ] Left hamburger menu opens sidebar with backdrop
- [ ] Right hamburger menu opens right panel with backdrop
- [ ] Close buttons (✕) work
- [ ] Click backdrop closes panel
- [ ] Selecting conversation auto-closes sidebar
- [ ] Tab labels shortened (S/A/Q/Sub)
- [ ] Header shows "S" instead of full text

**Touch Behavior:**
- [ ] Buttons feel responsive (no 300ms delay)
- [ ] Panels slide smoothly (300ms)
- [ ] No accidental double-taps

### Browser DevTools Testing

1. Open Chrome DevTools (F12)
2. Toggle device toolbar (Ctrl+Shift+M)
3. Test these viewports:
   - iPhone SE (375x667)
   - iPhone 12 Pro (390x844)
   - iPad Mini (768x1024)
   - Desktop (1920x1080)

### Automated Screenshot Script

Run the screenshot script to capture all viewports:

```bash
# From repo root
npm run pretest:e2e  # Build services
E2E_REUSE_SERVER=1 npx tsx scripts/screenshot-mobile-ui.mts
```

Screenshots saved to `screenshots/`:
- `01-desktop-default.png`
- `02-tablet-default.png`
- `02-tablet-sidebar-open.png`
- `02-tablet-panel-open.png`
- `03-mobile-default.png`
- `03-mobile-sidebar-open.png`
- `03-mobile-panel-open.png`

## Accessibility

- **Keyboard navigation:** All controls remain keyboard-accessible
- **Screen readers:** Proper ARIA labels (`aria-label`, `aria-selected`)
- **Focus management:** Focus stays within open panel
- **Touch targets:** 44px minimum via `touch-manipulation`

## Future Enhancements

Potential improvements for later:
- Swipe gestures to open/close panels
- Remember panel state per session
- Configurable panel widths
- PWA installability for mobile
