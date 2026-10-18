"use client";

import { clsx } from "clsx";
import { AlertTriangle } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  Children,
  cloneElement,
  createContext,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useContext,
  useEffect,
  useRef,
} from "react";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { Mark } from "./mark";

/**
 * The shell listens for the page's title: when the large title scrolls up under the top bar, the bar shows it
 * small, as iOS and Android large-title screens do.
 */
export const ShellTitle = createContext<((title: string | null) => void) | null>(null);

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  const show = useContext(ShellTitle);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const el = heading.current;
    if (!show || !el) return;
    // the top bar is about 64px tall plus the status bar; the title counts as gone once it slides under it
    const top =
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-top")) || 0;
    const observer = new IntersectionObserver(([entry]) => show(entry?.isIntersecting ? null : title), {
      rootMargin: `-${Math.round(top + 60)}px 0px 0px 0px`,
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      show(null);
    };
  }, [show, title]);
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1
          ref={heading}
          className="text-[28px] leading-tight font-bold tracking-tight sm:text-2xl sm:font-semibold"
        >
          {title}
        </h1>
        {subtitle ? <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  pad = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    // min-w-0: as a grid or flex item a card must not grow to fit a wide table; the table scrolls instead
    <section
      data-spotlight
      className={clsx("min-w-0 rounded-2xl border border-border bg-surface", className)}
    >
      {title || actions ? (
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </div>
      ) : null}
      <div className={clsx(pad && "p-4")}>{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "waste" | "saving" | "accent";
}) {
  return (
    <div data-spotlight className="rounded-2xl border border-border bg-surface p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div
        className={clsx(
          "num mt-1 text-xl font-semibold tracking-tight sm:text-2xl",
          tone === "waste" && "text-waste",
          tone === "saving" && "text-saving",
          tone === "accent" && "text-accent",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

const BADGE = {
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent-soft text-accent",
  waste: "bg-waste-soft text-waste",
  saving: "bg-saving-soft text-saving",
  danger: "bg-danger-soft text-danger",
};

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: keyof typeof BADGE;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        BADGE[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Every figure says whether it was metered or estimated. */
export function TierBadge({ tier }: { tier: string }) {
  const { t } = useI18n();
  return tier === "measured" ? (
    <Badge tone="accent" title={t.common.measuredHint}>
      {t.common.measured}
    </Badge>
  ) : (
    <span
      title={t.common.estimatedHint}
      className="inline-flex items-center whitespace-nowrap rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted"
    >
      {t.common.estimated}
    </span>
  );
}

export function Button({
  variant = "secondary",
  busy,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={clsx(
        "fc-press inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "fc-prominent hover:brightness-105",
        variant === "secondary" && "border border-border bg-surface hover:bg-surface-2",
        variant === "ghost" && "hover:bg-surface-2",
        variant === "danger" && "border border-border bg-surface text-danger hover:bg-danger-soft",
        className,
      )}
    >
      {busy ? <Mark motion="breathe" className="size-4" /> : null}
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as a child
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

const control =
  "h-9 w-full min-w-0 rounded-xl border border-border bg-surface px-3 text-sm outline-none transition-shadow focus:border-accent focus:ring-4 focus:ring-[var(--ring)]";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(control, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(control, "pr-8", props.className)} />;
}

/**
 * Loading. `full`: the brand loader on an empty screen (the app starting). `page`: the outline of a page (title,
 * figures, a card) so the screen keeps its shape while data arrives. Otherwise: a few shimmering lines in place.
 */
export function Loading({ full = false, page = false }: { full?: boolean; page?: boolean }) {
  const { t } = useI18n();
  if (full)
    return (
      <div className="grid min-h-dvh place-items-center" role="status">
        <div className="flex flex-col items-center gap-3 text-sm text-muted">
          <Mark motion="breathe" className="size-10 text-accent" />
          {t.common.loading}
        </div>
      </div>
    );
  if (page)
    return (
      <div role="status" aria-label={t.common.loading} className="fc-fade">
        <div className="fc-skel mb-2 h-8 w-40" />
        <div className="fc-skel mb-6 h-4 w-72 max-w-full" />
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="fc-skel h-[92px] rounded-2xl" />
          ))}
        </div>
        <div className="fc-skel h-64 rounded-2xl" />
      </div>
    );
  return (
    <div role="status" aria-label={t.common.loading} className="fc-fade space-y-2.5 py-3">
      <div className="fc-skel h-4 w-2/5" />
      <div className="fc-skel h-4 w-4/5" />
      <div className="fc-skel h-4 w-3/5" />
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const e = error instanceof ApiError ? error : null;
  const message =
    e?.status === 403
      ? t.common.forbidden
      : (e?.message ?? (error instanceof Error ? error.message : String(error)));
  return (
    <div className="fc-rise rounded-2xl border border-border bg-danger-soft p-4 text-sm" role="alert">
      <div className="flex items-center gap-2 font-semibold text-danger">
        <AlertTriangle className="size-4" aria-hidden /> {t.common.errorTitle}
      </div>
      <p className="mt-1">{message}</p>
      {e?.problems.length ? (
        <ul className="mt-2 list-disc pl-5">
          {e.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {e?.requestId ? (
        <p className="mt-2 text-xs text-muted">
          {t.common.requestId}: <code>{e.requestId}</code>
        </p>
      ) : null}
      {onRetry ? (
        <Button className="mt-3" onClick={onRetry}>
          {t.common.retry}
        </Button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted">
      {children}
    </div>
  );
}

/**
 * A data table. On a phone each row becomes a small card of label and value lines (the labels come from `head`),
 * so nothing has to be scrolled sideways.
 */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  const labels = head.map((h) => (typeof h === "string" ? h : ""));
  const rows = Children.map(children, (row) => {
    if (!isValidElement<{ children?: ReactNode }>(row)) return row;
    const cells = Children.map(row.props.children, (cell, i) =>
      isValidElement(cell)
        ? cloneElement(cell as ReactElement<{ "data-label"?: string }>, { "data-label": labels[i] ?? "" })
        : cell,
    );
    return cloneElement(row, {}, cells);
  });
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="fc-table w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            {head.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static header cells
              <th key={i} className="px-4 py-2 font-medium first:pl-4">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-border [&>tr:last-child]:border-0 [&_td]:px-4 [&_td]:py-2.5">
          {rows}
        </tbody>
      </table>
    </div>
  );
}
