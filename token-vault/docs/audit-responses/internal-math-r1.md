# Internal Auditor 2 — Math/Economics Focus (Claude)

**Date:** 2026-04-16
**Verdict:** YELLOW → GREEN after fixes
**Severity counts:** 0 BLOCKER / 2 MAJOR (1 fixed, 1 acknowledged) / 4 MINOR / 4 NIT

---

## Findings

### MAJOR-1: 1-unit stake griefing — emission rounds to 0

**Location:** vault.move:524-526
**Description:** If `capped * max_rate < stake_target`, `emission_rate` returns 0 via integer truncation. Attacker stakes 1 unit, `last_reward_time` advances without distributing rewards.
**Impact:** After reward_balance fix (deducting in `update_reward_pool`), no rewards are consumed when rate=0. Rewards are preserved for when real stakers arrive. The 1 APT fee makes this attack cost ~$8+ per attempt.
**Resolution:** Acceptable after the reward_balance fix. Griefing is self-limiting and costly.

### MAJOR-2: `reward_balance` underflow — rounding across multiple stakers — FIXED

**Location:** vault.move:454, 484 (original)
**Description:** Multiple stakers' `pending` values could sum to exceed `reward_balance` due to integer division rounding. First claim succeeds, second underflows, locking staked tokens.
**Impact:** Fund-locking. Same root cause as Security Auditor's MAJOR-1.
**Fix applied:** Same fix — deduct in `update_reward_pool`, not in claim/unstake.

### MINOR-1: Zero-staked period skips emission time

**Location:** vault.move:502-506
**Description:** When `total_staked == 0`, `last_reward_time` advances without emitting. Standard MasterChef behavior. Rewards remain in balance for future stakers.
**Impact:** None — by design.

### MINOR-2: Vesting rounding favors protocol

**Location:** vault.move:316
**Description:** Integer division truncates toward zero. User gets slightly less than pro-rata until `now >= end_time`. Max rounding loss per claim: `duration - 1` base units.
**Impact:** Standard. No funds permanently lost.

### MINOR-3: No minimum lock/vest duration

**Location:** vault.move:174, 248
**Description:** Can lock for 1 second or vest over 1 second. Fee discourages trivial usage.
**Impact:** None — fee is the deterrent.

### MINOR-4: 1 APT fee per stake position — ACKNOWLEDGED

Same as Security Auditor MAJOR-2.

### NIT-1: `as u64` cast position ambiguous (lines 314-315)
### NIT-2: No minimum stake amount
### NIT-3: No pool admin or recovery mechanism
### NIT-4: MasterChef ordering is correct (initially flagged, then retracted)
