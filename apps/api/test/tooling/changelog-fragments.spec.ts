/**
 * RT-805 — per-change CHANGELOG fragments.
 *
 * Every unreleased change is one file under `changelog.d/`, so parallel PRs
 * never edit the same CHANGELOG lines. `tools/changelog/fragments.cjs`
 * validates the fragments and assembles them into a version section at
 * release. This spec checks the real fragments and the `[Unreleased]` pointer,
 * and pins the parser and the assembler with negative cases.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Fragment = { name: string; section: string; body: string };
type FragmentsLib = {
  SECTIONS: readonly string[];
  UNRELEASED_POINTER: string;
  migrateUnreleased(
    changelog: string,
    existingNames: string[],
  ): { changelog: string; files: Array<{ name: string; text: string }> };
  parseFragment(name: string, text: string): Fragment;
  readFragments(dir: string): Fragment[];
  renderSections(fragments: Fragment[]): string;
  splitSections(markdown: string): Array<{ section: string; body: string }>;
  unreleasedBlock(changelog: string): string;
  release(changelog: string, fragments: Fragment[], version: string, date: string): string;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require("../../../../tools/changelog/fragments.cjs") as FragmentsLib;

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const FRAGMENTS_DIR = resolve(REPO_ROOT, "changelog.d");

const fragment = (name: string, section: string, bullet: string): string => `### ${section}\n- ${bullet}\n`;

describe("changelog fragments (RT-805)", () => {
  describe("the repository", () => {
    it("every file in changelog.d is a valid fragment", () => {
      const fragments = lib.readFragments(FRAGMENTS_DIR);
      for (const f of fragments) {
        expect(lib.SECTIONS).toContain(f.section);
        expect(f.body.startsWith("- ")).toBe(true);
      }
    });

    it("CHANGELOG [Unreleased] holds only the pointer to changelog.d, no entries", () => {
      const block = lib.unreleasedBlock(readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8"));
      expect(block).toContain("changelog.d/");
      const entryLines = block.split("\n").filter((line) => /^(###\s|[-*]\s)/.test(line));
      expect(entryLines).toEqual([]);
    });
  });

  describe("parseFragment", () => {
    it("reads the section and keeps the body verbatim", () => {
      const text = "### Fixed\n- RT-1 a fix\n  that wraps.\n";
      expect(lib.parseFragment("RT-1-a-fix.md", text)).toEqual({
        name: "RT-1-a-fix.md",
        section: "Fixed",
        body: "- RT-1 a fix\n  that wraps.",
      });
    });

    it.each([
      ["no ticket key", "a-fix.md"],
      ["lower-case key", "rt-1-a-fix.md"],
      ["no slug", "RT-1.md"],
      ["upper-case slug", "RT-1-A-Fix.md"],
      ["not markdown", "RT-1-a-fix.txt"],
    ])("rejects a file name with %s", (_label, name) => {
      expect(() => lib.parseFragment(name, fragment(name, "Fixed", "x"))).toThrow(/file name/);
    });

    it("accepts a no-ticket fragment name", () => {
      expect(lib.parseFragment("no-ticket-tidy.md", fragment("", "Changed", "x")).section).toBe("Changed");
    });

    it("rejects a fragment without a section heading", () => {
      expect(() => lib.parseFragment("RT-1-a.md", "- RT-1 a\n")).toThrow(/section/);
    });

    it("rejects an unknown section", () => {
      expect(() => lib.parseFragment("RT-1-a.md", fragment("", "Misc", "x"))).toThrow(/section/);
    });

    it("rejects a body that is not a bullet", () => {
      expect(() => lib.parseFragment("RT-1-a.md", "### Added\nprose\n")).toThrow(/bullet/);
    });

    it("rejects a second section heading", () => {
      expect(() => lib.parseFragment("RT-1-a.md", "### Added\n- a\n### Fixed\n- b\n")).toThrow(/one section/);
    });
  });

  describe("assembly", () => {
    const fragments = [
      lib.parseFragment("RT-20-b.md", fragment("", "Added", "RT-20 b")),
      lib.parseFragment("RT-3-a.md", "### Added\n- RT-3 a\n\n  second paragraph.\n"),
      lib.parseFragment("RT-7-c.md", fragment("", "Security", "RT-7 c")),
      lib.parseFragment("RT-5-d.md", fragment("", "Changed", "RT-5 d")),
    ];

    it("renders sections in Keep a Changelog order, entries by ticket number", () => {
      expect(lib.renderSections(fragments)).toBe(
        [
          "### Added",
          "- RT-3 a",
          "",
          "  second paragraph.",
          "- RT-20 b",
          "",
          "### Changed",
          "- RT-5 d",
          "",
          "### Security",
          "- RT-7 c",
          "",
        ].join("\n"),
      );
    });

    it("splitSections inverts renderSections", () => {
      const split = lib.splitSections(lib.renderSections(fragments));
      expect(split.map((s) => s.section)).toEqual(["Added", "Added", "Changed", "Security"]);
      expect(split[0]?.body).toBe("- RT-3 a\n\n  second paragraph.");
    });

    it("release inserts a dated version section under the [Unreleased] pointer", () => {
      const changelog = "# Changelog\n\n## [Unreleased]\n\nSee changelog.d/.\n\n## [0.1.0] — old\n- x\n";
      const out = lib.release(changelog, fragments, "0.2.0", "2026-10-22");
      expect(out.startsWith("# Changelog\n\n## [Unreleased]\n\nSee changelog.d/.\n\n## [0.2.0] — 2026-10-22\n\n### Added\n")).toBe(true);
      expect(out.endsWith("- RT-7 c\n\n## [0.1.0] — old\n- x\n")).toBe(true);
      expect(lib.unreleasedBlock(out)).toBe("\nSee changelog.d/.\n\n");
    });

    it("release refuses an empty fragment set", () => {
      expect(() => lib.release("## [Unreleased]\n\n## [0.1.0]\n", [], "0.2.0", "2026-10-22")).toThrow(/no fragments/);
    });

    it("unreleasedBlock refuses a changelog with no [Unreleased] heading", () => {
      expect(() => lib.unreleasedBlock("# Changelog\n")).toThrow(/Unreleased/);
    });
  });

  describe("migrateUnreleased (entries written straight into CHANGELOG.md)", () => {
    const changelog = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "- RT-9 first",
      "  wrapped.",
      "- RT-9 again",
      "- untagged entry",
      "",
      "### Fixed",
      "- RT-4 fix",
      "",
      "## [0.1.0] — old",
      "- x",
      "",
    ].join("\n");

    it("moves every entry into a fragment and leaves only the pointer", () => {
      const out = lib.migrateUnreleased(changelog, ["RT-9-added.md"]);
      expect(out.files.map((f) => f.name)).toEqual([
        "RT-9-added-2.md",
        "RT-9-added-3.md",
        "no-ticket-added.md",
        "RT-4-fixed.md",
      ]);
      expect(out.files[0]?.text).toBe("### Added\n- RT-9 first\n  wrapped.\n");
      expect(lib.unreleasedBlock(out.changelog)).toBe(`\n${lib.UNRELEASED_POINTER}\n\n`);
      expect(out.changelog.endsWith("## [0.1.0] — old\n- x\n")).toBe(true);
      const parsed = out.files.map((f) => lib.parseFragment(f.name, f.text));
      expect(lib.splitSections(lib.renderSections(parsed))).toHaveLength(4);
    });

    it("reads a CRLF checkout the same as LF and writes LF", () => {
      const crlf = lib.migrateUnreleased(changelog.replace(/\n/g, "\r\n"), ["RT-9-added.md"]);
      expect(crlf).toEqual(lib.migrateUnreleased(changelog, ["RT-9-added.md"]));
    });

    it("is a no-op when [Unreleased] holds only the pointer", () => {
      const clean = lib.migrateUnreleased(changelog, []).changelog;
      expect(lib.migrateUnreleased(clean, [])).toEqual({ changelog: clean, files: [] });
    });

    it("refuses text it cannot place in a fragment", () => {
      const prose = changelog.replace("### Added\n", "Some prose.\n\n### Added\n");
      expect(() => lib.migrateUnreleased(prose, [])).toThrow(/cannot migrate/);
    });
  });
});
