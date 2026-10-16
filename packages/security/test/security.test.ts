import { describe, expect, it } from "vitest";
import {
  hashPassword,
  looksLikeApiKey,
  needsRehash,
  newApiKey,
  passwordProblems,
  sha256,
  verifyPassword,
} from "../src";

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery stapl")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=4096,t=3,p=1$abc$def")).toBe(true);
  });

  it("applies a length rule and rejects obvious passwords", () => {
    expect(passwordProblems("short")).toHaveLength(1);
    expect(passwordProblems("password1234")).toContain("This password is too common.");
    expect(passwordProblems("manager-secret-2026", { email: "manager@example.com" })).toHaveLength(1);
    expect(passwordProblems("a long enough passphrase")).toEqual([]);
  });
});

describe("api keys", () => {
  it("are random, prefixed and stored only as a hash", () => {
    const a = newApiKey();
    const b = newApiKey();
    expect(a.key).not.toBe(b.key);
    expect(looksLikeApiKey(a.key)).toBe(true);
    expect(a.hash).toBe(sha256(a.key));
    expect(a.key.startsWith(a.prefix)).toBe(true);
  });
});
