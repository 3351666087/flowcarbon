import { zonedTime } from "@flowcarbon/core";
import { createDb, type DbHandle, schema, withOrg } from "@flowcarbon/db";
import { deviceIds, type SeedResult, seedDemo } from "@flowcarbon/demo";
import { createTestDatabase, type TestDatabase } from "@flowcarbon/demo/testing";
import type { JobQueue, RecomputePayload } from "@flowcarbon/jobs";
import { ingestTelemetry, loadBuildingContext } from "@flowcarbon/pipeline";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { briefInput, runBrief } from "../src/brief";
import { type ExplainDeps, PROMPT_VERSION, runExplain } from "../src/explain";
import { runNightly } from "../src/nightly";
import { runRecompute } from "../src/recompute";

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)("worker jobs", () => {
  let tdb: TestDatabase;
  let h: DbHandle;
  let seeded: SeedResult;

  beforeAll(async () => {
    tdb = await createTestDatabase(adminUrl!);
    h = createDb(tdb.appUrl, { max: 4 });
    seeded = await seedDemo(h.db, { startDate: "2026-09-15", days: 28, password: "worker-test-password" });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    await tdb?.drop();
  });

  const inOrg = <T>(fn: Parameters<typeof withOrg<T>>[2]) => withOrg(h.db, seeded.orgId, fn);

  it("processes pending batches once and marks them processed", async () => {
    const noop = await runRecompute(h.db, { orgId: seeded.orgId, buildingId: seeded.buildingId });
    expect(noop.batches).toBe(0);

    // a late correction: people were on F11 on the evening of 9 October
    await inOrg(async (tx) =>
      ingestTelemetry(tx, await loadBuildingContext(tx, seeded.orgId, seeded.buildingId), {
        idempotencyKey: "late-correction-1",
        batch: {
          readings: [],
          hvacEvents: [],
          lightingEvents: [],
          doorCounts: [
            {
              device: deviceIds("F11").door,
              start: new Date(zonedTime("2026-10-09", 20 * 60, "Asia/Shanghai")).toISOString(),
              entries: 6,
              exits: 0,
            },
          ],
        },
      }),
    );
    const r = await runRecompute(h.db, { orgId: seeded.orgId, buildingId: seeded.buildingId });
    expect(r.batches).toBe(1);
    expect(r.spans).toEqual([{ fromDate: "2026-10-09", toDateExclusive: "2026-10-11" }]);
    expect(r.days).toBe(2);
    const pending = await inOrg((tx) =>
      tx.select().from(schema.ingestionBatches).where(isNull(schema.ingestionBatches.processedAt)),
    );
    expect(pending).toEqual([]);
  });

  describe("explanations", () => {
    async function pendingExplanation() {
      return inOrg(async (tx) => {
        const [f] = await tx.select().from(schema.findings).limit(1);
        const [e] = await tx
          .insert(schema.aiExplanations)
          .values({ orgId: seeded.orgId, findingId: f!.id, promptVersion: "pending", input: {} })
          .returning();
        return e!.id;
      });
    }
    // streams the response text in small pieces, as the API does; `during` runs once it has all been sent
    const fakeClient = (
      response: { stop_reason: string; text?: string },
      seen?: unknown[],
      during?: () => Promise<void>,
    ) =>
      ({
        beta: {
          messages: {
            stream: (params: unknown) => {
              seen?.push(params);
              const listeners: ((delta: string, snapshot: string) => void)[] = [];
              return {
                on(event: string, listener: (delta: string, snapshot: string) => void) {
                  if (event === "text") listeners.push(listener);
                  return this;
                },
                async finalMessage() {
                  const text = response.text ?? "";
                  let snapshot = "";
                  for (let i = 0; i < text.length; i += 40) {
                    snapshot += text.slice(i, i + 40);
                    for (const listener of listeners) listener(text.slice(i, i + 40), snapshot);
                  }
                  await during?.();
                  return {
                    model: "claude-opus-5-5",
                    usage: { input_tokens: 1200, output_tokens: 180 },
                    stop_reason: response.stop_reason,
                    content: text ? [{ type: "text", text }] : [],
                  };
                },
              };
            },
          },
        },
      }) as unknown as ExplainDeps["client"];
    const output = {
      whatHappened: "F12 was cooled for 3 h after everyone had left.",
      likelyCauses: ["Fixed BMS schedule until 20:00"],
      outlook: "A median of 12 people is expected after 18:00 on workdays.",
      recommendedAction: {
        strategyId: "occupancy_gated_workday",
        reason: "Cooling would stop 30 min after the floor empties.",
      },
      basis: ["gb-50189-2015", "flowcarbon-rule-rationale", "gb-50189-2015"],
      uncertainties: ["HVAC energy is estimated from rated power."],
    };

    it("stores a structured explanation with checked citations", async () => {
      const id = await pendingExplanation();
      const seen: unknown[] = [];
      const text = JSON.stringify(output);
      // what the page sees while the answer is still arriving
      let draft: string | null = null;
      const readDraft = async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const [row] = await inOrg((tx) =>
          tx.select().from(schema.aiExplanations).where(eq(schema.aiExplanations.id, id)),
        );
        draft = row!.draft;
      };
      const r = await runExplain(
        {
          db: h.db,
          client: fakeClient({ stop_reason: "end_turn", text }, seen, readDraft),
          model: "claude-opus-5-5",
          effort: "medium",
        },
        { orgId: seeded.orgId, explanationId: id },
      );
      expect(r).toBe("done");
      const [row] = await inOrg((tx) =>
        tx.select().from(schema.aiExplanations).where(eq(schema.aiExplanations.id, id)),
      );
      expect(draft).toBeTruthy();
      expect(text.startsWith(draft!)).toBe(true);
      expect(row).toMatchObject({
        status: "done",
        model: "claude-opus-5-5",
        promptVersion: PROMPT_VERSION,
        draft: null,
        inputTokens: 1200,
        outputTokens: 180,
      });
      const basis = (row!.output as { basis: { id: string; title: string }[] }).basis;
      expect(basis.map((b) => b.id)).toEqual(["gb-50189-2015", "flowcarbon-rule-rationale"]);
      expect(basis[0]!.title).toContain("GB 50189");
      const params = seen[0] as {
        model: string;
        fallbacks: string;
        betas: string[];
        output_config: { effort: string };
      };
      expect(params).toMatchObject({
        model: "claude-opus-5-5",
        fallbacks: "default",
        betas: ["server-side-fallback-2026-07-01"],
      });
      expect(params.output_config.effort).toBe("medium");
      // running the job again does nothing
      expect(
        await runExplain(
          {
            db: h.db,
            client: fakeClient({ stop_reason: "end_turn", text }),
            model: "m",
            effort: "medium",
          },
          { orgId: seeded.orgId, explanationId: id },
        ),
      ).toBe("skipped");
    });

    describe("building briefs", () => {
      // the seeded window ends on 13 October; look at the two weeks before it
      const now = Date.parse("2026-10-13T04:00:00Z");
      const pendingBrief = () =>
        inOrg(async (tx) => {
          const [b] = await tx
            .insert(schema.aiBriefs)
            .values({
              orgId: seeded.orgId,
              buildingId: seeded.buildingId,
              promptVersion: "pending",
              input: {},
            })
            .returning();
          return b!.id;
        });

      it("ranks groups of open findings and keeps only groups it was given", async () => {
        const id = await pendingBrief();
        const data = await briefInput(h.db, seeded.orgId, id, now);
        const [top] = data!.groups;
        expect(top!.count).toBeGreaterThan(0);
        const output = {
          headline: "One floor wastes most.",
          priorities: [
            {
              floor: top!.floor,
              ruleId: top!.ruleId,
              strategyId: "investigate_on_site",
              why: "Largest group.",
            },
            {
              floor: "F99",
              ruleId: "hvac_empty_floor",
              strategyId: "auto_lights_off",
              why: "No such floor.",
            },
            { floor: top!.floor, ruleId: top!.ruleId, strategyId: "no_action", why: "Said twice." },
          ],
          watch: ["Nothing in effect yet."],
        };
        const seen: unknown[] = [];
        const r = await runBrief(
          {
            db: h.db,
            client: fakeClient({ stop_reason: "end_turn", text: JSON.stringify(output) }, seen),
            model: "claude-opus-5-5",
            effort: "medium",
          },
          { orgId: seeded.orgId, briefId: id },
          now,
        );
        expect(r).toBe("done");
        const [row] = await inOrg((tx) =>
          tx.select().from(schema.aiBriefs).where(eq(schema.aiBriefs.id, id)),
        );
        const out = row!.output as { priorities: Record<string, unknown>[]; watch: string[] };
        expect(out.priorities).toEqual([
          expect.objectContaining({
            floor: top!.floor,
            ruleId: top!.ruleId,
            strategyId: "investigate_on_site",
            floorId: top!.floorId,
            findings: top!.count,
            findingId: top!.latest.id,
          }),
        ]);
        expect(out.watch).toEqual(["Nothing in effect yet."]);
        expect(row).toMatchObject({ status: "done", draft: null, inputTokens: 1200 });
        expect(seen).toHaveLength(1);
      });

      it("answers without the model when nothing is open", async () => {
        const id = await pendingBrief();
        const r = await runBrief(
          { db: h.db, client: null, model: "m", effort: "medium" },
          { orgId: seeded.orgId, briefId: id },
          // before the seeded data begins
          Date.parse("2026-08-01T00:00:00Z"),
        );
        expect(r).toBe("done");
        const [row] = await inOrg((tx) =>
          tx.select().from(schema.aiBriefs).where(eq(schema.aiBriefs.id, id)),
        );
        expect((row!.output as { priorities: unknown[] }).priorities).toEqual([]);
      });
    });

    it("records refusals and missing configuration as failures", async () => {
      const refused = await pendingExplanation();
      expect(
        await runExplain(
          {
            db: h.db,
            client: fakeClient({ stop_reason: "refusal" }),
            model: "m",
            effort: "medium",
          },
          { orgId: seeded.orgId, explanationId: refused },
        ),
      ).toBe("failed");
      const malformed = await pendingExplanation();
      expect(
        await runExplain(
          {
            db: h.db,
            client: fakeClient({ stop_reason: "end_turn", text: '{"whatHappened": "F12 was' }),
            model: "m",
            effort: "medium",
          },
          { orgId: seeded.orgId, explanationId: malformed },
        ),
      ).toBe("failed");
      const unconfigured = await pendingExplanation();
      expect(
        await runExplain(
          { db: h.db, client: null, model: "m", effort: "medium" },
          { orgId: seeded.orgId, explanationId: unconfigured },
        ),
      ).toBe("failed");
      const rows = await inOrg((tx) =>
        tx.select().from(schema.aiExplanations).where(eq(schema.aiExplanations.status, "failed")),
      );
      expect(rows.map((r) => r.error)).toEqual(
        expect.arrayContaining([
          "The AI service declined to explain this finding.",
          "The AI response did not match the expected structure.",
          "AI explanations are not configured for this deployment.",
        ]),
      );
    });
  });

  it("schedules each building in its nightly local hour", async () => {
    const sent: RecomputePayload[] = [];
    const jobs: JobQueue = {
      recompute: async (p) => {
        sent.push(p);
        return "id";
      },
      explain: async () => null,
      demo: async () => null,
      brief: async () => null,
    };
    // 03:10 local in Shanghai: not due
    expect(
      (await runNightly(h.db, jobs, { localHour: 4, now: zonedTime("2026-10-14", 190, "Asia/Shanghai") }))
        .scheduled,
    ).toBe(0);
    const r = await runNightly(h.db, jobs, {
      localHour: 4,
      now: zonedTime("2026-10-14", 250, "Asia/Shanghai"),
    });
    expect(r.scheduled).toBe(1);
    expect(sent).toEqual([{ orgId: seeded.orgId, buildingId: seeded.buildingId }]);
    const [marker] = await inOrg((tx) =>
      tx
        .select()
        .from(schema.ingestionBatches)
        .where(eq(schema.ingestionBatches.idempotencyKey, `nightly-${seeded.buildingId}-2026-10-13`)),
    );
    expect(marker?.processedAt).toBeNull();
  });
});
