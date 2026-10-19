/**
 * RT-648 — the question matchers of `E1-BL v1`: rule R-G1 (the question asks for
 * an action) and rule R-G5 (a tenant-level health or currency question). Fixed
 * EN/AR keyword lists, versioned with the dataset. Arabic is matched after
 * stripping diacritics and folding alef variants.
 */
const DIACRITICS = /[\u064B-\u065F\u0670]/g;
const ALEF_VARIANTS = /[\u0623\u0625\u0622]/g;
const ALEF = "\u0627";

function normalize(question: string): string {
  return question.normalize("NFKC").toLowerCase().replace(DIACRITICS, "").replace(ALEF_VARIANTS, ALEF);
}

const ACTION_EN: readonly RegExp[] = [
  /\b(repair|retry|re-?try|void|edit)\b/,
  /\bre-?post\b/,
  /\bmark (it |this |as )?(as )?posted\b/,
  /\bsync now\b/,
  /\bre-?sync\b/,
];
const ACTION_AR = [
  "اعد المحاولة", "اعادة المحاولة", "اصلح", "اصلاح", "الغاء", "تعديل", "حدد العملية", "كمرحلة", "مزامنة الان",
];
const HEALTH_EN = /\b(healthy|up[- ]to[- ]date|connector (ok|health)|all good)\b/;
const HEALTH_AR = ["سليم", "محدث", "يعمل بشكل صحيح", "بخير"];

export function matchesActionRequest(question: string): boolean {
  const normalized = normalize(question);
  return ACTION_EN.some((pattern) => pattern.test(normalized)) || ACTION_AR.some((word) => normalized.includes(word));
}

export function matchesHealthQuestion(question: string): boolean {
  const normalized = normalize(question);
  return HEALTH_EN.test(normalized) || HEALTH_AR.some((word) => normalized.includes(word));
}
