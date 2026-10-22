#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { homophoneVariants } from "../lib/homophones.mjs";
import { executeRun, jobId, runEgo } from "../lib/run.mjs";
import { writeReport } from "../lib/report.mjs";
import { SEARCH_URL } from "../lib/driver.mjs";

const HELP = `tm-check  商标局近似检索批量查询（经 Ego Lite 复用你的登录态）

用法
  tm-check check <名称...> [选项]     新建一次检索并执行
  tm-check resume [runId]             续查未完成的检索（默认最近一次）
  tm-check report [runId]             重新生成报告
  tm-check list                       列出历次检索
  tm-check homophones <名称...>       只打印同音变体，不查询
  tm-check doctor                     检查 ego-browser 与商标局登录状态

check 选项
  -c, --cls 9,41,42        国际分类（默认取配置，未配置为 9,41,42）
  -f, --file names.txt     从文件读取名称（每行一个，# 开头为注释）
  -H, --homophones         同时检索每个字的常用同音字变体
      --top 3              每个字取几个同音字（默认 3）
      --max-rank 3000      同音字只取字频排名前 N 的常用字（默认 3000）
      --pinyin             改用拼音检索（只匹配商标登记的拼音）
  -n, --dry-run            只生成任务，不查询
      --tag 名字            给本次检索起个名字，写进目录名

通用选项
      --space <id>         指定 Ego Lite 空间 id（默认按配置或名称复用）
      --delay <ms>         两次查询的间隔（默认 4000）
      --out <dir>          结果目录（默认取 .tm-check.json，未配置为 ~/run/tm-check/runs）
      --config <file>      指定配置文件（默认从当前目录向上找 .tm-check.json）
      --wait-login <分钟>   登录失效时最多等待多久（默认 30）
  -v, --verbose            打印 ego-browser 原始输出

退出码：0 全部完成；1 参数错误；2 未完成（登录、风控或超时），可 resume。`;

const ui = {
  verbose: false,
  info: (m) => console.error(`· ${m}`),
  warn: (m) => console.error(`! ${m}`),
  bell: () => process.stderr.write("\x07"),
  debug(m) {
    if (this.verbose) console.error(`  ${m}`);
  },
  result: (ev) =>
    console.error(`  ${ev.status === "ok" ? "✓" : "✗"} ${ev.id}${ev.status === "ok" ? `  ${ev.total ?? "?"} 件` : `  ${ev.status}`}`),
};

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cls: { type: "string", short: "c" },
      file: { type: "string", short: "f" },
      homophones: { type: "boolean", short: "H" },
      top: { type: "string" },
      "max-rank": { type: "string" },
      pinyin: { type: "boolean" },
      "dry-run": { type: "boolean", short: "n" },
      tag: { type: "string" },
      space: { type: "string" },
      delay: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      "wait-login": { type: "string" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readNames(positionals, file) {
  const names = [...positionals];
  if (file) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.replace(/#.*/, "").trim();
      if (t) names.push(...t.split(/[\s,，、]+/).filter(Boolean));
    }
  }
  return [...new Set(names)];
}

export function planJobs(names, { classes, mode, homophones, top, maxRank }) {
  const jobs = [];
  const seen = new Set();
  const add = (name, query, kind) => {
    for (const cls of classes) {
      const job = { name, query, kind, cls, mode };
      job.id = jobId(job);
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push(job);
    }
  };
  for (const name of names) {
    add(name, name, "original");
    if (homophones) for (const v of homophoneVariants(name, { top, maxRank })) add(name, v.name, "homophone");
  }
  return jobs;
}

function runsDir(cfg, opts) {
  return resolve(opts.out ?? cfg.outDir);
}

function findRun(dir, runId) {
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter((d) => existsSync(join(dir, d, "meta.json"))).sort();
  if (!runId) return runs.length ? join(dir, runs.at(-1)) : null;
  const hit = runs.filter((d) => d === runId || d.includes(runId));
  return hit.length ? join(dir, hit.at(-1)) : null;
}

function printRollup(rollup, runDir) {
  const width = Math.max(...rollup.map((g) => g.name.length), 2);
  console.log("");
  for (const g of rollup) {
    const note = [...g.hits, ...g.failed, ...g.pending.map((x) => `${x} 待看图`)].join("；");
    console.log(`${g.name.padEnd(width + 1, "　")}${g.status}${note ? `  ${note}` : ""}`);
  }
  console.log(`\n报告：${join(runDir, "report.md")}`);
}

