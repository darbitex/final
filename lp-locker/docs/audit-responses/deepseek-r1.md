# DeepSeek V3 — LP Locker R1 audit response

**Date:** 2026-04-16
**Verdict:** ✅ **GREEN — Recommended for mainnet publish**
**Severity counts:** 0 HIGH / 0 MEDIUM / 1 LOW (no-fix, theoretical) / 2 INFO (no-fix)
**Language:** Original response in Chinese, translated summary below.

---

## Opening assessment

> The module is cleanly designed and tightly scoped, strictly following Aptos Move object-model security best practices. No high-severity or critical vulnerabilities were found. All predefined threat-model items are effectively mitigated. The interaction with core `darbitex::pool` is safe and minimal.

---

## Findings

### LOW-1: Theoretical concern about destructure-then-assert pattern in `redeem` (no real impact)

**Location:** `lock.move:146-151`

**Description:** `redeem` first calls `move_from<LockedPosition>(locker_addr)` to remove the resource from storage, *then* performs `assert!(now >= unlock_at, E_STILL_LOCKED)`. If the assert fails, the entire transaction aborts and all state changes (including `move_from`) roll back. This is Move's atomicity guarantee — there is no intermediate state where "resource destroyed but user didn't receive position".

**Assessment:** Pattern is completely safe under Move. The code clearly expresses the "rollback if not unlocked" intent. The only theoretical blemish: if Move VM atomic-rollback semantics were ever to fundamentally change (extremely unlikely), this ordering could become a problem. But that is out of audit scope. The current implementation is fully compatible with Move best practices.

**Recommended fix:** None. Keep the current code for readability.

---

### INFORMATIONAL-1: Deliberate omission of `pool_addr` in `FeesClaimed`

**Location:** `lock.move:120-129`

**Description:** `FeesClaimed` event deliberately omits `pool_addr` because `LpPosition.pool_addr` is private in core and there is no public getter. The solution is to correlate with core's `LpFeesClaimed` event in the same tx via `position_addr`.

**Assessment:** A pragmatic engineering trade-off. Under the zero-core-touch constraint, omitting the field and resolving via event correlation is reasonable. No security hole is introduced because the event emitter is trusted (the module itself), and `position_addr` is already in scope for correlation. Off-chain indexers can reliably join the two events.

**Recommended fix:** None. Keep current design.

### INFORMATIONAL-2: `lock_position_and_get` as `public` rather than `public(friend)`

**Location:** `lock.move:50`

**Description:** `lock_position_and_get` is marked `public`, meaning any Move module can call it and obtain a `LockedPosition` handle. This matches `pool::add_liquidity` in core.

**Assessment:** Exposing as `public` does not widen the attack surface. The caller must provide a `&signer` they signed, and must own the `LpPosition` being locked. All checks (ownership transfer, unlock time validity) are based on `signer` and input parameters, independent of visibility modifiers. This enables other contracts (e.g., automated investment strategy contracts) to compose the locker functionality — a beneficial design.

**Recommended fix:** None.

---

## Design questions answered

**D-1 (correlation-based event attribution):** **Accepted.** Under the hard "zero core touch" constraint, this is the only viable engineering approach. `pool_addr` is private and has no getter. Correlation is a standard practice for off-chain indexers, safe and reliable.

**D-2 (strict `unlock_at > now`):** **Correct.** Using strict `>` avoids the ambiguity of "zero-second locks" and forces the user to explicitly specify a future timestamp. `u64::MAX` as a permanent-lock sentinel is clean and effective, no extra boolean flag needed. Allowing `>=` would only add misuse risk.

**D-3 (`lock_position_and_get` as non-entry sibling):** Correct API design. Perfectly mirrors the core `add_liquidity` / `add_liquidity_entry` pattern. `public` visibility does not introduce security risk because authorization is `signer`-based.

**D-4 (no `permit` model):** Correct. Keeping the feature set minimal is key to security. If delegation is needed in the future, it can be done via a multisig wallet holding the locker, or through a simple proxy contract — no need to build into the locker core.

**D-5 (no hard cap on lock duration):** Correct. Setting a cap (e.g., "no locks past 2100") is unnecessary paternalism. `u64::MAX` is large enough; letting users fully decide their lock duration is in the spirit of decentralized apps. There is no technical security risk from excessively long locks.

**D-6 (no extend/shorten):** Correct. Keeping the API atomic (`redeem` + re-`lock`) simplifies state management and eliminates potential race conditions in state updates. The cost of re-locking is two transactions — acceptable for such a low-frequency operation.

**D-7 (core-upgrade risk stance):** Sufficient. Aptos Move's `compatible` upgrade policy explicitly forbids signature changes. Any semantic change to the core would require a new audit cycle, at which point compatibility can be re-evaluated. After core flips to `immutable`, the risk is fully eliminated.

---

## Threat model walkthrough verification

| # | Threat | Status |
|---|---|---|
| 1 | Unauthorized fee harvest | ✅ mitigated — `claim_fees` asserts `object::owner(locker) == user_addr` |
| 2 | Unauthorized redeem | ✅ mitigated — same assert in `redeem` |
| 3 | Principal-lock bypass | ✅ mitigated — LP position ownership transferred to locker_addr; user cannot call `pool::remove_liquidity` directly because core's owner check would fail |
| 4 | Lock-state mutation post-lock | ✅ mitigated — `unlock_at` field is read-only (accessed via immutable borrow), no extend/shorten functions |
| 5 | Double-spend on owner transfer | ✅ mitigated — `object::owner` check reflects current owner in real time; original owner's authority expires immediately after transfer |
| 6 | Stuck position | ✅ mitigated — `redeem` provides a clear exit path, guaranteed to work as long as core behavior is unchanged |
| 7 | Event spoofing | ✅ mitigated — events are emitted internally by the module; external modules cannot forge `darbitex_lp_locker::lock::Locked` event types |
| 8 | Resource leak on redeem | ✅ mitigated — `move_from` removes `LockedPosition`; `object::delete(delete_ref)` removes the object itself; `ExtendRef` and `DeleteRef` are properly dropped |
| 9 | Hot-potato FA mishandling | ✅ mitigated — returned FAs from `pool::claim_lp_fees` are immediately deposited to user's primary store; if `deposit` fails the tx aborts, and Move's linear type system guarantees FAs cannot be silently dropped |

---

## Optional micro-optimization (style only, not required)

In `redeem`, the assert could be placed before `move_from` to avoid unnecessary state deserialization overhead on failed transactions:

```move
// Optional minor change, NOT required
let l = borrow_global<LockedPosition>(locker_addr);
assert!(timestamp::now_seconds() >= l.unlock_at, E_STILL_LOCKED);
let LockedPosition { ... } = move_from<LockedPosition>(locker_addr);
```

The current implementation is equally correct — decide per code style preference.

---

## Final recommendation

> Module code quality is high, documentation is thorough, test coverage is comprehensive. All core security invariants are satisfied. Recommend proceeding with mainnet deployment as planned.

**Verdict:** ✅ **GREEN**
