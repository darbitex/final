# Claude (fresh web) R1 — Darbitex Final

**Auditor:** Claude Opus 4.6 extended (Anthropic web, fresh session)
**Code reviewed:** R1 submission
**Verdict:** 🟡 YELLOW (ready after MEDIUM-1 and MEDIUM-2 addressed)

---

## Findings

### HIGH: none

### MEDIUM-1: swap_compose uses caller-nominated direct_pool as baseline — canonicalize
- **Location:** arbitrage.move, swap_compose + swap_entry
- **Description:** Caller-nominated `direct_pool` trusts arbitrary baseline pool. Frontend/SDK bug silently distorts service charge. Inconsistent with `execute_path_compose` (canonical derivation via `canonical_pool_address_of`).
- **Recommended fix:** Replace `direct_pool: address` with `metadata_out: Object<Metadata>` in both `swap_compose` and `swap_entry`. Internally derive canonical via `pool_factory::canonical_pool_address_of`. Treat missing canonical as baseline=0 (consistent with linear-no-direct-pool case).

### MEDIUM-2: execute_path_compose doesn't enforce pool uniqueness in caller-supplied paths (NEW)
- **Location:** arbitrage.move, execute_path_compose
- **Description:** `pool_path: vector<address>` is caller-supplied. DFS-discovered paths are unique by construction, but external callers can pass `[pool_AB, pool_BC, pool_AB]` — same pool twice. Second visit to pool_AB sees post-first-swap state. The documented simulation-to-execution determinism guarantee (Q2) does not hold for duplicate-pool paths.
- **Impact:** `min_out` protects caller from loss, but documented invariant is broken. Integrator programmatically constructing paths might not notice.
- **Recommended fix:** Add O(n²) duplicate check at top of `execute_path_compose` (n ≤ MAX_HOPS=4, ≤6 comparisons max):
```move
let i = 0;
while (i < vector::length(&pool_path)) {
    let j = i + 1;
    while (j < vector::length(&pool_path)) {
        assert!(*vector::borrow(&pool_path, i) != *vector::borrow(&pool_path, j), E_WRONG_POOL);
        j = j + 1;
    };
    i = i + 1;
};
```

### MEDIUM-3: close_triangle_compose pre-check vs post-check rounding gap
- Low impact. Pre-check optimizes gas, post-check is authoritative. Keep both.
- **Effective severity: INFO / defense-in-depth observation.** Not actionable.

### LOW-1: LP fee dust accumulation via accrue_fee rounding
- Standard MasterChef V2 behavior. Bounded by `lp_supply / SCALE`. Sub-atomic for realistic values.
- **No action required.**

### LOW-2: E_SAME_TOKEN check in pool::create_pool is redundant
- Same finding as Qwen. Assert unreachable because factory's `assert_sorted` rejects same-token pair first.
- **Recommended:** Keep as friend-boundary defense-in-depth, add comment noting factory pre-condition.

### LOW-3: pools_containing_asset silently clamps oversize limit requests
- Caller passing `limit=100` silently gets 10. No "more exists" signal.
- **Recommended:** Return tuple `(vector<address>, bool)` with saturation flag. Compat-safe during soak window.

### INFORMATIONAL-1: `amount_out < reserve_out` assert mathematically unreachable
- For x*y=k formula, denominator > amount_in_after_fee so result < reserve_out strictly. Keep as defense-in-depth.

### INFORMATIONAL-2: Compose layer event attribution spoofable
- OQ-7 already documented. Accept.

### INFORMATIONAL-3: design.md describes stale architecture (NEW)
- **design.md** describes `beforeSwap`/`afterSwap` callback architecture with `friend darbitex::arbitrage` in pool and `swap_raw` friend function. The IMPLEMENTED code is entirely different: pool is pure primitive, arbitrage wraps from outside, no friend coupling between pool and arbitrage.
- **Impact:** Documentation mismatch could confuse auditors or future contributors.
- **Recommended:** Update design.md to reflect implemented wrapper architecture, or deprecate in favor of submission doc.

---

## OQ answers
- **OQ-1:** Keep current design (no factory cap, `fetch_all_sister_pools`). Soft gas budget via `&mut u64` counter as future compat upgrade if gas becomes practical issue. **Don't add preemptively.**
- **OQ-2:** Canonicalize. (MEDIUM-1 fix)
- **OQ-3:** 4/5 reasonable. Keep.
- **OQ-4:** Yes, canonicalize `swap_entry` (same as OQ-2).
- **OQ-5:** Keep pre-pass.
- **OQ-6:** Don't refuse sub-optimal paths (caller sovereignty).
- **OQ-7:** Accept spoofing (choice c).

---

## Praise section (8 confirmed)

1. **FA-in/FA-out compose layer with no &signer** — cleanest Move composability pattern
2. **Hot-potato FlashReceipt with no abilities** — bulletproof linear type safety
3. **Reserve-unchanged model during flash borrow** — simpler and safer k-invariant
4. **Separation of pool and arbitrage modules** — zero reentrancy surface (vs the callback architecture in design.md which would have been worse)
5. **`canonical_pool_address_of` for O(1) baseline (M-3 fix)** — exactly the right fix
6. **`fetch_all_sister_pools` over factory cap (M-4 fix)** — learning from beta `amount_a == amount_b` cautionary tale
7. **Uniform 10% service charge across all surfaces** — philosophically consistent
8. **Pool lock reentrancy protection** — simple, effective, correctly positioned

---

## Overall verdict
**🟡 YELLOW** — ready for mainnet after addressing MEDIUM-1 (canonicalize direct_pool) and MEDIUM-2 (pool uniqueness enforcement in execute_path_compose). Both are clean API improvements during the current compat window. Neither is exploitable for value extraction. After these, package is green for mainnet publish.