async function runAndReport(runDir, cfg, opts) {
  const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
  const jobs = JSON.parse(readFileSync(join(runDir, "jobs.json"), "utf8"));
  const res = await executeRun(runDir, cfg, opts, ui);
  if (res.space && res.space !== meta.space) {
    meta.space = res.space;
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
  }
  const { rollup } = await writeReport(runDir, meta, jobs);
  printRollup(rollup, runDir);
  if (!res.ok) {
    const why = { login: "商标局登录失效且等待超时", risk: "多次触发风控", form: "找不到查询表单（页面改版或未打开近似查询页）", partial: `仍有 ${res.left} 条超时` }[res.reason] ?? res.reason;
    ui.warn(`未完成：${why}。处理后执行 tm-check resume ${meta.runId}`);
    return 2;
  }
  return 0;
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const { values: o, positionals } = parse(rest);
  ui.verbose = !!o.verbose;
  if (o.help || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return 0;
  }
  const cfg = loadConfig(o.config);
  const opts = {
    space: o.space ? Number(o.space) : undefined,
    delayMs: o.delay ? Number(o.delay) : undefined,
    waitLoginMin: o["wait-login"] ? Number(o["wait-login"]) : undefined,
    out: o.out,
  };
  if (cfg.configFile) ui.info(`配置 ${cfg.configFile}`);

  switch (cmd) {
    case "homophones": {
      for (const name of readNames(positionals, o.file)) {
        const vs = homophoneVariants(name, { top: Number(o.top ?? cfg.homophones.top), maxRank: Number(o["max-rank"] ?? cfg.homophones.maxRank) });
        console.log(`${name}\t${vs.map((v) => v.name).join(" ")}`);
      }
      return 0;
    }
    case "check": {
      const names = readNames(positionals, o.file);
      if (!names.length) {
        ui.warn("没有名称。用法：tm-check check 籁间 汀间 -H");
        return 1;
      }
      const bad = names.filter((n) => [...n].length > 20);
      if (bad.length) {
        ui.warn(`商标局检索要素最多 20 个字符：${bad.join("、")}`);
        return 1;
      }
      const classes = (o.cls ? o.cls.split(/[,，\s]+/) : cfg.classes).map(Number).filter((n) => n >= 1 && n <= 45);
      if (!classes.length) {
        ui.warn("类别必须是 1-45");
        return 1;
      }
      const mode = o.pinyin ? "py" : cfg.mode;
      const homophones = !!o.homophones;
      const jobs = planJobs(names, {
        classes,
        mode,
        homophones,
        top: Number(o.top ?? cfg.homophones.top),
        maxRank: Number(o["max-rank"] ?? cfg.homophones.maxRank),
      });
      const runId = `${stamp()}${o.tag ? `-${o.tag}` : ""}`;
      const runDir = join(runsDir(cfg, opts), runId);
      const meta = { runId, createdAt: new Date().toISOString(), names, classes, mode, homophones, space: opts.space ?? cfg.space ?? null, source: SEARCH_URL };
      const etaMin = Math.ceil((jobs.length * ((opts.delayMs ?? cfg.delayMs) + 8000)) / 60000);
      ui.info(`${names.length} 个名称 × ${classes.length} 类${homophones ? "（含同音）" : ""} = ${jobs.length} 次查询，约 ${etaMin} 分钟`);
      ui.info(`目录 ${runDir}`);
      if (o["dry-run"]) {
        for (const j of jobs) console.log(`${j.cls}\t${j.query}\t${j.kind === "homophone" ? `同音 ${j.name}` : ""}`);
        return 0;
      }
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
      await writeFile(join(runDir, "jobs.json"), JSON.stringify(jobs, null, 2));
      return runAndReport(runDir, cfg, opts);
    }
    case "resume": {
      const runDir = findRun(runsDir(cfg, opts), positionals[0]);
      if (!runDir) {
        ui.warn("找不到检索记录");
        return 1;
      }
      const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
      if (!opts.space && meta.space) opts.space = meta.space;
      ui.info(`续查 ${runDir}`);
      return runAndReport(runDir, cfg, opts);
    }
    case "report": {
      const runDir = findRun(runsDir(cfg, opts), positionals[0]);
      if (!runDir) {
        ui.warn("找不到检索记录");
        return 1;
      }
      const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
      const jobs = JSON.parse(readFileSync(join(runDir, "jobs.json"), "utf8"));
      const { rollup } = await writeReport(runDir, meta, jobs);
      printRollup(rollup, runDir);
      return 0;
    }
    case "list": {
      const dir = runsDir(cfg, opts);
      if (!existsSync(dir)) return 0;
      for (const d of readdirSync(dir).sort()) {
        const f = join(dir, d, "meta.json");
        if (!existsSync(f)) continue;
        const m = JSON.parse(readFileSync(f, "utf8"));
        console.log(`${d}\t${m.classes.join(",")}\t${m.names.join(" ")}`);
      }
      return 0;
    }
    case "doctor": {
      const script = `const IN=${JSON.stringify({ space: opts.space ?? cfg.space, spaceName: cfg.spaceName })};
const task = IN.space ? await takeOverTaskSpace(IN.space) : await taskSpace(IN.spaceName);
const q = task.page("p1");
let url = await q.url();
if (!/cnipa/.test(url)) { await q.goto(${JSON.stringify(SEARCH_URL)}); url = await q.url(); }
const text = await q.evaluate(() => document.body ? document.body.innerText.slice(0, 1500) : "");
const state = /sso\\.cnipa/.test(url) || /个人用户登录/.test(text) ? "login" : /云安全平台检测到/.test(text) ? "risk" : /商标近似查询|检索要素/.test(text) ? "ok" : "unknown";
console.log("@@TM " + JSON.stringify({ type: "doctor", spaceId: task.spaceId, name: task.name, url, state }));`;
      let info = null;
      const code = await runEgo(script, { onEvent: (e) => (info = e), onLog: (l) => ui.debug(l) });
      if (!info) {
        ui.warn(`ego-browser 调用失败（exit ${code}）。确认 Ego Lite 已打开，或加 -v 看原始输出`);
        return 2;
      }
      const label = { ok: "已登录，可以查询", login: "需要登录：在该空间里登录商标局后再跑", risk: "触发风控，稍后再试", unknown: "页面状态未知" }[info.state];
      console.log(`空间 ${info.spaceId}「${info.name}」\n${info.url}\n${label}`);
      return info.state === "ok" ? 0 : 2;
    }
    default:
      ui.warn(`未知命令 ${cmd}`);
      console.log(HELP);
      return 1;
  }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack ?? err);
      process.exit(1);
    }
  );
}
