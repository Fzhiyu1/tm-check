import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDriverScript, EXIT } from "./driver.mjs";

export const DONE_STATUSES = new Set(["ok"]);

export function jobId(job) {
  return `${job.mode}${job.cls}-${job.query}`;
}

export function readResults(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** 同一 job 以最后一次结果为准。 */
export function latestById(results) {
  const map = new Map();
  for (const r of results) map.set(r.id, r);
  return map;
}

export function pendingJobs(jobs, resultsFile) {
  const done = latestById(readResults(resultsFile));
  return jobs.filter((j) => !DONE_STATUSES.has(done.get(j.id)?.status));
}

/** 运行一段 ego-browser 脚本，逐行回调 @@TM 状态。 */
export function runEgo(script, { onEvent = () => {}, onLog = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const handle = (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("@@TM ")) onEvent(JSON.parse(line.slice(5)));
        else if (line.trim() && !line.startsWith("[ego-browser:notice]")) onLog(line);
      }
    };
    child.stdout.on("data", (d) => handle(d.toString()));
    child.stderr.on("data", (d) => handle(d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (buf.trim()) handle(buf + "\n");
      resolve(code);
    });
    child.stdin.end(script);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑完 runDir 里所有未完成的 job。登录失效时等待用户重新登录，风控时退避。
 */
export async function executeRun(runDir, cfg, opts, ui) {
  const jobs = JSON.parse(readFileSync(join(runDir, "jobs.json"), "utf8"));
  const resultsFile = join(runDir, "results.jsonl");
  const shotsDir = join(runDir, "shots");
  await mkdir(shotsDir, { recursive: true });
  let riskStrikes = 0;
  let loginWaitedMs = 0;
  let space = opts.space ?? cfg.space;

  for (;;) {
    const pending = pendingJobs(jobs, resultsFile);
    if (!pending.length) return { ok: true };
    ui.info(`待查 ${pending.length} / ${jobs.length}`);
    const script = buildDriverScript({
      space,
      spaceName: cfg.spaceName,
      jobs: pending,
      resultsFile,
      shotsDir,
      resultWaitMs: cfg.resultWaitMs,
      delayMs: opts.delayMs ?? cfg.delayMs,
    });
    await writeFile(join(runDir, "last-driver.mjs"), script);
    let halt = null;
    const code = await runEgo(script, {
      onEvent: (ev) => {
        if (ev.type === "space") {
          if (!space) ui.info(`ego 空间 ${ev.spaceId}「${ev.name}」`);
          space = ev.spaceId;
        } else if (ev.type === "result") ui.result(ev);
        else if (ev.type === "halt") halt = ev;
        else if (ev.type === "warn") ui.warn(ev.msg);
      },
      onLog: (line) => ui.debug(line),
    });

    if (code === EXIT.LOGIN || halt?.reason === "login") {
      const limit = (opts.waitLoginMin ?? 30) * 60_000;
      if (loginWaitedMs >= limit) return { ok: false, reason: "login", space };
      ui.warn(`商标局登录已失效。请在 Ego Lite 空间 ${space} 里重新登录并打开商标近似查询页，登录后自动继续…`);
      ui.bell();
      const step = 15_000;
      await sleep(step);
      loginWaitedMs += step;
      continue;
    }
    if (code === EXIT.RISK || halt?.reason === "risk") {
      riskStrikes += 1;
      if (riskStrikes > (opts.maxRisk ?? 4)) return { ok: false, reason: "risk", space };
      const backoff = 60_000 * 2 ** (riskStrikes - 1);
      ui.warn(`触发商标局风控提示，退避 ${backoff / 1000}s 后继续（第 ${riskStrikes} 次）`);
      await sleep(backoff);
      continue;
    }
    if (code === EXIT.FORM || halt?.reason === "form") {
      return { ok: false, reason: "form", space };
    }
    if (code !== 0) return { ok: false, reason: `ego exit ${code}`, space };
    loginWaitedMs = 0;
    riskStrikes = 0;
    // 本轮正常结束但仍有失败 job（超时等）时，只自动重试一轮
    const left = pendingJobs(jobs, resultsFile);
    if (!left.length) return { ok: true, space };
    if (opts._retried) return { ok: false, reason: "partial", space, left: left.length };
    opts._retried = true;
  }
}
