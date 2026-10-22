import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

export const DEFAULTS = {
  classes: [9, 41, 42],
  mode: "cn",
  space: null,
  spaceName: "商标查询",
  delayMs: 4000,
  resultWaitMs: 15000,
  outDir: join(homedir(), "run", "tm-check", "runs"),
  homophones: { top: 3, maxRank: 3000 },
};

/** 从 cwd 向上找 .tm-check.json，项目可以借此指定输出目录和默认类别。 */
export function findProjectConfig(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    const file = join(dir, ".tm-check.json");
    if (existsSync(file)) return file;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(explicit) {
  const file = explicit ? resolve(explicit) : findProjectConfig();
  const cfg = structuredClone(DEFAULTS);
  cfg.configFile = null;
  if (!file) return cfg;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(cfg, raw, { homophones: { ...cfg.homophones, ...(raw.homophones ?? {}) } });
  if (raw.outDir && !isAbsolute(raw.outDir)) cfg.outDir = join(dirname(file), raw.outDir);
  cfg.configFile = file;
  return cfg;
}
