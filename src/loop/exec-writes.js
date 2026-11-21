// @ts-check
// issue #711：从 `exec` 的 `command` 里读出「本 run 声明要写哪些文件」。
//
// 为什么需要这一份：写台账（`fileWrites`）过去只认**写工具**声明的路径（`rawWritePaths`），
// 而模型大量用 shell 落盘 —— `cat > f <<'EOF'` / `echo x > f` / `tee f` / `sed -i … f`。
// 那些写对引擎不可见，于是 `--require-deliverable` 的布尔简写对「只会用 shell 落盘」的模型
// **空洞为真**（台账空集 ⇒ 没有东西要核），final guard 也拿不到 exec 的产物。
//
// 两条口径，**分别**成立，不许混（这是本单的诚实性核心）：
//   * **计数面** `writeFormCount`：出现写形态（heredoc / `>` / `>>` / `tee` / `sed -i`）的
//     **命令条数**。解析不出目标也算 —— 它说的是「这里有写、我不全知道」，不是「我写了几次」。
//   * **台账面** `writes`：**只放解析得出来、且能化成绝对路径**的目标。解析不出来就**不进**，
//     绝不猜（猜一个错路径进台账，宿主会去核一个模型根本没写的文件 —— 那是比盲区更坏的假事实）。
//
// 「解析不出来」的判定（一律只计数、不记路径）：目标是变量 / 命令替换 / 反引号 / 通配符 /
// 花括号展开，或者命令结构读不懂（未闭合引号、heredoc 定界符本身是变量、嵌套子 shell）。
// 相对路径需要 run 的 `cwd` 才能绝对化：**没有 `cwd` 就不记**（也是「不猜」）。
//
// 排除 `/dev/` 下的全部路径（`/dev/null`、`/dev/stdout`、`/dev/stderr` 在内）：写到设备是
// **看得见的丢弃**，不是盲区 —— 它既不进台账，也不该把「我看不见」的旗子举起来。
//
// 只认工具名 `exec`（与 `termination.js` 的 `isFileWritesBlind` 数的是**同一个名字**，
// 常量在这里导出，别处引它，别再各写一份字面量）。不加开关：要更宽的口径请宿主用
// `deliverables` 自己声明判据（issue #711「明确不做」那一节）。

import path from "node:path";

/** 引擎里「shell 工具」的固定名字（与 `toolStats` / 台账 `tool` 字段同口径）。 */
export const EXEC_TOOL_NAME = "exec";

/** 台账条目第四个键 `via` 的取值（exec 来源条目的写形态；非 exec 条目**不写**这个键）。 */
export const EXEC_WRITE_VIA = Object.freeze({
  heredoc: "heredoc",
  redirect: "redirect",
  tee: "tee",
  sedI: "sed-i",
});

/** 写在设备上是丢弃，不是盲区（`/dev/` 前缀整族排除，判据 2「`/dev/*` 一律排除」）。 */
const DEV_PREFIX = "/dev/";

/** 命令名前面可以跳过的包装词（`sudo tee f`、`nohup sed -i …`）。 */
const WRAPPER_WORDS = new Set(["sudo", "env", "nohup", "exec", "time", "command", "nice"]);

/**
 * 不透明解释器：真正的写藏在引号里、分词器看不见（`bash -c 'echo x > out'`）。
 * 与 {@link WRAPPER_WORDS} 的分工：包装词跳过后下一词仍是看得见的命令（`sudo tee f` 照常解析）；
 * 不透明解释器的**载荷文本**才是写所在，只能当字符串扫（阻断①）。
 */
const OPAQUE_C_WRAPPERS = new Set(["bash", "sh", "dash", "ksh", "zsh"]);
/** 把「之后的整段」当脚本解释的不透明包装词（`eval 'echo x > out'`）。 */
const OPAQUE_REST_WRAPPERS = new Set(["eval"]);
/** 把「之后的命令词」拼成一行执行的包装词（`… | xargs sh -c '… > …'`）。 */
const OPAQUE_ARG_WRAPPERS = new Set(["xargs"]);

/** 会让目标「不确定」的 shell 展开字符（通配 / 花括号展开）。 */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * 一个 token：`word` 是命令里的一个词（带「被引号包过」「含变量展开」两个诚实标记），
 * `op` 是控制符。**token 只在这里表达引擎读得懂的东西**，读不懂的结构直接不进 token 流。
 * @typedef {{type:"word", value:string, quoted:boolean, expansion:boolean, start:number, end:number}
 *   | {type:"op", value:string, start:number, end:number}} Token
 */

