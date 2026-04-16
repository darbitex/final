# Internal Auditor 3 — Aptos Patterns Focus (Claude)

**Date:** 2026-04-16
**Verdict:** GREEN (contingent on design-intent clarifications)
**Severity counts:** 0 BLOCKER / 0 MAJOR (2 downgraded after analysis) / 4 MINOR / 3 NIT

---

## Findings

### MINOR-1: Objects are transferable by default

**Location:** vault.move:181, 254, 410
**Description:** `object::create_object(user_addr)` creates transferable objects. `LockedTokens`, `VestedTokens`, and `StakePosition` can all be transferred. New owner can redeem/claim/unstake.
**Impact:** By design. Same pattern as LP Locker. OTC-able positions.
**Resolution:** Acknowledged — intentional.

### MINOR-2: `reward_balance` underflow not guarded — FIXED

**Location:** vault.move:454, 484 (original)
**Description:** Subtraction could underflow in theory. Fixed by deducting in `update_reward_pool` instead.
**Impact:** Fixed.

### MINOR-3: No `RewardPool` deletion mechanism

**Location:** vault.move:44-54
**Description:** No `DeleteRef` stored. Pools are immortal once created.
**Impact:** By design — fire-and-forget. Minor storage cost.

### MINOR-4: 1 APT fee per stake position

Same as other auditors.

### NIT-1: `as u64` cast precedence (line 314-316)

Compiles correctly. Readability improvement only.

### NIT-2: Missing `stake_info` view — FIXED

Added `stake_info(stake) → (pool_addr, amount)`.

### NIT-3: Event structs well-formed

All events use `#[event]` with `drop + store`. Correct v2 pattern.

---

## Design-intent clarifications (resolved)

- **Transferability:** Confirmed intentional.
- **`claim_vested` borrow + move_from:** Confirmed compiler accepts — mutable ref is dead before `move_from`. Sound.
