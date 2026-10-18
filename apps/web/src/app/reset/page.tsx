"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { codeInputProps, useCodeError } from "@/components/auth-code";
import {
  AuthStage,
  FieldGroup,
  GroupField,
  groupInput,
  RememberRow,
  SheetStep,
  StepHeader,
  useRemember,
} from "@/components/auth-stage";
import { Mark } from "@/components/mark";
import { ApiError, api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/** Forgot password: an emailed code, then a new password; every other session is signed out. */
export default function ResetPage() {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refusals, setRefusals] = useState(0);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const { inApp, remember, setRemember } = useRemember();
  const codeError = useCodeError();

  // arriving from sign-in, the address is already known
  useEffect(() => {
    const known = sessionStorage.getItem("fc.resetEmail");
    if (known) setEmail(known);
  }, []);

  useEffect(() => {
    if (until <= now) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [until, now]);
  const wait = Math.max(0, Math.ceil((until - now) / 1000));

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/api/v1/auth/password/forgot", { body: { email } }));
      setUntil(Date.now() + 45_000);
      setNow(Date.now());
      setStep("code");
    } catch (err) {
      setError(err);
      setRefusals((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step === "email") return send();
    setBusy(true);
    setError(null);
    try {
      const me = await unwrap(
        api.POST("/api/v1/auth/password/reset", { body: { email, code, password, remember } }),
      );
      qc.clear();
      qc.setQueryData(["me"], me);
      router.replace("/");
    } catch (err) {
      setError(err);
      setRefusals((n) => n + 1);
      setBusy(false);
    }
  }

  const problems = error instanceof ApiError && error.status === 422 ? error.problems : [];
  const message = problems.length ? error instanceof Error && error.message : codeError(error);

  return (
    <AuthStage shake={refusals}>
      <SheetStep step={step} dir={step === "code" ? 1 : -1}>
        <form onSubmit={submit}>
          <StepHeader
            back={
              step === "code" ? (
                <button
                  type="button"
                  onClick={() => setStep("email")}
                  className="fc-press -ml-2 mb-2 inline-flex items-center gap-0.5 rounded-full py-1 pr-2.5 pl-1 text-sm font-medium text-accent"
                >
                  <ChevronLeft className="size-[18px]" aria-hidden />
                  {t.auth.change}
                </button>
              ) : (
                <Link
                  href="/login"
                  className="fc-press -ml-2 mb-2 inline-flex items-center gap-0.5 rounded-full py-1 pr-2.5 pl-1 text-sm font-medium text-accent"
                >
                  <ChevronLeft className="size-[18px]" aria-hidden />
                  {t.reset.back}
                </Link>
              )
            }
            title={t.reset.title}
            subtitle={step === "code" ? t.auth.codeSentTo.replace("{email}", email) : t.reset.subtitle}
          />
          <FieldGroup>
            {step === "email" ? (
              <GroupField label={t.auth.email}>
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
            ) : (
              <>
                <GroupField
                  label={t.login.code}
                  trailing={
                    <button
                      type="button"
                      disabled={busy || wait > 0}
                      onClick={send}
                      className="fc-press -mr-1 shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium text-accent disabled:text-muted"
                    >
                      {wait > 0 ? t.auth.resendIn.replace("{s}", String(wait)) : t.auth.resend}
                    </button>
                  }
                >
                  <input
                    {...codeInputProps}
                    // biome-ignore lint/a11y/noAutofocus: the field appears because a code was just sent to fill it
                    autoFocus
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className={`${groupInput} tracking-[0.3em]`}
                  />
                </GroupField>
                <GroupField label={t.reset.password}>
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
              </>
            )}
          </FieldGroup>
          {step === "code" && !inApp ? (
            <RememberRow
              label={t.auth.remember}
              hint={t.login.rememberHint}
              remember={remember}
              setRemember={setRemember}
            />
          ) : null}
          {message ? (
            <div role="alert" className="fc-rise mt-3 px-1 text-sm text-danger">
              {message}
              {problems.length ? (
                <ul className="mt-1 list-disc pl-5">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="fc-prominent fc-press mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-80"
          >
            {busy ? <Mark motion="breathe" className="size-5" /> : null}
            {step === "code" ? t.reset.submit : t.login.sendCode}
            {busy ? null : <ArrowRight className="size-[18px]" aria-hidden />}
          </button>
        </form>
      </SheetStep>
    </AuthStage>
  );
}
