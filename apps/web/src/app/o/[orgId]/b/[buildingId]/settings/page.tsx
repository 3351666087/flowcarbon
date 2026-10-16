"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Table,
} from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { type Role, useBuilding, useIds, useMembership, useTenants } from "@/lib/session";

const ROLES: Role[] = [
  "owner",
  "admin",
  "property_manager",
  "energy_analyst",
  "engineer",
  "tenant_admin",
  "viewer",
];
const SCOPES = ["telemetry:write", "read", "overtime:write"] as const;

function CopyOnce({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <div className="mt-3 rounded-lg bg-waste-soft p-3 text-sm">
      <p>{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs">
          {value}
        </code>
        <Button
          className="h-8"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setDone(true);
          }}
        >
          <Copy className="size-4" aria-hidden /> {done ? t.common.copied : t.common.copy}
        </Button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const me = useMembership();
  const tenants = useTenants();
  const qc = useQueryClient();
  const tz = building!.timezone;
  const org = { orgId };
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("viewer");
  const [inviteTenant, setInviteTenant] = useState("");
  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>(["telemetry:write"]);

  const members = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/members", { params: { path: org } })),
  });
  const invitations = useQuery({
    queryKey: ["invitations", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/invitations", { params: { path: org } })),
  });
  const keys = useQuery({
    queryKey: ["keys", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/api-keys", { params: { path: org } })),
  });
  const audit = useQuery({
    queryKey: ["audit", orgId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/audit-log", { params: { path: org, query: { limit: 50 } } })),
  });

  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: Role }) =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/members/{userId}", {
          params: { path: { orgId, userId: v.userId } },
          body: { role: v.role },
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: ["members", orgId] }),
  });
  const invite = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/invitations", {
          params: { path: org },
          body: {
            email: inviteEmail,
            role: inviteRole,
            tenantId: inviteRole === "tenant_admin" ? inviteTenant || null : null,
            expiresInDays: 7,
          },
        }),
      ),
    onSuccess: () => {
      setInviteEmail("");
      qc.invalidateQueries({ queryKey: ["invitations", orgId] });
    },
  });
  const withdraw = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/invitations/{invitationId}", {
          params: { path: { orgId, invitationId: id } },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invitations", orgId] }),
  });
  const createKey = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/api-keys", {
          params: { path: org },
          body: { name: keyName, scopes: keyScopes as (typeof SCOPES)[number][], buildingId },
        }),
      ),
    onSuccess: () => {
      setKeyName("");
      qc.invalidateQueries({ queryKey: ["keys", orgId] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/api/v1/orgs/{orgId}/api-keys/{keyId}", { params: { path: { orgId, keyId: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keys", orgId] }),
  });

  if (members.isPending) return <Loading />;
  if (members.error) return <ErrorBox error={members.error} />;

  return (
    <>
      <PageHeader title={t.settings.title} subtitle={me?.orgName} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={t.settings.members}>
          <Table head={["", t.settings.role]}>
            {members.data.map((m) => (
              <tr key={m.userId}>
                <td>
                  <div className="font-medium">{m.name}</div>
                  <div className="text-xs text-muted">{m.email}</div>
                </td>
                <td>
                  <Select
                    className="h-8"
                    aria-label={t.settings.role}
                    value={m.role}
                    disabled={m.role === "tenant_admin" || (me?.role !== "owner" && m.role === "owner")}
                    onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value as Role })}
                  >
                    {ROLES.filter((r) => r !== "tenant_admin" || m.role === "tenant_admin").map((r) => (
                      <option key={r} value={r} disabled={me?.role !== "owner" && r === "owner"}>
                        {t.settings.roles[r]}
                      </option>
                    ))}
                  </Select>
                </td>
              </tr>
            ))}
          </Table>
          {setRole.error ? <ErrorBox error={setRole.error} /> : null}

          <form
            className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1.4fr_1fr_auto]"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              invite.mutate();
            }}
          >
            <Field label={t.settings.inviteEmail}>
              <Input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </Field>
            <Field label={t.settings.role}>
              <Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
                {ROLES.filter((r) => me?.role === "owner" || r !== "owner").map((r) => (
                  <option key={r} value={r}>
                    {t.settings.roles[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="primary" busy={invite.isPending}>
                {t.settings.invite}
              </Button>
            </div>
            {inviteRole === "tenant_admin" ? (
              <Field label={t.common.tenant}>
                <Select required value={inviteTenant} onChange={(e) => setInviteTenant(e.target.value)}>
                  <option value="" disabled>
                    —
                  </option>
                  {(tenants.data ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </form>
          {invite.data ? <CopyOnce label={t.settings.inviteLink} value={invite.data.acceptUrl} /> : null}
          {invite.error ? <ErrorBox error={invite.error} /> : null}
          {invitations.data?.filter((i) => !i.acceptedAt).length ? (
            <div className="mt-4">
              <div className="mb-1 text-xs font-semibold text-muted">{t.settings.invitations}</div>
              <ul className="space-y-1 text-sm">
                {invitations.data
                  .filter((i) => !i.acceptedAt)
                  .map((i) => (
                    <li key={i.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{i.email}</span>
                      <Badge>{t.settings.roles[i.role]}</Badge>
                      <Button
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => withdraw.mutate(i.id)}
                      >
                        {t.common.delete}
                      </Button>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card title={t.settings.apiKeys}>
          {keys.isPending ? (
            <Loading />
          ) : (
            <Table head={[t.settings.keyName, t.settings.scopes, t.data.lastSeen, ""]}>
              {(keys.data ?? []).map((k) => (
                <tr key={k.id} className={k.revokedAt ? "opacity-50" : undefined}>
                  <td>
                    <div className="font-medium">{k.name}</div>
                    <code className="text-xs text-muted">{k.prefix}…</code>
                  </td>
                  <td className="text-xs">{k.scopes.join(", ")}</td>
                  <td className="text-xs">{dateTime(k.lastUsedAt, locale, tz)}</td>
                  <td>
                    {!k.revokedAt ? (
                      <Button
                        variant="danger"
                        className="h-7 px-2 text-xs"
                        onClick={() => revoke.mutate(k.id)}
                      >
                        {t.common.revoke}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <form
            className="mt-5 space-y-3 border-t border-border pt-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              createKey.mutate();
            }}
          >
            <Field label={t.settings.keyName}>
              <Input
                required
                maxLength={80}
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="Gateway — Tower A"
              />
            </Field>
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <legend className="mb-1 font-medium">{t.settings.scopes}</legend>
              {SCOPES.map((s) => (
                <label key={s} className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={keyScopes.includes(s)}
                    onChange={(e) =>
                      setKeyScopes(e.target.checked ? [...keyScopes, s] : keyScopes.filter((x) => x !== s))
                    }
                  />
                  <code className="text-xs">{s}</code>
                </label>
              ))}
            </fieldset>
            <Button type="submit" variant="primary" busy={createKey.isPending} disabled={!keyScopes.length}>
              {t.settings.newKey}
            </Button>
          </form>
          {createKey.data ? <CopyOnce label={t.settings.keyShown} value={createKey.data.key} /> : null}
          {createKey.error ? <ErrorBox error={createKey.error} /> : null}
        </Card>
      </div>

      <Card title={t.settings.audit} className="mt-6">
        {audit.isPending ? (
          <Loading />
        ) : (
          <Table head={["", "", ""]}>
            {(audit.data?.items ?? []).map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap text-xs">{dateTime(a.at, locale, tz)}</td>
                <td>
                  <code className="text-xs">{a.action}</code>
                  <div className="text-xs text-muted">
                    {a.entityType} {a.entityId?.slice(0, 8)}
                  </div>
                </td>
                <td className="text-xs text-muted">
                  {a.actorType} {a.actorId?.slice(0, 8)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
