# Security Audit — R3 Bundle Re-Audit (Final)

> **Auditor**: Claude Opus 4.7 (1M)
> **Date**: 2026-04-20
> **Scope**: `flashbot/sources/bridge.move` (184 lines), `twamm/sources/twamm.move` (295 lines)
> **Context**: Re-audit of R3 bundle claims + verification of fixes across 3 iterations

---

## Iteration Summary

| Iteration | Findings | Blockers | Resolution |
|-----------|----------|----------|------------|
| **R3 Initial Audit** | H-A1, H-A2, L-A1, L-A2, L-A3 | 2 HIGH | Fixed in iteration 2 |
| **Iter 2 Re-Audit** | H-B1, L-B1, L-B2 | 1 HIGH (regression from H-A1 fix) | H-B1, L-B1 fixed in iteration 3 |
| **Iter 3 Final** | L-B2 only (advisory) | 0 | ✅ APPROVED |

---

## R3 Bundle Claim Verification (Original)

| ID | Claim | Final Status |
|----|-------|--------------|
| C1 | `E_SAME_TOKEN` & `E_REENTRANT` added | ✅ Valid (E_REENTRANT later removed as dead code) |
| C2 | Symmetric dust sweep (both tokens) | ✅ Valid — `twamm.move:281-292` |
| M1 | Fail-fast slippage 80% floor | ✅ Valid, tightened to 90% — `twamm.move:232` |
| H1 | `public(friend)` restriction | ✅ Valid — `bridge.move:15, 102` |
| H2 | Global lock removed | ✅ Valid — no `ReentrancyLock` resource remains |
| M2 | u256 casting for EMA overflow safety | ✅ Valid — `twamm.move:247-251` |
| M3 | "Full-reserve blending" | ⚠️ **Claim was misleading in R3**, but genuinely fixed in iteration 3 |
| H3 | `force_update_oracle` removed | ❌ Caused deadlock (H-A2), **reverted** in iteration 2 |
| H4 | Keeper whitelist via AdminState | ✅ Valid — `twamm.move:71-77, 187` |

---

## New Findings (Iteration 1 → Iteration 2)

### H-A2 (HIGH — regression from H3) — **FIXED (iter 2)**
**File**: `twamm.move:106-116`

R3's H3 removed `force_update_oracle` citing "admin backdoor". But combined with `init_ema_*` being no-op-if-exists, this created a **permanent liveness deadlock**: if oracle goes stale (>5 min), `execute_virtual_order` aborts on `E_STALE_ORACLE`, and no recovery path exists.

**Fix**: `force_update_oracle` restored, admin-gated to `@darbitex_twamm` (3/5 multisig). Trust-assumed via multisig, not single admin.

### H-A1 (MEDIUM — false claim) — **FIXED (iter 3, with regression)**
**File**: `twamm.move:253-264`

R3 claimed "reverted to full-reserve blending" but the original code still blended `oracle.reserve_in` with `amount_to_swap` (single-trade size, not reserve). Magnitude drift over time would eventually zero out `auto_borrow_amount`.

**Fix (iter 2)**: Switched to `pool::reserves(darbitex_arb_pool)` for blend source. This introduced H-B1 (see below).

### L-A1 (LOW) — **FIXED (iter 2)**
Dead constant `E_REENTRANT` removed from `bridge.move`.

### L-A2 (LOW) — **FIXED (iter 2)**
Added `remove_keeper` in `twamm.move:79-86`, symmetric to `add_keeper`.

### L-A3 (LOW) — **FIXED (iter 2), then obsoleted (iter 3)**
u128 downcast bound-check added, then removed when L-B1 eliminated the downcast entirely.

---

## New Findings (Iteration 2 → Iteration 3)

### H-B1 (HIGH — regression from H-A1 fix) — **FIXED (iter 3)**
**File**: `twamm.move:254-258`

`pool::reserves()` returns in pool-local order (`meta_a, meta_b`), not oracle order (`token_in, token_out`). Without orientation check, 50% of pools would blend **reversed** reserves into oracle, causing systematic price inversion and corrupting `calculate_optimal_borrow`.

