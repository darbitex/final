# Gemini 2.5 Pro — Token Vault R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟡 **YELLOW** → GREEN after HIGH-1 fix
**Severity counts:** 1 HIGH / 1 MEDIUM / 1 LOW / 3 INFORMATIONAL

---

## Findings

### HIGH-1: Precision loss in accumulator traps reward dust

**Location:** vault.move:516-519 (inside `update_reward_pool`)
**Description:** When calculating the accumulator increase, integer division truncates:
`rp.acc_reward_per_share = ... + (total_reward as u128) * SCALE / (rp.total_staked as u128);`
However, `rp.reward_balance` is decremented by the full `total_reward`. Because the accumulator truncates down, the actual tokens distributed to stakers will be strictly less than `total_reward`.
**Impact:** The difference becomes permanently trapped in the pool's FA store. Over many epochs this dust leakage can compound.
**Recommended fix:** Deduct only the *actually distributed* amount from `reward_balance`:
```move
let added_acc = (total_reward as u128) * SCALE / (rp.total_staked as u128);
let actual_distributed = ((added_acc * (rp.total_staked as u128) / SCALE) as u64);
rp.acc_reward_per_share = rp.acc_reward_per_share + added_acc;
rp.reward_balance = rp.reward_balance - actual_distributed;
```

### MEDIUM-1: Missing `pool_addr` in `TokensUnstaked` event

**Location:** vault.move:140-148
**Description:** `TokensStaked` includes `pool_addr` but `TokensUnstaked` does not. Indexers cannot reconcile unstake events to their parent pools without stateful mappings.
**Recommended fix:** Add `pool_addr: address` to `TokensUnstaked` struct and emit it.

### LOW-1: Hardcoded APT metadata address limits network portability

**Location:** vault.move:151
**Description:** `collect_fee` hardcodes APT metadata to `@0xa`. Correct for mainnet/testnet but may fail in custom environments.
**Impact:** Non-blocking for production.

### INFORMATIONAL-1: Same-token pool accounting is mathematically sound (D-4 validated)

Sequential withdrawals in `unstake_tokens` are safe because `reward_balance` tracks unallocated budget and `total_staked` tracks principal separately.

### INFORMATIONAL-2: `deposit_rewards` skips accumulator update (harmless)

Adding to `reward_balance` without calling `update_reward_pool` is functionally equivalent to updating first. Gas-efficient and safe.

### INFORMATIONAL-3: Vesting object cleanup borrow logic is clean

Move NLL correctly drops the mutable reference `v` before `move_from`. No dangling references.

---

## Overall assessment

> The core architecture, authorization boundaries, and MasterChef adaptations are highly robust. The `reward_balance` allocation-time deduction elegantly solves the standard multi-epoch underflow vulnerability.
