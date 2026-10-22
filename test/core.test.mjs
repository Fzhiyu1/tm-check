import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homophoneVariants, homophonesOf } from "../lib/homophones.mjs";
import { classifyRow, rollupByName, summarize, toTsv } from "../lib/report.mjs";
import { pendingJobs } from "../lib/run.mjs";
import { planJobs } from "../bin/tm-check.mjs";
import { buildDriverScript } from "../lib/driver.mjs";
import { loadConfig } from "../lib/config.mjs";

test("同音变体覆盖已知冲突：声息间 -> 生息间", () => {
  const names = homophoneVariants("声息间").map((v) => v.name);
  assert.ok(names.includes("生息间"));
  assert.ok(!names.includes("声息间"));
});

test("同音字按字频排序且不含生僻字", () => {
  assert.deepEqual(homophonesOf("籁", { top: 3 }), ["来", "莱", "赖"]);
  assert.ok(!homophonesOf("籁", { top: 20, maxRank: 3000 }).includes("濑"));
});

test("多音字取所有读音", () => {
  const alts = homophonesOf("行", { top: 50 });
  assert.ok(alts.includes("型") && alts.includes("航"));
});

test("planJobs 去重并按类别展开", () => {
  const jobs = planJobs(["汀间", "汀间"], { classes: [9, 41], mode: "cn", homophones: false });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.id), ["cn9-汀间", "cn41-汀间"]);
});

test("classifyRow 区分相同、包含与其他", () => {
  assert.equal(classifyRow({ mark: "生息间" }, "生息间"), "same");
  assert.equal(classifyRow({ mark: "生 息 间" }, "生息间"), "same");
  assert.equal(classifyRow({ mark: "生息间APP" }, "生息间"), "contains");
  assert.equal(classifyRow({ mark: "松息间" }, "生息间"), "other");
  assert.equal(classifyRow({ mark: "" }, "生息间"), "unknown");
});

const jobs = planJobs(["声息间"], { classes: [9], mode: "cn", homophones: true, top: 1 });
const results = [
  { id: "cn9-声息间", status: "ok", total: 3, rows: [{ regNo: "1", mark: "松息间", applicant: "A" }] },
  { id: "cn9-生息间", status: "ok", total: 85, rows: [{ regNo: "85389031", mark: "生息间", applicant: "北京卡路里信息技术有限公司" }] },
  { id: "cn9-声西间", status: "timeout" },
];

test("汇总：同音变体命中相同商标即判冲突", () => {
  const roll = rollupByName(summarize(jobs, results));
  assert.equal(roll[0].status, "冲突");
  assert.match(roll[0].hits[0], /卡路里/);
});

test("pendingJobs 跳过已成功的 job，失败的重查", () => {
  const dir = mkdtempSync(join(tmpdir(), "tmc-"));
  const f = join(dir, "results.jsonl");
  writeFileSync(f, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const left = pendingJobs(jobs, f).map((j) => j.id);
  assert.ok(left.includes("cn9-声西间"));
  assert.ok(!left.includes("cn9-生息间"));
});

test("TSV 每行列数一致", () => {
  const lines = toTsv(summarize(jobs, results)).split("\n").filter(Boolean);
  const n = lines[0].split("\t").length;
  for (const l of lines) assert.equal(l.split("\t").length, n);
});

test("驱动脚本可解析且嵌入了输入", () => {
  const src = buildDriverScript({ space: 11, spaceName: "x", jobs, resultsFile: "/tmp/r.jsonl", shotsDir: "/tmp/s", resultWaitMs: 1, delayMs: 1 });
  assert.match(src, /"space":11/);
  const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
  assert.doesNotThrow(() => new AsyncFn(src.replace(/await import\(/g, "await (async()=>({}))(")));
});

test("项目配置的相对 outDir 以配置文件目录为基准", () => {
  const dir = mkdtempSync(join(tmpdir(), "tmc-cfg-"));
  writeFileSync(join(dir, ".tm-check.json"), JSON.stringify({ outDir: "out", classes: [9] }));
  const cfg = loadConfig(join(dir, ".tm-check.json"));
  assert.equal(cfg.outDir, join(dir, "out"));
  assert.deepEqual(cfg.classes, [9]);
});
