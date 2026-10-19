/**
 * RT-655 — the pre-call input estimate must be conservative: text that
 * tokenizes denser than four characters per token (Arabic, emoji, UUIDs) must
 * not slip under a route's `maxInputTokens`.
 */
import { estimateInputTokens } from "../../src/ai/token-estimate";

function estimateFor(text: string): number {
  return estimateInputTokens({
    system: "",
    evidencePack: { items: [{ ref: "r", fields: { text } }] },
  });
}

describe("estimateInputTokens", () => {
  it("is at least one token per two UTF-8 bytes (ASCII)", () => {
    const text = "a".repeat(1000);
    expect(estimateFor(text)).toBeGreaterThanOrEqual(500);
  });

  it("counts multibyte text by bytes, not UTF-16 length (Arabic, emoji)", () => {
    const arabic = "م".repeat(1000); // 2 bytes each
    const emoji = "😀".repeat(500); // 4 bytes each
    expect(estimateFor(arabic)).toBeGreaterThan(estimateFor("a".repeat(1000)));
    expect(estimateFor(emoji)).toBeGreaterThan(estimateFor("a".repeat(500)));
    expect(estimateFor(arabic)).toBeGreaterThanOrEqual(1000);
  });

  it("includes the system text", () => {
    const withSystem = estimateInputTokens({
      system: "s".repeat(400),
      evidencePack: { items: [] },
    });
    const without = estimateInputTokens({ system: "", evidencePack: { items: [] } });
    expect(withSystem - without).toBeGreaterThanOrEqual(200);
  });
});
