import type { paths } from "./api-types";

/** the JSON body of a successful response of an API operation */
type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer T } } };
}
  ? T
  : paths[P][M] extends { responses: { 201: { content: { "application/json": infer T } } } }
    ? T
    : never;

export type FindingDetail = Ok<"/api/v1/orgs/{orgId}/buildings/{buildingId}/findings/{findingId}", "get">;
export type MeasureDetail = Ok<"/api/v1/orgs/{orgId}/buildings/{buildingId}/measures/{measureId}", "get">;
export type Measure = NonNullable<FindingDetail["measureDetail"]>;
export type Verification = Measure["verification"];

export type AssistantTurn = Ok<"/api/v1/orgs/{orgId}/buildings/{buildingId}/assistant/turns/{turnId}", "get">;
export type TurnPlan = NonNullable<AssistantTurn["plan"]>;
export type TurnOption = TurnPlan["options"][number];
export type StrategyBoard = Ok<"/api/v1/orgs/{orgId}/buildings/{buildingId}/strategy-board", "get">;
export type CommunityStrategy = Ok<"/api/v1/orgs/{orgId}/community/strategies", "get">["items"][number];
