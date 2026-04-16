# Kimi K2 — LP Locker R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟢 **GREEN — Safe for Mainnet Deployment**
**Severity counts:** 0 actionable HIGH / 0 actionable MED / 1 LOW (acceptable risk, non-blocking) / 2 INFO + 4 NIT + **2 false positives**

Note: Kimi labeled two findings as "HIGH-1" and "HIGH-2" but both were explicitly marked **"VERIFIED SAFE (No issue found)"** in the body — these are non-findings framed as HIGH to document that they were checked. Adjusted counts above reflect actual actionable severity.

---

## Findings

### HIGH-1 (labeled) — "Critical Resource Destructure Ordering in `redeem`" → VERIFIED SAFE

**Location:** `lock.move:158-165`
**Actual status:** No issue. Kimi confirms destructure-then-assert is safe under Move atomic-tx semantics: "If the assertion fails, the entire transaction aborts atomically, and `LockedPosition` is restored to storage. No resource is leaked."

**Recommendation:** Add an inline comment to forestall future maintainer confusion:
```move
// NOTE: Destructure before assert is safe — Move transactions are atomic.
// If E_STILL_LOCKED fires, LockedPosition is restored to storage automatically.
```

**Actionable:** NIT only (comment addition).

### HIGH-2 (labeled) — "Flash Loan Risk on Wrapped Position (Principal-Lock Bypass)" → VERIFIED SAFE

**Location:** `pool.move` (core dependency)
**Actual status:** No issue. Kimi independently traced all pool entries (`flash_borrow`, `swap`, `add_liquidity`, `remove_liquidity`) and confirmed only `remove_liquidity` consumes `LpPosition`, and it has the owner check. "The principal-lock invariant holds. The locked position cannot be used in any pool operation except through the locker's authorized functions."

**Actionable:** None.

---

### MEDIUM-1 — **FALSE POSITIVE**: "Missing `acquires` Annotation Documentation"

**Claim:** `claim_fees` and `redeem` are missing `acquires LockedPosition` annotations.

**Verification:** This is **incorrect**. Both functions already explicitly declare `acquires LockedPosition`:

```move
public entry fun claim_fees(
    user: &signer,
    locker: Object<LockedPosition>,
) acquires LockedPosition { ... }

public entry fun redeem(
    user: &signer,
    locker: Object<LockedPosition>,
) acquires LockedPosition { ... }
```

See `lock.move:131-134` and `lock.move:156-159`. Kimi misread the source.

**Actionable:** None. Rejected as false positive.

---

### MEDIUM-2 — "Fee Claiming During Pool Lock State" → VERIFIED SAFE

**Analysis:** Kimi asked whether `claim_fees` can be called while `pool.locked = true` (e.g., during a flash loan). Traced `pool::claim_lp_fees` and confirmed it asserts `!pool.locked` at entry — call would abort cleanly with `E_LOCKED` from core. "This is correct behavior."

**Recommendation:** Document that `E_LOCKED` can propagate from core through locker calls. NIT only.

**Actionable:** Doc NIT.

---

### LOW-1 — **FALSE POSITIVE**: "Event Field Ordering Inconsistency"

**Claim:** Events have inconsistent field ordering.

**Verification:** This is **incorrect**. Actual event schemas:

| Event | Field order |
|---|---|
| `Locked` | `locker_addr, owner, position_addr, unlock_at, timestamp` |
| `FeesClaimed` | `locker_addr, owner, position_addr, fees_a, fees_b, timestamp` |
| `Redeemed` | `locker_addr, owner, position_addr, timestamp` |

All three events have the **same prefix** (`locker_addr, owner, position_addr`), variant-specific middle fields, and `timestamp` **always last**. This is already the consistent ordering Kimi recommends.

**Actionable:** None. Rejected as false positive.

---

### LOW-2 — "No Validation of `position` Object Type at Lock Time" → ACCEPTABLE RISK

**Location:** `lock.move:93-118` (`lock_position_and_get`)

**Description:** The function accepts `Object<LpPosition>` without verifying:
1. That the position exists with the `LpPosition` resource
2. That the position belongs to a valid Darbitex pool

**Kimi's own analysis:**
1. Existence: `object::transfer` aborts if `position` is not a valid object ✓
2. Fake position: could be a fake `LpPosition` from a malicious module with the same struct name — **but Move's type system routes `Object<darbitex::pool::LpPosition>` by full module path**, so a fake in a different module would fail type checking at compile time.

**Risk assessment:** Low. "The failure mode is 'stuck fees' not 'stolen funds'."

**Actionable:** Kimi recommends adding a view call to verify the position is recognized by core before locking. **BUT:** the only way to verify "this is a real Darbitex pool position" requires reading `LpPosition.pool_addr` and calling `pool::pool_exists(pool_addr)` — and `LpPosition.pool_addr` is module-private in core (same blocker as D-1). A validation path requires either a core upgrade or trusting the caller. Kimi's own risk assessment calls this "Acceptable."

**Decision:** Accept as-is, document in mainnet runbook.

---

### INFORMATIONAL-1: Zero-fee event emission — by design ✓

### INFORMATIONAL-2: Permanent lock semantics (`u64::MAX`) — by design ✓

---

## Design questions answered

**D-1 (correlation attribution):** **ACCEPTABLE.** Pragmatic and secure. No change.
**D-2 (strict `unlock_at > now`):** **CORRECT.**
**D-3 (`lock_position_and_get` as `public`):** **SAFE.** Note: ensure future edits don't accidentally mark it `entry` (which would break it, since entry funs can't return values).
**D-4 (no permit model):** **CORRECT OMISSION.**
**D-5 (no hard cap on duration):** **ACCEPTABLE.**
**D-6 (no extend/shorten):** **CORRECT.**
**D-7 (core upgrade risk stance):** **ACCEPTABLE WITH MONITORING.** Recommends adding version assertion in a future upgrade if core adds a `version: u64` view — not needed now.

---

## Positive patterns Kimi called out

| Pattern | Assessment |
|---|---|
| Hot-potato FA handling | Correct — Move linear types prevent drops |
| Owner-check authorization | Correct — no separate ACL needed |
| Atomic destructure+assert | Correct — abort rolls back |
| Clean object lifecycle | Correct — no zombie objects |
| Zero admin surface | Correct — immutable logic |
| Principal isolation | Correct — user cannot bypass |

---

## Deployment checklist (from Kimi)

- [ ] Verify mainnet core address `0xc988d39a...78dd` correct in Move.toml
- [ ] Confirm upgrade policy = `compatible`
- [ ] Set up monitoring for `FeesClaimed` events to verify correlation indexing works

---

## Overall verdict

> 🟢 **GREEN — Safe for Mainnet Deployment.** The Darbitex LP Locker is a well-architected, minimal, and secure satellite contract. It correctly implements the time-lock primitive with no identified critical vulnerabilities. The contract is ready for mainnet.

**Actionable findings from Kimi R1:**
- Zero HIGH (2 labeled as HIGH but both VERIFIED SAFE)
- Zero actionable MED (MED-1 false positive, MED-2 verified safe)
- Zero actionable LOW (LOW-1 false positive, LOW-2 acceptable risk not fixable without core touch)
- 2 NIT doc improvements (destructure comment + document E_LOCKED propagation)
- **2 false positives rejected** (MED-1 missing acquires, LOW-1 event field ordering)
