import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | {
      kind: "item";
      label: string;
      hotkey?: string;
      onClick: () => void;
      disabled?: boolean;
      /** Optional hover-tooltip; shown by the browser as title attribute. */
      title?: string;
    }
  | { kind: "separator" }
  | {
      kind: "submenu";
      label: string;
      items: MenuItem[];
      disabled?: boolean;
      title?: string;
    };

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Clamp into viewport after first render (when we know our size).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 4;
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - pad) {
      left = window.innerWidth - rect.width - pad;
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - rect.height - pad;
    }
    setPosition({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      // Walk up from the click target: if it's inside the root menu OR
      // any open submenu (which lives in a sibling portal and tags itself
      // data-fvp-submenu), let the click stand. Otherwise dismiss.
      const target = e.target as Element | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (target.closest("[data-fvp-submenu]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed bg-fvp-surface border border-fvp-border rounded shadow-lg py-1 min-w-[220px] z-40 text-xs select-none"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems items={items} onClose={onClose} />
    </div>,
    document.body,
  );
}

/** Renders a flat list of menu items. Used by both ContextMenu (root)
 *  and Submenu (nested). Submenu items open child Submenus on hover. */
function MenuItems({
  items,
  onClose,
}: {
  items: MenuItem[];
  onClose: () => void;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subAnchor, setSubAnchor] = useState<DOMRect | null>(null);
  const closeSubTimer = useRef<number | null>(null);

  const openSubmenu = (idx: number, rect: DOMRect) => {
    if (closeSubTimer.current !== null) {
      window.clearTimeout(closeSubTimer.current);
      closeSubTimer.current = null;
    }
    setOpenSub(idx);
    setSubAnchor(rect);
  };
  const scheduleCloseSub = () => {
    if (closeSubTimer.current !== null) window.clearTimeout(closeSubTimer.current);
    closeSubTimer.current = window.setTimeout(() => {
      setOpenSub(null);
      setSubAnchor(null);
      closeSubTimer.current = null;
    }, 180);
  };
  const cancelCloseSub = () => {
    if (closeSubTimer.current !== null) {
      window.clearTimeout(closeSubTimer.current);
      closeSubTimer.current = null;
    }
  };

  return (
    <>
      {items.map((item, i) => {
        if (item.kind === "separator") {
          return <div key={`sep-${i}`} className="my-1 border-t border-fvp-border" />;
        }
        if (item.kind === "submenu") {
          const isOpen = openSub === i;
          return (
            <div
              key={i}
              onMouseEnter={(e) => {
                if (item.disabled) return;
                openSubmenu(i, (e.currentTarget as HTMLElement).getBoundingClientRect());
              }}
              onMouseLeave={scheduleCloseSub}
            >
              <button
                disabled={item.disabled}
                title={item.title}
                className={`w-full px-3 py-1.5 text-left flex justify-between items-center gap-6 ${
                  item.disabled
                    ? "text-fvp-muted cursor-not-allowed"
                    : isOpen
                      ? "bg-fvp-accent text-white"
                      : "text-fvp-text hover:bg-fvp-accent hover:text-white cursor-pointer"
                }`}
              >
                <span>{item.label}</span>
                <span className="text-[10px] opacity-80">▸</span>
              </button>
              {isOpen && subAnchor && (
                <Submenu
                  items={item.items}
                  anchor={subAnchor}
                  onMouseEnter={cancelCloseSub}
                  onMouseLeave={scheduleCloseSub}
                  onClose={onClose}
                />
              )}
            </div>
          );
        }
        return (
          <button
            key={i}
            disabled={item.disabled}
            title={item.title}
            onMouseEnter={() => {
              // Close any open submenu when hovering a sibling regular item.
              if (openSub !== null) scheduleCloseSub();
            }}
            onClick={(e) => {
              e.stopPropagation();
              item.onClick();
              onClose();
            }}
            className={`w-full px-3 py-1.5 text-left flex justify-between items-center gap-6 ${
              item.disabled
                ? "text-fvp-muted cursor-not-allowed"
                : "text-fvp-text hover:bg-fvp-accent hover:text-white cursor-pointer"
            }`}
          >
            <span>{item.label}</span>
            {item.hotkey && (
              <span className="text-[10px] opacity-70 font-mono whitespace-nowrap">
                {item.hotkey}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

/** Floating submenu positioned to the right of its parent row. Stays
 *  alive while the cursor is inside it (parent cancels the close timer
 *  on mouseenter). Clamps to viewport. */
function Submenu({
  items,
  anchor,
  onMouseEnter,
  onMouseLeave,
  onClose,
}: {
  items: MenuItem[];
  anchor: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: anchor.right + 2, top: anchor.top });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 4;
    let left = anchor.right + 2;
    let top = anchor.top;
    if (left + rect.width > window.innerWidth - pad) {
      // Flip to the left side of the anchor when there's no room on the right.
      left = anchor.left - rect.width - 2;
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - rect.height - pad;
    }
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      data-fvp-submenu
      className="fixed bg-fvp-surface border border-fvp-border rounded shadow-lg py-1 min-w-[220px] z-50 text-xs select-none"
      style={{ left: pos.left, top: pos.top }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems items={items} onClose={onClose} />
    </div>,
    document.body,
  );
}
