---
name: imagegen-chatgpt-compat
description: "通过 ChatGPT/Codex 套餐额度生成或编辑图片（文生图、图生图、参考图改图）。把生图整体委托给经过验证的稳定版本 Codex CLI（默认 0.143.0），以 codex exec + $imagegen 子进程方式执行，规避新版 Codex image_gen 长请求数分钟后 network error 的回归。凡用户要求生成图片、修改图片、按参考图作图，或当前环境 image_gen 工具报 network error / error sending request / 长时间等待后失败时，都使用本技能；不使用 OPENAI_API_KEY，不调用 OpenAI Image API。"
---

# ChatGPT 生图兼容层（imagegen-chatgpt-compat）

把生图请求委托给一个固定、经过验证稳定的旧版本 Codex CLI 子进程执行，而不是用当前主 Agent 自带的 image_gen 工具。只消耗 ChatGPT / Codex 套餐额度，不使用 `OPENAI_API_KEY`，不调用 OpenAI Image API。

核心原则：

1. 一次 `codex exec` → 一次 `$imagegen` → 保存 → 返回路径。**不要**生成后再打开图片做视觉 review、再修改、再重生成，除非用户明确要求。
2. 用户 prompt **原样传递**：不重写、不翻译、不扩写、不重新解释。执行类指令（保存位置、输出路径）由脚本自动附加，不要自己拼接进 prompt。
3. 失败按类型处理（见下表），**network error 最多自动重试 1 次**后停止——一次失败本身可能已经消耗了 4~5 分钟的等待窗口，反复重试非常浪费额度。

## 前置条件

- 本机已安装 Node.js / npm（脚本通过 npx 拉起指定版本 CLI）。
- 用户已用 ChatGPT 账号登录 Codex（`codex login`）。脚本默认会从子进程环境中删除 `OPENAI_API_KEY`，强制走 ChatGPT 登录态。
- 首次运行某个版本时 npx 需要下载该包（约几十秒），之后有缓存。

## 用法

脚本位于本技能目录下 `scripts/imagegen.mjs`，用绝对路径调用。在目标输出目录（或其父目录）的工作目录里执行：

纯文生图：

```bash
node "<本技能目录>/scripts/imagegen.mjs" "用户给出的原始 prompt" --out-dir ./generated
```

图生图 / 参考图改图（`-i` 必须用绝对路径，可多次）：

```bash
node "<本技能目录>/scripts/imagegen.mjs" "Replace the background with ..." \
  -i /absolute/path/to/source.png \
  -i /absolute/path/to/style.jpg \
  --out-dir ./generated
```

先做连通性检查（不消耗额度，只打印各版本 CLI 是否可用）：

```bash
node "<本技能目录>/scripts/imagegen.mjs" --self-check
```

预览将执行的完整命令与传给子进程的 prompt（不实际执行）：

```bash
node "<本技能目录>/scripts/imagegen.mjs" "..." --dry-run
```

成功时脚本 stdout 会输出机器可读的结果块，取 `IMAGE_PATH` 返回给用户：

```text
RESULT: success
IMAGE_PATH: D:\work\generated\a1b2.png
CLI_VERSION: 0.143.0
MODEL: gpt-5.5
ATTEMPTS: 1
```

## 失败处理

脚本结束时 stdout 输出 `RESULT: failure` + `FAILURE_TYPE`。按类型行动，**不要**用相同版本+相同模型盲目重试：

| FAILURE_TYPE | 含义 | 应该做什么 |
|---|---|---|
| `model_unsupported` | 该 CLI 版本不认识/不支持该模型 | 用 `--model` 指定一个当前套餐可用的模型重试一次（例如主 Agent 当前正在用的模型）；仍失败则说明旧 CLI 对新模型的 capability 判断有问题，改用 `--codex-versions` 换版本 |
| `tool_unavailable` | 该 CLI 版本未暴露 image_generation 工具 | CLI 版本与模型能力不兼容：用 `--codex-versions` 换一个已验证稳定的版本 |
| `network_error` | 传输层/网关层失败（脚本已自动重试 1 次） | 停止。向用户说明失败现象与耗时，建议稍后再试或缩小图片复杂度；不要继续重试 |
| `auth_error` | 未登录或登录态不可用 | 让用户运行 `codex login` 重新登录后重试 |
| `quota_error` | 套餐额度/限流 | 停止，告知用户额度问题 |
| `no_image_found` | 子进程正常结束但没找到图片文件 | 把脚本 stderr 里的子进程输出 tail 给用户，检查 prompt 是否被模型拒绝 |
| `unknown_error` | 其他 | 读取脚本 stderr 的输出 tail 判断，不要自动重试 |

## 配置项

全部可用环境变量覆盖（也可用同名 CLI 参数临时覆盖单次调用）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `IMAGEGEN_CODEX_VERSIONS` | `0.143.0` | CLI 版本池，逗号分隔，按序尝试 |
| `IMAGEGEN_MODEL` | `gpt-5.5` | 主模型（agent 模型，不必然等于底层生图模型） |
| `IMAGEGEN_MODEL_FALLBACKS` | 空 | 备用模型池，逗号分隔；model_unsupported 时按序切换 |
| `IMAGEGEN_MAX_NETWORK_RETRIES` | `1` | network error 最大重试次数，不要调大 |
| `IMAGEGEN_TIMEOUT_SECONDS` | `600` | 单次子进程超时；`0` 表示不限时 |
| `IMAGEGEN_REASONING_EFFORT` | `medium` | 传给 `-c model_reasoning_effort=` |
| `IMAGEGEN_ALLOW_API_KEY` | `0` | 设为 `1` 才允许子进程环境保留 `OPENAI_API_KEY` |

示例：

```bash
export IMAGEGEN_CODEX_VERSIONS="0.143.0"
export IMAGEGEN_MODEL="gpt-5.5"
export IMAGEGEN_MODEL_FALLBACKS="gpt-6.1-sol"
```

## 版本与模型维护

- `0.143.0` 是社区验证过的纯生图稳定点，**不是**因为它有特殊超时，而是该版本的模型能力解析与 tool routing 与后续版本不同。背景与证据见 `references/notes.md`。
- 不要长期写死"某个版本 + 某个模型"：模型会下架，旧 CLI 对未来新模型的 tool capability 判断也不保证正确。策略是**固定兼容策略，不固定具体版本/模型**——出问题改环境变量，不改脚本。
- 社区确认了新的稳定版本后，把它加进 `IMAGEGEN_CODEX_VERSIONS` 池（保留旧稳定版在前）。
- 自定义 prompt 已由脚本原样传给子进程；如果需要调整子进程收到的执行指令（保存位置等），改脚本常量而不是在调用处拼接。

## 设计依据与排障

- 为什么不是 180 秒硬超时、为什么选 0.143.0、失败时间观测数据、endpoint 说明：读 `references/notes.md`。
- 排障时先看脚本 stderr（含每次尝试的退出码、耗时、子进程输出 tail），再用 `--dry-run` 检查实际命令。
