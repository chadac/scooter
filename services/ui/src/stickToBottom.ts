/**
 * Keep a scroll viewport pinned to the bottom as content grows. A `stick` intent flag
 * flips false only on a genuine upward user scroll, never on content growth; while stuck,
 * a ResizeObserver and a MutationObserver re-pin on any size change.
 */

/** Wheel, touch and scroll listeners plus the observers; returns the detach function. */
export function attachStickToBottom(el: HTMLElement, syncStore: () => void): () => void {
  // Whether we are following the bottom; only a real upward user scroll turns it off.
  let stick = true;
  let lastTop = el.scrollTop;
  // While set, the scroll event our own re-pin triggers is ignored.
  let pinning = 0;

  const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight <= 2;

  const pin = () => {
    pinning++;
    el.scrollTop = el.scrollHeight;
    syncStore(); // keep the library's isAtBottom true so its autoScroll stays on
    requestAnimationFrame(() => {
      pinning = Math.max(0, pinning - 1);
      lastTop = el.scrollTop;
    });
  };

  // Re-pin every frame until scrollHeight has held steady for a few frames, since a big message keeps reflowing after it mounts and pinning once lands short.
  let chaseFrame: number | null = null;
  const CHASE_MAX_FRAMES = 120; // a hard stop for a never-settling layout
  const CHASE_STABLE_FRAMES = 3; // scrollHeight unchanged this many frames means settled
  const chase = () => {
    // A running chase self-extends, so it is not restarted.
    if (chaseFrame !== null) return;
    let frames = 0;
    let stableFrames = 0;
    let lastHeight = -1;
    const step = () => {
      if (!stick) { chaseFrame = null; return; }
      const h = el.scrollHeight;
      stableFrames = h === lastHeight ? stableFrames + 1 : 0;
      lastHeight = h;
      pin();
      if (stableFrames >= CHASE_STABLE_FRAMES || ++frames >= CHASE_MAX_FRAMES) {
        chaseFrame = null;
        return;
      }
      chaseFrame = requestAnimationFrame(step);
    };
    chaseFrame = requestAnimationFrame(step);
  };

  const onScroll = () => {
    if (pinning > 0) return; // our own re-pin
    if (el.scrollTop < lastTop - 1) stick = false; // a genuine scroll up stops following
    else if (atBottom()) stick = true; // back at the bottom resumes it
    lastTop = el.scrollTop;
  };
  el.addEventListener("scroll", onScroll, { passive: true });

  // An upward gesture releases the lock even mid-pin, when onScroll mistakes it for our own scroll.
  const release = () => {
    if (!stick) return;
    stick = false;
    if (chaseFrame !== null) cancelAnimationFrame(chaseFrame);
    chaseFrame = null;
    // assistant-ui drops its own pending scroll-to-bottom on pointerdown.
    el.dispatchEvent(new Event("pointerdown"));
  };
  const onWheel = (e: Event) => {
    if ((e as WheelEvent).deltaY < 0) release();
  };
  let touchY: number | null = null;
  const onTouchStart = (e: Event) => {
    touchY = (e as TouchEvent).touches[0]?.clientY ?? null;
  };
  const onTouchMove = (e: Event) => {
    const y = (e as TouchEvent).touches[0]?.clientY;
    if (touchY !== null && y !== undefined && y > touchY) release(); // a downward drag scrolls up
    touchY = y ?? touchY;
  };
  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: true });

  // The viewport's border-box does not change with scrollHeight, so every direct child of the scroll content is observed instead.
  const ro = new ResizeObserver(() => {
    if (!stick) return;
    // The synchronous pin runs with layout, so the first jump is caught even when rAF is starved.
    pin();
    chase();
  });
  const observeContent = () => {
    ro.disconnect();
    // The inner scroll content holds the message group and footer.
    const inner = el.firstElementChild as HTMLElement | null;
    if (inner) {
      ro.observe(inner);
      for (const child of Array.from(inner.children)) ro.observe(child as HTMLElement);
    } else {
      ro.observe(el);
    }
  };
  observeContent();
  // Re-attach the ResizeObserver when new messages mount so their growth is followed too.
  const mo = new MutationObserver(() => {
    observeContent();
    if (!stick) return;
    pin();
    chase();
  });
  // Observing the whole subtree janks, so only new-message mounts are observed.
  const messageGroup = el.querySelector<HTMLElement>('[data-slot="aui_message-group"]');
  if (messageGroup) {
    mo.observe(messageGroup, { childList: true, subtree: false });
  } else {
    mo.observe(el, { childList: true, subtree: true }); // the group is not mounted yet
  }

  // Land at the tail on first paint and chase the history replay's late layout.
  chase();

  return () => {
    el.removeEventListener("scroll", onScroll);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    ro.disconnect();
    mo.disconnect();
    if (chaseFrame !== null) cancelAnimationFrame(chaseFrame);
  };
}
