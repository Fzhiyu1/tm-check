// 生成在 ego-browser 内嵌 Node 中运行的查询脚本。
// ego 运行时读不到外部环境变量，所以所有输入都以 JSON 字面量写进脚本。
// 脚本逐条追加 JSONL，遇到登录失效 / 风控时输出状态行并以对应退出码结束，由外层调度续查。

export const EXIT = { OK: 0, LOGIN: 20, RISK: 21, FORM: 22 };
export const SEARCH_URL = "https://wcjs.sbj.cnipa.gov.cn/sistm";


export function buildDriverScript({ space, spaceName, jobs, resultsFile, shotsDir, resultWaitMs, delayMs }) {
  const input = JSON.stringify({ space, spaceName, jobs, resultsFile, shotsDir, resultWaitMs, delayMs, EXIT, SEARCH_URL });
  return `const IN = ${input};
${RUNTIME}`;
}

// 运行在 ego-browser 里的代码。只用 skill 中列出的 TaskSpace / Page API。
const RUNTIME = String.raw`
const fs = await import("node:fs/promises");
await fs.mkdir(IN.shotsDir, { recursive: true });
const say = (o) => console.log("@@TM " + JSON.stringify(o));

let task;
if (IN.space) {
  try { task = await takeOverTaskSpace(IN.space); } catch (e) { say({ type: "warn", msg: "空间 " + IN.space + " 不可用，改用「" + IN.spaceName + "」：" + String(e.message || e).slice(0, 80) }); }
}
if (!task) task = await taskSpace(IN.spaceName);
say({ type: "space", spaceId: task.spaceId, name: task.name });
// 查询页：优先复用已打开的 /sistm 页（直接 goto 会被 WAF 以 403 拦截，需从首页点进）。
let q = task.page("p1");
for (const p of await task.pages()) {
  try { if (/wcjs\.sbj\.cnipa\.gov\.cn\/sistm/.test(await p.url())) { q = p; break; } } catch {}
}

const CLS_INPUT = 'loc=css:input[placeholder^="(输入：1－45"]';
const KW_INPUT = 'loc=css:input[placeholder="请输入1-20个字符"]';

async function closeExtras() {
  for (const p of await task.pages()) if (p.label !== q.label) await p.close().catch(() => {});
}

async function pageState(p) {
  const url = await p.url();
  if (/sso\.cnipa\.gov\.cn/.test(url)) return "login";
  const text = await p.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : "");
  if (/云安全平台检测到|访问行为存在异常|请稍后重试|请求被阻断/.test(text)) return "risk";
  if (/统一身份认证|个人用户登录/.test(text)) return "login";
  return "ok";
}

async function ensureForm() {
  let st = await pageState(q);
  if (st !== "ok") return st;
  if (!/\/sistm/.test(await q.url())) {
    await q.goto(IN.SEARCH_URL);
    st = await pageState(q);
    if (st !== "ok") return st;
  }
  try {
    await q.waitForSelector(KW_INPUT, { timeout: 8000 });
  } catch {
    st = await pageState(q);
    return st === "ok" ? "form" : st;
  }
  return "ok";
}

// 结果页解析：优先读页面里的结构化数据，退化到表格单元格。
function parseResultPage() {
  if (!document.body) return { total: null, rows: [], empty: false };
  const text = document.body.innerText;
  const m = text.match(/检索到\s*(\d+)\s*件/) || text.match(/总记录数[:：]\s*(\d+)/);
  const total = m ? Number(m[1]) : null;
  const rows = [];
  for (const tr of document.querySelectorAll("tr")) {
    const tds = [...tr.querySelectorAll("td")];
    if (tds.length < 5) continue;
    const cells = tds.map((td) => td.innerText.trim());
    const regIdx = cells.findIndex((c) => /^[A-Z]?\d{5,}$/.test(c));
    if (regIdx < 0) continue;
    const markTd = tds[regIdx + 2];
    const img = markTd ? markTd.querySelector("img") : null;
    const markText = (markTd && markTd.innerText.trim()) || (img && (img.alt || img.title)) || "";
    rows.push({
      seq: Number(cells[regIdx - 1]) || rows.length + 1,
      regNo: cells[regIdx],
      date: cells[regIdx + 1] || "",
      mark: markText,
      applicant: cells[regIdx + 3] || "",
    });
  }
  return { total, rows, empty: /未查询到|没有查询到|无相关|检索到\s*0\s*件/.test(text) };
}

async function runJob(job) {
  await q.fill(CLS_INPUT, String(job.cls));
  await q.evaluate((i) => document.querySelectorAll('input[type=radio]')[i].click(), job.mode === "py" ? 1 : 0);
  await q.fill(KW_INPUT, job.query);
  const before = new Set((await task.pages()).map((p) => p.label));
  const r = await q.click("loc=css:input.bottonb", { label: "查 " + job.cls + " 类 " + job.query });
  let label = r && r.popups && r.popups[0] && r.popups[0].label;
  const deadline = Date.now() + IN.resultWaitMs;
  let p = null;
  while (Date.now() < deadline) {
    const pages = await task.pages();
    p = pages.find((x) => x.label === label) || pages.find((x) => !before.has(x.label));
    if (p) break;
    await q.waitForTimeout(300);
  }
  if (!p) {
    const st = await pageState(q);
    return { status: st === "ok" ? "no-popup" : st };
  }
  let parsed = null;
  while (Date.now() < deadline) {
    const st = await pageState(p);
    if (st !== "ok") { await p.close().catch(() => {}); return { status: st }; }
    parsed = await p.evaluate(parseResultPage).catch(() => null);
    if (!parsed) { await p.waitForTimeout(500); continue; }
    if (parsed.total !== null || parsed.rows.length || parsed.empty) break;
    await p.waitForTimeout(500);
  }
  // 商标图是懒加载的，截图前等表格里的图片加载完（最多 8 秒）。
  const imgDeadline = Date.now() + 8000;
  while (Date.now() < imgDeadline) {
    const pending = await p.evaluate(() => [...document.images].filter((i) => !i.complete || /loading|\.gif$/i.test(i.src)).length).catch(() => 0);
    if (!pending) break;
    await p.waitForTimeout(500);
  }
  const shot = IN.shotsDir + "/" + job.id + ".png";
  await p.screenshot({ path: shot, fullPage: true }).catch(() => p.screenshot({ path: shot }));
  await p.close().catch(() => {});
  if (!parsed || (parsed.total === null && !parsed.rows.length && !parsed.empty)) return { status: "timeout", shot };
  return { status: "ok", total: parsed.empty && parsed.total === null ? 0 : parsed.total, rows: parsed.rows, shot };
}

await closeExtras();
for (const job of IN.jobs) {
  const st = await ensureForm();
  if (st === "login") { say({ type: "halt", reason: "login", job: job.id }); process.exit(IN.EXIT.LOGIN); }
  if (st === "risk") { say({ type: "halt", reason: "risk", job: job.id }); process.exit(IN.EXIT.RISK); }
  if (st === "form") { say({ type: "halt", reason: "form", job: job.id }); process.exit(IN.EXIT.FORM); }
  let res;
  try {
    res = await runJob(job);
  } catch (e) {
    res = { status: "error", error: String(e && e.message || e).slice(0, 200) };
    await closeExtras();
  }
  if (res.status === "login" || res.status === "risk") {
    say({ type: "halt", reason: res.status, job: job.id });
    process.exit(res.status === "login" ? IN.EXIT.LOGIN : IN.EXIT.RISK);
  }
  const rec = { ...job, ...res, at: new Date().toISOString() };
  await fs.appendFile(IN.resultsFile, JSON.stringify(rec) + "\n");
  say({ type: "result", id: job.id, status: rec.status, total: rec.total ?? null });
  await q.waitForTimeout(IN.delayMs);
}
say({ type: "done" });
`;
