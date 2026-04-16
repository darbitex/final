# Darbitex LP Staking — External Audit Submission (Round 1)

**Package:** `darbitex_staking`
**Version:** 0.1.0
**Date:** 2026-04-16
**Chain:** Aptos
**Dependency:** Darbitex Final core at `0xc988d39a...` (mainnet, v0.2.0 — 2 views added same day)
**Audit package size:** 1 Move source file (`sources/staking.move`), ~320 LoC, compile-clean with zero warnings
**Previous deploys:** Testnet at `0x0047a3e1...` (Aptos testnet). All 6 entry functions and 3 views exercised on-chain. Full lifecycle: create pool → deposit rewards → stake LP → views → unstake (position returned + 1061 rewards claimed).
**Planned mainnet publisher:** 1/5 multisig (same 5 owners as Darbitex Final), raised to 3/5 after smoke test.
**Upgrade policy:** `compatible` (cannot flip to `immutable` until core dependency does — planned ~2026-07-14)

---

## 1. What we are asking from you

You are reviewing a single Move source file for a **permissionless LP staking satellite**. Users stake Darbitex LP positions (`Object<LpPosition>`) into reward pools and earn token rewards proportional to their LP shares. We want an **independent security review** focused on:

1. **Authorization correctness** — can any unauthorized party claim rewards, claim LP fees, or unstake someone else's position?
2. **Fund safety** — can LP positions be permanently locked? Can reward tokens be stolen?
3. **Pool validation** — can an attacker stake an LP position from the wrong pool to earn undeserved rewards?
4. **Accumulator math** — is the MasterChef reward distribution correct?
5. **LP fee proxy safety** — does `claim_lp_fees` correctly forward fees from core to the staker?
6. **Object lifecycle** — are all objects cleanly created and deleted? Any dangling refs?
7. **Event completeness** — do events capture all state mutations?
8. **Interaction with Darbitex core** — any unexpected side effects from calling `pool::claim_lp_fees` or `pool::position_shares`?

**Output format:**

```
## Findings

### HIGH-1: <title>
Location: staking.move:<line>
Description: <what>
Impact: <why it matters>
Recommended fix: <how>

### MEDIUM-1: ...
### LOW-1: ...
### INFORMATIONAL-1: ...

## Overall verdict
(GREEN / YELLOW / RED for mainnet publish readiness)
```

---

## 2. Architecture overview

Permissionless LP staking factory. Any token creator can set up a reward pool for any Darbitex LP pool. Users stake their LP positions, earn rewards proportional to their LP shares, and can harvest LP swap fees while staked.

**Two independent reward streams:**
1. **Staking rewards** — from the reward pool's deposited tokens (MasterChef accumulator)
2. **LP fees** — from swap activity in the underlying pool (proxied via `pool::claim_lp_fees`)

**Fee model:** 1 APT flat fee on `create_lp_reward_pool` only. All other operations free.

**Key design:**
- Agnostic — any Darbitex pool, any reward token
- Fire-and-forget — zero admin, immutable after deploy
- Permissionless — anyone can create pools and deposit rewards
- One-way rewards — `deposit_rewards` has no withdraw counterpart

---

## 3. Entry surface (6 entries + 3 views)

| Function | Fee | Description |
|----------|-----|-------------|
| `create_lp_reward_pool(creator, pool_addr, reward_token, max_rate, stake_target)` | 1 APT | Create permissionless reward pool for a Darbitex LP pool |
| `deposit_rewards(depositor, reward_pool, amount)` | free | One-way reward deposit |
| `stake_lp(user, reward_pool, position)` | free | Stake LP position, validate pool via metadata check |
| `claim_rewards(user, stake)` | free | Harvest pending staking rewards |
| `claim_lp_fees(user, stake)` | free | Proxy LP fee harvest from underlying pool |
| `unstake_lp(user, stake)` | free | Withdraw LP position + pending rewards |

| View | Returns |
|------|---------|
| `reward_pool_info(pool)` | (pool_addr, reward_token, max_rate, stake_target, total_staked, reward_balance) |
| `stake_info(stake)` | (reward_pool_addr, position_addr, shares) |
| `stake_pending_reward(stake)` | u64 |

