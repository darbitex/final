# Internal Auditor 4 — Edge Cases Focus (Claude)

**Date:** 2026-04-16
**Verdict:** YELLOW → GREEN after fixes
**Severity counts:** 0 BLOCKER / 3 MAJOR (1 fixed, 2 acknowledged) / 4 MINOR / 2 NIT

---

## Findings

### MAJOR-1: Same-token `reward_balance` underflow — FIXED

**Location:** vault.move:452-454, 482-484 (original)
**Description:** When `staked_token == reward_token`, pool holds commingled balance. Rounding across stakers could cause `reward_balance - pending` underflow. Same root cause as Security/Math auditor findings.
**Fix applied:** Deduct in `update_reward_pool`.

### MAJOR-2: u128 overflow with adversarial `max_rate = u64::MAX`

**Location:** vault.move:509, 524-526
**Description:** With `max_rate = u64::MAX` and `total_staked = 1`, `acc_reward_per_share` grows by ~2^103 per second. After ~1 year, u128 overflows and pool is permanently bricked — all stakers' tokens locked.
**Impact:** Attacker creates toxic pool with extreme parameters and lures victims.
**Resolution:** Acknowledged. Self-inflicted damage with visible on-chain parameters. 1 APT fee deters. Frontend should filter extreme pools.

### MAJOR-3: Permanent lock with `unlock_at = u64::MAX`

**Location:** vault.move:174
**Description:** No upper bound on `unlock_at`. Setting `u64::MAX` creates an unredeemable lock. No admin override.
**Impact:** User error. Their tokens, their choice.
**Resolution:** Acknowledged — same as LP Locker's design.

### MINOR-1: 1 APT fee per stake position
### MINOR-2: Unlimited locks/vests/stakes per user — no on-chain enumeration
### MINOR-3: Treasury `primary_fungible_store::deposit` auto-creates store — non-issue
### MINOR-4: Transferable positions — by design

### NIT-1: Vesting with `total_amount = 1` and long duration — cliff-like behavior due to truncation
### NIT-2: `as u64` cast redundancy (lines 314-315)
