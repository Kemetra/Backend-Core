#!/usr/bin/env node
/**
 * RT-805 — CHANGELOG fragment CLI. Run from the repository root:
 *
 *   node tools/changelog/assemble.cjs                      check fragments and the [Unreleased] pointer
 *   node tools/changelog/assemble.cjs --preview            print the sections the next release would get
 *   node tools/changelog/assemble.cjs --migrate            move entries written into [Unreleased] into fragments
 *   node tools/changelog/assemble.cjs --release 0.2.0 [--date 2026-10-22]
 *                                                          write the version section and delete the fragments
 */
"use strict";

const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const lib = require("./fragments.cjs");

const ROOT = resolve(__dirname, "..", "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const FRAGMENTS_DIR = join(ROOT, "changelog.d");

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function check(changelog) {
  const fragments = lib.readFragments(FRAGMENTS_DIR);
  const migration = lib.migrateUnreleased(changelog, []);
  if (migration.files.length > 0) {
    throw new Error(
      `CHANGELOG.md [Unreleased] holds ${migration.files.length} entr${migration.files.length === 1 ? "y" : "ies"}; ` +
        "run `node tools/changelog/assemble.cjs --migrate`",
    );
  }
  console.log(`[OK] ${fragments.length} fragment(s) in changelog.d; [Unreleased] holds only the pointer`);
}

function migrate(changelog) {
  mkdirSync(FRAGMENTS_DIR, { recursive: true });
  const out = lib.migrateUnreleased(changelog, readdirSync(FRAGMENTS_DIR));
  for (const file of out.files) writeFileSync(join(FRAGMENTS_DIR, file.name), file.text);
  writeFileSync(CHANGELOG, out.changelog);
  console.log(`[DONE] moved ${out.files.length} entr${out.files.length === 1 ? "y" : "ies"} into changelog.d`);
}

function release(changelog, version, date) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("--release needs a semver version");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");
  const fragments = lib.readFragments(FRAGMENTS_DIR);
  writeFileSync(CHANGELOG, lib.release(changelog, fragments, version, date));
  for (const f of fragments) rmSync(join(FRAGMENTS_DIR, f.name));
  console.log(`[DONE] released ${fragments.length} fragment(s) as ${version}`);
}

function main(args) {
  const changelog = readFileSync(CHANGELOG, "utf8");
  if (!existsSync(FRAGMENTS_DIR) && !args.includes("--migrate")) throw new Error("changelog.d/ is missing");
  if (args.includes("--migrate")) return migrate(changelog);
  if (args.includes("--preview")) return process.stdout.write(lib.renderSections(lib.readFragments(FRAGMENTS_DIR)));
  if (args.includes("--release")) {
    const date = argValue(args, "--date") ?? new Date().toISOString().slice(0, 10);
    return release(changelog, argValue(args, "--release"), date);
  }
  return check(changelog);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = 1;
}
