"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, ChevronDown, KeyRound, LogOut, Plus, Smartphone, Sparkles, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useIds, useMe } from "@/lib/session";
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme";
import { Segmented, useAuthMethods } from "./auth-code";
import { Avatar } from "./auth-flow";
import { tick, useLens } from "./glass";
import { LanguageSwitch } from "./language-switch";
import { Mark } from "./mark";

/**
 * The account menu, shaped like the ones in large suites: who you are, which organisation you are in (and the
 * others you belong to), the other accounts signed in on this device, your preferences, and signing out. On a phone
 * it is a sheet that rises from the bottom and is dragged away; on a wide screen a panel beside the sidebar.
 */
export function AccountMenu({ variant }: { variant: "avatar" | "row" }) {
  const { t } = useI18n();
  const me = useMe();
  const { orgId } = useIds();
  const [open, setOpen] = useState(false);
  const user = me.data?.user;
  const current = me.data?.memberships.find((m) => m.orgId === orgId);
  if (!user) return null;
  return (
    <>
      {variant === "avatar" ? (
        <button
          type="button"
          aria-label={t.account.menu}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            tick();
            setOpen(true);
          }}
          className="fc-glass fc-press grid size-10 shrink-0 place-items-center rounded-full"
        >
          <Avatar name={user.name} email={user.email} size={32} />
        </button>
      ) : (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="fc-press flex w-full items-center gap-3 rounded-[22px] p-2 text-left hover:bg-[var(--glass-field)]"
        >
          <Avatar name={user.name} email={user.email} size={36} />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium">{user.name}</span>
            <span className="block truncate text-xs text-muted">
              {current ? `${t.settings.roles[current.role]} · ${current.orgName}` : user.email}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
        </button>
      )}
      {open ? <AccountSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AccountSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const { orgId } = useIds();
  const methods = useAuthMethods();
  const device = useQuery({
    queryKey: ["device-accounts"],
    queryFn: () => unwrap(api.GET("/api/v1/auth/accounts")),
    staleTime: 0,
  });
  const lens = useLens<HTMLDivElement>({ bezel: 30, depth: 22 });
  const panel = useRef<HTMLDivElement | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const [section, setSection] = useState<"org" | "password" | null>(null);
  const [orgName, setOrgName] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => setTheme(readTheme()), []);

  const close = () => {
    setLeaving(true);
    setTimeout(onClose, 260);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => removeEventListener("keydown", onKey);
  });

  const user = me.data?.user;
  const memberships = me.data?.memberships ?? [];
  const others = (device.data?.accounts ?? []).filter((a) => !a.active);
  const inDemo = memberships.some((m) => m.orgSlug === methods.data?.demo?.slug);

  async function act(task: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try {
      await task();
    } catch (err) {
      setNote({
        ok: false,
        text:
          err instanceof ApiError && err.problems.length
            ? `${err.message} ${err.problems.join(" ")}`
            : err instanceof Error
              ? err.message
              : String(err),
      });
    } finally {
      setBusy(false);
    }
  }
  const openOrg = (id: string) => {
    onClose();
    router.push(`/?org=${id}`);
  };

  const createOrg = (e: FormEvent) => {
    e.preventDefault();
    return act(async () => {
      const org = await unwrap(api.POST("/api/v1/orgs", { body: { name: orgName } }));
      await qc.invalidateQueries({ queryKey: ["me"] });
      openOrg(org.id);
    });
  };
  const joinDemo = () =>
    act(async () => {
      const org = await unwrap(api.POST("/api/v1/orgs/demo/join"));
      await qc.invalidateQueries({ queryKey: ["me"] });
      openOrg(org.id);
    });
  const switchTo = (userId: string) =>
    act(async () => {
      await unwrap(api.POST("/api/v1/auth/accounts/switch", { body: { userId } }));
      qc.clear();
      onClose();
      router.replace("/");
    });
  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    return act(async () => {
      await unwrap(
        api.POST("/api/v1/me/password", {
          body: { currentPassword: user?.hasPassword ? current : undefined, newPassword: next },
        }),
      );
      setCurrent("");
      setNext("");
      setSection(null);
      setNote({ ok: true, text: t.account.saved });
      qc.invalidateQueries({ queryKey: ["me"] });
    });
  };
  const signOut = (everyone: boolean) =>
    act(async () => {
      const res = await unwrap(api.POST("/api/v1/auth/logout", { body: { everyone } }));
      qc.clear();
      onClose();
      router.replace(res.next ? "/" : "/login");
    });

  if (!user) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        aria-label={t.common.close}
        tabIndex={-1}
        onClick={close}
        className={clsx("fc-scrim absolute inset-0 cursor-default", leaving && "fc-scrim-out")}
      />
      <div
        ref={(node) => {
          panel.current = node;
          lens.ref(node);
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t.account.menu}
        tabIndex={-1}
        style={{ ...lens.style, ...(drag ? { transform: `translateY(${drag}px)`, transition: "none" } : {}) }}
        className={clsx(
          "fc-glass fc-glass-strong fc-sheet absolute inset-x-2 bottom-[calc(var(--app-bottom)+8px)] flex max-h-[min(86dvh,760px)] flex-col overflow-hidden rounded-[32px] outline-none lg:inset-x-auto lg:bottom-3 lg:left-3 lg:w-[360px]",
          leaving && "fc-sheet-out",
        )}
      >
        {lens.defs}
        {/* drag the handle down to put the sheet away, as on a phone */}
        <div
          className="flex shrink-0 cursor-grab touch-none justify-center pt-2.5 pb-1 lg:hidden"
          onPointerDown={(e) => {
            start.current = e.clientY;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => start.current !== null && setDrag(Math.max(0, e.clientY - start.current))}
          onPointerUp={() => {
            start.current = null;
            if (drag > 90) close();
            setDrag(0);
          }}
        >
          <span className="h-1.5 w-10 rounded-full bg-[var(--glass-hairline)] shadow-[inset_0_0_0_1px_var(--glass-hairline)]" />
        </div>

        <div className="min-h-0 overflow-y-auto overscroll-contain px-3 pt-2 pb-3 lg:pt-3">
          <div className="flex items-center gap-3 px-2 pb-4">
            <Avatar name={user.name} email={user.email} size={48} />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[17px] font-semibold">{user.name}</div>
              <div className="truncate text-sm text-muted">{user.email}</div>
            </div>
          </div>

          <Group title={t.account.organisations}>
            {memberships.map((m) => (
              <Row
                key={m.orgId}
                onClick={() => (m.orgId === orgId ? close() : openOrg(m.orgId))}
                icon={<OrgBadge name={m.orgName} />}
                title={m.orgName}
                note={t.settings.roles[m.role]}
                trailing={m.orgId === orgId ? <Check className="size-4 text-accent" aria-hidden /> : null}
              />
            ))}
            {methods.data?.demo && !inDemo ? (
              <Row
                onClick={joinDemo}
                icon={<Sparkles className="size-[18px]" aria-hidden />}
                title={t.account.joinDemo}
                note={methods.data.demo.name}
              />
            ) : null}
            <Row
              onClick={() => setSection(section === "org" ? null : "org")}
              icon={<Plus className="size-[18px]" aria-hidden />}
              title={t.account.newOrg}
            />
            {section === "org" ? (
              <form onSubmit={createOrg} className="fc-rise flex gap-2 px-3 pt-1 pb-3">
                <input
                  required
                  minLength={2}
                  // biome-ignore lint/a11y/noAutofocus: opened to type the name
                  autoFocus
                  aria-label={t.account.orgName}
                  placeholder={t.account.orgName}
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  className="fc-field h-10 min-w-0 flex-1 rounded-xl px-3 text-sm outline-none focus-visible:outline-none"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="fc-prominent fc-press h-10 shrink-0 rounded-full px-4 text-sm font-semibold"
                >
                  {t.account.create}
                </button>
              </form>
            ) : null}
          </Group>

          <Group title={t.account.device}>
            {others.map((a) => (
              <Row
                key={a.userId}
                onClick={() => switchTo(a.userId)}
                icon={<Avatar name={a.name} email={a.email} size={30} />}
                title={a.name}
                note={a.email}
              />
            ))}
            <Row
              onClick={() => {
                onClose();
                router.push("/login?add=1");
              }}
              icon={<UserPlus className="size-[18px]" aria-hidden />}
              title={t.account.add}
            />
          </Group>

          <Group>
            <div className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="text-[15px]">{t.account.language}</span>
              <LanguageSwitch glass={false} />
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="text-[15px]">{t.account.appearance}</span>
              <div className="w-[208px]">
                <Segmented
                  label={t.account.appearance}
                  value={theme}
                  onChange={(v) => {
                    setTheme(v);
                    applyTheme(v);
                  }}
                  options={[
                    { key: "system", label: t.account.system },
                    { key: "light", label: t.account.light },
                    { key: "dark", label: t.account.dark },
                  ]}
                />
              </div>
            </div>
            <div className="fc-web-only">
              <Row
                onClick={() => {
                  onClose();
                  router.push("/app");
                }}
                icon={<Smartphone className="size-[18px]" aria-hidden />}
                title={t.download.get}
              />
            </div>
            <Row
              onClick={() => setSection(section === "password" ? null : "password")}
              icon={<KeyRound className="size-[18px]" aria-hidden />}
              title={user.hasPassword ? t.account.changePassword : t.account.setPassword}
            />
            {section === "password" ? (
              <form onSubmit={savePassword} className="fc-rise space-y-2 px-3 pt-1 pb-3">
                {user.hasPassword ? (
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    aria-label={t.account.currentPassword}
                    placeholder={t.account.currentPassword}
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                    className="fc-field h-10 w-full rounded-xl px-3 text-sm outline-none focus-visible:outline-none"
                  />
                ) : null}
                <div className="flex gap-2">
                  <input
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                    aria-label={t.account.newPassword}
                    placeholder={t.account.newPassword}
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    className="fc-field h-10 min-w-0 flex-1 rounded-xl px-3 text-sm outline-none focus-visible:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={busy}
                    className="fc-prominent fc-press h-10 shrink-0 rounded-full px-4 text-sm font-semibold"
                  >
                    {t.account.save}
                  </button>
                </div>
              </form>
            ) : null}
          </Group>

          {note ? (
            <p
              role="status"
              className={clsx("fc-rise px-3 pb-3 text-sm", note.ok ? "text-saving" : "text-danger")}
            >
              {note.text}
            </p>
          ) : null}

          <Group>
            <Row
              onClick={() => signOut(false)}
              icon={
                busy ? (
                  <Mark motion="breathe" className="size-[18px]" />
                ) : (
                  <LogOut className="size-[18px]" aria-hidden />
                )
              }
              title={t.account.signOut}
              tone="danger"
            />
            {others.length ? (
              <Row onClick={() => signOut(true)} icon={<span />} title={t.account.signOutAll} tone="danger" />
            ) : null}
          </Group>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      {title ? <h3 className="px-3 pb-1.5 text-xs font-medium text-muted">{title}</h3> : null}
      <div className="fc-field divide-y divide-[var(--glass-hairline)] overflow-hidden rounded-[20px]">
        {children}
      </div>
    </section>
  );
}

function Row({
  onClick,
  icon,
  title,
  note,
  trailing,
  tone,
}: {
  onClick: () => void;
  icon: ReactNode;
  title: string;
  note?: string;
  trailing?: ReactNode;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "fc-press flex w-full items-center gap-3 px-3 py-2.5 text-left",
        tone === "danger" ? "text-danger" : "",
      )}
    >
      <span className="grid size-[30px] shrink-0 place-items-center text-muted">{icon}</span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[15px]">{title}</span>
        {note ? <span className="mt-0.5 block truncate text-xs text-muted">{note}</span> : null}
      </span>
      {trailing}
    </button>
  );
}

/** A square badge with the organisation's first character, like a workspace icon. */
function OrgBadge({ name }: { name: string }) {
  return (
    <span className="grid size-[30px] place-items-center rounded-[9px] bg-accent-soft text-[13px] font-semibold text-accent">
      {[...name.trim()][0]?.toUpperCase() ?? "·"}
    </span>
  );
}
