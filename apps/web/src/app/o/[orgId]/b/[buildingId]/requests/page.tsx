"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
} from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { addDays, dateTime, money, num, todayIn, zonedToIso } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { can, useBuilding, useFloors, useIds, useMembership, useTenants } from "@/lib/session";

const TONE = { requested: "waste", approved: "saving", declined: "danger", cancelled: "neutral" } as const;

export default function RequestsPage() {
  const { t, locale } = useI18n();
  const { orgId, buildingId } = useIds();
  const { building } = useBuilding();
  const membership = useMembership();
  const role = membership?.role;
  const floors = useFloors();
  const tenants = useTenants();
  const qc = useQueryClient();
  const tz = building!.timezone;
  const path = { orgId, buildingId };
  const [status, setStatus] = useState("");
  const [floorId, setFloorId] = useState("");
  const [start, setStart] = useState(`${addDays(todayIn(tz), 1)}T19:00`);
  const [hours, setHours] = useState(3);
  const [people, setPeople] = useState(5);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const list = useQuery({
    queryKey: ["overtime", orgId, buildingId, status],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/buildings/{buildingId}/overtime-requests", {
          params: { path, query: { status: (status || undefined) as "requested" | undefined, limit: 200 } },
        }),
      ),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["overtime", orgId, buildingId] });
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/overtime-requests", {
          params: { path },
          body: { floorId, startAt: zonedToIso(start, tz), hours, expectedPeople: people },
        }),
      ),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "decline" }) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/overtime-requests/{requestId}/decision", {
          params: { path: { ...path, requestId: v.id } },
          body: { decision: v.decision, note: notes[v.id] || undefined },
        }),
      ),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/overtime-requests/{requestId}/cancel", {
          params: { path: { ...path, requestId: id } },
        }),
      ),
    onSuccess: refresh,
  });

  const tenantName = new Map((tenants.data ?? []).map((x) => [x.id, x.name]));
  const floorLabel = new Map((floors.data ?? []).map((f) => [f.id, f.label]));
  // tenant admins only see and request their own floors
  const requestable = (floors.data ?? []).filter(
    (f) => f.tenantId && (!membership?.tenantId || f.tenantId === membership.tenantId),
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <>
      <PageHeader title={t.requests.title} subtitle={t.requests.subtitle} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.8fr]">
        {can.requestOvertime(role) ? (
          <Card title={t.requests.new}>
            <form onSubmit={submit} className="space-y-4">
              <Field label={t.common.floor}>
                <Select required value={floorId} onChange={(e) => setFloorId(e.target.value)}>
                  <option value="" disabled>
                    —
                  </option>
                  {requestable.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label} · {tenantName.get(f.tenantId ?? "") ?? ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t.requests.start} hint={tz}>
                <Input
                  type="datetime-local"
                  required
                  value={start}
                  step={900}
                  onChange={(e) => setStart(e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t.requests.duration}>
                  <Input
                    type="number"
                    min={0.25}
                    max={16}
                    step={0.25}
                    required
                    value={hours}
                    onChange={(e) => setHours(Number(e.target.value))}
                  />
                </Field>
                <Field label={t.requests.expected}>
                  <Input
                    type="number"
                    min={1}
                    max={5000}
                    required
                    value={people}
                    onChange={(e) => setPeople(Number(e.target.value))}
                  />
                </Field>
              </div>
              <Button type="submit" variant="primary" busy={create.isPending} disabled={!floorId}>
                {t.requests.submit}
              </Button>
              {create.error ? <ErrorBox error={create.error} /> : null}
              {create.data ? (
                <div className="rounded-lg bg-accent-soft p-3 text-sm">
                  <div className="font-medium">{t.requests.mode[create.data.recommendedMode]}</div>
                  <p className="mt-1">{create.data.recommendation}</p>
                  <p className="mt-1 text-xs">
                    {t.requests.fee}: {money(create.data.fee, locale, building!.currency)}
                  </p>
                </div>
              ) : null}
            </form>
          </Card>
        ) : null}

        <Card
          title={t.requests.title}
          actions={
            <Select
              className="h-8 w-40"
              aria-label={t.common.status}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">{t.common.all}</option>
              {Object.entries(t.requests.statuses).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          }
        >
          {list.isPending ? (
            <Loading />
          ) : list.error ? (
            <ErrorBox error={list.error} />
          ) : list.data.length === 0 ? (
            <Empty>{t.common.noData}</Empty>
          ) : (
            <ul className="-my-2 divide-y divide-border">
              {list.data.map((r) => (
                <li key={r.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{floorLabel.get(r.floorId)}</span>
                    <span className="text-sm text-muted">{tenantName.get(r.tenantId)}</span>
                    <Badge tone={TONE[r.status]}>{t.requests.statuses[r.status]}</Badge>
                    <span className="ml-auto num text-sm">{money(r.fee, locale, building!.currency)}</span>
                  </div>
                  <div className="mt-1 text-sm">
                    {dateTime(r.startAt, locale, tz)} · {num(r.hours, locale, 2)} {t.common.hours} ·{" "}
                    {r.expectedPeople} {t.common.people}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {t.requests.recommendation}: {t.requests.mode[r.recommendedMode]}
                    {r.approvedMode && r.approvedMode !== r.recommendedMode
                      ? ` → ${t.requests.mode[r.approvedMode]}`
                      : ""}
                    {r.decisionNote ? ` · “${r.decisionNote}”` : ""}
                  </div>
                  {r.status === "requested" && can.decideOvertime(role) ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Input
                        className="h-8 max-w-60"
                        placeholder={t.requests.declineReason}
                        value={notes[r.id] ?? ""}
                        onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                      />
                      <Button
                        variant="primary"
                        className="h-8"
                        onClick={() => decide.mutate({ id: r.id, decision: "approve" })}
                      >
                        {t.requests.approve}
                      </Button>
                      <Button
                        variant="danger"
                        className="h-8"
                        disabled={!notes[r.id]?.trim()}
                        onClick={() => decide.mutate({ id: r.id, decision: "decline" })}
                      >
                        {t.requests.decline}
                      </Button>
                    </div>
                  ) : null}
                  {(r.status === "requested" || r.status === "approved") &&
                  Date.parse(r.startAt) > Date.now() &&
                  can.requestOvertime(role) ? (
                    <Button
                      variant="ghost"
                      className="mt-1 h-8 px-2 text-xs"
                      onClick={() => cancel.mutate(r.id)}
                    >
                      {t.requests.cancel}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {decide.error ? <ErrorBox error={decide.error} /> : null}
          {cancel.error ? <ErrorBox error={cancel.error} /> : null}
        </Card>
      </div>
    </>
  );
}
