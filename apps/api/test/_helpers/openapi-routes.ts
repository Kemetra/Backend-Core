/**
 * Shared OpenAPI ↔ Nest route helpers for the route sweeps
 * (runtime-route-conformance, RT-619 console rate-limit ratchet).
 */
import "reflect-metadata";

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Type } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { load as parseYaml } from "js-yaml";

export type Operation = {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
};

type OpenApiDocument = {
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, Record<string, Operation>>;
};

export type ContractRoute = {
  path: string;
  method: string;
  operation: Operation;
  /** The effective security requirement (operation, else document default). */
  security: Array<Record<string, unknown>>;
};

const CONTRACT_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const NEST_VERBS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD"];

export const CONTRACTS_DIR = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "openapi");

export function yamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/i.test(entry.name) ? [path] : [];
  });
}

function normalizeSegment(segment: string): string {
  const colon = segment.indexOf(":");
  const express = colon >= 0 ? `${segment.slice(0, colon)}{param}` : segment;
  return express.replace(/\{[^/}]*\}/g, "{param}");
}

/** `/a/:id/` and `/a/{id}` both become `/a/{param}`. */
export function normalizePath(path: string): string {
  return "/" + path.split("/").filter((s) => s.length > 0).map(normalizeSegment).join("/");
}

export function contractRoutes(dir: string = CONTRACTS_DIR): ContractRoute[] {
  return yamlFiles(dir).flatMap((file) => {
    const document = parseYaml(readFileSync(file, "utf8")) as OpenApiDocument;
    return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      CONTRACT_METHODS.flatMap((method) => {
        const operation = item[method];
        return operation?.operationId
          ? [{ path, method, operation, security: operation.security ?? document.security ?? [] }]
          : [];
      }),
    );
  });
}

export function usesScheme(route: ContractRoute, scheme: string): boolean {
  return route.security.some((requirement) => Object.keys(requirement).includes(scheme));
}

export interface ControllerRoute {
  /** `METHOD /normalized/{param}` — the join key with {@link contractRouteKey}. */
  key: string;
  controller: Type<unknown>;
  handler: object;
  id: string;
}

function joinPath(base: unknown, sub: unknown): string {
  const segments = [base, sub]
    .flatMap((p) => (Array.isArray(p) ? [p[0]] : [p]))
    .filter((p): p is string => typeof p === "string")
    .flatMap((p) => p.split("/"))
    .filter((s) => s.length > 0);
  return "/" + segments.join("/");
}

/** Every route handler of `controller`, keyed by method and normalized path. */
export function controllerRoutes(controller: Type<unknown>): ControllerRoute[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor" && typeof proto[name] === "function")
    .flatMap((name) => {
      const handler = proto[name] as object;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (verb === undefined) return [];
      const path = joinPath(Reflect.getMetadata(PATH_METADATA, controller), Reflect.getMetadata(PATH_METADATA, handler));
      return [{ key: `${NEST_VERBS[verb] ?? "GET"} ${normalizePath(path)}`, controller, handler, id: `${controller.name}.${name}` }];
    });
}

export function contractRouteKey(route: ContractRoute): string {
  return `${route.method.toUpperCase()} ${normalizePath(route.path)}`;
}
