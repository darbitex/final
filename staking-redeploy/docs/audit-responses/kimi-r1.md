# Kimi K2 — R1 Audit Response

**Received:** 2026-04-27
**Verdict:** GREEN
**Findings:** 0 HIGH / 0 MED / 0 LOW / 3 INFO

---

## Findings

### INFORMATIONAL-1: Reward-pool address omitted from claim events
**Module:** staking  
**Location:** `staking.move:340-343` (`LpRewardsClaimed`), `staking.move:370-373` (`LpFeesClaimed`)  
**Description:** Neither `LpRewardsClaimed` nor `LpFeesClaimed` includes the `reward_pool_addr`. Off-chain indexers must perform a state lookup from `stake_addr → LpStakePosition → reward_pool_addr` to attribute the claim to the correct pool stream.  
**Impact:** Minor indexing friction; no runtime security impact.  
**Recommended fix:** Add `reward_pool_addr: address` to both event structs if indexer ergonomics are a priority.

---

### INFORMATIONAL-2: Unassigned dust accumulation in `committed_rewards`
**Module:** staking  
**Location:** `staking.move:474-505` (`update_pool`)  
**Description:** Standard MasterChef floor semantics mean `committed_rewards` (which increments by the full `paid` amount) can drift slightly above the sum of all individually-computable `pending_reward` values. The delta is trapped as unassigned dust until a future staker's `acc_at_stake` is low enough to absorb it. This is the expected behavior of `floor(shares×acc/SCALE)` arithmetic and is bounded by `staked/SCALE` per `update_pool` call.  
**Impact:** None; dust remains in the pool's free balance and is not extractable by any party.  
**Recommended fix:** None — document and accept (already acknowledged in design accepts).

---

### INFORMATIONAL-3: Permanent storage of empty `LpRewardPool` objects
**Module:** staking  
**Location:** `staking.move:115-135` (`create_reward_pool`)  
**Description:** `LpRewardPool` is created with an `extend_ref` but no `delete_ref`. Once minted, the object and its resource can never be deleted, even if `total_staked_shares` and `committed_rewards` are both zero.  
**Impact:** Negligible — bounded by the gas cost of creation. No staker funds are at risk.  
**Recommended fix:** None — permissionless creation makes pool retirement a non-goal.

---

## Overall verdict

**GREEN** for mainnet publish readiness.

### Security assessment summary

| Axis | Result | Notes |
|---|---|---|
| **Authorization** | ✅ Pass | Every privileged path (`claim_*`, `unstake_*`, `redeem_*`) asserts `object::owner(...) == signer::address_of(user)`. Staking correctly proxies locker owner checks via `stake_signer`. |
| **Fund safety** | ✅ Pass | `committed_rewards + free = phys` invariant holds; `paid ≤ free` prevents over-credit (B3). No early-unlock path exists; 3-firewall composition verified. |
| **Pool validation** | ✅ Pass | `create_stake` asserts claimed-fee metadata against `pool::pool_tokens(rp.pool_addr)` before resource creation (B5). Wrong-pool positions abort with `E_WRONG_POOL=3`. |
| **Accumulator math** | ✅ Pass | B1–B8 fixes are correctly ported: `paid==0` early-return (B1), ceiling division for `accounted_seconds` (B2), `committed_rewards` cap (B3), u256 intermediate math (B4), standard floor-of-each-term pending (B6), `per_share_bump==0` dust guard (B7). |
| **Composition (3-firewall)** | ✅ Pass | `LpPosition` never leaves `locker_addr` until `redeem_position`. Staking only ever handles `Object<LockedPosition>` (handle), never the inner position. `lock_invariant_after_unstake_locked` test validates end-to-end. |
| **Object lifecycle** | ✅ Pass | `delete_ref` is stored at creation and consumed in every destruction path (`redeem_position`, both `unstake_*`). Abort after `move_from` reverts atomically; no orphan risk. |
| **Reentrancy** | ✅ Pass | `pool::claim_lp_fees` uses a `pool.locked` guard. No callbacks into staking exist. |
| **Event completeness** | ✅ Pass | All state-mutating entry functions emit events. Minor suggestion per INFO-1 above. |

No HIGH, MEDIUM, or LOW severity findings were identified. The two modules implement a clean, minimal surface with correct Move 2 enum usage and faithfully reproduce the Sui R3+R4 hardened design.
