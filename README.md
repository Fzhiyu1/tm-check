# tm-check

国家知识产权局商标局「商标近似查询」的批量查询 CLI。商标局没有公开接口，且 API 请求带反爬签名（`FECU`），所以这里驱动 Ego Lite 里已登录的页面查询，结果以商标局页面为准。

## 用法

```sh
tm-check doctor                         # 检查 ego-browser 与登录状态
tm-check check 籁间 汀间 -H             # 9/41/42 类，含常用同音字变体
tm-check check -f names.txt -c 9,42     # 从文件读名称
tm-check check 籁间 -H -n               # 只看会查哪些，不查
tm-check homophones 声息间              # 只打印同音变体
tm-check resume                         # 登录失效/风控中断后续查
tm-check report                         # 重新生成报告
tm-check list
```

每次检索生成一个目录：`meta.json`、`jobs.json`、`results.jsonl`（逐条追加，可续查）、`summary.tsv`、`report.md`、`shots/`（结果页整页截图）、`sheets/`（按名称拼好的前排结果图）。

## 判定口径

- **冲突**：某类、某检索词的结果里，有图样文字与检索词完全相同的商标。
- **未见相同**：结果里没有完全相同的，但近似（如「松息间」对「声息间」）不在自动判定范围内，要看 `sheets/` 或交给代理。
- **待人工看图**：图形商标读不出文字。
- **不完整**：有查询失败，执行 `resume`。

同音扩展：每次替换一个字为字频前 3000 的常用同音字（每字默认取 3 个，多音字取所有读音）。商标局的拼音检索只匹配商标登记的拼音，查不出同音不同字的商标，所以同音冲突必须用汉字逐个查。

## 稳定性

- 默认间隔 4 秒，每次约 10 秒。
- 登录失效（跳到 `sso.cnipa.gov.cn`）时响铃并等待最多 30 分钟，用户在同一空间重新登录后自动继续。
- 出现「云安全平台检测到…访问行为异常」时指数退避（1/2/4/8 分钟），超过 4 次停止。
- 退出码：0 完成，1 参数错误，2 未完成（可 `resume`）。

## 配置

从当前目录向上查找 `.tm-check.json`，例如冥想项目 `~/run/meditation/.tm-check.json`：

```json
{ "classes": [9, 41, 42], "spaceName": "商标查询", "outDir": "软著工作区/商标检索" }
```

可选字段：`space`（固定 Ego 空间 id）、`delayMs`、`resultWaitMs`、`mode`（`cn`/`py`）、`homophones.top`、`homophones.maxRank`。

## 开发

```sh
npm test               # 单元测试（不访问网络）
npm run build-data     # 重新生成 data/homophones.json（需 devDependencies）
```

`lib/driver.mjs` 里的 `RUNTIME` 运行在 ego-browser 内嵌 Node 中，只能用 ego 的 TaskSpace/Page API，且读不到外部环境变量，输入以 JSON 字面量注入。
