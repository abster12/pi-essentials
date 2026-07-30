import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveHostPiVersionFrom } from "../compact-header.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the host-pi version resolution that replaced the stale
 * `VERSION` import in the compact header.
 *
 * Background: the extension's own `node_modules` can lag the actually-running
 * pi (e.g. a 0.82.1 devDependency while the global pi is 0.83.0). Because
 * pi-essentials is loaded by path, Node never falls back to the global prefix,
 * so `import { VERSION }` would report the wrong release. `resolveHostPiVersionFrom`
 * walks up from the pi bin's directory looking for the host package.json first,
 * falling back to the nearest nested copy only if the host package isn't found.
 *
 * These tests build a synthesized directory tree under a temp root and verify
 * the precedence against the real filesystem (no monkeypatching of `require`).
 */
describe("resolveHostPiVersionFrom", () => {
  let root: string;
  const PKG = "@earendil-works/pi-coding-agent";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "pi-ver-"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function pkgJson(dir: string, version: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: PKG, version }),
    );
  }
  function nestedCopy(dir: string, version: string) {
    const nm = join(dir, "node_modules", PKG);
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "package.json"), JSON.stringify({ version }));
  }

  it("finds the host package.json walking up from a nested directory", () => {
    pkgJson(join(root, "pkg"), "1.2.3");
    const deep = join(root, "pkg", "dist", "cli");
    mkdirSync(deep, { recursive: true });
    assert.equal(resolveHostPiVersionFrom(deep), "1.2.3");
  });

  it("prefers the host package.json over a nearer nested copy", () => {
    // A stale nested copy sitting right next to the bin…
    const proj = join(root, "proj");
    nestedCopy(proj, "0.82.1");
    // …but the actual host package lives above it and must win.
    pkgJson(join(root, "proj", "host"), "0.83.0");
    // bin lives under proj/host/dist/cli, which has the nested copy as a sibling
    // of an ancestor: host package is at proj/host, nested at proj/node_modules.
    const binDir = join(root, "proj", "host", "dist", "cli");
    mkdirSync(binDir, { recursive: true });
    assert.equal(resolveHostPiVersionFrom(binDir), "0.83.0");
  });

  it("falls back to the nearest nested copy when no host package.json exists above", () => {
    const proj = join(root, "fallback");
    nestedCopy(proj, "0.82.1");
    const binDir = join(proj, "deep", "nested", "cli");
    mkdirSync(binDir, { recursive: true });
    // No host package.json anywhere up the tree → use the nested copy.
    assert.equal(resolveHostPiVersionFrom(binDir), "0.82.1");
  });

  it("returns 'unknown' when nothing resolvable exists up the tree", () => {
    const dir = join(root, "nowhere");
    mkdirSync(dir, { recursive: true });
    assert.equal(resolveHostPiVersionFrom(dir), "unknown");
  });

  it("stops at a package.json that is NOT the host package (keeps walking)", () => {
    // A sibling package at the same level must not short-circuit the walk.
    const other = join(root, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "some-other-pkg", version: "9.9.9" }));
    pkgJson(join(root, "other", "realhost"), "0.83.0");
    const binDir = join(root, "other", "realhost", "dist");
    mkdirSync(binDir, { recursive: true });
    assert.equal(resolveHostPiVersionFrom(binDir), "0.83.0");
  });
});