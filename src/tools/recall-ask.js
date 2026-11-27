// @ts-check
// issue #896 §3-C（PR #969 复审①）：让**模型**能发起的单发回忆检索工具 `recall_ask`。
//
// 为什么需要它：`recallOnce`（`src/loop/recall-runner.js`）是个单发回忆调用的**单元**，但它没有
// 任何生产路径会走到——orchestrator 不调、工具面没有入口、`record.recallEvidence` 从不被写。
// 本文件把它接成一个**内置工具**：模型给「问题 + 要回忆的轮区间」，引擎就从**账本原文**取那些轮
// 的消息、拼进单发请求、每片算 sha256 落证据。
//
// 与 `recall_read` 的分工：`recall_read` 是**确定性回账本**（逐字/grep/按 ref 回验）；`recall_ask`
// 是**让一个回忆模型在指定轮区间的原文里找证据**（单发、只指不说）。两者的原文口径必须一致：本工具
// 用 `collectRoundMessagesInRange`（与 `recall_read` 的 evidenceRead/逐字模式同一套账本行口径）取原文，
// 再用 `recallOnce` 内的 `buildRecallRequest` 在同一段切片上算指纹——于是 `recall_ask` 返回的
// `evidenceRefs[]` 拿去 `recall_read({evidenceRef})` 必然逐字对得上（复审②：指纹落**账本原文**，不是摘要）。
//
// 纪律（照抄 recall-runner，六条）：单发、`maxTokens` 硬顶、`temperature:0`、超时码 `recall_timeout`、
// 用量走 engine 桶（经注入的 `addUsage`，缺省 no-op）、**端口没有主 provider 兜底**——
// `recallProvider` 端口不提供 ⇒ `status:"unavailable"`（不抛、不降级、一条 provider 都不调）。
//
// 端口从哪来：`recall_ask` 由**宿主显式挂载**（同 `recall_read`，不进默认工具面），而 `recallProvider`
// 端口由 **orchestrator 透传进工具上下文**（`baseToolContext`，仿 `noteTools` 注入先例）。故本工具从
// `executeTool(request)` 收到的 `request.context.recallProvider` 读端口——run 作用域的东西**每次调用**经
// context 显式取，不反向 import orchestrator。

import { recallOnce } from "../loop/recall-runner.js";
import { collectRoundMessagesInRange } from "./recall.js";

/** 端口缺失时的统一不可用话术（含「不可用」「未提供」，与 recall-runner 同口径）。 */
const UNAVAILABLE_REASON = "recallProvider 未提供：回忆能力不可用（不是降级到主 provider）";

/** @param {any} v @returns {boolean} */
function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v >= 1;
}

/** 缺省用量替身：context 没给 `addUsage` 时 no-op（不影响返回契约）。 */
const NOOP_ADD_USAGE = () => {};
/** 缺省 await 替身：context 没给 `awaitWithAbort` 时直接 await。 */
const PASS_THROUGH_AWAIT = (/** @type {Promise<any>} */ p) => p;

/**
 * 组装 `recall_ask` 的工具定义。
 * @type {object}
 */
const RECALL_ASK_DEFINITION = {
  name: "recall_ask",
  description:
    "对指定轮区间发起一次**单发回忆检索**：把要回忆的那几轮（往往正是被折叠掉的那几轮）的**账本原文**喂给一个回忆模型，让它只指不说——只给答案指针，绝不改写。when-to-use：需要「回忆」某段已折叠历史里写过什么时调用。fromRound/toRound 指定要回忆的轮区间（含端点，轮号 1 起）；引擎从账本原文取这些轮的消息（消息行 + 轮载体行同口径），按切片拼进请求、每片算 sha256 落证据。返回 status：found 拿到回忆结果（answer/answerUnbacked/nextStep/uncertain/pointers/evidenceRefs/evidenceCount）；unavailable recallProvider 端口未提供（不降级、不调任何 provider）；invalid 入参非法（question 空、轮区间非法）；timeout 回忆端口超时。返回的 evidenceRefs[] 是**收窄子集**（只留与 pointers 轮重叠的，无 pointers 取前 3 条、至多 5 条；evidenceCount 是台账里的指纹总数，落账一条不少），可交给 recall_read({evidenceRef}) 回账本逐字回验。answerUnbacked 是**引擎算的事实**（不是模型自评）：true 表示这条答案没指认任何本次切片区里的轮——指针为空，或指针指的轮不在切片区（幻觉轮号）——即它在账本上核不动；uncertain 才是模型自评的把握。两者相互独立。显式挂载（同 recall_read，不进默认工具面）。",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, description: "要回忆的问题" },
      fromRound: { type: "integer", minimum: 1, description: "要回忆的轮区间下界（含端点）" },
      toRound: { type: "integer", minimum: 1, description: "要回忆的轮区间上界（含端点）" },
    },
    required: ["question", "fromRound", "toRound"],
    additionalProperties: false,
  },
};

