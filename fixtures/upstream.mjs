// 真上游 HTTP 测试夹具（issue #257 T1）—— 可脚本化的 **真 socket** HTTP 上游。
//
// 为什么存在：`test/` 里旧有 provider 测试全部注入假 fetch，只验函数形状；这一层
// 起真的 `http.createServer`，让 **真 provider（不注入 fetchImpl）** 走真 TCP，
// 从而覆盖 SSE 分帧 / 跨包切片 / 半截流 / 真 HTTP 状态码 / 首字节超时。
//
// ---------------------------------------------------------------------------
// 用法（T5 复用请照此抄）：
//
//   import { createScriptedUpstream, sseOpenAI, sseAnthropic } from "../fixtures/upstream.mjs";
//
//   const upstream = createScriptedUpstream({
//     // script：按 **请求序号** 依次取用；取完后重复最后一项（便于断言重发次数）
//     script: [
//       sseResponse({ frames: sseOpenAI(textChunks(["你好", "世界"])) }),
//       jsonResponse({ ok: true }, { status: 429, headers: { "retry-after": "0" } }),
//     ],
//   });
//   t.after(() => upstream.close());            // 漏关会挂住整个套件
//   const baseUrl = await upstream.listen();    // 绑 127.0.0.1 : 0（端口由内核给）
//
//   const provider = createOpenAIProvider({ endpoint: baseUrl, apiKey: "k", model: "m" });
//   const res = await provider.chatStream({ messages: [...], onDelta });
//
//   assert.deepEqual(upstream.requests.map((r) => r.path), ["/v1/chat/completions"]);
//   assert.equal(upstream.responses[0].writes.length, 4);   // 服务端真实写分片计划
//
// 响应 spec 的关键字段（`kind:"sse"` 走分帧写路径，其余走一次性 body）：
//   status / headers / frames / framing / delayFirstByteMs / truncateAfterWrites
//   framing: "frames" = 一帧一次 res.write()
//            "byte"   = 每 1 字节一次 res.write()
//            "irregular" = 按导出的 DEFAULT_IRREGULAR_SLICE_CYCLE 不规则切片
//            number[] = 自定义不规则切片（按给定字节数循环切）
//   delayFirstByteMs: 收到请求后迟迟不 flush header（命中 provider 的 **request**
//                     阶段超时/中止：undici 的 fetch() 要等 header 才 resolve）
//   delayBodyMs:      header 已发、body 第一个字节迟迟不到（命中 **firstByte** 阶段）
//   truncateAfterWrites: 写完 k 次后 **res.socket.destroy()**（半截流，无 `[DONE]`）
//   destroyDelayMs: destroy 前的缓存毫秒数（>0 才能让客户端先把已发帧读走）
//
// 分包是怎么保证的：`res.write()` 在未背压时会同步把字节交给 socket（Node 对 accepted
// socket 默认 TCP_NODELAY），帧内切片之间再让出一个宏任务，客户端就有机会在两读之间
// 拿到上一片——「跨包」因此是可观察事实，而不是应用层看起来分片、实际一次发完。
//
// issue #614（CLI 默认压缩策略 = `fold-llm`）：每次折叠都会多一发**摘要器请求**。它和主循环
// 请求长得很像（同一个端点、同一个协议），但 `classifyChatRequest` 能把两类**正面**分开
// （摘要器提示词指南首行 vs 非空 `tools` / 多轮历史）。要用「一个脚本同时应答两类」，请用
// `createCompactionAwareScript({ main, summarizer })`——认不出的请求一律 500，不给 garbage。
// 注意：**不要拿 `res.write()` 的写回调当「已发出」**——`ServerResponse` 的 `close`
// 会抢在它前面触发，把半截写误判成 socket 已死，服务端就会提前退出写循环且永不
// `end()`，客户端一直等 → 整个套件挂死。断言服务端侧记录前请先 `await settled()`。
// ---------------------------------------------------------------------------

import http from "node:http";

