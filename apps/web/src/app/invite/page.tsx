"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import {
  AuthStage,
  FieldGroup,
  GroupField,
  groupInput,
  RememberRow,
  StepHeader,
  useRemember,
} from "@/components/auth-stage";
import { Mark } from "@/components/mark";
import { ErrorBox } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/** The token travels in the URL fragment, which browsers never send to servers or put in Referer headers. */
export default function InvitePage() {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refusals, setRefusals] = useState(0);
  const { inApp, remember, setRemember } = useRemember();
  useEffect(() => setToken(window.location.hash.slice(1) || ""), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const me = await unwrap(
        api.POST("/api/v1/auth/invitations/accept", { body: { token, name, password, remember } }),
      );
      qc.setQueryData(["me"], me);
      history.replaceState(null, "", "/invite");
      router.replace("/");
    } catch (err) {
      setError(err);
      setRefusals((n) => n + 1);
      setBusy(false);
    }
  }

  return (
    <AuthStage shake={refusals}>
      <form onSubmit={submit}>
        <StepHeader title={t.invite.title} />
        {token === "" ? (
          <div className="mb-4">
            <ErrorBox error={new Error(t.invite.missing)} />
          </div>
        ) : null}
        <FieldGroup>
          <GroupField label={t.invite.name}>
            <input
              required
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={groupInput}
            />
          </GroupField>
          <GroupField label={t.invite.password}>
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
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
        {error ? (
          <div className="mt-4">
            <ErrorBox error={error} />
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy || !token}
          className="fc-prominent fc-press mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-60"
        >
          {busy ? <Mark motion="breathe" className="size-5" /> : null}
          {t.invite.submit}
        </button>
      </form>
    </AuthStage>
  );
}
