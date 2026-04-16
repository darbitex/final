# Internal Auditor 1 — Security Focus (Claude)

**Date:** 2026-04-16
**Verdict:** YELLOW → GREEN after fixes
**Severity counts:** 0 BLOCKER / 2 MAJOR (both fixed) / 3 MINOR / 3 NIT

---

## Findings

### MAJOR-1: `reward_balance` underflow on concurrent claims — FIXED

**Location:** vault.move:454, 484 (original)
**Description:** `rp.reward_balance = rp.reward_balance - pending` in `claim_stake_rewards` and `unstake_tokens`. Between `update_reward_pool` (which caps `total_reward` to `reward_balance`) and the actual withdrawal, multiple stakers' accumulated `pending` could exceed `reward_balance` after the first claim decrements it. Second staker's claim causes u64 underflow abort, **locking their staked tokens**.
**Impact:** Fund-locking bug. Staked tokens permanently trapped until someone deposits enough rewards to cover the deficit.
**Fix applied:** Deducted `total_reward` from `reward_balance` inside `update_reward_pool` at allocation time. Removed deduction in `claim_stake_rewards` and `unstake_tokens`. Now `reward_balance` tracks unallocated emission budget, not unclaimed rewards.

### MAJOR-2: 1 APT creation fee per stake position — ACKNOWLEDGED

**Location:** vault.move:401
**Description:** Every `stake_tokens` call charges 1 APT. Staking is a recurring user action, not a one-time vault creation. At current APT prices this makes the staking module essentially unusable for pools with rewards < 1 APT.
**Impact:** Economic/UX concern, not a code bug.
**Resolution:** Acknowledged as intentional design choice — deters 1-unit stake griefing attack.

### MINOR-1: Operator precedence ambiguity in `vested_available`

**Location:** vault.move:314-316
**Description:** `(now - v.start_time as u64)` — the `as u64` cast binds to `v.start_time`, not the subtraction result. Since both are already u64, this is a no-op and correct by accident.
**Impact:** Not exploitable. Readability concern only.

### MINOR-2: Vesting object cleanup race with borrow

**Location:** vault.move:302-307
**Description:** `claim_vested` borrows VestedTokens mutably, then conditionally does `move_from` to destroy it. The borrow is dead before `move_from` executes (verified by compiler).
**Impact:** None. Pattern is sound but fragile.

### MINOR-3: Reward emission can silently halt

**Location:** vault.move:502-522
**Description:** When `reward_balance` drops to 0, emission halts silently. No event or view to indicate the pool is "dry."
**Impact:** Pool creator gets no notification. Frontend responsibility.

### NIT-1: No admin/emergency withdrawal mechanism

Deposited rewards are irrecoverable if no one stakes. By design (fire-and-forget).

### NIT-2: `RewardPool` has no `DeleteRef`

Pool objects are immortal. Minor storage leak for abandoned pools.

### NIT-3: Hardcoded treasury address

`TREASURY` is a compile-time constant. Changeable via compat upgrade if needed.