/**
 * 把一条 shell 命令切成 token。
 *
 * 刻意**不是**一个完整的 shell 解析器：它只保证「读得懂的部分精确，读不懂的部分不要瞎猜」。
 * 读不懂时的动作是**停止扫描**（已收集的 token 仍然有效），不是继续硬解析。
 *
 * @param {string} command
 * @returns {{tokens: Token[], truncated: boolean, unterminated: boolean}} `truncated` = 后面有读不懂的东西被放弃了
 *   （已收集的 token 仍有效）；`unterminated` = 未闭合引号/反引号/`$(…`/`${…` 使整条命令不可执行。
 */
function tokenize(command) {
  /** @type {Token[]} */
  const tokens = [];
  /**
   * 行内尚未收尾的词：`word` 是正在攒的词（`null` = 还没有词）。
   * 初始化处用类型断言而不是 `@type` 注释：`startWord` / `flush` 闭包里的赋值 CFG 看不见，
   * 注释声明会被控制流收窄钉死成字面量 `null`，每条 `word += …` 都成 TS2322；
   * 声明处断言让收窄保持为 `string|null`（纯类型层，零运行时变化）。
   */
  let word = /** @type {string|null} */ (null);
  let wordQuoted = false;
  let wordExpansion = false;
  let wordStart = 0;
  /** 本行声明的 heredoc 定界符（一行可以有两个，按出现顺序消费正文）。 */
  /** @type {{text:string, stripTabs:boolean}[]} */
  const pending = [];
  let truncated = false;
  // 命令本身不可执行（未闭合引号 / 反引号 / 未闭合 `$(…` / `${…` ⇒ bash 直接报 unexpected EOF）。
  // 与 `truncated` 的分工：`truncated` = 后面读不懂但**已读的 token 仍有效**（变量定界符、heredoc 正文未完）；
  // `unterminated` = 整条命令根本不会被执行 ⇒ 连已读的写目标也不算（阻断②：假事实比盲区更坏）。
  let unterminated = false;
  let i = 0;

  /** @param {number} at 词收尾的位置（下标） */
  const flush = (at) => {
    if (word !== null) {
      tokens.push({ type: "word", value: word, quoted: wordQuoted, expansion: wordExpansion, start: wordStart, end: at });
      word = null;
      wordQuoted = false;
      wordExpansion = false;
    }
  };
  /**
   * @param {string} value 控制符文本
   * @param {number} at 起始位置（下标）
   */
  const pushOp = (value, at) => {
    flush(at);
    tokens.push({ type: "op", value, start: at, end: at + value.length });
  };
  const startWord = () => {
    if (word === null) {
      word = "";
      wordStart = i;
    }
  };

  while (i < command.length) {
    const ch = command[i];
    if (ch === " " || ch === "\t" || ch === "\r") {
      flush(i);
      i += 1;
      continue;
    }
    if (ch === "\n") {
      flush(i);
      const at = i;
      i += 1;
      // heredoc 正文从**下一行**开始；正文整体跳过 —— 正文里的 `>` 是文本，不是重定向。
      while (pending.length > 0) {
        const lineStart = i;
        const nextBreak = command.indexOf("\n", lineStart);
        const rawLine = nextBreak === -1 ? command.slice(lineStart) : command.slice(lineStart, nextBreak);
        const wanted = pending[0];
        const candidate = wanted.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
        i = nextBreak === -1 ? command.length : nextBreak + 1;
        if (candidate === wanted.text) {
          pending.shift();
        } else if (nextBreak === -1) {
          // 定界符到不了：剩下的全是正文（也可能整条命令本来就没写完）⇒ 保守放弃后面的扫描。
          truncated = true;
          break;
        }
      }
      tokens.push({ type: "op", value: "\n", start: at, end: i });
      if (truncated) break;
      continue;
    }
    if (ch === "\\") {
      if (command[i + 1] === "\n") {
        // 续行：换行被吃掉，词不断开。
        i += 2;
        continue;
      }
      if (i + 1 < command.length) {
        startWord();
        word += command[i + 1];
        wordQuoted = true; // 转义出来的字符是字面量（`my\ file` 是一个词）
        i += 2;
        continue;
      }
      truncated = true;
      break;
    }
    if (ch === "#") {
      // 词首的 `#` 起注释（词中的 `a#b` 是文件名的一部分）。
      const prev = i === 0 ? "" : command[i - 1];
      if (word === null && (i === 0 || /[\s;|&()<>]/.test(prev))) {
        const nextBreak = command.indexOf("\n", i);
        i = nextBreak === -1 ? command.length : nextBreak;
        continue;
      }
    }
    if (ch === "'") {
      startWord();
      i += 1;
      const close = command.indexOf("'", i);
      if (close === -1) {
        word += command.slice(i);
        wordQuoted = true;
        i = command.length;
        truncated = true; // 未闭合引号：后面读不懂，且整条不可执行
        unterminated = true;
        break;
      }
      word += command.slice(i, close);
      wordQuoted = true;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      startWord();
      i += 1;
      let closed = false;
      while (i < command.length) {
        if (command[i] === "\\" && i + 1 < command.length) {
          if (command[i + 1] !== "\n") word += command[i + 1];
          wordQuoted = true;
          i += 2;
          continue;
        }
        if (command[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        // 双引号**不**阻止展开：`"$OUT"` 的值仍然不在引擎眼前 ⇒ 整个词标成不确定。
        if (command[i] === "$" || command[i] === "`") wordExpansion = true;
        word += command[i];
        i += 1;
      }
      wordQuoted = true;
      if (!closed) {
        truncated = true;
        unterminated = true;
        break;
      }
      continue;
    }
    if (ch === "`") {
      startWord();
      const close = command.indexOf("`", i + 1);
      if (close === -1) {
        truncated = true;
        unterminated = true;
        break;
      }
      wordExpansion = true;
      i = close + 1;
      continue;
    }
    if (ch === "$") {
      startWord();
      wordExpansion = true;
      if (command.startsWith("$(", i)) {
        // 命令替换 / 算术替换：跳过配对括号，内部结构不解释（`$(pick.sh)` 读不出目标）。
        let depth = 0;
        let j = i + 1;
        let done = false;
        for (; j < command.length; j += 1) {
          if (command[j] === "(") depth += 1;
          else if (command[j] === ")") {
            depth -= 1;
            if (depth === 0) {
              j += 1;
              done = true;
              break;
            }
          }
        }
        if (!done) {
          truncated = true;
          unterminated = true;
          i = command.length;
          break;
        }
        i = j;
        continue;
      }
      if (command[i + 1] === "{") {
        const close = command.indexOf("}", i + 2);
        if (close === -1) {
          truncated = true;
          unterminated = true;
          i = command.length;
          break;
        }
        i = close + 1;
        continue;
      }
      i += 1;
      while (i < command.length && /[\w]/.test(command[i])) i += 1;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        // `<<<` here-string：写的是 stdin，不落盘。
        pushOp("<<<", i);
        i += 3;
        continue;
      }
      const stripTabs = command[i + 2] === "-";
      pushOp(stripTabs ? "<<-" : "<<", i);
      i += stripTabs ? 3 : 2;
      while (i < command.length && (command[i] === " " || command[i] === "\t")) i += 1;
      const delimiter = readHeredocDelimiter();
      if (delimiter === null) {
        // 定界符**引号没闭合**（`<<'EOF`）或整条没有定界符 ⇒ heredoc 语法不完整、bash 根本不执行。
        // 与「未闭合引号」同口径：`unterminated` ⇒ 前面已读出的 `>` 目标也只计数、不记路径（阻断 B）。
        truncated = true;
        unterminated = true;
        break;
      }
      if (delimiter.expansion || delimiter.text === "") {
        // 定界符本身是变量（`<<$D`）⇒ 正文边界找不到 ⇒ 放弃后续扫描。但命令本身可执行 ⇒ **只**截断、
        // **不**置 unterminated：早停前读出的 `>` 目标是真目标，不许连坐丢弃（判据 5）。
        truncated = true;
        break;
      }
      pending.push({ text: delimiter.text, stripTabs });
      continue;
    }
    if (ch === ">" && command[i + 1] === ">") {
      pushOp(">>", i);
      i += 2;
      continue;
    }
    if (ch === ">" && command[i + 1] === "&") {
      const after = command[i + 2];
      if (after === undefined || after === "-" || /\d/.test(after)) {
        pushOp(">&fd", i); // `>&2` / `>&-`：dup 到 fd，不是文件
        i += after === undefined ? 2 : 3;
        continue;
      }
      pushOp(">&", i);
      i += 2;
      continue;
    }
    if (ch === ">") {
      pushOp(">", i);
      i += 1;
      continue;
    }
    if (ch === "&" && command[i + 1] === ">") {
      pushOp(command[i + 2] === ">" ? "&>>" : "&>", i);
      i += command[i + 2] === ">" ? 3 : 2;
      continue;
    }
    if (ch === "<") {
      pushOp("<", i); // stdin 重定向：读，不是写
      i += 1;
      continue;
    }
    if (ch === "|") {
      const two = command[i + 1] === "|";
      pushOp(two ? "||" : "|", i);
      i += two ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      const two = command[i + 1] === "&";
      pushOp(two ? "&&" : "&", i);
      i += two ? 2 : 1;
      continue;
    }
    if (ch === ";") {
      pushOp(";", i);
      i += 1;
      continue;
    }
    if ((ch === "(" || ch === ")") && word === null) {
      // **词首**的括号才是子 shell（bash 的规矩）；词中的 `out(1).txt` 是文件名的一部分。
      // 花括号当普通字符：`file{1,2}.txt` 由 GLOB_CHARS 标成不确定，而不是被切成三段。
      pushOp(ch, i);
      i += 1;
      continue;
    }
    startWord();
    word += ch;
    i += 1;
  }
  flush(command.length);

  /** 读 heredoc 的定界符（可以带引号、可以是变量）。 */
  function readHeredocDelimiter() {
    let text = "";
    let expansion = false;
    const before = i;
    while (i < command.length && command[i] !== " " && command[i] !== "\t" && command[i] !== "\n" && command[i] !== ";") {
      const c = command[i];
      if (c === "'") {
        const close = command.indexOf("'", i + 1);
        if (close === -1) return null;
        text += command.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (c === '"') {
        const close = command.indexOf('"', i + 1);
        if (close === -1) return null;
        text += command.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (c === "$" || c === "`") expansion = true;
      text += c;
      i += 1;
    }
    if (i === before) return null;
    return { text, expansion };
  }

  return { tokens, truncated, unterminated };
}

/**
 * 把 fd 前缀（`2>` 里的 `2`）从词里摘掉：它紧贴着重定向符，不是操作数。
 *
 * @param {Token} token
 * @param {Token|undefined} next
 * @returns {boolean}
 */
function isFileDescriptorPrefix(token, next) {
  return token.type === "word"
    && !token.quoted
    && /^\d+$/.test(token.value)
    && next !== undefined
    && next.type === "op"
    && next.start === token.end;
}

/**
 * 按控制符切段：一段 = 一条简单命令。
 *
 * @param {Token[]} tokens
 * @returns {Token[][]}
 */
function splitSegments(tokens) {
  /** @type {Token[][]} */
  const segments = [[]];
  for (const token of tokens) {
    if (token.type === "op" && ["|", "||", "&&", ";", "&", "\n", "(", ")"].includes(token.value)) {
      segments.push([]);
      continue;
    }
    segments[segments.length - 1].push(token);
  }
  return segments.filter((segment) => segment.length > 0);
}

/**
 * 把「词」解析成台账要的**绝对路径**。
 *
 * @param {Token|undefined} token
 * @param {{cwd?: unknown, allowRelative?: boolean}} options
 * @returns {string|null} 解析不出来 ⇒ `null`（只计数，不记路径）
 */
function resolveTargetPath(token, options) {
  if (token === undefined || token.type !== "word") return null;
  if (token.expansion) return null; // `$OUT` / `$(pick.sh)` / 反引号 —— 值不在引擎眼前
  const text = token.value;
  if (text === "" || GLOB_CHARS.test(text)) return null; // 通配/花括号展开：可能是 0 个或 N 个文件
  const cwd = typeof options.cwd === "string" ? options.cwd : "";
  let absolute;
  if (path.isAbsolute(text)) {
    absolute = path.resolve(text);
  } else {
    // 相对路径要靠 run 的 cwd 绝对化；没有 cwd 就不猜（判据 1 要的是绝对路径）。
    // 命令里出现过 `cd` ⇒ 相对路径的基准**不再是** run 的 cwd ⇒ 同样不猜。
    if (cwd === "" || options.allowRelative === false) return null;
    absolute = path.resolve(cwd, text);
  }
  if (absolute === DEV_PREFIX || absolute.startsWith(DEV_PREFIX)) return null;
  return absolute;
}

/**
 * 词面就是设备路径（`/dev/…`）⇒「看得见的丢弃」：既不进台账、**也不计数**、不举旗（阻断③）。
 * 与 {@link resolveTargetPath} 对 `/dev` 也返回 `null` 的分工：后者只管「不记路径」，
 * 这里管「连写形态都不算」——否则 `cat a > /dev/null` 会误举细盲区旗。
 * 带变量展开的不算（`>/dev/$FD` 的值不在引擎眼前，不能断定是设备）。
 *
 * @param {Token|undefined} token
 * @returns {boolean}
 */
function isDevTarget(token) {
  if (token === undefined || token.type !== "word" || token.expansion) return false;
  return token.value === DEV_PREFIX.slice(0, -1) || token.value.startsWith(DEV_PREFIX);
}

/** 把输出重定向到文件的运算符（`>&fd` 不在内：那是 dup 到 fd，不是文件）。 */
const REDIRECT_OPS = [">", ">>", ">&", "&>", "&>>"];

/** `sed` 里需要下一个词作值的选项（下一个词是**选项的值**，不是文件操作数）。 */
const SED_VALUE_OPTIONS = new Set(["-e", "--expression", "-f", "--file", "--delimiter"]);
/** `tee` 没有取值选项（`-a` 是开关）。 */
const NO_VALUE_OPTIONS = new Set();

/**
 * 摘掉紧贴重定向符的 fd 前缀（`cmd 2>err.log` 里的 `2` 不是操作数）。
 *
 * @param {Token[]} tokens
 * @returns {Token[]}
 */
function stripFdPrefixes(tokens) {
  /** @type {Token[]} */
  const cleaned = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (isFileDescriptorPrefix(tokens[index], tokens[index + 1])) continue;
    cleaned.push(tokens[index]);
  }
  return cleaned;
}

/**
 * 读一条 exec 命令里的写形态与写目标。
 *
 * @param {unknown} command `exec` 的 `input.command`（不是非空字符串 ⇒ 什么都不说）
 * @param {{cwd?: unknown}} [options] `cwd` = 该 run 的 `config.run.cwd`（原样，引擎不校验它）
 * @returns {{hasWriteForm: boolean, targets: {path:string, via:string}[], unresolvedWriteCount: number}}
 *   `unresolvedWriteCount` = 本条命令里「有写形态、但目标解析不出 / 结构读不懂 / 被截断 /
 *   来自不透明包装」的写**目标个数**（至少 1 就举旗）；台账里进不去的那些都算它。
 */
export function parseExecCommandWrites(command, options = {}) {
  if (typeof command !== "string" || command.trim() === "") return { hasWriteForm: false, targets: [], unresolvedWriteCount: 0 };
  const { tokens: rawTokens, unterminated } = tokenize(command);
  const segments = splitSegments(stripFdPrefixes(rawTokens));
  // 命令里出现过 `cd`（含子 shell `(cd d && …)`）⇒ 相对路径的基准**不再是** run 的 cwd ⇒ 只认绝对路径。
  const allowRelative = !segments.some((segment) => {
    const head = commandWordOf(segment.filter((token) => token.type === "word"));
    return head !== null && path.posix.basename(head.value) === "cd";
  });
  const resolveOptions = { cwd: options.cwd, allowRelative };

  /** @type {{path:string, via:string}[]} */
  const targets = [];
  let hasWriteForm = false;
  let unresolvedWriteCount = 0;
  /**
   * @param {Token} token
   * @param {string} via 写形态（`EXEC_WRITE_VIA` 之一）
   */
  const pushTarget = (token, via) => {
    if (isDevTarget(token)) return; // 设备：既不进台账、也不计数、不举旗（阻断③）
    hasWriteForm = true; // 目标解析不出来也要计数：那是「有写、我不全知道」（甲的计数面）
    if (unterminated) { unresolvedWriteCount += 1; return; } // 整条不可执行 ⇒ 只计数、不记路径（阻断②）
    const resolved = resolveTargetPath(token, resolveOptions);
    if (resolved !== null) targets.push({ path: resolved, via });
    else unresolvedWriteCount += 1; // 有写形态、目标解析不出 ⇒ 计入未解析（阻断④）
  };

  for (const segment of segments) {
    const words = segment.filter((token) => token.type === "word");
    const sawHeredoc = segment.some((token) => token.type === "op" && (token.value === "<<" || token.value === "<<-"));
    const sawRedirectOp = segment.some((token) => token.type === "op" && REDIRECT_OPS.includes(token.value));
    // 重定向符与正文都扫过之后才知道这一段的写是不是 heredoc 喂出来的（`cat > f <<EOF` 与
    // `cat <<EOF > f` 是同一件事，via 都是 `heredoc`）。
    const redirectVia = sawHeredoc ? EXEC_WRITE_VIA.heredoc : EXEC_WRITE_VIA.redirect;
    /** @type {Token[]} */
    const redirectTokens = [];
    for (const token of segment) {
      if (token.type !== "op") continue;
      if (token.value === "<<" || token.value === "<<-") {
        // 裸 heredoc（`mysql <<SQL … SQL`）是**可见的写形态**：内容进了某个命令的 stdin，
        // 落在哪个文件看不见 ⇒ 只计数、不记路径（是否计入未解析看下面：有重定向目标时目标已认领）。
        hasWriteForm = true;
        continue;
      }
      if (REDIRECT_OPS.includes(token.value)) {
        // 重定向后紧跟的词就是目标；紧跟不上（缺词 / 换段）也算写形态，且解析不出目标 ⇒ 计入未解析。
        const target = segment[segment.indexOf(token) + 1];
        if (target !== undefined && target.type === "word") redirectTokens.push(target);
        else { hasWriteForm = true; unresolvedWriteCount += 1; }
      }
    }
    for (const token of redirectTokens) pushTarget(token, redirectVia);
    // 裸 heredoc（段内无任何重定向目标 ⇒ 内容落点看不见）⇒ 计入未解析（阻断④）。
    // 有重定向时目标已由上面认领（解析得出 ⇒ 已知；解析不出 ⇒ pushTarget 已计未解析），不重复计。
    if (sawHeredoc && !sawRedirectOp) unresolvedWriteCount += 1;

    const commandToken = commandWordOf(words);
    const toolName = commandToken === null ? "" : path.posix.basename(commandToken.value);
    const opaquePayload = opaqueWritePayloadOf(words, commandToken, toolName);
    if (opaquePayload !== null) {
      // 不透明包装（阻断①）：载荷里有写形态 ⇒ 只计数 + 记「未解析」，**绝不从载荷里提路径**；
      // 载荷里没有写形态（`bash -c 'rg foo'`）⇒ 不计数（只读包装不是写）。
      const payloadWrites = countPayloadWriteForms(opaquePayload); // 载荷里写形态的下界计数（判据 6）
      if (payloadWrites > 0) { hasWriteForm = true; unresolvedWriteCount += payloadWrites; }
    } else if (toolName === "tee") {
      const files = operandsAfter(words, commandToken, NO_VALUE_OPTIONS).filter((token) => !redirectTokens.includes(token));
      for (const file of files) pushTarget(file, EXEC_WRITE_VIA.tee);
    } else if (toolName === "sed" && hasInPlaceOption(words)) {
      // 脚本由 `-e`/`-f`（含附着式）提供 ⇒ 非选项参数**全**是文件；否则第一个位置操作数是脚本要丢掉
      // （`--` 只终止选项、不提供脚本 ⇒ 丢掉后可能一个文件都不剩 ⇒ sed 从 stdin 读，目标不明）。
      const operands = operandsAfter(words, commandToken, SED_VALUE_OPTIONS);
      const files = (sedDropsFirstAsScript(words, operands) ? operands.slice(1) : operands).filter((token) => !redirectTokens.includes(token));
      hasWriteForm = true; // `sed -i` 本身就是写形态（判据 1：无文件也要计数）
      if (files.length === 0) unresolvedWriteCount += 1; // 就地改但无文件操作数 ⇒ 有写、目标不明（判据 1）
      for (const file of files) pushTarget(file, EXEC_WRITE_VIA.sedI);
    }
  }
  return { hasWriteForm, targets, unresolvedWriteCount };
}

/**
 * 段首的「命令词」：跳过 `VAR=value` 前置赋值与 `sudo`/`env` 这类包装词。
 *
 * @param {Token[]} words 只收 word 词（调用方都先按 `type === "word"` 过滤过）
 * @returns {Token|null}
 */
function commandWordOf(words) {
  for (const token of words) {
    if (token.type !== "word") continue; // 收窄用（op 词没有 `quoted` 键）；调用方传的都是 word，此分支实际不发生
    if (token.quoted) return token; // 引号包起来的不是赋值
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) continue;
    if (WRAPPER_WORDS.has(path.posix.basename(token.value))) continue;
    return token;
  }
  return null;
}

/**
 * 不透明包装词的「载荷文本」（写形态藏在里面，分词器看不见 ⇒ 只当字符串扫，绝不提路径）。
 *   * `bash/sh/… -c <载荷>` → `<载荷>`（`-c` 的下一个词）；
 *   * `eval <整段>` → 之后的整段；
 *   * `xargs <命令词>` → 之后过滤掉选项后的命令词拼成一行。
 * 返回 `null` = 不是不透明包装（交给常规 tee/sed/重定向处理）。
 *
 * @param {Token[]} words 段内的词（调用方已按 word 过滤）
 * @param {Token|null} commandToken 段首命令词
 * @param {string} toolName 命令词的 basename
 * @returns {string|null}
 */
function opaqueWritePayloadOf(words, commandToken, toolName) {
  if (commandToken === null) return null;
  const isC = OPAQUE_C_WRAPPERS.has(toolName);
  const isRest = OPAQUE_REST_WRAPPERS.has(toolName);
  const isArgs = OPAQUE_ARG_WRAPPERS.has(toolName);
  if (!isC && !isRest && !isArgs) return null;
  const rest = words.slice(words.indexOf(commandToken) + 1);
  if (isC) {
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token.type !== "word" || token.quoted) continue; // `-c` 得是未加引号的词
      if (token.value === "-c" && rest[index + 1] !== undefined) return rest[index + 1].value;
    }
    return ""; // 无 `-c` 的 `bash script.sh`：载荷看不见，不猜为写
  }
  if (isRest) return rest.map((token) => token.value).join(" ");
  return rest
    .filter((token) => token.type === "word" && (token.quoted || !token.value.startsWith("-")))
    .map((token) => token.value)
    .join(" ");
}

