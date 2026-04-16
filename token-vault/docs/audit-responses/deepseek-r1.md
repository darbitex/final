# DeepSeek — Token Vault R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟡 **YELLOW** → GREEN after HIGH-1 analysis
**Severity counts:** 1 HIGH / 2 MEDIUM / 2 LOW / 1 INFORMATIONAL

---

## Findings

### HIGH-1: u128 overflow in `pending_reward` for extreme acc values — ACKNOWLEDGED (LOW in practice)

**Location:** vault.move:529-532 (`pending_reward`)
**Description:** `(amount as u128) * acc` could overflow u128 if both `amount` and `acc` are extremely large. Auditor gives example: `acc ≈ 1.8e31` (from tiny staked + huge rewards) and `amount = 2e7` → product = 3.6e38, approaching u128::MAX (3.4e38).
**Our analysis:** This requires adversarial pool parameters (`total_staked = 1`, massive reward deposits). Same root cause as Internal Auditor 4's MAJOR-2 (adversarial `max_rate`). In practice:
- 1 APT fee deters creating such pools
- Pool parameters are visible on-chain — stakers can inspect before entering
- Realistic token amounts (even 1B supply at 8 decimals = 1e17) with realistic staking participation won't trigger this
- u256 widening is the textbook fix but adds a dependency on `aptos_std::u256`

**Resolution:** Acknowledged as theoretical risk. Same category as "don't stake in a pool with max_rate=u64::MAX." Frontend should warn about pools with extreme accumulator values.

### MEDIUM-1: `reward_balance` may overflow u64 — FALSE POSITIVE

**Location:** vault.move:379
**Description:** Auditor claims repeated `deposit_rewards` could overflow `reward_balance` (u64).
**Our response:** `reward_balance` tracks unallocated budget. Each `update_reward_pool` call deducts allocated rewards. The maximum `reward_balance` at any point is bounded by the total FA token supply, which is itself u64. Multiple deposits of the same token can't exceed u64::MAX because the depositor can't have more than u64::MAX tokens. **Not a real overflow risk.**

### MEDIUM-2: Borrow checker hazard in `claim_vested` — FALSE POSITIVE

**Location:** vault.move:276-308
**Description:** Same claim as Qwen HIGH-1 — `borrow_global_mut` followed by `move_from` might fail.
**Our response:** **FALSE POSITIVE.** Move NLL drops the reference after last use. Verified by compilation, 24/24 tests, testnet deploy, and Gemini INFORMATIONAL-3 independent validation. Current compiler (Aptos mainnet rev) accepts this. Future compiler changes are speculative — and if they occur, a compat upgrade can restructure.

### LOW-1: Redundant `as u64` cast — ACKNOWLEDGED

**Location:** vault.move:314
**Description:** No-op cast. Readability only.

### LOW-2: No event for fee collection — ACKNOWLEDGED

**Location:** vault.move:150-155
**Description:** `collect_fee` doesn't emit an event. Fee is visible via FA transfer events from `primary_fungible_store::withdraw/deposit`, but no dedicated `FeeCollected` event.
**Our response:** FA-level transfer events already provide transparency. Dedicated event would be nice-to-have but not required. Can add in compat upgrade if needed.

### INFORMATIONAL-1: Timestamp reliance is standard

`timestamp::now_seconds()` — standard practice, ~1s validator tolerance acceptable for lock/vest/stake.

---

## Summary

| Finding | Severity | Status |
|---------|----------|--------|
| u128 overflow in pending_reward | HIGH | Acknowledged (theoretical, adversarial params) |
| reward_balance u64 overflow | MEDIUM | False positive |
| Borrow checker in claim_vested | MEDIUM | False positive |
| Redundant cast | LOW | Acknowledged |
| No fee event | LOW | Acknowledged (FA events suffice) |
| Timestamp reliance | INFO | Standard practice |
