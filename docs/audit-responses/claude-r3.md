# Claude (fresh web) R3 — Darbitex Final

**Auditor:** Claude Opus 4.6 extended (Anthropic web, fresh session)
**Code reviewed:** R2.2 submission (post-R1 fix batch + R1.5 hotfix + R2.1 + R2.2)
**Verdict:** 🟢 GREEN — conditional on MEDIUM-1 fix (one-line change)

---

## Findings

### HIGH: none

### MEDIUM-1: `find_best_flash_triangle` outer-loop candidate iteration not budget-bounded
- **Location:** `arbitrage.move` `find_best_flash_triangle`, ~lines 515-580
- **Description:** R2.2 lazy pagination in `dfs_path` / `dfs_cycle` correctly decrements budget per candidate. But in `find_best_flash_triangle`'s outer loop, budget is only consumed inside `find_best_cycle_internal`, which is only reached when `anchor_reserve > amount`. If a candidate fails this liquidity pre-check, no budget is consumed, loop advances, next page fetched. An attacker creating ~2000-5000 minimum-liquidity pools containing a hub asset (APT) with tiny reserves can force the outer loop to iterate through the entire bucket doing O(N) storage reads (pool_tokens + reserves per candidate) before reaching the DFS layer. Same class as Gemini R2 HIGH-1 but at lower severity.
- **Impact:** Gas-griefing DoS on `close_triangle_flash` and `quote_best_flash_triangle`. Dormant at 3-pool launch but activates with ecosystem growth.
- **Recommended fix:** Decrement budget at the top of the outer loop, matching `dfs_path` / `dfs_cycle` pattern.

### LOW-1: Stale "before/after callback" comment in pool.move
- **Location:** pool.move line ~750
- **Description:** Comment says "fires the before/after callback path" referencing abandoned architecture. R2.1 INFO-1 fixed the module header + swap_compose docstring, missed this comment.
- **Impact:** Developer confusion only.
- **Recommended fix:** Replace with language consistent with cleaned-up header.

### LOW-2: `execute_path_compose` accepts arbitrarily long caller paths
- **Location:** `execute_path_compose`
- **Description:** O(n²) duplicate check bounded by path length but no upper cap. Caller can pass 100-pool path → 10,000 comparisons.
- **Recommended fix:** `assert!(path_len <= MAX_CYCLE_LEN, E_WRONG_POOL)` (optional).
- **Status:** Not applied — preserves "raw primitive, caller sovereignty" philosophy (OQ-6).

### INFORMATIONAL-1: budget variable shadowing note
Cosmetic naming inconsistency. No action.

### INFORMATIONAL-2: surplus arithmetic u64 overflow threshold
Notes potential overflow for 180B+ APT surplus in single swap. Considered low-priority by Claude. Later flagged MEDIUM by Kimi R3 — applied as Kimi MED-1 fix.

---

## R2.1 + R2.2 delta verification

### ✅ R2.1 Zero-Baseline Guard — VERIFIED
`swap_compose` improvement formula correctly matches `execute_path_compose` pattern. "No baseline = no charge" philosophy consistently applied.

### ✅ R2.2 Lazy Pagination dfs_path / dfs_cycle — VERIFIED
All 5 verification points pass: budget decrement per candidate, no upfront allocation, termination conditions sound, offset arithmetic safe, budget propagation through recursion correct.

### ⚠️ R2.2 Lazy Pagination find_best_flash_triangle — PARTIALLY VERIFIED
Pattern correct but outer-loop candidate overhead (pool_tokens + reserves reads) not budget-bounded — MEDIUM-1 above.

### ✅ R1.5 fixes — VERIFIED (no regression)
MED-1 silent no-op abort + MED-2 shared budget refactor both correctly implemented.

### ✅ R1 fixes — VERIFIED (no regression)
Canonicalize, E_SAME_TOKEN removal, directions field removal, duplicate-pool check, DFS visit budget, design.md deprecation all present and correct.

---

## Praise section
1. Shared DFS budget architecture (R1.5 MED-2 self-catch)
2. `canonical_pool_address_of` for O(1) baseline (M-3 fix)
3. Lazy pagination pattern clean and readable
4. `min_net_profit` semantic rename + dual pre/post check
5. `assert!(chosen.expected_out > 0, E_SLIPPAGE)` silent-no-op fix
6. Pool uniqueness check in `execute_path_compose`
7. Flash loan reserve model (reserves unchanged, fee to accumulator)
8. First-mover honesty section (§7a)

---

## Overall verdict
**🟢 GREEN — conditional on MEDIUM-1 fix.** One-line change, no structural impact. After applying it, the codebase has no blocking issues for mainnet publish.
