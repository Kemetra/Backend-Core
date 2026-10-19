/**
 * RT-648 — deterministic synthetic identifiers for the E1 dataset.
 *
 * Tenant T-A has store A1 (`Africa/Cairo`) and A2 (default `UTC`); tenant T-B
 * has store B1 (RT-647 §6.1). All ids are fixed literals or pure functions of
 * a case number, so the dataset hash never depends on a clock or a PRNG.
 */
const PREFIX = "0191e100-0000-7000-8000";

function id(tail: string): string {
  return `${PREFIX}-${tail.padStart(12, "0")}`;
}

export const TENANT_A = id("a0");
export const TENANT_B = id("b0");
export const STORE_A1 = id("a1");
export const STORE_A2 = id("a2");
export const STORE_B1 = id("b1");
export const USER_A = id("c1");

export const TENANT_B_NAME = "Rahma Pharmacy Group B";
export const STORE_B1_NAME = "Branch B1 Nasr City";

export const STORE_TIMEZONE: Readonly<Record<"A1" | "A2", string>> = {
  A1: "Africa/Cairo",
  A2: "UTC",
};

export function storeId(store: "A1" | "A2"): string {
  return store === "A1" ? STORE_A1 : STORE_A2;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

export const saleRefOf = (n: number): string => id(`1000${hex2(n)}`);
export const postingStatusIdOf = (n: number): string => id(`2000${hex2(n)}`);
export const lineRefOf = (n: number): string => id(`3000${hex2(n)}`);
export const returnRefOf = (n: number): string => id(`4000${hex2(n)}`);
export const deviceRefOf = (n: number): string => id(`5000${hex2(n)}`);
export const packIdOf = (n: number, lang: "en" | "ar"): string =>
  id(`${lang === "en" ? "6" : "7"}000${hex2(n)}`);

/** A sale of tenant B: a cross-tenant probe supplies its ref as the path value. */
export const TENANT_B_SALE_REF = id("1000ff");
