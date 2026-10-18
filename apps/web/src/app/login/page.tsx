"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useRef, useState } from "react";
import {
  codeInputProps,
  Segmented,
  useAuthMethods,
  useCodeError,
  useCodeSender,
} from "@/components/auth-code";
import {
  AuthStage,
  FieldGroup,
  GroupField,
  groupInput,
  RememberRow,
  useRemember,
} from "@/components/auth-stage";
import { Mark } from "@/components/mark";
import { ApiError, api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const methods = useAuthMethods();
  const [mode, setMode] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refusals, setRefusals] = useState(0);
  const { inApp, remember, setRemember } = useRemember();
  const sender = useCodeSender("sign_in");
  const codeError = useCodeError();
  const byCode = mode === "code";
  const codeField = useRef<HTMLInputElement>(null);
  // once a code is on its way, the cursor waits where it goes
  useEffect(() => {
    if (sender.sentTo) codeField.current?.focus();
  }, [sender.sentTo]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (byCode && !sender.sentTo) {
      await sender.send(email);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = byCode
        ? await unwrap(api.POST("/api/v1/auth/code/sign-in", { body: { email, code, remember } }))
        : await unwrap(api.POST("/api/v1/auth/login", { body: { email, password, remember } }));
      qc.setQueryData(["me"], me);
      const next = params.get("next");
      // only follow same-site relative paths
      router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (err) {
      setError(err);
      setRefusals((n) => n + 1);
      setBusy(false);
    }
  }

  const failure = error ?? sender.error;
  const message = byCode
    ? codeError(failure)
    : failure instanceof ApiError && failure.status === 401
      ? t.login.failed
      : failure instanceof Error
        ? failure.message
        : failure
          ? String(failure)
          : null;

  return (
    <AuthStage title={t.login.title} subtitle={t.login.subtitle} onSubmit={submit} shake={refusals}>
      {methods.data?.emailCode ? (
        <div className="mb-4">
          <Segmented
            label={t.login.title}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
            options={[
              { key: "password", label: t.login.withPassword },
              { key: "code", label: t.login.withCode },
            ]}
          />
        </div>
      ) : null}
      <FieldGroup>
        <GroupField label={t.login.email}>
          <input
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={groupInput}
          />
        </GroupField>
        {byCode ? (
          <GroupField
            label={t.login.code}
            trailing={
              <button
                type="button"
                disabled={!email || sender.busy || sender.wait > 0}
                onClick={() => sender.send(email)}
                className="fc-press -mr-1 shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium text-accent disabled:text-muted"
              >
                {sender.wait > 0
                  ? t.login.resendIn.replace("{s}", String(sender.wait))
                  : sender.sentTo
                    ? t.login.resend
                    : t.login.sendCode}
              </button>
            }
          >
            <input
              ref={codeField}
              {...codeInputProps}
              required={!!sender.sentTo}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className={`${groupInput} tracking-[0.3em]`}
            />
          </GroupField>
        ) : (
          <GroupField
            label={t.login.password}
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={groupInput}
            />
          </GroupField>
        )}
      </FieldGroup>
      {byCode && sender.sentTo && !message ? (
        <p className="fc-rise mt-3 px-1 text-xs text-muted">
          {t.login.codeSent.replace("{email}", sender.sentTo)}
        </p>
      ) : null}
      {!byCode && methods.data?.emailCode ? (
        <div className="mt-2 px-1 text-right">
          <Link href="/reset" className="text-xs font-medium text-accent">
            {t.login.forgot}
          </Link>
        </div>
      ) : null}
      {inApp ? null : (
        <RememberRow
          label={t.login.remember}
          hint={t.login.rememberHint}
          remember={remember}
          setRemember={setRemember}
        />
      )}
      {message ? (
        <p role="alert" className="fc-rise mt-3 px-1 text-sm text-danger">
          {message}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy || sender.busy}
        className="fc-prominent fc-press mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-80"
      >
        {busy || sender.busy ? <Mark motion="breathe" className="size-5" /> : null}
        {byCode && !sender.sentTo ? t.login.sendCode : t.login.submit}
        {busy || sender.busy ? null : <ArrowRight className="size-[18px]" aria-hidden />}
      </button>
      <p className="mt-4 px-1 text-center text-xs text-muted">{t.login.demo}</p>
    </AuthStage>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
