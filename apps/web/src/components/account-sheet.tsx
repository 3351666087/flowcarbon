"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Check,
  ChevronDown,
  DoorOpen,
  KeyRound,
  LogOut,
  Pencil,
  Plus,
  Smartphone,
  Sparkles,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, unwrap } from "@/lib/api";
import { useBackClose } from "@/lib/back";
import { fill, useI18n } from "@/lib/i18n";
import { can, useIds, useMe } from "@/lib/session";
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme";
import { Segmented, useAuthMethods } from "./auth-code";
import { Avatar } from "./auth-flow";
import { AvatarBadge, AvatarSheet } from "./avatar-sheet";
import { Dialog } from "./dialog";
import { tick, useLens } from "./glass";
import { LanguageSwitch } from "./language-switch";
import { Mark } from "./mark";
import { Sheet } from "./sheet";
import { type SwipeAction, SwipeRow } from "./swipe-row";
import { toast } from "./toast";

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
          <Avatar name={user.name} email={user.email} src={user.avatarUrl} size={32} />
        </button>
      ) : (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="fc-press flex w-full items-center gap-3 rounded-[22px] p-2 text-left hover:bg-[var(--glass-field)]"
        >
          <Avatar name={user.name} email={user.email} src={user.avatarUrl} size={36} />
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
  useBackClose(close);
  // focus the sheet once when it opens; doing it on every render pulled focus out of its text fields after each key
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const user = me.data?.user;
  const memberships = me.data?.memberships ?? [];
  const others = (device.data?.accounts ?? []).filter((a) => !a.active);
  // a demo building of one's own (the shared demonstration is read-only)
  const inDemo = memberships.some((m) => m.orgSlug.startsWith("demo-"));

  // an organisation row slid open, and the dialog or sheet opened from it (or for the picture)
  const [swiped, setSwiped] = useState<string | null>(null);
  useBackClose(() => setSwiped(null), swiped !== null);
  const [editing, setEditing] = useState<
    { kind: "avatar" } | { kind: "rename" | "delete" | "leave"; m: (typeof memberships)[number] } | null
  >(null);
  const shared = (m: (typeof memberships)[number]) => m.orgSlug === methods.data?.demo?.slug;
  const orgActions = (m: (typeof memberships)[number]): SwipeAction[] => {
    const list: SwipeAction[] = [];
    if (!shared(m) && can.manageOrg(m.role))
      list.push({
        key: "rename",
        label: t.account.rename,
        tone: "accent",
        icon: <Pencil className="size-4" aria-hidden />,
        run: () => setEditing({ kind: "rename", m }),
      });
    if (!shared(m) && m.role === "owner")
      list.push({
        key: "delete",
        label: t.account.delete,
        tone: "danger",
        icon: <Trash2 className="size-4" aria-hidden />,
        run: () => setEditing({ kind: "delete", m }),
      });
    else
      list.push({
        key: "leave",
        label: t.account.leave,
        tone: "danger",
        icon: <DoorOpen className="size-4" aria-hidden />,
        run: () => setEditing({ kind: "leave", m }),
      });
    return list;
  };
  /** after the current organisation is gone, the start page picks another (or offers to make one) */
  // the organisation leaves the cached session at once, so no screen tries to open it while the session reloads
  const gone = (orgGone: string, note: string) => {
    qc.setQueryData(["me"], (old: typeof me.data) =>
      old ? { ...old, memberships: old.memberships.filter((m) => m.orgId !== orgGone) } : old,
    );
    toast(note);
    setEditing(null);
    if (orgGone === orgId) {
      onClose();
      router.replace("/");
    }
    qc.invalidateQueries({ queryKey: ["me"] });
  };

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
      const org = await unwrap(api.POST("/api/v1/orgs/demo"));
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
            <button
              type="button"
              aria-label={t.account.changeAvatar}
              onClick={() => {
                tick();
                setEditing({ kind: "avatar" });
              }}
              className="fc-press relative shrink-0 rounded-full"
            >
              <Avatar name={user.name} email={user.email} src={user.avatarUrl} size={48} />
              <AvatarBadge />
            </button>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[17px] font-semibold">{user.name}</div>
              <div className="truncate text-sm text-muted">{user.email}</div>
            </div>
          </div>

          <Group title={t.account.organisations}>
            {memberships.map((m) => (
              <SwipeRow
                key={m.orgId}
                actions={orgActions(m)}
                open={swiped === m.orgId}
                onOpenChange={(open) => setSwiped(open ? m.orgId : null)}
                label={fill(t.account.actionsFor, { org: m.orgName })}
              >
                <Row
                  onClick={() => (m.orgId === orgId ? close() : openOrg(m.orgId))}
                  icon={<OrgBadge name={m.orgName} />}
                  title={m.orgName}
                  note={t.settings.roles[m.role]}
                  trailing={m.orgId === orgId ? <Check className="size-4 text-accent" aria-hidden /> : null}
                />
              </SwipeRow>
            ))}
            {methods.data?.demo && !inDemo ? (
              <Row
                onClick={joinDemo}
                icon={<Sparkles className="size-[18px]" aria-hidden />}
                title={t.account.joinDemo}
                note={t.account.joinDemoNote}
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
                icon={<Avatar name={a.name} email={a.email} src={a.avatarUrl} size={30} />}
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
      {editing?.kind === "avatar" ? <AvatarSheet user={user} onClose={() => setEditing(null)} /> : null}
      {editing?.kind === "rename" ? (
        <RenameOrg
          org={editing.m}
          onClose={() => setEditing(null)}
          onDone={async () => {
            await qc.invalidateQueries({ queryKey: ["me"] });
            toast(t.account.renamed);
          }}
        />
      ) : null}
      {editing?.kind === "delete" ? (
        <RemoveOrg
          org={editing.m}
          mode="delete"
          onClose={() => setEditing(null)}
          onDone={() => gone(editing.m.orgId, fill(t.account.deleted, { name: editing.m.orgName }))}
        />
      ) : null}
      {editing?.kind === "leave" ? (
        <RemoveOrg
          org={editing.m}
          mode="leave"
          onClose={() => setEditing(null)}
          onDone={() => gone(editing.m.orgId, fill(t.account.left, { name: editing.m.orgName }))}
        />
      ) : null}
    </div>,
    document.body,
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      {title ? <h3 className="px-3 pb-1.5 text-xs font-medium text-muted">{title}</h3> : null}
      <div className="fc-field fc-still divide-y divide-[var(--glass-hairline)] overflow-hidden rounded-[20px]">
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

interface OrgRef {
  orgId: string;
  orgName: string;
}

/** A new name for an organisation. */
function RenameOrg({
  org,
  onClose,
  onDone,
}: {
  org: OrgRef;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(org.orgName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (close: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.PATCH("/api/v1/orgs/{orgId}", { params: { path: { orgId: org.orgId } }, body: { name } }),
      );
      await onDone();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={t.account.renameTitle}
      onClose={onClose}
      footer={(close) => (
        <button
          type="button"
          disabled={busy || name.trim().length < 2 || name.trim() === org.orgName}
          onClick={() => save(close)}
          className="fc-prominent fc-press h-11 w-full rounded-full text-[15px] font-semibold disabled:opacity-50"
        >
          {t.account.save}
        </button>
      )}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: the sheet opens to type the name
        autoFocus
        value={name}
        maxLength={120}
        aria-label={t.account.orgName}
        onChange={(e) => setName(e.target.value)}
        className="fc-field h-12 w-full rounded-2xl px-4 text-[15px] outline-none focus-visible:outline-none"
      />
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </Sheet>
  );
}

/** Deleting an organisation (owners; held down, it cannot be undone) or leaving it. */
function RemoveOrg({
  org,
  mode,
  onClose,
  onDone,
}: {
  org: OrgRef;
  mode: "delete" | "leave";
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buildings = useQuery({
    queryKey: ["buildings", org.orgId],
    enabled: mode === "delete",
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/buildings", { params: { path: { orgId: org.orgId } } })),
  });
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "delete")
        await unwrap(api.DELETE("/api/v1/orgs/{orgId}", { params: { path: { orgId: org.orgId } } }));
      else
        await unwrap(
          api.DELETE("/api/v1/orgs/{orgId}/membership", { params: { path: { orgId: org.orgId } } }),
        );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  const n = buildings.data?.length;
  return (
    <Dialog
      title={fill(mode === "delete" ? t.account.deleteTitle : t.account.leaveTitle, { name: org.orgName })}
      confirm={mode === "delete" ? t.account.holdToDelete : t.account.leave}
      tone="danger"
      hold={mode === "delete"}
      busy={busy}
      onConfirm={run}
      onClose={onClose}
    >
      <p>
        {mode === "delete"
          ? n === 0
            ? t.account.deleteEmpty
            : fill(t.account.deleteBody, {
                buildings: n === 1 ? t.account.oneBuilding : fill(t.account.buildings, { n: n ?? "…" }),
              })
          : t.account.leaveBody}
      </p>
      {error ? <p className="mt-2 text-danger">{error}</p> : null}
    </Dialog>
  );
}
