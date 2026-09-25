import { createHash } from "node:crypto";

import { bodyFingerprint, composeTuple } from "../../src/idempotency/idempotency.interceptor";
import { canonicalJson } from "../../src/idempotency/canonical-json";

describe("#614 canonical idempotency fingerprint", () => {
  it("hashes reordered object keys to the same fingerprint", () => {
    const left = bodyFingerprint({ a: 1, b: { d: 2, c: 3 } });
    const right = bodyFingerprint({ b: { c: 3, d: 2 }, a: 1 });
    expect(left.equals(right)).toBe(true);
  });

  it("does not treat different values as the same object", () => {
    expect(bodyFingerprint({ a: 1 }).equals(bodyFingerprint({ a: 2 }))).toBe(false);
  });

  it("omits undefined object values the way JSON.stringify does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("keeps array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});

describe("#614 in-flight tuple includes tenant", () => {
  it("differs across tenants for the same key", () => {
    const a = composeTuple("tenant-a", "POST:/sales:client:key-1");
    const b = composeTuple("tenant-b", "POST:/sales:client:key-1");
    expect(a).not.toBe(b);
    expect(a.startsWith("tenant-a:")).toBe(true);
  });

  it("is stable for the same inputs", () => {
    const once = composeTuple("tenant-a", "POST:/sales:client:key-1");
    const twice = composeTuple("tenant-a", "POST:/sales:client:key-1");
    expect(once).toBe(twice);
    expect(createHash("sha256").update(once).digest("hex")).toHaveLength(64);
  });
});
