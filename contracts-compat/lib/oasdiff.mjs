// RT-713: run oasdiff the same way tools/oasdiff/check.sh does (composed mode,
// --fail-on WARN, the shared severity-levels.txt), so the two gates agree.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// A native oasdiff on Windows cannot take backslashes inside a glob.
const forGlob = (p) => p.replaceAll("\\", "/");

/**
 * Compare every contract under baseDir with every contract under headDir.
 * @returns { status: 'ok'|'breaking'|'tool-error', output: string }
 */
export function diffTrees({ oasdiff = process.env.OASDIFF ?? "oasdiff", baseDir, headDir, severityFile, ignoreFile }) {
  const args = [
    "breaking", "--composed", "--fail-on", "WARN",
    "--severity-levels", severityFile,
    "--err-ignore", ignoreFile,
    "--warn-ignore", ignoreFile,
    "--format", "singleline",
    `${forGlob(baseDir)}/**/*.yaml`,
    `${forGlob(headDir)}/**/*.yaml`,
  ];
  const r = spawnSync(oasdiff, args, { encoding: "utf8" }); // NOSONAR: PATH-resolved like tools/oasdiff/check.sh; CI installs a pinned, checksum-verified binary
  if (r.error) return { status: "tool-error", output: String(r.error.message) };
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status === 0) return { status: "ok", output };
  // Findings are printed on stdout; a non-zero exit with none is a tool failure.
  return { status: (r.stdout ?? "").trim() === "" ? "tool-error" : "breaking", output };
}

export function writeIgnoreFile(file, lines) {
  // Never write a comment or blank pattern: oasdiff would treat it as an ignore entry.
  writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}
