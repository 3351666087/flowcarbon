"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refusals, setRefusals] = useState(0);
  const { inApp, remember, setRemember } = useRemember();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await unwrap(api.POST("/api/v1/auth/login", { body: { email, password, remember } }));
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

  const message =
    error instanceof ApiError && error.status === 401
      ? t.login.failed
      : error instanceof Error
        ? error.message
        : error
          ? String(error)
          : null;

  return (
    <AuthStage title={t.login.title} subtitle={t.login.subtitle} onSubmit={submit} shake={refusals}>
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
      </FieldGroup>
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
        disabled={busy}
        className="fc-prominent fc-press mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-80"
      >
        {busy ? <Mark motion="breathe" className="size-5" /> : null}
        {t.login.submit}
        {busy ? null : <ArrowRight className="size-[18px]" aria-hidden />}
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
