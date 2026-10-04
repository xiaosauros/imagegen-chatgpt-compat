#!/usr/bin/env node
// imagegen.mjs — ChatGPT/Codex 套餐生图兼容层
//
// 把生图委托给指定版本的 Codex CLI（codex exec + $imagegen 子进程），只使用
// ChatGPT 登录态额度；默认从子进程环境删除 OPENAI_API_KEY。
//
// 设计要点（背景见 ../references/notes.md）：
// - CLI 版本与 agent 模型都参数化，支持版本池/模型池按失败类型自动切换；
//   不永久写死"某个版本 + 某个模型"。
// - 用户 prompt 原样通过 stdin 传给 codex exec（规避 Windows 命令行转义），
//   执行指令（保存到当前目录、输出绝对路径、不做 review）由脚本附加。
// - network error 最多重试 IMAGEGEN_MAX_NETWORK_RETRIES（默认 1）次后停止。
//
// 用法：node imagegen.mjs "<prompt>" [-i 参考图...] [--out-dir ./generated] [--help]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const IS_WIN = process.platform === "win32";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const EXIT = {
  OK: 0, UNKNOWN: 1, MODEL: 2, TOOL: 3, NETWORK: 4,
  AUTH: 5, QUOTA: 6, ARGS: 7, NO_IMAGE: 8, CLI: 9,
};
const EXIT_FOR_TYPE = {
  model_unsupported: EXIT.MODEL,
  tool_unavailable: EXIT.TOOL,
  network_error: EXIT.NETWORK,
  auth_error: EXIT.AUTH,
  quota_error: EXIT.QUOTA,
  unknown_error: EXIT.UNKNOWN,
  no_image_found: EXIT.NO_IMAGE,
  cli_unavailable: EXIT.CLI,
};

function log(msg) {
  console.error(`[imagegen] ${msg}`);
}

function fail(exitCode, msg) {
  if (msg) console.error(`[imagegen] ${msg}`);
  process.exit(exitCode);
}

// ---------- 参数解析 ----------

function parseArgv(argv) {
  const opts = {
    prompt: null, inputs: [], outDir: null, model: null, models: null,
    codexVersion: null, codexVersions: null, maxNetworkRetries: null,
    timeoutSeconds: null, effort: null, allowApiKey: false,
    dryRun: false, selfCheck: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(EXIT.ARGS, `参数 ${a} 缺少值`);
      return v;
    };
    switch (a) {
      case "-i": case "--input": opts.inputs.push(next()); break;
      case "-o": case "--out-dir": case "--output-dir": opts.outDir = next(); break;
      case "-m": case "--model": opts.model = next(); break;
      case "--models": opts.models = next(); break;
      case "--codex-version": opts.codexVersion = next(); break;
      case "--codex-versions": opts.codexVersions = next(); break;
      case "-r": case "--max-network-retries": opts.maxNetworkRetries = next(); break;
      case "-t": case "--timeout-seconds": opts.timeoutSeconds = next(); break;
      case "-e": case "--effort": opts.effort = next(); break;
      case "--allow-api-key": opts.allowApiKey = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--self-check": opts.selfCheck = true; break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-")) fail(EXIT.ARGS, `未知参数 ${a}（用 --help 查看用法）`);
        if (opts.prompt !== null) fail(EXIT.ARGS, "只接受一个 prompt 参数");
        opts.prompt = a;
    }
  }
  return opts;
}

