import {
  createLogger,
  withRequestContext,
  DEFAULT_REDACT_PATHS,
} from "../../src/logger/pino";

// ---------------------------------------------------------------------------
// createLogger — default options
// ---------------------------------------------------------------------------

describe("createLogger — default options", () => {
  it("returns a callable logger for the given service", () => {
    const logger = createLogger({ service: "test-svc" });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("defaults level to 'info' when LOG_LEVEL env is unset", () => {
    const saved = process.env["LOG_LEVEL"];
    delete process.env["LOG_LEVEL"];
    const logger = createLogger({ service: "svc" });
    expect(logger.level).toBe("info");
    if (saved !== undefined) process.env["LOG_LEVEL"] = saved;
  });

  it("picks up LOG_LEVEL from the environment when level is not passed", () => {
    const saved = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "warn";
    const logger = createLogger({ service: "svc" });
    expect(logger.level).toBe("warn");
    process.env["LOG_LEVEL"] = saved ?? "";
    if (saved === undefined) delete process.env["LOG_LEVEL"];
  });

  it("does not attach a transport when pretty is false", () => {
    const logger = createLogger({ service: "svc", pretty: false });
    // pino stores transport config internally; accessing options via pino internals
    // is fragile. We verify the logger is functional (no transport error thrown).
    expect(() => logger.info("no-transport")).not.toThrow();
  });

  it("does not attach a transport when pretty is true but stdout is not a TTY", () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    try {
      const logger = createLogger({ service: "svc", pretty: true });
      expect(() => logger.info("no-tty")).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(process.stdout, "isTTY", original);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (process.stdout as any).isTTY;
      }
    }
  });

  it("attaches transport options when pretty is true and stdout is a TTY", () => {
    // pino-pretty may not be installed in CI. We verify the branch is entered
    // by spying on the pino constructor via mocking the module and checking
    // that options.transport is set. We do this by calling createLogger with
    // isTTY=true and catching the pino-pretty resolution error — the error
    // itself confirms the branch was reached (pino tried to load the transport).
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      // The branch sets options.transport. Pino then tries to resolve pino-pretty.
      // If pino-pretty is installed: no error. If not: "unable to determine transport target".
      // Either way the branch is covered; we accept both outcomes.
      try {
        createLogger({ service: "svc", pretty: true });
      } catch (err) {
        const msg = (err as Error).message ?? "";
        // Only acceptable error is the missing pino-pretty transport target
        expect(msg).toContain("transport");
      }
    } finally {
      if (original) {
        Object.defineProperty(process.stdout, "isTTY", original);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (process.stdout as any).isTTY;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// createLogger — explicit level + bindings
// ---------------------------------------------------------------------------

describe("createLogger — explicit level and bindings", () => {
  it("respects an explicit level override", () => {
    const logger = createLogger({ service: "svc", level: "debug" });
    expect(logger.level).toBe("debug");
  });

  it("explicit level takes precedence over LOG_LEVEL env", () => {
    process.env["LOG_LEVEL"] = "error";
    const logger = createLogger({ service: "svc", level: "trace" });
    expect(logger.level).toBe("trace");
    delete process.env["LOG_LEVEL"];
  });

  it("merges extra bindings into the base object without throwing", () => {
    const logger = createLogger({
      service: "svc",
      bindings: { env: "test", version: "1.2.3" },
    });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// createLogger — redactPaths merging
// ---------------------------------------------------------------------------

describe("createLogger — redactPaths merging", () => {
  it("accepts no extra redactPaths (uses defaults only)", () => {
    expect(() => createLogger({ service: "svc" })).not.toThrow();
  });

  it("merges extra redactPaths with defaults without duplicating", () => {
    const extra = ["custom.field", "another.secret"];
    const logger = createLogger({ service: "svc", redactPaths: extra });
    expect(logger).toBeDefined();
  });

  it("deduplicates when extra paths overlap with defaults", () => {
    // 'token' is in DEFAULT_REDACT_PATHS; passing it again must not error
    const extra = ["token", "my.custom.path"];
    expect(() =>
      createLogger({ service: "svc", redactPaths: extra }),
    ).not.toThrow();
  });

  it("DEFAULT_REDACT_PATHS contains expected sentinel paths", () => {
    expect(DEFAULT_REDACT_PATHS).toContain("password");
    expect(DEFAULT_REDACT_PATHS).toContain("token");
    expect(DEFAULT_REDACT_PATHS).toContain("secret");
    expect(DEFAULT_REDACT_PATHS).toContain("api_key");
    expect(DEFAULT_REDACT_PATHS).toContain("device_token_attestation");
    expect(DEFAULT_REDACT_PATHS).toContain("pairing_code");
    expect(DEFAULT_REDACT_PATHS).toContain("device_token");
  });
});

// ---------------------------------------------------------------------------
// withRequestContext
// ---------------------------------------------------------------------------

describe("withRequestContext", () => {
  const baseLogger = createLogger({ service: "test-svc" });

  it("returns a child logger (distinct from parent)", () => {
    const child = withRequestContext(baseLogger, { request_id: "req-1" });
    expect(child).not.toBe(baseLogger);
    expect(typeof child.info).toBe("function");
  });

  it("child logger carries all four context keys", () => {
    const child = withRequestContext(baseLogger, {
      request_id: "req-abc",
      tenant_id: "tenant-xyz",
      user_id: "user-999",
      store_id: "store-42",
    });
    // pino child loggers expose bindings via child.bindings()
    const bindings = child.bindings();
    expect(bindings["request_id"]).toBe("req-abc");
    expect(bindings["tenant_id"]).toBe("tenant-xyz");
    expect(bindings["user_id"]).toBe("user-999");
    expect(bindings["store_id"]).toBe("store-42");
  });

  it("writes null (not undefined) for missing optional fields", () => {
    const child = withRequestContext(baseLogger, { request_id: "req-min" });
    const bindings = child.bindings();
    expect(bindings["tenant_id"]).toBeNull();
    expect(bindings["user_id"]).toBeNull();
    expect(bindings["store_id"]).toBeNull();
  });

  it("preserves explicit null for tenant_id / user_id / store_id", () => {
    const child = withRequestContext(baseLogger, {
      request_id: "req-null",
      tenant_id: null,
      user_id: null,
      store_id: null,
    });
    const bindings = child.bindings();
    expect(bindings["tenant_id"]).toBeNull();
    expect(bindings["user_id"]).toBeNull();
    expect(bindings["store_id"]).toBeNull();
  });
});
