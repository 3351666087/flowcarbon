/** HTTP-level tests against a real database as the runtime role. Requires TEST_DATABASE_URL (see packages/demo). */
import { readFileSync } from "node:fs";
import { addDays, localParts, zonedTime } from "@flowcarbon/core";
import { createDb, type DbHandle, schema, type Tx, withOrg } from "@flowcarbon/db";
import { type SeedResult, seedDemo } from "@flowcarbon/demo";
import { createTestDatabase, type TestDatabase } from "@flowcarbon/demo/testing";
import type {
  AssistantPayload,
  BriefPayload,
  DemoPayload,
  ExplainPayload,
  JobQueue,
  RecomputePayload,
} from "@flowcarbon/jobs";
import { hashPassword, sha256 } from "@flowcarbon/security";
import { eq, inArray, sql } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { API_PREFIX, buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Mailer, MailMessage } from "../src/mail";

const adminUrl = process.env.TEST_DATABASE_URL;
const PASSWORD = "api-test-password-2026";
const ORIGIN = "http://localhost:3000";

describe.skipIf(!adminUrl)("HTTP API", () => {
  let tdb: TestDatabase;
  let handle: DbHandle;
  let seeded: SeedResult;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const sent: {
    recompute: RecomputePayload[];
    explain: ExplainPayload[];
    demo: DemoPayload[];
    brief: BriefPayload[];
    assistant: AssistantPayload[];
  } = { recompute: [], explain: [], demo: [], brief: [], assistant: [] };
  /** set to make the queue refuse the next assistant job */
  let queueDown = false;
  const jobs: JobQueue = {
    recompute: async (p) => {
      sent.recompute.push(p);
      return "job";
    },
    explain: async (p) => {
      sent.explain.push(p);
      return "job";
    },
    demo: async (p) => {
      sent.demo.push(p);
      return "job";
    },
    brief: async (p) => {
      sent.brief.push(p);
      return "job";
    },
    assistant: async (p) => {
      if (queueDown) throw new Error("queue is down");
      sent.assistant.push(p);
      return "job";
    },
  };
  const sessions = new Map<string, string>();
  const outbox: MailMessage[] = [];
  const mailer: Mailer = {
    enabled: true,
    send: async (m) => {
      outbox.push(m);
    },
  };
  const lastMailTo = (to: string) => outbox.filter((m) => m.to === to).at(-1);
  const codeIn = (m: MailMessage | undefined) => /\b(\d{6})\b/.exec(m?.text ?? "")?.[1];

  beforeAll(async () => {
    tdb = await createTestDatabase(adminUrl!);
    handle = createDb(tdb.appUrl, { max: 6 });
    seeded = await seedDemo(handle.db, { startDate: "2026-09-15", days: 28, password: PASSWORD });
    const config = loadConfig({
      DATABASE_URL: tdb.appUrl,
      NODE_ENV: "test",
      CORS_ORIGINS: ORIGIN,
      LOGIN_ATTEMPTS_PER_15_MIN: "100",
      SIGNUP_OPEN: "true",
      DEMO_ORG_SLUG: "tower-a-demo",
    });
    app = await buildApp({ db: handle.db, config, jobs, mailer, logger: false });
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await tdb?.drop();
  });

  const org = () => `${API_PREFIX}/orgs/${seeded.orgId}`;
  const bld = () => `${org()}/buildings/${seeded.buildingId}`;
  const inOrg = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(handle.db, seeded.orgId, fn);
  /** The seeded organisation is a demo, where a measure takes effect as it is agreed; for a test of everywhere else. */
  const outsideDemo = async () => {
    const setPlan = (plan: string) =>
      handle.db.update(schema.organizations).set({ plan }).where(eq(schema.organizations.id, seeded.orgId));
    await setPlan("standard");
    onTestFinished(async () => {
      await setPlan("demo");
    });
  };

  async function login(email: string) {
    const cached = sessions.get(email);
    if (cached) return cached;
    const res = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "fc_session")!;
    sessions.set(email, cookie.value);
    return cookie.value;
  }

  async function as(email: string, opts: InjectOptions & { url: string }) {
    const token = await login(email);
    const unsafe = opts.method && opts.method !== "GET";
    return app.inject({
      ...opts,
      cookies: { fc_session: token },
      headers: { ...(unsafe ? { origin: ORIGIN } : {}), ...opts.headers },
    });
  }
  const manager = "manager@flowcarbon-demo.example";
  const analyst = "analyst@flowcarbon-demo.example";
  const tenant = "tenant@flowcarbon-demo.example";
  const ownerEmail = "owner@flowcarbon-demo.example";

  describe("operations", () => {
    it("reports liveness, readiness and an OpenAPI document", async () => {
      expect((await app.inject({ url: "/healthz" })).json()).toMatchObject({ status: "ok" });
      expect((await app.inject({ url: "/readyz" })).statusCode).toBe(200);
      const doc = (await app.inject({ url: `${API_PREFIX}/docs/json` })).json();
      expect(doc.openapi).toBe("3.1.0");
      expect(Object.keys(doc.paths).length).toBeGreaterThan(30);
      const metrics = await app.inject({ url: "/metrics" });
      expect(metrics.body).toContain("flowcarbon_api_http_request_duration_seconds");
    });

    it("answers unknown routes and invalid input with problem details", async () => {
      const res = await app.inject({ url: `${API_PREFIX}/nope` });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      const bad = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: "not-an-email", password: "" },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ code: "validation", status: 400 });
      expect(bad.json().details.length).toBeGreaterThan(0);
    });
  });

  describe("authentication", () => {
    it("rejects wrong passwords and unknown accounts the same way", async () => {
      const wrong = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: manager, password: "wrong-password-123" },
      });
      const unknown = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: "nobody@example.com", password: "wrong-password-123" },
      });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.json().detail).toBe(unknown.json().detail);
    });

    it("sets an HttpOnly, SameSite=Lax session cookie and returns memberships", async () => {
      const res = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: manager.toUpperCase(), password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const c = res.cookies.find((x) => x.name === "fc_session")!;
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe("Lax");
      expect(res.json().memberships).toEqual([
        expect.objectContaining({ orgId: seeded.orgId, role: "property_manager" }),
      ]);
      const me = await app.inject({ url: `${API_PREFIX}/me`, cookies: { fc_session: c.value } });
      expect(me.json().user.email).toBe(manager);
    });

    it("keeps a session for weeks only when asked, and renews a kept session's cookie as it is used", async () => {
      const signIn = (remember?: boolean) =>
        app.inject({
          method: "POST",
          url: `${API_PREFIX}/auth/login`,
          payload: { email: manager, password: PASSWORD, ...(remember === undefined ? {} : { remember }) },
        });
      const cookieOf = (res: Awaited<ReturnType<typeof signIn>>) =>
        res.cookies.find((x) => x.name === "fc_session");
      const day = 86_400_000;

      // by default the cookie ends with the browser session
      const plain = cookieOf(await signIn())!;
      expect(plain.expires).toBeUndefined();
      expect(cookieOf(await signIn(false))!.expires).toBeUndefined();

      // kept: the cookie lasts the 30-day idle window
      const kept = cookieOf(await signIn(true))!;
      expect(kept.expires!.getTime() - Date.now()).toBeGreaterThan(29 * day);
      expect(kept.expires!.getTime() - Date.now()).toBeLessThan(31 * day);

      // after a while unused, the next request moves the kept cookie forward; a browser-session cookie is left alone
      const age = (token: string) =>
        handle.db
          .update(schema.sessions)
          .set({ lastSeenAt: new Date(Date.now() - 20 * day), expiresAt: new Date(Date.now() + 10 * day) })
          .where(eq(schema.sessions.id, sha256(token)));
      await age(kept.value);
      await age(plain.value);
      const keptMe = await app.inject({ url: `${API_PREFIX}/me`, cookies: { fc_session: kept.value } });
      expect(keptMe.statusCode).toBe(200);
      const renewed = cookieOf(keptMe)!;
      expect(renewed.value).toBe(kept.value);
      expect(renewed.expires!.getTime() - Date.now()).toBeGreaterThan(29 * day);
      const plainMe = await app.inject({ url: `${API_PREFIX}/me`, cookies: { fc_session: plain.value } });
      expect(plainMe.statusCode).toBe(200);
      expect(cookieOf(plainMe)).toBeUndefined();
    });

    it("requires a session and blocks cross-site writes", async () => {
      expect((await app.inject({ url: `${org()}/buildings` })).statusCode).toBe(401);
      const token = await login(manager);
      const body = { name: "CSRF test" };
      const noOrigin = await app.inject({
        method: "PATCH",
        url: bld(),
        cookies: { fc_session: token },
        payload: body,
      });
      const evil = await app.inject({
        method: "PATCH",
        url: bld(),
        cookies: { fc_session: token },
        payload: body,
        headers: { origin: "https://evil.example" },
      });
      expect(noOrigin.statusCode).toBe(403);
      expect(evil.statusCode).toBe(403);
    });

    it("stores the user's language", async () => {
      const res = await as(analyst, { method: "PATCH", url: `${API_PREFIX}/me`, payload: { locale: "zh" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.locale).toBe("zh");
      expect(
        (await as(analyst, { method: "PATCH", url: `${API_PREFIX}/me`, payload: { locale: "fr" } }))
          .statusCode,
      ).toBe(400);
    });

    it("signs out", async () => {
      const res = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: analyst, password: PASSWORD },
      });
      const token = res.cookies.find((c) => c.name === "fc_session")!.value;
      const out = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/logout`,
        cookies: { fc_session: token },
        headers: { origin: ORIGIN },
      });
      expect(out.json()).toEqual({ next: null });
      expect((await app.inject({ url: `${API_PREFIX}/me`, cookies: { fc_session: token } })).statusCode).toBe(
        401,
      );
    });
  });

  describe("authorisation", () => {
    it("lets staff read the building and only managers change it", async () => {
      expect((await as(analyst, { url: bld() })).statusCode).toBe(200);
      expect((await as(analyst, { method: "PATCH", url: bld(), payload: { address: "x" } })).statusCode).toBe(
        403,
      );
      const ok = await as(manager, {
        method: "PATCH",
        url: bld(),
        payload: { ruleParams: { emptyGraceMinutes: 45 } },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ruleParams).toEqual({ emptyGraceMinutes: 45 });
    });

    it("hides organisations the caller does not belong to", async () => {
      const res = await as(manager, {
        url: `${API_PREFIX}/orgs/00000000-0000-4000-8000-000000000000/buildings`,
      });
      expect(res.statusCode).toBe(404);
    });

    it("limits tenant admins to their own floors and requests", async () => {
      const overview = (await as(tenant, { url: `${bld()}/overview` })).json();
      expect(overview.floors.map((f: { label: string }) => f.label).sort()).toEqual(["F12", "F13"]);
      expect(overview.last28).toBeNull();
      const floors = (await as(tenant, { url: `${bld()}/floors` })).json() as {
        label: string;
        tenantId: string | null;
      }[];
      expect(floors.map((f) => f.label).sort()).toEqual(["F12", "F13"]);
      // what the overtime form goes by: each floor's tenant, from its live lease
      expect(new Set(floors.map((f) => f.tenantId))).toEqual(new Set([seeded.tenantIds["t-northwind"]]));
      expect((await as(tenant, { url: `${bld()}/findings` })).statusCode).toBe(403);
      expect((await as(tenant, { url: `${bld()}/report` })).statusCode).toBe(403);
      const requests = (await as(tenant, { url: `${bld()}/overtime-requests` })).json() as {
        tenantId: string;
      }[];
      expect(requests.length).toBeGreaterThan(0);
      expect(new Set(requests.map((r) => r.tenantId))).toEqual(new Set([seeded.tenantIds["t-northwind"]]));
    });
  });

  describe("the overview", () => {
    it("adds the floors' 28 days up to the building's, and says how many days it has", async () => {
      const { floors, last28 } = (await as(manager, { url: `${bld()}/overview` })).json();
      const sum = floors.reduce((s: number, f: { avoidableKwh28d: number }) => s + f.avoidableKwh28d, 0);
      expect(sum).toBeCloseTo(last28.avoidableKwh, 0);
      expect(last28.days).toBe(28);
    });

    it("leaves out today, which is still coming in, as a plan does", async () => {
      const today = localParts(Date.now(), "Asia/Shanghai").dateKey;
      const yesterday = addDays(today, -1);
      const row = (day: string, kwhTotal: number) => ({
        orgId: seeded.orgId,
        buildingId: seeded.buildingId,
        floorId: seeded.floorIds.f12!,
        day,
        dayType: "workday" as const,
        kwhTotal,
        kwhAfterHours: 0,
        kwhMeasured: kwhTotal,
        cost: 0,
        afterHoursPeak: 0,
        afterHoursHvacHours: 0,
        intervals: 96,
      });
      await inOrg((tx) => tx.insert(schema.floorDaily).values(row(yesterday, 100)));
      onTestFinished(async () => {
        await inOrg((tx) =>
          tx.delete(schema.floorDaily).where(inArray(schema.floorDaily.day, [yesterday, today])),
        );
      });
      const whole = (await as(manager, { url: `${bld()}/overview` })).json().last28;
      await inOrg((tx) => tx.insert(schema.floorDaily).values(row(today, 7)));
      const { asOf, last28 } = (await as(manager, { url: `${bld()}/overview` })).json();
      expect(asOf).toBe(today);
      expect(last28).toEqual(whole);
      expect(last28.to).toBe(today);
      const { plan } = (await as(manager, { url: `${bld()}/strategy-board` })).json();
      expect(plan.window).toMatchObject({ days: last28.days, from: last28.from, to: last28.to });
      expect(plan.recorded.kwh).toBeCloseTo(last28.kwh, 1);
    });
  });

  describe("input that cannot be stored", () => {
    it("refuses a NUL in a text field as invalid, not with a server error", async () => {
      const res = await as(manager, {
        method: "PATCH",
        url: `${API_PREFIX}/me`,
        payload: { name: "a\u0000b" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "validation" });
    });
  });

  describe("overtime requests", () => {
    const startAt = () => {
      const today = localParts(Date.now(), "Asia/Shanghai").dateKey;
      return new Date(zonedTime(addDays(today, 2), 19 * 60, "Asia/Shanghai")).toISOString();
    };

    it("lets a tenant request only its own floor and suggests a setback for few people", async () => {
      const other = await as(tenant, {
        method: "POST",
        url: `${bld()}/overtime-requests`,
        payload: { floorId: seeded.floorIds.f11, startAt: startAt(), hours: 3, expectedPeople: 2 },
      });
      expect(other.statusCode).toBe(422);
      const res = await as(tenant, {
        method: "POST",
        url: `${bld()}/overtime-requests`,
        payload: { floorId: seeded.floorIds.f12, startAt: startAt(), hours: 3, expectedPeople: 2 },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ status: "requested", recommendedMode: "setback", fee: 540 });

      const declineWithoutReason = await as(manager, {
        method: "POST",
        url: `${bld()}/overtime-requests/${res.json().id}/decision`,
        payload: { decision: "decline" },
      });
      expect(declineWithoutReason.statusCode).toBe(422);
      const approved = await as(manager, {
        method: "POST",
        url: `${bld()}/overtime-requests/${res.json().id}/decision`,
        payload: { decision: "approve" },
      });
      expect(approved.json()).toMatchObject({ status: "approved", approvedMode: "setback" });
      const again = await as(manager, {
        method: "POST",
        url: `${bld()}/overtime-requests/${res.json().id}/decision`,
        payload: { decision: "approve" },
      });
      expect(again.statusCode).toBe(409);
      expect(
        (
          await as(tenant, {
            method: "POST",
            url: `${bld()}/overtime-requests/${res.json().id}/decision`,
            payload: { decision: "approve" },
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  describe("findings", () => {
    it("pages through findings with a cursor", async () => {
      const first = (await as(manager, { url: `${bld()}/findings?limit=5` })).json();
      expect(first.items).toHaveLength(5);
      expect(first.nextCursor).toBeTruthy();
      const second = (
        await as(manager, { url: `${bld()}/findings?limit=5&cursor=${first.nextCursor}` })
      ).json();
      const ids = new Set(first.items.map((f: { id: string }) => f.id));
      expect(second.items.some((f: { id: string }) => ids.has(f.id))).toBe(false);
      expect(Date.parse(second.items[0].startAt)).toBeLessThanOrEqual(Date.parse(first.items[4].startAt));
    });

    it("records reviews in the audit log and queues explanations", async () => {
      const [f] = (await as(manager, { url: `${bld()}/findings?limit=1` })).json().items;
      expect(
        (
          await as(manager, {
            method: "PATCH",
            url: `${bld()}/findings/${f.id}`,
            payload: { status: "dismissed" },
          })
        ).statusCode,
      ).toBe(422);
      const res = await as(manager, {
        method: "PATCH",
        url: `${bld()}/findings/${f.id}`,
        payload: { status: "dismissed", note: "Commissioning test" },
      });
      expect(res.json()).toMatchObject({ status: "dismissed", statusNote: "Commissioning test" });
      const ex = await as(analyst, { method: "POST", url: `${bld()}/findings/${f.id}/explanations` });
      expect(ex.statusCode).toBe(202);
      expect(sent.explain.at(-1)).toEqual({ orgId: seeded.orgId, explanationId: ex.json().explanationId });
      const log = (await as(ownerEmail, { url: `${org()}/audit-log?limit=20` })).json();
      expect(log.items.map((i: { action: string }) => i.action)).toEqual(
        expect.arrayContaining(["finding.status", "finding.explain"]),
      );
    });
  });

  describe("measures", () => {
    describe("on a building whose data has ended", () => {
      const open = async (ruleId: string) =>
        (await as(manager, { url: `${bld()}/findings?status=open&limit=200` }))
          .json()
          .items.find(
            (f: { ruleId: string; dayType: string }) => f.ruleId === ruleId && f.dayType === "workday",
          );
      const adopt = async (id: string) =>
        (
          await as(manager, {
            method: "POST",
            url: `${bld()}/findings/${id}/measure`,
            payload: { strategyId: "occupancy_gated_workday", source: "manual", similar: true },
          })
        ).json().measure;
      const cancelled = (id: string) => async () => {
        await as(manager, {
          method: "PATCH",
          url: `${bld()}/measures/${id}`,
          payload: { status: "cancelled" },
        });
      };

      it("looks back from the last data, so a planned measure keeps its expected saving", async () => {
        await outsideDemo();
        const f = await open("hvac_empty_floor");
        const measure = await adopt(f.id);
        onTestFinished(cancelled(measure.id));
        expect(measure.status).toBe("planned");
        const { verification } = measure;
        expect(verification.verdict).toBe("projected");
        expect(verification.weekly.kwh).toBeGreaterThan(0);
        // the data of this building stops well before today, and the series stops with it
        expect(verification.series.at(-1).date < localParts(Date.now(), "Asia/Shanghai").dateKey).toBe(true);
      });

      it("takes effect at once in a demo organisation, and waits for data rather than claiming a result", async () => {
        const f = await open("hvac_empty_floor");
        const measure = await adopt(f.id);
        onTestFinished(cancelled(measure.id));
        expect(measure).toMatchObject({ status: "in_effect", findings: { acknowledged: 0 } });
        expect(measure.verification).toMatchObject({ verdict: "waiting", after: { days: 0, kwh: 0 } });
        expect(measure.verification.weekly.kwh).toBeGreaterThan(0);
        const { totals } = (await as(manager, { url: `${bld()}/measures` })).json();
        expect(totals).toMatchObject({ inEffect: 1, measured: 0, weeklyKwh: 0 });
        expect(totals.expectedWeeklyKwh).toBeGreaterThan(0);
      });

      it("counts only days with data after a measure took effect", async () => {
        const f = await open("hvac_empty_floor");
        const measure = await adopt(f.id);
        onTestFinished(cancelled(measure.id));
        const last = (await as(manager, { url: `${bld()}/overview` })).json().asOf as string;
        await withOrg(handle.db, seeded.orgId, (tx) =>
          tx
            .update(schema.measures)
            .set({ implementedAt: new Date(`${addDays(last, -7)}T04:00:00Z`) })
            .where(eq(schema.measures.id, measure.id)),
        );
        const { verification: v } = (await as(manager, { url: `${bld()}/measures/${measure.id}` })).json();
        const days = v.series.filter((d: { phase: string; covered: boolean; complete: boolean }) => {
          return d.phase === "after" && d.covered && d.complete;
        });
        expect(v.after.days).toBe(days.length);
        expect(v.after.days).toBeGreaterThan(0);
        expect(v.after.days).toBeLessThanOrEqual(5);
        expect(v.series.at(-1).date).toBe(last);
      });
    });

    it("closes the loop: agree a measure, put it into effect, undo, cancel", async () => {
      const open = (
        await as(manager, { url: `${bld()}/findings?status=open&ruleId=full_floor_few_people&limit=200` })
      ).json().items as { id: string; dayType: string; floorId: string }[];
      const f = open.find((x) => x.dayType === "workday")!;
      const detail = (await as(manager, { url: `${bld()}/findings/${f.id}` })).json();
      expect(detail.options.fits).toEqual(["occupancy_gated_workday", "investigate_on_site"]);
      expect(detail.thresholds.map((t: { key: string }) => t.key)).toEqual([
        "fullFloorMinPeople",
        "minFindingKwh",
      ]);
      expect(detail.measureDetail).toBeNull();
      const similar = detail.options.similar.occupancy_gated_workday as number;
      await outsideDemo();

      const body = {
        strategyId: "occupancy_gated_workday",
        source: "ai_edited",
        note: "Zone off 30 min after empty",
      };
      const url = `${bld()}/findings/${f.id}/measure`;
      // reading is not deciding
      expect((await as(analyst, { method: "POST", url, payload: body })).statusCode).toBe(403);
      const adopted = await as(manager, { method: "POST", url, payload: body });
      expect(adopted.statusCode).toBe(201);
      const { measure, linked, joined } = adopted.json();
      expect(joined).toBe(false);
      expect(linked).toBe(similar + 1);
      expect(measure).toMatchObject({
        status: "planned",
        source: "ai_edited",
        floorId: f.floorId,
        findings: { total: linked, acknowledged: linked, fixed: 0 },
        verification: { verdict: "projected", dayTypes: ["workday"] },
      });
      expect((await as(manager, { method: "POST", url, payload: body })).statusCode).toBe(409);

      const after = (await as(manager, { url: `${bld()}/findings/${f.id}` })).json();
      expect(after).toMatchObject({ status: "acknowledged", measure: { id: measure.id, status: "planned" } });
      expect(after.activity.map((a: { action: string }) => a.action)).toContain("measure.create");

      const m = `${bld()}/measures/${measure.id}`;
      const inEffect = (
        await as(manager, { method: "PATCH", url: m, payload: { status: "in_effect" } })
      ).json();
      expect(inEffect).toMatchObject({ status: "in_effect", findings: { acknowledged: 0 } });
      expect(inEffect.findings.fixed).toBeGreaterThanOrEqual(linked);
      expect(inEffect.implementedAt).toBeTruthy();
      expect(inEffect.verification.verdict).toBe("waiting");
      const list = (await as(analyst, { url: `${bld()}/measures` })).json();
      expect(list.totals.inEffect).toBe(1);
      expect((await as(analyst, { url: m })).json().linked).toHaveLength(inEffect.findings.total);

      const undone = (await as(manager, { method: "PATCH", url: m, payload: { status: "planned" } })).json();
      expect(undone).toMatchObject({ status: "planned", implementedAt: null, findings: { fixed: 0 } });
      const cancelled = (
        await as(manager, { method: "PATCH", url: m, payload: { status: "cancelled" } })
      ).json();
      expect(cancelled).toMatchObject({ status: "cancelled", findings: { total: 0 } });
      expect((await as(manager, { url: `${bld()}/findings/${f.id}` })).json()).toMatchObject({
        status: "open",
        measure: null,
      });
      expect((await as(manager, { method: "PATCH", url: m, payload: { note: "again" } })).statusCode).toBe(
        422,
      );
    });
  });

  describe("briefs, sorting and imports", () => {
    it("asks for one building brief at a time", async () => {
      const first = await as(analyst, { method: "POST", url: `${bld()}/briefs` });
      expect(first.statusCode).toBe(202);
      const { briefId } = first.json();
      expect(sent.brief.at(-1)).toEqual({ orgId: seeded.orgId, briefId });
      // while it is being written, asking again returns the same one
      expect((await as(analyst, { method: "POST", url: `${bld()}/briefs` })).json().briefId).toBe(briefId);
      const latest = (await as(manager, { url: `${bld()}/briefs/latest` })).json();
      expect(latest.brief).toMatchObject({ id: briefId, status: "pending", output: null });
      expect((await as(tenant, { method: "POST", url: `${bld()}/briefs` })).statusCode).toBe(403);
    });

    it("says when a priority's finding has gone into a measure since the brief was written", async () => {
      const [finding] = await inOrg((tx) =>
        tx
          .select({ id: schema.findings.id })
          .from(schema.findings)
          .where(eq(schema.findings.status, "open"))
          .limit(1),
      );
      const [brief] = await inOrg((tx) =>
        tx
          .insert(schema.aiBriefs)
          .values({
            orgId: seeded.orgId,
            buildingId: seeded.buildingId,
            locale: "ja",
            status: "done",
            promptVersion: "test",
            input: {},
            output: { headline: "", priorities: [{ findingId: finding!.id }, { floor: "F1" }], watch: [] },
          })
          .returning({ id: schema.aiBriefs.id }),
      );
      onTestFinished(async () => {
        await inOrg((tx) => tx.delete(schema.aiBriefs).where(eq(schema.aiBriefs.id, brief!.id)));
      });
      const read = async () =>
        (await as(manager, { url: `${bld()}/briefs/${brief!.id}` })).json().output.priorities;
      expect((await read())[0].measureId).toBeUndefined();
      const adopted = await as(manager, {
        method: "POST",
        url: `${bld()}/findings/${finding!.id}/measure`,
        payload: { strategyId: "investigate_on_site", source: "manual" },
      });
      const measureId = adopted.json().measure.id;
      expect((await read())[0].measureId).toBe(measureId);
      expect((await read())[1]).toEqual({ floor: "F1" });
      await as(manager, {
        method: "PATCH",
        url: `${bld()}/measures/${measureId}`,
        payload: { status: "cancelled" },
      });
      expect((await read())[0].measureId).toBeUndefined();
    });

    it("orders findings by floor and by energy", async () => {
      const levels = new Map(
        ((await as(manager, { url: `${bld()}/floors` })).json() as { id: string; level: number }[]).map(
          (f) => [f.id, f.level],
        ),
      );
      const byFloor = (await as(manager, { url: `${bld()}/findings?sort=floor&limit=60` })).json();
      const seenLevels = byFloor.items.map((f: { floorId: string }) => levels.get(f.floorId)!);
      expect(seenLevels).toEqual([...seenLevels].sort((a, b) => a - b));
      const next = (
        await as(manager, { url: `${bld()}/findings?sort=floor&limit=60&cursor=${byFloor.nextCursor}` })
      ).json();
      expect(levels.get(next.items[0].floorId)).toBeGreaterThanOrEqual(seenLevels.at(-1));
      const byKwh = (await as(manager, { url: `${bld()}/findings?sort=kwh&limit=20` })).json();
      const kwh = byKwh.items.map((f: { avoidableKwh: number }) => f.avoidableKwh);
      expect(kwh).toEqual([...kwh].sort((a, b) => b - a));
    });

    it("imports a table next to the live feed, and not into a demo building", async () => {
      const row = { time: "2026-10-01 18:00", floor: "F5", people: 3 };
      const demo = await as(manager, {
        method: "POST",
        url: `${bld()}/imports`,
        payload: { rows: [row], key: "demo-import-1" },
      });
      expect(demo.statusCode).toBe(422);

      const org = (
        await as(ownerEmail, { method: "POST", url: `${API_PREFIX}/orgs`, payload: { name: "Case Co" } })
      ).json();
      const base = `${API_PREFIX}/orgs/${org.id}`;
      const b = (
        await as(ownerEmail, {
          method: "POST",
          url: `${base}/buildings`,
          payload: {
            name: "Case building",
            timezone: "Asia/Shanghai",
            gridRegion: "CN-East",
            tariff: { kind: "flat", rate: 0.85 },
          },
        })
      ).json();
      for (const level of [1, 2])
        await as(ownerEmail, {
          method: "POST",
          url: `${base}/buildings/${b.id}/floors`,
          payload: { label: `F${level}`, level, areaM2: 1200, ratedHvacKw: 84, ratedLightingKw: 10.8 },
        });
      const rows: Record<string, unknown>[] = [];
      for (let k = 0; k < 8; k++)
        rows.push({
          time: `2026-10-12 ${18 + Math.floor(k / 4)}:${String((k % 4) * 15).padStart(2, "0")}`,
          floor: "F1",
          people: Math.max(0, 6 - 2 * k),
          hvacKwh: 5,
          hvac: "full",
          lights: 100,
        });
      rows.push(
        { time: "2026-10-12 18:00", floor: "F9", people: 1 },
        { time: "yesterday", floor: "F2", people: 1 },
      );
      const payload = { rows, key: "case-import-0001", source: "case.csv" };
      const before = sent.recompute.length;
      const r = await as(ownerEmail, { method: "POST", url: `${base}/buildings/${b.id}/imports`, payload });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        rows: 8,
        skipped: { unknownFloor: 1, badTime: 1, unknownFloors: ["F9"] },
        counts: { readings: 8, doorCounts: 8, hvacEvents: 1, lightingEvents: 1 },
        carry: { F1: { people: 0, hvac: "full", lights: 1 } },
      });
      expect(sent.recompute.slice(before)).toEqual([{ orgId: org.id, buildingId: b.id }]);
      // the same part sent again is recognised and not processed twice
      expect(
        (await as(ownerEmail, { method: "POST", url: `${base}/buildings/${b.id}/imports`, payload }))
          .statusCode,
      ).toBe(200);
      expect(sent.recompute.length).toBe(before + 1);
      const devices = (await as(ownerEmail, { url: `${base}/buildings/${b.id}/devices` })).json() as {
        externalId: string;
      }[];
      expect(devices.map((d) => d.externalId)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^IMPORT-\w{8}-F1-DOOR$/),
          expect.stringMatching(/-F1-M-HVAC$/),
        ]),
      );
    });
  });

  describe("organisations and pictures", () => {
    it("renames, leaves and deletes organisations by role", async () => {
      // the shared demo: managers may not rename it, and nobody may delete it
      expect(
        (await as(manager, { method: "PATCH", url: org(), payload: { name: "Renamed" } })).statusCode,
      ).toBe(403);
      expect((await as(ownerEmail, { method: "DELETE", url: org() })).statusCode).toBe(409);

      const own = (
        await as(ownerEmail, {
          method: "POST",
          url: `${API_PREFIX}/orgs`,
          payload: { name: "Short-lived Co" },
        })
      ).json();
      const url = `${API_PREFIX}/orgs/${own.id}`;
      const renamed = await as(ownerEmail, { method: "PATCH", url, payload: { name: "Renamed Co" } });
      expect(renamed.json()).toMatchObject({ id: own.id, name: "Renamed Co" });
      // its only owner cannot leave it
      expect((await as(ownerEmail, { method: "DELETE", url: `${url}/membership` })).statusCode).toBe(409);
      // someone else can
      const [analystUser] = await handle.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, analyst));
      await handle.db
        .insert(schema.memberships)
        .values({ orgId: own.id, userId: analystUser!.id, role: "viewer" });
      expect((await as(analyst, { method: "DELETE", url })).statusCode).toBe(403);
      expect((await as(analyst, { method: "DELETE", url: `${url}/membership` })).statusCode).toBe(204);
      expect(
        (await as(analyst, { url: `${API_PREFIX}/me` }))
          .json()
          .memberships.some((m: { orgId: string }) => m.orgId === own.id),
      ).toBe(false);

      expect((await as(ownerEmail, { method: "DELETE", url })).statusCode).toBe(204);
      expect([403, 404]).toContain((await as(ownerEmail, { url })).statusCode);
    });

    it("keeps a picture per person, only real images", async () => {
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const fake = `data:image/png;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`;
      expect(
        (await as(manager, { method: "PUT", url: `${API_PREFIX}/me/avatar`, payload: { image: fake } }))
          .statusCode,
      ).toBe(422);
      const set = await as(manager, {
        method: "PUT",
        url: `${API_PREFIX}/me/avatar`,
        payload: { image: png },
      });
      expect(set.statusCode).toBe(200);
      const { avatarUrl } = set.json();
      expect((await as(manager, { url: `${API_PREFIX}/me` })).json().user.avatarUrl).toBe(avatarUrl);
      const picture = await as(analyst, { url: avatarUrl });
      expect(picture.statusCode).toBe(200);
      expect(picture.headers["content-type"]).toBe("image/png");
      expect(picture.headers["cache-control"]).toContain("immutable");
      expect((await app.inject({ url: avatarUrl })).statusCode).toBe(401);
      expect((await as(manager, { method: "DELETE", url: `${API_PREFIX}/me/avatar` })).statusCode).toBe(204);
      expect((await as(manager, { url: `${API_PREFIX}/me` })).json().user.avatarUrl).toBeNull();
    });
  });

  describe("analytics", () => {
    it("serves the report as JSON and CSV", async () => {
      const r = (await as(analyst, { url: `${bld()}/report?from=2026-09-15&to=2026-10-13` })).json();
      expect(r.totals.kwh).toBeGreaterThan(150_000);
      expect(r.scope2.locationFactor.region).toBe("CN-East");
      const csv = await as(analyst, { url: `${bld()}/report?from=2026-09-15&to=2026-10-13&format=csv` });
      expect(csv.headers["content-type"]).toContain("text/csv");
      expect(csv.body).toContain("scope2,location_based");
    });

    it("estimates strategies and evaluates an EPC", async () => {
      const s = (await as(manager, { url: `${bld()}/strategies?from=2026-09-15&to=2026-10-13` })).json();
      const full = s.strategies.find((x: { id: string }) => x.id === "full_package");
      expect(full.capex).toBe(280_000);
      const epc = (
        await as(manager, {
          method: "POST",
          url: `${bld()}/epc`,
          payload: { strategyId: "full_package", annualKwh: full.annualKwh, escoShare: 0.6, years: 5 },
        })
      ).json();
      expect(epc.escoPaybackYears).toBeGreaterThan(1);
      expect(epc.escoPaybackYears).toBeLessThan(5);
      expect(epc.timeline).toHaveLength(5);
    });

    it("serves forecasts and evidence intervals", async () => {
      const fc = (await as(manager, { url: `${bld()}/forecasts?from=2026-10-13` })).json();
      expect(fc).toHaveLength(12 * 7);
      const iv = (
        await as(manager, { url: `${bld()}/floors/${seeded.floorIds.f12}/intervals?date=2026-10-12` })
      ).json();
      expect(iv).toHaveLength(96);
    });
  });

  describe("API keys and ingestion", () => {
    it("ingests telemetry with a building-scoped key, idempotently", async () => {
      const created = await as(ownerEmail, {
        method: "POST",
        url: `${org()}/api-keys`,
        payload: { name: "Gateway", scopes: ["telemetry:write"], buildingId: seeded.buildingId },
      });
      expect(created.statusCode).toBe(201);
      const { key, id } = created.json();
      const headers = { authorization: `Bearer ${key}`, "idempotency-key": "gw-2026-10-13-0001" };
      const payload = {
        doorCounts: [{ device: "TA-F12-DOOR", start: "2026-10-13T01:00:00Z", entries: 3, exits: 0 }],
      };
      const first = await app.inject({ method: "POST", url: `${bld()}/telemetry`, headers, payload });
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({
        duplicate: false,
        affected: { fromDate: "2026-10-13", toDateExclusive: "2026-10-14" },
      });
      expect(sent.recompute.at(-1)).toEqual({ orgId: seeded.orgId, buildingId: seeded.buildingId });
      const retry = await app.inject({ method: "POST", url: `${bld()}/telemetry`, headers, payload });
      expect(retry.json()).toMatchObject({ duplicate: true, batchId: first.json().batchId });

      const unknown = await app.inject({
        method: "POST",
        url: `${bld()}/telemetry`,
        headers: { ...headers, "idempotency-key": "gw-x-0002" },
        payload: { doorCounts: [{ ...payload.doorCounts[0], device: "NOPE" }] },
      });
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json().details[0]).toContain("NOPE");
      // the key cannot read findings and stops working once revoked
      expect(
        (await app.inject({ url: `${bld()}/findings`, headers: { authorization: `Bearer ${key}` } }))
          .statusCode,
      ).toBe(403);
      expect((await as(ownerEmail, { method: "DELETE", url: `${org()}/api-keys/${id}` })).statusCode).toBe(
        204,
      );
      expect(
        (await app.inject({ method: "POST", url: `${bld()}/telemetry`, headers, payload })).statusCode,
      ).toBe(401);
    });

    it("only lets admins manage keys", async () => {
      expect((await as(manager, { url: `${org()}/api-keys` })).statusCode).toBe(403);
    });
  });

  describe("invitations", () => {
    it("invites a viewer who signs up and gets read-only access", async () => {
      const inv = await as(ownerEmail, {
        method: "POST",
        url: `${org()}/invitations`,
        payload: { email: "new.viewer@example.com", role: "viewer" },
      });
      expect(inv.statusCode).toBe(201);
      // with outgoing mail configured the invitee gets the link too
      expect(inv.json().emailed).toBe(true);
      expect(lastMailTo("new.viewer@example.com")?.text).toContain(inv.json().acceptUrl);
      const token = inv.json().acceptUrl.split("#")[1];
      const weak = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/invitations/accept`,
        payload: { token, name: "New Viewer", password: "short" },
      });
      expect(weak.statusCode).toBe(422);
      const ok = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/invitations/accept`,
        payload: { token, name: "New Viewer", password: "a sufficiently long passphrase" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().memberships[0]).toMatchObject({ orgId: seeded.orgId, role: "viewer" });
      const cookie = ok.cookies.find((c) => c.name === "fc_session")!.value;
      const read = await app.inject({ url: `${bld()}/report`, cookies: { fc_session: cookie } });
      expect(read.statusCode).toBe(200);
      const [f] = (
        await app.inject({ url: `${bld()}/findings?limit=1`, cookies: { fc_session: cookie } })
      ).json().items;
      const review = await app.inject({
        method: "PATCH",
        url: `${bld()}/findings/${f.id}`,
        cookies: { fc_session: cookie },
        headers: { origin: ORIGIN },
        payload: { status: "acknowledged" },
      });
      expect(review.statusCode).toBe(403);
      // the token is single-use
      const reuse = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/invitations/accept`,
        payload: { token, name: "X", password: "a sufficiently long passphrase" },
      });
      expect(reuse.statusCode).toBe(404);
    });

    it("prevents admins from granting ownership and removing the last owner", async () => {
      const members = (await as(ownerEmail, { url: `${org()}/members` })).json() as {
        userId: string;
        role: string;
      }[];
      const owner = members.find((m) => m.role === "owner")!;
      const res = await as(ownerEmail, { method: "DELETE", url: `${org()}/members/${owner.userId}` });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("email: continue, sign up, reset", () => {
    const engineer = "engineer@flowcarbon-demo.example";
    const start = (email: string) =>
      app.inject({ method: "POST", url: `${API_PREFIX}/auth/email/start`, payload: { email, locale: "zh" } });
    const verify = (email: string, code: string) =>
      app.inject({ method: "POST", url: `${API_PREFIX}/auth/email/verify`, payload: { email, code } });
    const cookie = (res: Awaited<ReturnType<typeof start>>, name: string) =>
      res.cookies.find((c) => c.name === name)?.value;

    it("describes what this server offers", async () => {
      expect((await app.inject({ url: `${API_PREFIX}/auth/methods` })).json()).toEqual({
        password: true,
        emailCode: true,
        signUp: true,
        demo: { name: expect.any(String), slug: "tower-a-demo" },
      });
    });

    it("tells the form whether an address has an account, and mails codes only to new addresses", async () => {
      const identify = (email: string) =>
        app.inject({ method: "POST", url: `${API_PREFIX}/auth/identify`, payload: { email } });
      expect((await identify(engineer.toUpperCase())).json()).toEqual({ account: "password", signUp: true });
      expect((await identify("nobody@example.com")).json()).toEqual({ account: "none", signUp: true });
      // an existing account signs in with its password; it gets no sign-up code
      const before = outbox.length;
      expect((await start(engineer)).statusCode).toBe(202);
      expect(outbox.length).toBe(before);
    });

    it("stops accepting a code after five wrong tries", async () => {
      const kim = "kim@example.com";
      await start(kim);
      const code = codeIn(lastMailTo(kim))!;
      const wrong = code === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) expect((await verify(kim, wrong)).statusCode).toBe(401);
      expect((await verify(kim, code)).statusCode).toBe(401);
    });

    it("signs up a verified address with a password: explore the demo, or found an organisation", async () => {
      const ada = "ada@example.com";
      await start(ada);
      const mail = lastMailTo(ada);
      expect(mail?.subject).toContain("验证码"); // the language the form was in
      const v = await verify(ada, codeIn(mail)!);
      expect(v.statusCode).toBe(200);
      const ticket = v.json().ticket as string;
      const signup = (body: Record<string, unknown>) =>
        app.inject({ method: "POST", url: `${API_PREFIX}/auth/signup`, payload: { ticket, ...body } });
      // a weak password is refused before the ticket is spent
      expect((await signup({ name: "Ada", password: "short", start: "demo" })).statusCode).toBe(422);
      const demo = await signup({
        name: "Ada",
        password: "a long enough passphrase",
        start: "demo",
        locale: "zh",
        remember: true,
      });
      expect(demo.statusCode).toBe(200);
      expect(demo.json().user).toMatchObject({ email: ada, locale: "zh", hasPassword: true });
      // the demo is a building of one's own, built by a background job
      expect(demo.json().memberships).toEqual([
        expect.objectContaining({ role: "owner", orgSlug: expect.stringMatching(/^demo-/) }),
      ]);
      const adaDemo = demo.json().memberships[0].orgId;
      expect(sent.demo.at(-1)).toEqual({ orgId: adaDemo });
      const adaCookie = demo.cookies.find((c) => c.name === "fc_session")!.value;
      const again = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/orgs/demo`,
        cookies: { fc_session: adaCookie },
        headers: { origin: ORIGIN },
      });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ id: adaDemo, ready: false });
      expect(
        (await signup({ name: "Ada", password: "a long enough passphrase", start: "demo" })).statusCode,
      ).toBe(410);
      // from now on the address signs in with its password
      const back = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: ada, password: "a long enough passphrase" },
      });
      expect(back.statusCode).toBe(200);

      const lin = "lin@example.com";
      await start(lin);
      const t2 = (await verify(lin, codeIn(lastMailTo(lin))!)).json().ticket as string;
      const founded = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/signup`,
        payload: {
          ticket: t2,
          name: "Lin",
          password: "another long passphrase",
          start: "organisation",
          organisation: "Harbour Point 物业",
          remember: true,
        },
      });
      expect(founded.statusCode).toBe(200);
      const own = founded.json().memberships[0];
      expect(own).toMatchObject({ orgName: "Harbour Point 物业", role: "owner" });
      expect(own.orgSlug).toMatch(/^harbour-point-[a-z0-9]+$/);

      const visitor = "visitor@example.com";
      await start(visitor);
      const t3 = (await verify(visitor, codeIn(lastMailTo(visitor))!)).json().ticket as string;
      const looking = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/signup`,
        payload: { ticket: t3, name: "Visitor", password: "a third long passphrase", start: "explore" },
      });
      expect(looking.statusCode).toBe(200);
      expect(looking.json().memberships).toMatchObject([
        { orgSlug: "tower-a-demo", role: "viewer", orgPlan: "demo" },
      ]);
    });

    it("keeps several accounts signed in on one device and switches between them", async () => {
      const first = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: manager, password: PASSWORD, remember: true },
      });
      const second = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: ownerEmail, password: PASSWORD, remember: true },
        cookies: { fc_session: cookie(first, "fc_session")! },
        headers: { origin: ORIGIN },
      });
      const jar = { fc_session: cookie(second, "fc_session")!, fc_accounts: cookie(second, "fc_accounts")! };
      expect(jar.fc_accounts).toBe(cookie(first, "fc_session"));
      const listed = (await app.inject({ url: `${API_PREFIX}/auth/accounts`, cookies: jar })).json().accounts;
      expect(listed.map((a: { email: string; active: boolean }) => [a.email, a.active])).toEqual([
        [ownerEmail, true],
        [manager, false],
      ]);
      const managerId = listed[1].userId;
      const switched = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/accounts/switch`,
        payload: { userId: managerId },
        cookies: jar,
        headers: { origin: ORIGIN },
      });
      expect(switched.statusCode).toBe(200);
      expect(switched.json().user.email).toBe(manager);
      const after = {
        fc_session: cookie(switched, "fc_session")!,
        fc_accounts: cookie(switched, "fc_accounts")!,
      };
      expect(after.fc_session).toBe(cookie(first, "fc_session"));
      expect(after.fc_accounts).toBe(jar.fc_session);
      // a switch needs the app's own origin
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${API_PREFIX}/auth/accounts/switch`,
            payload: { userId: managerId },
            cookies: jar,
            headers: { origin: "https://evil.example" },
          })
        ).statusCode,
      ).toBe(403);
      // signing out hands over to the next account on the device
      const out = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/logout`,
        cookies: after,
        headers: { origin: ORIGIN },
      });
      expect(out.json().next.email).toBe(ownerEmail);
      const everyone = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/logout`,
        payload: { everyone: true },
        cookies: { fc_session: cookie(out, "fc_session")! },
        headers: { origin: ORIGIN },
      });
      expect(everyone.json().next).toBeNull();
      expect(
        (await app.inject({ url: `${API_PREFIX}/me`, cookies: { fc_session: jar.fc_session } })).statusCode,
      ).toBe(401);
    });

    it("signs out a session that was not kept when someone else signs in", async () => {
      const shared = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: manager, password: PASSWORD },
      });
      const other = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: ownerEmail, password: PASSWORD },
        cookies: { fc_session: cookie(shared, "fc_session")! },
        headers: { origin: ORIGIN },
      });
      expect(cookie(other, "fc_accounts") ?? "").toBe("");
      const old = await app.inject({
        url: `${API_PREFIX}/me`,
        cookies: { fc_session: cookie(shared, "fc_session")! },
      });
      expect(old.statusCode).toBe(401);
    });

    it("lets a signed-in person found another organisation", async () => {
      const res = await as(analyst, {
        method: "POST",
        url: `${API_PREFIX}/orgs`,
        payload: { name: "Side project" },
      });
      expect(res.statusCode).toBe(201);
      const me = (await as(analyst, { url: `${API_PREFIX}/me` })).json();
      expect(
        me.memberships.map((m: { orgName: string; role: string }) => [m.orgName, m.role]),
      ).toContainEqual(["Side project", "owner"]);
    });

    it("resets a password with a code and signs out every other session", async () => {
      const viewer = "new.viewer@example.com";
      const old = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: viewer, password: "a sufficiently long passphrase" },
      });
      const oldCookie = old.cookies.find((c) => c.name === "fc_session")!.value;
      await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/password/forgot`,
        payload: { email: viewer },
      });
      const code = codeIn(lastMailTo(viewer))!;
      const reset = (password: string) =>
        app.inject({
          method: "POST",
          url: `${API_PREFIX}/auth/password/reset`,
          payload: { email: viewer, code, password, remember: true },
        });
      // an unacceptable password does not use up the code
      expect((await reset("short")).statusCode).toBe(422);
      const ok = await reset("another sufficiently long passphrase");
      expect(ok.statusCode).toBe(200);
      expect(ok.cookies.find((c) => c.name === "fc_session")!.expires).toBeDefined();
      expect(
        (await app.inject({ url: `${API_PREFIX}/me`, cookies: { fc_session: oldCookie } })).statusCode,
      ).toBe(401);
      const relogin = await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/login`,
        payload: { email: viewer, password: "another sufficiently long passphrase" },
      });
      expect(relogin.statusCode).toBe(200);
    });

    it("answers the same for unknown addresses when sign-up is closed elsewhere", async () => {
      const before = outbox.length;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${API_PREFIX}/auth/password/forgot`,
            payload: { email: "nobody@example.com" },
          })
        ).statusCode,
      ).toBe(202);
      expect(outbox.length).toBe(before);
    });
  });

  describe("assistant, strategies and community", () => {
    const viewer = "strategy.viewer@example.com";
    let tower: SeedResult;
    const towerOrg = () => `${API_PREFIX}/orgs/${tower.orgId}`;
    const towerBld = () => `${towerOrg()}/buildings/${tower.buildingId}`;
    const inSeeded = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(handle.db, seeded.orgId, fn);
    type Board = {
      plan: {
        before: {
          kwh: number;
          cost: number;
          avoidableKwh: number;
          avoidableShare: number;
          greenShare: number;
        };
        window: { from: string; to: string; days: number };
        realisation: { low: number; mid: number; high: number };
        options: {
          id: string;
          actions: { floorId: string; strategyId: string; coveredKwh: number; findings: number }[];
          after: { kwh: number; avoidableKwh: number; greenShare: number };
          low: { kwh: number };
          high: { kwh: number };
        }[];
      };
      adopted: { measures: { id: string }[]; after: { kwh: number } };
      week: { days: { withKwh: number; withoutKwh: number }[]; coverage: unknown[] };
      applied: { turnId: string; option: string; measureIds: string[] }[];
    };
    const boardOf = async (url: string, email = manager) =>
      (await as(email, { url: `${url}/strategy-board` })).json() as Board;
    const pairs = (board: Board) =>
      board.plan.options.flatMap((o) => o.actions.map((a) => `${a.floorId}|${a.strategyId}`));
    /** A turn the worker has finished, with the plan the board shows. */
    async function doneTurn(over: Partial<typeof schema.assistantTurns.$inferInsert> = {}) {
      const { plan } = await boardOf(bld());
      const [turn] = await inSeeded((tx) =>
        tx
          .insert(schema.assistantTurns)
          .values({
            orgId: seeded.orgId,
            buildingId: seeded.buildingId,
            prompt: "Bring avoidable energy down",
            status: "done",
            plan: plan as never,
            reply: { reply: "Here you go.", options: [] },
            promptVersion: "assistant-v1",
            ...over,
          })
          .returning(),
      );
      return turn!;
    }
    const measureCount = async () =>
      (
        await inSeeded((tx) =>
          tx.select({ id: schema.measures.id, status: schema.measures.status }).from(schema.measures),
        )
      ).filter((m) => m.status !== "cancelled").length;

    beforeAll(async () => {
      const [u] = await handle.db
        .insert(schema.users)
        .values({
          email: viewer,
          name: "Strategy Viewer",
          passwordHash: await hashPassword(PASSWORD),
          emailVerifiedAt: new Date(),
        })
        .returning();
      await inSeeded((tx) =>
        tx.insert(schema.memberships).values({ orgId: seeded.orgId, userId: u!.id, role: "viewer" }),
      );
      // a second organisation, which is not the shared demonstration and not on the demo plan
      tower = await seedDemo(handle.db, {
        slug: "tower-b",
        orgName: "Tower B",
        // up to yesterday, so its data is current
        startDate: addDays(localParts(Date.now(), "Asia/Shanghai").dateKey, -21),
        days: 21,
        password: PASSWORD,
      });
      await handle.db
        .update(schema.organizations)
        .set({ plan: "standard" })
        .where(eq(schema.organizations.id, tower.orgId));
    }, 120_000);

    describe("the strategy board", () => {
      it("starts from the figures the building reports and states its assumption", async () => {
        const board = await boardOf(bld(), viewer);
        const { plan } = board;
        expect(plan.options.map((o) => o.id)).toEqual(["weekends", "weekdays", "balanced"]);
        expect(plan.realisation).toEqual({ low: 0.6, mid: 0.8, high: 0.95 });
        expect(plan.window.days).toBe(28);
        const report = (
          await as(manager, { url: `${bld()}/report?from=${plan.window.from}&to=${plan.window.to}` })
        ).json();
        expect(plan.before.kwh).toBe(report.totals.kwh);
        expect(plan.before.avoidableKwh).toBe(report.totals.avoidableKwh);
        expect(plan.before.cost).toBe(report.totals.cost);
      });

      it("works out every option from what it covers, with the range around it", async () => {
        const { plan } = await boardOf(bld());
        for (const o of plan.options) {
          const covered = o.actions.reduce((s, a) => s + a.coveredKwh, 0);
          expect(covered).toBeGreaterThan(0);
          expect(plan.before.kwh - o.after.kwh).toBeCloseTo(covered * plan.realisation.mid, 0);
          expect(plan.before.avoidableKwh - o.after.avoidableKwh).toBeCloseTo(
            covered * plan.realisation.mid,
            0,
          );
          expect(plan.before.kwh - o.low.kwh).toBeCloseTo(covered * plan.realisation.low, 0);
          expect(plan.before.kwh - o.high.kwh).toBeCloseTo(covered * plan.realisation.high, 0);
          // the same green energy over a lower total
          expect(o.after.greenShare * o.after.kwh).toBeCloseTo(plan.before.greenShare * plan.before.kwh, 0);
        }
      });

      it("is for those who may read findings", async () => {
        expect((await as(tenant, { url: `${bld()}/strategy-board` })).statusCode).toBe(403);
      });
    });

    describe("asking", () => {
      const ask = (email: string, payload: unknown) =>
        as(email, { method: "POST", url: `${bld()}/assistant`, payload: payload as object });

      it("queues a turn, shows it newest last and polls it while pending", async () => {
        const first = await ask(analyst, { prompt: "  Bring avoidable kWh down to 5%  ", locale: "en" });
        expect(first.statusCode).toBe(202);
        const { turnId } = first.json();
        expect(sent.assistant.at(-1)).toEqual({ orgId: seeded.orgId, turnId });
        const second = (await ask(analyst, { prompt: "周末关空调", locale: "zh" })).json();

        const turn = (await as(viewer, { url: `${bld()}/assistant/turns/${turnId}` })).json();
        expect(turn).toMatchObject({
          status: "pending",
          prompt: "Bring avoidable kWh down to 5%",
          locale: "en",
          plan: null,
          reply: null,
          draft: null,
          model: null,
          appliedOption: null,
          requestedBy: "Demo Energy & Carbon Analyst",
        });
        const { items } = (await as(viewer, { url: `${bld()}/assistant/turns?limit=2` })).json();
        expect(items.map((t: { id: string }) => t.id)).toEqual([turnId, second.turnId]);
      });

      it("takes the request as it is meant and refuses anything else", async () => {
        expect((await ask(analyst, { prompt: "   ", locale: "en" })).statusCode).toBe(400);
        expect((await ask(analyst, { prompt: "x".repeat(501), locale: "en" })).statusCode).toBe(400);
        expect((await ask(analyst, { prompt: "Hello", locale: "fr" })).statusCode).toBe(400);
      });

      it("leaves asking to those who may ask the AI", async () => {
        expect((await ask(viewer, { prompt: "Lights off", locale: "en" })).statusCode).toBe(403);
        expect((await ask(tenant, { prompt: "Lights off", locale: "en" })).statusCode).toBe(403);
      });

      it("counts turns against a demo organisation's AI quota, but not those no model answers", async () => {
        const rows = (promptVersion: string) =>
          Array.from({ length: 25 }, () => ({
            orgId: seeded.orgId,
            buildingId: seeded.buildingId,
            prompt: "Filling the quota",
            promptVersion,
          }));
        const clear = () =>
          inSeeded((tx) =>
            tx.delete(schema.assistantTurns).where(eq(schema.assistantTurns.prompt, "Filling the quota")),
          );
        await inSeeded((tx) => tx.insert(schema.assistantTurns).values(rows("template")));
        expect((await ask(analyst, { prompt: "Still fine", locale: "en" })).statusCode).toBe(202);
        await clear();
        await inSeeded((tx) => tx.insert(schema.assistantTurns).values(rows("assistant-v1")));
        // past the quota the plan still comes, with templated words: it never needed a model
        const past = await ask(analyst, { prompt: "One too many", locale: "en" });
        expect(past.statusCode).toBe(202);
        const [templated] = await inSeeded((tx) =>
          tx
            .select({ promptVersion: schema.assistantTurns.promptVersion })
            .from(schema.assistantTurns)
            .where(eq(schema.assistantTurns.id, past.json().turnId)),
        );
        expect(templated?.promptVersion).toBe("template");
        // explanations and briefs share the same allowance (this finding has no explanation under way)
        const f = (await as(analyst, { url: `${bld()}/findings?limit=100` })).json().items.at(-1);
        const explained = await as(analyst, {
          method: "POST",
          url: `${bld()}/findings/${f.id}/explanations`,
        });
        expect(explained.statusCode).toBe(429);
        // with what the page needs to say so in its own language
        expect(explained.json()).toMatchObject({ code: "ai_quota", details: { perDay: 20 } });
        await clear();

        // a turn that failed answered no one
        await inSeeded((tx) =>
          tx
            .insert(schema.assistantTurns)
            .values(rows("assistant-v1").map((r) => ({ ...r, status: "failed" as const }))),
        );
        const again = await as(analyst, { method: "POST", url: `${bld()}/findings/${f.id}/explanations` });
        expect(again.statusCode).toBe(202);
        await clear();
        await inSeeded((tx) =>
          tx.delete(schema.aiExplanations).where(eq(schema.aiExplanations.findingId, f.id)),
        );
      });

      it("leaves no turn behind when the job cannot be queued", async () => {
        const prompt = "The queue is down";
        queueDown = true;
        const res = await ask(analyst, { prompt, locale: "en" });
        queueDown = false;
        expect(res.statusCode).toBe(500);
        const { items } = (await as(analyst, { url: `${bld()}/assistant/turns` })).json();
        expect(items.map((t: { prompt: string }) => t.prompt)).not.toContain(prompt);
      });

      it("ends a turn that lost its job, which then stops counting against the quota", async () => {
        const old = await doneTurn({
          status: "pending",
          plan: null,
          reply: null,
          draft: '{"reply":"half',
          createdAt: new Date(Date.now() - 3_600_000),
        });
        const fresh = await doneTurn({ status: "pending", plan: null, reply: null });
        const seen = (await as(viewer, { url: `${bld()}/assistant/turns/${old.id}` })).json();
        expect(seen).toMatchObject({ status: "failed", draft: null, outdated: false });
        expect(seen.completedAt).toBeTruthy();
        expect((await as(viewer, { url: `${bld()}/assistant/turns/${fresh.id}` })).json().status).toBe(
          "pending",
        );
        await inSeeded((tx) =>
          tx.delete(schema.assistantTurns).where(inArray(schema.assistantTurns.id, [old.id, fresh.id])),
        );
      });
    });

    describe("reading a turn in another language", () => {
      const read = async (id: string, locale?: string) =>
        (
          await as(viewer, { url: `${bld()}/assistant/turns/${id}${locale ? `?locale=${locale}` : ""}` })
        ).json();
      const intent = {
        kind: "plan" as const,
        target: null,
        focus: "all" as const,
        floors: [],
        unknownFloors: [],
        days: "all" as const,
      };

      it("tells a finished turn again from its plan, keeping what the person typed", async () => {
        const turn = await doneTurn({
          prompt: "帮我想几个节能方案",
          locale: "zh",
          intent,
          model: "claude-opus-5-5",
          reply: { reply: "周末是最容易下手的。", options: [] },
        });
        expect(await read(turn.id)).toMatchObject({ locale: "zh", reply: { reply: "周末是最容易下手的。" } });
        const en = await read(turn.id, "en");
        expect(en).toMatchObject({ locale: "en", prompt: "帮我想几个节能方案", model: null });
        expect(en.reply.reply).toMatch(/^Avoidable energy is /);
        expect(en.reply.options.map((o: { title: string }) => o.title)).toEqual([
          "Weekends first",
          "Weekdays first",
          "Balanced",
        ]);
        expect(en.reply.options[0].why).toMatch(/^Weekends: cool only floors that asked/);
        expect((await read(turn.id, "zh")).reply.reply).toBe("周末是最容易下手的。");
      });

      it("leaves a turn still being written as it is", async () => {
        const turn = await doneTurn({ status: "pending", plan: null, reply: null, locale: "zh" });
        expect(await read(turn.id, "en")).toMatchObject({ locale: "zh", status: "pending", reply: null });
        await inSeeded((tx) => tx.delete(schema.assistantTurns).where(eq(schema.assistantTurns.id, turn.id)));
      });
    });

    describe("applying", () => {
      const apply = (email: string, turnId: string, option: string) =>
        as(email, {
          method: "POST",
          url: `${bld()}/assistant/turns/${turnId}/apply`,
          payload: { option },
        });
      const undo = (email: string, turnId: string) =>
        as(email, { method: "POST", url: `${bld()}/assistant/turns/${turnId}/undo` });

      it("refuses those who only read or ask, and creates nothing", async () => {
        const turn = await doneTurn();
        const before = await measureCount();
        expect((await apply(viewer, turn.id, "weekends")).statusCode).toBe(403);
        expect((await apply(analyst, turn.id, "weekends")).statusCode).toBe(403);
        expect((await undo(viewer, turn.id)).statusCode).toBe(403);
        expect(await measureCount()).toBe(before);
      });

      it("applies once however often it is asked, and undo restores everything", async () => {
        const start = await boardOf(bld());
        const turn = await doneTurn();
        const option = start.plan.options.find((o) => o.id === "balanced")!;

        const applied = await apply(manager, turn.id, "balanced");
        expect(applied.statusCode).toBe(200);
        const first = applied.json();
        expect(first).toMatchObject({ appliedOption: "balanced", appliedBy: "Demo Property Manager" });
        expect(first.appliedAt).toBeTruthy();
        expect(first.appliedMeasures).toHaveLength(option.actions.length);
        // a demo organisation's simulated hardware obeys at once, and the row keeps nothing the page should not show
        expect(new Set(first.appliedMeasures.map((m: { status: string }) => m.status))).toEqual(
          new Set(["in_effect"]),
        );
        expect(first.appliedMeasures[0]).not.toHaveProperty("findingIds");
        const count = await measureCount();

        const again = (await apply(manager, turn.id, "balanced")).json();
        expect(again.appliedMeasures).toEqual(first.appliedMeasures);
        expect(await measureCount()).toBe(count);

        // through the same path as adopting a finding
        const { items } = (await as(manager, { url: `${bld()}/measures?status=in_effect` })).json();
        const ids = first.appliedMeasures.map((m: { measureId: string }) => m.measureId);
        const created = items.filter((m: { id: string }) => ids.includes(m.id));
        expect(created).toHaveLength(ids.length);
        for (const m of created) {
          expect(m).toMatchObject({
            source: "ai",
            status: "in_effect",
            verification: { verdict: "waiting" },
          });
          expect(m.implementedAt).toBeTruthy();
          expect(m.findings.fixed).toBeGreaterThan(0);
        }

        const board = await boardOf(bld());
        expect(board.adopted.measures.map((m) => m.id).sort()).toEqual([...ids].sort());
        expect(board.adopted.after.kwh).toBeCloseTo(option.after.kwh, 0);
        for (const a of option.actions) expect(pairs(board)).not.toContain(`${a.floorId}|${a.strategyId}`);
        expect(board.applied[0]).toMatchObject({ turnId: turn.id, option: "balanced", measureIds: ids });
        expect(board.week.days.some((d) => d.withKwh < d.withoutKwh)).toBe(true);

        expect((await apply(manager, turn.id, "weekends")).statusCode).toBe(409);

        const undone = await undo(manager, turn.id);
        expect(undone.statusCode).toBe(200);
        expect(undone.json()).toMatchObject({
          appliedOption: null,
          appliedAt: null,
          appliedBy: null,
          appliedMeasures: null,
        });
        expect(await measureCount()).toBe(count - ids.length);
        const after = await boardOf(bld());
        expect(after.plan).toEqual(start.plan);
        expect(after.adopted.measures).toEqual([]);
        expect(after.applied).toEqual([]);

        // undoing again changes nothing, and the option can be applied afresh
        expect((await undo(manager, turn.id)).statusCode).toBe(200);
        expect(await measureCount()).toBe(count - ids.length);
        expect((await apply(manager, turn.id, "weekends")).statusCode).toBe(200);
        expect((await undo(manager, turn.id)).statusCode).toBe(200);
        expect((await boardOf(bld())).plan).toEqual(start.plan);
      });

      it("records who did what in the audit log", async () => {
        const turn = await doneTurn();
        await apply(manager, turn.id, "weekends");
        await undo(manager, turn.id);
        const rows = await inSeeded((tx) =>
          tx.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, turn.id)),
        );
        expect(rows.map((r) => r.action)).toEqual(["assistant.apply", "assistant.undo"]);
      });

      it("tells the truth about an option once its measures have moved on", async () => {
        const start = await boardOf(bld());
        const turn = await doneTurn();
        const first = (await apply(manager, turn.id, "weekends")).json();
        const [one, ...others] = first.appliedMeasures as { measureId: string }[];
        const read = async () => (await as(manager, { url: `${bld()}/assistant/turns/${turn.id}` })).json();
        const patch = (id: string, status: string) =>
          as(manager, { method: "PATCH", url: `${bld()}/measures/${id}`, payload: { status } });

        expect((await patch(one!.measureId, "planned")).statusCode).toBe(200);
        const { appliedMeasures } = await read();
        const statuses = appliedMeasures.map((m: { status: string }) => m.status);
        expect(statuses[0]).toBe("planned");
        expect(new Set(statuses.slice(1))).toEqual(new Set(["in_effect"]));

        for (const m of [one!, ...others]) await patch(m.measureId, "cancelled");
        expect(await read()).toMatchObject({ appliedOption: null, appliedMeasures: null, appliedAt: null });

        // nothing of it is left, so it can be applied again
        const again = await apply(manager, turn.id, "balanced");
        expect(again.statusCode).toBe(200);
        expect(again.json().appliedOption).toBe("balanced");
        await undo(manager, turn.id);
        expect((await boardOf(bld())).plan).toEqual(start.plan);
      });

      it("gives a measure the figure of the card it came from, with its range and basis", async () => {
        const { plan } = await boardOf(bld());
        const card = plan.options.find((o: { id: string }) => o.id === "weekends")!;
        const adopted = (
          await as(manager, {
            method: "POST",
            url: `${bld()}/strategy-board/adopt`,
            payload: { option: "weekends" },
          })
        ).json();
        onTestFinished(async () => {
          await undo(manager, adopted.id);
        });
        const weekly = (saved: number) => (saved * 7) / plan.window.days;
        const { items, totals } = (await as(manager, { url: `${bld()}/measures` })).json();
        expect(totals.expectedWeeklyKwh).toBeCloseTo(weekly(plan.before.kwh - card.after.kwh), 0);
        expect(totals.expectedWeeklyLowKwh).toBeCloseTo(weekly(plan.before.kwh - card.low.kwh), 0);
        expect(totals.expectedWeeklyHighKwh).toBeCloseTo(weekly(plan.before.kwh - card.high.kwh), 0);
        expect(totals.expectedDays).toBe(plan.window.days);
        const active = items.filter((m: { status: string }) => m.status !== "cancelled");
        expect(active.length).toBeGreaterThan(0);
        for (const { verification: v } of active)
          expect(v.expected).toMatchObject({ days: plan.window.days, realisation: plan.realisation });
      });

      it("expects nothing of an on-site check, which switches nothing", async () => {
        const [finding] = await inOrg((tx) =>
          tx
            .select({ id: schema.findings.id })
            .from(schema.findings)
            .where(eq(schema.findings.status, "open"))
            .limit(1),
        );
        const measure = (
          await as(manager, {
            method: "POST",
            url: `${bld()}/findings/${finding!.id}/measure`,
            payload: { strategyId: "investigate_on_site", source: "manual" },
          })
        ).json().measure;
        onTestFinished(async () => {
          await as(manager, {
            method: "PATCH",
            url: `${bld()}/measures/${measure.id}`,
            payload: { status: "cancelled" },
          });
        });
        expect(measure.verification.weekly).toEqual({ kwh: 0, cost: 0 });
        expect(measure.verification.expected).toMatchObject({ lowKwh: 0, highKwh: 0 });
      });

      it("marks an answer from before the latest change, and says what applying it left out", async () => {
        const stale = await doneTurn();
        const read = async () => (await as(manager, { url: `${bld()}/assistant/turns/${stale.id}` })).json();
        expect((await read()).outdated).toBe(false);
        const adopted = (
          await as(manager, {
            method: "POST",
            url: `${bld()}/strategy-board/adopt`,
            payload: { option: "weekends" },
          })
        ).json();
        expect((await read()).outdated).toBe(true);

        const later = (await apply(manager, stale.id, "balanced")).json();
        const option = later.plan.options.find((o: { id: string }) => o.id === "balanced");
        expect(later.appliedMeasures.length).toBeLessThan(option.actions.length);
        expect(later.outdated).toBe(false);
        await undo(manager, stale.id);
        await undo(manager, adopted.id);
        // back to the measures it counted
        expect((await read()).outdated).toBe(false);
      });

      it("creates one measure when two people adopt at once", async () => {
        const start = await boardOf(bld());
        const adopt = () =>
          as(manager, {
            method: "POST",
            url: `${bld()}/strategy-board/adopt`,
            payload: { option: "weekends" },
          });
        const both = await Promise.all([adopt(), adopt()]);
        const turns = both.filter((r) => r.statusCode === 201).map((r) => r.json());
        expect(turns.length).toBeGreaterThan(0);
        const measures = (await boardOf(bld())).adopted.measures as unknown as {
          floorId: string;
          strategyId: string;
        }[];
        const keys = measures.map((m) => `${m.floorId}|${m.strategyId}`);
        expect(new Set(keys).size).toBe(keys.length);
        for (const turn of turns.reverse()) await undo(manager, turn.id);
        expect((await boardOf(bld())).plan).toEqual(start.plan);
      });

      it("plans the next option on top of the last, so asking again sees the building as it stands", async () => {
        const start = await boardOf(bld());
        const adopted = (
          await as(manager, {
            method: "POST",
            url: `${bld()}/strategy-board/adopt`,
            payload: { option: "weekends" },
          })
        ).json();
        const { plan } = await boardOf(bld());
        const option = start.plan.options.find((o) => o.id === "weekends")!;
        expect(plan.before.kwh).toBeCloseTo(option.after.kwh, 0);
        for (const o of plan.options) expect(o.after.kwh).toBeLessThan(plan.before.kwh);
        await undo(manager, adopted.id);
      });

      it("does not list an option as applied once its measures are cancelled", async () => {
        const turn = await doneTurn();
        const { appliedMeasures } = (await apply(manager, turn.id, "weekends")).json();
        expect((await boardOf(bld())).applied.map((a) => a.turnId)).toContain(turn.id);
        for (const { measureId } of appliedMeasures)
          await as(manager, {
            method: "PATCH",
            url: `${bld()}/measures/${measureId}`,
            payload: { status: "cancelled" },
          });
        const { applied } = await boardOf(bld());
        expect(applied.map((a) => a.turnId)).not.toContain(turn.id);
        await inSeeded((tx) =>
          tx
            .update(schema.assistantTurns)
            .set({ appliedOption: null, appliedAt: null, appliedBy: null, appliedMeasures: null })
            .where(eq(schema.assistantTurns.id, turn.id)),
        );
      });

      it("records a measure losing findings in that measure's own history", async () => {
        await outsideDemo();
        const start = await boardOf(bld());
        const turn = await doneTurn();
        const { floorId, strategyId } = start.plan.options.find((o) => o.id === "weekends")!.actions[0]!;
        const open = (
          await as(manager, { url: `${bld()}/findings?status=open&floorId=${floorId}&limit=200` })
        ).json().items as { id: string; dayType: string }[];
        const f = open.find((x) => x.dayType === "weekend" || x.dayType === "holiday")!;
        const own = (
          await as(manager, {
            method: "POST",
            url: `${bld()}/findings/${f.id}/measure`,
            payload: { strategyId, source: "manual", similar: false },
          })
        ).json().measure;
        await apply(manager, turn.id, "weekends");
        await undo(manager, turn.id);
        const rows = await inSeeded((tx) =>
          tx.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, own.id)),
        );
        expect(rows.map((r) => r.action)).toContain("measure.leave");
        await as(manager, {
          method: "PATCH",
          url: `${bld()}/measures/${own.id}`,
          payload: { status: "cancelled" },
        });
        expect((await boardOf(bld())).plan).toEqual(start.plan);
      });

      it("gives a reason the page can word, for what it can refuse", async () => {
        const turn = await doneTurn();
        expect((await apply(manager, turn.id, "community")).json().code).toBe("turn_no_option");
        const pending = await doneTurn({ status: "pending", plan: null });
        expect((await apply(manager, pending.id, "weekends")).json().code).toBe("turn_no_plan");
      });

      it("will not apply what is not there to apply", async () => {
        const turn = await doneTurn();
        expect((await apply(manager, turn.id, "community")).statusCode).toBe(422);
        const pending = await doneTurn({ status: "pending", plan: null });
        expect((await apply(manager, pending.id, "weekends")).statusCode).toBe(409);
        const gone = await apply(manager, "00000000-0000-4000-8000-000000000000", "weekends");
        expect(gone.statusCode).toBe(404);
        const bad = await apply(manager, turn.id, "tuesdays");
        expect(bad.statusCode).toBe(400);
      });

      it("joins a measure agreed since the plan was made, and undo leaves that measure as it was", async () => {
        await outsideDemo();
        const start = await boardOf(bld());
        const turn = await doneTurn();
        const option = start.plan.options.find((o) => o.id === "weekends")!;
        const { floorId, strategyId } = option.actions[0]!;
        const open = (
          await as(manager, { url: `${bld()}/findings?status=open&floorId=${floorId}&limit=200` })
        ).json().items as { id: string; ruleId: string; dayType: string }[];
        const f = open.find((x) => x.dayType === "weekend" || x.dayType === "holiday")!;
        const own = (
          await as(manager, {
            method: "POST",
            url: `${bld()}/findings/${f.id}/measure`,
            payload: { strategyId, source: "manual", similar: false },
          })
        ).json().measure;

        const { appliedMeasures } = (await apply(manager, turn.id, "weekends")).json();
        const joined = appliedMeasures.find((m: { measureId: string }) => m.measureId === own.id);
        expect(joined).toMatchObject({ joined: true, status: "planned" });
        expect(joined.linked).toBeGreaterThan(0);
        expect(appliedMeasures.filter((m: { joined: boolean }) => !m.joined)).toHaveLength(
          option.actions.length - 1,
        );

        await undo(manager, turn.id);
        const m = `${bld()}/measures/${own.id}`;
        expect((await as(manager, { url: m })).json()).toMatchObject({
          status: "planned",
          findings: { total: 1, acknowledged: 1 },
        });
        await as(manager, { method: "PATCH", url: m, payload: { status: "cancelled" } });
        expect((await boardOf(bld())).plan).toEqual(start.plan);
      });

      it("leaves measures planned outside a demo organisation, and adopts from the board", async () => {
        const start = await boardOf(towerBld());
        const adopted = await as(manager, {
          method: "POST",
          url: `${towerBld()}/strategy-board/adopt`,
          payload: { option: "weekdays", locale: "zh" },
        });
        expect(adopted.statusCode).toBe(201);
        const turn = adopted.json();
        expect(turn).toMatchObject({
          status: "done",
          locale: "zh",
          model: null,
          appliedOption: "weekdays",
          intent: { source: "board" },
        });
        expect(turn.prompt).toBe("采纳工作日优先");
        expect(turn.reply.options.map((o: { id: string }) => o.id)).toEqual(["weekdays"]);
        expect(new Set(turn.appliedMeasures.map((m: { status: string }) => m.status))).toEqual(
          new Set(["planned"]),
        );
        const board = await boardOf(towerBld());
        expect(board.applied[0]).toMatchObject({ turnId: turn.id, option: "weekdays" });
        expect(board.adopted.measures).toHaveLength(turn.appliedMeasures.length);

        const url = `${towerBld()}/assistant/turns/${turn.id}/undo`;
        expect((await as(manager, { method: "POST", url })).statusCode).toBe(200);
        expect((await boardOf(towerBld())).plan).toEqual(start.plan);
        expect(
          (
            await as(analyst, {
              method: "POST",
              url: `${towerBld()}/strategy-board/adopt`,
              payload: { option: "weekdays" },
            })
          ).statusCode,
        ).toBe(403);
      });
    });

    describe("between organisations", () => {
      it("keeps turns to their organisation", async () => {
        const turn = await doneTurn();
        // the same people belong to both, so only the organisation in the path differs
        const url = `${towerBld()}/assistant/turns/${turn.id}`;
        expect((await as(manager, { url })).statusCode).toBe(404);
        expect(
          (await as(manager, { method: "POST", url: `${url}/apply`, payload: { option: "weekends" } }))
            .statusCode,
        ).toBe(404);
        expect((await as(manager, { method: "POST", url: `${url}/undo` })).statusCode).toBe(404);
        const { items } = (await as(manager, { url: `${towerBld()}/assistant/turns` })).json();
        expect(items.map((t: { id: string }) => t.id)).not.toContain(turn.id);
        // another organisation's building is not found under this one
        expect(
          (await as(manager, { url: `${org()}/buildings/${tower.buildingId}/assistant/turns` })).statusCode,
        ).toBe(404);

        // and row-level security holds without the routes
        const seen = await withOrg(handle.db, tower.orgId, (tx) =>
          tx.select().from(schema.assistantTurns).where(eq(schema.assistantTurns.id, turn.id)),
        );
        expect(seen).toEqual([]);
        const touched = await withOrg(handle.db, tower.orgId, (tx) =>
          tx
            .update(schema.assistantTurns)
            .set({ prompt: "Hijacked" })
            .where(eq(schema.assistantTurns.id, turn.id))
            .returning(),
        );
        expect(touched).toEqual([]);
      });
    });

    describe("the community", () => {
      const publish = (url: string, payload: object, email = manager) =>
        as(email, { method: "POST", url: `${url}/community/strategies`, payload });
      const list = async (orgUrl: string, query = "", email = manager) =>
        (await as(email, { url: `${orgUrl}/community/strategies${query}` })).json().items as {
          id: string;
          uses: number;
          mine: boolean;
          publicDataset: boolean;
        }[];
      let shared: { id: string };

      it("does not publish from the shared demonstration, or for those who may not review", async () => {
        expect((await publish(bld(), { option: "weekends", alias: "Tower A" })).statusCode).toBe(403);
        expect(
          (await publish(towerBld(), { option: "weekends", alias: "Tower B" }, analyst)).statusCode,
        ).toBe(403);
        expect(await list(org())).toEqual([]);
      });

      it("publishes a mix and a result, and nothing about the floors or the people", async () => {
        const res = await publish(towerBld(), { option: "weekends", alias: "East wing" });
        expect(res.statusCode).toBe(201);
        shared = res.json();
        const { plan } = await boardOf(towerBld());
        const option = plan.options.find((o) => o.id === "weekends")!;
        expect(res.json()).toMatchObject({
          alias: "East wing",
          title: "Weekends first",
          locale: "en",
          optionKind: "weekends",
          floorsCount: 12,
          uses: 0,
          mine: true,
          publicDataset: false,
          result: {
            basis: "expected",
            days: plan.window.days,
            avoidableShareBefore: expect.closeTo(plan.before.avoidableShare, 3),
          },
        });
        expect(res.json().strategyMix).toEqual([
          { strategyId: "zone_only_non_working", floorShare: option.actions.length / 12 },
        ]);
        expect(res.json().summary).toMatch(/^Expected: avoidable share from /);
        expect(Object.keys(res.json()).sort()).toEqual(
          [
            "alias",
            "areaBand",
            "createdAt",
            "floorsCount",
            "id",
            "locale",
            "mine",
            "optionKind",
            "publicDataset",
            "result",
            "strategyMix",
            "summary",
            "title",
            "uses",
          ].sort(),
        );
        const text = res.body;
        expect(text).not.toMatch(/\bF\d+\b|Tower|Northwind/);
        for (const id of [tower.orgId, tower.buildingId, option.actions[0]!.floorId])
          expect(text).not.toContain(id);
      });

      it("takes the numbers and the language from the turn it came from", async () => {
        const adopted = (
          await as(manager, {
            method: "POST",
            url: `${towerBld()}/strategy-board/adopt`,
            payload: { option: "weekdays", locale: "zh" },
          })
        ).json();
        const res = await publish(towerBld(), {
          option: "weekdays",
          alias: "East wing",
          turnId: adopted.id,
          title: "夜里有人才开",
        });
        expect(res.statusCode).toBe(201);
        // planned, so nothing has been measured yet
        expect(res.json()).toMatchObject({
          title: "夜里有人才开",
          locale: "zh",
          result: { basis: "expected" },
        });
        expect(res.json().summary).toMatch(/^预计：可避免占比从 /);
        expect(res.json().result.avoidableShareAfter).toBeCloseTo(
          adopted.plan.options[0].after.avoidableShare,
          3,
        );
        await as(manager, {
          method: "DELETE",
          url: `${towerBld()}/community/strategies/${res.json().id}`,
        });
        await as(manager, { method: "POST", url: `${towerBld()}/assistant/turns/${adopted.id}/undo` });
        const stranger = await publish(towerBld(), {
          option: "weekdays",
          alias: "East wing",
          turnId: "00000000-0000-4000-8000-000000000000",
        });
        expect(stranger.statusCode).toBe(404);
      });

      it("reports what the data measured once a strategy has run, but never on a simulated building", async () => {
        const adopted = (
          await as(manager, {
            method: "POST",
            url: `${towerBld()}/strategy-board/adopt`,
            payload: { option: "weekdays" },
          })
        ).json();
        const ids = adopted.appliedMeasures.map((m: { measureId: string }) => m.measureId) as string[];
        for (const id of ids)
          await as(manager, {
            method: "PATCH",
            url: `${towerBld()}/measures/${id}`,
            payload: { status: "in_effect" },
          });
        const body = { option: "weekdays", alias: "East wing", turnId: adopted.id };
        const withdraw = (id: string) =>
          as(manager, { method: "DELETE", url: `${towerBld()}/community/strategies/${id}` });

        const tookEffect = (days: number) =>
          withOrg(handle.db, tower.orgId, (tx) =>
            tx
              .update(schema.measures)
              .set({ implementedAt: new Date(Date.now() - days * 86_400_000) })
              .where(inArray(schema.measures.id, ids)),
          );

        // it took effect a moment ago: no complete day since
        const fresh = (await publish(towerBld(), body)).json();
        expect(fresh.result.basis).toBe("expected");
        await withdraw(fresh.id);

        // a day or two is not what the month would look like
        await tookEffect(3);
        const early = (await publish(towerBld(), body)).json();
        expect(early.result.basis).toBe("expected");
        await withdraw(early.id);

        await tookEffect(14);
        const setPlan = (plan: string) =>
          handle.db
            .update(schema.organizations)
            .set({ plan })
            .where(eq(schema.organizations.id, tower.orgId));
        await setPlan("demo");
        const simulated = (await publish(towerBld(), body)).json();
        expect(simulated.result).toMatchObject({ basis: "expected", simulated: true });
        expect(simulated.publicDataset).toBe(false);
        await withdraw(simulated.id);
        await setPlan("standard");

        const measured = (await publish(towerBld(), body)).json();
        const { items } = (await as(manager, { url: `${towerBld()}/measures?status=in_effect` })).json();
        const chosen = items.filter((m: { id: string }) => ids.includes(m.id)) as {
          verification: { weekly: { kwh: number }; after: { days: number } };
        }[];
        const weekly = chosen.reduce((s, m) => s + m.verification.weekly.kwh, 0);
        const { before, window } = adopted.plan;
        expect(measured.summary).toMatch(/^Measured: /);
        expect(measured.result).toMatchObject({
          basis: "measured",
          days: Math.min(...chosen.map((m) => m.verification.after.days)),
          avoidableShareBefore: expect.closeTo(before.avoidableShare, 3),
          energyCutPct: expect.closeTo(((weekly / 7) * window.days * 100) / before.kwh, 1),
        });
        await withdraw(measured.id);
        await as(manager, { method: "POST", url: `${towerBld()}/assistant/turns/${adopted.id}/undo` });
      });

      it("keeps floors, tenants and claims out of what a publisher types", async () => {
        const [floor] = await withOrg(handle.db, tower.orgId, (tx) =>
          tx.select({ label: schema.floors.label }).from(schema.floors).limit(1),
        );
        const [lease] = await withOrg(handle.db, tower.orgId, (tx) =>
          tx.select({ name: schema.tenants.name }).from(schema.tenants).limit(1),
        );
        const [building] = await withOrg(handle.db, tower.orgId, (tx) =>
          tx.select({ name: schema.buildings.name }).from(schema.buildings).limit(1),
        );
        for (const body of [
          { alias: `${lease!.name}, Tower B` },
          { alias: `East wing ${floor!.label}` },
          { alias: "East wing", title: `${lease!.name} on weekends` },
          { alias: "East wing", title: `Quiet ${floor!.label}` },
          { alias: "East wing", title: `${building!.name} on weekends` },
          { alias: "East wing", title: "A 90% saving" },
          { alias: "East wing", title: "Saves half the energy" },
          { alias: "East wing", title: "Measured results" },
          // the same names, however they are spelled (the spellings themselves are tested in core)
          { alias: lease!.name.split(" ")[0]! },
          { alias: "floor 7 crew" },
        ]) {
          const res = await publish(towerBld(), { option: "weekdays", ...body });
          expect(res.statusCode).toBe(422);
          expect(res.json().code).toBe("community_identifies");
        }
      });

      it("shares each option once, until it is withdrawn", async () => {
        const again = await publish(towerBld(), { option: "weekends", alias: "Again" });
        expect(again.statusCode).toBe(409);
        expect(again.json().code).toBe("community_shared");
        expect((await publish(towerBld(), { option: "community", alias: "Mine" })).statusCode).toBe(422);
        expect((await publish(towerBld(), { option: "weekends", alias: "x" })).statusCode).toBe(400);
      });

      it("shows it to every organisation's members, and only its own as theirs", async () => {
        const theirs = (await list(org())).find((s) => s.id === shared.id);
        expect(theirs).toMatchObject({ mine: false });
        expect((await list(towerOrg())).find((s) => s.id === shared.id)).toMatchObject({ mine: true });
        // published per building, so a sibling building has it as anyone's, to use and not to withdraw
        const here = `?buildingId=${tower.buildingId}`;
        const sibling = "?buildingId=00000000-0000-4000-8000-000000000000";
        expect((await list(towerOrg(), here)).find((s) => s.id === shared.id)).toMatchObject({ mine: true });
        expect((await list(towerOrg(), sibling)).find((s) => s.id === shared.id)).toMatchObject({
          mine: false,
        });
        // tenants read it too, though they may not see the findings
        expect((await list(org(), "", tenant)).map((s) => s.id)).toContain(shared.id);
      });

      it("protects it from everyone but its publisher", async () => {
        const url = `${bld()}/community/strategies/${shared.id}`;
        expect((await as(manager, { method: "DELETE", url })).statusCode).toBe(404);
        const touched = await inSeeded((tx) =>
          tx
            .update(schema.communityStrategies)
            .set({ title: "Hijacked", uses: 1000 })
            .where(eq(schema.communityStrategies.id, shared.id))
            .returning(),
        );
        expect(touched).toEqual([]);
        const [row] = (await list(org())).filter((s) => s.id === shared.id);
        expect(row).toMatchObject({ title: "Weekends first", uses: 0 });
      });

      it("reads in the language asked for, publisher's or not, keeping only what was typed", async () => {
        const row = (await as(manager, { url: `${org()}/community/strategies?locale=zh` }))
          .json()
          .items.find((s: { id: string }) => s.id === shared.id);
        expect(row).toMatchObject({ title: "周末优先", locale: "zh" });
        expect(row.summary).toMatch(/^预计：/);
      });

      it("lets someone who only reads look at a strategy, and leaves no trace of them", async () => {
        const before = (await as(viewer, { url: `${bld()}/assistant/turns` })).json().items.length;
        const url = `${bld()}/community/strategies/${shared.id}`;
        const use = await as(viewer, { method: "POST", url: `${url}/use`, payload: { locale: "en" } });
        expect(use.statusCode).toBe(403);
        const look = await as(viewer, { url: `${url}/plan` });
        expect(look.statusCode).toBe(200);
        expect(look.json().plan.options.map((o: { id: string }) => o.id)).toEqual(["community"]);
        expect((await as(viewer, { url: `${bld()}/assistant/turns` })).json().items).toHaveLength(before);
        expect((await as(tenant, { url: `${url}/plan` })).statusCode).toBe(403);
      });

      it("does not plan a strategy on the building that published it", async () => {
        const url = `${towerBld()}/community/strategies/${shared.id}/use`;
        const res = await as(manager, { method: "POST", url, payload: { locale: "en" } });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("community_own");
      });

      it("plans a shared strategy on another building, without a model or the quota", async () => {
        const url = `${bld()}/community/strategies/${shared.id}/use`;
        const res = await as(analyst, { method: "POST", url, payload: { locale: "zh" } });
        expect(res.statusCode).toBe(201);
        const turn = (await as(viewer, { url: `${bld()}/assistant/turns/${res.json().turnId}` })).json();
        expect(turn).toMatchObject({ status: "done", model: null, locale: "zh" });
        expect(turn.prompt).toBe("使用 East wing 的“周末优先”");
        expect(turn.plan.options.map((o: { id: string }) => o.id)).toEqual(["community"]);
        const strategies = turn.plan.options[0].actions.map((a: { strategyId: string }) => a.strategyId);
        expect(new Set(strategies)).toEqual(new Set(["zone_only_non_working"]));
        expect(turn.reply.options[0]).toMatchObject({ id: "community", title: "共享策略" });
        const [stored] = await inSeeded((tx) =>
          tx
            .select({ promptVersion: schema.assistantTurns.promptVersion })
            .from(schema.assistantTurns)
            .where(eq(schema.assistantTurns.id, turn.id)),
        );
        expect(stored?.promptVersion).toBe("template");
        // a viewer has seen what it would do; acting on it is someone else's
        const apply = `${bld()}/assistant/turns/${turn.id}/apply`;
        const body = { option: "community" };
        expect((await as(viewer, { method: "POST", url: apply, payload: body })).statusCode).toBe(403);
        expect((await list(org())).find((s) => s.id === shared.id)?.uses).toBe(0);
      });

      it("counts a use once, when it is applied", async () => {
        const start = await boardOf(bld());
        const url = `${bld()}/community/strategies/${shared.id}/use`;
        const { turnId } = (await as(manager, { method: "POST", url, payload: { locale: "en" } })).json();
        const turn = `${bld()}/assistant/turns/${turnId}`;
        const body = { option: "community" };
        expect((await as(manager, { method: "POST", url: `${turn}/apply`, payload: body })).statusCode).toBe(
          200,
        );
        await as(manager, { method: "POST", url: `${turn}/apply`, payload: body });
        const uses = async () => (await list(org(), "?sort=used")).find((s) => s.id === shared.id)?.uses;
        expect(await uses()).toBe(1);
        await as(manager, { method: "POST", url: `${turn}/undo` });
        await as(manager, { method: "POST", url: `${turn}/apply`, payload: body });
        expect(await uses()).toBe(1);
        await as(manager, { method: "POST", url: `${turn}/undo` });
        expect((await boardOf(bld())).plan).toEqual(start.plan);

        // a fresh turn from the same organisation is the same organisation taking it up
        const second = (await as(manager, { method: "POST", url, payload: { locale: "en" } })).json();
        const next = `${bld()}/assistant/turns/${second.turnId}`;
        await as(manager, { method: "POST", url: `${next}/apply`, payload: body });
        expect(await uses()).toBe(1);
        await as(manager, { method: "POST", url: `${next}/undo` });
      });

      it("withdraws it from everyone, keeping it from being used", async () => {
        const url = `${towerBld()}/community/strategies/${shared.id}`;
        expect((await as(analyst, { method: "DELETE", url })).statusCode).toBe(403);
        expect((await as(manager, { method: "DELETE", url })).statusCode).toBe(204);
        expect((await as(manager, { method: "DELETE", url })).statusCode).toBe(404);
        expect((await list(towerOrg())).map((s) => s.id)).not.toContain(shared.id);
        expect((await list(org())).map((s) => s.id)).not.toContain(shared.id);
        const use = `${bld()}/community/strategies/${shared.id}/use`;
        expect((await as(manager, { method: "POST", url: use, payload: {} })).statusCode).toBe(404);
      });
    });

    describe("languages", () => {
      const ask = (locale?: string) =>
        as(analyst, {
          method: "POST",
          url: `${towerBld()}/briefs`,
          ...(locale ? { payload: { locale } } : {}),
        });
      const latest = async (query = "") =>
        (await as(analyst, { url: `${towerBld()}/briefs/latest${query}` })).json();

      it("asks for a brief per language and looks it up by language", async () => {
        const zh = (await ask("zh")).json().briefId;
        const en = (await ask("en")).json().briefId;
        expect(en).not.toBe(zh);
        expect((await ask("zh")).json().briefId).toBe(zh);
        expect((await latest("?locale=zh")).brief).toMatchObject({ id: zh, locale: "zh" });
        expect((await latest("?locale=en")).brief).toMatchObject({ id: en, locale: "en" });
        // no language given: the newest, as before
        expect((await latest()).brief).toMatchObject({ id: en });
        expect((await as(analyst, { url: `${towerBld()}/briefs/latest?locale=fr` })).statusCode).toBe(400);
      });

      it("says when a finished brief exists in the other language", async () => {
        expect(await latest("?locale=zh")).toMatchObject({ otherLocale: false });
        await withOrg(handle.db, tower.orgId, (tx) =>
          tx.update(schema.aiBriefs).set({ status: "done" }).where(eq(schema.aiBriefs.locale, "en")),
        );
        expect(await latest("?locale=zh")).toMatchObject({ otherLocale: true });
        expect(await latest("?locale=en")).toMatchObject({ otherLocale: false });
        expect(await latest()).toMatchObject({ otherLocale: false });
      });

      it("labels what was stored before by the language it is written in, not by who asked", async () => {
        const stored = (headline: string, locale: string) =>
          withOrg(handle.db, tower.orgId, async (tx) => {
            const [row] = await tx
              .insert(schema.aiBriefs)
              .values({
                orgId: tower.orgId,
                buildingId: tower.buildingId,
                locale,
                status: "done",
                promptVersion: "brief-v1",
                input: {},
                output: { headline, priorities: [], watch: [] },
              })
              .returning({ id: schema.aiBriefs.id });
            return row!.id;
          });
        const chinese = await stored("F10工作日连续7天空楼层仍在供冷", "en");
        const english = await stored("Biggest single loss: F10", "zh");
        const repair = readFileSync(
          new URL("../../../packages/db/drizzle/0012_ai_text_language.sql", import.meta.url),
          "utf8",
        );
        await withOrg(handle.db, tower.orgId, async (tx) => {
          for (const statement of repair.split("--> statement-breakpoint"))
            await tx.execute(sql.raw(statement));
        });
        const rows = await withOrg(handle.db, tower.orgId, (tx) =>
          tx
            .select({ id: schema.aiBriefs.id, locale: schema.aiBriefs.locale })
            .from(schema.aiBriefs)
            .where(inArray(schema.aiBriefs.id, [chinese, english])),
        );
        expect(new Map(rows.map((r) => [r.id, r.locale]))).toEqual(
          new Map([
            [chinese, "zh"],
            [english, "en"],
          ]),
        );
        await withOrg(handle.db, tower.orgId, (tx) =>
          tx.delete(schema.aiBriefs).where(inArray(schema.aiBriefs.id, [chinese, english])),
        );
      });

      it("defaults to English for a client that does not say", async () => {
        await withOrg(handle.db, tower.orgId, (tx) =>
          tx.update(schema.aiBriefs).set({ status: "done" }).where(eq(schema.aiBriefs.status, "pending")),
        );
        const { briefId } = (await ask()).json();
        expect((await latest("?locale=en")).brief).toMatchObject({ id: briefId, status: "pending" });
      });

      it("looks explanations up by language too", async () => {
        const f = (await as(analyst, { url: `${towerBld()}/findings?limit=1` })).json().items[0];
        const url = `${towerBld()}/findings/${f.id}`;
        const asked = await as(analyst, {
          method: "POST",
          url: `${url}/explanations`,
          payload: { locale: "zh" },
        });
        const { explanationId } = asked.json();
        const of = async (query: string) =>
          (await as(analyst, { url: `${url}${query}` })).json().explanations as {
            id: string;
            locale: string;
          }[];
        expect(await of("?locale=zh")).toMatchObject([{ id: explanationId, locale: "zh" }]);
        expect(await of("?locale=en")).toEqual([]);
        expect(await of("")).toHaveLength(1);
        const other = await as(analyst, {
          method: "POST",
          url: `${url}/explanations`,
          payload: { locale: "en" },
        });
        expect(other.json().explanationId).not.toBe(explanationId);
      });
    });

    describe("floor layouts", () => {
      it("shows a floor's layout and lets those who edit the building change it", async () => {
        const floors = (await as(manager, { url: `${bld()}/floors` })).json() as {
          id: string;
          layout: string;
        }[];
        expect(new Set(floors.map((f) => f.layout))).toEqual(new Set(["open_plan"]));
        const url = `${bld()}/floors/${floors[0]!.id}/layout`;
        const payload = { layout: "meeting_rooms" };
        expect((await as(analyst, { method: "PATCH", url, payload })).statusCode).toBe(403);
        expect((await as(manager, { method: "PATCH", url, payload })).statusCode).toBe(204);
        const now = (await as(analyst, { url: `${bld()}/floors` })).json() as typeof floors;
        expect(now.find((f) => f.id === floors[0]!.id)?.layout).toBe("meeting_rooms");
        expect(
          (await as(manager, { method: "PATCH", url, payload: { layout: "ballroom" } })).statusCode,
        ).toBe(400);
        const elsewhere = `${towerBld()}/floors/${floors[0]!.id}/layout`;
        expect((await as(manager, { method: "PATCH", url: elsewhere, payload })).statusCode).toBe(404);
      });
    });
  });
});
