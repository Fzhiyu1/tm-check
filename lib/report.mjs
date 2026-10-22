import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { latestById, readResults } from "./run.mjs";

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/** 结果行与检索词的关系：same=图样文字与检索词相同，contains=包含检索词，other=其他近似。 */
export function classifyRow(row, query) {
  const mark = norm(row.mark);
  const q = norm(query);
  if (!mark) return "unknown";
  if (mark === q) return "same";
  if (mark.includes(q)) return "contains";
  return "other";
}

export function summarize(jobs, results) {
  const latest = latestById(results);
  return jobs.map((job) => {
    const r = latest.get(job.id);
    const rows = r?.rows ?? [];
    const tagged = rows.map((row) => ({ ...row, rel: classifyRow(row, job.query) }));
    const same = tagged.filter((x) => x.rel === "same");
    const unknownMarks = tagged.length > 0 && tagged.every((x) => x.rel === "unknown");
    let verdict;
    if (!r) verdict = "未查";
    else if (r.status !== "ok") verdict = `失败:${r.status}`;
    else if (same.length) verdict = "相同";
    else if (r.total === 0) verdict = "无结果";
    else if (unknownMarks) verdict = "待看图";
    else verdict = "无相同";
    return { job, result: r, rows: tagged, same, verdict };
  });
}

const tsvCell = (s) => String(s ?? "").replace(/[\t\n\r]+/g, " ");

export function toTsv(summary, topN = 5) {
  const head = ["名称", "类别", "检索词", "来源", "方式", "结论", "检索件数", "相同商标", `前${topN}条（注册号/商标/申请人）`, "截图"];
  const lines = [head.join("\t")];
  for (const s of summary) {
    const { job, result } = s;
    lines.push(
      [
        job.name,
        job.cls,
        job.query,
        job.kind === "homophone" ? `同音:${job.name}` : "原名",
        job.mode === "py" ? "拼音" : "汉字",
        s.verdict,
        result?.total ?? "",
        s.same.map((x) => `${x.regNo} ${x.applicant}`).join("；"),
        s.rows
          .slice(0, topN)
          .map((x) => `${x.regNo}/${x.mark || "?"}/${x.applicant}`)
          .join("；"),
        result?.shot ?? "",
      ]
        .map(tsvCell)
        .join("\t")
    );
  }
  return lines.join("\n") + "\n";
}

/** 按名称汇总：任何一个类别、任何一个同音变体出现相同商标都算冲突。 */
export function rollupByName(summary) {
  const by = new Map();
  for (const s of summary) {
    const key = s.job.name;
    if (!by.has(key)) by.set(key, { name: key, hits: [], pending: [], failed: [] });
    const g = by.get(key);
    if (s.verdict === "相同") g.hits.push(`${s.job.cls}类「${s.job.query}」${s.same.map((x) => x.applicant).join("、")}`);
    else if (s.verdict === "待看图") g.pending.push(`${s.job.cls}类「${s.job.query}」`);
    else if (s.verdict.startsWith("失败") || s.verdict === "未查") g.failed.push(`${s.job.cls}类「${s.job.query}」${s.verdict}`);
  }
  return [...by.values()].map((g) => ({
    ...g,
    status: g.hits.length ? "冲突" : g.failed.length ? "不完整" : g.pending.length ? "待人工看图" : "未见相同",
  }));
}

export function toMarkdown(meta, rollup, summary) {
  const out = [];
  out.push(`# 商标近似检索 ${meta.runId}`, "");
  out.push(`- 时间：${meta.createdAt}`);
  out.push(`- 类别：${meta.classes.join("、")}；方式：${meta.mode === "py" ? "拼音" : "汉字"}；同音扩展：${meta.homophones ? "是" : "否"}`);
  out.push(`- 来源：国家知识产权局商标局商标近似查询（wcjs.sbj.cnipa.gov.cn），仅供参考，不具有法律效力`);
  out.push(`- 「未见相同」只表示检索结果的图样文字里没有与检索词完全相同的商标，近似判断仍需人工或代理确认`, "");
  out.push("| 名称 | 结论 | 说明 |", "|---|---|---|");
  for (const g of rollup) {
    const note = [...g.hits, ...g.failed, ...g.pending.map((x) => `${x} 待看图`)].join("；") || "";
    out.push(`| ${g.name} | ${g.status} | ${note} |`);
  }
  out.push("", "明细见 `summary.tsv`，截图在 `shots/`，拼图在 `sheets/`。", "");
  const failed = summary.filter((s) => s.verdict.startsWith("失败") || s.verdict === "未查");
  if (failed.length) out.push(`未完成 ${failed.length} 条，可执行 \`tm-check resume ${meta.runId}\` 续查。`, "");
  return out.join("\n");
}

/** 把每张结果截图的表头 + 前几行裁出来，按名称拼成一张图，方便人工过目。 */
export async function buildSheets(runDir, summary, { rowsHeight = 560 } = {}) {
  if (!hasMagick()) return [];
  const dir = join(runDir, "sheets");
  await mkdir(dir, { recursive: true });
  const groups = new Map();
  for (const s of summary) {
    const shot = s.result?.shot;
    if (!shot || !existsSync(shot)) continue;
    if (!groups.has(s.job.name)) groups.set(s.job.name, []);
    groups.get(s.job.name).push({ shot, label: `${s.job.cls}类 ${s.job.query} ${s.result.total ?? "?"}件 ${s.verdict}` });
  }
  const outs = [];
  for (const [name, items] of groups) {
    const out = join(dir, `${name}.png`);
    const args = [];
    for (const it of items) {
      args.push("(", it.shot, "-crop", `1000x${rowsHeight}+90+60`, "+repage", "-resize", "50%", "-set", "label", it.label, ")");
    }
    execFileSync("magick", ["montage", ...args, "-font", fontPath(), "-pointsize", "14", "-tile", `${Math.min(items.length, 4)}x`, "-geometry", "+6+6", "-background", "white", out]);
    outs.push(out);
  }
  return outs;
}

function hasMagick() {
  try {
    execFileSync("magick", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fontPath() {
  for (const f of ["/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc"]) {
    if (existsSync(f)) return f;
  }
  return "Helvetica";
}

export async function writeReport(runDir, meta, jobs, { sheets = true } = {}) {
  const results = readResults(join(runDir, "results.jsonl"));
  const summary = summarize(jobs, results);
  const rollup = rollupByName(summary);
  await writeFile(join(runDir, "summary.tsv"), toTsv(summary));
  await writeFile(join(runDir, "report.md"), toMarkdown(meta, rollup, summary));
  const sheetFiles = sheets ? await buildSheets(runDir, summary) : [];
  return { summary, rollup, sheetFiles };
}
