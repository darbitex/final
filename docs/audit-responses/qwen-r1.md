# Qwen R1 — Darbitex Final

**Auditor:** Qwen (Alibaba, fresh web session)
**Code reviewed:** R1 submission
**Verdict:** 🟡 YELLOW (conditional)

---

## Findings

### HIGH: none

### MEDIUM-1: DFS Gas Scalability via Redundant Vector Allocations
- **Location:** `arbitrage.move` (`fetch_all_sister_pools` called within `dfs_path` / `dfs_cycle`)
- **Description:** DFS calls `fetch_all_sister_pools` at every recursion depth, constructing a new vector by copying pool addresses each invocation. For asset in N pools, complexity proportional to paths visited × O(N) copy. For 30 pools at depth 3, >27_000 vector copies = prohibitive gas.
- **Impact:** Arbitrage layer may become unusable at >15 pools per asset. Blocks unbounded growth principle medium-term.
- **Recommended fix:** (a) Refactor DFS to accept reference to fetched candidate list, or use index-based iteration. (b) Implement soft runtime budget (node visit limit).

### LOW-1: swap_compose Baseline Gaming via User-Provided direct_pool
- **Location:** `arbitrage.move` (swap_compose)
- **Description:** Caller passing a pool with zero reserves / extreme slippage causes `direct_out = 0`, full output counted as "improvement", 10% cut on entire swap.
- **Impact:** Self-harm UX footgun. Not protocol exploit.
- **Recommended fix:** Canonicalize via `canonical_pool_address_of` (already implemented).

### LOW-2: Dead E_SAME_TOKEN Assert in pool::create_pool
- **Location:** `pool.move` (create_pool)
- **Description:** `create_pool` asserts `metadata_a != metadata_b` with `E_SAME_TOKEN`. But it's `public(friend)`, only callable by factory which already calls `assert_sorted` (strict `<` rejects same-token). **Unreachable dead code.**
- **Impact:** No security. Bytecode clutter.
- **Recommended fix:** Remove unreachable assert and `E_SAME_TOKEN` constant from pool.move (consistent with factory fix already applied).

### INFORMATIONAL-1: min_out = 0 in Intermediate Legs
- Standard multi-hop design. Final check enforced at caller level. May waste gas on zero-yield legs. No action required.

### INFORMATIONAL-2: swap_entry UX Footgun
- User-provided `pool_addr` can be non-existent or adversarial. See OQ-4. Recommended: canonicalize.

---

## Q1-Q7 answers
All verified sound. Highlights:

- **Q1:** DFS correct. `exclude_pool` at every depth. `find_best_flash_triangle` sees all candidates via `fetch_all_sister_pools`. Bottleneck is gas, not logic.
- **Q2:** `actual_out == expected_out` guaranteed. Post-checks redundant but load-bearing safety.
- **Q3:** Cycle detection correct. `compute_direct_baseline` O(1) via canonical lookup.
- **Q4:** Flash-triangle safe. Hot-potato + atomic revert on abort.
- **Q5:** FA-in/FA-out correct. No authorization gaps.
- **Q6:** Hot-potato handling correct.
- **Q7:** Pool delta preserves all invariants.

---

## OQ answers
- **OQ-1:** Current implementation risky for gas. Implement budget or optimize vectors.
- **OQ-2:** Canonicalize `direct_pool` to prevent user error.
- **OQ-3:** 4/5 reasonable.
- **OQ-4:** Yes, canonicalize `pool_addr`.
- **OQ-5:** Keep pre-pass (better error codes).
- **OQ-6:** Allow sub-optimal execution.
- **OQ-7:** Accept spoofing.

---

## Praise section
- **Reserve-unchanged flash model** — "excellent" simplification of k-invariant check
- **Uniform service charge** — "robust economic design, prevents fee avoidance"
- **Hot potato pattern** — "correct usage"
- **Deterministic math** — "u256 intermediates prevent sandwich attacks within the module"

---

## Overall verdict
**🟡 YELLOW** (conditional)

Core AMM and arbitrage logic secure. YELLOW due to MEDIUM-1 (gas scalability). Blocks unbounded growth principle in medium term. To reach GREEN:
1. Refactor DFS vector handling or implement gas budget
2. Remove dead E_SAME_TOKEN in pool.move
3. Canonicalize baselines in swap_compose/swap_entry

Launch starts with 3 pools where gas is negligible, but technical debt must be addressed.
