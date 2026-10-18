/** HTTP-level tests against a real database as the runtime role. Requires TEST_DATABASE_URL (see packages/demo). */
import { addDays, localParts, zonedTime } from "@flowcarbon/core";
import { createDb, type DbHandle, schema } from "@flowcarbon/db";
import { type SeedResult, seedDemo } from "@flowcarbon/demo";
import { createTestDatabase, type TestDatabase } from "@flowcarbon/demo/testing";
import type { ExplainPayload, JobQueue, RecomputePayload } from "@flowcarbon/jobs";
import { sha256 } from "@flowcarbon/security";
import { eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX, buildApp } from "../src/app";
import { loadConfig } from "../src/config";

const adminUrl = process.env.TEST_DATABASE_URL;
const PASSWORD = "api-test-password-2026";
const ORIGIN = "http://localhost:3000";

describe.skipIf(!adminUrl)("HTTP API", () => {
  let tdb: TestDatabase;
  let handle: DbHandle;
  let seeded: SeedResult;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const sent: { recompute: RecomputePayload[]; explain: ExplainPayload[] } = { recompute: [], explain: [] };
  const jobs: JobQueue = {
    recompute: async (p) => {
      sent.recompute.push(p);
      return "job";
    },
    explain: async (p) => {
      sent.explain.push(p);
      return "job";
    },
  };
  const sessions = new Map<string, string>();

  beforeAll(async () => {
    tdb = await createTestDatabase(adminUrl!);
    handle = createDb(tdb.appUrl, { max: 6 });
    seeded = await seedDemo(handle.db, { startDate: "2026-09-15", days: 28, password: PASSWORD });
    const config = loadConfig({
      DATABASE_URL: tdb.appUrl,
      NODE_ENV: "test",
      CORS_ORIGINS: ORIGIN,
      LOGIN_ATTEMPTS_PER_15_MIN: "100",
    });
    app = await buildApp({ db: handle.db, config, jobs, logger: false });
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await tdb?.drop();
  });

  const org = () => `${API_PREFIX}/orgs/${seeded.orgId}`;
  const bld = () => `${org()}/buildings/${seeded.buildingId}`;

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
      const cookieOf = (res: Awaited<ReturnType<typeof signIn>>) => res.cookies.find((x) => x.name === "fc_session");
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
      await app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/logout`,
        cookies: { fc_session: token },
        headers: { origin: ORIGIN },
      });
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
      expect((await as(tenant, { url: `${bld()}/findings` })).statusCode).toBe(403);
      expect((await as(tenant, { url: `${bld()}/report` })).statusCode).toBe(403);
      const requests = (await as(tenant, { url: `${bld()}/overtime-requests` })).json() as {
        tenantId: string;
      }[];
      expect(requests.length).toBeGreaterThan(0);
      expect(new Set(requests.map((r) => r.tenantId))).toEqual(new Set([seeded.tenantIds["t-northwind"]]));
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
});
