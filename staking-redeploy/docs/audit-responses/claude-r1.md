# Claude 4.7 fresh web — R1 Audit Response

**Received:** 2026-04-27
**Verdict:** GREEN
**Findings:** 0 HIGH / 1 MED / 1 LOW / 5 INFO

---

I'll work through the submission carefully — locker source, staking source, and the §12 areas of concern. Going to follow your requested output format exactly, and I've respected the false-positive list at the top of §1 (permissionless creation, no reward mandate, u128 INFO-S1).

## Findings

### MEDIUM-1: Pool match validated via metadata, not pool address — coupling to core invariant

**Module:** staking
**Location:** `staking.move:541-543`

**Description:**
```move
let (expected_a, expected_b) = pool::pool_tokens(rp.pool_addr);
assert!(fungible_asset::asset_metadata(&fa_a) == expected_a, E_WRONG_POOL);
assert!(fungible_asset::asset_metadata(&fa_b) == expected_b, E_WRONG_POOL);
```

The check verifies that the FA returned by `claim_lp_fees`/`claim_fees_assets` carries the metadata pair expected by `rp.pool_addr`. It does **not** verify that `position.pool_addr == rp.pool_addr` directly. Equivalence holds **iff** `darbitex::pool_factory` enforces a single Pool per ordered `(metadata_a, metadata_b)` pair — which §6 LOW-S1 acknowledges is "currently safe" but explicitly out-of-scope. The `LpPosition` struct (§9) carries `pool_addr` as a field, but core exposes no `#[view]` to read it, so satellite code cannot do the direct comparison.

**Impact:** This is the exact attack vector your §1 question 3 asks me to verify. Today, blocked by core's canonical-pair invariant. If a future core upgrade introduces fee tiers, stable/volatile variants, or a factory regression that allows two `Pool` resources at distinct addresses with the same `(metadata_a, metadata_b)`:

1. Attacker mints `LpPosition` X in pool A (`shares = S_A`, `pool_supply = L_A`).
2. Stakes X into a reward pool RP bound to pool B (`pool_supply = L_B`).
3. Metadata check passes (same pair).
4. Per-second emission becomes `(S_A / L_B) * max_rate_per_sec`. If `S_A > L_B`, this exceeds `max_rate_per_sec` — the design's intensity ceiling that backs the WARNING items 2-4 ("pure-proportional, no admin lever, no boost").

The R3 free-balance cap on `committed_rewards` still bounds total drainage to `phys`, so funds in RP are not over-withdrawn — but emissions can be drained at an arbitrary multiple of the documented rate, displacing legitimate pool-B stakers. This is the one class of attack the satellite-level invariants alone cannot prevent; it is structurally a contract between core and staking.

**Recommended fix:** Add to core (one new view, no state change):
```move
#[view] public fun position_pool_addr(pos: Object<LpPosition>): address acquires LpPosition {
    borrow_global<LpPosition>(object::object_address(&pos)).pool_addr
}
```

Then in `staking.move`, hoist the check above the transfer/claim block (currently line 528):
```move
let pos_pool = match (&inner) {
    StakedLp::Naked(p)  => pool::position_pool_addr(*p),
    StakedLp::Locked(l) => pool::position_pool_addr(lock::position_of(*l)),
};
assert!(pos_pool == rp.pool_addr, E_WRONG_POOL);
```

The metadata check at line 542 then becomes redundant defense-in-depth and can stay or be removed. This decouples staking from any future core invariant change. If you instead intend to contractually freeze the canonical-pair invariant as part of the immutable core ABI, document that explicitly in the staking WARNING — currently the invariant is implicit.

---

### LOW-1: `create_stake` transfers position and claims fees before pool match check

**Module:** staking
**Location:** `staking.move:528-545`

**Description:** In `create_stake`, the position is transferred to `stake_addr` and `pool::claim_lp_fees` (or `lock::claim_fees_assets`) is invoked **before** the metadata equality assertion. On mismatch, Move's transaction-level rollback reverts the transfer, the fee withdraw, and the `pool.locked` toggle. So no funds are lost.

