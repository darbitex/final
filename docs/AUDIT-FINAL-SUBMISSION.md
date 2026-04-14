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

## 11. Full source code

The following files constitute the complete audit scope.

1. `Move.toml`
2. `sources/pool.move`
3. `sources/pool_factory.move`
4. `sources/arbitrage.move`

`tests.move` is a stub, out of scope.

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

### 11.2 pool.move

See file: `/home/rera/darbitex-final/sources/pool.move` (807 lines)

### 11.3 pool_factory.move

See file: `/home/rera/darbitex-final/sources/pool_factory.move` (198 lines)

### 11.4 arbitrage.move

See file: `/home/rera/darbitex-final/sources/arbitrage.move` (973 lines)

---

**Commit reference:** current working tree at `/home/rera/darbitex-final/` — no git history yet, this is the pre-commit audit baseline. Post-audit, findings-addressed version will be committed as the round-1 submission hash.

**Maintainer contact:** Rera (project owner), Claude Opus 4.6 (in-session developer + R1 self-audit).