/** 不透明载荷里写形态计数的上界：防病态输入（一条畸形载荷把 `unresolvedWriteCount` 撑爆）。 */
const PAYLOAD_WRITE_FORM_CAP = 32;

/**
 * 不透明载荷里写形态的出现**次数**（下界，绝不从中提路径）：`>`/`>>` 重定向、
 * heredoc `<<`、`tee`、`sed … -i`。载荷对分词器不透明 ⇒ 只能按字面数：这是「至少这么多处
 * 没解析出来」的**下界**，不是精确目标数（判据 6）。上界 {@link PAYLOAD_WRITE_FORM_CAP} 防病态输入。
 * @param {string} text
 * @returns {number}
 */
function countPayloadWriteForms(text) {
  if (text === "") return 0;
  const count = (haystack, re) => (haystack.match(re) || []).length;
  let n = count(text, />>/g); // 追加：一次写，先匹配，剩下的 `>` 不重复计
  n += count(text.replace(/>>/g, " "), />/g); // 去掉 `>>` 后余下的单个 `>`
  n += count(text.replace(/<<</g, " "), /<</g); // heredoc；`<<<` here-string 不写盘，先剔除
  n += count(text, /\btee\b/g);
  n += count(text, /\bsed\b[^\n]*\s-i/g);
  return Math.min(n, PAYLOAD_WRITE_FORM_CAP);
}

