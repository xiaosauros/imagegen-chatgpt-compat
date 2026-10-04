# imagegen-chatgpt-compat 设计依据与排障笔记

整理自社区对 Codex image_gen / `$imagegen` 版本差异与稳定方案的调查。结论先行的版本是"当前可确认的事实 + 合理推断"，凡是没有证据的不写死进脚本。

## 问题现象

新版 Codex 调用 `https://chatgpt.com/backend-api/codex/images/generations`（编辑走 `.../images/edits`）生成复杂图片时，等待数分钟后失败，被包装成 generic：

```text
image generation failed: network error:
error sending request for url (https://chatgpt.com/backend-api/codex/images/generations)
```

公开复现的失败时间并不固定（约 240s / 265s / 304s / 308s / 312s / 319s），所以**没有证据**表明存在统一的 180 秒硬编码超时。更可能的模型是：长请求 → transport / gateway / proxy / response lifecycle 某一层失败 → Codex 包装成 generic "network error"。失败点可能在客户端 transport，也可能在 ChatGPT edge/backend、代理或长连接生命周期，客户端无法直接修复。

## 为什么选 0.143.0（以及它不是什么）

- 社区 workaround（eagleskyai/codex-imagegen-143）的核心是**版本隔离**：把生图整体委托给 `@openai/codex@0.143.0` 子进程执行，而不是修改 HTTP timeout、不做无限 retry、不 patch reqwest/endpoint。
- 0.143.0 → 0.144.0 附近，`models.json`、模型 metadata、fallback metadata、input modalities、image_generation tool 暴露与 routing 发生过明显变化，是重点调查边界。
- 更早的 0.139.0 → 0.142.x 之间，参考图 / image-to-image 行为也变过。所以 image_gen 在这一系列版本里一直在调整，0.143.0 只是"社区验证过的纯生图稳定点"，不是唯一正确版本，更不保证永远兼容未来模型。

## 已确认事实

1. 新版存在长等待后 network error 的公开复现；失败时间不固定在 180s。
2. workaround 的本质是版本回退，不是 timeout 补丁。
3. `0.143.0 → 0.144.0` 附近模型 metadata / capability routing 有明显变化。
4. Codex 客户端 skill 部分开源（如 `codex-rs/skills/src/assets/samples/imagegen/`，含 SKILL.md、references/、scripts/image_gen.py）；`chatgpt.com/backend-api/codex/images/*` 背后的服务端**不开源**（真正的 image model、quota、gateway timeout、调度、服务端 retry 都看不到）。
5. sample `image_gen.py` 里的 retry 逻辑（transient error、指数 backoff）**不等于** Codex 内置 `/images/generations` 的行为，不能由脚本里的数字反推内置 timeout。
6. `-m` 指定的是执行 Codex agent / `$imagegen` 调用的通用模型，**不必然等于**底层生成像素的 image model。
7. Codex 模型不是编译期写死：内置 models catalog + 服务端模型信息 + 配置覆盖 + fallback metadata；旧 CLI 对未来新模型的 capability 判断不一定正确——这是固定旧版本方案的长期风险。

## 仍属推断（不要写死进方案）

- 新版失败一定是 reqwest timeout；一定存在固定 300s ClientBuilder timeout。
- 新旧版本使用完全不同的 backend endpoint（无明确证据，URL 基本相同/相近）。
- 0.144.0 中某一个单独 commit 是全部根源。
- 0.143.0 永远兼容未来新模型 / 能正确暴露其 image_generation tool。

## 本脚本的工程决策

| 决策 | 理由 |
|---|---|
| prompt 走 stdin 传给 `codex exec` | 多行/含引号 prompt 不经过命令行转义；Windows 下经 npx 多层传参引号会被剥离 |
| `-c model_reasoning_effort=medium` 用裸值 | codex `-c` 对非 TOML 值按字面字符串处理（官方帮助明示）；实测穿透 npx 链路可用 |
| 子进程 cwd = 输出目录 + `--sandbox workspace-write` | 子 agent 把成图复制到"当前目录"不需要越权；imagegen 工具本身由 CLI 核心发起 HTTP，不受 sandbox 影响 |
| 图片定位顺序：输出目录(本次) → 子进程输出中的现存路径 → `~/.codex/generated_images`(本次) | imagegen 工具默认把成图落在 `~/.codex/generated_images/<uuid>/`；agent 移动文件会保留 mtime，所以文本提取是必要补充。不能用输出目录旧图片兜底，否则可能误报成功 |
| 不依赖 `--output-last-message` | 0.143.0 当前官方 npm 包的 `codex exec --help` 已列出该 flag；脚本直接读取 stdout/stderr 并扫描本次生成图片，省去每次额外的帮助探测 |
| network error 最多重试 1 次 | 一次失败可能已消耗 4~5 分钟；反复重试浪费额度。model/tool 不可用才是"换池"信号，且失败很快 |
| 不自动二次视觉 review | 生成 → 重开图 → 视觉分析 → 再改的流程会成倍消耗额度/时间；用户明确要求才 review |

## 版本池维护清单

1. 社区/官方确认新的稳定版本后，加入 `IMAGEGEN_CODEX_VERSIONS`（稳定版在前），不要删旧稳定版。
2. 模型下架（`model_unsupported`）→ 更新 `IMAGEGEN_MODEL` / `IMAGEGEN_MODEL_FALLBACKS` 为当前套餐可用模型。
3. 旧 CLI 不认识新模型（换模型也失败）→ 说明需要更新的 CLI：把最新验证版本加入池，或临时 `--codex-versions latest`（注意 latest 可能正是有 regression 的版本，network error 会很快停止不重试）。
4. 需要排查环境时跑：`node scripts/imagegen.mjs --self-check`（验证每个版本 CLI 启动与 ChatGPT 登录态，不调用生图）。正常生图调用会自动执行 CLI 启动检查，无需单独自检。

## 想继续定位根因时

diff `rust-v0.143.0..rust-v0.144.0`，搜索：`image_generation`、`images/generations`、`images/edits`、`reqwest`、`timeout`、`ClientBuilder`、`model_info_from_slug`、`input_modalities`、`models.json`、`retry`；重点目录：`codex-rs/models-manager/`、`codex-rs/core/src/tools/`、`codex-rs/protocol/`、app-server 与 image generation 集成。要回答的问题：请求怎么构造、tool 怎么注册、capability 怎么判断、HTTP client 怎么等待，以及哪一项变化最可能导致"简单图成功、复杂图几分钟后 network error"。

## 已知限制

- Windows 下参考图路径经 npx 传递：路径含空格理论上可能出问题（promise-spawn 会加引号，通常没事）；遇到问题时把文件复制到无空格路径再传。
- 服务端 4~5 分钟级失败客户端无解；脚本只能保证"失败尽快、类型明确、不浪费重试"。
- 首次使用某个池版本时 npx 要下载 CLI 和平台二进制；macOS arm64 实测约 4 分钟。脚本使用可写的临时 npm 缓存，并在安装期间报告进度。受限执行环境若阻止访问外网或本机代理，仍需给该次命令联网权限。