**Impact:** Wasted gas on misrouted stakes. The user pays for a transfer + an external pool call + two FA deposits that are all undone. Diagnostic clarity also suffers — the abort point is mid-flow, not at entry. Not a security issue.

**Recommended fix:** If MEDIUM-1's hoisted check is adopted, this is naturally resolved (validate before commit). If MEDIUM-1 is deferred, reorder so the metadata pair from `rp.pool_addr` is fetched first and compared as soon as `fa_a, fa_b` exist (you already do this; just consider moving the entire match block after asserting that the position's metadata is at least *coherent* — though without the pool_addr view this is hard to do upfront).

---

### INFORMATIONAL-1: `redeem_position` destructures before checking unlock deadline

**Module:** lock
**Location:** `lock.move:338-340`

**Description:**
```move
let LockedPosition { position, unlock_at_seconds, extend_ref, delete_ref }
    = move_from<LockedPosition>(locker_addr);
assert!(timestamp::now_seconds() >= unlock_at_seconds, E_STILL_LOCKED);
```

The resource is `move_from`'d before the time-gate assertion. Move's abort semantics revert all state changes transactionally, so this is type-safe and functionally correct — `ExtendRef`/`DeleteRef` (no `drop`) need not be consumed because `abort` has bottom type, and the `move_from` itself is rolled back. §12 item 3 raises the same concern; my conclusion: no resource leak, no bug.

**Impact:** Cosmetic only. Convention would be:
```move
{
    let l = borrow_global<LockedPosition>(locker_addr);
    assert!(timestamp::now_seconds() >= l.unlock_at_seconds, E_STILL_LOCKED);
};
let LockedPosition { position, unlock_at_seconds: _, extend_ref, delete_ref }
    = move_from<LockedPosition>(locker_addr);
```

**Recommended fix:** Optional reorder for readability. Not blocking.

---

### INFORMATIONAL-2: Permanent dust accumulation in `committed_rewards`

**Module:** staking
**Location:** `staking.move:721, 725`

