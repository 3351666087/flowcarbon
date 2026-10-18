"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";

/** the tabs, in the order the tab bar and sidebar show them */
const ORDER = ["floors", "findings", "forecast", "simulate", "requests", "report", "data", "settings"];

// where the previous page was, to tell which way this one arrives
let previous: string | null = null;

/**
 * Re-mounted on every navigation inside a building, so each page arrives with motion that says where it came from:
 * a detail slides in from the right (push), coming back slides in from the left (pop), and moving between tabs
 * shifts sideways in the order of the tabs.
 */
export default function BuildingTemplate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [kind] = useState(() => {
    const now = pathname.split("/").filter(Boolean);
    const before = previous?.split("/").filter(Boolean);
    previous = pathname;
    if (!before || before.slice(0, 4).join("/") !== now.slice(0, 4).join("/")) return "fade";
    if (now.length > before.length) return "push";
    if (now.length < before.length) return "pop";
    const a = ORDER.indexOf(before[4] ?? "");
    const b = ORDER.indexOf(now[4] ?? "");
    return b > a ? "next" : b < a ? "prev" : "fade";
  });
  return <div className={`fc-route-${kind}`}>{children}</div>;
}
