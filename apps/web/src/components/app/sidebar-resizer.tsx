'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  readStoredWidth,
} from '@/lib/sidebar-width';
import { cn } from '@/lib/utils';

/**
 * Drag-to-resize for the sidebar.
 *
 * Pointer capture rather than window listeners: the pointer leaves the 5px
 * handle on the first frame of any real drag, and without capture the events
 * land on whatever is underneath — which is why naive versions drop the drag
 * the moment you move quickly.
 *
 * Desktop only. Below md the sidebar is a fixed-width slide-over drawer, and
 * a resize grip on a touch target that overlays the whole screen is a way to
 * fight the scroll gesture, not a feature.
 */
export function useSidebarWidth() {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);

  // Read after mount: touching localStorage during render would make the
  // server and client disagree on the first paint.
  useEffect(() => {
    setWidth(readStoredWidth(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)));
  }, []);

  const persist = useCallback((next: number) => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  }, []);

  return { width, setWidth, dragging, setDragging, persist };
}

export function SidebarResizer({
  width,
  onWidth,
  onCommit,
  dragging,
  onDraggingChange,
}: {
  width: number;
  onWidth: (next: number) => void;
  onCommit: (next: number) => void;
  dragging: boolean;
  onDraggingChange: (next: boolean) => void;
}) {
  const startX = useRef(0);
  const startWidth = useRef(width);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Ignore secondary buttons — a right-click drag isn't a resize.
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    startWidth.current = width;
    onDraggingChange(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    onWidth(clampSidebarWidth(startWidth.current + (e.clientX - startX.current)));
  }

  function finish(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onDraggingChange(false);
    onCommit(width);
  }

  /** Keyboard resizing, because a mouse-only control is not a control. */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 32 : 8;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = clampSidebarWidth(width - step);
    else if (e.key === 'ArrowRight') next = clampSidebarWidth(width + step);
    else if (e.key === 'Home') next = SIDEBAR_MIN_WIDTH;
    else if (e.key === 'End') next = SIDEBAR_MAX_WIDTH;
    if (next === null) return;
    e.preventDefault();
    onWidth(next);
    onCommit(next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        onWidth(SIDEBAR_DEFAULT_WIDTH);
        onCommit(SIDEBAR_DEFAULT_WIDTH);
      }}
      title="Drag to resize · double-click to reset"
      className={cn(
        // Sits over the border and slightly past it: a 1px target is a target
        // you miss. The visible line stays 1px — only the grab zone is wide.
        'absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize md:block',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2',
        'after:bg-transparent after:transition-colors hover:after:bg-brand/50',
        'focus-visible:outline-none focus-visible:after:bg-brand',
        dragging && 'after:bg-brand',
      )}
    />
  );
}