// issue #614：摘要器提示词指南的**首行**是「这个请求是不是折叠摘要器发的」的判别锚点。
// 从 `src/compact/fold-llm.js` 拿，不在本文件里抄一份字面量——抄一份就多一个真相来源，
// 指南改一个字，夹具就默默不再认得摘要器请求（那会让「随机 garbage 摘要却仍判绿」复活）。
import { SUMMARIZER_PROMPT_GUIDE } from "../src/compact/fold-llm.js";

const DEFAULT_SLICE_CYCLE = [1, 2, 1, 5, 1, 13];

function toJsonFrame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/**
 * OpenAI 协议 SSE 帧：`data: {json}\n\n`，默认以 `[DONE]` 收尾。
 *
 * @param {Array<object>} chunks chat.completions 流式 chunk 对象
 * @param {{ done?: boolean }} [options] done=false 时 **不发** `[DONE]`
 * @returns {string[]} 帧数组（每帧自带结尾空行）
 */
export function sseOpenAI(chunks, options = {}) {
  const frames = chunks.map((chunk) => toJsonFrame(chunk));
  if (options.done !== false) frames.push("data: [DONE]\n\n");
  return frames;
}

/**
 * Anthropic 协议 SSE 帧：`event: …\ndata: …\n\n`。
 *
 * @param {Array<{ type: string } & Record<string, any>>} events 事件对象（type 决定 `event:` 行）
 * @param {{ done?: boolean, withEventLine?: boolean }} [options]
 * @returns {string[]} 帧数组
 */
export function sseAnthropic(events, options = {}) {
  const frames = events.map((event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    return options.withEventLine === false ? data : `event: ${event.type}\n${data}`;
  });
  if (options.done === true) frames.push("data: [DONE]\n\n");
  return frames;
}

/**
 * 把文本切成 OpenAI 流式文本增量 chunk 序列（`delta.content`）。
 * @param {string[]} parts 文本片段
 * @returns {object[]} chunk 序列
 */
export function openAITextChunks(parts) {
  return parts.map((part, index) => ({
    id: `id-${index}`,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
  }));
}

/**
 * 把一次工具调用切成 OpenAI 流式 chunk 序列（`delta.tool_calls`）：
 * 首帧带 id/name/参数，末帧 `finish_reason:"tool_calls"`，再补一帧 usage。
 *
 * 为什么要这个 helper：`openAITextChunks` 只覆盖纯文本，而 repl / `--stream` 这类
 * 「模型端必须流式」的进程级用例要的是**工具调用**那条路径（参数是拼装出来的，不是一次给全）。
 *
 * @param {string} name 工具名
 * @param {object} args 工具入参（会被 `JSON.stringify` 进 `function.arguments`）
 * @param {string} id 工具调用 id（引擎按它配对 `tool_result`）
 * @param {{ usage?: object }} [options] 末帧的 usage（缺省给一个固定的非零值）
 * @returns {object[]} chunk 序列
 */
