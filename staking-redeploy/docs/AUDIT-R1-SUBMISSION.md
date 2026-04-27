# Darbitex LP Locker + LP Staking — External Audit Submission (Round 1)

**Bundle:** `darbitex_lp_locker` (locker, ~210 LoC) + `darbitex_staking` (staking, ~480 LoC) — published as one multisig deploy
**Chain:** Aptos mainnet
**Aptos CLI:** 9.1.0 (Move 2 with native enum support)
**Core dependency:** `darbitex::pool` at `0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd` (Darbitex Final v0.2.0, live on mainnet, 3/5 multisig, `compatible`)
**Publisher (planned):** new 1/5 multisig (same 5 owners as Darbitex Final), raised to 3/5 after smoke test
**Upgrade policy:** `compatible` during stabilization soak, intended `immutable` post-soak
**Test status at submission:** 10 locker tests + 24 staking tests, all PASS, zero compile warnings

This is a redeploy of two prior packages that are already live on mainnet:
- v1 locker `0x45aeb402...` (compatible, 3/5)
- v1 staking `0xeec9f236...` (compatible, 3/5)

The v1 packages cannot be patched in-place because the redeploy adds new struct fields and refactors `reward_debt → acc_at_stake` (breaking compat-policy guarantees). New addresses required.

---

## 1. What we are asking from you

You are reviewing **two Move source files** that compose. Locker wraps an `Object<LpPosition>` with a one-way time gate. Staking wraps EITHER a naked `Object<LpPosition>` OR a `Object<LockedPosition>` from the locker, distributing FA reward tokens via a MasterChef-style accumulator. We want an **independent security review** focused on:

1. **Authorization correctness** — can any unauthorized party claim rewards, claim LP fees, redeem locked LP, or unstake someone else's position?
2. **Fund safety** — can LP positions be permanently bricked? Can the underlying `LpPosition` exit a `LockedPosition` before `unlock_at_seconds`? Can reward tokens be siphoned by an attacker?
3. **Pool validation** — can an attacker stake an LP position from pool A into a reward pool bound to pool B and earn rewards meant for pool-B stakers?
4. **Accumulator math** — is the MasterChef reward distribution correct under all edge cases? Can `update_pool` over-credit, dust-leak, or grief stakers? Are the 8 R3+R4 fixes (see §4) actually closing the bugs they target?
5. **Composition (3-firewall)** — when a `LockedPosition` is staked, does the lock invariant hold end-to-end? Specifically: can any sequence of staking-package calls result in the inner `LpPosition` reaching the user before `unlock_at_seconds`?
6. **Object lifecycle** — clean creation/deletion, no dangling refs, no orphaned resources.
7. **Event completeness** — do events capture all state mutations sufficient for indexer reconstruction?
8. **Unknown unknowns** — anything we missed.

**Output format expected:**

```
## Findings

### HIGH-1: <title>
Module: lock | staking
Location: <file>.move:<line>
Description: <what>
Impact: <why it matters>
Recommended fix: <how>

### MEDIUM-1: ...
### LOW-1: ...
### INFORMATIONAL-1: ...

## Overall verdict
GREEN / YELLOW / RED for mainnet publish readiness
```

False positives we want flagged but don't intend to fix:
- Permissionless reward pool creation (multiple per Darbitex pool, by design — see WARNING item 1 + `feedback_no_singleton_reward_pools`)
- No initial-reward mandate (unknowable token value/supply — see WARNING item 11)
- u128 `acc_reward_per_share` theoretical overflow at ~1.8e7 calls with extreme params (Sui R3+R4 design accept)

---

## 2. Architecture overview

### Two packages, one bundle

```
                     ┌──────────────────────────┐
                     │   darbitex::pool         │  (live mainnet, untouched)
                     │   - LpPosition           │
                     │   - claim_lp_fees        │
                     │   - lp_supply            │
                     │   - position_shares      │
                     │   - pool_tokens          │
                     │   - pool_exists          │
                     └──────────┬───────────────┘
                                │ (used by)
            ┌───────────────────┴──────────────────────┐
            │                                          │
┌───────────▼───────────┐                  ┌───────────▼──────────────┐
│ darbitex_lp_locker    │                  │ darbitex_staking         │
│   ::lock              │                  │   ::staking              │
│ - LockedPosition      │◀── (depends on) ─┤ - LpRewardPool           │
│   wraps Object<LpPos> │                  │ - StakedLp enum          │
│ - claim_fees_assets   │                  │   { Naked, Locked }      │
│ - redeem_position     │                  │ - LpStakePosition        │
│ - WARNING             │                  │ - WARNING                │
└───────────────────────┘                  └──────────────────────────┘
```

Staking depends on locker. Locker depends only on core pool. Core is unchanged (no upgrade required for this redeploy).

### 3-firewall composition for locked-staked LP

When a user locks an LP position then stakes the locker wrapper:

```
USER                  LOCKER                STAKING
─────                 ───────               ────────
LpPosition  ──lock─▶  LockedPosition  ──stake_locked_lp─▶  LpStakePosition
                       (owns LpPosition)                    (owns LockedPosition,
                       unlock_at_seconds=T                   inner=Locked(handle))
```

Three independent invariants protect the inner `LpPosition`:

1. **Aptos object ownership (runtime).** `LpPosition` is owned by `locker_addr`. To extract it requires a signer for `locker_addr`, which only the locker module can produce (via `extend_ref`).
2. **Staking module privacy (compile-time).** The `StakedLp::Locked(Object<LockedPosition>)` variant is destructured ONLY inside `unstake_locked`, which returns the `Object<LockedPosition>` (still gated) — never the inner `LpPosition`.
3. **Locker time-gate (compile-time + runtime).** The `LockedPosition` resource's destructure happens ONLY in `lock::redeem_position`, which asserts `now >= unlock_at_seconds`.

Even if staking were fully compromised — bug, malicious upgrade, etc. — the inner `LpPosition` cannot leave the locker before `unlock_at_seconds` because firewall 3 is enforced inside the locker module's privacy boundary.

The submission test `lock_invariant_after_unstake_locked` exercises this: stake a locked LP, unstake it (returning `Object<LockedPosition>` to the user), then attempt `lock::redeem` on the wrapper before `unlock_at_seconds` — must abort `E_STILL_LOCKED=2`.