const HELP = `
用法
  node imagegen.mjs "<prompt>" [选项]

选项
  -i, --input <file>            参考图，可多次；内部会转为绝对路径（图生图/改图用）
  -o, --out-dir <dir>           输出目录（默认 ./generated），子进程工作目录即这里
  -m, --model <model>           主 agent 模型（覆盖 IMAGEGEN_MODEL）
      --models <m1,m2,...>      完整模型池（覆盖 IMAGEGEN_MODEL 与 IMAGEGEN_MODEL_FALLBACKS）
      --codex-version <v>       单个 CLI 版本（覆盖版本池）
      --codex-versions <v1,v2>  完整 CLI 版本池（覆盖 IMAGEGEN_CODEX_VERSIONS）
  -r, --max-network-retries <n> network error 最大重试次数（默认 1，不建议调大）
  -t, --timeout-seconds <n>     单次子进程超时秒数（默认 600，0 = 不限时）
  -e, --effort <level>          model_reasoning_effort（默认 medium）
      --allow-api-key           允许子进程环境保留 OPENAI_API_KEY（默认强制删除）
      --dry-run                 只打印将执行的命令与 stdin 内容，不实际运行
      --self-check              检查版本池内各 CLI 可用性与登录态（不耗生图额度）
  -h, --help                    显示本帮助

环境变量
  IMAGEGEN_CODEX_VERSIONS       默认 0.143.0
  IMAGEGEN_MODEL                默认 gpt-5.5
  IMAGEGEN_MODEL_FALLBACKS      默认空（model_unsupported 时按序切换）
  IMAGEGEN_MAX_NETWORK_RETRIES  默认 1
  IMAGEGEN_TIMEOUT_SECONDS      默认 600（0 = 不限时）
  IMAGEGEN_REASONING_EFFORT     默认 medium
  IMAGEGEN_ALLOW_API_KEY        默认 0

退出码
  0 成功  1 未知  2 模型不可用  3 工具不可用  4 网络错误  5 未登录
  6 额度  7 参数错误  8 正常结束但未找到图片  9 CLI 不可用

结果通过 stdout 输出机器可读块（RESULT / IMAGE_PATH / FAILURE_TYPE ...），
过程日志在 stderr。
`.trim();

// ---------- 配置 ----------

const list = (s) => String(s).split(",").map((x) => x.trim()).filter(Boolean);
const uniq = (arr) => [...new Set(arr)];
const envOf = (k, d) => process.env[k] ?? d;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---------- npx 解析（Windows 必须绕开 npx.cmd 的批处理转义） ----------

function resolveNpx() {
  if (!IS_WIN) return { cmd: "npx", head: [] };
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  try {
    candidates.push(createRequire(import.meta.url).resolve("npm/bin/npx-cli.js"));
  } catch { /* 全局 npm 不在解析路径里时忽略 */ }
  for (const c of candidates) {
    if (fs.existsSync(c)) return { cmd: process.execPath, head: [c] };
  }
  fail(EXIT.ARGS, "找不到 npx 的 npx-cli.js（Windows）。请确认 Node.js/npm 安装完整。");
}

// ---------- 命令构造 ----------

function buildExecArgs({ version, model, effort, images }) {
  const args = [
    "--yes",
    `--package=@openai/codex@${version}`,
    "--",
    "codex", "exec",
    "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-m", model,
    // 裸值即可：codex -c 对非 TOML 值按字面字符串处理，也避免 Windows 传参引号被剥离
    "-c", `model_reasoning_effort=${effort}`,
  ];
  for (const img of images) args.push("-i", img);
  return args;
}

function buildFinalPrompt(rawPrompt) {
  const p = rawPrompt.trim();
  const body = p.startsWith("$imagegen") ? p : `$imagegen ${p}`;
  return [
    body,
    "",
    "Execution instruction:",
    "Save the final image into the current working directory.",
    "Output the absolute path of the saved image on its own line.",
    "No need to review and verify the image.",
  ].join("\n");
}

// ---------- 子进程 ----------

function childEnv(allowApiKey) {
  const env = { ...process.env };
  if (!allowApiKey) delete env.OPENAI_API_KEY; // 强制走 ChatGPT 登录态
  // 沙箱中 ~/.npm 通常不可写；把 npx 安装与缓存放在可写的临时目录。
  if (!env.npm_config_cache && !env.NPM_CONFIG_CACHE) {
    env.npm_config_cache = path.join(os.tmpdir(), "imagegen-chatgpt-compat-npm-cache");
  }
  if (!env.npm_config_registry && !env.NPM_CONFIG_REGISTRY) env.npm_config_registry = "https://registry.npmjs.org/";
  // npm 自带的多次重试会让安装阶段长时间无输出；交给脚本统一报告失败。
  if (!env.npm_config_fetch_retries && !env.NPM_CONFIG_FETCH_RETRIES) env.npm_config_fetch_retries = "0";
  return env;
}

