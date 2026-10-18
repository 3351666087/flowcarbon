import { clsx } from "clsx";

/** The FlowCarbon mark: three floors of a building, drawn as one stroke each (same geometry as app/icon.svg). */
const FLOORS = ["M0 -10 L11 -4.5 L0 1 L-11 -4.5 Z", "M-11 0.5 L0 6 L11 0.5", "M-11 5.5 L0 11 L11 5.5"];

export function Mark({ className, motion }: { className?: string; motion?: "settle" | "breathe" }) {
  return (
    <svg
      viewBox="-13 -12.5 26 25"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx(motion === "settle" && "fc-mark", motion === "breathe" && "fc-loader", className)}
    >
      {FLOORS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The mark on its tile, the way the app icon looks on a home screen. */
export function MarkTile({ className, motion }: { className?: string; motion?: "settle" | "breathe" }) {
  return (
    <span className={clsx("fc-tile grid shrink-0 place-items-center", className)}>
      <Mark className="size-[64%]" motion={motion} />
    </span>
  );
}