**Description:** `per_share_bump = paid * SCALE / staked` is floor-divided; `committed_rewards += paid` adds the full amount. The invariant `committed_rewards ≥ Σ_i pending_i` always holds (good — that's what protects against B3 over-credit), but the gap is unclaimable dust bounded by `staked / SCALE` per `update_pool` call. An additional truncation: an individual staker whose `shares × (current_acc - acc_at_stake) < SCALE` floors to zero pending — small stakers in pools with large `staked` may consistently earn 0 in a given window even as the pool emits.

**Impact:** Some reward tokens become permanently locked in the reward pool over its lifetime. Bounded magnitude. Not exploitable. Not a security issue. Worth noting since with `compatible` upgrade policy a future patch could add a `drain_dust` function gated on `total_staked_shares == 0` — but that would introduce an admin lever the design has rejected.

**Recommended fix:** None. Document in WARNING under "ROUNDING / DUST" if not already covered.

---

### INFORMATIONAL-3: u128 `acc_reward_per_share` overflow failure mode is DoS, not silent corruption

**Module:** staking
**Location:** `staking.move:724`

**Description:** Per §11 / §6 INFO-S1, `acc_reward_per_share: u128` can in theory overflow at ~1.8×10⁷ `update_pool` calls under adversarial parameters. Worth surfacing: Move arithmetic overflow **aborts** the transaction. So once the threshold is approached, every subsequent `update_pool` call aborts — meaning every `claim_rewards`, `unstake_*`, `deposit_rewards`, and `create_stake` against that reward pool aborts. Stakers can't claim, can't unstake, can't even deposit more rewards. The pool is bricked for emission, though stakes can still be unstaked **only if** their `unstake_*` path doesn't trigger `update_pool`'s overflow — which it does (line 633 / 672), so unstake also aborts.

This means the stakers' principal LP positions become **inaccessible** at u128 saturation, not just their unclaimed rewards. That's a more serious framing than "overflow at extreme scale."

**Impact:** Practical impossibility per INFO-S1's calculation (would require ~1.8e7 transactions with `max_rate_per_sec = u64::MAX`, `staked = 1`). But the failure mode is principal lock-out, not just reward loss. WARNING text should make this explicit.

**Recommended fix:** None on code — accept matches Sui R3+R4. Update WARNING to disclose the failure as "permanent emission halt and stake lockout" rather than implying the reward pool merely stops emitting. A defensive option: in `update_pool`, gate the `acc + per_share_bump` against u128 saturation and `return` early instead of aborting — preserves stake/unstake liveness even if emission halts. Probably unnecessary given the operating envelope.

---

### INFORMATIONAL-4: `claim_rewards` aborts on `pending == 0` after running `update_pool`

**Module:** staking
**Location:** `staking.move:572-575`

**Description:**
```move
update_pool(rp, rp_addr);
let pending = pending_reward(sp.shares, rp.acc_reward_per_share, sp.acc_at_stake);
assert!(pending > 0, E_NOTHING_CLAIMABLE);
```

`update_pool` mutates `acc_reward_per_share`, `last_reward_time_seconds`, `committed_rewards`. If `pending == 0`, the abort discards all of it. The next caller re-runs the same work fresh.

**Impact:** Caller A pays gas for `update_pool` work that's discarded; the next caller redoes it. Self-griefing only — no exploitation vector (attacker pays own gas to harm only themselves). `unstake_*` doesn't have this property because they don't abort on `pending == 0` (they conditionally pay).

**Recommended fix:** None required. If you want claim_rewards to be idempotent-with-clock-progress, return early on `pending == 0` without aborting. But that loses the explicit `E_NOTHING_CLAIMABLE` signal.

---

### INFORMATIONAL-5: Verify staking WARNING covers `LpStakePosition` transferability

**Module:** staking
**Location:** `staking.move:518` (and WARNING text at `staking.move:51`, body redacted in submission)

**Description:** `LpStakePosition` is created via `object::create_object(user_addr)`, which has ungated transfer enabled by default. No `TransferRef` is generated and no `disable_ungated_transfer` is called. Whoever owns the stake object can call `claim_rewards`, `claim_lp_fees`, and `unstake_*` — secondary transfer carries full economic rights (consistent with the locker's wrapper transferability in WARNING item 3 and the §11 design accept "LockedPosition wrapper transferable").

**Impact:** This is a deliberate, useful design property (custody transfer, secondary markets). But if the staking WARNING doesn't explicitly disclose it, users may assume their stake is principal-bound to their account.

**Recommended fix:** I can't see the full staking WARNING body (truncated in submission). Verify it includes a "STAKE WRAPPER TRANSFERABILITY" item analogous to locker WARNING item 3. If `warning_anchors_field_names` (test #23) doesn't already byte-anchor `object::transfer` or `transferable` for staking, add to the anchor list before sealing immutable. Sui R3+R4 likely had the equivalent disclosure.

---

## Verifications against §12 areas of concern

For the record, walking through each area you flagged:

1. **`update_pool` math under exhaustion + concurrent stakers.** The `committed ≤ phys` invariant holds inductively: `paid ≤ free = phys - committed`, then `committed' = committed + paid ≤ phys`. Decrements on claim/unstake are always by `pending`, and `Σ pending ≤ committed` (proven by induction over update_pool's per_share_bump floor div). The B3 fix is correct. ✓
2. **`stake_locked_lp` ownership transfer + claim sequence.** After `object::transfer(user, locked, stake_addr)`, `object::owner(locked) == stake_addr`. `stake_signer` is generated by `object::generate_signer(&ctor)` for the same `stake_addr`. `lock::claim_fees_assets`'s owner check `object::owner(locker) == signer::address_of(user)` passes. Inside, `lock` uses its own `extend_ref` to claim from the underlying `LpPosition` at `locker_addr`. No bypass. ✓
3. **`unstake_*` move_from + variant abort.** The `match (inner) { Locked(_) => abort E_NOT_NAKED }` (and symmetric for `unstake_locked`) discards a copyable `Object<...>` handle via `_`, then aborts. `extend_ref`/`delete_ref` have no `drop` ability but `abort: !` doesn't require them to be consumed; the transaction-level rollback restores the `LpStakePosition` resource. No leak, no orphan. ✓
4. **`lock::claim_fees_assets` callable by `stake_signer`.** Owner check `object::owner(locker) == user_addr` where `user_addr = stake_addr` (since locked was transferred there at stake time). The locker's `extend_ref` generates the locker_signer used for `pool::claim_lp_fees`. `LpPosition` ownership stays at `locker_addr` throughout. No path bypasses the owner check. ✓
5. **Enum dispatch.** All `match` sites in `create_stake`, `claim_lp_fees`, `unstake_naked`, `unstake_locked` have exhaustive arms (`Naked`, `Locked`). Where one variant is invalid (e.g., `unstake_naked` on `Locked`), the wrong arm aborts cleanly. The `&inner` borrow form copies the inner `Object<...>` handle (which has `copy + drop + store`), no double-move. ✓
6. **`pool::claim_lp_fees`'s `pool.locked` reentrancy.** `pool::claim_lp_fees` sets `pool.locked = true`, performs FA withdrawals (which don't call back into staking), emits an event, then `pool.locked = false`. No callable surface from inside it touches `LpRewardPool`. The `borrow_global_mut<LpRewardPool>` held by the staking caller is on a different resource type at a different address; no aliasing. ✓

## 3-firewall composition check

Traced explicitly: lock(unlock_at=T) → stake_locked_lp → time advances to t<T → unstake_locked (returns `Object<LockedPosition>` to user) → `lock::redeem_position(user, locked)` → owner check passes → `move_from<LockedPosition>` succeeds → `assert now >= T` aborts `E_STILL_LOCKED`. The inner `LpPosition` never leaves `locker_addr`. ✓

The only routes to extract `Object<LpPosition>` are:
- `pool::create_position` (admin / add_liquidity in core; not via this bundle)
- `lock::redeem_position` (gated on `now >= unlock_at_seconds`)
- `staking::unstake_naked` (returns position only if `inner == Naked`; aborts on `Locked`)

No path returns the inner `LpPosition` from a `Locked` stake. Firewall holds end-to-end, including under simulated staking-side compromise. ✓

---

## Overall verdict

**GREEN** for mainnet publish under `compatible` policy + stabilization soak.

The bundle is well-engineered. R3+R4 fixes ported from Sui are in place and correctly pre-empt the 8 prior bugs. The 3-firewall composition is correctly enforced at the type/privacy/runtime level — the inner `LpPosition` cannot leak from a `LockedPosition` before `unlock_at_seconds` regardless of staking-side bugs or future malicious upgrades. The `committed_rewards` / free-balance cap invariant is correctly maintained, closing the B3 over-credit class. u256 arithmetic prevents `pending_reward` overflow. Owner checks are consistent. Object lifecycle is clean. Events appear sufficient for indexer reconstruction.

**Pre-immutable-soak action recommended:** address MEDIUM-1 (pool match via address, not just metadata) — either by adding the `position_pool_addr` view to core and tightening the satellite check, or by explicitly contracting the canonical-pair invariant into the public core ABI and disclosing the dependency in the staking WARNING. Today's behavior is safe; the brittleness is in the coupling, not the current implementation. This is the only finding that materially affects the "satellite is self-contained" framing.

LOW-1 and the INFORMATIONAL items are quality-of-life and disclosure items — none block R1 or the 3/5 multisig promotion.

If you want, I can dig deeper into any specific finding — e.g., trace through MEDIUM-1 against your `pool_factory` source to confirm the canonical-pair contract, or write a Move test that demonstrates the cross-pool stake scenario assuming the invariant is breakable.
