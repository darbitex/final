# Kimi R3 — Darbitex Final

**Auditor:** Kimi K2 (Moonshot AI, fresh web session)
**Code reviewed:** R2.2 submission
**Verdict:** 🟡 YELLOW → 🟢 GREEN after MEDIUM-1 fix applied

---

## Findings

### HIGH: none

### MEDIUM-1: Integer Overflow in Treasury Cut Calculation (NEW — first auditor to catch)
- **Location:** `arbitrage.move` — `swap_compose`, `execute_path_compose`, `close_triangle_compose`, `close_triangle_flash_compose` (6 sites)
- **Description:** `treasury_cut = surplus * TREASURY_BPS / TOTAL_BPS` performs u64 multiplication before division. If `surplus > u64::MAX / 1_000 ≈ 1.84 × 10^16`, intermediate multiplication overflows and aborts.
- **Threshold examples:**
  - 8-decimal APT: 184 million APT per swap — reachable in whale trades in mature ecosystem
  - 6-decimal USDC: 18.4 billion USDC per swap — very high but theoretical
- **Impact:** Legitimate high-value arbitrage transactions could abort unexpectedly. Overflow occurs in intermediate result before division reduces to safe value.
- **Recommended fix:** `((surplus as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64` — matches pattern already used in pool.move accumulator math.
- **Status:** ✅ Fix applied across all 6 sites.

### LOW: none

### INFORMATIONAL-1: Vector contains O(n) in DFS loops
Bounded by small constants (MAX_HOPS=4, MAX_CYCLE_LEN=5, DFS_VISIT_BUDGET=256). Negligible overhead. No action.

---

## Delta Verification

### ✅ R2.1 swap_compose zero-baseline guard — CORRECTLY FIXED
"The earlier bug where `direct_out == 0` would cause a 10% tax on the full output is fixed."

### ✅ R2.2 Lazy pagination in dfs_path, dfs_cycle, find_best_flash_triangle — CORRECTLY FIXED
"Budget decrements per candidate within each page, not just per page. No vector allocation larger than PAGE = 10 elements."

Note: Kimi observed the lazy pagination correctly but didn't notice that `find_best_flash_triangle`'s outer loop budget decrement was missing (caught separately by Claude R3 MED-1 — also applied).

### ✅ R1.5 fixes preserved
- MED-1 `expected_out > 0` assertion verified
- MED-2 shared budget in find_best_flash_triangle verified

---

## Q1-Q10 + OQ1-OQ7 answers
All standard confirmations. No new design questions raised. OQ-2 noted as "RESOLVED" since caller-nominated direct_pool was already canonicalized in R1 fix batch.

---

## Full-surface review highlights

### ✅ Correctly Implemented
1. Flash loan safety (hot-potato, locked flag, k-invariant, strict equality on repayment)
2. Service charge uniformity across 4 compose functions
3. Simulation-to-execution determinism (pool uniqueness enforced)
4. Composability safety (FA-in/FA-out pattern)
5. Factory asset_index correctly maintained
6. Pool simplifications preserve LP accumulator invariants

### Minor observations
- Dust swap fee floor to 0 (accepted)
- Flash fee floor to 1 (accepted)
- Intentional conservative rounding

---

## Overall verdict
**🟡 YELLOW (pre-fix) → 🟢 GREEN (post-fix)**

The R2.1 and R2.2 hotfixes are correctly implemented. The MEDIUM-1 u64 overflow is a cheap u128-widening fix matching beta's existing defensive pattern. After applying, no blocking issues for mainnet publish.

**Cross-coverage note:** Kimi caught treasury overflow that Claude R3 rated as INFO and DeepSeek/Perplexity did not mention. Each R3 auditor found different issues.
