# Qwen — R1 Audit Response

**Received:** 2026-04-27
**Verdict:** YELLOW
**Findings:** 1 HIGH / 1 MED / 1 LOW / 2 INFO

---

## Findings

### HIGH-1: Unsafe `move_from` precedes validation in `redeem_position`, `unstake_naked`, and `unstake_locked`
Module: lock | staking
Location: `lock.move:148-150`, `staking.move:378-381`, `staking.move:421-424`
Description: All three functions call `move_from` to destructure the target resource *before* performing the critical validation (`timestamp` check in locker, variant match in staking). If the subsequent `assert!` or `abort` triggers, the destructured fields (`extend_ref`, `delete_ref`, `Object<T>`) are left in scope without `drop` capability. In Move semantics, this either causes a hard compiler error or, if compiled under permissive toolchain configurations, results in permanent resource loss or undefined runtime behavior when the transaction aborts.
Impact: Violates abort-safety guarantees. If triggered, the contract will either fail to compile (blocking mainnet publish) or permanently brick LP positions and stake objects, freezing user funds and breaking object lifecycle invariants.
Recommended fix: Move validation logic **before** `move_from`. 
- For `redeem_position`: `assert!(timestamp::now_seconds() >= borrow_global<LockedPosition>(locker_addr).unlock_at_seconds, E_STILL_LOCKED);` then `let LockedPosition { ... } = move_from...`.
- For `unstake_*`: Borrow the `inner` field to check the variant before `move_from`, or reconstruct the resource and `move_to` it back if the variant check fails. Never leave non-droppable fields in scope across an abort boundary.

### MEDIUM-1: `acc_at_stake` updated before reward withdrawal in `claim_rewards`
Module: staking
Location: `staking.move:333-337`
Description: `claim_rewards` updates `sp.acc_at_stake = rp.acc_reward_per_share` and decrements `rp.committed_rewards` *before* calling `primary_fungible_store::withdraw`. While Aptos transactions are fully atomic and a withdrawal failure would revert all state changes, this ordering is a best-practice anti-pattern. If framework behavior changes or cross-contract callbacks are introduced in future upgrades, mutating accounting state before an external/FA call opens a window for inconsistent ledger states.
Impact: Low immediate risk due to atomicity, but increases maintenance debt and audit surface for future composability. Could complicate downstream integrations that rely on immediate state consistency.
Recommended fix: Defer state mutations until after successful withdrawal: calculate `pending`, call `withdraw`, then update `acc_at_stake` and `committed_rewards`. Alternatively, wrap in a temporary variable and commit only on success.

### LOW-1: `claim_lp_fees` proxy does not sync reward pool accumulator
Module: staking
Location: `staking.move:345-368`
Description: `claim_lp_fees` allows users to harvest LP trading fees without calling `update_pool`. This is functionally correct and intentional, but means that calling `claim_lp_fees` will not advance `acc_reward_per_share` or `last_reward_time_seconds`. View functions or downstream indexers querying `stake_pending_reward` immediately after a fee claim may see slightly stale reward accrual data until the next `update_pool` trigger.
Impact: Purely informational/view-layer desync. No fund safety or math implications.
Recommended fix: Document explicitly in comments that `claim_lp_fees` is side-effect-free for the reward accumulator. No code change required.

### INFORMATIONAL-1: `FungibleAsset` return types in `claim_fees_assets` require explicit downstream handling
Module: lock
Location: `lock.move:128`
Description: `claim_fees_assets` returns raw `(FungibleAsset, FungibleAsset)` objects. The entry wrapper `claim_fees` correctly deposits them to the primary store, but any downstream protocol composing against the public `claim_fees_assets` must remember to deposit or burn the assets. Dropping them without handling will trigger framework-level asset destruction.
Impact: Standard integration caveat. No vulnerability, but requires clear downstream documentation to prevent accidental user fund loss in wrapper contracts.
Recommended fix: Add explicit `@dev` warning in docstring. Consider returning a typed wrapper or requiring a `&signer` for automatic deposit in a future version if composability expands.

### INFORMATIONAL-2: `LpRewardPool` lacks `delete_ref` → permanent storage occupation
Module: staking
Location: `staking.move:89`
Description: `LpRewardPool` stores only an `extend_ref`. Without a `delete_ref`, deployed reward pools cannot be destroyed, even if balance reaches zero and creator intends to abandon them. This aligns with the "permissionless multi-stream" design accept, but implies unbounded storage growth for unused/junk pools.
Impact: Minor long-term storage cost on-chain. No security risk.
Recommended fix: Intentional per §11 Design Accepts. Monitor storage rent economics if Aptos introduces account storage fees in the future.

## Overall verdict
**YELLOW** for mainnet publish readiness.

The architecture, accumulator math, and 3-firewall composition are well-designed and correctly implement the 8 pre-empted R3+R4 fixes. However, **HIGH-1** is a structural abort-safety violation that must be resolved before deployment. Once the validation-before-`move_from` ordering is corrected across `redeem_position`, `unstake_naked`, and `unstake_locked`, the package is ready for a **GREEN** verdict. All other findings are low-risk or align with documented design accepts.
