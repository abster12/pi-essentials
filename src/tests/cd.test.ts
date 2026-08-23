import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome, resolveCdTarget, rewriteToolPath, reminderText, completeDirs } from "../cd.js";

describe("expandHome", () => {
  it("expands ~ to homedir", () => {
    assert.equal(expandHome("~"), homedir());
  });

  it("expands ~/foo", () => {
    assert.equal(expandHome("~/foo"), resolve(homedir(), "foo"));
  });

  it("leaves other paths alone", () => {
    assert.equal(expandHome("/tmp"), "/tmp");
    assert.equal(expandHome("rel"), "rel");
  });
});

describe("resolveCdTarget", () => {
  const current = "/proj";

  it("bare cd goes home", () => {
    assert.deepEqual(resolveCdTarget("", current, null), { ok: true, path: homedir() });
    assert.deepEqual(resolveCdTarget("   ", current, null), { ok: true, path: homedir() });
  });

  it("resolves relative against current", () => {
    assert.deepEqual(resolveCdTarget("src", current, null), { ok: true, path: resolve(current, "src") });
    assert.deepEqual(resolveCdTarget("..", current, null), { ok: true, path: resolve(current, "..") });
  });

  it("keeps absolute paths", () => {
    assert.deepEqual(resolveCdTarget("/tmp", current, null), { ok: true, path: "/tmp" });
  });

  it("cd - uses previous dir", () => {
    assert.deepEqual(resolveCdTarget("-", current, "/old"), { ok: true, path: "/old" });
  });

  it("cd - with no previous dir fails", () => {
    assert.deepEqual(resolveCdTarget("-", current, null), { ok: false, reason: "cd: OLDPWD not set" });
  });

  it("expands ~ in the argument", () => {
    assert.deepEqual(resolveCdTarget("~/Desktop", current, null), {
      ok: true,
      path: resolve(homedir(), "Desktop"),
    });
  });
});

describe("rewriteToolPath", () => {
  const launch = "/launch";
  const current = "/new";

  it("does nothing when still at launch dir", () => {
    assert.equal(rewriteToolPath("src/a.ts", launch, launch), undefined);
    assert.equal(rewriteToolPath(undefined, launch, launch), undefined);
  });

  it("rewrites relative paths against current", () => {
    assert.equal(rewriteToolPath("src/a.ts", current, launch), join(current, "src/a.ts"));
  });

  it("strips a leading @ then rewrites", () => {
    assert.equal(rewriteToolPath("@src/a.ts", current, launch), join(current, "src/a.ts"));
  });

  it("leaves absolute paths alone", () => {
    assert.equal(rewriteToolPath("/abs/a.ts", current, launch), undefined);
  });

  it("fills missing path with current dir", () => {
    assert.equal(rewriteToolPath(undefined, current, launch), current);
    assert.equal(rewriteToolPath("", current, launch), current);
  });
});

describe("reminderText", () => {
  it("names the new directory", () => {
    const text = reminderText(tmpdir());
    assert.match(text, /<system-reminder>/);
    assert.ok(text.includes(tmpdir()));
  });
});

describe("completeDirs", () => {
  const root = mkdtempSync(join(tmpdir(), "cd-complete-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "src", "foo"));
  mkdirSync(join(root, "src", "bar"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "readme.md"), "x");
  after(() => rmSync(root, { recursive: true, force: true }));

  it("lists dirs in current, files excluded", () => {
    const items = completeDirs("", root);
    assert.deepEqual(
      items.map((i) => i.value),
      ["src/"],
    );
  });

  it("filters by prefix", () => {
    const items = completeDirs("src/f", root);
    assert.deepEqual(items, [{ value: "src/foo/", label: "foo/" }]);
  });

  it("walks into a trailing slash", () => {
    const items = completeDirs("src/", root);
    assert.deepEqual(
      items.map((i) => i.value).sort(),
      ["src/bar/", "src/foo/"],
    );
  });

  it("hides dotdirs unless the prefix starts with .", () => {
    assert.equal(
      completeDirs("", root).some((i) => i.label.startsWith(".")),
      false,
    );
    assert.deepEqual(completeDirs(".", root), [{ value: ".hidden/", label: ".hidden/" }]);
  });

  it("returns empty for a missing parent", () => {
    assert.deepEqual(completeDirs("nope/x", root), []);
  });
});