export function openAIToolCallChunks(name, args, id, options = {}) {
  const usage = options.usage ?? { prompt_tokens: 11, completion_tokens: 9 };
  return [
    {
      id: `chunk-${id}`,
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: `chunk-${id}-finish`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
    { id: `chunk-${id}-usage`, object: "chat.completion.chunk", choices: [], usage },
  ];
}

/**
 * Anthropic 文本回复事件序列：message_start → content_block_start → N × content_block_delta
 * → content_block_stop → message_delta → message_stop。
 * @param {string[]} parts 文本片段
 * @param {{ usage?: object, stopReason?: string }} [options]
 * @returns {object[]} 事件序列
 */
export function anthropicTextEvents(parts, options = {}) {
  const usage = options.usage ?? {
    input_tokens: 7,
    output_tokens: 5,
  };
  return [
    {
      type: "message_start",
      message: {
        id: "msg_scripted",
        type: "message",
        role: "assistant",
        model: "claude-scripted",
        content: [],
        usage: { input_tokens: usage.input_tokens, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...parts.map((part) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: part },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: options.stopReason ?? "end_turn" },
      usage: { output_tokens: usage.output_tokens },
    },
    { type: "message_stop" },
  ];
}

/**
 * 普通（非流式）JSON 响应。
 * @param {any} value 响应体
 * @param {{ status?: number, headers?: Record<string,string> }} [options]
 */
export function jsonResponse(value, options = {}) {
  return {
    kind: "json",
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify(value),
  };
}

/**
 * 纯文本响应（用于「非 2xx + 文本 body」这类分类路径）。
 */
export function textResponse(body, options = {}) {
  return {
    kind: "text",
    status: options.status ?? 200,
    headers: { "content-type": "text/plain", ...(options.headers ?? {}) },
    body: String(body),
  };
}

/**
 * SSE 流式响应。
 * @param {{
 *   frames: string[],
 *   status?: number,
 *   headers?: Record<string,string>,
 *   framing?: "frames" | "byte" | "irregular" | number[],
 *   delayFirstByteMs?: number,
 *   delayBodyMs?: number,
 *   truncateAfterWrites?: number,
 *   destroyDelayMs?: number,
 *   endAfterFrames?: boolean,
 * }} options
 */
export function sseResponse(options) {
  return {
    kind: "sse",
    status: options.status ?? 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...(options.headers ?? {}),
    },
    frames: options.frames.slice(),
    framing: options.framing ?? "frames",
    delayFirstByteMs: options.delayFirstByteMs ?? 0,
    delayBodyMs: options.delayBodyMs ?? 0,
    truncateAfterWrites: options.truncateAfterWrites,
    // destroy 前留一点时间（毫秒级）：否则客户端会把已缓冲的帧连同错误一起
    // 丢弃（实测：undici 在 premature close 时不保留未读数据），那就只能验到
    // “什也没收到”而不是“收到一半后断”。
    destroyDelayMs: options.destroyDelayMs ?? 0,
    endAfterFrames: options.endAfterFrames !== false,
  };
}

function sliceBody(body, framing) {
  if (framing === "frames") return null; // 由调用方按帧边界写
  if (framing === "byte") return body.match(/[\s\S]/gu) ?? [];
  // "irregular"：固定但不均匀的切片表，比 1 字节更接近真实网络的错落分片。
  const sizes = framing === "irregular"
    ? DEFAULT_SLICE_CYCLE
    : Array.isArray(framing) ? framing.map((n) => Math.max(1, Math.trunc(n))) : null;
  if (!sizes || sizes.length === 0) return null;
  const slices = [];
  let cursor = 0;
  let index = 0;
  while (cursor < body.length) {
    const size = sizes[index % sizes.length];
    slices.push(body.slice(cursor, cursor + size));
    cursor += size;
    index += 1;
  }
  return slices;
}

function planSlices(spec) {
  const body = spec.frames.join("");
  const explicit = sliceBody(body, spec.framing);
  if (explicit) return explicit;
  return spec.frames.slice(); // "frames"
}

function delay(ms) {
  if (!(ms > 0)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    // 未触发也要让事件循环能退出：延迟只是测试内的可推进判定，不该拖住进程。
    timer.unref?.();
  });
}

function waitForDrain(res) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(value);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const guard = setTimeout(() => finish(!res.destroyed), 500);
    guard.unref?.();
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

// 写一片。**不用 res.write() 的回调作为“已发出”的信号**：实测上 `ServerResponse`
// 的 `close` 会在写回调之前触发（客户端仍在等数据），把它当“socket 已死”就会
// 让服务端提前退出写循环、永不 `end()` → 客户端挂死整个套件。可信的是：
//   • `res.write()` 在未背压时会同步把字节交给 socket（Node 默认 TCP_NODELAY）；
//   • 背压时等 `drain`；
//   • 帧内切片之间让出一个宏任务，保证上一片已交给内核，客户端能在两读之间拿到它。
async function writeOne(res, chunk, pace) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    if (!res.write(chunk) && !(await waitForDrain(res))) return false;
  } catch {
    return false;
  }
  if (pace) {
    // 帧内切片之间让出一个宏任务：客户端才有机会在两次 read 之间拿到上一片，
    // 「跨包」才是可观察的事实而不是愿望。帧边界模式（一帧一次 write）不让出，
    // 否则写计划会跑在客户端后面，断言只能看到半截计划。
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref?.();
    });
  }
  return !res.destroyed;
}

