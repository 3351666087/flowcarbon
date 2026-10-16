import createClient from "openapi-fetch";
import type { components, paths } from "./api-types";

/** Same-origin client: requests go through the Next.js rewrite, so the session cookie is first-party. */
export const api = createClient<paths>({ baseUrl: "", credentials: "include" });

export interface Problem {
  status: number;
  title?: string;
  detail?: string;
  code?: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string;
  constructor(p: Problem) {
    super(p.detail ?? p.title ?? `Request failed (${p.status})`);
    this.status = p.status;
    this.code = p.code ?? "error";
    this.details = p.details;
    this.requestId = p.requestId;
  }
  /** Human-readable list of problems returned with a 4xx response. */
  get problems(): string[] {
    if (Array.isArray(this.details))
      return this.details.map((d) =>
        typeof d === "string"
          ? d
          : `${(d as { path?: string }).path ?? ""} ${(d as { message?: string }).message ?? ""}`.trim(),
      );
    return [];
  }
}

/** Unwraps an openapi-fetch result, throwing ApiError for any non-2xx answer. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (!response.ok) {
    const e = (error ?? {}) as Partial<Problem>;
    throw new ApiError({ ...e, status: response.status });
  }
  return data as T;
}

export type Schemas = components extends { schemas: infer S } ? S : never;
