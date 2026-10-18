/**
 * Boot the real AppModule against an unreachable database, for sweeps that
 * read route metadata only (RT-129 route-auth markers, OpenAPI route
 * conformance, RT-567 audit action-kind drift guard). Every assertion in
 * those sweeps must hold without a DB or Redis.
 */
import type { INestApplication, Type } from "@nestjs/common";
import { ModulesContainer, NestFactory } from "@nestjs/core";

import { AppModule } from "../../src/app.module";

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "AUTH_LOOKUP_DATABASE_URL", "REDIS_URL"] as const;

export interface DbLessApp {
  readonly app: INestApplication;
  /** Close the app and restore the env it changed. */
  close(): Promise<void>;
}

/** `label` names the unreachable DB URL, so a stray connection is traceable. */
export async function bootDbLessApp(label: string): Promise<DbLessApp> {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env["NODE_ENV"] = "test";
  process.env["DATABASE_URL"] = `postgres://${label}:${label}@127.0.0.1:1/${label}`;
  delete process.env["AUTH_LOOKUP_DATABASE_URL"];
  delete process.env["REDIS_URL"];
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  return {
    app,
    async close() {
      await app.close();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** Every controller class registered in `app`. */
export function appControllers(app: INestApplication): Type<unknown>[] {
  return [...app.get(ModulesContainer).values()].flatMap((mod) =>
    [...mod.controllers.values()].map((wrapper) => wrapper.metatype as Type<unknown>),
  );
}