### Emission formula (staking)

```
emission_rate = total_staked_shares / pool::lp_supply * max_rate_per_sec
```

Pure-proportional, pool-derived denominator, no `stake_target`, no admin lever, no boost. Distribution intensity = community participation only. See WARNING items 2-4 for full design rationale.

---

## 3. Entry surface

### Locker

| Function | Type | Args | Effect |
|---|---|---|---|
| `lock_position` | entry | `(user, position, unlock_at_seconds)` | Lock a position. Wrapper transferred to `signer::address_of(user)`. |
| `lock_position_and_get` | non-entry public | same | Same + returns `Object<LockedPosition>` handle. |
| `claim_fees_assets` | non-entry public | `(user, locker)` | Returns `(FungibleAsset, FungibleAsset)` for caller to route. |
| `claim_fees` | entry | `(user, locker)` | Wraps `claim_fees_assets`, deposits to user primary store. |
| `redeem_position` | non-entry public | `(user, locker)` | Consumes wrapper, transfers `LpPosition` to user, returns its handle. Aborts unless `now >= unlock_at_seconds`. |
| `redeem` | entry | `(user, locker)` | Wraps `redeem_position`. |
| `unlock_at_seconds` | view | `(locker)` | Stored deadline. |
| `is_unlocked` | view | `(locker)` | `now >= unlock_at_seconds`. |
| `position_of` | view | `(locker)` | Wrapped `Object<LpPosition>` handle. |
| `position_shares` | view | `(locker)` | Proxies `pool::position_shares` on the wrapped position. |
| `read_warning` | view | `()` | On-chain disclosure. |

### Staking

| Function | Type | Args | Effect |
|---|---|---|---|
| `create_lp_reward_pool` | entry | `(creator, pool_addr, reward_token, max_rate_per_sec)` | Mint a fresh `Object<LpRewardPool>`. Multiple per Darbitex pool allowed. No fee. |
| `deposit_rewards` | entry | `(depositor, rp, amount)` | Permissionless top-up. |
| `stake_lp` | entry | `(user, rp, position)` | Stake naked. |
| `stake_locked_lp` | entry | `(user, rp, locked)` | Stake locker wrapper. |
| `claim_rewards` | entry | `(user, stake)` | Harvest emission rewards. |
| `claim_lp_fees` | entry | `(user, stake)` | Proxy LP fees from inner variant. |
| `unstake_naked` | entry | `(user, stake)` | Aborts `E_NOT_NAKED=6` if inner is `Locked`. |
| `unstake_locked` | entry | `(user, stake)` | Aborts `E_NOT_LOCKED=7` if inner is `Naked`. Returns `Object<LockedPosition>` (still gated). |
| `reward_pool_info` | view | `(rp)` | `(pool_addr, reward_token, max_rate_per_sec, total_staked_shares, phys_balance, committed_rewards)` |
| `stake_info` | view | `(stake)` | `(reward_pool_addr, source_addr, shares, locked_variant: bool)` |
| `current_emission_rate_per_sec` | view | `(rp)` | Live rate given current state. |
| `staked_fraction_bps` | view | `(rp)` | Adoption metric. |
| `unstaked_lp_shares` | view | `(rp)` | `pool::lp_supply − total_staked_shares`. |
| `stake_pending_reward` | view | `(stake)` | Pending given current state. |
| `read_warning` | view | `()` | On-chain disclosure. |

---

## 4. R3+R4 bug pre-empt — the 8 findings ported back from Sui audit

This staking redeploy is the **Aptos port of the Sui staking design** at pkg `0x1647e7c5...` (sealed immutable on Sui mainnet 2026-04-27 after 4 audit rounds: R1, R2, R3, R4). 8 bugs were found and fixed during those rounds. Each is pre-empted in this Aptos redeploy:

