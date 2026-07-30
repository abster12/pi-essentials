/**
 * oh-pi Compact Header — table-style startup info with dynamic column widths
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Resolve the version of the *host* pi that launched this process.
 *
 * Extensions link against whichever `@earendil-works/pi-coding-agent` copy Node
 * resolves from their own `node_modules`, which can lag the actually-running pi
 * (e.g. a stale devDependency pinned to an older release). Because pi-essentials
 * is loaded by path rather than as a global package, Node never falls back to
 * the global prefix — so the imported `VERSION` constant may report the wrong
 * release. Instead, locate the host pi via `process.argv[1]` (the pi bin path)
 * and read its package.json directly.
 *
 * The walk-up is split out as `resolveHostPiVersionFrom(startDir)` so it can be
 * unit-tested against a synthesized directory tree without touching the real
 * filesystem or `process.argv`.
 */
export function resolveHostPiVersionFrom(startDir: string): string {
  let nestedFallback: string | undefined;
  let dir = startDir;
  for (let i = 0; i < 40 && dir !== "/"; i++) {
    // A directory whose own package.json *is* the host package is authoritative —
    // returning here is the happy path (argv[1] realpath lives under it).
    try {
      const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
      if (pkg?.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch { /* not a package dir, keep walking */ }
    // Remember the nearest nested copy as a fallback only — never return it
    // eagerly, since the first one found may be a stale devDependency; the host
    // package.json (checked at every level) always wins if it exists above.
    if (nestedFallback === undefined) {
      try {
        nestedFallback = JSON.parse(
          readFileSync(`${dir}/node_modules/@earendil-works/pi-coding-agent/package.json`, "utf8"),
        ).version;
      } catch { /* no nested copy at this level */ }
    }
    dir = dirname(dir);
  }
  return nestedFallback ?? "unknown";
}

function getHostPiVersion(): string {
  try {
    return resolveHostPiVersionFrom(dirname(realpathSync(process.argv[1])));
  } catch {
    return "unknown";
  }
}

const PI_VERSION = getHostPiVersion();

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        const d = (s: string) => theme.fg("dim", s);
        const a = (s: string) => theme.fg("accent", s);

        const cmds = pi.getCommands();
        const prompts = cmds.filter(c => c.source === "prompt").map(c => `/${c.name}`).join("  ");
        const skills = cmds.filter(c => c.source === "skill").map(c => c.name).join("  ");
        const model = ctx.model ? `${ctx.model.id}` : "no model";
        const thinking = pi.getThinkingLevel();
        const provider = ctx.model?.provider ?? "";

        const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
        const t = (s: string) => truncateToWidth(s, width);
        const sep = d(" │ ");

        // Right two columns are fixed width
        const rCol = [
          [d("esc"), a("interrupt"),   d("S-tab"), a("thinking")],
          [d("^C"),  a("clear/exit"),  d("^O"),    a("expand")],
          [d("^P"),  a("model"),       d("^G"),    a("editor")],
          [d("/"),   a("commands"),    d("^V"),    a("paste")],
          [d("!"),   a("bash"),        d(""),      a("")],
        ];
        const k1w = 6, v1w = 13, k2w = 6, v2w = 9;
        const rightW = k1w + v1w + 3 + k2w + v2w + 3; // 3 for each sep

        // Left column gets remaining space
        const leftW = Math.max(20, width - rightW);
        const lk = 9; // label width

        const lCol = [
          [d("version"), a(`v${PI_VERSION}  ${provider}`)],
          [d("model"),   a(model)],
          [d("think"),   a(thinking)],
          [d(""),        d("")],
          [d(""),        d("")],
        ];

        const lines: string[] = [""];
        for (let i = 0; i < 5; i++) {
          const [lk0, lv0] = lCol[i];
          const [rk0, rv0, rk1, rv1] = rCol[i];
          const left = truncateToWidth(pad(lk0, lk) + lv0, leftW);
          const right = pad(rk0, k1w) + pad(rv0, v1w) + sep + pad(rk1, k2w) + rv1;
          lines.push(t(pad(left, leftW) + sep + right));
        }

        if (prompts) lines.push(t(`${pad(d("prompts"), lk)}${a(prompts)}`));
        if (skills) lines.push(t(`${pad(d("skills"), lk)}${a(skills)}`));
        lines.push(d("─".repeat(width)));

        return lines;
      },
      invalidate() {},
    }));
  });
}