/**
 * 命令词之后的操作数（选项、选项的值、`env` 式前置赋值都排除）。
 *
 * @param {Token[]} words
 * @param {Token|null} commandToken
 * @param {Set<string>} valueOptions 需要吃掉下一个词的选项
 * @returns {Token[]}
 */
function operandsAfter(words, commandToken, valueOptions) {
  if (commandToken === null) return [];
  const rest = words.slice(words.indexOf(commandToken) + 1);
  /** @type {Token[]} */
  const operands = [];
  let expectValue = false;
  let optionsEnded = false;
  for (const token of rest) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    // `--` 之后**全**是操作数（选项解析终止）：`tee -- -out.txt` 里的 `-out.txt` 是文件名。
    if (optionsEnded) {
      operands.push(token);
      continue;
    }
    if (token.type === "word" && token.quoted) {
      operands.push(token);
      continue;
    }
    if (token.value === "--") {
      optionsEnded = true; // `--` 本身不是操作数，只切换为「后面都是文件」
      continue;
    }
    if (token.value.startsWith("-") && token.value !== "-") {
      // 取值的选项（`-f X` / `--file X`）吃掉下一个词；**附着式**（`-f=X` / `--expression=X`）值在词里，不另计。
      const eq = token.value.indexOf("=");
      const name = eq === -1 ? token.value : token.value.slice(0, eq);
      if (eq === -1 && valueOptions.has(name)) expectValue = true;
      continue; // 选项（含 `-i.bak` / `-f=script.sed`）
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) continue;
    operands.push(token);
  }
  return operands;
}