---

## 4. Error codes

| Code | Constant | Used in |
|------|----------|---------|
| 1 | E_NOT_OWNER | claim_rewards, claim_lp_fees, unstake_lp |
| 2 | E_ZERO_AMOUNT | create_lp_reward_pool, deposit_rewards, stake_lp |
| 3 | E_WRONG_POOL | create_lp_reward_pool, stake_lp (metadata validation) |
| 4 | E_NOTHING_CLAIMABLE | claim_rewards |

---

## 5. Key design decisions we want challenged

### D-1: Pool validation via `claim_lp_fees` metadata check (no `position_pool` view)
At `stake_lp` time, the LP position is transferred to the staking object, then `pool::claim_lp_fees` is called. The returned FungibleAsset metadata is compared against `pool::pool_tokens(rp.pool_addr)`. If mismatch → `E_WRONG_POOL` abort (atomic rollback).

This works because Darbitex enforces one canonical pool per sorted pair (via `create_named_object` deterministic addressing). If FA metadata matches, the position must be from the correct pool.

**Side effect:** any accrued LP fees are claimed at stake time and deposited to the user (clean slate).

**Question:** Is this validation sound? Any edge case where metadata matches but pool differs?

### D-2: Emission formula
```
emission_rate = max_rate * min(total_staked_shares, stake_target) / stake_target
```
Same MasterChef pattern as token vault. `reward_balance` deducted at allocation time (not claim time) with `actual_distributed` dust-leak fix from Gemini audit.

**Question:** Correct and safe?

### D-3: LP fee proxy while staked
`claim_lp_fees(user, stake)` generates a signer from the staking object's `ExtendRef` and calls `pool::claim_lp_fees`. Same pattern as LP Locker (proven on mainnet).

**Question:** Any auth bypass? Can someone other than the owner call this?

### D-4: No time lock on unstaking
Unlike LP Locker, LP staking has no `unlock_at`. Users can unstake at any time.

**Question:** Is this acceptable for a staking product?

### D-5: Positions transferable by default
`LpStakePosition` objects are transferable. New owner can claim rewards and unstake.

**Question:** Security implications?

### D-6: `upgrade_policy = compatible` (cannot be immutable)
Staking depends on DarbitexFinal which is `compatible`. Aptos enforces `EDEP_WEAKER_POLICY` — dependent package cannot have stricter policy than dependency. Will flip to `immutable` when core does (~2026-07-14).

**Question:** Acceptable?

---

## 6. Dependency on Darbitex core

| Core function | Used in | Purpose |
|--------------|---------|---------|
| `pool::pool_exists(addr)` | create_lp_reward_pool | Validate pool exists |
| `pool::position_shares(pos)` | stake_lp | Read LP shares for weight |
| `pool::pool_tokens(addr)` | stake_lp | Validate LP belongs to correct pool |
| `pool::claim_lp_fees(signer, pos)` | stake_lp, claim_lp_fees | Pool validation + fee proxy |

All 4 functions are `public` in `darbitex::pool`, stable on mainnet since v0.1.0 (position_shares since v0.2.0). No `friend` access required.

---

## 7. Pre-audit self-review results

Self-audit (8 categories) — **GREEN**, 0 findings.
Unit tests — **13/13 pass**.
Testnet smoke test — all 6 entries + 3 views exercised, full lifecycle verified.

---

## 8. Source code

**File:** `sources/staking.move` — ~320 LoC

