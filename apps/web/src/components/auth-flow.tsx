"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  Smartphone,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ApiError, api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useAuthMethods } from "./auth-code";
import {
  AuthStage,
  FieldGroup,
  GroupField,
  groupInput,
  RememberRow,
  SheetStep,
  StepHeader,
  useRemember,
} from "./auth-stage";
import { tick } from "./glass";
import { Mark } from "./mark";
import { OtpInput } from "./otp-input";

type Step = "choose" | "email" | "code" | "password" | "profile";
type Me = { user: { email: string } };

/**
 * Getting in, identifier first as large suites do it. The email comes first. An address with an account asks for
 * its password; a new address proves itself with a six-digit code, then sets a name, a password and where to start
 * (explore the demo, or found an organisation). Every account has both an email and a password, and signing in
 * always takes both; codes are only for proving a new address and for resetting a forgotten password. Accounts
 * already signed in on this device are offered first, and `?add=1` adds another account without signing the
 * current one out.
 */
export function AuthFlow() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const adding = params.get("add") === "1";
  const methods = useAuthMethods();
  const accounts = useQuery({
    queryKey: ["device-accounts"],
    queryFn: () => unwrap(api.GET("/api/v1/auth/accounts")),
    staleTime: 0,
  });
  const { inApp, remember, setRemember } = useRemember();

  const [step, setStep] = useState<Step | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [ticket, setTicket] = useState("");
  const [name, setName] = useState("");
  const [start, setStart] = useState<"demo" | "organisation">("demo");
  const [organisation, setOrganisation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState(0);
  const [codeErrors, setCodeErrors] = useState(0);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const others = (accounts.data?.accounts ?? []).filter((a) => !a.active);
  const target = () => {
    const next = params.get("next");
    return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
  };

  // where to begin: signed in already → into the app; known accounts here → the chooser; else the email
  useEffect(() => {
    if (step || !accounts.data || !methods.data) return;
    if (!adding && accounts.data.accounts.some((a) => a.active)) router.replace(target());
    else setStep(others.length && !adding ? "choose" : "email");
  });

  useEffect(() => {
    if (until <= now) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [until, now]);
  const wait = Math.max(0, Math.ceil((until - now) / 1000));

  // without a demo to explore, founding an organisation is the only way to start
  useEffect(() => {
    if (methods.data && !methods.data.demo) setStart("organisation");
  }, [methods.data]);

  const go = (next: Step, d: 1 | -1 = 1) => {
    setDir(d);
    setStep(next);
    setError(null);
  };
  const refuse = (message: string) => {
    setError(message);
    setRefusals((n) => n + 1);
  };
  const enter = (me: Me) => {
    qc.clear();
    qc.setQueryData(["me"], me);
    router.replace(target());
  };
  const describe = (err: unknown) =>
    err instanceof ApiError && err.status === 503
      ? t.auth.mailOff
      : err instanceof Error
        ? err.message
        : String(err);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }

  async function mailCode() {
    await unwrap(api.POST("/api/v1/auth/email/start", { body: { email, locale } }));
    setUntil(Date.now() + 45_000);
    setNow(Date.now());
  }

  // the email decides the way on: password for an account, a code for a new address
  const identify = () =>
    run(async () => {
      try {
        const found = await unwrap(api.POST("/api/v1/auth/identify", { body: { email } }));
        if (found.account === "password") go("password");
        else if (found.account === "no_password") {
          // an account that never had a password sets one through the reset flow, by code
          sessionStorage.setItem("fc.resetEmail", email);
          router.push("/reset");
        } else if (found.signUp) {
          await mailCode();
          go("code");
        } else refuse(t.auth.noAccount.replace("{email}", email));
      } catch (err) {
        refuse(describe(err));
      }
    });

  const resend = () =>
    run(async () => {
      try {
        await mailCode();
      } catch (err) {
        refuse(describe(err));
      }
    });

  const verify = (code: string) =>
    run(async () => {
      try {
        const res = await unwrap(api.POST("/api/v1/auth/email/verify", { body: { email, code } }));
        setTicket(res.ticket);
        go("profile");
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          go("password");
          refuse(t.auth.taken);
          return;
        }
        setCodeErrors((n) => n + 1);
        refuse(err instanceof ApiError && err.status === 401 ? t.auth.codeWrong : describe(err));
      }
    });

  const signInWithPassword = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      try {
        enter(await unwrap(api.POST("/api/v1/auth/login", { body: { email, password, remember } })));
      } catch (err) {
        refuse(err instanceof ApiError && err.status === 401 ? t.auth.wrongPassword : describe(err));
      }
    });
  };

  const signUp = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      try {
        enter(
          await unwrap(
            api.POST("/api/v1/auth/signup", {
              body: {
                ticket,
                name,
                password,
                start,
                organisation: start === "organisation" ? organisation : undefined,
                locale,
                remember,
              },
            }),
          ),
        );
      } catch (err) {
        if (err instanceof ApiError && (err.status === 410 || err.status === 409)) {
          go("email", -1);
          refuse(err.status === 410 ? t.auth.expired : t.auth.taken);
        } else
          refuse(
            err instanceof ApiError && err.status === 422 && err.problems.length
              ? err.problems.join(" ")
              : describe(err),
          );
      }
    });
  };

  const switchTo = (userId: string) =>
    run(async () => {
      try {
        enter(await unwrap(api.POST("/api/v1/auth/accounts/switch", { body: { userId } })));
      } catch (err) {
        refuse(describe(err));
        accounts.refetch();
      }
    });

  const back = (to: Step | "app", label = t.auth.back) => (
    <button
      type="button"
      onClick={() => (to === "app" ? router.back() : go(to, -1))}
      className="fc-press -ml-2 mb-2 inline-flex items-center gap-0.5 rounded-full py-1 pr-2.5 pl-1 text-sm font-medium text-accent"
    >
      <ChevronLeft className="size-[18px]" aria-hidden />
      {label}
    </button>
  );
  const remembered = inApp ? null : (
    <RememberRow
      label={t.auth.remember}
      hint={t.login.rememberHint}
      remember={remember}
      setRemember={setRemember}
    />
  );
  const alert = error ? (
    <p role="alert" className="fc-rise mt-3 px-1 text-sm text-danger">
      {error}
    </p>
  ) : null;

  let body: ReactNode = (
    <div className="grid min-h-40 place-items-center">
      <Mark motion="breathe" className="size-8 text-accent" />
    </div>
  );

  if (step === "choose")
    body = (
      <>
        <StepHeader
          back={adding ? back("app") : undefined}
          title={adding ? t.auth.addTitle : t.auth.chooseTitle}
          subtitle={adding ? t.auth.addSub : t.auth.chooseSub}
        />
        <div className="fc-field divide-y divide-[var(--glass-hairline)] overflow-hidden rounded-[20px]">
          {others.map((a) => (
            <button
              key={a.userId}
              type="button"
              disabled={busy}
              onClick={() => switchTo(a.userId)}
              className="fc-press flex w-full items-center gap-3 px-3.5 py-3 text-left"
            >
              <Avatar name={a.name} email={a.email} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">{a.name}</span>
                <span className="block truncate text-xs text-muted">{a.email}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
            </button>
          ))}
          <button
            type="button"
            onClick={() => go(methods.data?.emailCode ? "email" : "password")}
            className="fc-press flex w-full items-center gap-3 px-3.5 py-3 text-left"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--glass-field)] text-accent shadow-[inset_0_0_0_1px_var(--glass-hairline)]">
              <Plus className="size-5" aria-hidden />
            </span>
            <span className="flex-1 text-[15px] font-medium">{t.auth.another}</span>
          </button>
        </div>
        {alert}
      </>
    );

  if (step === "email")
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          identify();
        }}
      >
        <StepHeader
          back={adding ? back("app") : others.length ? back("choose") : undefined}
          title={adding ? t.auth.addTitle : t.auth.welcome}
          subtitle={adding ? t.auth.addSub : methods.data?.signUp ? t.auth.welcomeSub : t.auth.inviteOnly}
        />
        <FieldGroup>
          <GroupField label={t.auth.email}>
            <input
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              // biome-ignore lint/a11y/noAutofocus: the one field on the screen
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={groupInput}
            />
          </GroupField>
        </FieldGroup>
        {alert}
        <Primary busy={busy}>{t.auth.continue}</Primary>
        <Link
          href="/app"
          className="fc-web-only fc-press mx-auto mt-3 flex w-fit items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted hover:text-text"
        >
          <Smartphone className="size-3.5" aria-hidden />
          {t.download.get}
        </Link>
      </form>
    );

  if (step === "code")
    body = (
      <div>
        <StepHeader
          back={back("email", t.auth.change)}
          title={t.auth.verifyTitle}
          subtitle={<Emphasised text={t.auth.codeSentTo} value={email} />}
        />
        <OtpInput label={t.auth.checkEmail} onComplete={verify} disabled={busy} error={codeErrors} />
        {alert}
        <div className="mt-4 flex items-center justify-between gap-3 px-1 text-xs">
          <span className="text-muted">
            {busy ? <Mark motion="breathe" className="size-4 text-accent" /> : t.auth.noCode}
          </span>
          <button
            type="button"
            disabled={wait > 0 || busy}
            onClick={resend}
            className="fc-press shrink-0 rounded-full px-2 py-1 font-medium text-accent disabled:text-muted"
          >
            {wait > 0 ? t.auth.resendIn.replace("{s}", String(wait)) : t.auth.resend}
          </button>
        </div>
      </div>
    );

  if (step === "password")
    body = (
      <form onSubmit={signInWithPassword}>
        <StepHeader title={t.auth.passwordTitle} />
        {/* the address chosen on the first step; tapping it goes back to change it */}
        <button
          type="button"
          onClick={() => go("email", -1)}
          className="fc-field fc-press mb-3 flex max-w-full items-center gap-2 rounded-full py-1 pr-3.5 pl-1 text-sm"
        >
          <Avatar name={email} email={email} size={26} />
          <span className="min-w-0 truncate font-medium">{email}</span>
          <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
        </button>
        {/* password managers pair the password with this address */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <FieldGroup>
          <GroupField
            label={t.auth.password}
            trailing={
              <button
                type="button"
                aria-label={reveal ? t.login.hidePassword : t.login.showPassword}
                aria-pressed={reveal}
                onClick={() => setReveal((r) => !r)}
                className="fc-press -mr-2 grid size-9 shrink-0 place-items-center rounded-full text-muted hover:text-text"
              >
                {reveal ? (
                  <EyeOff className="size-[18px]" aria-hidden />
                ) : (
                  <Eye className="size-[18px]" aria-hidden />
                )}
              </button>
            }
          >
            <input
              type={reveal ? "text" : "password"}
              autoComplete="current-password"
              required
              // biome-ignore lint/a11y/noAutofocus: the one field on the screen
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={groupInput}
            />
          </GroupField>
        </FieldGroup>
        {methods.data?.emailCode ? (
          <div className="mt-2 px-1 text-right">
            <Link
              href="/reset"
              onClick={() => sessionStorage.setItem("fc.resetEmail", email)}
              className="text-xs font-medium text-accent"
            >
              {t.auth.forgot}
            </Link>
          </div>
        ) : null}
        {remembered}
        {alert}
        <Primary busy={busy}>{t.auth.signIn}</Primary>
      </form>
    );

  if (step === "profile")
    body = (
      <form onSubmit={signUp}>
        <StepHeader
          title={t.auth.profileTitle}
          subtitle={<Emphasised text={t.auth.verified} value={email} />}
        />
        <FieldGroup>
          <GroupField label={t.auth.name}>
            <input
              required
              autoComplete="name"
              // biome-ignore lint/a11y/noAutofocus: the first thing to fill on a new step
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={groupInput}
            />
          </GroupField>
          <GroupField label={t.auth.newPassword}>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={groupInput}
            />
          </GroupField>
        </FieldGroup>
        {/* password managers save the new password under this address */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <div className="mt-5 mb-2 px-1 text-sm font-medium">{t.auth.startQuestion}</div>
        <div role="radiogroup" aria-label={t.auth.startQuestion} className="space-y-2">
          {methods.data?.demo ? (
            <Choice
              selected={start === "demo"}
              onSelect={() => setStart("demo")}
              icon={<Sparkles className="size-5" aria-hidden />}
              title={t.auth.startDemo}
              note={t.auth.startDemoNote.replace("{name}", methods.data.demo.name)}
            />
          ) : null}
          <Choice
            selected={start === "organisation"}
            onSelect={() => setStart("organisation")}
            icon={<Building2 className="size-5" aria-hidden />}
            title={t.auth.startOrg}
            note={t.auth.startOrgNote}
          >
            {start === "organisation" ? (
              <input
                required
                minLength={2}
                placeholder={t.auth.orgName}
                aria-label={t.auth.orgName}
                value={organisation}
                onChange={(e) => setOrganisation(e.target.value)}
                className="fc-field fc-rise mt-3 h-11 w-full rounded-xl px-3.5 text-[15px] outline-none focus-visible:outline-none"
              />
            ) : null}
          </Choice>
        </div>
        {remembered}
        {alert}
        <Primary busy={busy}>{t.auth.create}</Primary>
      </form>
    );

  return (
    <AuthStage shake={refusals}>
      <SheetStep step={step ?? "loading"} dir={dir}>
        {body}
      </SheetStep>
    </AuthStage>
  );
}

function Primary({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="fc-prominent fc-press mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-80"
    >
      {busy ? <Mark motion="breathe" className="size-5" /> : null}
      {children}
      {busy ? null : <ArrowRight className="size-[18px]" aria-hidden />}
    </button>
  );
}

/** "{email}" in a sentence, set in the text colour so the address stands out. */
function Emphasised({ text, value }: { text: string; value: string }) {
  const [before, after] = text.split(/\{\w+\}/);
  return (
    <>
      {before}
      <span className="font-medium break-all text-text">{value}</span>
      {after}
    </>
  );
}

function Choice({
  selected,
  onSelect,
  icon,
  title,
  note,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  note: string;
  children?: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card with a nested field cannot be a native radio
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={() => {
        if (!selected) tick();
        onSelect();
      }}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && e.target === e.currentTarget && onSelect()}
      className={clsx(
        "fc-field fc-press cursor-pointer rounded-[20px] p-3.5 transition-shadow",
        selected && "fc-choice-on",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={clsx(
            "grid size-10 shrink-0 place-items-center rounded-full transition-colors duration-300",
            selected ? "bg-accent text-on-accent" : "bg-[var(--glass-field)] text-muted",
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">{title}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted">{note}</span>
        </span>
        <span
          className={clsx(
            "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border transition-all duration-300",
            selected ? "border-accent bg-accent text-on-accent" : "border-[var(--glass-hairline)]",
          )}
        >
          {selected ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : null}
        </span>
      </div>
      {children}
    </div>
  );
}

/** Initials on a colour drawn from the address, so the same person always looks the same. */
export function Avatar({ name, email, size = 40 }: { name: string; email: string; size?: number }) {
  let hash = 0;
  for (const c of email) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const hue = [168, 196, 222, 262, 32, 340][hash % 6];
  const initials =
    name
      .trim()
      .split(/\s+/)
      .map((w) => [...w][0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `linear-gradient(135deg, hsl(${hue} 70% 58%), hsl(${(hue! + 28) % 360} 64% 42%))`,
      }}
    >
      {initials}
    </span>
  );
}
