# Darbitex Final — External Audit Package (round 1)

> **Single-file consolidated audit bundle.** This document combines the audit
> submission context (design principles, threat model, review questions) with
> the complete Move source code (3 modules + manifest). Paste this entire
> document into a fresh AI chat session for review.
>
> **Response format:** See Section 1 of the submission. Return findings in
> Markdown with the structure:
> `## Findings → ### HIGH/MEDIUM/LOW/INFORMATIONAL → ## Design questions → ## Overall verdict`.
>
> **Free-tier context note:** this document is ~2500 lines of markdown,
> embedding ~2000 lines of Move. If your AI chat has a short context limit,
> split into two messages: first the submission (up to Section 11 header),
> then the source bundle (Sections 11.1–11.4). Long-context models (Gemini
> 2.5 Pro, Kimi K2, Claude) can ingest the whole document at once.

---

# Darbitex Final — External Audit Submission (round 3)

**Version:** Final 0.1.0 (R2.2 — post R1 fix batch + R2 hotfix pair)
**Date:** 2026-04-14
**Chain:** Aptos mainnet (fresh publish pending audit)
**Audit package size:** 3 Move source files, ~2205 LoC total, compile clean with zero warnings on `aptos move compile --named-addresses darbitex=0x1`
**Previous deploys:** none — this is a fresh codebase. Darbitex Beta (`0x2656e373...9c7ec2`, live) is **not** being upgraded; Final is a clean-slate package at a new address.
**Planned mainnet publisher:** new 1/5 multisig at publish time, raised to 3/5 after smoke test.

---

## ⚠ Round 3 context — delta review after R1 + R2

This is the **third audit round**. The codebase has been through two prior rounds with ten AI audit passes total. Your job for R3 is **primarily verification** that previous findings were correctly addressed, plus full-surface review to catch any new issues introduced by the hotfix iterations.

### Round 1 (8 independent auditors): clean-slate review

Eight auditors reviewed the original R1 submission in parallel:

| Auditor | Verdict | Key findings |
|---|---|---|
| Gemini 2.5 Pro | 🟡 YELLOW | HIGH DFS DoS (unbounded recursion), MED pagination inefficiency, LOW direct_pool gaming |
| Grok 4 | 🟢 GREEN | INFO only (acknowledged tradeoffs) |
| Qwen | 🟡 YELLOW | MED DFS scalability, LOW direct_pool, LOW dead `E_SAME_TOKEN` |
| Kimi K2 | 🟢 GREEN | MED direct_pool canonicalize, LOW DFS soft budget |
| DeepSeek V3 | 🟢 GREEN | LOW DFS concern, LOW unused `directions` field |
| ChatGPT GPT-5 | 🟡 YELLOW | 3 HIGH claims (5 false positives verified against source) + 1 valid MED DFS |
| Claude (in-session) | self-audit | Pre-applied M-1..M-4, L-1..L-3 fixes before external audit |
| Claude (fresh web) | 🟡 YELLOW | MED canonicalize, MED pool uniqueness in `execute_path_compose`, LOW dead `E_SAME_TOKEN` |

**Cross-confirmation:**
- **8/8 unanimous:** canonicalize `swap_compose` / `swap_entry` — remove caller-nominated `direct_pool`, derive canonical via `canonical_pool_address_of`
- **7/8 recommend:** DFS gas protection (some form of visit budget or scaling cap)
- **2/8 cross-confirmed:** remove dead `E_SAME_TOKEN` in `pool.move`
- **Single-source but trivially verifiable:** unused `directions` field (DeepSeek), pool uniqueness check (Claude), stale `design.md` (Claude)

### R1 fix batch (applied post-R1)

Six fixes applied from R1 consensus:

1. **Canonicalize `swap_compose` + `swap_entry`** (8/8 consensus) — replaced `direct_pool: address` with `metadata_out: Object<Metadata>`. Direct baseline derived internally via `pool_factory::canonical_pool_address_of(in_addr, out_addr)`. Removed caller-nominated baseline footgun.
2. **Remove dead `E_SAME_TOKEN`** (2/8) — the assert in `pool::create_pool` was unreachable because factory's `assert_sorted` rejects same-token pairs first. Constant + assert removed from `pool.move`.
3. **Remove unused `directions` field from `Path`** (1/8 verified) — field was populated during DFS and exposed in quote views but never consumed by `execute_pool_list` (direction is inferred from FA metadata at `pool::swap` call time). Simpler struct.
4. **Duplicate-pool check in `execute_path_compose`** (1/8 — Claude fresh web MED-2) — O(n²) guard at top of function, bounded by MAX_HOPS, rejects caller-supplied paths with repeated pools. Prevents breaking the simulation-to-execution determinism invariant.
5. **DFS soft visit budget** (7/8) — new `DFS_VISIT_BUDGET = 256` constant + `&mut u64` counter threaded through `dfs_path` and `dfs_cycle`. Decrements per candidate iteration. Bounds worst-case gas O(budget) regardless of ecosystem size.
6. **Deprecate `design.md`** (1/8 — Claude fresh web INFO-3) — the file described a pre-implementation `beforeSwap` / `afterSwap` callback architecture that was abandoned in favor of the wrapper pattern. Added deprecation banner pointing to this submission doc.

### R1.5 self-audit hotfix pair (applied after R1 fix batch)

A fresh self-audit of the R1-fixed code caught two MEDIUM regressions introduced by the canonicalize + budget interactions:

**MED-1: `swap_compose` silent no-op** — when `find_best_path` returns empty AND no canonical direct pool exists, `chosen.pools = []`, `chosen.expected_out = 0`. With `min_out = 0`, the slippage assert passed, `execute_pool_list` looped zero times and returned `fa_in` unchanged. User's A tokens returned with event misattribution claiming swap succeeded to B. **Fix:** `assert!(chosen.expected_out > 0, E_SLIPPAGE);` added before the existing slippage check. Rejects empty-path scenarios cleanly.

**MED-2: `find_best_flash_triangle` outer loop not budget-bounded** — Fix 5 (DFS budget) bounded PER cycle search, but `find_best_flash_triangle` iterated `N` borrow candidates calling `find_best_cycle(..., fresh budget)` for each. Total work scaled O(N × 256). Attacker with 100 junk pools → 25,600 simulate_leg calls. **Fix:** refactored `find_best_cycle` into a wrapper + `find_best_cycle_internal(..., &mut budget)`. `find_best_flash_triangle` creates one shared budget, passes to `_internal` across all iterations. Total work bounded O(256) regardless of candidate count.

### Round 2 (2 verifier auditors): post-R1 delta review

Two auditors re-reviewed the R1 + R1.5 code:

| Auditor | Verdict | Finding | Severity |
|---|---|---|---|
| Claude (fresh web R2) | 🔴 RED | `swap_compose` charges 10% on full output when no direct pool exists | **HIGH** |
| Gemini 2.5 Pro (R2) | 🟡 YELLOW | `fetch_all_sister_pools` bypasses DFS budget via upfront vector allocation | **HIGH** |

**Both R2 auditors found REAL and DIFFERENT HIGH bugs that nobody in R1 caught (including the self-audit).** Cross-coverage lesson: complex systems have many independent fault surfaces; parallel audit catches them individually.

### R2.1 hotfix (Claude R2 HIGH-1)

**Scenario:** In `swap_compose`, if no canonical direct pool exists (`direct_out = 0`) and a multi-hop path exists (`best.expected_out > 0`), the improvement formula was `if (actual_out > direct_out)` — which reduces to `actual_out > 0`, always true for successful swaps. Result: `improvement = actual_out - 0 = actual_out`, treasury takes 10% of **full swap output** instead of 10% of surplus over baseline.

**Dormant at 3-pool launch** (every pair has a direct pool) but **activates immediately when a 4th asset enters without a direct pool to an existing asset** — exactly the ecosystem growth scenario Darbitex is designed for.