```move
module darbitex_staking::staking {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, Metadata};
    use aptos_framework::object::{Self, Object, ExtendRef, DeleteRef};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool::{Self, LpPosition};

    const SCALE: u128 = 1_000_000_000_000;
    const CREATION_FEE: u64 = 100_000_000;
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;

    const E_NOT_OWNER: u64 = 1;
    const E_ZERO_AMOUNT: u64 = 2;
    const E_WRONG_POOL: u64 = 3;
    const E_NOTHING_CLAIMABLE: u64 = 4;

    struct LpRewardPool has key {
        pool_addr: address,
        reward_token: Object<Metadata>,
        max_rate: u64,
        stake_target: u64,
        acc_reward_per_share: u128,
        last_reward_time: u64,
        total_staked_shares: u64,
        reward_balance: u64,
        extend_ref: ExtendRef,
    }

    struct LpStakePosition has key {
        reward_pool_addr: address,
        position: Object<LpPosition>,
        shares: u64,
        reward_debt: u128,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    #[event]
    struct LpRewardPoolCreated has drop, store {
        creator: address, reward_pool_addr: address, pool_addr: address,
        reward_token: address, max_rate: u64, stake_target: u64,
    }

    #[event]
    struct LpRewardsDeposited has drop, store {
        depositor: address, reward_pool_addr: address,
        amount: u64, new_balance: u64,
    }

    #[event]
    struct LpStaked has drop, store {
        user: address, stake_addr: address, reward_pool_addr: address,
        position_addr: address, shares: u64, timestamp: u64,
    }

    #[event]
    struct LpRewardsClaimed has drop, store {
        user: address, stake_addr: address,
        amount: u64, timestamp: u64,
    }

    #[event]
    struct LpFeesClaimed has drop, store {
        user: address, stake_addr: address,
        fees_a: u64, fees_b: u64, timestamp: u64,
    }

    #[event]
    struct LpUnstaked has drop, store {
        user: address, stake_addr: address, pool_addr: address,
        position_addr: address, shares: u64, rewards_claimed: u64, timestamp: u64,
    }

    fun collect_fee(user: &signer) {
        let apt_meta = object::address_to_object<Metadata>(@0xa);
        let fa = primary_fungible_store::withdraw(user, apt_meta, CREATION_FEE);
        primary_fungible_store::deposit(TREASURY, fa);
    }

    public entry fun create_lp_reward_pool(
        creator: &signer, pool_addr: address, reward_token: Object<Metadata>,
        max_rate: u64, stake_target: u64,
    ) {
        assert!(pool::pool_exists(pool_addr), E_WRONG_POOL);
        assert!(max_rate > 0 && stake_target > 0, E_ZERO_AMOUNT);
        collect_fee(creator);

        let creator_addr = signer::address_of(creator);
        let ctor = object::create_object(creator_addr);
        let rp_signer = object::generate_signer(&ctor);
        let rp_addr = signer::address_of(&rp_signer);

        move_to(&rp_signer, LpRewardPool {
            pool_addr, reward_token, max_rate, stake_target,
            acc_reward_per_share: 0,
            last_reward_time: timestamp::now_seconds(),
            total_staked_shares: 0, reward_balance: 0,
            extend_ref: object::generate_extend_ref(&ctor),
        });

        event::emit(LpRewardPoolCreated {
            creator: creator_addr, reward_pool_addr: rp_addr, pool_addr,
            reward_token: object::object_address(&reward_token),
            max_rate, stake_target,
        });
    }

    public entry fun deposit_rewards(
        depositor: &signer, reward_pool: Object<LpRewardPool>, amount: u64,
    ) acquires LpRewardPool {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let rp_addr = object::object_address(&reward_pool);
        let rp = borrow_global_mut<LpRewardPool>(rp_addr);

        let fa = primary_fungible_store::withdraw(depositor, rp.reward_token, amount);
        let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
        primary_fungible_store::deposit(signer::address_of(&rp_signer), fa);
        rp.reward_balance = rp.reward_balance + amount;

        event::emit(LpRewardsDeposited {
            depositor: signer::address_of(depositor),
            reward_pool_addr: rp_addr, amount, new_balance: rp.reward_balance,
        });
    }

    public entry fun stake_lp(
        user: &signer, reward_pool: Object<LpRewardPool>, position: Object<LpPosition>,
    ) acquires LpRewardPool {
        let rp_addr = object::object_address(&reward_pool);
        let rp = borrow_global_mut<LpRewardPool>(rp_addr);
        update_pool(rp);

        let shares = pool::position_shares(position);
        assert!(shares > 0, E_ZERO_AMOUNT);

        let user_addr = signer::address_of(user);
        let position_addr = object::object_address(&position);

        let ctor = object::create_object(user_addr);
        let stake_signer = object::generate_signer(&ctor);
        let stake_addr = signer::address_of(&stake_signer);

        object::transfer(user, position, stake_addr);

        let (fa_a, fa_b) = pool::claim_lp_fees(&stake_signer, position);
        let (expected_a, expected_b) = pool::pool_tokens(rp.pool_addr);
        assert!(fungible_asset::asset_metadata(&fa_a) == expected_a, E_WRONG_POOL);
        assert!(fungible_asset::asset_metadata(&fa_b) == expected_b, E_WRONG_POOL);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        let reward_debt = (shares as u128) * rp.acc_reward_per_share / SCALE;
        move_to(&stake_signer, LpStakePosition {
            reward_pool_addr: rp_addr, position, shares, reward_debt,
            extend_ref: object::generate_extend_ref(&ctor),
            delete_ref: object::generate_delete_ref(&ctor),
        });

        rp.total_staked_shares = rp.total_staked_shares + shares;

        event::emit(LpStaked {
            user: user_addr, stake_addr, reward_pool_addr: rp_addr,
            position_addr, shares, timestamp: timestamp::now_seconds(),
        });
    }

    public entry fun claim_rewards(
        user: &signer, stake: Object<LpStakePosition>,
    ) acquires LpRewardPool, LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let sp = borrow_global_mut<LpStakePosition>(stake_addr);
        let rp = borrow_global_mut<LpRewardPool>(sp.reward_pool_addr);
        update_pool(rp);

        let pending = pending_reward(sp.shares, rp.acc_reward_per_share, sp.reward_debt);
        assert!(pending > 0, E_NOTHING_CLAIMABLE);
        sp.reward_debt = (sp.shares as u128) * rp.acc_reward_per_share / SCALE;

        {
            let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
            let fa = primary_fungible_store::withdraw(&rp_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, fa);
        };

        event::emit(LpRewardsClaimed {
            user: user_addr, stake_addr,
            amount: pending, timestamp: timestamp::now_seconds(),
        });
    }

    public entry fun claim_lp_fees(
        user: &signer, stake: Object<LpStakePosition>,
    ) acquires LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let sp = borrow_global<LpStakePosition>(stake_addr);

        let stake_signer = object::generate_signer_for_extending(&sp.extend_ref);
        let (fa_a, fa_b) = pool::claim_lp_fees(&stake_signer, sp.position);
        let fees_a = fungible_asset::amount(&fa_a);
        let fees_b = fungible_asset::amount(&fa_b);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        event::emit(LpFeesClaimed {
            user: user_addr, stake_addr,
            fees_a, fees_b, timestamp: timestamp::now_seconds(),
        });
    }

    public entry fun unstake_lp(
        user: &signer, stake: Object<LpStakePosition>,
    ) acquires LpRewardPool, LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let LpStakePosition {
            reward_pool_addr, position, shares, reward_debt,
            extend_ref, delete_ref,
        } = move_from<LpStakePosition>(stake_addr);

        let rp = borrow_global_mut<LpRewardPool>(reward_pool_addr);
        update_pool(rp);

        let pending = pending_reward(shares, rp.acc_reward_per_share, reward_debt);

        if (pending > 0) {
            let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
            let fa = primary_fungible_store::withdraw(&rp_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, fa);
        };

        rp.total_staked_shares = rp.total_staked_shares - shares;

        let stake_signer = object::generate_signer_for_extending(&extend_ref);
        object::transfer(&stake_signer, position, user_addr);
        object::delete(delete_ref);

        event::emit(LpUnstaked {
            user: user_addr, stake_addr, pool_addr: rp.pool_addr,
            position_addr: object::object_address(&position),
            shares, rewards_claimed: pending, timestamp: timestamp::now_seconds(),
        });
    }

    fun update_pool(rp: &mut LpRewardPool) {
        let now = timestamp::now_seconds();
        if (now <= rp.last_reward_time) return;
        if (rp.total_staked_shares == 0) {
            rp.last_reward_time = now;
            return
        };

        let elapsed = now - rp.last_reward_time;
        let rate = emission_rate(rp.total_staked_shares, rp.max_rate, rp.stake_target);
        let total_reward_u128 = (elapsed as u128) * (rate as u128);
        let total_reward = if (total_reward_u128 > (rp.reward_balance as u128)) {
            rp.reward_balance
        } else {
            (total_reward_u128 as u64)
        };

        if (total_reward > 0) {
            let added_acc = (total_reward as u128) * SCALE / (rp.total_staked_shares as u128);
            let actual_distributed = ((added_acc * (rp.total_staked_shares as u128) / SCALE) as u64);
            rp.acc_reward_per_share = rp.acc_reward_per_share + added_acc;
            rp.reward_balance = rp.reward_balance - actual_distributed;
        };
        rp.last_reward_time = now;
    }

    fun emission_rate(total_staked: u64, max_rate: u64, stake_target: u64): u64 {
        let capped = if (total_staked > stake_target) stake_target else total_staked;
        (((capped as u128) * (max_rate as u128) / (stake_target as u128)) as u64)
    }

    fun pending_reward(shares: u64, acc: u128, debt: u128): u64 {
        let raw = (shares as u128) * acc / SCALE;
        if (raw > debt) ((raw - debt) as u64) else 0
    }

    #[view]
    public fun reward_pool_info(
        reward_pool: Object<LpRewardPool>,
    ): (address, address, u64, u64, u64, u64) acquires LpRewardPool {
        let rp = borrow_global<LpRewardPool>(object::object_address(&reward_pool));
        (rp.pool_addr, object::object_address(&rp.reward_token),
         rp.max_rate, rp.stake_target, rp.total_staked_shares, rp.reward_balance)
    }

    #[view]
    public fun stake_info(
        stake: Object<LpStakePosition>,
    ): (address, address, u64) acquires LpStakePosition {
        let sp = borrow_global<LpStakePosition>(object::object_address(&stake));
        (sp.reward_pool_addr, object::object_address(&sp.position), sp.shares)
    }

    #[view]
    public fun stake_pending_reward(
        stake: Object<LpStakePosition>,
    ): u64 acquires LpRewardPool, LpStakePosition {
        let stake_addr = object::object_address(&stake);
        let sp = borrow_global<LpStakePosition>(stake_addr);
        let rp = borrow_global<LpRewardPool>(sp.reward_pool_addr);
        let now = timestamp::now_seconds();
        let elapsed = if (now > rp.last_reward_time) now - rp.last_reward_time else 0;
        let rate = emission_rate(rp.total_staked_shares, rp.max_rate, rp.stake_target);
        let extra = if (rp.total_staked_shares > 0 && elapsed > 0) {
            let uncapped = (elapsed as u128) * (rate as u128);
            let capped = if (uncapped > (rp.reward_balance as u128)) {
                (rp.reward_balance as u128)
            } else { uncapped };
            capped * SCALE / (rp.total_staked_shares as u128)
        } else { 0 };
        pending_reward(sp.shares, rp.acc_reward_per_share + extra, sp.reward_debt)
    }
}
```

---

## 9. Ranked areas of concern

1. **Pool validation via metadata check** (D-1) — relies on one-pool-per-pair invariant. Verify this is sufficient.
2. **LP position ownership transfer at stake time** — position moves to staking object. Can core's `remove_liquidity` be called on it by anyone?
3. **`claim_lp_fees` proxy auth chain** — staking object signer → pool owner check → fee withdrawal. Same pattern as LP Locker (mainnet-proven).
4. **Accumulator dust-leak fix** — `actual_distributed` pattern. Verify correctness.
5. **View function `stake_pending_reward`** — verify it caps at `reward_balance`.

---

## 10. Out of scope

- Darbitex core (`darbitex::pool`) security — already audited R3+1 GREEN, LIVE since 2026-04-14
- Aptos framework correctness — trusted
- Frontend UX — not shipped yet
- LP Locker interaction — separate satellite, no cross-dependency

---

**End of submission.** Please audit the source in §8. Findings format in §1. Verdict: **GREEN / YELLOW / RED** for mainnet publish readiness.
