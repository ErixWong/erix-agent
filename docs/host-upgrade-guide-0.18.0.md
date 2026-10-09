# Host upgrade guide: 0.18.0

0.18.0 removes nothing: no signature changed, no tool disappeared, no store format
moved. It is **not** a no-op upgrade for every host though. Three host habits break:
pinning the judge's write-tool set, asserting the file-tool name list, and matching
tool output text character for character. Each has a short self-check below; if you
do none of the three, upgrade as-is.

New symbols arrive through the **`erix-agent/tools` subpath**, never the package
root. If you wrote `import { createFileTools } from "erix-agent"`, that import fails
(section 6).

## 1. Change summary

| Change | Breaks a host that … | Section |
| --- | --- | --- |
| `writeToolNames` default is now `["writeFile", "edit"]` (issue #191) | relies on the default *or* passes its own list and expects `edit` to be merged in | 2 |
| `createFileTools().definitions` grew from 6 to 7 entries (issue #195 `searchText`, issue #191 `edit`) | asserts the tool-name list or its length | 3 |
| `rg` / `grep` append one deprecation line to **every** result (issue #195, tiering per #188) | matches alias output verbatim, counts its lines, or treats "last line" as data | 4 |
| Truncation marker wording and human-readable byte units are **Experimental** (issue #196) | parses marker text or asserts its exact wording | 5 |
| File tools and the skills loader are exported only on `erix-agent/tools` (issues #184 / #197) | imports them from the package root | 6 |

## 2. `writeToolNames`: the default grew by one entry

The judge decides "did a write happen since the last evaluation" from the tool names
in `writeToolNames`. Until 0.18.0 that set was `["writeFile"]`, so an `edit` call was
invisible to it and a run that only edited could be judged as having written nothing.
The default is now the two-name set; the single source of truth is
`DEFAULT_WRITE_TOOL_NAMES` in `src/reflection/judge.js`.

**Explicit wins outright — it is a replacement, not a merge.** Passing
`writeToolNames` yourself keeps using exactly your array; `edit` is *not* added to it.
A host that pins `["writeFile"]` today keeps the 0.17 blind spot after upgrading, and
the symptom is silent (a guard that stops firing, not an error).

```js
// The default constant is module-level: it is NOT on the public export surface,
// so you cannot import it to compare against. Write the two names yourself.
const judge = createReflectionJudge({ /* … */ writeToolNames: ["writeFile", "edit"] });
```

Self-check — find every place that pins the option, then decide per call site:

```bash
grep -rn "writeToolNames" src/ bin/ your-host/   # every explicit list is a decision point
```

Self-check — the default is **not** importable, so you cannot assert against it from
outside the module; pin it in your own test instead:

```bash
node -e "import('erix-agent').then((m) =>
  console.log(Object.keys(m).filter((k) => /write.?tool/i.test(k))));"   # → []
```

Behavioural check, the one that actually catches the regression: run a session whose
**only** write is an `edit`, then read back your own judge record for that run — it
must show a write. On 0.17 with the default list it showed none, and with an explicit
`["writeFile"]` it still shows none after upgrading.

If you rely on the default, nothing to do. If you pass a list, add `"edit"` unless you
can say why you keep it out.

## 3. `definitions` grew from six entries to seven

```
readFile / searchText / rg / grep / tree / edit / writeFile
```

`searchText` (issue #195) and `edit` (issue #191) both landed in 0.18.0, so a host that
carried a 0.17 six-name fixture is stale twice over. The assertion of record is
`fileToolsContract` in `test/contract/file-tools.js` — run that suite against your own
registration instead of trusting a hand-written list.

Self-check — print what your installed package really exposes:

```bash
node -e "import('erix-agent/tools').then((m) => {
  const names = m.createFileTools({ cwd: process.cwd() }).definitions.map((d) => d.name).sort();
  console.log(names.length, names.join(','));
  // expect: 7  edit,grep,readFile,rg,searchText,tree,writeFile
});"
```

Also update anything keyed off the count: registry fixtures, "N tools" assertions in
your snapshots, permission/allow-list tables, side-effect classifiers. **`edit` is a
write**: its `path` argument must be classified with the writes, not with the readers
(see "File edit tool `edit`" in [host-consumer-contract.md](host-consumer-contract.md)).

## 4. `rg` / `grep` now end every result with a deprecation line

One line is appended **on every call**, not only when the result is truncated. Measured
on a run with no hits at all:

```
（无命中）
[已跳过 1 个二进制文件]
[已弃用 rg：它是 searchText 的薄别名，请改用 searchText with mode="regex"；rg 将在后续 major 版本移除]
```

and for `grep` the tail reads
`…请改用 searchText with mode="regex" and name_pattern；grep 将在后续 major 版本移除]`.

What that breaks: assertions that compare a whole result string, "the last line is the
final hit" parsing, and line-count budgets. Migrate to the single search entry instead
of learning to strip the line:

```js
// searchText: mode is REQUIRED and has no default
{ name: "searchText", input: { pattern: "needle", mode: "literal", name_pattern: "*.js" } }
```

`rg` / `grep` keep their names and input shapes (Stable surface): removal needs a major
bump (issue #188 tiering), so there is no urgency — but new code should not add a call.
Note the alias default `is_regex=true` means **regex**, while `searchText` refuses to
guess (a missing `mode` is an explicit error).

## 5. Marker wording and byte units are Experimental

Truncation markers changed shape in this release (they now name the next step, and byte
quantities render as `256KB` / `1.5MB` / `1.0GB` / `1.5TB` on a 1024 base). That wording
is **Experimental**: it may change in any minor, marker text included. Pin the
structured fields instead — the search tools report:

| `metadata` field | meaning |
| --- | --- |
| `searchHits` / `searchMatchedLines` / `searchFiles` | hits this call returned, matched lines, distinct files |
| `searchLimit` / `searchOffset` | effective cap and this call's offset |
| `searchTruncated` | whether the cap was reached |
| `searchNextOffset` | present only when truncated — pass it back as `offset` to continue |
| `searchSkipped.{vendorDirectories,hiddenDirectories,largeFiles,binaryFiles,deniedPaths}` | the exclusion ledger |

Two caveats:

- These fields travel **into the transcript, not onto the wire**: the model only ever
  sees the marker text. Your host code can read them; do not assume the model can.
- `formatSize()` and `toolMarker()` are module-level exports of
  `src/tools/file-tools.js` and are **not importable from the npm package** today
  (`exports` maps only `.` / `./tools` / `./contract-tests`). If you want the same
  rendering, implement it yourself — see the export-surface caveat in
  [host-consumer-contract.md](host-consumer-contract.md).

## 6. Import path: `erix-agent/tools`, not the root

```js
// correct
import { createFileTools, skillDirectories, discoverSkills, loadSkill } from "erix-agent/tools";

// wrong — fails to resolve the symbol, it is not on the root export
import { createFileTools } from "erix-agent";
```

`package.json` `exports` maps exactly three entries: `.` (engine core), `./tools`
(optional tool library), `./contract-tests`. `createFileTools` appears **zero** times in
`src/index.js`, and this is the design, not an oversight: ADR-005 keeps the optional
library off the main export. The `./tools` subpath carries the file tools
(`createFileTools`, `resolveFileReadMaxBytes`, `truncateDisplayText`,
`FILE_TOOL_DEFINITIONS`, `FILE_READ_MAX_BYTES_DEFAULT`, `MAX_FILE_BYTES`,
`MAX_TREE_ENTRIES`, `GREP_MAX_RESULTS_HARD_CAP`) and the skills loader
(`skillDirectories`, `discoverSkills`, `loadSkill`, `loadAllSkills`, `buildSkillTools`,
`warnBuiltinToolConflicts`) plus the registry and provider factories. There is **no**
`./skills` subpath.

Skills loading has one extra trap: `bundledDir` is a required-by-intent parameter.
Not passing it means the built-in skill directory simply does not participate in
discovery — the library guesses no path of its own. Pass your own
(`<package>/skills` for the CLI).

## 7. Upgrade checklist

| If you … | Do this | Verify with |
| --- | --- | --- |
| rely on the judge default | nothing — `edit` is now included | a run that only calls `edit` must register as a write |
| pass `writeToolNames` | add `"edit"` explicitly, or document why not | `grep -rn "writeToolNames"` |
| assert file-tool names/count | update to the seven-name set | the `node -e` snippet in section 3 |
| classify tool side effects | treat `edit` as a write | your classifier's test for `edit` |
| match `rg`/`grep` output text | strip the trailing marker or migrate to `searchText` | a call with zero hits still ends with the deprecation line |
| assert marker wording / byte text | move the assertion to `metadata` fields | section 5 field list |
| import new symbols from the root | switch to `erix-agent/tools` | `node -e "import('erix-agent').then(m => console.log('createFileTools' in m))"` → `false` |

Prior guides in this series:
[0.17.0](host-upgrade-guide-0.17.0.md),
[0.16.0](host-upgrade-guide-0.16.0.md),
[0.15.0](host-upgrade-guide-0.15.0.md),
[0.14.0](host-upgrade-guide-0.14.0.md).
Full contract text: [host-consumer-contract.md](host-consumer-contract.md).
