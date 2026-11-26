import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

let dismissActive: (() => void) | undefined;

export function useTooltip(content: ReactNode, { describe = false, when }: {
  describe?: boolean;
  when?: (anchor: HTMLElement) => boolean;
} = {}) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | undefined>(undefined);

  useEffect(() => () => stop.current?.(), []);

  useLayoutEffect(() => {
    const tooltip = bubble.current;
    if (!anchor || !tooltip) return;

    function position() {
      if (!tooltip || !anchor) return;
      const margin = 8;
      const viewport = document.documentElement;
      const rect = anchor.getBoundingClientRect();
      const { offsetWidth: width, offsetHeight: height } = tooltip;
      const below = rect.bottom + margin;
      const above = rect.top - margin - height;
      const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max - margin));
      tooltip.style.left = `${clamp(rect.left + (rect.width - width) / 2, viewport.clientWidth - width)}px`;
      const fitsBelow = below + height <= viewport.clientHeight - margin;
      const hasMoreRoomBelow = rect.top < viewport.clientHeight - rect.bottom;
      const top = fitsBelow || (above < margin && hasMoreRoomBelow) ? below : above;
      tooltip.style.top = `${clamp(top, viewport.clientHeight - height)}px`;
    }

    position();
    const observer = new ResizeObserver(position);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [anchor]);

  function start(element: HTMLElement, keyboard: boolean) {
    if (element === anchor || element.getAttribute("aria-expanded") === "true" ||
        document.querySelector(".recent-menu-items:popover-open") || when && !when(element)) return;

    dismissActive?.();
    const listeners = new AbortController();
    const { signal } = listeners;
    let timer: number | undefined;

    function dismiss() {
      window.clearTimeout(timer);
      listeners.abort();
      stop.current = undefined;
      if (dismissActive === dismiss) dismissActive = undefined;
      setAnchor(null);
    }

    stop.current = dismiss;
    dismissActive = dismiss;
    if (keyboard) {
      setAnchor(element);
    } else {
      timer = window.setTimeout(() => {
        if (when && !when(element)) dismiss();
        else setAnchor(element);
      }, 500);
    }

    function contains(rect: DOMRect, x: number, y: number) {
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    document.addEventListener("pointermove", ({ clientX: x, clientY: y }) => {
      if (keyboard && document.activeElement === element) return;
      const target = element.getBoundingClientRect();
      if (contains(target, x, y)) return;
      if (bubble.current && !bubble.current.hidden) {
        const tip = bubble.current.getBoundingClientRect();
        if (contains(tip, x, y)) return;
        // Keep the tooltip visible while the pointer crosses the gap to it.
        if (x >= Math.max(tip.left, target.left) && x <= Math.min(tip.right, target.right) &&
            y >= Math.min(tip.bottom, target.bottom) && y <= Math.max(tip.top, target.top)) return;
      }
      dismiss();
    }, { signal });
    document.addEventListener("pointerout", (event) => {
      if (!event.relatedTarget && !keyboard) dismiss();
    }, { signal });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") dismiss();
    }, { signal, capture: true });
    for (const event of ["pointerdown", "contextmenu", "dragstart", "scroll"]) {
      document.addEventListener(event, dismiss, { signal, capture: true });
    }
    window.addEventListener("resize", dismiss, { signal });
    window.addEventListener("blur", dismiss, { signal });
  }

  return {
    id,
    trigger: {
      onPointerEnter: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType !== "touch" && !event.buttons) start(event.currentTarget, false);
      },
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (event.currentTarget.matches(":focus-visible")) start(event.currentTarget, true);
      },
      onBlur: () => stop.current?.(),
    },
    tooltip: createPortal(
      <div ref={bubble} id={id} role="tooltip" className="soft-start-tooltip" hidden={!anchor}
        aria-hidden={describe ? undefined : true}>
        {content}
      </div>, document.body),
  };
}
