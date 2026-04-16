# Qwen — LP Staking R1 audit response

**Date:** 2026-04-16
**Verdict:** GREEN (conditional on HIGH-1 — FALSE POSITIVE)
**Severity counts:** 1 HIGH / 1 LOW / 2 INFORMATIONAL

---

## Findings

### HIGH-1: Use-after-move in `stake_lp` — FALSE POSITIVE

**Location:** staking.move (~line 200-202)
**Description:** Auditor claims `object::transfer(user, position, stake_addr)` consumes the `Object<LpPosition>` handle, making the subsequent `pool::claim_lp_fees(&stake_signer, position)` a use-after-move error.
**Our response:** **FALSE POSITIVE.** `Object<T>` in Aptos Move has `copy + drop + store` abilities. It is NOT consumed by `object::transfer` — the function takes `Object<T>` by value but since `Object<T>` is `copy`, the original binding remains valid. Verified by:
- `aptos move compile --dev` → zero errors, zero warnings
- `aptos move test` → 13/13 pass
- Testnet deploy + full lifecycle smoke test → all functions executed successfully
- Same pattern used by LP Locker (mainnet-proven, 5/5 audit GREEN)

### LOW-1: Legacy signer generation API — ACKNOWLEDGED

`object::generate_signer(&ctor)` vs `generate_signer_for_constructor_ref`. Both work in current Aptos framework. Not a security issue. Can update in future compat upgrade if API is actually deprecated.

### INFORMATIONAL-1: deposit_rewards doesn't trigger accumulator update

By design. Standard MasterChef pattern. Documented.

### INFORMATIONAL-2: View gas cost

Standard for view functions. No security risk.

---

## Design decision validations

All 6 decisions (D-1..D-6) validated as correct by auditor.