/**
 * `sed -i` / `sed -i.bak` / `sed -ni` / `--in-place[=SUFFIX]`。
 *
 * 短选项串里的 `i` 一律算就地改（`sed -ni 's/x/y/' f` 是真的在改 `f`）；长选项只认精确的
 * `--in-place`，否则 `--version` 这种词里也带 `i`。
 *
 * @param {Token[]} words
 * @returns {boolean}
 */
function hasInPlaceOption(words) {
  return words.some((token) => {
    // `token.type !== "word"` 是收窄（op 词没有 `quoted` 键）；op 值也不匹配下面任何模式，判定不变。
    if (token.type !== "word" || token.quoted || !token.value.startsWith("-")) return false;
    if (token.value.startsWith("--")) return token.value === "--in-place" || token.value.startsWith("--in-place=");
    return /^-[A-Za-z]*i[A-Za-z]*(\.|=|$)/.test(token.value);
  });
}

/**
 * `sed -i` 是否要把第一个非选项参数当**脚本**丢掉。
 *
 * 不丢（⇒ 非选项参数**全**是文件）的唯一情形：脚本由取值选项提供
 *   `-e`/`--expression`/`-f`/`--file`（含附着式 `-e=`/`--file=`）。
 * 否则第一个位置操作数就是内联脚本（`sed -i 's/x/y/' f`），要丢。
 *
 * ❗ `--` **只终止选项解析、不提供 sed 脚本**：没有 `-e`/`-f` 时，无论有没有 `--`，
 * 第一个位置操作数都是脚本。`sed -i -- -notes.md` 里 `-notes.md` 是**脚本**、没有文件
 * 操作数（sed 从 stdin 读）；`sed -i 's/a/b/' -- -notes.md` 里脚本是 `'s/a/b/'`，`--` 之后那个
 * `-notes.md` 才是文件。上一轮把 `--` 当「后面都是文件」处理，正好把这两格判反。
 *
 * @param {Token[]} words @param {Token[]} operands 已按选项规则筛出的操作数
 * @returns {boolean}
 */
