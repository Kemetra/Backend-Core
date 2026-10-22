/**
 * RT-410 G4 guard (AD-POSTING-001 D-4): the Connector's rejection message is
 * never logged, audited or used as a metric label.
 *
 * A source scan of the API and the worker:
 *   - only the reviewed files below read the message (`reason.message`,
 *     `rejection_message`, `rejectionMessage`); a new reader fails here and
 *     needs the same review;
 *   - none of those files writes to a logger, the console, Sentry, audit
 *     metadata or a metric with a label.
 * The integration spec (posting-ack-rejection-message.spec.ts) adds the
 * runtime check that no audit row carries it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..");
const SOURCE_DIRS = ["apps/api/src", "apps/worker/src"];
const MESSAGE_READ = /reason\??\.message|rejection_message|rejectionMessage/;

/** Every file that reads the message, reviewed for RT-410. */
const REVIEWED_READERS = [
  "apps/api/src/catalog/erpnext-posting/erpnext-posting.service.ts",
  "apps/api/src/catalog/erpnext-posting/rejection-message.ts",
  "apps/api/src/catalog/erpnext-reconciliation/erpnext-reconciliation.service.ts",
  "apps/api/src/catalog/erpnext-reconciliation/reconciliation-report.projection.ts",
].sort();

/** A write to a log, the console, Sentry, audit metadata or a labelled metric. */
const SINKS = /\blogger\b|\bconsole\.|Sentry|captureException|annotateAudit|auditMetadata|\.warn\(|\.info\(|\.error\(|\.debug\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const readers = SOURCE_DIRS.flatMap((dir) => sourceFiles(resolve(ROOT, dir)))
  .filter((path) => MESSAGE_READ.test(readFileSync(path, "utf8")))
  .map((path) => relative(ROOT, path).replace(/\\/g, "/"))
  .sort();

describe("RT-410 G4 — the rejection message never reaches a log, audit or metric", () => {
  it("only the reviewed files read it", () => {
    expect(readers).toEqual(REVIEWED_READERS);
  });

  it.each(REVIEWED_READERS)("%s writes to no log, console, Sentry, audit metadata or labelled metric", (file) => {
    const sinks = readFileSync(resolve(ROOT, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .filter((line) => SINKS.test(line));
    expect(sinks).toEqual([]);
  });
});