**Fix (matches `execute_path_compose`'s correct pattern):**

```move
let improvement = if (direct_out > 0 && actual_out > direct_out) {
    actual_out - direct_out
} else {
    0
};
```

Plus INFO-1 docstring cleanup: removed stale "before/after callbacks" language from `pool.move` module header, replaced "nominated direct-hop pool" with "canonical direct-hop pool" in `swap_compose` module docstring.

### R2.2 hotfix (Gemini R2 HIGH-1)

**Scenario:** `fetch_all_sister_pools(asset)` looped `pool_factory::pools_containing_asset` pagination calls until exhaustion, accumulating all entries into one in-memory vector. Called at every DFS depth and at the start of `find_best_flash_triangle`. An attacker creating 10,000 junk pools containing APT could force any APT-touching operation to:
1. Execute 1,000 cross-module pagination calls per DFS level
2. Allocate a 10,000-element vector per DFS level
3. THEN hit the `DFS_VISIT_BUDGET` check inside the while loop

The DFS budget decrements per iteration, but the expensive fetch + allocation happened upfront — **bypassing the budget protection entirely**. Any APT-touching call hits out-of-gas long before the 256-tick budget is consumed.

**Fix: lazy pagination inlined into DFS loops.** `dfs_path`, `dfs_cycle`, and `find_best_flash_triangle` now fetch one PAGE at a time, iterate within that page (decrementing budget per candidate), and only fetch the next page if `budget > 0`. Total fetch cost now strictly bounded by the DFS budget. `fetch_all_sister_pools` helper removed entirely (no longer called anywhere).

This is the critical fix that closes the DoS surface. Total simulate_leg + fetch work across the entire search tree is now bounded by `DFS_VISIT_BUDGET = 256` regardless of how many junk pools exist in any asset's bucket.

### What we want from R3 reviewers

**Primary: delta verification** — confirm that the R2.1 + R2.2 hotfixes correctly address Claude R2 HIGH-1 and Gemini R2 HIGH-1 without introducing new regressions. Specifically:

1. **`swap_compose` zero-baseline guard** (lines ~780) — verify the `direct_out > 0 && ...` addition matches `execute_path_compose` semantics and is consistent with the "no baseline = no charge" philosophy rule.
2. **Lazy pagination in `dfs_path` / `dfs_cycle`** (lines ~295-370, ~395-470) — verify the nested `while (!exhausted && *budget > 0)` pattern correctly terminates, decrements budget per candidate within each page, and stops fetching further pages when budget exhausts. No off-by-one in `offset + batch_n` arithmetic.
3. **Lazy pagination in `find_best_flash_triangle`** (lines ~490-580) — verify shared budget is consumed across outer iteration + nested cycle search correctly. Terminate condition on outer loop.
4. **No regressions in existing fixes** — canonicalize, duplicate-pool check, `min_net_profit` semantic, hot-potato receipt handling, factory asset_index integrity.

**Secondary: fresh-eyes full review** — the R1 + R2 cross-audit caught bugs nobody else saw. R3 may still catch something in the delta. Please do a full-surface pass and flag anything.

**Open question for R3 consensus:** MEDIUM-1 from Gemini R2 proposes sharding `pool_factory::asset_index` (or using `aptos_std::smart_vector::SmartVector`) to avoid storage-gas degradation at extreme pool counts (10,000+ pools per asset). This is a factory-level structural refactor with non-trivial cost. **Do you consider this a blocker for launch, or a compat-upgrade-during-soak item?** Tiebreaker needed.

---

## ⚠ Round 1 context — clean-slate review

This is the **first audit round** for Darbitex Final. The codebase is a fresh design iteration that **reuses the audited beta pool + factory primitives with philosophy-level changes**, plus a brand-new `arbitrage` module. Auditors have no prior-round baseline to compare against — please do a full-surface review.

**What reuses beta (minor delta review):**

- `pool.move` (807 lines) — cloned from beta pool.move, then stripped:
  - Removed: `HookNFT` struct, `mint_hook_nft`, `claim_hook_fees` + entry, `hook_*_fee_*` accumulators on Pool struct, `HookFeesClaimed` event, `EXTRA_FEE_DENOM` + `HOOK_SPLIT_PCT` constants, `hook_nft_1/2` fields from PoolCreated / Pool struct, `hook_*_fee` fields from Swapped event, hook views (`hook_nft_addresses`, `hook_fee_buckets`, `hook_nft_info`), TWAP cumulative (fields, `update_twap`, view), stats (`total_swaps`, `total_volume_*`, view), `schema_version` + `_reserved` padding fields
  - Modified: `accrue_fee` simplified to LP-only (single u64 return); `swap` body simplified (no extra_fee split); `flash_repay` fee routing simplified; `create_pool` signature (returns tuple 2 not 4, no factory/treasury params)
  - Added: `compute_amount_out` pure public helper (was inline in `swap` + view); `compute_flash_fee` pure public helper (was inline in `flash_borrow`); `swap_entry` NOT present — deliberately removed so users route via `arbitrage::swap_entry`

- `pool_factory.move` (198 lines) — cloned from beta pool_factory.move, then stripped:
  - Removed: `hook_listings` table + escrow system, `buy_hook` entry, `set_hook_price` admin entry, `DEFAULT_HOOK_PRICE`, `TREASURY_ADDR`/`ADMIN_ADDR`/`REVENUE_ADDR` constants, `HookPurchased`/`HookPriceUpdated` events, hook-related views, `FactoryInitialized`/`CanonicalPoolCreated` duplicate events (pool module already emits `PoolCreated`), `schema_version` + `_reserved`
  - Added: `asset_index: Table<address, vector<address>>` reverse index (asset → list of pools containing it); `index_asset` helper; `pools_containing_asset(asset, offset, limit)` paginated view (MAX_PAGE=10 hard cap)
  - Modified: `create_canonical_pool` signature now inserts into asset_index at creation; `init_factory` no longer emits event

**What is brand new (full-surface review):**

- `arbitrage.move` (973 lines) — new module implementing the programmable arbitrage layer. Three execution tiers (entry / compose / view), four primary operations (execute_path / swap / close_triangle / close_triangle_flash), 10% service charge on surplus-over-baseline. No external deps beyond `darbitex::pool` and `darbitex::pool_factory`.

**What we want you to focus on:**

1. **arbitrage.move correctness** — path and cycle DFS, simulation/execution determinism, flash-triangle topology safety, hot-potato receipt handling, service charge math (uniform rule across all 4 entry surfaces).
2. **pool.move delta** — verify the HookNFT removal and accrue_fee simplification did not break the LP fee accumulator invariants or the flash loan k-invariant. (Beta passed 4 rounds of audit; Final is a strict subset plus minor refactors.)
3. **Philosophy compliance** — Darbitex Final is "decentralized arbitrage exchange". Confirm the design (treasury hardcoded, 10% uniform service charge, no admin override, no witness gates on swap) matches that mission statement.
4. **Composability safety** — the `*_compose` functions take FA by value and return FA, no `&signer`. External modules (Aave flash receivers, other DEX satellites) are intended to compose these. Verify no authorization gap exists at the compose layer.

---

## ⚠ R1 pre-audit self-review fixes (already applied)

Before submitting to external auditors, the developer ran a full self-audit pass and addressed the following findings in-place. **These fixes are already compiled and included in the source bundle below.** They are listed here so external reviewers know what was already patched (avoid re-reporting) and can verify the fixes are correct.

**M-1 [arbitrage] — `find_best_flash_triangle` missing liquidity pre-check.**
`find_best_flash_triangle` chose (borrow_pool, cycle) tuples by profit alone and did not verify that `amount < anchor_reserve` on the borrow pool. Execution would then abort opaquely at `pool::flash_borrow`'s own check instead of cleanly signaling "no viable topology". **Fix:** added a reserve pre-check that mirrors `pool::flash_borrow`'s strict `amount < reserve_in` at candidate evaluation time; insufficient-liquidity candidates are skipped silently. If every candidate is too small, `find_best_flash_triangle` returns `@0x0` and `close_triangle_flash_compose` aborts cleanly with `E_NO_CYCLE`.

**M-2 [arbitrage] — `min_profit` semantic was gross, caller expected net.**
Both `close_triangle_compose` and `close_triangle_flash_compose` previously took `min_profit` and interpreted it as the gross cycle profit, before the 10% treasury cut. A caller passing `min_profit=100` would actually receive 90 (10% extracted). **Fix:** parameter renamed `min_profit` → `min_net_profit`, semantic changed so both the pre-execution check (against simulated `expected_net`) and the post-execution check (against actual `net_to_caller`) now compare to the caller's take-home AFTER the treasury cut. A caller passing `min_net_profit=100` is guaranteed to receive ≥100 units of the anchor asset.

**M-3 [arbitrage] — `compute_direct_baseline` could miss the direct pool.**
The helper scanned the first page of `pool_factory::pools_containing_asset(from, 0, PAGE=10)` looking for a pool whose other side was `to`. If the direct pool was at index ≥ 10 in the asset's bucket (e.g., created after other pools referencing that asset), the scan missed it, `compute_direct_baseline` returned 0, and `execute_path_compose` falsely concluded "no baseline, no service charge". **Fix:** added a new `pool_factory::canonical_pool_address_of(asset_a, asset_b)` view that derives the deterministic canonical pool address from the sorted pair seed in O(1) without any pagination scan. `compute_direct_baseline` now computes the canonical address, checks `pool::pool_exists(addr)`, and simulates the leg. No more pagination dependency for baseline lookup. `pool::pool_exists` was restored as a 1-line view for this purpose.

**M-4 [arbitrage] — DFS missed pools past the first pagination page.**
`dfs_path` and `dfs_cycle` previously called `pool_factory::pools_containing_asset(current, 0, PAGE=10)` exactly once per depth, so only the first 10 sister pools for any asset at any depth were visited. Ecosystem growth beyond 10 pools per asset would silently degrade routing quality — pools past index 10 become invisible to DFS.

**First fix attempted (then reverted):** enforce a `MAX_POOLS_PER_ASSET = 10` hard cap at the factory level via `index_asset`. This guaranteed DFS completeness but **forced ecosystem growth to halt at 10 pools per asset**, which for a hub asset like APT (realistically in 6–10+ pools: APT/USDC, APT/USDt, APT/stAPT, APT/WETH, APT/BTCB, ...) is a near-term ceiling. This is the **same preemptive-constraint pattern** that caused the Darbitex Beta `amount_a == amount_b` symmetric-seeding incident — a unilateral "simplification" that blocks real use cases. **Reverted.**

**Actual fix:** added a `fetch_all_sister_pools(asset)` helper in arbitrage.move that **paginates through the full bucket** via repeated `pools_containing_asset(..., offset, PAGE)` calls with `offset += n` until a short batch signals exhaustion. Now `dfs_path`, `dfs_cycle`, and `find_best_flash_triangle` all see every sister pool regardless of count. No factory-level cap. The gas cost of DFS scales linearly with pool count per asset; this is accepted as honest scaling behavior — a bot paying more gas on a mature ecosystem is preferable to ecosystem growth being blocked by a hardcoded ceiling.

**L-1 [factory] — Dead `E_SAME_TOKEN` check in `create_canonical_pool`.**
`assert_sorted` uses strict `<` on BCS bytes, which rejects same-token pairs (`bcs(a) < bcs(a)` is false). The subsequent `assert!(meta_a != meta_b, E_SAME_TOKEN)` check was unreachable. **Fix:** removed the dead assert and the `E_SAME_TOKEN` error constant. Comment clarifies that `assert_sorted` covers the same-token case.

**L-2 [factory] — Theoretical u64 overflow in `pools_containing_asset` pagination arithmetic.**
The old implementation computed `end = offset + capped` before clamping to `len`. If `offset` were pathologically large (u64::MAX-ish), the addition could wrap. Not reachable in practice (Aptos storage won't hold u64::MAX-length vectors), but technically unsafe. **Fix:** refactored to compute `remaining = len - offset` (safe because `offset < len` is already asserted) and `take = min(capped, remaining)`, then loop from `offset` to `offset + take` where the sum is proven bounded by `len`. No overflow path.

**L-3 [arbitrage] — Defense-in-depth in `find_best_flash_triangle` reserve extraction.**
Previously assumed the borrow pool candidate (from `asset_index[anchor]`) always contained `anchor` on one of its two sides. **Fix:** explicit `else if (anchor == mb_addr) { rb } else { 0 }` — if the invariant is ever violated (e.g., future factory bug), the function safely returns `anchor_reserve = 0` which fails the `> amount` check and skips the candidate.

**Compile state after fixes:** `aptos move compile` clean, zero warnings, zero errors.

---

## 1. What we are asking from you

You are reviewing three Move source files for **Darbitex Final**, an Aptos-native AMM with a programmable arbitrage layer. We want an **independent security review** focused on:

1. DFS search correctness (path + cycle + flash triangle topology)
2. Simulation-to-execution determinism (does `actual_out == expected_out` always hold?)
3. Flash loan safety in the arbitrage path (reserve check, lock interaction, hot-potato consumption, k-invariant)
4. Service charge math (surplus = output − baseline; baseline auto-detection for cycle vs linear; treasury cut extraction order)
5. Composability safety (FA-in/FA-out primitives without &signer)
6. Event attribution and any spoof potential
7. Any admin override or trust escape we did not explicitly acknowledge
8. Minor delta on pool + factory (HookNFT removal, asset_index addition)

**Output format we'd like back:**

```
## Findings

### HIGH-1: <title>
Location: <file>:<line>
Description: <what>
Impact: <why it matters>
Recommended fix: <how>

### MEDIUM-1: ...
### LOW-1: ...
### INFORMATIONAL-1: ...

## Design questions we want answered
(any specific question from section 7 below)

## Overall verdict
(green / yellow / red for mainnet publish readiness)
```

Please also comment on **things we considered and got right** — we want to know which decisions held up under scrutiny, not just where we failed.

---

## 2. Project context

**Darbitex** is a small Aptos-native AMM. The lineage:

- **Alpha** (V1) — shipped with hook-auction bugs, frozen as legacy
- **Beta** (V1.1) — clean-slate AMM with HookNFT fee-sharing system (soulbound treasury slot + auctionable marketplace slot), 4 rounds of audit, live on mainnet since 2026-04-12 at `0x2656e373...9c7ec2`
- **Final** (this submission) — terminal iteration. Preserves beta's audited pool + factory primitives, removes the HookNFT fee-sharing system entirely (treasury revenue now only from arbitrage service charge, not from passive fee slots), and adds a new `arbitrage` module for programmable multi-hop routing and cycle-closure arb.

**Final's design philosophy:**

- **Decentralized** — zero admin surface, zero permissions, zero upgrade override after the 3-6 month soak ends and the package flips to immutable
- **Agnostic** — accepts any Aptos Fungible Asset, no whitelisting, no token-class discrimination
- **Composable** — three-tier API (entry wallet, compose FA-in/FA-out for Move callers, view for RPC quote)
- **Service charge not tax** — 10% treasury cut applies only to surplus OVER a clear baseline. If no value is added (output ≤ baseline), charge is 0. Uniform rule across every execution surface.

Darbitex Beta will remain live as legacy after Final deploys; LP providers migrate organically via `remove_liquidity` on beta + `add_liquidity_entry` on final. No migration tool.

---

## 3. Core design principles

These are **intentional**. If you find something that violates one of these, that's a HIGH finding. If you disagree with a principle, note it under "Design questions" rather than as a finding.

1. **One pool type, agnostic to pair.** Stable and volatile pairs share the same `Pool` struct with identical rules. Any valid `Object<Metadata>` can be a side.

2. **Truly immutable pools.** After `pool_factory::create_canonical_pool` returns, no function anywhere in Final can alter fee, curve, pair, or any per-pool parameter. Zero pool-level admin surface.

3. **No passive fee slot.** Beta had a HookNFT fee-sharing system where a hardcoded 10% of every swap fee was siphoned into two "hook pots" and claimable by NFT holders. Final removes this entirely. Swap fee is 100% LP — the full 1 bps accrues via `lp_fee_per_share` accumulator.

4. **Treasury revenue comes from arbitrage service charge, not passive fee.** The `TREASURY` address (`0xdbce89...`, same multisig as beta) receives 10% of any **surplus** extracted via the arbitrage module (smart routing improvement or cycle profit). If no surplus exists, treasury receives nothing. This is a conscious **service charge** framing, not a protocol tax: we charge for value Darbitex adds, not for value users bring themselves.

5. **Service charge is uniform.** The same 10%-of-surplus rule applies across all four arbitrage entry surfaces (`execute_path_compose`, `swap_compose`, `close_triangle_compose`, `close_triangle_flash_compose`). No two-tier system where sophisticated callers avoid the cut via raw primitives. Baseline is defined per surface:
   - Cycle (start_asset == end_asset): baseline = seed amount. Surplus = cycle profit.
   - Linear swap with direct pool available: baseline = direct-hop output. Surplus = improvement.
   - Linear swap with no direct pool: baseline = 0, surplus = 0, no charge (Darbitex isn't "adding value" when it is the only available path).

6. **Programmable arbitrage, not V4-style hooks.** Swap does not call user-defined code. `pool::swap` is a pure primitive; arbitrage is a SEPARATE module that wraps pool::swap from the outside. Zero reentrancy attack surface from user hooks. The "programmable" aspect is: users compose arbitrage primitives into larger flows, not inject code into the swap path.

7. **LP as NFT with global accumulator.** Unchanged from beta. MasterChef V2 per-share pattern with u256 intermediates. LP positions are Aptos objects (`LpPosition`), transferable, each with its own debt snapshot.

8. **Flash loan at pool level.** Unchanged from beta. Hot-potato `FlashReceipt` with no abilities. `pool.locked = true` during borrow span. `flash_repay` asserts `k_after >= k_before` in u256. Reserves are UNCHANGED during flash — only store balance mutates.

9. **Canonical pool uniqueness + reverse asset index.** Factory enforces one pool per sorted `(metadata_a, metadata_b)` pair via `create_named_object` at a deterministic address. New: factory also maintains `asset_index: Table<address, vector<address>>` that maps each asset metadata to all pools containing it, updated atomically on pool creation. Arbitrage reads via paginated `pools_containing_asset(asset, offset, limit)` with hard cap `MAX_PAGE = 10` per call.

10. **Three-tier composability.** Every arbitrage capability is available as:
    - **Entry** (`*_entry`) — `public entry fun` with deadline + primary_fungible_store wrapping. User-facing wallet call.
    - **Compose** (`*_compose`) — `public fun` taking and returning `FungibleAsset`. Move-callable from any module. No &signer, no primary store coupling.
    - **View** (`quote_*`) — `#[view]` functions for RPC-side path discovery.

11. **Real capital AND flash loan both supported for cycle closure.** `close_triangle` uses caller's seed (Move TX atomic rollback on unprofitable). `close_triangle_flash` uses internal `pool::flash_borrow` (requires ≥ 1 pool disjoint from the cycle to serve as borrow source — dormant at 3-pool launch, activates with 4+ pools).

12. **Compat → immutable upgrade policy.** Launch with `upgrade_policy = compatible` for 3-6 months of soak. After clean operation, flip to immutable via a multisig tx (no code change). Beta remains live in parallel as legacy.

---

## 4. Security model and trust assumptions

### Trusted parties

- **Publisher multisig** (new, 1/5 at publish, raised to 3/5 after smoke test, reused from beta owners): publishes and upgrades the Final package during the compat window. After the package flips to immutable, the upgrade cap becomes inert.
- **Treasury multisig** (`0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576`, reused from beta): passive recipient of the 10% arbitrage service charge. Cannot touch pool state, cannot mint or burn anything, cannot move funds out of pools. Can withdraw its own received cuts as it would any other wallet.

### Untrusted parties

- Anyone can create pools (`pool_factory::create_canonical_pool`)
- Anyone can swap, add/remove liquidity on any pool
- Anyone can flash-borrow from any pool (as long as they repay in the same TX)
- Anyone can call any arbitrage entry — `swap_entry`, `close_triangle`, `close_triangle_flash`
- External Move modules can compose arbitrage's `public fun` layer
- LP positions are validated by `object::owner(obj) == caller` on claim / remove calls

### Threat model we care about

- Economic extraction via rounding, invariant-break, or accumulator math drift
- Reentrancy via the FA callback path (flash loan hot-potato interaction with arbitrage flow)
- Simulation-to-execution drift (does DFS quote match real on-chain execution?)
- First-depositor / LP-share manipulation
- Fee attribution mismatch (service charge taken when it should not be, or missed when it should)
- Pool duplication / canonical address collision
- u128 / u256 overflow in accumulator math under realistic pool lifetime
- Hot-potato `FlashReceipt` being dropped without consumption (compile-level impossibility in Move, but we want confirmation)
- Arbitrage compose layer letting an attacker siphon value from another caller's FA

### Threat model we do NOT care about

- External AMMs at different package addresses
- Malicious FA metadata (we trust the Aptos FA standard)
- Off-chain frontend or SDK bugs
- Publisher multisig key compromise (multisig problem, out of scope)
- Price oracle manipulation across all of DeFi
- Event attribution spoofing at the compose layer (documented — `swapper` / `caller` parameters in compose functions are hints for analytics, not cryptographic attestation)

---

## 4a. Dependencies

Final depends on exactly the same three Aptos framework packages as beta, pinned to the same mainnet revision. Zero third-party code, zero vendored dependencies.

- **AptosFramework** (explicit in Move.toml) — `object`, `fungible_asset`, `primary_fungible_store`, `account`, `event`, `timestamp`, `table`
- **AptosStdlib** (transitive) — `Table`
- **MoveStdlib** (transitive) — `signer`, `vector`, `bcs`

---

## 5. Module map

| File | Lines | Purpose |
|---|---|---|
| `pool.move` | 807 | Core AMM primitives (Pool, LpPosition, FlashReceipt), swap + LP + flash + fee claim. Minus HookNFT system from beta. |
| `pool_factory.move` | 198 | Factory singleton with asset_index reverse lookup. Minus hook escrow system from beta. |
| `arbitrage.move` | 973 | Programmable arbitrage: path + cycle + flash-triangle DFS, four entry surfaces (entry/compose/view), uniform 10% service charge. |
| `tests.move` | 14 | Stub. Full test suite pending. |

All files live at `darbitex-final/sources/`. Compilation: `aptos move compile --named-addresses darbitex=0x1` passes cleanly, zero warnings.

---

## 6. Locked-in constants

| Constant | Value | Module | Rationale |
|---|---|---|---|
| `SWAP_FEE_BPS` | 1 | pool | 1 bps LP swap fee |
| `FLASH_FEE_BPS` | 1 | pool | 1 bps LP flash fee |
| `BPS_DENOM` | 10_000 | pool | standard bps denominator |
| `MINIMUM_LIQUIDITY` | 1_000 | pool | dead LP shares, anti first-depositor manipulation |
| `SCALE` | 1e12 | pool | u128 per_share accumulator scale |
| `U64_MAX` | 2^64−1 | pool | overflow guard in add_liquidity |
| `FACTORY_SEED` | `b"darbitex_factory"` | pool_factory | resource account derivation seed |
| `POOL_SEED_PREFIX` | `b"darbitex_pool"` | pool_factory | canonical pool address seed prefix |
| `MAX_PAGE` | 10 | pool_factory | `pools_containing_asset` per-call page cap |
| `TREASURY_BPS` | 1_000 (10%) | arbitrage | treasury share of surplus |
| `TOTAL_BPS` | 10_000 | arbitrage | bps denominator |
| `MAX_HOPS` | 4 | arbitrage | max linear path length in smart routing |
| `MAX_CYCLE_LEN` | 5 | arbitrage | max cycle length in close_triangle |
| `PAGE` | 10 | arbitrage | per-lookup page size for factory reverse index |
| `TREASURY` | `@0xdbce89...f9576` | arbitrage | multisig recipient of service charge (reused from beta) |

All constants are hardcoded. Changing any of them after launch requires a compat upgrade during the soak window, or becomes impossible after the package flips to immutable.

---

## 7. Specific review questions (prioritized)

Please explicitly answer each section.

### Q1 — DFS search correctness (arbitrage.move)

Three DFS functions:
- `find_best_path(from, to, amount_in)` — linear A→B path search, MAX_HOPS=4
- `find_best_cycle(anchor, seed_amount, exclude_pool)` — closed cycle A→...→A search, MIN 3 legs, MAX_CYCLE_LEN=5
- `find_best_flash_triangle(anchor, amount)` — iterates borrow_pool candidates, runs `find_best_cycle` with exclude_pool=borrow_pool, picks highest net profit

Search state carried through recursion:
- `path_pools: &vector<address>` — pools used so far in this branch
- `path_dirs: &vector<bool>` — a→b flag per leg
- `visited: &vector<address>` — assets visited (prevents cycles except the closing leg)

**Questions:**
- Does `find_best_path` correctly find THE best path (by expected_out) given the reverse-index constraint? It skips re-visiting pools via `vector::contains(path_pools, &pool_addr)` and re-visiting assets via `vector::contains(visited, &other)`. Is that sufficient?
- Does `find_best_cycle` correctly enforce min-length 3? Check the `if (depth + 1 >= 3 && leg_out > best.expected_out)` branch. Edge case: cycle of exactly length 3 vs length 5.
- `exclude_pool: address` parameter in `dfs_cycle` — does it correctly skip the flash-borrow source from the cycle candidate set at every recursion depth, not just the first?
- `find_best_flash_triangle` iterates `pools_containing_asset(anchor, 0, PAGE)` — if more than 10 pools contain anchor, we only check the first 10 as borrow-source candidates. Is that a correctness problem or an acceptable scaling bound?
- Gas cost of DFS is O(N^K) worst case where N is pools per asset and K is path depth. Is MAX_HOPS=4 / MAX_CYCLE_LEN=5 a reasonable bound for on-chain DFS? Any tighter bound we should consider?

### Q2 — Simulation-to-execution determinism

`find_best_path` / `find_best_cycle` simulate each leg's output via `pool::compute_amount_out(reserve_in, reserve_out, amount_in_left)`, carrying `amount_in_left = leg_out` into the next leg. Execution via `execute_pool_list` chains real `pool::swap` calls.

For the simulated output to exactly equal the executed output:
- Each pool is touched AT MOST ONCE in a single path/cycle (enforced by `vector::contains(path_pools, ...)`)
- compute_amount_out and swap use the same math with the same inputs

**Questions:**
- Is `actual_out == expected_out` guaranteed for every path/cycle returned by `find_best_*`? Any corner case where integer rounding or state mutation between legs makes them differ?
- `execute_pool_list` passes `min_out = 0` per leg, relying on the caller (entry function) to check overall `min_out`. Is there any scenario where a mid-path intermediate output could be manipulated by a concurrent TX? (We believe no, because Move TXs are sequential within a single TX.)
- The compose functions re-check `actual_out >= min_out` / `actual_out >= required + min_profit` after execution, even though simulation already guaranteed it. Is this redundant or load-bearing?

### Q3 — Service charge uniform rule

The uniform rule: `surplus = max(0, actual_out − baseline)`, `treasury_cut = surplus × 10%`, caller gets `actual_out − treasury_cut`.

Baseline definition per surface:
- `execute_path_compose`: cycle → baseline = amount_in; linear with direct pool → baseline = direct_out; linear with no direct pool → baseline = 0
- `swap_compose`: baseline = `compute_amount_out` on the caller-specified `direct_pool`
- `close_triangle_compose`: baseline = seed_amount (always cycle)
- `close_triangle_flash_compose`: baseline = amount + flash_fee (amount returned to flash source, fee to pool LP)

**Questions:**
- Is the cycle-detection for `execute_path_compose` correct? `trace_path_end` walks `asset_after_leg` for each pool. For a valid cycle, the last leg's output equals the starting input asset. Any edge case where the trace could return the wrong end_asset (e.g., a pool path that visits the same asset but is not a real cycle)?
- Is the `compute_direct_baseline` helper correct? It iterates `pools_containing_asset(from, 0, PAGE)` and returns the first pool whose other side is `to`. Canonical pairs guarantee at most one such pool — is that assumption watertight?
- In `swap_compose`, if `best.expected_out <= direct_out`, we fall back to the direct-only path. Surplus is 0, treasury cut is 0, user gets `direct_out`. Is there any scenario where this fallback path executes via the direct pool differently from how beta's `pool::swap` would execute it directly?
- In all four compose functions, treasury_cut is extracted from `fa_out` via `fungible_asset::extract(&mut fa_out, treasury_cut)`. Can this ever underflow? (We believe no because `treasury_cut <= surplus <= actual_out`.)
- Is the `min_net_profit` semantic correct? In `close_triangle_compose` and `close_triangle_flash_compose`, `min_net_profit` is the caller's take-home AFTER the 10% cut, not the gross profit. Both pre-check and post-check assert `net_to_caller >= min_net_profit`. Caller passing `min_net_profit=100` is guaranteed to receive ≥100 of the anchor asset.

### Q4 — Flash-triangle topology safety

In `close_triangle_flash_compose`:
1. `find_best_flash_triangle(anchor, amount)` returns `(borrow_pool, cycle)` where `borrow_pool` is disjoint from `cycle.pools` (enforced via `dfs_cycle`'s `exclude_pool` parameter).
2. `pool::flash_borrow(borrow_pool, anchor_metadata, amount)` locks borrow_pool and returns `(fa_borrowed, receipt)`.
3. `execute_path(caller, &cycle, fa_borrowed)` chains `pool::swap` on each cycle pool.
4. `fungible_asset::extract(&mut fa_out, required)` + `pool::flash_repay(borrow_pool, fa_repay, receipt)` consumes the receipt and unlocks borrow_pool.

**Questions:**
- Can any cycle leg accidentally target the locked `borrow_pool`? (We believe no because `dfs_cycle(exclude_pool=borrow_pool)` is called.)
- The receipt is a hot-potato with no abilities. Between `flash_borrow` and `flash_repay`, we have `assert!(actual_out >= required + min_profit)`. If this assert fires, does the receipt get dropped correctly via TX abort? (We believe yes — Move's type system treats abort paths as not-returning, so hot-potato consumption is only checked on normal-return paths.)
- `find_best_flash_triangle` pre-checks `anchor_reserve > amount` for the borrow_pool candidate (mirrors pool::flash_borrow's strict check). Does that pre-check eliminate all paths where pool::flash_borrow would abort on reserve insufficiency? Any edge case we missed?
- The `amount` parameter is caller-specified. There is no optimization loop (like ternary search for optimal borrow size). A bot wanting maximum profit must off-chain-optimize and call with the optimal amount. Is that an acceptable API, or should we add on-chain search?
- Flash-triangle pays the flash fee to the borrow pool's LP (via `accrue_fee` inside `pool::flash_repay`) AND the swap fees (1 bps each) to the 3+ cycle pool LPs. Total fee burden = 1 bps flash + 3 bps cycle = 4 bps gross. Cycle profit must exceed 4 bps for the operation to be profitable. Is this the right fee structure?

### Q5 — Composable primitive safety (FA-in, no &signer)

The `*_compose` functions take `FungibleAsset` by value. They never see the caller's `&signer`. Example:

```move
public fun close_triangle_compose(
    caller: address,
    fa_seed: FungibleAsset,
    min_net_profit: u64,
): FungibleAsset
```

The `caller: address` parameter is only used for:
- `pool::swap(pool_addr, caller, fa_in, 0)` — stored in the Swapped event as attribution
- `event::emit(TriangleClosed { caller, ... })` — attribution in the arbitrage event

No authorization depends on `caller`. Any address can be passed. The FA itself is the only thing carrying value.

**Questions:**
- Can an attacker construct a scenario where they hold a `FungibleAsset` obtained from elsewhere (e.g., withdrawn from their own wallet, received via flash borrow) and manipulate pool state to the detriment of another party? (We believe no because all state changes flow through the FA, and the FA ownership is enforced at the point of creation by Move's linear type system.)
- If a bot passes a fake `caller` address in `close_triangle_compose`, what are the consequences? (Events are misattributed — we accept this as a known limitation for composability. Economic outcomes are unchanged.)
- Are there any paths where the compose function could "leak" FA to an unintended destination? All deposits should go to either `TREASURY` (hardcoded constant) or be returned as the function's return value to the caller.
- Does the lack of `&signer` on `pool::swap` (present in beta and Final) create any attack vector? (Same design as beta, but flagging for re-review with fresh eyes.)

### Q6 — Hot-potato FlashReceipt handling

`pool::FlashReceipt` has no abilities: `struct FlashReceipt { ... }`. Created by `pool::flash_borrow`, consumed by `pool::flash_repay`. Move type system enforces consumption before function return on all non-abort paths.

In `close_triangle_flash_compose`, the sequence is:

```move
let (fa_borrowed, receipt) = pool::flash_borrow(...);        // create
let fa_out = execute_path(caller, &flash.cycle, fa_borrowed);
let actual_out = fungible_asset::amount(&fa_out);
assert!(actual_out >= required, E_MIN_PROFIT);                 // may abort
let fa_repay = fungible_asset::extract(&mut fa_out, required);
pool::flash_repay(flash.borrow_pool, fa_repay, receipt);       // consume
```

**Questions:**
- If the assert between `fa_out` creation and `flash_repay` fires, is the receipt correctly "dropped" via TX abort? (We believe yes — Move compile-checks linear-type consumption only on normal-return paths; abort is a non-return.)
- Are there any hidden branches in the extract/repay flow that could skip the `flash_repay` call? (We believe no, straight-line code.)
- The `fa_repay` extract takes `required = amount + flash_fee`. If `actual_out < required`, extract aborts with `EINSUFFICIENT_BALANCE`. Our pre-assert guarantees `actual_out >= required + min_profit`, so extract is safe. Please verify the comparison chain.

### Q7 — Pool + factory delta from beta

Beta's pool.move and pool_factory.move passed 4 rounds of audit. Final strips the HookNFT system and adds the asset_index reverse lookup. The delta is described in the "What reuses beta" section at the top.

**Questions:**
- Does the removal of `EXTRA_FEE_DENOM` and `HOOK_SPLIT_PCT` and the simplification of `accrue_fee` break the LP fee accumulator invariant? (Before: fee split into `extra_fee` to hook pot + `lp_portion` to accumulator, reserves deducted `extra_fee + lp_portion`. After: full fee goes to accumulator, reserves deducted `lp_fee`. We believe the store-conservation invariant still holds.)
- Does the removal of TWAP cumulative and stats fields from the Pool struct break anything? (These fields were dead weight; no function except their getters read them. Removing them is purely a struct simplification.)
- Does the removal of `schema_version` + `_reserved` forward-compat padding from Pool and LpPosition create any upgrade risk? (We accept this because Final flips to immutable after soak — forward-compat padding becomes irrelevant.)
- Is the new `asset_index: Table<address, vector<address>>` correctly maintained? `index_asset(&mut factory.asset_index, meta_a, pool_addr)` and `index_asset(&mut factory.asset_index, meta_b, pool_addr)` are called atomically inside `create_canonical_pool`. Can this vector grow unboundedly? (Yes for a given asset — bounded by the number of pools that reference it. MAX_PAGE=10 per read call mitigates on-chain read cost, but the storage itself is unbounded.)
- `pools_containing_asset(asset, offset, limit)` clamps `limit` to `MAX_PAGE` but does NOT clamp `offset`. If offset > length, it returns empty. Edge case: if offset is near u64::MAX, is there any arithmetic wraparound in `offset + capped`? (We believe no because `offset + capped` is u64 addition; if it wraps, the subsequent `end > len` branch catches it. Please verify.)

### Q8 — Dust swap edge cases

For `amount_in < 10_000`, `fee = amount_in * 1 / 10_000 = 0`. Swap proceeds with `lp_fee = 0`, `accrue_fee` is a no-op, reserves grow by full `amount_in`.

Same for `flash_borrow` with `amount < 10_000`: `compute_flash_fee` returns 1 (minimum floored), so flash borrows of less than 10_000 units pay a slightly higher effective rate. Caller gets less net value.

**Questions:**
- Is the dust-swap fee-floor-to-zero behavior correct? (Beta accepted this as normal AMM behavior.)
- Is the flash-borrow fee-floor-to-one behavior correct? (Beta accepted this.)
- In the arbitrage module, does a dust-sized cycle trigger edge cases? `compute_amount_out` returns 0 for very small inputs; `simulate_leg` returns `leg_out = 0`; `dfs_cycle` skips if `leg_out == 0`. So dust cycles are naturally filtered out at search time.

### Q9 — Integer overflow / underflow

All swap math uses u256 intermediates. `lp_fee_per_share_*: u128` with `SCALE = 1e12`, overflow unreachable under realistic pool lifetimes.

**Questions:**
- Any path we missed where an intermediate computation could overflow u256? (We believe no.)
- `surplus * TREASURY_BPS / TOTAL_BPS` — surplus is u64, TREASURY_BPS * u64 fits in u128, divide by TOTAL_BPS returns u64. Any edge case where this rounds incorrectly? (Rounds down; treasury slightly under-charges on odd values, which is in the caller's favor. Accepted.)

### Q10 — Anything else

**Any finding not in Q1–Q9 is welcome.** Specifically look for:
- Dead code, unreachable branches, unused imports
- Inconsistent error codes or missing assertions
- Magic numbers without explanation
- Gas cost outliers (especially in the DFS recursion paths)
- Any admin surface we accidentally left open
- Any module visibility misstep (public where it should be public(friend), or vice versa)
- Inconsistencies between compose layer and entry layer wrapping

---

## 7a. First-mover honesty

Darbitex is an early entrant in the Aptos native-arbitrage design space. There is no battle-tested precedent on Aptos for: (a) programmable multi-hop arb-routing modules, (b) Move-native flash-triangle closure via hot-potato receipt receiver lists, (c) FA-in/FA-out composable arb primitives at the non-entry layer. EVM has Uniswap V2/V3/V4 designs with years of adversarial review; Aptos Move for this class of module does not. **Our error vector is larger than an equivalent EVM submission.**

The implication for auditors: **do not defer to our design decisions as "probably right"**. Specifically, decisions we label as "intentional" or "known tradeoff" in this document may still be wrong — we are learning the territory. If you disagree with a principle, flag it under "Design questions" with a concrete alternative. We will not dismiss pushback.

One specific incident from Darbitex Beta's audit history informs this stance: a `assert!(amount_a == amount_b)` symmetric-seeding constraint was declared "non-negotiable design principle" at round 1 and defended by the developer across 4 audit rounds despite Gemini's strong pushback. It was removed in round 5 — not because auditors convinced us, but because the first mainnet publish actually broke on APT/USDC (different decimals → raw equality makes creation impossible). The package at `0x8c8f40ef...` was abandoned, pool_count=0. Round 5 became a delta review on the forced correction.

We do not want to repeat this. Preemptive unilateral constraints should be called out early. See §7b for specific decisions we are genuinely uncertain about.

---

## 7b. Open questions — developer is unsure, wants multi-auditor consensus

These are decisions where the developer picked a reasonable default but is genuinely uncertain and wants multi-auditor input before finalizing. Please give explicit opinions.

### OQ-1 — Unbounded sister-pool count, DFS paginates — is this right?

An earlier revision enforced `MAX_POOLS_PER_ASSET = 10` at the factory level (matching `MAX_PAGE = 10`) to make DFS complete in one paginated read. This was **reverted** because it blocks ecosystem growth — a hub asset like APT realistically participates in 6–10+ pools within a year, and a hardcoded cap would abort legitimate `create_canonical_pool` calls beyond the 10th.

Current design: **no factory cap.** Arbitrage's `fetch_all_sister_pools(asset)` helper loops `pool_factory::pools_containing_asset(asset, offset, PAGE)` calls with `offset += n` until exhausted. DFS visits every sister pool. Gas scales O(N) per asset for the helper + O(N^K) for the DFS recursion where N = pools per asset and K = depth.

**Tradeoffs:**
- Mature ecosystem (30 pools per asset) DFS worst case ≈ 30^4 = 810_000 operations. Practical count much lower due to visited-asset / visited-pool pruning, but gas is a real concern.
- No cap means ecosystem growth is never blocked by code, only by economic viability.

**Questions:**
- Is unbounded DFS with O(N^K) gas scaling acceptable, or should we add a soft runtime budget (e.g., terminate DFS after N pool-visits total)?
- If so, where? In `dfs_path` / `dfs_cycle` with a shared counter passed through recursion?
- Alternative: keep DFS complete but lower `MAX_HOPS` / `MAX_CYCLE_LEN` constants for tighter bounds?

### OQ-2 — Service charge exclusivity when `direct_pool` is caller-nominated

`swap_compose(swapper, direct_pool, fa_in, min_out)` takes `direct_pool` as a caller-nominated baseline for computing the improvement and hence the treasury cut. A sophisticated caller could nominate an intentionally "bad" pool (shallow reserves, bad price) as direct_pool, making the "improvement" look artificially large and causing treasury to take a larger cut.

**Is this an attack or a non-issue?**
- The caller would be HURTING THEMSELVES (giving up more to treasury), so no economic attack on other parties.
- Treasury receives MORE, not less, from this behavior.
- The improvement computation is asymmetric: caller can pass any pool they own or any valid pool in the ecosystem.

**Questions:**
- Is this gaming direction (caller over-paying treasury) acceptable or should we canonicalize `direct_pool` to the factory's canonical (from, to) pool via `canonical_pool_address_of`?
- If canonicalized, the caller parameter becomes redundant — they'd just pass `to: address` and the module would look up the canonical direct pool automatically. Cleaner API, consistent with `compute_direct_baseline`'s O(1) lookup. Suggest changing?

### OQ-3 — `MAX_HOPS = 4` and `MAX_CYCLE_LEN = 5` — gas vs coverage

DFS worst-case complexity is O(MAX_POOLS_PER_ASSET^MAX_HOPS) at each depth. With the current constants: 10^4 = 10000 candidate paths max (in practice much less due to visited-asset pruning).

For a minimal ecosystem (3-5 assets), paths rarely exceed 3 hops to be optimal. MAX_HOPS=4 gives one step of headroom.

**Questions:**
- Is 4 hops enough for practical DEX routing? Uniswap's off-chain router routinely uses 6+ hops.
- Is 5 cycle legs enough? Triangular arb is length-3; length-4 "quadrangle" arb exists in larger ecosystems; length-5+ is rare.
- Worth lowering MAX_HOPS to 3 for tighter gas bounds, or keeping at 4 for future flexibility?

### OQ-4 — Should `swap_entry` canonicalize `pool_addr`?

Currently `swap_entry(user, pool_addr, metadata_in, amount_in, min_out, deadline)` takes a user-nominated `pool_addr`. The module uses it only as a baseline for the improvement split; the actual execution path is whatever `find_best_path` returns.

**A user who nominates a stale / non-existent / adversarial pool_addr could:**
- Abort early if pool_addr doesn't exist (we read `pool_tokens(pool_addr)` early)
- Or produce a weird baseline that makes improvement math odd

**Alternative:** remove `pool_addr` from the entry, take `metadata_in` + `metadata_out: Object<Metadata>` instead, and use `canonical_pool_address_of(in, out)` internally as the baseline pool. Simpler UX, harder to misuse.

**Questions:**
- Is the current `pool_addr` API a UX footgun?
- Would `metadata_out`-based API be cleaner?

### OQ-5 — `execute_path_compose` path validation ordering

`execute_path_compose` does a pre-pass via `trace_path_end` to validate the path AND detect cycle-vs-linear. Then `execute_pool_list` does the actual chain of `pool::swap` calls, each of which internally re-validates the FA metadata against the pool's metadata_a/b.

**Redundancy:** the pre-pass validates the path structurally; the execution would also catch invalid paths via `E_WRONG_TOKEN` in pool::swap.

**Tradeoff:** pre-pass costs ~O(N) extra `pool::pool_tokens` reads (cheap). Benefit: caller gets `E_WRONG_POOL` (clear) instead of `E_WRONG_TOKEN` (ambiguous) on broken paths, with no wasted execution. Plus pre-pass is needed anyway to know the end_asset for baseline / is_cycle computation.

**Question:** any reason to remove the pre-pass? (Developer believes keeping it is right but flags for review.)

### OQ-6 — Service charge when user's swap is sub-optimal

If a caller explicitly passes a `pool_path` to `execute_path_compose` that yields LESS than the direct baseline, our current logic computes `surplus = 0` (no improvement over direct), so no treasury cut. Caller gets their sub-optimal output.

**Question:** should the module REFUSE to execute sub-optimal paths (abort with some error), or just let the caller shoot themselves in the foot? Currently we execute — caller is trusted to know what they're doing.

### OQ-7 — No protection against `caller` parameter spoofing in compose

Compose functions take `swapper: address` / `caller: address` as attribution parameters, used for event emission only. A caller passing a fake address pollutes event analytics.

**Mitigations considered:**
- (a) Require `&signer` and use `signer::address_of` — breaks pure FA-in/FA-out composability; defeats the compose layer's purpose.
- (b) Remove attribution entirely — events become less useful for indexing.
- (c) Accept spoofing as a known limitation, document it — current choice.

**Question:** is (c) the right choice for a decentralized primitive, or is there a middle-ground we missed?

---

## 8. Known tradeoffs we have consciously accepted

These are NOT findings. We have discussed and chosen each deliberately. If you disagree, note under "Design questions" rather than as a finding.

- **`TREASURY` is hardcoded to a specific multisig.** This is a service charge recipient, not a DAO. Project operator framing: "I am providing operational value, this is a service charge not a tax". The 10% applies only to arb surplus, never to principal or LP fees.
- **`close_triangle_flash` is dormant at 3-pool launch.** Requires ≥ 1 pool containing the anchor AND disjoint from the cycle. The 3-pool canonical ecosystem (APT/USDC, APT/USDt, USDt/USDC) has no such disjoint pool. Dormant until a 4th pool is added. Anyone can call `create_canonical_pool` to add it.
- **Event attribution at compose layer can be spoofed.** `caller: address` / `swapper: address` parameters in compose functions are hints, not cryptographic attestation. Indexers should treat them as metadata. Entry wrappers use `signer::address_of(user)` which is authenticated.
- **No multi-hop beyond MAX_HOPS=4 / MAX_CYCLE_LEN=5.** If a future mega-ecosystem has 30 pools per asset, longer paths may miss arb. Accepted as "final design constraint". A compat upgrade during soak can raise the limits if needed.
- **No protocol fee stream.** 100% of swap fee goes to LP. Treasury revenue is ONLY from arbitrage service charge.
- **No TWAP, no stats.** Removed from beta's struct. External oracles / indexers derive from events.
- **No LP migration tool from beta.** LPs withdraw from beta + re-deposit to final manually. Accepted because Beta remains live indefinitely as legacy.
- **`swap_entry` in pool.move is deliberately NOT present.** Users swap via `arbitrage::swap_entry` which wraps `pool::swap` with smart routing. Direct `pool::swap` is a composable primitive callable only from Move code, not from a wallet. This forces all user-facing swap flows through the arbitrage layer (and the service charge).
- **`min_net_profit` is caller's take-home, not gross.** Renamed from `min_profit` for semantic clarity. A caller passing `100` is guaranteed to receive ≥100 of the anchor asset.

---

## 9. Out of scope

Please do NOT audit:

- `tests.move` — it is a 14-line stub. Full test suite will be rebuilt after this audit closes. Do not spend review effort on it.
- Aptos framework dependencies (`aptos_framework::*`). We trust them.
- BCS encoding cryptography, object address derivation, signer capability internals.
- Frontend / SDK / indexer integrations (not in this submission).
- Darbitex Beta at `0x2656e373...9c7ec2` — live and separately audited, not being upgraded.
- Darbitex Alpha at `0x85d1e4...` — legacy, frozen, already immutable.

---

## 10. How to respond

Please return your review as Markdown with the structure described in Section 1. If you find no blocking issues, please explicitly state "no blocking issues found" and provide a green verdict.

If your review finds nothing to report in a category, please still include an empty section (e.g., "HIGH: none") so we can compare coverage across multiple reviewers.

---


---

## 11. Full source code

The following files constitute the complete audit scope for Darbitex Final.

| # | File | Lines |
|---|---|---|
| 1 | `Move.toml` | ~14 |
| 2 | `sources/pool.move` | ~812 |
| 3 | `sources/pool_factory.move` | ~244 |
| 4 | `sources/arbitrage.move` | ~1010 |

`sources/tests.move` (14-line stub) is out of scope — full test suite will be rebuilt post-audit.

### 11.1 Move.toml

```toml
[package]
name = "DarbitexFinal"
version = "0.1.0"
upgrade_policy = "compatible"
authors = ["Rera", "Claude (Anthropic)"]
license = "Unlicense"

[dependencies.AptosFramework]
git = "https://github.com/aptos-labs/aptos-core.git"
rev = "mainnet"
subdir = "aptos-move/framework/aptos-framework"

[addresses]
darbitex = "_"
```

### 11.2 sources/pool.move

```move
/// Darbitex — pool primitive.
///
/// One canonical pool per pair. x*y=k constant product. 1 bps swap fee,
/// 1 bps flash fee, 100% LP. LP positions are Aptos objects with a
/// global fee accumulator + per-position debt snapshot. Flash loan
/// primitive (hot-potato receipt) is exposed for composable arb flows.
/// Zero admin surface.
///
/// `pool::swap` is a pure composable primitive with no callbacks into
/// external modules (no reentrancy surface). The `arbitrage` module
/// wraps `pool::swap` from the outside, providing smart-routing and
/// cycle-closure entry points that apply a 10% service charge on any
/// measurable surplus over a canonical direct-hop baseline.

module darbitex::pool {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::object::{Self, Object, ConstructorRef, ExtendRef, DeleteRef};
    use aptos_framework::fungible_asset::{Self, FungibleAsset, Metadata};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    friend darbitex::pool_factory;

    // ===== Constants =====

    const SWAP_FEE_BPS: u64 = 1;
    const FLASH_FEE_BPS: u64 = 1;
    const BPS_DENOM: u64 = 10_000;
    const MINIMUM_LIQUIDITY: u64 = 1_000;
    const SCALE: u128 = 1_000_000_000_000;
    const U64_MAX: u64 = 18446744073709551615;

    // ===== Errors =====

    const E_ZERO_AMOUNT: u64 = 1;
    const E_INSUFFICIENT_LIQUIDITY: u64 = 2;
    const E_SLIPPAGE: u64 = 3;
    const E_LOCKED: u64 = 4;
    const E_DISPROPORTIONAL: u64 = 5;
    const E_WRONG_POOL: u64 = 6;
    const E_INSUFFICIENT_LP: u64 = 7;
    const E_WRONG_TOKEN: u64 = 8;
    const E_K_VIOLATED: u64 = 9;
    const E_NOT_OWNER: u64 = 10;
    const E_NO_POSITION: u64 = 11;
    const E_NO_POOL: u64 = 12;
    const E_DEADLINE: u64 = 14;

    // ===== Structs =====

    /// Pool state. Config fields (metadata_a/b, extend_ref) are immutable
    /// after create_pool. Reserves + LP accumulators + locked flag mutate
    /// during normal operations.
    struct Pool has key {
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
        extend_ref: ExtendRef,

        reserve_a: u64,
        reserve_b: u64,
        lp_supply: u64,

        // LP fee global accumulators (cumulative per-share, scaled by SCALE).
        // 100% of swap + flash fee flows here.
        lp_fee_per_share_a: u128,
        lp_fee_per_share_b: u128,

        locked: bool,
    }

    /// LP position as an Aptos object. Each add_liquidity mints a new
    /// one. Transferable. Burned on remove_liquidity.
    struct LpPosition has key {
        pool_addr: address,
        shares: u64,
        fee_debt_a: u128,
        fee_debt_b: u128,
        delete_ref: DeleteRef,
    }

    /// Flash loan receipt. Hot-potato: no drop/store/key abilities. Must
    /// be consumed via flash_repay in the same TX.
    struct FlashReceipt {
        pool_addr: address,
        metadata: Object<Metadata>,
        amount: u64,
        fee: u64,
        k_before: u256,
    }

    // ===== Events =====

    #[event]
    struct PoolCreated has drop, store {
        pool_addr: address,
        metadata_a: address,
        metadata_b: address,
        creator: address,
        amount_a: u64,
        amount_b: u64,
        initial_lp: u64,
        timestamp: u64,
    }

    #[event]
    struct Swapped has drop, store {
        pool_addr: address,
        swapper: address,
        amount_in: u64,
        amount_out: u64,
        a_to_b: bool,
        lp_fee: u64,
        timestamp: u64,
    }

    #[event]
    struct LiquidityAdded has drop, store {
        pool_addr: address,
        provider: address,
        position_addr: address,
        amount_a: u64,
        amount_b: u64,
        shares_minted: u64,
        timestamp: u64,
    }

    #[event]
    struct LiquidityRemoved has drop, store {
        pool_addr: address,
        provider: address,
        position_addr: address,
        amount_a: u64,
        amount_b: u64,
        fees_a: u64,
        fees_b: u64,
        shares_burned: u64,
        timestamp: u64,
    }

    #[event]
    struct LpFeesClaimed has drop, store {
        pool_addr: address,
        position_addr: address,
        claimer: address,
        fees_a: u64,
        fees_b: u64,
        timestamp: u64,
    }

    #[event]
    struct FlashBorrowed has drop, store {
        pool_addr: address,
        metadata: address,
        amount: u64,
        fee: u64,
        timestamp: u64,
    }

    #[event]
    struct FlashRepaid has drop, store {
        pool_addr: address,
        metadata: address,
        amount: u64,
        fee: u64,
        timestamp: u64,
    }

    // ===== Internal helpers =====

    /// Babylonian integer sqrt for initial LP share computation.
    fun sqrt(x: u128): u128 {
        if (x == 0) return 0;
        let z = (x + 1) / 2;
        let y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        };
        y
    }

    /// Pure x*y=k swap math with SWAP_FEE_BPS wedge. u256 intermediates
    /// prevent overflow on adversarial reserves near u64::MAX. Public so
    /// the arbitrage module can simulate cycle outputs stateless during
    /// ternary search without re-reading pool state per iteration.
    public fun compute_amount_out(
        reserve_in: u64,
        reserve_out: u64,
        amount_in: u64,
    ): u64 {
        let amount_in_after_fee = (amount_in as u256) * ((BPS_DENOM - SWAP_FEE_BPS) as u256);
        let numerator = amount_in_after_fee * (reserve_out as u256);
        let denominator = (reserve_in as u256) * (BPS_DENOM as u256) + amount_in_after_fee;
        ((numerator / denominator) as u64)
    }

    /// Pure flash-fee computation: `amount * FLASH_FEE_BPS / BPS_DENOM`,
    /// floored up to 1 so dust borrows still pay a unit. Public so the
    /// arbitrage module can pre-compute repayment obligations for
    /// flash-based triangle closure without simulating the borrow.
    public fun compute_flash_fee(amount: u64): u64 {
        let fee_raw = (((amount as u256) * (FLASH_FEE_BPS as u256) / (BPS_DENOM as u256)) as u64);
        if (fee_raw == 0) { 1 } else { fee_raw }
    }

    /// Credit `fee` to the LP per-share accumulator on the side the fee
    /// was collected. Returns the accrued amount (== fee) for event
    /// attribution. Zero-credit on dust fees (fee=0) is a silent no-op.
    fun accrue_fee(pool: &mut Pool, fee: u64, a_side: bool): u64 {
        if (fee > 0 && pool.lp_supply > 0) {
            let add = (fee as u128) * SCALE / (pool.lp_supply as u128);
            if (a_side) {
                pool.lp_fee_per_share_a = pool.lp_fee_per_share_a + add;
            } else {
                pool.lp_fee_per_share_b = pool.lp_fee_per_share_b + add;
            }
        };
        fee
    }

    /// Compute `(per_share_current - per_share_debt) * shares / SCALE` in
    /// u256 to avoid overflow, return u64.
    fun pending_from_accumulator(
        per_share_current: u128,
        per_share_debt: u128,
        shares: u64,
    ): u64 {
        if (per_share_current <= per_share_debt) return 0;
        let delta = per_share_current - per_share_debt;
        let product = (delta as u256) * (shares as u256);
        let scaled = product / (SCALE as u256);
        (scaled as u64)
    }

    /// Mint a fresh LpPosition object for `owner_addr` with the given
    /// shares and debt snapshot.
    fun mint_lp_position(
        owner_addr: address,
        pool_addr: address,
        shares: u64,
        initial_debt_a: u128,
        initial_debt_b: u128,
    ): Object<LpPosition> {
        let ctor = object::create_object(owner_addr);
        let pos_signer = object::generate_signer(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        move_to(&pos_signer, LpPosition {
            pool_addr,
            shares,
            fee_debt_a: initial_debt_a,
            fee_debt_b: initial_debt_b,
            delete_ref,
        });

        object::object_from_constructor_ref<LpPosition>(&ctor)
    }

    // ===== Pool Creation (friend-only) =====

    /// Atomic pool + initial LP position creation. Called only by
    /// pool_factory::create_canonical_pool. Returns (pool_addr, position).
    public(friend) fun create_pool(
        factory_signer: &signer,
        creator_addr: address,
        constructor_ref: &ConstructorRef,
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
        amount_a: u64,
        amount_b: u64,
    ): (address, Object<LpPosition>) {
        // Creator picks the initial reserve ratio by choosing
        // (amount_a, amount_b) — this is the only place the ratio is
        // set from outside the invariant. Later LPs go through
        // `add_liquidity`, which enforces an optimal-pair match against
        // the live reserves plus `min_shares_out` slippage protection.
        assert!(amount_a > 0 && amount_b > 0, E_ZERO_AMOUNT);
        // Note: same-token pair rejection lives in the factory's
        // `assert_sorted` (strict `<` on BCS bytes). `create_pool` is
        // friend-only, reachable exclusively through
        // `pool_factory::create_canonical_pool`, so metadata_a and
        // metadata_b are guaranteed distinct at this point.

        let pool_signer = object::generate_signer(constructor_ref);
        let pool_addr = signer::address_of(&pool_signer);
        let extend_ref = object::generate_extend_ref(constructor_ref);

        let pool_transfer_ref = object::generate_transfer_ref(constructor_ref);
        object::disable_ungated_transfer(&pool_transfer_ref);

        let fa_a = primary_fungible_store::withdraw(factory_signer, metadata_a, amount_a);
        let fa_b = primary_fungible_store::withdraw(factory_signer, metadata_b, amount_b);
        primary_fungible_store::deposit(pool_addr, fa_a);
        primary_fungible_store::deposit(pool_addr, fa_b);

        // Initial LP shares = sqrt(a*b). MINIMUM_LIQUIDITY shares are
        // locked as dead shares so the first depositor cannot corner
        // the position via a later-stage ratio squeeze.
        let initial_lp_u128 = sqrt((amount_a as u128) * (amount_b as u128));
        assert!(initial_lp_u128 > (MINIMUM_LIQUIDITY as u128), E_INSUFFICIENT_LIQUIDITY);
        let initial_lp = (initial_lp_u128 as u64);
        let creator_shares = initial_lp - MINIMUM_LIQUIDITY;

        let now = timestamp::now_seconds();

        move_to(&pool_signer, Pool {
            metadata_a,
            metadata_b,
            extend_ref,
            reserve_a: amount_a,
            reserve_b: amount_b,
            lp_supply: initial_lp,
            lp_fee_per_share_a: 0,
            lp_fee_per_share_b: 0,
            locked: false,
        });

        let position = mint_lp_position(creator_addr, pool_addr, creator_shares, 0, 0);
        let position_addr = object::object_address(&position);

        event::emit(PoolCreated {
            pool_addr,
            metadata_a: object::object_address(&metadata_a),
            metadata_b: object::object_address(&metadata_b),
            creator: creator_addr,
            amount_a,
            amount_b,
            initial_lp,
            timestamp: now,
        });

        event::emit(LiquidityAdded {
            pool_addr,
            provider: creator_addr,
            position_addr,
            amount_a,
            amount_b,
            shares_minted: creator_shares,
            timestamp: now,
        });

        (pool_addr, position)
    }

    // ===== Swap =====

    /// Composable swap primitive. Takes FungibleAsset and returns
    /// FungibleAsset. No &signer — authorization happens at the caller's
    /// FA withdraw. `swapper` is recorded in the Swapped event for
    /// attribution only.
    public fun swap(
        pool_addr: address,
        swapper: address,
        fa_in: FungibleAsset,
        min_out: u64,
    ): FungibleAsset acquires Pool {
        assert!(exists<Pool>(pool_addr), E_NO_POOL);
        let pool = borrow_global_mut<Pool>(pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;

        let in_metadata = fungible_asset::asset_metadata(&fa_in);
        let amount_in = fungible_asset::amount(&fa_in);
        assert!(amount_in > 0, E_ZERO_AMOUNT);

        let a_to_b =
            if (object::object_address(&in_metadata) == object::object_address(&pool.metadata_a)) {
                true
            } else {
                assert!(
                    object::object_address(&in_metadata) == object::object_address(&pool.metadata_b),
                    E_WRONG_TOKEN,
                );
                false
            };

        let (reserve_in, reserve_out) = if (a_to_b) {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        let amount_out = compute_amount_out(reserve_in, reserve_out, amount_in);

        assert!(amount_out >= min_out, E_SLIPPAGE);
        assert!(amount_out < reserve_out, E_INSUFFICIENT_LIQUIDITY);

        let fee = amount_in * SWAP_FEE_BPS / BPS_DENOM;
        let lp_fee = accrue_fee(pool, fee, a_to_b);

        if (a_to_b) {
            pool.reserve_a = pool.reserve_a + amount_in - lp_fee;
            pool.reserve_b = pool.reserve_b - amount_out;
        } else {
            pool.reserve_a = pool.reserve_a - amount_out;
            pool.reserve_b = pool.reserve_b + amount_in - lp_fee;
        };

        primary_fungible_store::deposit(pool_addr, fa_in);
        let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
        let out_metadata = if (a_to_b) { pool.metadata_b } else { pool.metadata_a };
        let fa_out = primary_fungible_store::withdraw(&pool_signer, out_metadata, amount_out);

        pool.locked = false;

        event::emit(Swapped {
            pool_addr,
            swapper,
            amount_in,
            amount_out,
            a_to_b,
            lp_fee,
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Liquidity =====

    /// Add liquidity. Mints a new LpPosition NFT to the provider; each
    /// call mints a separate position (no merging).
    ///
    /// `amount_a_desired`/`amount_b_desired` are maxima. The function
    /// picks the optimal pair: the side whose desired amount more
    /// tightly matches the current reserve ratio is used in full, and
    /// the other side uses only the proportional amount. The unused
    /// buffer stays in the caller's wallet.
    ///
    /// `min_shares_out` is the slippage floor on minted shares.
    public fun add_liquidity(
        provider: &signer,
        pool_addr: address,
        amount_a_desired: u64,
        amount_b_desired: u64,
        min_shares_out: u64,
    ): Object<LpPosition> acquires Pool {
        assert!(exists<Pool>(pool_addr), E_NO_POOL);
        assert!(amount_a_desired > 0 && amount_b_desired > 0, E_ZERO_AMOUNT);

        let pool = borrow_global_mut<Pool>(pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;

        // u64 cast guard: for ratios > 2^64:1 the u256 product overflows
        // u64. Explicit assert produces E_INSUFFICIENT_LIQUIDITY instead
        // of an opaque arithmetic abort.
        let amount_b_optimal_u256 =
            (amount_a_desired as u256) * (pool.reserve_b as u256)
                / (pool.reserve_a as u256);
        assert!(amount_b_optimal_u256 <= (U64_MAX as u256), E_INSUFFICIENT_LIQUIDITY);
        let amount_b_optimal = (amount_b_optimal_u256 as u64);
        let (amount_a, amount_b) = if (amount_b_optimal <= amount_b_desired) {
            (amount_a_desired, amount_b_optimal)
        } else {
            let amount_a_optimal_u256 =
                (amount_b_desired as u256) * (pool.reserve_a as u256)
                    / (pool.reserve_b as u256);
            assert!(amount_a_optimal_u256 <= (U64_MAX as u256), E_INSUFFICIENT_LIQUIDITY);
            let amount_a_optimal = (amount_a_optimal_u256 as u64);
            // Mathematically guaranteed by the if-branch condition under
            // the x*y=k invariant — kept as an explicit invariant check.
            assert!(amount_a_optimal <= amount_a_desired, E_DISPROPORTIONAL);
            (amount_a_optimal, amount_b_desired)
        };

        assert!(amount_a > 0 && amount_b > 0, E_ZERO_AMOUNT);

        // Shares minted proportionally; min as a guard against integer
        // rounding asymmetry between the two sides.
        let lp_a = (
            ((amount_a as u256) * (pool.lp_supply as u256) / (pool.reserve_a as u256)) as u64
        );
        let lp_b = (
            ((amount_b as u256) * (pool.lp_supply as u256) / (pool.reserve_b as u256)) as u64
        );
        let shares = if (lp_a < lp_b) { lp_a } else { lp_b };
        assert!(shares > 0, E_ZERO_AMOUNT);
        assert!(shares >= min_shares_out, E_SLIPPAGE);

        let provider_addr = signer::address_of(provider);

        let fa_a = primary_fungible_store::withdraw(provider, pool.metadata_a, amount_a);
        let fa_b = primary_fungible_store::withdraw(provider, pool.metadata_b, amount_b);
        primary_fungible_store::deposit(pool_addr, fa_a);
        primary_fungible_store::deposit(pool_addr, fa_b);

        pool.reserve_a = pool.reserve_a + amount_a;
        pool.reserve_b = pool.reserve_b + amount_b;
        pool.lp_supply = pool.lp_supply + shares;

        let debt_a = pool.lp_fee_per_share_a;
        let debt_b = pool.lp_fee_per_share_b;

        let position = mint_lp_position(provider_addr, pool_addr, shares, debt_a, debt_b);
        let position_addr = object::object_address(&position);

        event::emit(LiquidityAdded {
            pool_addr,
            provider: provider_addr,
            position_addr,
            amount_a,
            amount_b,
            shares_minted: shares,
            timestamp: timestamp::now_seconds(),
        });

        pool.locked = false;
        position
    }

    /// Burn LpPosition and return proportional reserves PLUS accumulated
    /// LP fees in one shot. `min_amount_a`/`min_amount_b` are slippage
    /// floors on the proportional reserve payout (not fee claims).
    public fun remove_liquidity(
        provider: &signer,
        position: Object<LpPosition>,
        min_amount_a: u64,
        min_amount_b: u64,
    ): (FungibleAsset, FungibleAsset) acquires Pool, LpPosition {
        let provider_addr = signer::address_of(provider);
        assert!(object::owner(position) == provider_addr, E_NOT_OWNER);

        let position_addr = object::object_address(&position);
        assert!(exists<LpPosition>(position_addr), E_NO_POSITION);

        let LpPosition {
            pool_addr,
            shares,
            fee_debt_a,
            fee_debt_b,
            delete_ref,
        } = move_from<LpPosition>(position_addr);

        assert!(exists<Pool>(pool_addr), E_NO_POOL);
        let pool = borrow_global_mut<Pool>(pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;
        assert!(shares > 0, E_ZERO_AMOUNT);
        assert!(pool.lp_supply >= shares, E_INSUFFICIENT_LP);

        let claim_a = pending_from_accumulator(pool.lp_fee_per_share_a, fee_debt_a, shares);
        let claim_b = pending_from_accumulator(pool.lp_fee_per_share_b, fee_debt_b, shares);

        let amount_a = (
            ((shares as u256) * (pool.reserve_a as u256) / (pool.lp_supply as u256)) as u64
        );
        let amount_b = (
            ((shares as u256) * (pool.reserve_b as u256) / (pool.lp_supply as u256)) as u64
        );

        assert!(amount_a >= min_amount_a, E_SLIPPAGE);
        assert!(amount_b >= min_amount_b, E_SLIPPAGE);

        pool.lp_supply = pool.lp_supply - shares;
        assert!(pool.lp_supply >= MINIMUM_LIQUIDITY, E_INSUFFICIENT_LIQUIDITY);
        pool.reserve_a = pool.reserve_a - amount_a;
        pool.reserve_b = pool.reserve_b - amount_b;

        let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
        let fa_a = primary_fungible_store::withdraw(&pool_signer, pool.metadata_a, amount_a + claim_a);
        let fa_b = primary_fungible_store::withdraw(&pool_signer, pool.metadata_b, amount_b + claim_b);

        event::emit(LiquidityRemoved {
            pool_addr,
            provider: provider_addr,
            position_addr,
            amount_a,
            amount_b,
            fees_a: claim_a,
            fees_b: claim_b,
            shares_burned: shares,
            timestamp: timestamp::now_seconds(),
        });

        object::delete(delete_ref);

        pool.locked = false;
        (fa_a, fa_b)
    }

    // ===== Fee Claims =====

    /// Harvest accumulated LP fees without touching position's shares.
    /// Resets debt snapshot to current per_share so future accumulation
    /// starts from zero. Runs under the pool lock to stay safe if FA
    /// operations ever gain dispatch callbacks.
    public fun claim_lp_fees(
        provider: &signer,
        position: Object<LpPosition>,
    ): (FungibleAsset, FungibleAsset) acquires Pool, LpPosition {
        let provider_addr = signer::address_of(provider);
        assert!(object::owner(position) == provider_addr, E_NOT_OWNER);

        let position_addr = object::object_address(&position);
        assert!(exists<LpPosition>(position_addr), E_NO_POSITION);

        let pos = borrow_global_mut<LpPosition>(position_addr);
        assert!(exists<Pool>(pos.pool_addr), E_NO_POOL);

        let pool = borrow_global_mut<Pool>(pos.pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;

        let claim_a = pending_from_accumulator(pool.lp_fee_per_share_a, pos.fee_debt_a, pos.shares);
        let claim_b = pending_from_accumulator(pool.lp_fee_per_share_b, pos.fee_debt_b, pos.shares);

        pos.fee_debt_a = pool.lp_fee_per_share_a;
        pos.fee_debt_b = pool.lp_fee_per_share_b;

        let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
        let fa_a = if (claim_a > 0) {
            primary_fungible_store::withdraw(&pool_signer, pool.metadata_a, claim_a)
        } else {
            fungible_asset::zero(pool.metadata_a)
        };
        let fa_b = if (claim_b > 0) {
            primary_fungible_store::withdraw(&pool_signer, pool.metadata_b, claim_b)
        } else {
            fungible_asset::zero(pool.metadata_b)
        };

        pool.locked = false;

        event::emit(LpFeesClaimed {
            pool_addr: pos.pool_addr,
            position_addr,
            claimer: provider_addr,
            fees_a: claim_a,
            fees_b: claim_b,
            timestamp: timestamp::now_seconds(),
        });

        (fa_a, fa_b)
    }

    // ===== Flash loan =====

    /// Flash borrow `amount` of `metadata` from the pool. Returns
    /// borrowed FA and a FlashReceipt hot-potato that must be consumed
    /// via flash_repay in the same TX. Pool is locked during the borrow
    /// span — swap/LP/flash ops abort until repay.
    public fun flash_borrow(
        pool_addr: address,
        metadata: Object<Metadata>,
        amount: u64,
    ): (FungibleAsset, FlashReceipt) acquires Pool {
        assert!(exists<Pool>(pool_addr), E_NO_POOL);
        assert!(amount > 0, E_ZERO_AMOUNT);

        let pool = borrow_global_mut<Pool>(pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;

        let metadata_addr = object::object_address(&metadata);
        let is_a = metadata_addr == object::object_address(&pool.metadata_a);
        assert!(is_a || metadata_addr == object::object_address(&pool.metadata_b), E_WRONG_TOKEN);

        let (reserve_in, reserve_out) = if (is_a) {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };
        assert!(amount < reserve_in, E_INSUFFICIENT_LIQUIDITY);

        // Record k_before in u256 for safe repay-time invariant check.
        let k_before = (reserve_in as u256) * (reserve_out as u256);

        let fee = compute_flash_fee(amount);

        let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
        let fa_out = primary_fungible_store::withdraw(&pool_signer, metadata, amount);

        event::emit(FlashBorrowed {
            pool_addr,
            metadata: metadata_addr,
            amount,
            fee,
            timestamp: timestamp::now_seconds(),
        });

        let receipt = FlashReceipt {
            pool_addr,
            metadata,
            amount,
            fee,
            k_before,
        };

        (fa_out, receipt)
    }

    /// Repay flash borrow with principal + fee. Consumes the hot-potato
    /// receipt and releases the lock.
    ///
    /// Reserve accounting: `flash_borrow` does NOT decrement reserve_a/b
    /// when the borrowed amount leaves the store — the `locked` flag
    /// guarantees no one reads reserves during the borrow span.
    /// Therefore `flash_repay` must NOT add the principal back; doing so
    /// would inflate reserves by `amount` and break solvency. Only the
    /// fee is routed to LP via `accrue_fee`.
    public fun flash_repay(
        pool_addr: address,
        fa_in: FungibleAsset,
        receipt: FlashReceipt,
    ) acquires Pool {
        let FlashReceipt { pool_addr: r_pool, metadata, amount, fee, k_before } = receipt;
        assert!(pool_addr == r_pool, E_WRONG_POOL);

        let repay_total = amount + fee;
        // Strict equality prevents silent donation of excess — the
        // surplus would be deposited as untracked reserve drift.
        assert!(fungible_asset::amount(&fa_in) == repay_total, E_INSUFFICIENT_LIQUIDITY);
        assert!(
            object::object_address(&fungible_asset::asset_metadata(&fa_in)) == object::object_address(&metadata),
            E_WRONG_TOKEN,
        );

        let pool = borrow_global_mut<Pool>(pool_addr);

        primary_fungible_store::deposit(pool_addr, fa_in);

        // Fee is pure LP revenue. Reserves unchanged — they were never
        // decremented at borrow time.
        let is_a = object::object_address(&metadata) == object::object_address(&pool.metadata_a);
        let _lp = accrue_fee(pool, fee, is_a);

        // k-invariant: post-repay reserves product must be >= pre-borrow
        // snapshot. With the reserve-unchanged model above, equality is
        // the expected case.
        let k_after = (pool.reserve_a as u256) * (pool.reserve_b as u256);
        assert!(k_after >= k_before, E_K_VIOLATED);

        pool.locked = false;

        event::emit(FlashRepaid {
            pool_addr,
            metadata: object::object_address(&metadata),
            amount,
            fee,
            timestamp: timestamp::now_seconds(),
        });
    }

    // ===== LP management entry wrappers (deadline-guarded) =====
    //
    // Swap entry is deliberately NOT here — users swap via the
    // `arbitrage` module, which wraps `pool::swap` with smart routing
    // and cycle closure and applies a 10% service charge on any
    // measurable surplus over the canonical direct-hop baseline.
    // Direct `pool::swap` is the pure composable primitive, callable
    // only from Move code (no wallet-facing entry).

    public entry fun add_liquidity_entry(
        provider: &signer,
        pool_addr: address,
        amount_a: u64,
        amount_b: u64,
        min_shares_out: u64,
        deadline: u64,
    ) acquires Pool {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let _ = add_liquidity(provider, pool_addr, amount_a, amount_b, min_shares_out);
    }

    public entry fun remove_liquidity_entry(
        provider: &signer,
        position: Object<LpPosition>,
        min_amount_a: u64,
        min_amount_b: u64,
        deadline: u64,
    ) acquires Pool, LpPosition {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let provider_addr = signer::address_of(provider);
        let (fa_a, fa_b) = remove_liquidity(provider, position, min_amount_a, min_amount_b);
        primary_fungible_store::deposit(provider_addr, fa_a);
        primary_fungible_store::deposit(provider_addr, fa_b);
    }

    public entry fun claim_lp_fees_entry(
        provider: &signer,
        position: Object<LpPosition>,
        deadline: u64,
    ) acquires Pool, LpPosition {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let provider_addr = signer::address_of(provider);
        let (fa_a, fa_b) = claim_lp_fees(provider, position);
        primary_fungible_store::deposit(provider_addr, fa_a);
        primary_fungible_store::deposit(provider_addr, fa_b);
    }

    // ===== Minimal state readers =====
    //
    // Only what the arbitrage module + frontend pool list need. LP
    // position views (supply, fees, pending) are intentionally omitted
    // — client-side RPC can read resources directly.

    #[view]
    public fun pool_exists(pool_addr: address): bool {
        exists<Pool>(pool_addr)
    }

    #[view]
    public fun reserves(pool_addr: address): (u64, u64) acquires Pool {
        let p = borrow_global<Pool>(pool_addr);
        (p.reserve_a, p.reserve_b)
    }

    #[view]
    public fun pool_tokens(pool_addr: address): (Object<Metadata>, Object<Metadata>) acquires Pool {
        let p = borrow_global<Pool>(pool_addr);
        (p.metadata_a, p.metadata_b)
    }
}
```

### 11.3 sources/pool_factory.move

```move
/// Darbitex — pool factory.
///
/// Creates canonical pools (one per sorted pair, deterministic
/// named-object address). Maintains a global asset→pools index used by
/// `arbitrage` for sister-pool discovery. Pure primitives + minimum
/// readers. No admin surface. The pool module owns the creation event
/// stream; the factory does not re-emit.

module darbitex::pool_factory {
    use std::signer;
    use std::vector;
    use std::bcs;
    use aptos_std::table::{Self, Table};
    use aptos_framework::account::{Self, SignerCapability};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::primary_fungible_store;

    use darbitex::pool;

    const FACTORY_SEED: vector<u8> = b"darbitex_factory";
    const POOL_SEED_PREFIX: vector<u8> = b"darbitex_pool";

    /// Hard cap on the per-call page size for `pools_containing_asset`.
    /// Bounds the per-call copy cost of the reverse index to a small
    /// constant regardless of how many pools reference any one asset.
    /// No cap on TOTAL pools per asset — callers (the arbitrage
    /// module and off-chain readers) paginate through the full set
    /// by looping `offset` if the page is saturated.
    const MAX_PAGE: u64 = 10;

    const E_NOT_ADMIN: u64 = 1;
    const E_ALREADY_INIT: u64 = 2;
    const E_NOT_INIT: u64 = 3;
    const E_WRONG_ORDER: u64 = 4;
    const E_ZERO: u64 = 5;

    /// Singleton at @darbitex. Owns the resource account under which all
    /// pool objects live and holds the asset→pools reverse index.
    struct Factory has key {
        signer_cap: SignerCapability,
        factory_addr: address,
        pool_addresses: vector<address>,
        /// Asset metadata address → list of pool addresses containing
        /// that asset as one of the two sides. Read via paginated
        /// `pools_containing_asset(asset, offset, limit)` to bound
        /// per-call copy cost.
        asset_index: Table<address, vector<address>>,
    }

    /// Require the pair in canonical sorted order (BCS byte order).
    fun assert_sorted(metadata_a: Object<Metadata>, metadata_b: Object<Metadata>) {
        let ba = bcs::to_bytes(&object::object_address(&metadata_a));
        let bb = bcs::to_bytes(&object::object_address(&metadata_b));
        assert!(ba < bb, E_WRONG_ORDER);
    }

    /// Deterministic seed from two raw asset addresses in the order
    /// supplied. Callers are responsible for passing them in canonical
    /// (BCS-sorted) order.
    fun derive_pair_seed_addrs(
        asset_a: address,
        asset_b: address,
    ): vector<u8> {
        let seed = POOL_SEED_PREFIX;
        vector::append(&mut seed, bcs::to_bytes(&asset_a));
        vector::append(&mut seed, bcs::to_bytes(&asset_b));
        seed
    }

    /// Object-typed convenience wrapper over `derive_pair_seed_addrs`.
    fun derive_pair_seed(
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
    ): vector<u8> {
        derive_pair_seed_addrs(
            object::object_address(&metadata_a),
            object::object_address(&metadata_b),
        )
    }

    /// Insert `pool_addr` into `asset_index[asset]`, creating the
    /// bucket on first touch. No cap on bucket length — ecosystem
    /// growth must not be gated by the factory. Arbitrage DFS
    /// paginates through the full bucket via MAX_PAGE-sized reads.
    fun index_asset(
        asset_index: &mut Table<address, vector<address>>,
        asset: address,
        pool_addr: address,
    ) {
        if (!table::contains(asset_index, asset)) {
            let v = vector::empty<address>();
            vector::push_back(&mut v, pool_addr);
            table::add(asset_index, asset, v);
        } else {
            let v = table::borrow_mut(asset_index, asset);
            vector::push_back(v, pool_addr);
        }
    }

    /// One-shot initializer. Called by the package publisher (`@darbitex`)
    /// once, immediately after publish.
    public entry fun init_factory(deployer: &signer) {
        assert!(signer::address_of(deployer) == @darbitex, E_NOT_ADMIN);
        assert!(!exists<Factory>(@darbitex), E_ALREADY_INIT);

        let (factory_signer, signer_cap) = account::create_resource_account(deployer, FACTORY_SEED);
        let factory_addr = signer::address_of(&factory_signer);

        move_to(deployer, Factory {
            signer_cap,
            factory_addr,
            pool_addresses: vector::empty(),
            asset_index: table::new(),
        });
    }

    /// Atomic canonical pool creation. Caller supplies seeding tokens
    /// with independent `amount_a`/`amount_b` — initial ratio is set by
    /// creator. Duplicate protection via `create_named_object` abort.
    public entry fun create_canonical_pool(
        creator: &signer,
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
        amount_a: u64,
        amount_b: u64,
    ) acquires Factory {
        assert!(exists<Factory>(@darbitex), E_NOT_INIT);
        assert!(amount_a > 0 && amount_b > 0, E_ZERO);
        // `assert_sorted` uses strict `<` on BCS bytes, which also
        // rejects same-token pairs (`bcs(a) < bcs(a)` is false).
        assert_sorted(metadata_a, metadata_b);

        let factory = borrow_global_mut<Factory>(@darbitex);
        let factory_signer = account::create_signer_with_capability(&factory.signer_cap);
        let factory_addr = factory.factory_addr;
        let creator_addr = signer::address_of(creator);

        let fa_a = primary_fungible_store::withdraw(creator, metadata_a, amount_a);
        let fa_b = primary_fungible_store::withdraw(creator, metadata_b, amount_b);
        primary_fungible_store::deposit(factory_addr, fa_a);
        primary_fungible_store::deposit(factory_addr, fa_b);

        let seed = derive_pair_seed(metadata_a, metadata_b);
        let ctor = object::create_named_object(&factory_signer, seed);

        let (pool_addr, _position) = pool::create_pool(
            &factory_signer,
            creator_addr,
            &ctor,
            metadata_a,
            metadata_b,
            amount_a,
            amount_b,
        );

        vector::push_back(&mut factory.pool_addresses, pool_addr);
        index_asset(&mut factory.asset_index, object::object_address(&metadata_a), pool_addr);
        index_asset(&mut factory.asset_index, object::object_address(&metadata_b), pool_addr);
    }

    // ===== Minimal readers =====

    #[view]
    public fun get_all_pools(): vector<address> acquires Factory {
        borrow_global<Factory>(@darbitex).pool_addresses
    }

    // Total number of pools containing `asset` as one of the two sides.
    // Cheap read (no copy). Lets the arbitrage module know whether to
    // paginate a second call when `limit` is saturated.
    #[view]
    public fun pools_containing_asset_count(asset: address): u64 acquires Factory {
        let f = borrow_global<Factory>(@darbitex);
        if (table::contains(&f.asset_index, asset)) {
            vector::length(table::borrow(&f.asset_index, asset))
        } else {
            0
        }
    }

    // Paginated reverse index lookup. Returns at most `min(limit,
    // MAX_PAGE)` pool addresses, starting at `offset` within the
    // asset's pool bucket. Empty if `asset` has no entries or `offset`
    // is past the end. Used by the arbitrage module for sister-pool
    // discovery and by off-chain indexers.
    #[view]
    public fun pools_containing_asset(
        asset: address,
        offset: u64,
        limit: u64,
    ): vector<address> acquires Factory {
        let result = vector::empty<address>();
        let f = borrow_global<Factory>(@darbitex);
        if (!table::contains(&f.asset_index, asset)) return result;

        let bucket = table::borrow(&f.asset_index, asset);
        let len = vector::length(bucket);
        if (offset >= len) return result;

        let capped = if (limit > MAX_PAGE) { MAX_PAGE } else { limit };
        // `remaining` is safe (offset < len is guaranteed above), and
        // `take = min(capped, remaining)` fits in u64 without overflow
        // because `take <= len - offset < len`.
        let remaining = len - offset;
        let take = if (capped > remaining) { remaining } else { capped };

        let i = 0;
        while (i < take) {
            vector::push_back(&mut result, *vector::borrow(bucket, offset + i));
            i = i + 1;
        };
        result
    }

    // Canonical pool address for any two asset metadata addresses,
    // without requiring the pool to exist. Sorts the inputs in BCS
    // byte order internally (caller does not need to pre-sort) and
    // returns the deterministic object address derived from the
    // factory seed + sorted pair. Pure address derivation — callers
    // must check `pool::pool_exists(addr)` before assuming the pool
    // is live.
    //
    // Used by the arbitrage module for O(1) direct-pool lookup when
    // computing the service-charge baseline, replacing a previously
    // O(N) reverse-index scan that could miss direct pools parked
    // past the pagination page size.
    #[view]
    public fun canonical_pool_address_of(
        asset_a: address,
        asset_b: address,
    ): address acquires Factory {
        let ba = bcs::to_bytes(&asset_a);
        let bb = bcs::to_bytes(&asset_b);
        let (sorted_a, sorted_b) = if (ba < bb) {
            (asset_a, asset_b)
        } else {
            (asset_b, asset_a)
        };
        let f = borrow_global<Factory>(@darbitex);
        let seed = derive_pair_seed_addrs(sorted_a, sorted_b);
        object::create_object_address(&f.factory_addr, seed)
    }
}
```

### 11.4 sources/arbitrage.move

```move
/// Darbitex — arbitrage module.
///
/// Decentralized, agnostic, composable. Every capability is available
/// in three layers:
///
/// • **Entry wrappers** — `*_entry` functions callable from a wallet.
///   Handle deadline, primary-store withdraw/deposit, and call into
///   the compose layer.
///
/// • **Composable primitives** — `*_compose` functions taking raw
///   `FungibleAsset` values and returning the caller's share as a
///   `FungibleAsset`. No `&signer`, no primary-store coupling, no
///   deadline. External Move modules (Aave flash receivers, other
///   DEX satellites, custom arb bots) import these directly and
///   compose them into larger flows. Treasury cut is extracted
///   inside the compose function where applicable.
///
/// • **Quote views** — `quote_*` functions marked `#[view]` for
///   RPC-side path discovery without executing. Off-chain bots
///   precompute the best path / cycle / flash triangle, then either
///   call an entry function or pass the path to
///   `execute_path_compose` for minimum on-chain overhead.
///
/// Four execution surfaces:
///
///   1. `execute_path_compose`  — raw chained multi-hop swap; no
///      treasury cut. Pure composability primitive, mirrors
///      `pool::swap` semantics extended to a pool sequence.
///
///   2. `swap_compose`          — smart-routed single-swap: module
///      DFS-searches the best path from input to output asset,
///      executes, and splits any improvement over the canonical
///      direct-hop pool 90% to caller / 10% to treasury. If no
///      canonical direct pool exists, baseline is 0 and no service
///      charge applies (Darbitex is the only available route).
///
///   3. `close_triangle_compose` — real-capital cycle closure:
///      caller supplies a seed FA, module executes the best cycle
///      (length 3..MAX_CYCLE_LEN) starting and ending at the
///      seed's asset, splits profit 90% / 10%.
///
///   4. `close_triangle_flash_compose` — zero-capital flash cycle:
///      module finds a (borrow_pool, cycle) topology where the
///      borrow pool is disjoint from the cycle legs, flash-borrows
///      the anchor amount, runs the cycle, repays, and returns the
///      caller's 90% profit share.
///
/// All execution paths pay the 1 bps LP fee per pool touched via
/// `pool::swap`. External flash-loan providers (Aave) compose
/// trivially with `close_triangle_compose` or `swap_compose` by
/// withdrawing FA from their borrow callback and feeding it in.
/// Rebalancing across the pool graph is a natural side effect of
/// repeated cycle/routed execution; there is no "goal state" — arb
/// continues as long as profit remains.

module darbitex::arbitrage {
    use std::signer;
    use std::vector;
    use aptos_framework::event;
    use aptos_framework::object::{Self, Object};
    use aptos_framework::fungible_asset::{Self, FungibleAsset, Metadata};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool;
    use darbitex::pool_factory;

    // ===== Constants =====

    /// Treasury cut is 10% of surplus; caller/user gets the remaining 90%.
    const TREASURY_BPS: u64 = 1_000;
    const TOTAL_BPS: u64 = 10_000;

    /// Max path length for smart routing.
    const MAX_HOPS: u64 = 4;

    /// Max cycle length for triangle closure. Minimum is 3 (enforced
    /// at match time) because canonical pairs make 2-leg cycles
    /// impossible.
    const MAX_CYCLE_LEN: u64 = 5;

    /// Per-lookup page size for the factory's reverse index.
    const PAGE: u64 = 10;

    /// Soft DFS visit budget — maximum number of sister-pool
    /// candidates the recursive search will iterate through across
    /// the entire search tree per `find_best_*` call. Once exhausted,
    /// the DFS returns the best path found so far and stops
    /// exploring. Bounds worst-case gas to a predictable O(budget)
    /// regardless of ecosystem size, preventing gas-exhaustion DoS
    /// from junk-pool spam.
    const DFS_VISIT_BUDGET: u64 = 256;

    /// Treasury recipient for the protocol cut on arb surplus.
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;

    // ===== Errors =====

    const E_DEADLINE: u64 = 1;
    const E_ZERO: u64 = 2;
    const E_WRONG_POOL: u64 = 3;
    const E_SLIPPAGE: u64 = 4;
    const E_NO_CYCLE: u64 = 5;
    const E_MIN_PROFIT: u64 = 6;

    // ===== Types =====

    /// A path through the pool graph. `pools[i]` is the pool used for
    /// hop `i`; direction at each hop is inferred from the FA metadata
    /// at execution time (see `pool::swap`). `expected_out` is the
    /// simulated output at the final hop given the entry amount at
    /// hop 0.
    struct Path has copy, drop {
        pools: vector<address>,
        expected_out: u64,
    }

    /// A flash-based triangle: `borrow_pool` is the flash source,
    /// `cycle` is the closed cycle at anchor that must not include
    /// `borrow_pool`. `borrow_pool == @0x0` signals no valid topology.
    struct FlashTriangle has copy, drop {
        borrow_pool: address,
        cycle: Path,
    }

    fun empty_path(): Path {
        Path {
            pools: vector::empty(),
            expected_out: 0,
        }
    }

    // ===== Events =====

    #[event]
    struct RoutedSwap has drop, store {
        swapper: address,
        metadata_in: address,
        metadata_out: address,
        amount_in: u64,
        direct_out: u64,
        routed_out: u64,
        hops: u64,
        improvement: u64,
        treasury_cut: u64,
        caller_received: u64,
        timestamp: u64,
    }

    #[event]
    struct TriangleClosed has drop, store {
        caller: address,
        anchor: address,
        seed: u64,
        gross_out: u64,
        profit: u64,
        treasury_cut: u64,
        caller_received: u64,
        cycle_hops: u64,
        timestamp: u64,
    }

    #[event]
    struct FlashTriangleClosed has drop, store {
        caller: address,
        anchor: address,
        borrow_pool: address,
        amount: u64,
        flash_fee: u64,
        gross_out: u64,
        profit: u64,
        treasury_cut: u64,
        caller_received: u64,
        cycle_hops: u64,
        timestamp: u64,
    }

    #[event]
    struct PathExecuted has drop, store {
        swapper: address,
        metadata_in: address,
        metadata_out: address,
        amount_in: u64,
        baseline: u64,
        actual_out: u64,
        surplus: u64,
        treasury_cut: u64,
        caller_received: u64,
        hops: u64,
        is_cycle: bool,
        timestamp: u64,
    }

    // ===== Pure helpers =====

    /// For the pool at `pool_addr`, return the "other side" asset, the
    /// direction flag, and the simulated leg output assuming `current`
    /// is the input asset and `amount_in_left` is the amount entering
    /// the leg. If the pool does not contain `current`, returns
    /// `leg_out = 0` — caller detects and skips.
    fun simulate_leg(
        pool_addr: address,
        current: address,
        amount_in_left: u64,
    ): (address, bool, u64) {
        let (ma, mb) = pool::pool_tokens(pool_addr);
        let ma_addr = object::object_address(&ma);
        let mb_addr = object::object_address(&mb);
        let (ra, rb) = pool::reserves(pool_addr);
        if (ma_addr == current) {
            (mb_addr, true, pool::compute_amount_out(ra, rb, amount_in_left))
        } else if (mb_addr == current) {
            (ma_addr, false, pool::compute_amount_out(rb, ra, amount_in_left))
        } else {
            (@0x0, false, 0)
        }
    }

    /// Given a pool and the current input asset, return the "other
    /// side" asset (what comes out of the pool). `@0x0` if the pool
    /// does not contain `current`.
    fun asset_after_leg(pool_addr: address, current: address): address {
        let (ma, mb) = pool::pool_tokens(pool_addr);
        let ma_addr = object::object_address(&ma);
        let mb_addr = object::object_address(&mb);
        if (ma_addr == current) {
            mb_addr
        } else if (mb_addr == current) {
            ma_addr
        } else {
            @0x0
        }
    }

    /// Walk `pool_path` from `start` asset and return the final
    /// asset the path ends at. Returns `@0x0` if any pool in the
    /// sequence does not contain the current-side asset.
    fun trace_path_end(pool_path: &vector<address>, start: address): address {
        let current = start;
        let n = vector::length(pool_path);
        let i = 0;
        while (i < n) {
            let pool_addr = *vector::borrow(pool_path, i);
            current = asset_after_leg(pool_addr, current);
            if (current == @0x0) return @0x0;
            i = i + 1;
        };
        current
    }

    /// Look up the direct `from` → `to` pool via the factory's
    /// deterministic canonical address derivation (O(1), no
    /// pagination scan) and return its simulated output for
    /// `amount_in`. Returns 0 if no pool exists at the derived
    /// address — caller interprets as "no baseline, no service
    /// charge applied".
    ///
    /// This avoids the pagination-miss bug where a reverse-index
    /// scan bounded by `PAGE` could fail to surface a direct pool
    /// parked at index ≥ PAGE and cause the service charge to be
    /// incorrectly skipped.
    fun compute_direct_baseline(
        from: address,
        to: address,
        amount_in: u64,
    ): u64 {
        if (from == to) return 0;
        let canonical = pool_factory::canonical_pool_address_of(from, to);
        if (!pool::pool_exists(canonical)) return 0;
        let (_, _, leg_out) = simulate_leg(canonical, from, amount_in);
        leg_out
    }

    /// Copy `path_pools` and append one more leg.
    fun push_leg(
        path_pools: &vector<address>,
        pool_addr: address,
    ): vector<address> {
        let new_pools = *path_pools;
        vector::push_back(&mut new_pools, pool_addr);
        new_pools
    }

    // ===== Search: linear A → B path =====

    /// Find the best path from `from` to `to` carrying `amount_in`.
    /// DFS up to MAX_HOPS deep, pruning revisited assets and pools.
    /// Bounded by `DFS_VISIT_BUDGET` — once exhausted the search
    /// stops and returns the best path found so far. Empty Path if
    /// no path reaches `to` within the budget.
    fun find_best_path(
        from: address,
        to: address,
        amount_in: u64,
    ): Path {
        let best = empty_path();
        let visited = vector::empty<address>();
        vector::push_back(&mut visited, from);
        let pools = vector::empty<address>();
        let budget = DFS_VISIT_BUDGET;
        dfs_path(from, to, amount_in, &pools, &visited, &mut best, &mut budget);
        best
    }

    fun dfs_path(
        current: address,
        target: address,
        amount_in_left: u64,
        path_pools: &vector<address>,
        visited: &vector<address>,
        best: &mut Path,
        budget: &mut u64,
    ) {
        let depth = vector::length(path_pools);
        if (depth >= MAX_HOPS || *budget == 0) return;

        // Lazy-paginated iteration over sister pools. Fetches one
        // PAGE at a time and only requests the next page if budget
        // remains. This bounds total fetch + allocation cost to
        // O(PAGE × max_pages_touched_before_budget_exhausts), which
        // is tightly coupled to the DFS budget — an attacker with N
        // junk pools cannot force the search to allocate an
        // N-element vector upfront. Fixes the `fetch_all_sister_pools`
        // DoS vector flagged by Gemini R2 HIGH-1.
        let offset = 0;
        let exhausted = false;
        while (!exhausted && *budget > 0) {
            let batch = pool_factory::pools_containing_asset(current, offset, PAGE);
            let batch_n = vector::length(&batch);
            if (batch_n == 0) {
                exhausted = true;
            } else {
                let i = 0;
                while (i < batch_n && *budget > 0) {
                    *budget = *budget - 1;
                    let pool_addr = *vector::borrow(&batch, i);
                    if (!vector::contains(path_pools, &pool_addr)) {
                        let (other, _a_to_b, leg_out) =
                            simulate_leg(pool_addr, current, amount_in_left);
                        if (leg_out > 0) {
                            if (other == target) {
                                if (leg_out > best.expected_out) {
                                    let new_pools = push_leg(path_pools, pool_addr);
                                    best.pools = new_pools;
                                    best.expected_out = leg_out;
                                };
                            } else if (!vector::contains(visited, &other)) {
                                let new_pools = push_leg(path_pools, pool_addr);
                                let new_visited = *visited;
                                vector::push_back(&mut new_visited, other);
                                dfs_path(
                                    other,
                                    target,
                                    leg_out,
                                    &new_pools,
                                    &new_visited,
                                    best,
                                    budget,
                                );
                            };
                        };
                    };
                    i = i + 1;
                };
                if (batch_n < PAGE) {
                    exhausted = true;
                } else {
                    offset = offset + batch_n;
                };
            };
        };
    }

    // ===== Search: closed cycle A → ... → A =====

    /// Find the best cycle closed at `anchor` carrying `seed_amount`
    /// of anchor through it. Cycle length in [3, MAX_CYCLE_LEN].
    /// `exclude_pool` is skipped entirely from candidates — pass
    /// `@0x0` for no exclusion, or a flash-borrow source address to
    /// prevent its reuse as a cycle leg (that pool is locked during
    /// flash and cannot host a swap).
    ///
    /// Wraps `find_best_cycle_internal` with a fresh DFS visit budget.
    /// Callers that want to share a budget across multiple cycle
    /// searches (e.g., `find_best_flash_triangle` iterating over
    /// borrow candidates) should call `_internal` directly with
    /// their own `&mut u64`.
    fun find_best_cycle(
        anchor: address,
        seed_amount: u64,
        exclude_pool: address,
    ): Path {
        let budget = DFS_VISIT_BUDGET;
        find_best_cycle_internal(anchor, seed_amount, exclude_pool, &mut budget)
    }

    fun find_best_cycle_internal(
        anchor: address,
        seed_amount: u64,
        exclude_pool: address,
        budget: &mut u64,
    ): Path {
        let best = empty_path();
        let visited = vector::empty<address>();
        vector::push_back(&mut visited, anchor);
        let pools = vector::empty<address>();
        dfs_cycle(
            anchor,
            anchor,
            seed_amount,
            exclude_pool,
            &pools,
            &visited,
            &mut best,
            budget,
        );
        best
    }

    fun dfs_cycle(
        current: address,
        anchor: address,
        amount_in_left: u64,
        exclude_pool: address,
        path_pools: &vector<address>,
        visited: &vector<address>,
        best: &mut Path,
        budget: &mut u64,
    ) {
        let depth = vector::length(path_pools);
        if (depth >= MAX_CYCLE_LEN || *budget == 0) return;

        // Lazy-paginated iteration — same pattern as `dfs_path`,
        // bounds fetch cost to the DFS budget.
        let offset = 0;
        let exhausted = false;
        while (!exhausted && *budget > 0) {
            let batch = pool_factory::pools_containing_asset(current, offset, PAGE);
            let batch_n = vector::length(&batch);
            if (batch_n == 0) {
                exhausted = true;
            } else {
                let i = 0;
                while (i < batch_n && *budget > 0) {
                    *budget = *budget - 1;
                    let pool_addr = *vector::borrow(&batch, i);
                    if (pool_addr != exclude_pool
                        && !vector::contains(path_pools, &pool_addr)) {
                        let (other, _a_to_b, leg_out) =
                            simulate_leg(pool_addr, current, amount_in_left);
                        if (leg_out > 0) {
                            if (other == anchor) {
                                // Closing leg — accept only if cycle has ≥ 3 legs.
                                if (depth + 1 >= 3 && leg_out > best.expected_out) {
                                    let new_pools = push_leg(path_pools, pool_addr);
                                    best.pools = new_pools;
                                    best.expected_out = leg_out;
                                };
                            } else if (!vector::contains(visited, &other)) {
                                let new_pools = push_leg(path_pools, pool_addr);
                                let new_visited = *visited;
                                vector::push_back(&mut new_visited, other);
                                dfs_cycle(
                                    other,
                                    anchor,
                                    leg_out,
                                    exclude_pool,
                                    &new_pools,
                                    &new_visited,
                                    best,
                                    budget,
                                );
                            };
                        };
                    };
                    i = i + 1;
                };
                if (batch_n < PAGE) {
                    exhausted = true;
                } else {
                    offset = offset + batch_n;
                };
            };
        };
    }

    // ===== Search: flash-triangle topology =====

    /// Iterate every pool containing `anchor` as a flash-borrow
    /// candidate; for each, verify the pool has enough anchor-side
    /// reserve to lend `amount`, then run a cycle search excluding
    /// that pool from cycle legs. Return the (borrow_pool, cycle)
    /// tuple with the highest net profit. `borrow_pool == @0x0`
    /// signals no valid topology — either the ecosystem lacks a
    /// disjoint pool, every candidate has insufficient reserve, or
    /// every candidate yields a loss after the flash fee.
    ///
    /// The reserve check mirrors `pool::flash_borrow`'s strict
    /// `amount < reserve_in` so unviable borrow sources fail fast
    /// at discovery instead of aborting mid-execution with an
    /// opaque `E_INSUFFICIENT_LIQUIDITY`.
    ///
    /// **Shared DFS visit budget.** The single `DFS_VISIT_BUDGET`
    /// is drawn down across ALL per-candidate cycle searches via
    /// `find_best_cycle_internal`. Without sharing, an attacker
    /// spawning many junk pools containing `anchor` would
    /// multiply the worst-case simulate_leg count by the candidate
    /// count, re-introducing gas-griefing DoS even with per-search
    /// DFS budgets. With shared budget, total work is bounded at
    /// O(DFS_VISIT_BUDGET) regardless of candidate count. The
    /// trade-off is that early-iteration candidates with
    /// unproductive DFS can starve later candidates of budget; in
    /// legitimate ecosystems the per-candidate cost is modest and
    /// the shared budget distributes naturally.
    fun find_best_flash_triangle(
        anchor: address,
        amount: u64,
    ): FlashTriangle {
        let best = FlashTriangle {
            borrow_pool: @0x0,
            cycle: empty_path(),
        };
        let best_net: u64 = 0;

        let flash_fee = pool::compute_flash_fee(amount);
        let required = amount + flash_fee;

        // Single budget shared across every cycle search.
        let budget = DFS_VISIT_BUDGET;

        // Lazy-paginated iteration over borrow candidates — same
        // pattern as `dfs_path` / `dfs_cycle`. Without this, a
        // densely-spammed `asset_index[anchor]` would force an
        // upfront allocation of the full bucket regardless of
        // budget, re-introducing the griefing surface fixed for
        // the DFS layer.
        //
        // Budget is decremented per outer-loop iteration BEFORE the
        // liquidity pre-check, so junk pools that fail the reserve
        // check still consume budget. Without this, an attacker
        // seeding many minimum-liquidity pools paired with the
        // anchor could force unbounded storage reads in the outer
        // loop (pool_tokens + reserves per candidate) even when no
        // `find_best_cycle_internal` call ever executes to draw
        // down budget. Fixes Claude R3 MEDIUM-1.
        let offset = 0;
        let exhausted = false;
        while (!exhausted && budget > 0) {
            let batch = pool_factory::pools_containing_asset(anchor, offset, PAGE);
            let batch_n = vector::length(&batch);
            if (batch_n == 0) {
                exhausted = true;
            } else {
                let i = 0;
                while (i < batch_n && budget > 0) {
                    budget = budget - 1;
                    let borrow_pool = *vector::borrow(&batch, i);

                    // Liquidity pre-check: does this pool actually
                    // have enough anchor to lend `amount`? Mirrors
                    // `pool::flash_borrow`'s strict check. Defensive
                    // `else if` on the b-side guards against a
                    // hypothetical factory bug that would allow an
                    // asset_index entry to reference a pool not
                    // actually containing the anchor.
                    let (ma, mb) = pool::pool_tokens(borrow_pool);
                    let ma_addr = object::object_address(&ma);
                    let mb_addr = object::object_address(&mb);
                    let (ra, rb) = pool::reserves(borrow_pool);
                    let anchor_reserve = if (anchor == ma_addr) {
                        ra
                    } else if (anchor == mb_addr) {
                        rb
                    } else {
                        0
                    };

                    if (anchor_reserve > amount) {
                        let cycle = find_best_cycle_internal(
                            anchor,
                            amount,
                            borrow_pool,
                            &mut budget,
                        );
                        if (cycle.expected_out > required) {
                            let net = cycle.expected_out - required;
                            if (net > best_net) {
                                best_net = net;
                                best.borrow_pool = borrow_pool;
                                best.cycle = cycle;
                            };
                        };
                    };
                    i = i + 1;
                };
                if (batch_n < PAGE) {
                    exhausted = true;
                } else {
                    offset = offset + batch_n;
                };
            };
        };
        best
    }

    // ===== Execution (internal) =====

    /// Chain-execute a pool sequence: each leg feeds its output into
    /// the next leg's input. Direction is inferred automatically by
    /// `pool::swap` from the FA's metadata. Per-leg `min_out = 0`;
    /// the overall output check is enforced by the caller.
    fun execute_pool_list(
        swapper: address,
        pool_path: &vector<address>,
        fa_in: FungibleAsset,
    ): FungibleAsset {
        let fa = fa_in;
        let n = vector::length(pool_path);
        let i = 0;
        while (i < n) {
            let pool_addr = *vector::borrow(pool_path, i);
            fa = pool::swap(pool_addr, swapper, fa, 0);
            i = i + 1;
        };
        fa
    }

    fun execute_path(
        swapper: address,
        path: &Path,
        fa_in: FungibleAsset,
    ): FungibleAsset {
        execute_pool_list(swapper, &path.pools, fa_in)
    }

    // ===== Composable: raw pool-path execution (no treasury cut) =====

    /// Execute a pre-computed multi-hop path through the specified
    /// pools. Each leg pays its 1 bps LP fee via `pool::swap`.
    /// Direction at each leg is inferred from the FA's metadata —
    /// the caller provides only the pool sequence.
    ///
    /// Service charge rule (applied uniformly across the module): if
    /// the execution produces output exceeding its baseline, 10% of
    /// the surplus goes to treasury. Baseline is computed as:
    ///
    ///   • Cycle (end_asset == start_asset): baseline = amount_in.
    ///     Surplus is the cycle profit.
    ///   • Linear (end_asset != start_asset): baseline = direct pool
    ///     output for (start, end) if such a pool exists; otherwise
    ///     baseline = 0. Surplus is the improvement over the direct
    ///     hop.
    ///
    /// If `output <= baseline` (no value added) the charge is zero —
    /// the caller receives the full output. If no direct pool exists
    /// for a linear path, baseline = 0 and the charge is also zero
    /// because there is no measurable improvement to charge against.
    public fun execute_path_compose(
        swapper: address,
        pool_path: vector<address>,
        fa_in: FungibleAsset,
        min_out: u64,
    ): FungibleAsset {
        let path_len = vector::length(&pool_path);
        assert!(path_len > 0, E_ZERO);

        // Enforce pool uniqueness in the caller-supplied path. DFS
        // paths are unique by construction, but external callers
        // (Move modules building paths programmatically) could pass
        // a sequence that visits the same pool twice, breaking the
        // simulation-to-execution determinism invariant and
        // producing unexpected reserve mutations. O(n²) in path
        // length; bounded by MAX_HOPS so max 6 comparisons.
        let i = 0;
        while (i < path_len) {
            let j = i + 1;
            while (j < path_len) {
                assert!(
                    *vector::borrow(&pool_path, i) != *vector::borrow(&pool_path, j),
                    E_WRONG_POOL,
                );
                j = j + 1;
            };
            i = i + 1;
        };

        let in_metadata_obj = fungible_asset::asset_metadata(&fa_in);
        let in_addr = object::object_address(&in_metadata_obj);
        let amount_in = fungible_asset::amount(&fa_in);
        assert!(amount_in > 0, E_ZERO);

        // Pre-pass: trace the path's end asset (validates the path
        // at the same time — any pool that doesn't host the current
        // side sets end_asset to @0x0).
        let end_asset = trace_path_end(&pool_path, in_addr);
        assert!(end_asset != @0x0, E_WRONG_POOL);

        let is_cycle = end_asset == in_addr;
        let baseline = if (is_cycle) {
            amount_in
        } else {
            compute_direct_baseline(in_addr, end_asset, amount_in)
        };

        let fa_out = execute_pool_list(swapper, &pool_path, fa_in);
        let actual_out = fungible_asset::amount(&fa_out);
        assert!(actual_out >= min_out, E_SLIPPAGE);

        let surplus = if (baseline > 0 && actual_out > baseline) {
            actual_out - baseline
        } else {
            0
        };
        let treasury_cut =
            (((surplus as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);

        if (treasury_cut > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_out, treasury_cut);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        let caller_received = fungible_asset::amount(&fa_out);

        event::emit(PathExecuted {
            swapper,
            metadata_in: in_addr,
            metadata_out: end_asset,
            amount_in,
            baseline,
            actual_out,
            surplus,
            treasury_cut,
            caller_received,
            hops: vector::length(&pool_path),
            is_cycle,
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Composable: smart-routed swap =====

    /// Smart-routed swap: find the best path from the input asset
    /// to `metadata_out` and execute it. Caller receives
    /// `actual_out - treasury_cut` as the returned FA; treasury
    /// receives 10% of the improvement over the canonical
    /// direct-hop baseline via internal deposit.
    ///
    /// The direct baseline is derived via
    /// `pool_factory::canonical_pool_address_of(in, out)` — an O(1)
    /// deterministic lookup. If no canonical direct pool exists,
    /// baseline is 0 and no service charge applies (Darbitex is not
    /// adding measurable value when it is the only available route).
    ///
    /// Aborts on slippage below `min_out`, zero input, or no route
    /// found. No deadline (entry wrapper enforces that).
    public fun swap_compose(
        swapper: address,
        metadata_out: Object<Metadata>,
        fa_in: FungibleAsset,
        min_out: u64,
    ): FungibleAsset {
        let in_metadata_obj = fungible_asset::asset_metadata(&fa_in);
        let in_addr = object::object_address(&in_metadata_obj);
        let out_addr = object::object_address(&metadata_out);
        let amount_in = fungible_asset::amount(&fa_in);
        assert!(amount_in > 0, E_ZERO);
        assert!(in_addr != out_addr, E_WRONG_POOL);

        // Canonical direct-hop baseline via deterministic address
        // derivation. If no direct pool exists, baseline = 0 and the
        // fallback path is whatever the DFS search returned.
        let direct_addr = pool_factory::canonical_pool_address_of(in_addr, out_addr);
        let direct_exists = pool::pool_exists(direct_addr);
        let direct_out = if (direct_exists) {
            let (ma, _mb) = pool::pool_tokens(direct_addr);
            let (ra, rb) = pool::reserves(direct_addr);
            let (r_in, r_out) = if (in_addr == object::object_address(&ma)) {
                (ra, rb)
            } else {
                (rb, ra)
            };
            pool::compute_amount_out(r_in, r_out, amount_in)
        } else {
            0
        };

        // Search the full graph for a better multi-hop route.
        let best = find_best_path(in_addr, out_addr, amount_in);

        // Choose the yield-maximizing option. If best DFS beats
        // direct, use it; else fall back to the direct pool path
        // (assuming the canonical direct pool exists).
        let chosen = if (best.expected_out > direct_out) {
            best
        } else if (direct_exists) {
            let pools = vector::empty<address>();
            vector::push_back(&mut pools, direct_addr);
            Path { pools, expected_out: direct_out }
        } else {
            // No direct pool, DFS found nothing. `best` is empty;
            // the non-zero check below will abort.
            best
        };

        // Reject empty-path / zero-output scenarios explicitly. The
        // combination of `expected_out > 0` and the existing slippage
        // floor catches three cases: (a) no route found at all
        // (empty path → 0), (b) dust-size input where final leg
        // produces 0 output, (c) standard slippage below `min_out`.
        // Prevents silent no-op where `min_out = 0` callers would
        // otherwise receive their input FA back unchanged with an
        // event misattributing the swap as succeeded.
        assert!(chosen.expected_out > 0, E_SLIPPAGE);
        assert!(chosen.expected_out >= min_out, E_SLIPPAGE);

        let fa_out = execute_path(swapper, &chosen, fa_in);
        let actual_out = fungible_asset::amount(&fa_out);
        assert!(actual_out >= min_out, E_SLIPPAGE);

        // Service charge applies only when a canonical direct pool
        // EXISTS as a baseline. If no direct pool exists (`direct_out
        // == 0`), Darbitex is the only available route — philosophy
        // rule "no baseline = no charge" kicks in. This guard must
        // match `execute_path_compose`'s `baseline > 0 && ...` check
        // for uniform behavior across the compose layer; without it,
        // zero-baseline scenarios would silently tax 10% of the full
        // swap output.
        let improvement = if (direct_out > 0 && actual_out > direct_out) {
            actual_out - direct_out
        } else {
            0
        };
        let treasury_cut =
            (((improvement as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);

        if (treasury_cut > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_out, treasury_cut);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        let caller_received = fungible_asset::amount(&fa_out);

        event::emit(RoutedSwap {
            swapper,
            metadata_in: in_addr,
            metadata_out: out_addr,
            amount_in,
            direct_out,
            routed_out: actual_out,
            hops: vector::length(&chosen.pools),
            improvement,
            treasury_cut,
            caller_received,
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Composable: real-capital cycle closure =====

    /// Close a triangular cycle using the provided `fa_seed` as
    /// capital. The anchor asset is inferred from the seed's
    /// metadata. Module searches for the best cycle of length ≥ 3
    /// that starts and ends at the anchor, executes it, and splits
    /// gross profit 10% to treasury (deposited internally) / 90% to
    /// caller (returned as FA).
    ///
    /// `min_net_profit` is the caller's minimum take-home AFTER the
    /// treasury cut — not the gross profit. If no cycle clears this
    /// floor, the TX aborts and the seed returns via rollback.
    public fun close_triangle_compose(
        caller: address,
        fa_seed: FungibleAsset,
        min_net_profit: u64,
    ): FungibleAsset {
        let anchor_metadata_obj = fungible_asset::asset_metadata(&fa_seed);
        let anchor_addr = object::object_address(&anchor_metadata_obj);
        let seed_amount = fungible_asset::amount(&fa_seed);
        assert!(seed_amount > 0, E_ZERO);

        let cycle = find_best_cycle(anchor_addr, seed_amount, @0x0);
        assert!(cycle.expected_out > 0, E_NO_CYCLE);

        // Pre-check using simulated cycle output. The net caller cut
        // after treasury split must meet the floor.
        assert!(cycle.expected_out >= seed_amount, E_MIN_PROFIT);
        let expected_gross = cycle.expected_out - seed_amount;
        let expected_treasury =
            (((expected_gross as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);
        let expected_net = expected_gross - expected_treasury;
        assert!(expected_net >= min_net_profit, E_MIN_PROFIT);

        let fa_out = execute_path(caller, &cycle, fa_seed);
        let actual_out = fungible_asset::amount(&fa_out);

        // Post-execution sanity: deterministic integer math implies
        // actual_out == cycle.expected_out, but re-verifying the
        // invariant here is a cheap safety net against future
        // refactors of the simulation / execution paths.
        assert!(actual_out >= seed_amount, E_MIN_PROFIT);
        let profit = actual_out - seed_amount;
        let treasury_cut =
            (((profit as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);
        let net_to_caller = profit - treasury_cut;
        assert!(net_to_caller >= min_net_profit, E_MIN_PROFIT);

        if (treasury_cut > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_out, treasury_cut);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        let caller_received = fungible_asset::amount(&fa_out);

        event::emit(TriangleClosed {
            caller,
            anchor: anchor_addr,
            seed: seed_amount,
            gross_out: actual_out,
            profit,
            treasury_cut,
            caller_received,
            cycle_hops: vector::length(&cycle.pools),
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Composable: flash-loan cycle closure (zero capital) =====

    /// Zero-capital cycle closure via internal flash loan. Module
    /// finds a (borrow_pool, cycle) topology where the borrow pool
    /// is disjoint from cycle legs, flash-borrows `amount` of
    /// `anchor_metadata` from the borrow pool, executes the cycle,
    /// repays the flash, and returns the caller's profit share as
    /// the returned FA. Treasury 10% is deposited internally.
    ///
    /// `min_net_profit` is the caller's minimum take-home AFTER the
    /// treasury cut and the flash-loan repayment (principal + flash
    /// fee) — not the gross cycle output.
    ///
    /// Returns a FA whose amount is the caller's net share (the
    /// principal + flash fee have already been repaid to the borrow
    /// pool before return).
    ///
    /// This path requires an ecosystem with at least one pool that
    /// contains the anchor AND is disjoint from the cycle. For a
    /// 3-pool canonical ecosystem where every pool is in the cycle
    /// the search returns no topology and the function aborts with
    /// `E_NO_CYCLE`; a 4+ pool ecosystem (e.g., adding APT/stAPT
    /// or APT/USD1 alongside the core three) activates it.
    public fun close_triangle_flash_compose(
        caller: address,
        anchor_metadata: Object<Metadata>,
        amount: u64,
        min_net_profit: u64,
    ): FungibleAsset {
        assert!(amount > 0, E_ZERO);
        let anchor_addr = object::object_address(&anchor_metadata);

        let flash = find_best_flash_triangle(anchor_addr, amount);
        assert!(flash.borrow_pool != @0x0, E_NO_CYCLE);

        let flash_fee = pool::compute_flash_fee(amount);
        let required = amount + flash_fee;

        // Pre-check: net caller take-home after flash repay + treasury
        // cut must meet the floor.
        assert!(flash.cycle.expected_out >= required, E_MIN_PROFIT);
        let expected_gross = flash.cycle.expected_out - required;
        let expected_treasury =
            (((expected_gross as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);
        let expected_net = expected_gross - expected_treasury;
        assert!(expected_net >= min_net_profit, E_MIN_PROFIT);

        // Flash-borrow the anchor. The hot-potato FlashReceipt must
        // be consumed by flash_repay before this function returns —
        // the Move type system enforces this statically.
        let (fa_borrowed, receipt) =
            pool::flash_borrow(flash.borrow_pool, anchor_metadata, amount);

        let fa_out = execute_path(caller, &flash.cycle, fa_borrowed);
        let actual_out = fungible_asset::amount(&fa_out);

        // Post-execution sanity. Deterministic math implies
        // actual_out == flash.cycle.expected_out; the re-check guards
        // against future refactors and keeps the repay extract safe.
        assert!(actual_out >= required, E_MIN_PROFIT);

        // Split the cycle output: repayment to the flash source,
        // profit to caller + treasury.
        let fa_repay = fungible_asset::extract(&mut fa_out, required);
        pool::flash_repay(flash.borrow_pool, fa_repay, receipt);

        let profit = actual_out - required;
        let treasury_cut =
            (((profit as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);
        let net_to_caller = profit - treasury_cut;
        assert!(net_to_caller >= min_net_profit, E_MIN_PROFIT);

        if (treasury_cut > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_out, treasury_cut);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        let caller_received = fungible_asset::amount(&fa_out);

        event::emit(FlashTriangleClosed {
            caller,
            anchor: anchor_addr,
            borrow_pool: flash.borrow_pool,
            amount,
            flash_fee,
            gross_out: actual_out,
            profit,
            treasury_cut,
            caller_received,
            cycle_hops: vector::length(&flash.cycle.pools),
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Entry wrappers =====

    /// Smart-routed swap from a user's primary store. Thin wrapper
    /// around `swap_compose` with deadline + store integration.
    /// Takes `metadata_in` / `metadata_out` directly — the canonical
    /// direct pool is derived internally, no pool address needed
    /// from the caller.
    public entry fun swap_entry(
        user: &signer,
        metadata_in: Object<Metadata>,
        metadata_out: Object<Metadata>,
        amount_in: u64,
        min_out: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let user_addr = signer::address_of(user);
        let fa_in = primary_fungible_store::withdraw(user, metadata_in, amount_in);
        let fa_out = swap_compose(user_addr, metadata_out, fa_in, min_out);
        primary_fungible_store::deposit(user_addr, fa_out);
    }

    /// Real-capital cycle closure from a caller's primary store.
    /// `min_net_profit` is the caller's take-home floor AFTER the
    /// 10% treasury cut, not gross.
    public entry fun close_triangle(
        caller: &signer,
        anchor_metadata: Object<Metadata>,
        seed_amount: u64,
        min_net_profit: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let caller_addr = signer::address_of(caller);
        let fa_seed = primary_fungible_store::withdraw(caller, anchor_metadata, seed_amount);
        let fa_out = close_triangle_compose(caller_addr, fa_seed, min_net_profit);
        primary_fungible_store::deposit(caller_addr, fa_out);
    }

    /// Zero-capital flash cycle closure. Caller pays only gas;
    /// profit is deposited to their primary store. `min_net_profit`
    /// is the caller's take-home floor AFTER flash repay and the
    /// 10% treasury cut.
    public entry fun close_triangle_flash(
        caller: &signer,
        anchor_metadata: Object<Metadata>,
        amount: u64,
        min_net_profit: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let caller_addr = signer::address_of(caller);
        let fa_out = close_triangle_flash_compose(caller_addr, anchor_metadata, amount, min_net_profit);
        primary_fungible_store::deposit(caller_addr, fa_out);
    }

    // ===== Quote views (off-chain path discovery) =====

    // Quote the best linear path from `from` to `to` carrying
    // `amount_in`. Returns (pools, expected_out) of the
    // yield-maximizing path up to MAX_HOPS. expected_out = 0 means
    // no path exists.
    #[view]
    public fun quote_best_path(
        from: address,
        to: address,
        amount_in: u64,
    ): (vector<address>, u64) {
        let best = find_best_path(from, to, amount_in);
        (best.pools, best.expected_out)
    }

    // Quote the best closed cycle at `anchor` carrying `seed_amount`.
    // Returns (pools, expected_out) of the cycle with the highest
    // gross output. expected_out = 0 means no cycle exists.
    #[view]
    public fun quote_best_cycle(
        anchor: address,
        seed_amount: u64,
    ): (vector<address>, u64) {
        let best = find_best_cycle(anchor, seed_amount, @0x0);
        (best.pools, best.expected_out)
    }

    // Quote the best flash-triangle topology at `anchor` for a
    // borrow of `amount`. Returns (borrow_pool, pools,
    // expected_out). borrow_pool == @0x0 means no valid topology
    // was found.
    #[view]
    public fun quote_best_flash_triangle(
        anchor: address,
        amount: u64,
    ): (address, vector<address>, u64) {
        let flash = find_best_flash_triangle(anchor, amount);
        (
            flash.borrow_pool,
            flash.cycle.pools,
            flash.cycle.expected_out,
        )
    }

    // Quote an arbitrary pre-computed path: simulate feeding
    // `amount_in` of `from` through each pool in `pool_path`
    // sequentially, returning the final output. Returns 0 if the
    // path is invalid (a pool in the sequence does not contain the
    // current asset).
    #[view]
    public fun quote_path(
        pool_path: vector<address>,
        from: address,
        amount_in: u64,
    ): u64 {
        let current = from;
        let amt = amount_in;
        let n = vector::length(&pool_path);
        let i = 0;
        while (i < n) {
            let pool_addr = *vector::borrow(&pool_path, i);
            let (other, _, leg_out) = simulate_leg(pool_addr, current, amt);
            if (leg_out == 0) return 0;
            current = other;
            amt = leg_out;
            i = i + 1;
        };
        amt
    }
}
```

---

**End of audit package.**

Please respond with your review in the format described in Section 1. Thank you.