function sedDropsFirstAsScript(words, operands) {
  if (operands.length === 0) return false;
  const isOptionProvidingScript = words.some((token) => {
    if (token.type !== "word" || token.quoted || !token.value.startsWith("-")) return false;
    const value = token.value;
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
    return name === "-e" || name === "--expression" || name === "-f" || name === "--file";
  });
  if (isOptionProvidingScript) return false;
  return true; // 无脚本取值选项 ⇒ 第一个位置操作数就是脚本（`--` 不改变这一点）
}

/**
 * 一批消息里所有 `exec` 调用的写形态计数与可解析目标。
 *
 * 这是台账唯一的 exec 读入口（`orchestrator.js` 的 `recordFileWrites` 调它）——
 * resume 重放轮记录也走同一个函数，所以两个方向的口径**必然**一致（#388 的教训）。
 *
 * @param {any[]} messages
 * @param {{cwd?: unknown}} [options]
 * @returns {{writeFormCount: number, writes: {path:string, via:string}[], unresolvedWriteCount: number}}
 *   `unresolvedWriteCount` = 所有 exec 命令里「有写形态、但没进台账」的写目标个数之和（阻断④）。
 */
export function scanExecWrites(messages, options = {}) {
  let writeFormCount = 0;
  let unresolvedWriteCount = 0;
  /** @type {{path:string, via:string}[]} */
  const writes = [];
  if (!Array.isArray(messages)) return { writeFormCount, writes, unresolvedWriteCount };
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "tool_use" || block.name !== EXEC_TOOL_NAME) continue;
      const parsed = parseExecCommandWrites(block.input?.command, options);
      if (!parsed.hasWriteForm) continue;
      writeFormCount += 1;
      unresolvedWriteCount += parsed.unresolvedWriteCount;
      for (const target of parsed.targets) writes.push(target);
    }
  }
  return { writeFormCount, writes, unresolvedWriteCount };
}