// `truncateAfterWrites: k` 的语义：**写完 k 片**再 destroy（k=0 即只发 header 就断）。
async function drainPlan(res, slices, truncateAfterWrites, pace) {
  const writes = [];
  for (let index = 0; index < slices.length; index += 1) {
    const ok = await writeOne(res, slices[index], pace);
    writes.push(slices[index].length);
    if (!ok) return { writes, truncated: "socket-closed" };
    if (truncateAfterWrites !== undefined && writes.length >= truncateAfterWrites) {
      return { writes, truncated: true };
    }
  }
  return { writes, truncated: false };
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", finish);
    req.on("error", finish);
    // 客户端提前中止时只有 `close`，永远等不到 `end`/`error`：也必须放行，
    // 否则 handler 卡在 await 上，`settled()` 与 close() 都会被拖住。
    req.on("close", finish);
  });
}

function normalizeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function resolveSpec(source, ctx) {
  if (typeof source === "function") return source(ctx);
  return source;
}

// ---------------------------------------------------------------------------
// 压缩感知的脚本化应答（issue #614：CLI 默认策略改成 fold-llm）
//
// 默认开启 fold-llm 之后，**每次折叠都会多一发模型请求**（摘要器提示词 + 被折轮次的序列化
// 正文）。脚本化上游此前只认识「主循环请求」这一类，多出来的那一发会被当成主循环请求来应答
// ⇒ 折叠块里落进一句主循环的台词，而判据只要「请求数 > 0 / run 没崩」就照旧绿。这就是本文件
// 新增下面这几个导出的理由：**分流必须是显式的事实，不能靠请求序号撞运气**。
//
// 分流依据（两条都是**正面识别**，谁也不靠「剩下的就是另一类」）：
//   · 摘要器请求：messages 里出现 `SUMMARIZER_PROMPT_GUIDE` 的首行（`SUMMARIZER_PROMPT_MARKER`）。
//     这一行只由 `src/compact/provider-summarizer.js` 拼进请求正文，主循环的系统提示 / 用户
//     任务里不会有它；指南本身从 `src/` 导入，单一真相来源。
//   · 主循环请求（含引擎内部的收尾调用）：请求体里有**非空** `tools` 数组，或历史不止一发
//     （`messages.length >= 3`）。引擎自己也有不发 tools 的调用（收尾/终稿整理），它们的
//     `messages` 是整段历史，所以第二个条件把它们收进来。
//   · 两条都不成立（无 tools、历史只有 system+user、又没有指南首行）⇒ `"unknown"`：
//     **这正是「指南首行改了、夹具不再认得摘要器」的形状**（摘要器请求就是 system+user 两条）。
//     此时 `createCompactionAwareScript` 一律回 500 并点名「分类失败」，绝不给一个看起来正常
//     的回复——宁可红在分类上，也不要绿在 garbage 上。
// ---------------------------------------------------------------------------

/** 摘要器请求的判别锚点：摘要器提示词指南的首行（来自 `src/compact/fold-llm.js`）。 */
export const SUMMARIZER_PROMPT_MARKER = SUMMARIZER_PROMPT_GUIDE.split("\n")[0];

/**
 * 请求体里所有消息的可读文本（字符串 content + text 块）。
 * @param {any} body 解析后的请求体
 * @returns {string}
 */
