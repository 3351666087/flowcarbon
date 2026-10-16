import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id with the OWASP Password Storage Cheat Sheet baseline (m = 19 MiB, t = 2, p = 1).
 * `Algorithm` is a const enum in the typings, so the numeric value is used (2 = Argon2id).
 */
export const PASSWORD_PARAMS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

// a short deny-list of passwords that pass the length rule but appear at the top of breach corpora
const COMMON = new Set([
  "password1234",
  "123456789012",
  "qwertyuiop12",
  "passwordpassword",
  "iloveyou1234",
  "administrator",
  "flowcarbon123",
]);

/** Returns the problems with a proposed password; empty when acceptable (NIST SP 800-63B style: length, no composition rules). */
export function passwordProblems(password: string, context: { email?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) problems.push("This password is too common.");
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local))
    problems.push("Do not include your email name in the password.");
  return problems;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_PARAMS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** True when the stored hash uses weaker parameters than the current ones and should be replaced at next sign-in. */
export function needsRehash(stored: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
  if (!m) return true;
  return Number(m[1]) < PASSWORD_PARAMS.memoryCost || Number(m[2]) < PASSWORD_PARAMS.timeCost;
}

/**
 * A fixed hash to verify against when the account does not exist, so sign-in takes the same time either way
 * and does not reveal which emails are registered.
 */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomToken(16));
  return dummyHash;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const API_KEY_PREFIX = "fck_";

export interface NewApiKey {
  /** shown to the user once, never stored */
  key: string;
  /** stored and displayed to identify the key */
  prefix: string;
  /** stored; lookups hash the presented key and compare */
  hash: string;
}

/** API keys are 256-bit random secrets; a fast hash is sufficient because they are not guessable. */
export function newApiKey(): NewApiKey {
  const key = `${API_KEY_PREFIX}${randomToken(32)}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 6), hash: sha256(key) };
}

export function looksLikeApiKey(value: string): boolean {
  return (
    value.startsWith(API_KEY_PREFIX) && value.length >= API_KEY_PREFIX.length + 40 && value.length <= 128
  );
}

export const API_KEY_SCOPES = ["telemetry:write", "read", "overtime:write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
