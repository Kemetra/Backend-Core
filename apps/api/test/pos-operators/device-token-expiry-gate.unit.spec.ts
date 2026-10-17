/** RT-370 — the `DEVICE_TOKEN_EXPIRY_ENFORCED` gate: off unless explicitly on. */
import { isDeviceTokenExpiryEnforced } from "../../src/pos-operators/device-token-expiry-gate";

describe("isDeviceTokenExpiryEnforced (RT-370)", () => {
  const FLAG = "DEVICE_TOKEN_EXPIRY_ENFORCED";
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it("is off when unset (the default)", () => {
    delete process.env[FLAG];
    expect(isDeviceTokenExpiryEnforced()).toBe(false);
  });

  it.each(["1", "true", "yes", " TRUE ", "Yes"])("is on for %p", (value) => {
    process.env[FLAG] = value;
    expect(isDeviceTokenExpiryEnforced()).toBe(true);
  });

  it.each(["", "0", "false", "no", "off", "enabled", "on"])("is off for %p", (value) => {
    process.env[FLAG] = value;
    expect(isDeviceTokenExpiryEnforced()).toBe(false);
  });

  it("is read per call (a deploy flips it without a code change)", () => {
    process.env[FLAG] = "true";
    expect(isDeviceTokenExpiryEnforced()).toBe(true);
    process.env[FLAG] = "false";
    expect(isDeviceTokenExpiryEnforced()).toBe(false);
  });
});
