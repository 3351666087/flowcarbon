"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { Button, ErrorBox, Field, Input } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

function LoginForm() {
  const { t, locale, setLocale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await unwrap(api.POST("/api/v1/auth/login", { body: { email, password } }));
      qc.setQueryData(["me"], me);
      const next = params.get("next");
      // only follow same-site relative paths
      router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="grid size-9 place-items-center rounded-xl bg-accent text-on-accent">
            <Layers className="size-5" aria-hidden />
          </span>
          <div>
            <div className="font-semibold">{t.appName}</div>
            <div className="text-xs text-muted">{t.tagline}</div>
          </div>
          <button
            type="button"
            onClick={() => setLocale(locale === "en" ? "zh" : "en")}
            className="ml-auto text-sm text-muted hover:text-text"
          >
            {t.common.language}
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-surface p-5">
          <h1 className="text-lg font-semibold">{t.login.title}</h1>
          <Field label={t.login.email}>
            <Input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label={t.login.password}>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error ? <ErrorBox error={error} /> : null}
          <Button type="submit" variant="primary" className="w-full" busy={busy}>
            {t.login.submit}
          </Button>
          <p className="text-xs text-muted">{t.login.demo}</p>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
