# imagegen-chatgpt-compat

通过 ChatGPT/Codex 套餐额度生成或编辑图片（文生图、图生图、参考图改图）的兼容层。把生图请求整体委托给固定、经过验证稳定的旧版本 Codex CLI（`codex exec` + `$imagegen` 子进程）执行，只消耗 ChatGPT / Codex 套餐额度——**不使用 `OPENAI_API_KEY`，不调用 OpenAI Image API**。

## 背景

新版 Codex CLI 生成复杂图片时存在回归：长请求等待数分钟后失败，被包装成 generic `network error`（失败时间不固定，无统一硬编码超时，客户端无法直接修复）。本项目的方案是**版本隔离**：固定一个社区验证过的纯生图稳定版本（默认 `0.143.0`）作为子进程执行生图，绕开该回归。完整的失败时间观测、版本差异分析与排障笔记见 [`references/notes.md`](references/notes.md)。

## 目录结构

```text
SKILL.md               技能说明（Agent 调用入口：行为准则、失败处理表、配置项）
agents/openai.yaml     接口元数据（显示名 / 短描述 / 默认 prompt）
references/notes.md    设计依据与排障笔记（为什么选 0.143.0、工程决策、根因调查线索）
scripts/imagegen.mjs   主脚本（参数解析、版本/模型池切换、失败分类、图片定位）
```

## 核心行为

1. 一次 `codex exec` → 一次 `$imagegen` → 保存 → 返回路径。不做生成后视觉 review、不自动改图重生成（用户明确要求除外）。
2. 用户 prompt **原样传递**：不重写、不翻译、不扩写；执行类指令（保存位置、输出绝对路径）由脚本自动附加。
3. 失败按类型分类处理：`model_unsupported` 切换模型池、`tool_unavailable` 切换版本池、`network_error` 最多自动重试 1 次后停止（一次失败可能已消耗 4~5 分钟额度窗口）、`auth_error` / `quota_error` / `unknown_error` 直接停止并给出建议。
4. prompt 经 stdin 传给子进程（规避 Windows 命令行转义），子进程 cwd 即输出目录 + `--sandbox workspace-write`。

## 前置条件

- 本机已安装 Node.js / npm（脚本通过 npx 拉起指定版本 CLI；Windows 下自动绕开 npx.cmd 批处理转义）。
- 已用 ChatGPT 账号登录 Codex（`codex login`）。脚本默认从子进程环境中删除 `OPENAI_API_KEY`，强制走 ChatGPT 登录态（`--allow-api-key` 可放开）。
- 首次运行某个版本时 npx 需要下载该包（约几十秒），之后走缓存。

## 用法

在目标输出目录（或其父目录）的工作目录里执行：

```bash
# 纯文生图
node "<本仓库>/scripts/imagegen.mjs" "用户给出的原始 prompt" --out-dir ./generated

# 图生图 / 参考图改图（-i 必须用绝对路径，可多次）
node "<本仓库>/scripts/imagegen.mjs" "Replace the background with ..." \
  -i /absolute/path/to/source.png \
  -i /absolute/path/to/style.jpg \
  --out-dir ./generated

# 连通性检查（不消耗额度：各版本 CLI 可用性、登录态、参数支持）
node "<本仓库>/scripts/imagegen.mjs" --self-check

# 预览将执行的完整命令与 stdin 内容（不实际执行）
node "<本仓库>/scripts/imagegen.mjs" "..." --dry-run
```

成功时 stdout 输出机器可读结果块，取 `IMAGE_PATH` 返回：

```text
RESULT: success
IMAGE_PATH: <输出目录>/a1b2.png
IMAGE_PATH_SOURCE: out_dir
CLI_VERSION: 0.143.0
MODEL: gpt-5.5
ATTEMPTS: 1
ELAPSED_SECONDS: 95.3
```

失败时输出 `RESULT: failure` + `FAILURE_TYPE` + `SUGGESTION`，按类型行动，不要用相同版本+相同模型盲目重试。完整失败类型对照表见 [`SKILL.md`](SKILL.md) 的「失败处理」一节。过程日志（每次尝试的退出码、耗时、子进程输出 tail）在 stderr。

## 配置项

全部可用环境变量覆盖（也可用同名 CLI 参数临时覆盖单次调用，完整列表见 `--help`）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `IMAGEGEN_CODEX_VERSIONS` | `0.143.0` | CLI 版本池，逗号分隔，按序尝试 |
| `IMAGEGEN_MODEL` | `gpt-5.5` | 主模型（agent 模型，不必然等于底层生图模型） |
| `IMAGEGEN_MODEL_FALLBACKS` | 空 | 备用模型池，逗号分隔；`model_unsupported` 时按序切换 |
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

## 版本与模型维护策略

**固定兼容策略，不固定具体版本/模型**——出问题改环境变量，不改脚本：

- `0.143.0` 是社区验证过的纯生图稳定点（模型能力解析与 tool routing 与后续版本不同），但不是唯一正确版本，也不保证永远兼容未来模型。
- 模型下架（`model_unsupported`）→ 更新 `IMAGEGEN_MODEL` / `IMAGEGEN_MODEL_FALLBACKS` 为当前套餐可用模型。
- 换模型仍失败 → 说明旧 CLI 无法识别新模型，把新的验证版本加入 `IMAGEGEN_CODEX_VERSIONS` 池（保留旧稳定版在前，不要删）。
- 定期跑 `node scripts/imagegen.mjs --self-check` 验证版本池（不耗额度）。

## 已知限制

- 服务端 4~5 分钟级的失败客户端无解，脚本只能保证「失败尽快、类型明确、不浪费重试」。
- Windows 下参考图路径经 npx 传递，路径含空格理论上可能出问题；遇到时把文件复制到无空格路径再传。
- 旧 CLI 对未来新模型的 capability 判断不保证正确，这是固定旧版本方案的长期风险。

更多设计依据与根因调查线索（如何 diff `rust-v0.143.0..rust-v0.144.0` 定位问题）见 [`references/notes.md`](references/notes.md)。