function killTree(child) {
  try {
    if (IS_WIN) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch { /* 进程可能已退出 */ }
}

function runCliCommand({ npx, version, subcommand, env, timeoutSeconds }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(npx.cmd, [...npx.head, "--yes", `--package=@openai/codex@${version}`, "--", "codex", ...subcommand], {
      env, windowsHide: true, detached: !IS_WIN, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    const heartbeat = setInterval(() => {
      log(`codex@${version} ${subcommand.join(" ")} 仍在运行（${Math.round((Date.now() - startedAt) / 1000)}s）`);
    }, 30_000);
    child.stdout.on("data", (d) => { if (out.length < 100_000) out += d; });
    child.stderr.on("data", (d) => { if (err.length < 100_000) err += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSeconds * 1000);
    const done = (exitCode, extraErr = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      resolve({ exitCode, out, err: extraErr ? `${err}\n${extraErr}` : err, timedOut, elapsedSeconds: ((Date.now() - startedAt) / 1000).toFixed(1) });
    };
    child.on("error", (e) => done(-1, e.message));
    child.on("close", (code) => done(code));
  });
}

function runAttempt({ npx, env, version, model, effort, images, finalPrompt, outDir, timeoutSeconds }) {
  return new Promise((resolve) => {
    const args = buildExecArgs({ version, model, effort, images });
    const startedAt = Date.now();

    const child = spawn(npx.cmd, [...npx.head, ...args], {
      cwd: outDir,
      env,
      windowsHide: true,
      detached: !IS_WIN, // posix 下成组，便于整树 kill
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { if (out.length < 2_000_000) out += d; });
    child.stderr.on("data", (d) => { if (err.length < 2_000_000) err += d; });
    child.stdin.on("error", () => { /* 子进程提前退出时忽略 EPIPE */ });
    child.stdin.write(finalPrompt + "\n");
    child.stdin.end();

    const timer = timeoutSeconds > 0
      ? setTimeout(() => { timedOut = true; log(`超过 ${timeoutSeconds}s，终止子进程`); killTree(child); }, timeoutSeconds * 1000)
      : null;

    const done = (exitCode, extraErr) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode, out, err: extraErr ? err + "\n" + extraErr : err, timedOut, startedAt });
    };
    child.on("error", (e) => done(-1, e.message));
    child.on("close", (code) => done(code));
  });
}

// ---------- 失败分类 ----------

function classify({ exitCode, out, err, timedOut }) {
  const text = `${out}\n${err}`.toLowerCase();
  if (timedOut) return "network_error"; // 本地超时按传输层失败处理
  if (/not logged in|please (log|sign) in|codex login|unauthorized|invalid api key|missing api key|\b401\b/.test(text)) return "auth_error";
  if (/usage.?limit|rate limit|quota|limit reached|\b429\b|upgrade your plan/.test(text)) return "quota_error";
  if (/model_not_found|unsupported_model|unknown model|invalid model|model .{0,40}(not found|not available|not supported|unsupported)|does not support/.test(text)) return "model_unsupported";
  if (/(no |unknown |unsupported )tool\b|tool.{0,40}(unavailable|not found|not supported)|image_generation.{0,40}(unavailable|not found|not exposed)/.test(text)) return "tool_unavailable";
  if (/network error|error sending request|timed?.?out|timeout|connection (reset|refused|closed|aborted)|stream (disconnected|error)|unexpected status 5\d\d|bad gateway|gateway time|econn(refused|reset|aborted)|etimedout|request (failed|aborted)/.test(text)) return "network_error";
  return "unknown_error";
}

const SUGGESTIONS = {
  model_unsupported: "用 --model 指定一个当前套餐可用的模型重试一次；仍失败则用 --codex-versions 换 CLI 版本（旧 CLI 可能无法识别新模型的 capability）。",
  tool_unavailable: "该 CLI 版本未暴露 image_generation 工具：用 --codex-versions 换一个已验证稳定的版本。",
  network_error: "脚本已按上限自动重试，请停止。可稍后再试、降低图片复杂度，或检查代理/网络；不要无限重试（每次失败可能已消耗数分钟额度窗口）。",
  auth_error: "让用户运行 codex login 重新登录后重试。",
  quota_error: "套餐额度/限流问题，告知用户。",
  unknown_error: "阅读脚本 stderr 中子进程输出 tail 后再决定，不要自动重试。",
  no_image_found: "子进程正常结束但没有产出图片：检查 prompt 是否被模型拒绝（见 stderr tail）。",
  cli_unavailable: "指定版本的 Codex CLI 未能启动。检查 npx/npm 网络与缓存，或安装该版本；不要把安装失败当作生图网络错误重试。",
};

