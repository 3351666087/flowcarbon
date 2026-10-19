"use client";

import { clsx } from "clsx";
import { Ellipsis, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { useBackClose } from "@/lib/back";
import { tick, useLens } from "./glass";
import { useLiquid } from "./liquid";

export interface Tab {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
}

/** a phone tab bar holds five; past that the last slot opens the rest */
const SLOTS = 5;

/**
 * The phone tab bar, as iOS 26 draws it: a capsule of glass floating over the content, with a liquid selection that
 * stretches from tab to tab. Press and slide along it and the selection lifts into a lens that magnifies the tab under
 * the finger, ticking as it crosses each one; let go to open it. Scrolling down shrinks the bar out of the way,
 * scrolling up brings it back.
 */
export function TabBar({
  tabs,
  active,
  moreLabel,
}: {
  tabs: Tab[];
  active: string | null;
  moreLabel: string;
}) {
  const router = useRouter();
  const overflow = tabs.length > SLOTS;
  const primary = overflow ? tabs.slice(0, SLOTS - 1) : tabs;
  const rest = overflow ? tabs.slice(SLOTS - 1) : [];
  const [menu, setMenu] = useState(false);
  // where a slide was released, held until the page it opens takes over
  const [pending, setPending] = useState<string | null>(null);
  const slot = pending ?? (rest.some((t) => t.key === active) ? "more" : active);
  const [compact, setCompact] = useState(false);
  const [dragging, setDragging] = useState(false);
  const bar = useLens<HTMLElement>({ bezel: 18, depth: 14 });
  const lens = useLens<HTMLSpanElement>({ bezel: 14, depth: 12, zoom: 1.22, disabled: !dragging });
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  useLiquid("x", slot, row, lens.el, dragging);

  const drag = useRef<{
    x: number;
    id: number;
    moved: boolean;
    over: string | null;
    // measured once when the slide starts, so moving the finger never forces a layout
    left?: number;
    scale?: number;
    span?: number;
    items?: { key: string; right: number; width: number }[];
  } | null>(null);
  const swallowClick = useRef(false);

  // shrink while reading down the page, return when heading back up
  useEffect(() => {
    let lastY = scrollY;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = scrollY;
        const dy = y - lastY;
        if (y < 48) setCompact(false);
        else if (dy > 10) setCompact(true);
        else if (dy < -10) setCompact(false);
        if (y < 48 || Math.abs(dy) > 10) lastY = y;
      });
    };
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("scroll", onScroll);
    };
  }, []);

  // a page change closes the menu and ends any hand-off
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacting to navigation is the point
  useEffect(() => {
    setMenu(false);
    setPending(null);
  }, [active]);
  useBackClose(() => setMenu(false), menu);

  const keyAt = (clientX: number) => {
    const items = row?.querySelectorAll<HTMLElement>("[data-liquid-key]") ?? [];
    let key: string | null = null;
    for (const el of items) {
      key = el.dataset.liquidKey ?? null;
      if (clientX < el.getBoundingClientRect().right) break;
    }
    return key;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, id: e.pointerId, moved: false, over: slot };
    setCompact(false);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const box = row;
    const el = lens.el;
    if (!d || d.id !== e.pointerId || !box || !el) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < 8) return;
      d.moved = true;
      box.setPointerCapture(e.pointerId);
      const r = box.getBoundingClientRect();
      d.left = r.left;
      d.scale = r.width / box.offsetWidth || 1;
      d.span = box.offsetWidth;
      d.items = [...box.querySelectorAll<HTMLElement>("[data-liquid-key]")].map((x) => ({
        key: x.dataset.liquidKey ?? "",
        right: x.getBoundingClientRect().right,
        width: x.offsetWidth,
      }));
      for (const a of el.getAnimations()) a.cancel();
      setDragging(true);
    }
    const items = d.items ?? [];
    const under = items.find((x) => e.clientX < x.right) ?? items[items.length - 1];
    const key = under?.key ?? null;
    const width = under?.width ?? el.offsetWidth;
    const span = d.span ?? box.offsetWidth;
    const centre = Math.max(
      width / 2,
      Math.min(span - width / 2, (e.clientX - (d.left ?? 0)) / (d.scale ?? 1)),
    );
    // the selection lifts into a lens under the finger and follows it directly
    el.style.transform = `translate3d(${centre - width / 2}px,0,0) scale(1.14,1.08)`;
    if (key !== d.over) {
      d.over = key;
      tick();
    }
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    setDragging(false);
    const key = keyAt(e.clientX);
    if (key === "more") setMenu(true);
    else {
      const tab = tabs.find((t) => t.key === key);
      if (tab && tab.key !== active) {
        setPending(tab.key);
        router.push(tab.href);
      }
    }
  };

  const item = (key: string, label: string, Icon: LucideIcon, href?: string) => {
    const on = slot === key;
    const body = (
      <>
        <Icon className="size-[22px] shrink-0" strokeWidth={on ? 2.3 : 1.9} aria-hidden />
        <span className="fc-tab-label max-w-full truncate text-[10.5px] font-medium leading-tight">
          {label}
        </span>
      </>
    );
    const cls = clsx(
      "fc-press relative z-10 flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 py-1.5 select-none",
      on ? "text-accent" : "text-muted",
    );
    return href ? (
      <Link
        key={key}
        href={href}
        // the tabs are always on screen: fetch their pages ahead, so a tap never waits on the network
        prefetch
        data-liquid-key={key}
        aria-current={on ? "page" : undefined}
        className={cls}
        draggable={false}
        onClick={() => !on && tick()}
      >
        {body}
      </Link>
    ) : (
      <button
        key={key}
        type="button"
        data-liquid-key={key}
        aria-expanded={menu}
        aria-haspopup="menu"
        className={cls}
        onClick={() => setMenu((m) => !m)}
      >
        {body}
      </button>
    );
  };

  return (
    <>
      {menu ? (
        <>
          <button
            type="button"
            aria-label={moreLabel}
            tabIndex={-1}
            className="fixed inset-0 z-30 cursor-default lg:hidden"
            onClick={() => setMenu(false)}
          />
          <div
            role="menu"
            className="fc-glass fc-glass-strong fc-bloom fixed right-3 bottom-[calc(max(12px,calc(var(--app-bottom)+8px))+76px)] z-40 w-60 origin-bottom-right rounded-[28px] p-1.5 lg:hidden"
          >
            {rest.map(({ key, href, label, icon: Icon }) => (
              <Link
                key={key}
                href={href}
                prefetch
                role="menuitem"
                aria-current={active === key ? "page" : undefined}
                onClick={() => setMenu(false)}
                className={clsx(
                  "fc-press flex items-center gap-3 rounded-[22px] px-4 py-3 text-[15px] font-medium",
                  active === key ? "bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-accent" : "",
                )}
              >
                <Icon className="size-5 shrink-0" aria-hidden />
                {label}
              </Link>
            ))}
          </div>
        </>
      ) : null}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pb-[max(12px,calc(var(--app-bottom)+8px))] lg:hidden">
        <nav
          ref={bar.ref}
          style={bar.style}
          aria-label="Main"
          data-compact={compact || undefined}
          className="fc-glass fc-tabbar pointer-events-auto mx-auto max-w-md rounded-full p-1.5"
        >
          {bar.defs}
          <div
            ref={setRow}
            className="relative flex touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(false);
            }}
            onClickCapture={(e) => {
              if (!swallowClick.current) return;
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <span
              ref={lens.ref}
              style={lens.style}
              className={clsx(
                "fc-liquid",
                dragging ? "fc-glass z-20" : "z-0 bg-[color-mix(in_oklab,var(--accent)_15%,transparent)]",
              )}
              data-drag={dragging || undefined}
            >
              {lens.defs}
            </span>
            {primary.map(({ key, href, label, icon }) => item(key, label, icon, href))}
            {overflow ? item("more", moreLabel, Ellipsis) : null}
          </div>
        </nav>
      </div>
    </>
  );
}
