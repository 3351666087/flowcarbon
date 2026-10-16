"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Button, ErrorBox, Field, Input } from "@/components/ui";
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
  useEffect(() => setToken(window.location.hash.slice(1) || ""), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const me = await unwrap(
        api.POST("/api/v1/auth/invitations/accept", { body: { token, name, password } }),
      );
      qc.setQueryData(["me"], me);
      history.replaceState(null, "", "/invite");
      router.replace("/");
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-surface p-5"
      >
        <h1 className="text-lg font-semibold">{t.invite.title}</h1>
        {token === "" ? <ErrorBox error={new Error(t.invite.missing)} /> : null}
        <Field label={t.invite.name}>
          <Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t.invite.password}>
          <Input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error ? <ErrorBox error={error} /> : null}
        <Button type="submit" variant="primary" className="w-full" busy={busy} disabled={!token}>
          {t.invite.submit}
        </Button>
      </form>
    </main>
  );
}