function requestMessageText(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return "";
  const parts = [];
  for (const message of messages) {
    if (typeof message?.content === "string") {
      parts.push(message.content);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (typeof block?.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * 把一发请求分成「折叠摘要器」/「主循环」/「认不出来」。
 *
 * @param {{json?: any, bodyText?: string}|undefined} entry `upstream.requests[i]` 那种登记项
 * @returns {"summarizer"|"main"|"unknown"}
 */
export function classifyChatRequest(entry) {
  const body = entry?.json;
  if (body === undefined || body === null) return "unknown";
  if (requestMessageText(body).includes(SUMMARIZER_PROMPT_MARKER)) return "summarizer";
  if (Array.isArray(body.tools) && body.tools.length > 0) return "main";
  if (Array.isArray(body.messages) && body.messages.length >= 3) return "main";
  return "unknown";
}

/**
 * 合法分节的摘要夹具（判据 1 的那一半：折叠块里必须出现 `## 阶段` / `## 教训与坑`）。
 *
 * 正文刻意短（远低于 `maxSummaryTokens` 的 1400 默认预算），这样断言打的是**分节语义**，
 * 不是「夹具写得多长」。`SEMANTIC_SUMMARY_MARKER` 是夹具自己的指纹：折叠块里出现它 ⇒
 * 那一段确实来自这一发摘要器应答，而不是统计摘要恰好长得像。
 */
export const SEMANTIC_SUMMARY_MARKER = "#614 语义摘要夹具";

/** @returns {string} 一份带 `## 阶段` / `## 教训与坑` 的合法摘要正文 */
export function semanticSummaryText() {
  return [
    `## 阶段`,
    `${SEMANTIC_SUMMARY_MARKER}：第 1 阶段读了三个文件，第 2 阶段写了结论。`,
    `## 已改文件`,
    `- src/a.js（新增一行注释）`,
    `## 已验证项`,
    `- 无（夹具场景不跑测试）`,
    `## 下一步（含"已完成项禁止重做"）`,
    `- 只差最后一句总结；已完成项禁止重做。`,
    `## 主题词面包屑`,
    `- src/a.js / read / 夹具`,
    `## 教训与坑（不要重犯的）`,
    `- 别把「读到了」当「做完了」；夹具里读文件不产生副作用。`,
  ].join("\n");
}

/**
 * 一个能应答**两类请求**的 script 条目（直接放进 `createScriptedUpstream({script: [...]})`）。
 *
 * `main` / `summarizer` 都可以是 spec 对象或 `(ctx) => spec`；`ctx` 里多了 `entry` / `body`
 * （解析后的请求体）与 `kind`（分类结果），所以调用方也能按序号自己编脚本。
 *
 * @param {{
 *   main: object | ((ctx: any) => object),
 *   summarizer: object | ((ctx: any) => object),
 * }} options
 * @returns {(ctx: {seq:number, req:any, path:string, entry:any, body:any, kind:string}) => object}
 */
export function createCompactionAwareScript({ main, summarizer }) {
  if (main === undefined || summarizer === undefined) {
    throw new TypeError("createCompactionAwareScript 需要 main 与 summarizer 两个应答");
  }
  return (ctx) => {
    const kind = classifyChatRequest(ctx.entry);
    const withKind = { ...ctx, kind };
    if (kind === "summarizer") return resolveSpec(summarizer, withKind);
    if (kind === "main") return resolveSpec(main, withKind);
    // 认不出来的请求**不许**给一个像样的回复：那会让「折叠块里落了 garbage 却判绿」复活。
    // 回 500 + 点名原因，调用方的断言会看到一次失败（而不是一次可疑的成功）。
    return textResponse(
      `scripted upstream: 认不出的 chat 请求（既没有摘要器提示词指南首行，也不是带 tools / 带历史的`
      + `主循环请求）——issue #614 的夹具分流在这里断了，请检查 classifyChatRequest。`
      + `seq=${ctx.seq} path=${ctx.path} bodyBytes=${String(ctx.entry?.bodyText ?? "").length}`,
      { status: 500 },
    );
  };
}

/**
 * 建一个脚本化真 HTTP 上游。**绑 127.0.0.1:0**（写死端口会撞车）。
 *
 * @param {{
 *   script?: Array<object | ((ctx: {seq:number, req:any}) => object)>,
 *   routes?: Record<string, object | ((ctx: {seq:number, req:any}) => object)>,
 *   onError?: (err: Error) => void,
 * }} [options]
 *   `routes` 按 path 精确匹配优先；否则用 `script` 按 **请求序号** 取（越界重复最后一项）。
 * @returns {{
 *   listen: () => Promise<string>,
 *   close: () => Promise<void>,
 *   reset: () => void,
 *   settled: () => Promise<void>,
 *   waitForRequests: (count?: number, timeoutMs?: number) => Promise<boolean>,
 *   readonly baseUrl: string,
 *   readonly port: number,
 *   readonly requests: Array<{seq:number, method:string, path:string, headers:Record<string,string>, bodyText:string, json:any, receivedAtMs:number}>,
 *   readonly responses: Array<{seq:number, status:number, headers:Record<string,string|number>, writes:number[], frames?:string[], truncated:boolean|string|undefined, completed:boolean}>,
 *   readonly requestCount: number,
 *   pathsFor: (n?: number) => string[],
 * }} 上游句柄
 */
export function createScriptedUpstream(options = {}) {
  const requests = [];
  const responses = [];
  // 正在跑的 handler：`settled()` 用它把「服务端已写完」变成一个可 await 的事实。
  // 客户端读到最后一个字节时，服务端的写循环往往还没跑完，直接断言写计划会看到半截。
  const inFlight = new Set();
  let server;
  let baseUrl = "";
  let closed = false;
  let pending = new Set();

  const handler = async (req, res) => {
    const seq = requests.length;
    const path = String(req.url ?? "");
    // 先登记、后读 body：客户端在 body 读完前就中止（`req` 只到 `close`、不到 `end`）时，
    // 请求也必须留在日志里——否则「不发第二发」这类次数断言会偶发变成 0。
    const entry = {
      seq,
      method: String(req.method ?? ""),
      path,
      // Node 会把请求头小写化：断言时按小写名取，别假设原大小写。
      headers: { ...req.headers },
      bodyText: "",
      json: undefined,
      // 请求**到达服务端**的时刻（`performance.now()`，与同进程的测试同一个时间原点）。
      // 为什么要有：`waitForRequests()` 是**轮询**判据，负载下轮询自己会被调度器饿着，
      // 「请求早就落地了但轮询没醒」和「请求压根没落地」在它眼里长得一样。落地时刻是
      // 服务端侧的事实，事后比对即可（#412：`test/e2e/upstream.test.js` 用它证明首发
      // **在截止线之前**就上了线，而不是「超时之后才勉强到达」）。
      receivedAtMs: performance.now(),
    };
    requests.push(entry);
    const bodyText = await readRequestBody(req);
    entry.bodyText = bodyText;
    entry.json = normalizeJson(bodyText);

    const routeKey = Object.keys(options.routes ?? {})
      .find((route) => route === path || route === path.split("?")[0]);
    const source = routeKey !== undefined
      ? options.routes[routeKey]
      : Array.isArray(options.script) && options.script.length > 0
        ? options.script[Math.min(seq, options.script.length - 1)]
        : undefined;

    const spec = resolveSpec(source, { seq, req, path, entry, body: entry.json });
    if (spec === undefined) {
      responses.push({
        seq,
        status: 500,
        headers: { "content-type": "text/plain" },
        writes: [],
        truncated: undefined,
        completed: false,
      });
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("scripted upstream: no scenario for this request");
      responses.at(-1).completed = true;
      return;
    }

    const status = spec.status ?? 200;
    const headers = { ...(spec.headers ?? {}) };
    const recorded = {
      seq,
      status,
      headers,
      writes: [],
      truncated: undefined,
      completed: false,
      // 发出去的帧（仅 SSE）：让“协议发全了”成为**服务端侧可断言的事实**，
      // 而不是测试拿自己构造的数组自指。
      frames: spec.kind === "sse" ? spec.frames.slice() : undefined,
    };
    responses.push(recorded);

    if (spec.kind !== "sse") {
      const body = typeof spec.body === "string" ? spec.body : "";
      res.writeHead(status, headers);
      const ok = await writeOne(res, body);
      recorded.writes.push(body.length);
      recorded.truncated = ok ? undefined : "socket-closed";
      await new Promise((resolve) => {
        if (res.destroyed || res.writableEnded) return resolve(undefined);
        res.end(resolve);
      });
      recorded.completed = true;
      return;
    }

    if (spec.delayFirstByteMs > 0) {
      await delay(spec.delayFirstByteMs);
      if (res.destroyed || res.writableEnded) {
        recorded.truncated = "client-gone";
        return;
      }
    }
    res.writeHead(status, headers);
    res.flushHeaders();

    // `delayBodyMs`：header 已到、body 第一个字节迟迟不到——这才是 provider 的
    // **firstByte** 阶段（undici 的 `fetch()` 在收到 header 时就 resolve，所以
    // 「迟迟不发 header」只能命中 request 阶段）。两个旋钮都要有。
    if (spec.delayBodyMs > 0) {
      await delay(spec.delayBodyMs);
      if (res.destroyed || res.writableEnded) {
        recorded.truncated = "client-gone";
        return;
      }
    }

    const slices = planSlices(spec);
    const drained = await drainPlan(res, slices, spec.truncateAfterWrites, spec.framing !== "frames");
    recorded.writes = drained.writes;
    recorded.truncated = drained.truncated;

    if (drained.truncated === true) {
      // 半截流：**destroy 而不是 end**——chunked 编码没有终止块，客户端必须看到
      //  premature close；这正是假 fetch 永远造不出来的形状。
      if (spec.destroyDelayMs > 0) await delay(spec.destroyDelayMs);
      req.socket.destroy();
      return;
    }
    if (drained.truncated === "socket-closed" || drained.truncated === "client-gone") return;

    if (spec.endAfterFrames !== false) {
      await new Promise((resolve) => {
        if (res.destroyed || res.writableEnded) return resolve(undefined);
        res.end(resolve);
      });
      recorded.completed = true;
    }
  };

  return {
    async listen() {
      if (server) return baseUrl;
      server = http.createServer((req, res) => {
        const running = handler(req, res)
          .catch((err) => {
            options.onError?.(err);
            if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
            res.destroy();
          })
          .finally(() => inFlight.delete(running));
        inFlight.add(running);
      });
      server.on("connection", (socket) => {
        pending.add(socket);
        socket.on("close", () => pending.delete(socket));
        socket.on("error", () => pending.delete(socket));
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(undefined));
      });
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      return baseUrl;
    },

    get baseUrl() {
      return baseUrl;
    },

    get port() {
      return server?.address()?.port ?? 0;
    },

    get requests() {
      return requests;
    },

    get responses() {
      return responses;
    },

    get requestCount() {
      return requests.length;
    },

    pathsFor(limit) {
      const list = requests.map((entry) => entry.path);
      return limit === undefined ? list : list.slice(0, limit);
    },

    // 等到所有在进请求的 handler 跑完：要断言 `responses[i].writes` / `truncated`
    // 这类**服务端侧**记录时必须先 await 它（客户端完成 ≠ 服务端写完）。
    async settled() {
      for (let round = 0; round < 50; round += 1) {
        if (inFlight.size === 0) return;
        await Promise.allSettled([...inFlight]);
      }
    },

    // 等到上游真的收到第 n 个请求（可推进的判定，不靠拍估定的毫秒数）：
    // 验证“外部中止”时必须先确认请求已经发出去，否则中止发生在连接建立之前，
    // 上游一条也没收到，“不发第二发”会退化成“一发也没发”。
    async waitForRequests(count = 1, timeoutMs = 500) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count) {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1);
          timer.unref?.();
        });
      }
      return true;
    },

    reset() {
      requests.length = 0;
      responses.length = 0;
    },

    async close() {
      if (closed) return;
      closed = true;
      if (!server) return;
      const closing = new Promise((resolve) => {
        server.close(() => resolve(undefined));
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      for (const socket of pending) socket.destroy();
      pending.clear();
      await closing;
      server = undefined;
      baseUrl = "";
    },
  };
}

export const DEFAULT_IRREGULAR_SLICE_CYCLE = DEFAULT_SLICE_CYCLE;