/**
 * 创建 `recall_ask` 内置工具的工厂。
 *
 * 默认不挂进任何默认工具面——由宿主显式挂载（同 `recall_read`）。`recallProvider` 端口由
 * orchestrator 经工具上下文透传，本工厂**不**接端口。
 *
 * @param {{
 *   readLedgerRows: () => Promise<any[]> | any[],
 *   recordEvidence?: (entry: {round:number, textSha256:string, occurrence:number, charRange:[number,number], sha256:string, bytes:number}) => void,
 * }} options
 *   - `readLedgerRows`：只读访问器，返回该 run 的账本行（`store.load(runId)` 的输出）。
 *   - `recordEvidence`：可选。每片指纹经它落 `record.recallEvidence`；不提供就只在返回里给 `evidenceRefs`。
 * @returns {{ definitions: object[], executeTool: (req: any) => Promise<string> }}
 */
export function createRecallAskTool(options = {}) {
  const accessor = options?.readLedgerRows;
  if (typeof accessor !== "function") {
    throw new TypeError("createRecallAskTool requires options.readLedgerRows to be a function");
  }
  const recordEvidence = typeof options?.recordEvidence === "function" ? options.recordEvidence : undefined;

  /**
   * @param {string} reason
   * @param {string} status
   * @returns {string}
   */
  const envelope = (status, reason) => JSON.stringify({
    status,
    reason,
    answer: "",
    pointers: [],
    uncertain: true,
    evidenceRefs: [],
  });

  async function recallAsk(/** @type {any} */ input, /** @type {any} */ context) {
    // 1) 端口从**工具上下文**取（orchestrator 注入）。缺 ⇒ unavailable：不读账本、不调任何 provider、
    //    不降级到主 provider（复审①的核心：端口没有主 provider 兜底）。
    const provider = context?.recallProvider;

    // 2) 入参校验：question 非空串、轮区间为 ≥1 正整数且 fromRound ≤ toRound。
    const question = input?.question;
    if (typeof question !== "string" || question.length === 0) {
      return envelope("invalid", "question 必须是非空字符串");
    }
    const fromRound = input?.fromRound;
    const toRound = input?.toRound;
    if (!isPositiveInt(fromRound) || !isPositiveInt(toRound)) {
      return envelope("invalid", "fromRound / toRound 必须是 ≥1 的正整数");
    }
    if (fromRound > toRound) {
      return envelope("invalid", `fromRound(${fromRound}) 不得大于 toRound(${toRound})`);
    }
    if (provider === undefined || provider === null) {
      return envelope("unavailable", UNAVAILABLE_REASON);
    }

    // 3) 从**账本原文**取区间内的轮消息（与 recall_read 同口径），过滤掉空原文（空切片不是合法证据）。
    let rows;
    try {
      rows = await accessor();
    } catch {
      return envelope("invalid", "无法读取账本");
    }
    if (!Array.isArray(rows)) rows = [];
    const slices = collectRoundMessagesInRange(rows, fromRound, toRound).filter((s) => s.text.length > 0);
    // 内容寻址透传（PR #973）：每片带 `textSha256`（那条消息整段正文的 sha256）+ `occurrence`（该轮内
    // 同正文第几次出现，0 基）+ `round`（定位必需），而不是行身份 rowSeq——真实写侧轮载体行无 seq、
    // 消息行又被 store.load() 折进载体，行会漂；内容不变则身份不变。
    const folds = slices.map((s) => ({ round: s.round, textSha256: s.textSha256, occurrence: s.occurrence, text: s.text }));

    // 4) 单发回忆调用：端口、用量、abort、超时全部**每次调用**经 deps 传入（缺省走安全默认）。
    /** @type {any} */
    let result;
    try {
      result = await recallOnce(
        {
          recallProviderPort: provider,
          addUsage: typeof context?.addUsage === "function" ? context.addUsage : NOOP_ADD_USAGE,
          awaitWithAbort: typeof context?.awaitWithAbort === "function" ? context.awaitWithAbort : PASS_THROUGH_AWAIT,
          signal: context?.signal,
          timeoutMs: Number.isFinite(context?.recallTimeoutMs) ? context.recallTimeoutMs : undefined,
        },
        { question, folds },
      );
    } catch (error) {
      if (error && /** @type {any} */ (error).code === "recall_timeout") {
        return envelope("timeout", "回忆端口超时（recall_timeout）");
      }
      throw error;
    }

    // 端口存在却仍报不可用（防御分支）：同样回 unavailable，不降级。
    if (result?.available === false) {
      return envelope("unavailable", typeof result.reason === "string" ? result.reason : UNAVAILABLE_REASON);
    }

    // 5) 每片指纹经 `recordEvidence` 落 `record.recallEvidence`——落账**不受收窄影响**（#261127-13）：
    //    全部指纹一条不少地进账本，可验证性一字不变。
    const allRefs = Array.isArray(result?.evidence) ? result.evidence : [];
    if (recordEvidence !== undefined) {
      for (const entry of allRefs) {
        recordEvidence(entry);
      }
    }

    // 6) 返回给模型的 `evidenceRefs` **收窄**（#261127-13 真机评测：56 条指纹把答案淹了）：
    //    只留与 `pointers` 按 `round` 重叠的那些（refs 的用途是「回验答案指过的那几片」，不是把
    //    整个账本倒出来）；无 pointers 时取前 3 条；上限 5 条，总数经 `evidenceCount` 告知。
    const pointers = Array.isArray(result?.pointers) ? result.pointers : [];
    const pointerRounds = new Set(pointers.map((/** @type {any} */ p) => p.round));
    const pointed = pointers.length > 0
      ? allRefs.filter((/** @type {any} */ ref) => pointerRounds.has(ref.round))
      : [];
    const evidenceRefs = (pointers.length > 0 ? pointed : allRefs.slice(0, 3)).slice(0, 5);
    // 7b) 「这条答案在账本上有没有落脚点」是**引擎算的**，不是模型自评（#261127-16 真机评测：场景 4 里
    //     模型答对了却一条指针都没给 ⇒ 影子当事实）。判据是**指针与切片的交集**：模型指了轮、那些轮
    //     又真在台账里 ⇒ 有落脚点；指针为空、或指针指的轮根本不在本次切片区里（幻觉轮号）⇒ 无落脚点。
    //     引擎不评价答案**对不对**（它读不懂），只陈述「能不能回账本核」。
    const answerUnbacked = pointed.length === 0;

    // 7) `nextStep` 是「到此为止」信号：两句都是**事实陈述**（陈述「直接用/还能做什么」），
    //    不是命令——不许写成「你必须…」。
    const uncertain = result?.uncertain === undefined ? true : result.uncertain;
    // 两句都是**事实陈述**，不是命令：引擎不校验答案内容，`uncertain` 是**模型自评**，
    // 所以这里不许写「直接用它」「这就是事实」这类替模型背书的话（copilot 复审点出来的）。
    // 两句都只**陈述事实**，不命令、不替模型背书：引擎不校验答案内容，`uncertain` 是**模型自评**；
    // 所以这里只报「自评值是什么」+「可核对的入口有哪些」，不写「直接用它」「应当去核」。
    const nextStep = uncertain
      ? "uncertain=true 是模型自评（引擎不校验答案内容）；可核对的入口："
        + "recall_read({pattern}) 在账本上检索、recall_read({evidenceRef}) 逐字回账本。"
      : "uncertain=false 是模型自评（引擎不校验答案内容）；可核对的入口："
        + "recall_read({evidenceRef}) 逐字回账本、recall_read({pattern}) 在账本上检索。";

    // 键顺序就是模型读到的顺序（#261127-13）：`answer` 紧跟 `status` 第一眼看到，
    // `evidenceRefs` / `evidenceCount` 沉底——答案不被埋在一片指纹底下。
    return JSON.stringify({
      status: "found",
      answer: result?.answer ?? "",
      // 紧贴 `answer` 之后：这是引擎对「答案有没有落脚点」的**事实陈述**，与模型自评的 `uncertain`
      // 是两个不同的问题（`uncertain` = 模型自己有多大把握；`answerUnbacked` = 账本上核不核得动）。
      answerUnbacked,
      nextStep,
      uncertain,
      pointers,
      evidenceRefs,
      evidenceCount: allRefs.length,
    });
  }

  /**
   * @param {any} request 引擎传入的工具调用：`{name, input, context, signal}`；也接受裸 input。
   * @returns {Promise<string>}
   */
  async function executeTool(request) {
    const isStructured = request !== null && typeof request === "object" && !Array.isArray(request)
      && typeof request.name === "string";
    const input = isStructured ? request.input : request;
    const context = isStructured ? request.context : undefined;
    return recallAsk(input ?? {}, context ?? {});
  }

  return {
    definitions: [RECALL_ASK_DEFINITION],
    executeTool,
  };
}
