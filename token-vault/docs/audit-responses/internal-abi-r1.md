# Internal Auditor 5 — ABI/Composability Focus (Claude)

**Date:** 2026-04-16
**Verdict:** YELLOW (missing views/operations)
**Severity counts:** 0 BLOCKER / 5 MAJOR (1 fixed, 4 acknowledged) / 4 MINOR / 4 NIT

---

## Findings

### MAJOR-1: Missing `stake_info` view — FIXED

**Location:** (absent)
**Description:** No way to query stake position details (pool_addr, amount) without indexing events.
**Fix applied:** Added `stake_info(stake) → (pool_addr, amount)`.

### MAJOR-2: No `extend_lock` entry function — ACKNOWLEDGED

**Description:** No way to extend a lock's `unlock_at`. Must redeem + re-lock (paying another 1 APT).
**Resolution:** Design choice — minimal API. Can add via compat upgrade later.

### MAJOR-3: No `increase_stake` / `add_to_stake` — ACKNOWLEDGED

**Description:** Users accumulate separate position objects, each costing 1 APT.
**Resolution:** Design choice. Can add fee-free `increase_stake` in future compat upgrade.

### MAJOR-4: No `top_up_vesting` — ACKNOWLEDGED

**Description:** Once created, vesting amount is fixed.
**Resolution:** Design choice — minimal, fire-and-forget.

### MAJOR-5: 1 APT fee per stake position — ACKNOWLEDGED

Same as other auditors.

### MINOR-1: `lock_info` view doesn't return owner

Owner is queryable via `object::owner()` on the Object layer.

### MINOR-2: `vest_info` doesn't include claimable inline

Separate `vest_claimable` view exists.

### MINOR-3: `reward_pool_info` omits `acc_reward_per_share` and `last_reward_time`

Needed for off-chain verification. Can add in compat upgrade.

### MINOR-4: Inner `create_*` functions are private, not public

Lost composability opportunity. Can add new public names in compat upgrade (existing private names not ABI-locked).

### NIT-1: Constants are hardcoded but changeable via compat upgrade
### NIT-2: `as u64` cast readability
### NIT-3: `extend_ref` dropped unused in `unstake_tokens` — correct behavior
### NIT-4: `SCALE = 1e12` — standard, no issues
