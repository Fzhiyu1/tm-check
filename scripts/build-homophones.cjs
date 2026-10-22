// 生成 data/homophones.json：无调拼音 -> 按字频排序的常用字（GB2312 一二级字库）
const fs = require("node:fs");
const path = require("node:path");
const { pinyin } = require("pinyin-pro");
const hanzi = require("hanzi");

const log = console.log;
console.log = () => {};
hanzi.start();
console.log = log;

const td = new TextDecoder("gb18030");
const chars = [];
for (let a = 0xb0; a <= 0xf7; a++) {
  for (let b = 0xa1; b <= 0xfe; b++) {
    if (a === 0xd7 && b > 0xf9) continue;
    const ch = td.decode(new Uint8Array([a, b]));
    if (/^\p{Script=Han}$/u.test(ch)) chars.push(ch);
  }
}

const map = {};
for (const ch of chars) {
  const freq = hanzi.getCharacterFrequency(ch);
  const rank = freq && freq.number ? Number(freq.number) : 99999;
  const readings = new Set(
    pinyin(ch, { multiple: true, type: "array", toneType: "none" }).map((s) => s.replace("ü", "v"))
  );
  for (const py of readings) (map[py] ||= []).push([ch, rank]);
}
const out = {};
for (const py of Object.keys(map).sort()) {
  out[py] = map[py].sort((x, y) => x[1] - y[1]).map(([ch, rank]) => [ch, rank]);
}
const file = path.join(__dirname, "..", "data", "homophones.json");
fs.writeFileSync(file, JSON.stringify(out));
log(`wrote ${file}: ${chars.length} chars, ${Object.keys(out).length} syllables`);