// ---------- 图片定位 ----------

function existingFile(p) {
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function extractPathFromText(text, exclude) {
  if (!text) return null;
  const re = /(?:[A-Za-z]:)?(?:[\\/][^\s"'`<>|*?:\r\n]+)+\.(?:png|jpe?g|webp|gif)/gi;
  for (const m of text.matchAll(re)) {
    const p = m[0].replace(/[.,;:)\]}'"]+$/, "");
    if (exclude.some((x) => x.toLowerCase() === p.toLowerCase())) continue;
    if (existingFile(p)) return p;
  }
  return null;
}

function collectImages(dir, sinceMs, depth = 3) {
  const found = [];
  const walk = (d, level) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (level < depth) walk(full, level + 1);
        continue;
      }
      if (!IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (sinceMs == null || st.mtimeMs >= sinceMs - 1500) found.push({ path: full, mtimeMs: st.mtimeMs });
    }
  };
  walk(dir, 0);
  return found;
}

function findImage({ startedAt, text, inputs, outDir }) {
  const exclude = [...inputs, os.tmpdir()];
  // 1) 输出目录里本次运行新增的图片（约定的交付位置）
  const inOutDir = collectImages(outDir, startedAt).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (inOutDir.length) return { path: inOutDir[0].path, source: "out_dir" };
  // 2) 子进程最终输出里提到的现存图片路径（覆盖"移动文件保留 mtime"的情况）
  const fromText = extractPathFromText(text, exclude);
  if (fromText) return { path: fromText, source: "agent_output" };
  // 3) Codex 自己的生图落盘目录（imagegen 工具的默认保存位置）
  const genDir = path.join(os.homedir(), ".codex", "generated_images");
  const inGen = collectImages(genDir, startedAt).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (inGen.length) return { path: inGen[0].path, source: "codex_generated_images" };
  return null;
}

function tail(text, lines = 50) {
  const arr = String(text).split(/\r?\n/).filter((l) => l.trim());
  return arr.slice(-lines).join("\n");
}

// ---------- self-check / dry-run ----------

async function selfCheck({ npx, versions, env }) {
  console.log(`SELF-CHECK npx: ${[npx.cmd, ...npx.head].join(" ")}`);
  const genDir = path.join(os.homedir(), ".codex", "generated_images");
  console.log(`SELF-CHECK generated_images_dir: ${genDir} ${fs.existsSync(genDir) ? "(存在)" : "(不存在，仅提示)"}`);
  let allOk = true;
  for (const v of versions) {
    log(`检查 codex@${v} 启动（首次使用需下载平台包，最多 600s）`);
    const vRes = await runCliCommand({ npx, version: v, subcommand: ["--version"], env, timeoutSeconds: 600 });
    const ver = vRes.out.trim();
    if (vRes.timedOut || vRes.exitCode !== 0 || !ver.startsWith("codex-cli")) {
      allOk = false;
      console.log(`SELF-CHECK codex@${v}: CLI FAIL (${vRes.timedOut ? "启动超时" : `exit=${vRes.exitCode}`}, ${vRes.elapsedSeconds}s)`);
      console.error(`[imagegen] codex@${v} 启动输出:\n${tail(`${vRes.out}\n${vRes.err}`, 10)}`);
      continue;
    }
    log(`检查 codex@${v} 登录态（最多 30s）`);
    const lRes = await runCliCommand({ npx, version: v, subcommand: ["login", "status"], env, timeoutSeconds: 30 });
    // login status 的结果在 stderr；区分 "Logged in ..." 与 "Not logged in"
    const loginText = `${lRes.out}\n${lRes.err}`;
    const loginOk = lRes.exitCode === 0 && !lRes.timedOut && !/not logged in/i.test(loginText) && /logged in/i.test(loginText);
    const ok = loginOk;
    if (!ok) allOk = false;
    console.log(
      `SELF-CHECK codex@${v}: ${ver} | login: ${loginOk ? "ChatGPT OK" : "FAIL"} | ${ok ? "OK" : "FAIL"}`,
    );
    if (!ok) console.error(`[imagegen] codex@${v} 登录输出:\n${tail(loginText, 10)}`);
  }
  process.exit(allOk ? EXIT.OK : EXIT.UNKNOWN);
}

