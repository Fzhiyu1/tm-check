import { readFileSync } from "node:fs";

const TABLE = JSON.parse(readFileSync(new URL("../data/homophones.json", import.meta.url), "utf8"));
const CHAR_TO_PY = new Map();
for (const [py, list] of Object.entries(TABLE)) {
  for (const [ch] of list) {
    if (!CHAR_TO_PY.has(ch)) CHAR_TO_PY.set(ch, []);
    CHAR_TO_PY.get(ch).push(py);
  }
}

export function readingsOf(ch) {
  return CHAR_TO_PY.get(ch) ?? [];
}

/** 某个字的常用同音字（不含自身），按字频排序。 */
export function homophonesOf(ch, { top = 3, maxRank = 3000 } = {}) {
  const seen = new Set([ch]);
  const pool = [];
  for (const py of readingsOf(ch)) {
    for (const [c, rank] of TABLE[py]) {
      if (rank > maxRank || seen.has(c)) continue;
      seen.add(c);
      pool.push([c, rank]);
    }
  }
  return pool.sort((a, b) => a[1] - b[1]).slice(0, top).map(([c]) => c);
}

/**
 * 每次只替换一个位置，生成同音变体。
 * 商标局拼音检索只匹配商标本身登记的拼音，所以同音冲突要用同音汉字逐个查。
 */
export function homophoneVariants(name, opts = {}) {
  const chars = [...name];
  const out = [];
  chars.forEach((ch, i) => {
    for (const alt of homophonesOf(ch, opts)) {
      const v = [...chars];
      v[i] = alt;
      out.push({ name: v.join(""), from: name, pos: i, char: alt });
    }
  });
  return out;
}
