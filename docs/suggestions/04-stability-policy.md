# docs(policy): publish a pre-1.0 stability / deprecation policy for host-facing APIs

## Background

From `CHANGELOG.md`:
- 14 releases from 0.4.0 (2026-09-14) to 0.17.0 (2026-10-08);
- 6 sections marked `Changed/Removed（BREAKING）`.

Upgrade guides exist (`docs/host-upgrade-guide-*.md`) and are good. Individual issues also tag their semver impact (#173, #176, #180–#182).

Two things are still missing:
- **A written policy.** The only explicit stability promises are scattered: projection shape in `docs/host-consumer-contract.md`, and contract freezing in ADR-014 (宿主端口框架 / host port framework …契约冻结 / contract freeze).
- **A 1.0 definition.** `docs/requirements.md` lists "v1.0 candidate — not shipped" and ties it to a touwaka migration, but doesn't say what 1.0 would freeze.

A host deciding whether to embed erix can't tell which surfaces are safe to depend on. On the current cadence, an upgrade can break them as often as weekly.

## Proposal

Add a short `docs/stability.md` (EN + CN, kept in sync by `check:docs`) covering:

1. **Surface tiers.**
   - **Stable:** e.g. `runToolLoop` options and result, `executeTool` contract, termination reason enum, transcript store interface, `./contract-tests`.
   - **Experimental:** e.g. judge internals, compaction strategy names, CLI flags.
   - **Internal:** everything else.
2. **Pre-1.0 rule.**
   - Breaking a Stable surface requires a minor bump, an upgrade guide (already done), and **one release of deprecation warning** where feasible.
   - Experimental surfaces may change in any minor.
3. **1.0 exit criteria.** For example: the touwaka and app_container hosts run on the same minor for N weeks, the contract suite is green in CI, and no Stable-surface breakage happens for N releases.
4. **Breaking-change batching.** Optionally, collect host-facing breaks into planned minors (e.g. at most one breaking minor every 2 weeks) instead of shipping each one as it lands.

## Acceptance

- `docs/stability.md` exists, is linked from README, and the CHANGELOG labels breaking items with their tier.

## Semver

None (docs/process).
