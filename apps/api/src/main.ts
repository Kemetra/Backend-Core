// instrumentation MUST be first: registers the OTel MeterProvider before
// any module that creates instruments at load time (api.metrics.ts, etc.).
import "./instrumentation";
import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import cookieParser from "cookie-parser";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./common/exception.filter";
import { LoggingInterceptor, ROOT_LOGGER } from "./common/logging.interceptor";
import { RequestIdInterceptor } from "./common/request-id.interceptor";
import { ZodValidationPipe } from "./common/zod-validation.pipe";
import { ContextInterceptor } from "./context/context.interceptor";
import { loadOpenApiContracts } from "./openapi/loader";

async function bootstrap(): Promise<void> {
  // OTel SDK is already running (started by ./instrumentation, which is
  // imported as the very first module in this file). The PrometheusExporter
  // listener is up on METRICS_PORT (default 9464) before any AppModule
  // provider creates an OTel instrument, so all instruments resolve to live
  // SDK counters/histograms rather than dead ProxyCounters.

  const rootLogger: Logger = createLogger({
    service: "api",
    level: process.env["LOG_LEVEL"] ?? "info",
  });

  // Fail-fast on malformed contracts. Constitution IV — contracts are the
  // source of truth; we'd rather refuse to start than serve traffic against
  // a corrupted spec.
  const contracts = loadOpenApiContracts();
  rootLogger.info(
    { count: contracts.length, ids: contracts.map((c) => c.id) },
    "openapi contracts loaded",
  );

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Trust the first reverse-proxy hop (Caddy / LB) so req.ip reflects the
  // real client IP. Without this, rate-limit buckets and audit events all
  // key on the proxy's internal address. The hop count MUST match the
  // deployment topology; `1` is correct for the single-Caddy template.
  // Do not trust forwarded headers unless the deployment explicitly declares
  // its proxy topology. Direct clients therefore cannot select their own
  // rate-limit bucket with X-Forwarded-For.
  const trustProxy = process.env["TRUST_PROXY"] ?? "false";
  const expressApp = app.getHttpAdapter().getInstance() as { set(key: string, value: unknown): void };
  const parsed = /^\d+$/.test(trustProxy) ? Number(trustProxy) : null;
  expressApp.set("trust proxy", parsed ?? trustProxy === "true");

  // CORS — explicit allowlist from ALLOWED_ORIGINS (comma-separated).
  // Defaults to disabled (no cross-origin requests allowed). The dashboard
  // frontend origin must be added to this list when deployed.
  const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowedOrigins.length > 0) {
    app.enableCors({
      origin: allowedOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    });
  }

  // Express middleware
  app.use(cookieParser());
  app.use(helmet());

  // Global interceptors — RequestIdInterceptor must run first so the others
  // can read request.requestId. ContextInterceptor bridges
  // request.context (set by TenantContextGuard, when present) into the
  // AsyncLocalStorage scope; it no-ops on routes that aren't guarded.
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new LoggingInterceptor(rootLogger),
    new ContextInterceptor(),
  );

  // Global exception filter — every uncaught error formatted into the
  // shared envelope shape.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Global Zod validation pipe — no-op when no schema is attached. Per-
  // route bodies attach their own schema via `@Body(new ZodValidationPipe(SignInSchema))`.
  app.useGlobalPipes(new ZodValidationPipe());

  // DI registration so providers that need the logger can `@Inject(ROOT_LOGGER)`.
  // (Used by LoggingInterceptor instances created via DI in future test
  // bootstraps; the global instance above is constructed manually.)
  void ROOT_LOGGER;

  app.enableShutdownHooks();

  const port = Number(process.env["PORT"] ?? 3000);
  await app.listen(port);
  rootLogger.info({ port }, "api listening");
}

if (require.main === module) {
  bootstrap().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("api: bootstrap failed", err);
    process.exit(1);
  });
}

export { bootstrap };
