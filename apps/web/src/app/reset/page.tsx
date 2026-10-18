"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { codeInputProps, useCodeError, useCodeSender } from "@/components/auth-code";
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

/** Forgot password: an emailed code, then a new password; every other session is signed out. */
export default function ResetPage() {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refusals, setRefusals] = useState(0);
  const { inApp, remember, setRemember } = useRemember();
  const sender = useCodeSender("password_reset");
  const codeError = useCodeError();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!sender.sentTo) {
      await sender.send(email);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await unwrap(
        api.POST("/api/v1/auth/password/reset", { body: { email, code, password, remember } }),
      );
      qc.setQueryData(["me"], me);
      router.replace("/");
    } catch (err) {
      setError(err);
      setRefusals((n) => n + 1);
      setBusy(false);
    }
  }

  const failure = error ?? sender.error;
  // a refused password lists what to change; anything else is about the code or the server
  const problems = failure instanceof ApiError && failure.status === 422 ? failure.problems : [];
  const message = problems.length ? failure instanceof Error && failure.message : codeError(failure);

  return (
    <AuthStage title={t.reset.title} subtitle={t.reset.subtitle} onSubmit={submit} shake={refusals}>
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
        {sender.sentTo ? (
          <>
            <GroupField
              label={t.login.code}
              trailing={
                <button
                  type="button"
                  disabled={sender.busy || sender.wait > 0}
                  onClick={() => sender.send(email)}
                  className="fc-press -mr-1 shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium text-accent disabled:text-muted"
                >
                  {sender.wait > 0 ? t.login.resendIn.replace("{s}", String(sender.wait)) : t.login.resend}
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
        ) : null}
      </FieldGroup>
      {sender.sentTo && !message ? (
        <p className="fc-rise mt-3 px-1 text-xs text-muted">
          {t.login.codeSent.replace("{email}", sender.sentTo)}
        </p>
      ) : null}
      {sender.sentTo && !inApp ? (
        <RememberRow
          label={t.login.remember}
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
        disabled={busy || sender.busy}
        className="fc-prominent fc-press mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-80"
      >
        {busy || sender.busy ? <Mark motion="breathe" className="size-5" /> : null}
        {sender.sentTo ? t.reset.submit : t.login.sendCode}
        {busy || sender.busy ? null : <ArrowRight className="size-[18px]" aria-hidden />}
      </button>
      <p className="mt-4 text-center">
        <Link href="/login" className="text-xs font-medium text-accent">
          {t.reset.back}
        </Link>
      </p>
    </AuthStage>
  );
}