function dryRun({ versions, models, outDir, images, finalPrompt, timeoutSeconds, maxNetworkRetries, effort }) {
  const args = buildExecArgs({ version: versions[0], model: models[0], effort, images });
  console.log("DRY-RUN version_pool: " + versions.join(", "));
  console.log("DRY-RUN model_pool: " + models.join(", "));
  console.log(`DRY-RUN out_dir: ${outDir}`);
  console.log(`DRY-RUN timeout: ${timeoutSeconds}s, network_retries: ${maxNetworkRetries}`);
  console.log("DRY-RUN command:");
  for (const a of ["<npx>", ...args]) console.log(`  ${JSON.stringify(a)}`);
  console.log("DRY-RUN prompt (stdin):");
  for (const line of finalPrompt.split("\n")) console.log(`  | ${line}`);
  process.exit(EXIT.OK);
}

// ---------- 主流程 ----------

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(EXIT.OK);
  }

  const versions = uniq(
    opts.codexVersions ? list(opts.codexVersions)
      : opts.codexVersion ? [opts.codexVersion]
        : list(envOf("IMAGEGEN_CODEX_VERSIONS", "0.143.0")),
  );
  const models = uniq(
    opts.models ? list(opts.models)
      : [opts.model ?? envOf("IMAGEGEN_MODEL", "gpt-5.5"), ...list(envOf("IMAGEGEN_MODEL_FALLBACKS", ""))],
  );
  const maxNetworkRetries = num(opts.maxNetworkRetries ?? envOf("IMAGEGEN_MAX_NETWORK_RETRIES", "1"), 1);
  const timeoutSeconds = num(opts.timeoutSeconds ?? envOf("IMAGEGEN_TIMEOUT_SECONDS", "600"), 600);
  const effort = opts.effort ?? envOf("IMAGEGEN_REASONING_EFFORT", "medium");
  const allowApiKey = opts.allowApiKey || envOf("IMAGEGEN_ALLOW_API_KEY", "0") === "1";

  if (versions.length === 0 || models.length === 0) fail(EXIT.ARGS, "版本池或模型池为空");

  const images = opts.inputs.map((p) => {
    const abs = path.resolve(p);
    if (!existingFile(abs)) fail(EXIT.ARGS, `参考图不存在：${abs}`);
    return abs;
  });

  if (opts.selfCheck) {
    await selfCheck({ npx: resolveNpx(), versions, env: childEnv(allowApiKey) });
    return;
  }
  // 自检不需要 prompt，必须在它之后读取 stdin，避免在 Agent 管道环境中阻塞。
  let prompt = opts.prompt;
  if (prompt === null && !process.stdin.isTTY) {
    prompt = fs.readFileSync(0, "utf8");
  }
  if (prompt === null || !prompt.trim()) fail(EXIT.ARGS, "缺少 prompt（位置参数或 stdin 管道）");

  const outDir = path.resolve(opts.outDir ?? "generated");
  const finalPrompt = buildFinalPrompt(prompt);

  if (opts.dryRun) {
    dryRun({ versions, models, outDir, images, finalPrompt, timeoutSeconds, maxNetworkRetries, effort });
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const npx = resolveNpx();
  const env = childEnv(allowApiKey);
  log(`版本池: [${versions.join(", ")}] 模型池: [${models.join(", ")}] 输出: ${outDir}`);

  const startedAll = Date.now();
  let vi = 0;
  let mi = 0;
  let netRetriesLeft = maxNetworkRetries;
  let attemptNo = 0;
  let lastVersion = versions[0];
  let lastModel = models[0];
  const checkedVersions = new Set();

  while (true) {
    const version = versions[vi];
    const model = models[mi];
    lastVersion = version;
    lastModel = model;
    if (!checkedVersions.has(version)) {
      log(`检查 codex@${version} 启动（首次使用需下载平台包，最多 600s）`);
      const check = await runCliCommand({ npx, version, subcommand: ["--version"], env, timeoutSeconds: 600 });
      if (check.timedOut || check.exitCode !== 0 || !check.out.trim().startsWith("codex-cli")) {
        console.log("RESULT: failure");
        console.log("FAILURE_TYPE: cli_unavailable");
        console.log(`CLI_VERSION: ${version}`);
        console.log(`ATTEMPTS: ${attemptNo}`);
        console.log(`ELAPSED_SECONDS: ${((Date.now() - startedAll) / 1000).toFixed(1)}`);
        console.log(`SUGGESTION: ${SUGGESTIONS.cli_unavailable}`);
        console.error(`[imagegen] CLI 启动${check.timedOut ? "超时" : `失败 (exit=${check.exitCode})`}，${check.elapsedSeconds}s。输出 tail:\n${tail(`${check.out}\n${check.err}`)}`);
        process.exit(EXIT.CLI);
      }
      checkedVersions.add(version);
    }
    attemptNo++;
    log(`尝试 #${attemptNo}: codex@${version} + ${model}`);

    const r = await runAttempt({ npx, env, version, model, effort, images, finalPrompt, outDir, timeoutSeconds });
    const elapsed = ((Date.now() - r.startedAt) / 1000).toFixed(1);
    const text = [r.out, r.err].join("\n");

    if (r.exitCode === 0) {
      const img = findImage({ startedAt: r.startedAt, text, inputs: images, outDir });
      if (img) {
        console.log(`RESULT: success`);
        console.log(`IMAGE_PATH: ${img.path}`);
        console.log(`IMAGE_PATH_SOURCE: ${img.source}`);
        console.log(`CLI_VERSION: ${version}`);
        console.log(`MODEL: ${model}`);
        console.log(`ATTEMPTS: ${attemptNo}`);
        console.log(`ELAPSED_SECONDS: ${((Date.now() - startedAll) / 1000).toFixed(1)}`);
        log(`成功 → ${img.path} (${elapsed}s)`);
        process.exit(EXIT.OK);
      }
      log(`子进程正常结束（${elapsed}s）但没有找到图片文件`);
      console.log(`RESULT: failure`);
      console.log(`FAILURE_TYPE: no_image_found`);
      console.log(`CLI_VERSION: ${version}`);
      console.log(`MODEL: ${model}`);
      console.log(`ATTEMPTS: ${attemptNo}`);
      console.log(`SUGGESTION: ${SUGGESTIONS.no_image_found}`);
      console.error(`[imagegen] 子进程输出 tail:\n${tail(text)}`);
      process.exit(EXIT.NO_IMAGE);
    }

    const ft = classify(r);
    log(`失败 ${ft}（exit=${r.exitCode}, ${elapsed}s, 版本 ${version}, 模型 ${model}）`);

    let stopType = null;
    if (ft === "network_error") {
      if (netRetriesLeft > 0) {
        netRetriesLeft--;
        log(`network error，自动重试（剩余 ${netRetriesLeft} 次）`);
        continue;
      }
      stopType = ft;
    } else if (ft === "model_unsupported") {
      if (mi + 1 < models.length) {
        mi++;
        log(`模型不可用，切换模型 → ${models[mi]}`);
        continue;
      }
      stopType = ft;
    } else if (ft === "tool_unavailable") {
      if (vi + 1 < versions.length) {
        vi++;
        log(`工具不可用，切换 CLI 版本 → ${versions[vi]}`);
        continue;
      }
      stopType = ft;
    } else {
      stopType = ft; // auth / quota / unknown：直接停止
    }

    console.log(`RESULT: failure`);
    console.log(`FAILURE_TYPE: ${stopType}`);
    console.log(`CLI_VERSION: ${lastVersion}`);
    console.log(`MODEL: ${lastModel}`);
    console.log(`ATTEMPTS: ${attemptNo}`);
    console.log(`ELAPSED_SECONDS: ${((Date.now() - startedAll) / 1000).toFixed(1)}`);
    console.log(`SUGGESTION: ${SUGGESTIONS[stopType]}`);
    console.error(`[imagegen] 子进程输出 tail:\n${tail(text)}`);
    process.exit(EXIT_FOR_TYPE[stopType] ?? EXIT.UNKNOWN);
  }
}

main().catch((e) => fail(EXIT.UNKNOWN, `未捕获异常：${e?.stack ?? e}`));