**Fix (iter 3)**: Orientation-aware fetch identical to `bridge.move:73-81` and `init_ema_from_pool`:
```move
let (res_a, res_b) = pool::reserves(darbitex_arb_pool);
let (meta_a, _) = pool::pool_tokens(darbitex_arb_pool);
let is_in_a = object::object_address(&order.token_in) == object::object_address(&meta_a);
let (pool_r_in, pool_r_out) = if (is_in_a) { (res_a, res_b) } else { (res_b, res_a) };
```

All three orientation call-sites now consistent. ✅

### L-B1 (LOW — dead code) — **FIXED (iter 3)**
After H-A1 pivoted blend source to `pool::reserves`, the `spot_reserve_out_u256` + bound-check + downcast at iter-2 `:265-267` became unused. Removed in iter 3 along with `U128_MAX` constant and `E_OVERFLOW` error. `ratio_ok` gate (using trade ratio) retained as sanity check before blend.

### L-B2 (LOW — advisory, **DEFERRED to v2**)
**File**: `twamm.move:247-258`

Semantic gap: `ratio_ok` gate uses **trade ratio** (`actual_amount_out/amount_to_swap`), but blend uses **pool snapshot reserves**. A sandwich attacker could manipulate pool state between blocks while keeping trade output within the 5× EMA band, causing oracle to absorb manipulated pool state at 10%/update.

**Mitigations already in place**:
- 10%/update smoothing (slow drift)
- Ratio gate with MAX_EMA_DEVIATION=5
- Keeper whitelist (only trusted keepers can trigger)

**Recommendation for v2**: Add direct `pool_r_in`/`pool_r_out` vs `oracle.reserve_in`/`oracle.reserve_out` magnitude cross-check (e.g., ≤2× delta) before commit.

---

## Final State Verification

### `bridge.move` (184 lines)
- E_SAME_TOKEN guard at `:117`
- `public(friend)` on `omni_swap_thala_twamm` at `:102`
- Orientation-aware `calculate_optimal_borrow` at `:64-98`
- u256 intermediates + sqrt_u256 + 50%-reserve cap + 99% fee buffer
- No reentrancy lock state (VM-native safety)
- Fund flow verified: beneficiary profit + treasury split + flash repay

### `twamm.move` (295 lines)
- Keeper whitelist with add/remove (`:71-86`)
- Admin recovery via `force_update_oracle` (`:106-116`)
- Oracle hardcoded to `@darbitex_twamm` (no keeper-controlled address)
- Precision-safe amount computation: `mul-then-div` at `:201`
- 90% inner slippage floor + 95% outer assertion (two-gate)
- EMA blend from actual pool reserves, orientation-aware
- Symmetric dust sweep for both tokens at order end (`:281-292`)

---

## Production Readiness Matrix

| Severity | Count | Outstanding | Blocker |
|----------|-------|-------------|---------|
| CRITICAL | 2 (C1, C2) | 0 | — |
| HIGH | 5 (H1, H2, H3→H-A2, H4, H-A1→H-B1) | 0 | — |
| MEDIUM | 3 (M1, M2, M3) | 0 | — |
| LOW | L-A1..3, L-B1..2 | L-B2 advisory | — |

**Status**: ✅ **APPROVED FOR MAINNET**

**Deploy path**: Follow Darbitex mainnet deploy SOP
1. 1/5 multisig propose → publish package
2. Smoke test with real params (heterogeneous decimals, market rate)
3. Freeze to immutable
4. Raise multisig to 3/5

---

## Appendix: File Paths

- `flashbot/sources/bridge.move`
- `twamm/sources/twamm.move`

## Appendix: Cross-References

- Prior audit: `audit_report.md` (pre-R3, Claude Opus 4.6)
- R2 fix bundle: `AUDIT-R2-BUNDLE.md`
- R3 fix bundle claim: `Audit-R3-Bundle.md`