| # | Bug | Origin | Mechanism in this redeploy | Source line |
|---|---|---|---|---|
| 1 | **Dust-spam clock advance grief** — `update_pool` advances `last_reward_time_*` even when `total_reward` truncates to 0 → attacker calls `deposit_rewards(1)` repeatedly, each call advances clock without distributing reward, fractional emission permanently lost | Gemini R1 MED-1 | `if (paid == 0) return` in `update_pool` — clock pinned, elapsed accumulates as future credit | `staking.move:488` |
| 2 | **`accounted_seconds = 0` truncation re-emission** — floor division of `accounted_seconds` truncates to 0 when `paid·supply < staked·max_rate`, leaving clock stalled while `acc` bumped → repeated calls re-emit against same elapsed window | Kimi R2 HIGH-1, DeepSeek R2 MED-1 | Ceiling division: `(paid·supply + denom − 1) / denom` guarantees `accounted_seconds ≥ 1` when `paid > 0` | `staking.move:502-503` |
| 3 | **Over-credit via physical-balance cap** ⚠ CRITICAL — `update_pool` caps emission against PHYSICAL balance instead of FREE balance (physical − unclaimed-pending). Repeated calls re-emit against committed-but-unclaimed coins. Eventually pending > balance → claim/unstake aborts permanently → stakers' LP locked | Claude R2 HIGH-1 | `committed_rewards: u64` field tracks pending Σ. `free = phys − committed`. `paid ≤ free`. `committed += paid`. Symmetric decrement on claim/unstake. | `staking.move:474-484` |
| 4 | **u128 overflow in `(shares × acc) / SCALE`** — intermediate overflows u128 with large position × long-lived pool × high max_rate. Worst case: shares=10^12, acc=10^31 → product = 10^43 > u128 max (3.4·10^38) | Claude/Kimi R2 MED-1 | `pending_reward` computes in u256: `(shares as u256) * (current_acc as u256) / SCALE` for both terms | `staking.move:510-516` |
| 5 | **Missing pool match assert** — claim_lp_fees relies on downstream to assert pool match; mismatched pool aborts deep with confusing error | Kimi R2 LOW-1 | At stake-time: `fungible_asset::asset_metadata(&fa_a) == expected_a` from `pool::pool_tokens(rp.pool_addr)` enforces 1:1 binding before resource creation. Aborts `E_WRONG_POOL=3`. (R3 fix-D from Sui — Aptos doesn't have caller-supplied pool, so deferred-cross-check is N/A; binding at stake suffices.) | `staking.move:268-270` |
| 6 | **MasterChef rounding semantic** — `pending = floor(shares × delta / SCALE)` underpays vs standard `floor(shares × current_acc / SCALE) − floor(shares × acc_at_stake / SCALE)` | Kimi R3 INFO-1 | Uses standard floor-of-each-term form in u256 | `staking.move:512-515` |
| 7 | **Dust leak when `per_share_bump = 0`** — when `paid · SCALE < staked`, per-share bump truncates to 0 but `committed_rewards += paid` still runs → dust accumulates that's never claimable | Claude R3 INFO-1 | `if (per_share_bump == 0) return` early — clock not advanced, paid stays in free balance for next call | `staking.move:492-493` |
| 8 | **WARNING text drift on field renames** — refactor renames fields but forgets to update WARNING bytes literal; once sealed immutable, mismatch permanent | Kimi+Claude R3 INFO-3 | WARNING references each field/concept by name. Test `warning_anchors_field_names` byte-anchors 10 tokens (`acc_at_stake`, `committed_rewards`, `max_rate_per_sec`, `acc_reward_per_share`, `total_staked_shares`, `pool::lp_supply`, `staked_fraction_bps`, `unstaked_lp_shares`, `darbitex_lp_locker`, `E_WRONG_POOL`). Renaming any breaks the test. | `staking.move:51` (WARNING) + `staking_tests.move:1400-1409` |

---

## 5. Error codes

### Locker (`darbitex_lp_locker::lock`)

| Code | Constant | Used in |
|---|---|---|
| 1 | `E_NOT_OWNER` | `claim_fees_assets`, `redeem_position` |
| 2 | `E_STILL_LOCKED` | `redeem_position` (when `now < unlock_at_seconds`) |
| 3 | `E_INVALID_UNLOCK` | `lock_position_and_get` (when `unlock_at_seconds ≤ now`) |

### Staking (`darbitex_staking::staking`)

| Code | Constant | Used in |
|---|---|---|
| 1 | `E_NOT_OWNER` | `claim_rewards`, `claim_lp_fees`, `unstake_naked`, `unstake_locked` |
| 2 | `E_ZERO_AMOUNT` | `deposit_rewards` (amount=0), `create_stake` (shares=0) |
| 3 | `E_WRONG_POOL` | `create_reward_pool` (pool doesn't exist), `create_stake` (metadata mismatch) |
| 4 | `E_NOTHING_CLAIMABLE` | `claim_rewards` (pending=0) |
| 5 | `E_BAD_PARAMS` | `create_reward_pool` (max_rate_per_sec=0) |
| 6 | `E_NOT_NAKED` | `unstake_naked` (inner is Locked) |
| 7 | `E_NOT_LOCKED` | `unstake_locked` (inner is Naked) |

---

## 6. Self-audit findings (pre-submission)

Per `feedback_satellite_self_audit`, structured 8-axis self-audit (ABI / args / math / reentrancy / edges / interactions / errors / events). Result: **0 HIGH, 0 MED, 1 LOW (out-of-scope), 3 INFO** — none blocking R1.

### Locker
- **INFO-L1 (applied):** `read_warning` lacked `#[view]` annotation — added. Behavior-equivalent.

### Staking
- **INFO-S1 (Sui design accept):** `acc_reward_per_share: u128` could theoretically overflow after ~1.8·10^7 `update_pool` calls with adversarial parameters (max_rate_per_sec = u64::MAX, staked = 1, SCALE = 10^12 → bump per call up to 1.8·10^31). u128 max is ~3.4·10^38. Practical impossibility (would require ~2·10^7 transactions, each with extreme params), but theoretically reachable. Sui R3+R4 audit accepted this with no fix — same conclusion here. **Document, no code change.**
- **INFO-S2 (applied):** `read_warning` lacked `#[view]` — added.
- **LOW-S1 (out-of-scope):** Pool match check at stake-time relies on `pool_factory` enforcing canonical-pair invariant (one Pool per ordered metadata pair). If a future Darbitex core upgrade allows two pools with same metadata, the check becomes ambiguous. **Currently safe** — `pool_factory::create_canonical_pool` enforces this at the core level. Out-of-scope for this submission.

---

## 7. Module 1 — Locker source (`darbitex_lp_locker::lock`)

Full source, ~210 LoC.

```move
/// Darbitex LP Locker — time-locked wrapper for darbitex::pool::LpPosition.
///
/// `lock_position` consumes an `Object<LpPosition>` and produces a
/// `LockedPosition` Aptos object resource carrying an `unlock_at_seconds`
/// deadline. `redeem_position` consumes the wrapper and returns the
/// underlying `LpPosition` once `now >= unlock_at_seconds`. `claim_fees`
/// is open throughout the lock period and proxies into
/// `darbitex::pool::claim_lp_fees`.
///
/// `claim_fees_assets` and `redeem_position` are non-entry public
/// primitives that return values directly to the caller. Downstream
/// wrappers (staking, lending, vesting) compose against these.
/// `claim_fees` and `redeem` are thin entry wrappers that forward to
/// the caller's primary store / wallet for direct end-user use.
///
/// Zero admin. No global registry. No pause, no extend, no early-unlock
/// path. The destructure of `LockedPosition` is module-private; the
/// only route to the inner `LpPosition` is `redeem_position` after the
/// deadline.

module darbitex_lp_locker::lock {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, FungibleAsset};
    use aptos_framework::object::{Self, Object, ExtendRef, DeleteRef};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool::{Self, LpPosition};

    const E_NOT_OWNER: u64 = 1;
    const E_STILL_LOCKED: u64 = 2;
    const E_INVALID_UNLOCK: u64 = 3;

    const WARNING: vector<u8> = b"DARBITEX LP LOCKER is a time-lock satellite ... [10-item disclosure, ~5400 bytes; full text in source file]";

    struct LockedPosition has key {
        position: Object<LpPosition>,
        unlock_at_seconds: u64,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    #[event] struct Locked has drop, store {
        locker_addr: address, owner: address, position_addr: address, unlock_at_seconds: u64,
    }
    #[event] struct FeesClaimed has drop, store {
        locker_addr: address, owner: address, position_addr: address, fees_a: u64, fees_b: u64,
    }
    #[event] struct Redeemed has drop, store {
        locker_addr: address, owner: address, position_addr: address,
    }

    public entry fun lock_position(
        user: &signer, position: Object<LpPosition>, unlock_at_seconds: u64,
    ) { let _ = lock_position_and_get(user, position, unlock_at_seconds); }

    public fun lock_position_and_get(
        user: &signer, position: Object<LpPosition>, unlock_at_seconds: u64,
    ): Object<LockedPosition> {
        let now = timestamp::now_seconds();
        assert!(unlock_at_seconds > now, E_INVALID_UNLOCK);

        let user_addr = signer::address_of(user);
        let ctor = object::create_object(user_addr);
        let locker_signer = object::generate_signer(&ctor);
        let locker_addr = signer::address_of(&locker_signer);
        let extend_ref = object::generate_extend_ref(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        object::transfer(user, position, locker_addr);
        let position_addr = object::object_address(&position);

        move_to(&locker_signer, LockedPosition {
            position, unlock_at_seconds, extend_ref, delete_ref,
        });

        event::emit(Locked { locker_addr, owner: user_addr, position_addr, unlock_at_seconds });
        object::object_from_constructor_ref<LockedPosition>(&ctor)
    }

    public fun claim_fees_assets(
        user: &signer, locker: Object<LockedPosition>,
    ): (FungibleAsset, FungibleAsset) acquires LockedPosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(locker) == user_addr, E_NOT_OWNER);

        let locker_addr = object::object_address(&locker);
        let l = borrow_global<LockedPosition>(locker_addr);
        let locker_signer = object::generate_signer_for_extending(&l.extend_ref);
        let position = l.position;
        let position_addr = object::object_address(&position);

        let (fa_a, fa_b) = pool::claim_lp_fees(&locker_signer, position);
        let fees_a = fungible_asset::amount(&fa_a);
        let fees_b = fungible_asset::amount(&fa_b);

        event::emit(FeesClaimed { locker_addr, owner: user_addr, position_addr, fees_a, fees_b });
        (fa_a, fa_b)
    }

    public entry fun claim_fees(
        user: &signer, locker: Object<LockedPosition>,
    ) acquires LockedPosition {
        let (fa_a, fa_b) = claim_fees_assets(user, locker);
        let user_addr = signer::address_of(user);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);
    }

    public fun redeem_position(
        user: &signer, locker: Object<LockedPosition>,
    ): Object<LpPosition> acquires LockedPosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(locker) == user_addr, E_NOT_OWNER);

        let locker_addr = object::object_address(&locker);
        let LockedPosition { position, unlock_at_seconds, extend_ref, delete_ref }
            = move_from<LockedPosition>(locker_addr);
        assert!(timestamp::now_seconds() >= unlock_at_seconds, E_STILL_LOCKED);

        let locker_signer = object::generate_signer_for_extending(&extend_ref);
        object::transfer(&locker_signer, position, user_addr);
        let position_addr = object::object_address(&position);

        object::delete(delete_ref);

        event::emit(Redeemed { locker_addr, owner: user_addr, position_addr });
        position
    }

    public entry fun redeem(
        user: &signer, locker: Object<LockedPosition>,
    ) acquires LockedPosition { let _ = redeem_position(user, locker); }

    #[view] public fun unlock_at_seconds(l: Object<LockedPosition>): u64 acquires LockedPosition {
        borrow_global<LockedPosition>(object::object_address(&l)).unlock_at_seconds
    }
    #[view] public fun is_unlocked(l: Object<LockedPosition>): bool acquires LockedPosition {
        let unlock = borrow_global<LockedPosition>(object::object_address(&l)).unlock_at_seconds;
        timestamp::now_seconds() >= unlock
    }
    #[view] public fun position_of(l: Object<LockedPosition>): Object<LpPosition> acquires LockedPosition {
        borrow_global<LockedPosition>(object::object_address(&l)).position
    }
    #[view] public fun position_shares(l: Object<LockedPosition>): u64 acquires LockedPosition {
        let pos = borrow_global<LockedPosition>(object::object_address(&l)).position;
        pool::position_shares(pos)
    }
    #[view] public fun read_warning(): vector<u8> { WARNING }
}
```

WARNING text (truncated above for brevity) is the full 10-item disclosure verbatim — see `lp-locker-redeploy/sources/lock.move:39` for the literal bytes. Items: (1) ONE-WAY TIME GATE, (2) CLOCK SOURCE, (3) WRAPPER TRANSFERABILITY, (4) FEE PROXY, (5) POOL DEPENDENCY, (6) NO RESCUE, (7) NO COMPOSITION GUARANTEES, (8) UPGRADE POLICY, (9) AUTHORSHIP/AUDIT DISCLOSURE, (10) UNKNOWN FUTURE LIMITATIONS.

---

## 8. Module 2 — Staking source (`darbitex_staking::staking`)

Full source ~480 LoC. Reproduced inline below; nothing redacted except WARNING text body (verbatim 14-item disclosure in source file at `staking-redeploy/sources/staking.move:51`).

```move
module darbitex_staking::staking {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, Metadata};
    use aptos_framework::object::{Self, Object, ExtendRef, DeleteRef};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool::{Self, LpPosition};
    use darbitex_lp_locker::lock::{Self, LockedPosition};

    const E_NOT_OWNER: u64 = 1;
    const E_ZERO_AMOUNT: u64 = 2;
    const E_WRONG_POOL: u64 = 3;
    const E_NOTHING_CLAIMABLE: u64 = 4;
    const E_BAD_PARAMS: u64 = 5;
    const E_NOT_NAKED: u64 = 6;
    const E_NOT_LOCKED: u64 = 7;

    const SCALE: u128 = 1_000_000_000_000;

    const WARNING: vector<u8> = b"DARBITEX LP STAKING is an agnostic adoption/retention distribution primitive ... [14-item disclosure, ~7800 bytes]";

    struct LpRewardPool has key {
        pool_addr: address,
        reward_token: Object<Metadata>,
        max_rate_per_sec: u64,
        acc_reward_per_share: u128,
        last_reward_time_seconds: u64,
        total_staked_shares: u64,
        committed_rewards: u64,
        extend_ref: ExtendRef,
    }

    enum StakedLp has store {
        Naked(Object<LpPosition>),
        Locked(Object<LockedPosition>),
    }

    struct LpStakePosition has key {
        reward_pool_addr: address,
        inner: StakedLp,
        shares: u64,
        acc_at_stake: u128,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    #[event] struct LpRewardPoolCreated has drop, store {
        creator: address, reward_pool_addr: address, pool_addr: address,
        reward_token: address, max_rate_per_sec: u64,
    }
    #[event] struct LpRewardsDeposited has drop, store {
        depositor: address, reward_pool_addr: address, amount: u64, new_balance: u64,
    }
    #[event] struct LpStaked has drop, store {
        user: address, stake_addr: address, reward_pool_addr: address,
        source_addr: address, shares: u64, locked_variant: bool,
    }
    #[event] struct LpRewardsClaimed has drop, store {
        user: address, stake_addr: address, amount: u64,
    }
    #[event] struct LpFeesClaimed has drop, store {
        user: address, stake_addr: address, fees_a: u64, fees_b: u64, locked_variant: bool,
    }
    #[event] struct LpUnstaked has drop, store {
        user: address, stake_addr: address, reward_pool_addr: address, source_addr: address,
        shares: u64, rewards_claimed: u64, locked_variant: bool,
    }

    public entry fun create_lp_reward_pool(
        creator: &signer, pool_addr: address, reward_token: Object<Metadata>, max_rate_per_sec: u64,
    ) { let _ = create_reward_pool(creator, pool_addr, reward_token, max_rate_per_sec); }

    fun create_reward_pool(
        creator: &signer, pool_addr: address, reward_token: Object<Metadata>, max_rate_per_sec: u64,
    ): Object<LpRewardPool> {
        assert!(pool::pool_exists(pool_addr), E_WRONG_POOL);
        assert!(max_rate_per_sec > 0, E_BAD_PARAMS);

        let creator_addr = signer::address_of(creator);
        let ctor = object::create_object(creator_addr);
        let rp_signer = object::generate_signer(&ctor);
        let rp_addr = signer::address_of(&rp_signer);

        move_to(&rp_signer, LpRewardPool {
            pool_addr, reward_token, max_rate_per_sec,
            acc_reward_per_share: 0,
            last_reward_time_seconds: timestamp::now_seconds(),
            total_staked_shares: 0,
            committed_rewards: 0,
            extend_ref: object::generate_extend_ref(&ctor),
        });

        event::emit(LpRewardPoolCreated {
            creator: creator_addr, reward_pool_addr: rp_addr, pool_addr,
            reward_token: object::object_address(&reward_token), max_rate_per_sec,
        });
        object::address_to_object<LpRewardPool>(rp_addr)
    }

    public entry fun deposit_rewards(
        depositor: &signer, reward_pool: Object<LpRewardPool>, amount: u64,
    ) acquires LpRewardPool {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let rp_addr = object::object_address(&reward_pool);
        let rp = borrow_global_mut<LpRewardPool>(rp_addr);
        update_pool(rp, rp_addr);

        let fa = primary_fungible_store::withdraw(depositor, rp.reward_token, amount);
        primary_fungible_store::deposit(rp_addr, fa);
        let new_balance = primary_fungible_store::balance(rp_addr, rp.reward_token);

        event::emit(LpRewardsDeposited {
            depositor: signer::address_of(depositor),
            reward_pool_addr: rp_addr, amount, new_balance,
        });
    }

    public entry fun stake_lp(
        user: &signer, reward_pool: Object<LpRewardPool>, position: Object<LpPosition>,
    ) acquires LpRewardPool { let _ = create_stake(user, reward_pool, StakedLp::Naked(position)); }

    public entry fun stake_locked_lp(
        user: &signer, reward_pool: Object<LpRewardPool>, locked: Object<LockedPosition>,
    ) acquires LpRewardPool { let _ = create_stake(user, reward_pool, StakedLp::Locked(locked)); }

    fun create_stake(
        user: &signer, reward_pool: Object<LpRewardPool>, inner: StakedLp,
    ): Object<LpStakePosition> acquires LpRewardPool {
        let rp_addr = object::object_address(&reward_pool);
        let rp = borrow_global_mut<LpRewardPool>(rp_addr);
        update_pool(rp, rp_addr);

        let user_addr = signer::address_of(user);
        let ctor = object::create_object(user_addr);
        let stake_signer = object::generate_signer(&ctor);
        let stake_addr = signer::address_of(&stake_signer);

        let (shares, source_addr, locked_variant) = match (&inner) {
            StakedLp::Naked(p) => (pool::position_shares(*p), object::object_address(p), false),
            StakedLp::Locked(l) => (lock::position_shares(*l), object::object_address(l), true),
        };
        assert!(shares > 0, E_ZERO_AMOUNT);

        let (fa_a, fa_b) = match (&inner) {
            StakedLp::Naked(p) => {
                let position = *p;
                object::transfer(user, position, stake_addr);
                pool::claim_lp_fees(&stake_signer, position)
            },
            StakedLp::Locked(l) => {
                let locked = *l;
                object::transfer(user, locked, stake_addr);
                lock::claim_fees_assets(&stake_signer, locked)
            },
        };

        let (expected_a, expected_b) = pool::pool_tokens(rp.pool_addr);
        assert!(fungible_asset::asset_metadata(&fa_a) == expected_a, E_WRONG_POOL);
        assert!(fungible_asset::asset_metadata(&fa_b) == expected_b, E_WRONG_POOL);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        let acc_at_stake = rp.acc_reward_per_share;
        move_to(&stake_signer, LpStakePosition {
            reward_pool_addr: rp_addr, inner, shares, acc_at_stake,
            extend_ref: object::generate_extend_ref(&ctor),
            delete_ref: object::generate_delete_ref(&ctor),
        });
        rp.total_staked_shares = rp.total_staked_shares + shares;

        event::emit(LpStaked {
            user: user_addr, stake_addr, reward_pool_addr: rp_addr,
            source_addr, shares, locked_variant,
        });
        object::address_to_object<LpStakePosition>(stake_addr)
    }

    public entry fun claim_rewards(
        user: &signer, stake: Object<LpStakePosition>,
    ) acquires LpRewardPool, LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let sp = borrow_global_mut<LpStakePosition>(stake_addr);
        let rp_addr = sp.reward_pool_addr;
        let rp = borrow_global_mut<LpRewardPool>(rp_addr);
        update_pool(rp, rp_addr);

        let pending = pending_reward(sp.shares, rp.acc_reward_per_share, sp.acc_at_stake);
        assert!(pending > 0, E_NOTHING_CLAIMABLE);
        sp.acc_at_stake = rp.acc_reward_per_share;
        rp.committed_rewards = rp.committed_rewards - pending;

        let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
        let fa = primary_fungible_store::withdraw(&rp_signer, rp.reward_token, pending);
        primary_fungible_store::deposit(user_addr, fa);

        event::emit(LpRewardsClaimed { user: user_addr, stake_addr, amount: pending });
    }

    public entry fun claim_lp_fees(
        user: &signer, stake: Object<LpStakePosition>,
    ) acquires LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let sp = borrow_global<LpStakePosition>(stake_addr);
        let stake_signer = object::generate_signer_for_extending(&sp.extend_ref);

        let (fa_a, fa_b, locked_variant) = match (&sp.inner) {
            StakedLp::Naked(p) => {
                let (a, b) = pool::claim_lp_fees(&stake_signer, *p);
                (a, b, false)
            },
            StakedLp::Locked(l) => {
                let (a, b) = lock::claim_fees_assets(&stake_signer, *l);
                (a, b, true)
            },
        };

        let fees_a = fungible_asset::amount(&fa_a);
        let fees_b = fungible_asset::amount(&fa_b);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        event::emit(LpFeesClaimed {
            user: user_addr, stake_addr, fees_a, fees_b, locked_variant,
        });
    }

    public entry fun unstake_naked(
        user: &signer, stake: Object<LpStakePosition>,
    ) acquires LpRewardPool, LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let LpStakePosition { reward_pool_addr, inner, shares, acc_at_stake, extend_ref, delete_ref }
            = move_from<LpStakePosition>(stake_addr);

        let position = match (inner) {
            StakedLp::Naked(p) => p,
            StakedLp::Locked(_) => abort E_NOT_NAKED,
        };

        let rp = borrow_global_mut<LpRewardPool>(reward_pool_addr);
        update_pool(rp, reward_pool_addr);

        let pending = pending_reward(shares, rp.acc_reward_per_share, acc_at_stake);
        rp.total_staked_shares = rp.total_staked_shares - shares;

        if (pending > 0) {
            rp.committed_rewards = rp.committed_rewards - pending;
            let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
            let fa = primary_fungible_store::withdraw(&rp_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, fa);
        };

        let stake_signer = object::generate_signer_for_extending(&extend_ref);
        object::transfer(&stake_signer, position, user_addr);
        object::delete(delete_ref);

        event::emit(LpUnstaked {
            user: user_addr, stake_addr, reward_pool_addr,
            source_addr: object::object_address(&position),
            shares, rewards_claimed: pending, locked_variant: false,
        });
    }

    public entry fun unstake_locked(
        user: &signer, stake: Object<LpStakePosition>,
    ) acquires LpRewardPool, LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let LpStakePosition { reward_pool_addr, inner, shares, acc_at_stake, extend_ref, delete_ref }
            = move_from<LpStakePosition>(stake_addr);

        let locked = match (inner) {
            StakedLp::Locked(l) => l,
            StakedLp::Naked(_) => abort E_NOT_LOCKED,
        };

        let rp = borrow_global_mut<LpRewardPool>(reward_pool_addr);
        update_pool(rp, reward_pool_addr);

        let pending = pending_reward(shares, rp.acc_reward_per_share, acc_at_stake);
        rp.total_staked_shares = rp.total_staked_shares - shares;

        if (pending > 0) {
            rp.committed_rewards = rp.committed_rewards - pending;
            let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
            let fa = primary_fungible_store::withdraw(&rp_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, fa);
        };

        let stake_signer = object::generate_signer_for_extending(&extend_ref);
        object::transfer(&stake_signer, locked, user_addr);
        object::delete(delete_ref);

        event::emit(LpUnstaked {
            user: user_addr, stake_addr, reward_pool_addr,
            source_addr: object::object_address(&locked),
            shares, rewards_claimed: pending, locked_variant: true,
        });
    }

    fun update_pool(rp: &mut LpRewardPool, rp_addr: address) {
        let now = timestamp::now_seconds();
        if (now <= rp.last_reward_time_seconds) return;

        let pool_supply = pool::lp_supply(rp.pool_addr);
        let staked = rp.total_staked_shares;
        if (staked == 0 || pool_supply == 0) {
            rp.last_reward_time_seconds = now;
            return
        };

        let phys = primary_fungible_store::balance(rp_addr, rp.reward_token);
        let committed = rp.committed_rewards;
        let free = if (phys > committed) phys - committed else 0;

        let elapsed_u256 = ((now - rp.last_reward_time_seconds) as u256);
        let staked_u256 = (staked as u256);
        let supply_u256 = (pool_supply as u256);
        let max_rate_u256 = (rp.max_rate_per_sec as u256);
        let total_reward_u256 = elapsed_u256 * staked_u256 * max_rate_u256 / supply_u256;
        let free_u256 = (free as u256);
        let paid_u256 = if (total_reward_u256 > free_u256) free_u256 else total_reward_u256;
        let paid = (paid_u256 as u64);

        if (paid == 0) return;  // B1 grief mitigation

        let per_share_bump = (paid as u128) * SCALE / (staked as u128);
        if (per_share_bump == 0) return;  // B7 dust-leak guard

        rp.acc_reward_per_share = rp.acc_reward_per_share + per_share_bump;
        rp.committed_rewards = rp.committed_rewards + paid;

        let denom = staked_u256 * max_rate_u256;
        let accounted_seconds_u256 = (paid_u256 * supply_u256 + denom - 1) / denom;  // B2 ceiling
        rp.last_reward_time_seconds = rp.last_reward_time_seconds + (accounted_seconds_u256 as u64);
    }

    fun pending_reward(shares: u64, current_acc: u128, acc_at_stake: u128): u64 {
        let scale_u256 = (SCALE as u256);
        let raw = (shares as u256) * (current_acc as u256) / scale_u256;
        let debt = (shares as u256) * (acc_at_stake as u256) / scale_u256;
        if (raw <= debt) return 0;
        ((raw - debt) as u64)
    }

    // [#[view] reward_pool_info, stake_info, current_emission_rate_per_sec, staked_fraction_bps,
    //  unstaked_lp_shares, stake_pending_reward, read_warning — read-only, mirror update_pool
    //  math without mutation. See source file for full bodies.]
}
```

---

## 9. Relevant Darbitex core excerpts (`darbitex::pool`)

These are the public surfaces from core that locker/staking call. Already live on mainnet, audited (Darbitex Final v0.2.0, R3.1 GREEN, 13 audit passes / 3 rounds).

### `LpPosition` struct (private fields — only callable via `claim_lp_fees`)

```move
struct LpPosition has key {
    pool_addr: address,
    shares: u64,
    fee_debt_a: u128,
    fee_debt_b: u128,
    delete_ref: DeleteRef,
}
```

### `claim_lp_fees` — called by locker and staking

```move
public fun claim_lp_fees(
    provider: &signer,
    position: Object<LpPosition>,
): (FungibleAsset, FungibleAsset) acquires Pool, LpPosition {
    let provider_addr = signer::address_of(provider);
    assert!(object::owner(position) == provider_addr, E_NOT_OWNER);

    let position_addr = object::object_address(&position);
    assert!(exists<LpPosition>(position_addr), E_NO_POSITION);

    let pos = borrow_global_mut<LpPosition>(position_addr);
    assert!(exists<Pool>(pos.pool_addr), E_NO_POOL);

    let pool = borrow_global_mut<Pool>(pos.pool_addr);
    assert!(!pool.locked, E_LOCKED);
    pool.locked = true;

    let claim_a = pending_from_accumulator(pool.lp_fee_per_share_a, pos.fee_debt_a, pos.shares);
    let claim_b = pending_from_accumulator(pool.lp_fee_per_share_b, pos.fee_debt_b, pos.shares);

    pos.fee_debt_a = pool.lp_fee_per_share_a;
    pos.fee_debt_b = pool.lp_fee_per_share_b;

    let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
    let fa_a = if (claim_a > 0) {
        primary_fungible_store::withdraw(&pool_signer, pool.metadata_a, claim_a)
    } else { fungible_asset::zero(pool.metadata_a) };
    let fa_b = if (claim_b > 0) {
        primary_fungible_store::withdraw(&pool_signer, pool.metadata_b, claim_b)
    } else { fungible_asset::zero(pool.metadata_b) };

    pool.locked = false;
    event::emit(LpFeesClaimed { /* ... */ });
    (fa_a, fa_b)
}
```

Owner check: `object::owner(position) == provider_addr`. Locker satisfies this because the position is transferred to `locker_addr` at lock-time, and `&locker_signer` is generated via the locker's stored `extend_ref`. Staking-naked satisfies this because the position is transferred to `stake_addr` at stake-time, with `&stake_signer` from the stake's `extend_ref`. Staking-locked routes through `lock::claim_fees_assets`, which performs its own owner check on the `LockedPosition` (owned by `stake_addr`) and uses the locker's internal `extend_ref` to claim from the `LpPosition` (owned by `locker_addr`).

### Views consumed by locker/staking

```move
#[view] public fun pool_exists(pool_addr: address): bool {
    exists<Pool>(pool_addr)
}
#[view] public fun pool_tokens(pool_addr: address): (Object<Metadata>, Object<Metadata>) acquires Pool {
    let p = borrow_global<Pool>(pool_addr);
    (p.metadata_a, p.metadata_b)
}
#[view] public fun lp_supply(pool_addr: address): u64 acquires Pool {
    borrow_global<Pool>(pool_addr).lp_supply
}
#[view] public fun position_shares(pos: Object<LpPosition>): u64 acquires LpPosition {
    borrow_global<LpPosition>(object::object_address(&pos)).shares
}
```

---

## 10. Test matrix

### Locker (10 tests, 10 PASS)

| # | Name | Validates |
|---|---|---|
| 1 | `lock_then_view` | All 5 views return correct values post-lock; ownership transferred to locker_addr |
| 2 | `redeem_before_unlock_aborts` | E_STILL_LOCKED=2 |
| 3 | `redeem_after_unlock_returns_position` | Position returned to user, locker resource deleted |
| 4 | `redeem_position_returns_handle` | Non-entry variant returns Object<LpPosition> handle |
| 5 | `claim_fees_non_owner_aborts` | E_NOT_OWNER=1 |
| 6 | `transferred_locker_new_owner_can_redeem` | object::transfer carries lock state |
| 7 | `lock_rejects_unlock_at_eq_now` | E_INVALID_UNLOCK=3 (strict-greater) |
| 8 | `lock_rejects_unlock_at_past` | E_INVALID_UNLOCK=3 |
| 9 | `lock_transfers_position_away_from_user` | Principal-lock invariant: user can no longer call pool ops on position directly |
| 10 | `warning_contains_key_disclosure_terms` | WARNING bytes contain `unlock_at_seconds`, `timestamp::now_seconds`, `object::transfer`, `claim_fees_assets`, `redeem_position` |

### Staking (24 tests, 24 PASS)

| # | Name | Validates |
|---|---|---|
| 1 | `create_pool_happy_path` | All 6 reward_pool_info fields |
| 2 | `create_pool_wrong_pool_aborts` | E_WRONG_POOL=3 (non-existent pool) |
| 3 | `create_pool_zero_rate_aborts` | E_BAD_PARAMS=5 (max_rate_per_sec=0) |
| 4 | `deposit_rewards_increases_phys` | Permissionless top-up works, phys updates |
| 5 | `deposit_zero_aborts` | E_ZERO_AMOUNT=2 |
| 6 | `stake_naked_happy_path` | Stake info, shares, locked_variant=false |
| 7 | `stake_locked_happy_path` | Stake info, shares, locked_variant=true; LockedPosition owned by stake_addr |
| 8 | `claim_rewards_after_time` | Rewards distributed after time elapsed |
| 9 | `claim_zero_pending_aborts` | E_NOTHING_CLAIMABLE=4 |
| 10 | `claim_non_owner_aborts` | E_NOT_OWNER=1 |
| 11 | `claim_lp_fees_naked_dispatches` | Naked variant routes through pool::claim_lp_fees |
| 12 | `claim_lp_fees_locked_dispatches` | Locked variant routes through lock::claim_fees_assets |
| 13 | `unstake_naked_happy_path` | Position returned, rewards paid, total_staked_shares decremented |
| 14 | `unstake_locked_returns_locked_handle` | LockedPosition returned (still gated), inner LpPosition still owned by locker_addr |
| 15 | `unstake_naked_on_locked_aborts` | E_NOT_NAKED=6 |
| 16 | `unstake_locked_on_naked_aborts` | E_NOT_LOCKED=7 |
| 17 | `pending_view_increases_with_time` | Monotonic, non-zero after stake + time |
| 18 | `free_balance_caps_cumulative_payout` | **B3 over-credit guard** — long elapsed + small balance → claimed ≤ deposit |
| 19 | `multi_staker_committed_cap_no_abort` | **B3 critical** — A+B stake, A claims mid, B unstakes after exhaustion → no abort, total ≤ deposit |
| 20 | `multiple_reward_pools_coexist` | Permissionless multi-stream, no singleton |
| 21 | `lock_invariant_after_unstake_locked` | **3-firewall composition** — even after unstake, lock::redeem aborts E_STILL_LOCKED |
| 22 | `adoption_views_track_state` | staked_fraction_bps, unstaked_lp_shares, current_emission_rate_per_sec |
| 23 | `warning_anchors_field_names` | **B8 drift guard** — WARNING contains 10 field/concept tokens |
| 24 | `warning_covers_design_disclosures` | WARNING contains 4 policy tokens (multiple pools, no mandate, no stake_target, no multiplier) |

Total: **34 tests, 34 PASS, zero compile warnings.**

---

## 11. Design accepts (intentional, please don't flag as fixable)

| Topic | Decision | Rationale |
|---|---|---|
| Multiple reward pools per Darbitex pool | ALLOWED, by design | Singleton/canonical-pair = DoS squat vector. See WARNING item 1. Permissionless mints only. |
| No initial-reward mandate | ALLOWED, empty pools valid | Token value/supply/decimals unknowable to contract. Any mandatory floor = policy noise. See WARNING item 11. |
| No multiplier for lock duration | EQUAL rate per share | Original-duration multiplier gameable via wrapper transfer; remaining-time multiplier adds complexity without clear win. See WARNING item 6. |
| u128 `acc_reward_per_share` theoretical overflow | ACCEPTED | Reachable only at ~1.8e7 calls × extreme params; Sui R3+R4 same accept. Practical impossibility. |
| Empty-pool grief | ACCEPTED | Bounded by gas + storage. Adversary creating a junk reward pool with 0 balance harms only the gas-spender. |
| `paid==0` and `bump==0` early-return griefable on gas | ACCEPTED | Anyone can call deposit_rewards(1) repeatedly to trigger. Costs attacker's gas, no state damage. Same as Sui. |
| `LockedPosition` wrapper transferable while inner LpPosition locked | ACCEPTED, by design | Wrapper transfer carries lock state; new owner inherits both fee-claim right and redeem-at-unlock right. Mirrors Sui R3+R4. |

---

## 12. Areas of concern — please give extra attention

Ranked by risk:

1. **`update_pool` math under concurrent stakers + balance exhaustion** (staking.move:463-505). The R3 fix (committed_rewards + free-balance cap) is the critical one. Verify the invariant `committed ≤ phys` cannot be violated by any sequence of stake/unstake/claim/deposit interleaved with empty `update_pool` triggers.
2. **`stake_locked_lp` ownership transfer + claim sequence** (staking.move:255-272). Locked is transferred to `stake_addr`, then we call `lock::claim_fees_assets(&stake_signer, locked)` where stake_signer is freshly generated from a fresh ctor. Verify owner check inside `claim_fees_assets` passes correctly (object::owner(locked) == signer::address_of(stake_signer)).
3. **`unstake_*` move_from + abort sequencing** (staking.move:376-382, 419-426). The destructure happens before the variant check. If the wrong-variant arm aborts, all destructured fields (extend_ref, delete_ref, etc.) must be drop-able. Verify no resource leak.
4. **Locker `claim_fees_assets` callable by stake_signer** (lock.move:125-151). When staking-locked claims fees, stake_signer is passed as `user`. The owner check `object::owner(locker) == user_addr` passes because we transferred `locked` to `stake_addr`. Verify no path where this owner check could be bypassed.
5. **Enum dispatch correctness** (staking.move). All `match (&inner)` and `match (inner)` sites — verify no mis-binding, no leaked variants, all arms exhaustive.
6. **`pool::claim_lp_fees`'s pool.locked guard interaction** with the staking module's borrow_global_mut on LpRewardPool. Verify no scenario where a callback from claim_lp_fees could re-enter staking.

---

## 13. Submission package

- `lock.move` — full source (228 lines incl. comments + WARNING)
- `staking.move` — full source (647 lines incl. comments + WARNING)
- `lock_tests.move` — 10 tests (243 lines)
- `staking_tests.move` — 24 tests (~430 lines)
- This document

All compiled with Aptos CLI 9.1.0, Move 2 syntax (native enum). Zero warnings.

## 14. Dev addresses (for compile-only review)

For local compilation:
```toml
# lp-locker-redeploy/Move.toml
[dev-addresses]
darbitex_lp_locker = "0xCAFE"

# staking-redeploy/Move.toml
[dev-addresses]
darbitex_staking = "0xBEEF"
darbitex_lp_locker = "0xCAFE"
```

`darbitex` is the live Darbitex Final core address `0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd`. No core upgrade in this submission.

---

End of submission. Awaiting review.
