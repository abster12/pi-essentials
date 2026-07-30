// src/compact-header.ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
function resolveHostPiVersionFrom(startDir) {
  let nestedFallback;
  let dir = startDir;
  for (let i = 0; i < 40 && dir !== "/"; i++) {
    try {
      const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
      if (pkg?.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
    }
    if (nestedFallback === void 0) {
      try {
        nestedFallback = JSON.parse(
          readFileSync(`${dir}/node_modules/@earendil-works/pi-coding-agent/package.json`, "utf8")
        ).version;
      } catch {
      }
    }
    dir = dirname(dir);
  }
  return nestedFallback ?? "unknown";
}
function getHostPiVersion() {
  try {
    return resolveHostPiVersionFrom(dirname(realpathSync(process.argv[1])));
  } catch {
    return "unknown";
  }
}
var PI_VERSION = getHostPiVersion();
function compact_header_default(pi) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setHeader((_tui, theme) => ({
      render(width) {
        const d = (s) => theme.fg("dim", s);
        const a = (s) => theme.fg("accent", s);
        const cmds = pi.getCommands();
        const prompts = cmds.filter((c) => c.source === "prompt").map((c) => `/${c.name}`).join("  ");
        const skills = cmds.filter((c) => c.source === "skill").map((c) => c.name).join("  ");
        const model = ctx.model ? `${ctx.model.id}` : "no model";
        const thinking = pi.getThinkingLevel();
        const provider = ctx.model?.provider ?? "";
        const pad = (s, w) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
        const t = (s) => truncateToWidth(s, width);
        const sep = d(" \u2502 ");
        const rCol = [
          [d("esc"), a("interrupt"), d("S-tab"), a("thinking")],
          [d("^C"), a("clear/exit"), d("^O"), a("expand")],
          [d("^P"), a("model"), d("^G"), a("editor")],
          [d("/"), a("commands"), d("^V"), a("paste")],
          [d("!"), a("bash"), d(""), a("")]
        ];
        const k1w = 6, v1w = 13, k2w = 6, v2w = 9;
        const rightW = k1w + v1w + 3 + k2w + v2w + 3;
        const leftW = Math.max(20, width - rightW);
        const lk = 9;
        const lCol = [
          [d("version"), a(`v${PI_VERSION}  ${provider}`)],
          [d("model"), a(model)],
          [d("think"), a(thinking)],
          [d(""), d("")],
          [d(""), d("")]
        ];
        const lines = [""];
        for (let i = 0; i < 5; i++) {
          const [lk0, lv0] = lCol[i];
          const [rk0, rv0, rk1, rv1] = rCol[i];
          const left = truncateToWidth(pad(lk0, lk) + lv0, leftW);
          const right = pad(rk0, k1w) + pad(rv0, v1w) + sep + pad(rk1, k2w) + rv1;
          lines.push(t(pad(left, leftW) + sep + right));
        }
        if (prompts) lines.push(t(`${pad(d("prompts"), lk)}${a(prompts)}`));
        if (skills) lines.push(t(`${pad(d("skills"), lk)}${a(skills)}`));
        lines.push(d("\u2500".repeat(width)));
        return lines;
      },
      invalidate() {
      }
    }));
  });
}
export {
  compact_header_default as default,
  resolveHostPiVersionFrom
};
//# sourceMappingURL=compact-header.js.map
