# Gemini 2.5 Pro — LP Locker R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟢 **GREEN for Mainnet Publish**
**Severity counts:** 0 HIGH / 0 MEDIUM / 0 LOW / 2 INFO (both non-blocking)

---

## Opening assessment

> This is a highly mature, exceptionally well-scoped, and defensively written piece of Move code. By strictly leveraging the Aptos object model for access control and transferability, you have effectively eliminated the need for custom ACLs, global registries, and complex state management. The decision to make this a satellite rather than a core upgrade is architecturally sound and preserves the audited invariants of your mainnet deployment.

---

## Findings

After a thorough review of the Move source code, execution flow, and object capability handling, there are **zero High, zero Medium, and zero Low severity findings.** The codebase strictly adheres to Move's linear typing and Aptos's object capability model.

### INFORMATIONAL-1: Redundant Zero-Fee Deposits

**Location:** `lock.move:133-143`

**Description:** In `claim_fees`, `pool::claim_lp_fees` may return `FungibleAsset`s with an amount of `0` if no fees have accrued since the last claim. The locker proceeds to call `primary_fungible_store::deposit` with these zero-amount assets.

**Impact:** This is not a security vulnerability. Aptos's `primary_fungible_store::deposit` natively handles zero-amount FAs by silently consuming/destroying them. However, it results in slightly sub-optimal gas usage for users who spam the claim function.

**Recommended fix:** None required. You could wrap the deposits in `if (fees_a > 0)` conditions, but the gas savings are negligible and omitting the check keeps the code path linear and simple.

### INFORMATIONAL-2: Object Deletion Before Event Emission

**Location:** `lock.move:162-169`

**Description:** In `redeem`, `object::delete(delete_ref)` is executed before `event::emit(Redeemed { ... })`.

**Impact:** In Move, this is completely safe; events are simply appended to the transaction output. However, if an off-chain indexer is listening for the `Redeemed` event and attempts a real-time RPC callback to query the `locker_addr` state *during* the block execution (a rare and anti-pattern indexer design), it will hit a `resource_not_found` error because the object is already destroyed.

**Recommended fix:** None required. This is standard lifecycle management, but it's worth noting for your off-chain indexing team.

---

## Design questions answered

**1. `redeem` destructure-then-assert ordering (§6.3 / §12.1)**
Implementation is **100% correct and safe**. Move transaction semantics guarantee atomic rollback. If the `unlock_at` assert fails, the VM aborts the transaction, and the preceding `move_from` is completely reverted. Moving the resource out of global storage prior to the assert avoids double-borrowing and is the idiomatic way to handle resource destruction in Move.

**2. FA Linearity in `claim_fees` (§12.2)**
Move's linear type system makes it impossible to drop a `FungibleAsset` silently. If `deposit` panics, the entire transaction aborts. **No execution path** where the fees are extracted from the pool but lost in the locker.

**3. Event attribution via correlation (D-1 / §12.3)**
Omitting `pool_addr` is the **correct architectural choice**. Altering core simply to satisfy a locker event violates the zero-core-touch principle. Indexers joining on `position_addr` within the same transaction hash is a standard, robust data engineering pattern. **Do not change this.**

**4. `lock_position_and_get` as public (D-3 / §12.4)**
Exposing this as a `public fun` introduces **zero attack surface**. In Aptos, possessing an `Object<T>` reference does not grant ownership rights; the framework checks `ObjectCore.owner`. Because the function requires the `user: &signer`, an attacker can only execute this function against `LpPosition` objects they already own. Returning the handle safely enables downstream composability.

**5. `object::transfer` internal owner check (§12.5)**
Reliance on `aptos_framework::object::transfer` is correct. The framework inherently checks `object::owns(object, signer::address_of(owner))` before executing the transfer. If a non-owner attempts to lock someone else's position, the framework will cleanly abort with `EOBJECT_NOT_OWNED` before locker logic even progresses.

**6. Core upgrade risk stance (D-7 / §12.6)**
Stance is accurate. Aptos's `compatible` upgrade policy strictly forbids signature mutations (adding/removing parameters or changing return types). Any behavioral changes to `claim_lp_fees` would require an audit of the core itself. **No version-assertion guard is needed.**

**7. Strict `unlock_at > now` & No Hard Cap (D-2 / D-5)**
Strict inequality (`>`) is the right call to prevent zero-second locks, which muddy semantic meaning. Allowing a user to lock until the year 3000 (no hard cap) is also correct; smart contracts should provide mechanisms, not paternalistic policies.

**8. No `permit` model & No extend/shorten (D-4 / D-6)**
Excellent restraint. By refusing to build a custom delegation ACL and relying purely on standard `object::transfer` for ownership changes, state complexity is drastically reduced. Forcing a `redeem` → `lock` cycle to alter durations ensures the security invariants remain perfectly linear.

---

## Overall verdict

🟢 **GREEN for Mainnet Publish.**

> This is a masterclass in writing minimal, composable, and secure Move code. By deferring access control to the Aptos framework (`object::owner` and `object::transfer`) and trusting the atomic rollback of the VM, you have created a zero-admin, zero-math satellite with an incredibly tight attack surface. You are clear for mainnet deployment.
