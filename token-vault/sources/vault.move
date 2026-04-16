module darbitex_vault::vault {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::object::{Self, Object, ExtendRef, DeleteRef};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    const SCALE: u128 = 1_000_000_000_000;
    const CREATION_FEE: u64 = 100_000_000; // 1 APT
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;

    const E_NOT_OWNER: u64 = 1;
    const E_STILL_LOCKED: u64 = 2;
    const E_INVALID_UNLOCK: u64 = 3;
    const E_ZERO_AMOUNT: u64 = 4;
    const E_NOTHING_CLAIMABLE: u64 = 5;
    const E_INVALID_SCHEDULE: u64 = 6;

    // ===== Lock: time-based token lock =====

    struct LockedTokens has key {
        token: Object<Metadata>,
        amount: u64,
        unlock_at: u64,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    // ===== Vest: linear vesting =====

    struct VestedTokens has key {
        token: Object<Metadata>,
        total_amount: u64,
        claimed_amount: u64,
        start_time: u64,
        end_time: u64,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    // ===== Stake: reward pool + staking =====

    struct RewardPool has key {
        staked_token: Object<Metadata>,
        reward_token: Object<Metadata>,
        max_rate: u64,
        stake_target: u64,
        acc_reward_per_share: u128,
        last_reward_time: u64,
        total_staked: u64,
        reward_balance: u64,
        extend_ref: ExtendRef,
    }

    struct StakePosition has key {
        pool_addr: address,
        amount: u64,
        reward_debt: u128,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    // ===== Events =====

    #[event]
    struct TokensLocked has drop, store {
        owner: address,
        locker_addr: address,
        token: address,
        amount: u64,
        unlock_at: u64,
        timestamp: u64,
    }

    #[event]
    struct TokensRedeemed has drop, store {
        owner: address,
        locker_addr: address,
        token: address,
        amount: u64,
        timestamp: u64,
    }

    #[event]
    struct VestingCreated has drop, store {
        owner: address,
        vest_addr: address,
        token: address,
        total_amount: u64,
        start_time: u64,
        end_time: u64,
    }

    #[event]
    struct VestingClaimed has drop, store {
        owner: address,
        vest_addr: address,
        claimed: u64,
        remaining: u64,
        timestamp: u64,
    }

    #[event]
    struct RewardPoolCreated has drop, store {
        creator: address,
        pool_addr: address,
        staked_token: address,
        reward_token: address,
        max_rate: u64,
        stake_target: u64,
    }

    #[event]
    struct RewardsDeposited has drop, store {
        depositor: address,
        pool_addr: address,
        amount: u64,
        new_balance: u64,
    }

    #[event]
    struct TokensStaked has drop, store {
        user: address,
        stake_addr: address,
        pool_addr: address,
        amount: u64,
        timestamp: u64,
    }

    #[event]
    struct StakeRewardsClaimed has drop, store {
        user: address,
        stake_addr: address,
        amount: u64,
        timestamp: u64,
    }

    #[event]
    struct TokensUnstaked has drop, store {
        user: address,
        stake_addr: address,
        pool_addr: address,
        amount: u64,
        rewards_claimed: u64,
        timestamp: u64,
    }

    // ===== Fee =====

    fun collect_fee(user: &signer) {
        let apt_meta = object::address_to_object<Metadata>(@0xa);
        let fa = primary_fungible_store::withdraw(user, apt_meta, CREATION_FEE);
        primary_fungible_store::deposit(TREASURY, fa);
    }

    // ===== Mode 1: LOCK =====

    public entry fun lock_tokens(
        user: &signer,
        token: Object<Metadata>,
        amount: u64,
        unlock_at: u64,
    ) {
        create_lock(user, token, amount, unlock_at);
    }

    fun create_lock(
        user: &signer,
        token: Object<Metadata>,
        amount: u64,
        unlock_at: u64,
    ): Object<LockedTokens> {
        let now = timestamp::now_seconds();
        assert!(unlock_at > now, E_INVALID_UNLOCK);
        assert!(amount > 0, E_ZERO_AMOUNT);
        collect_fee(user);

        let user_addr = signer::address_of(user);
        let fa = primary_fungible_store::withdraw(user, token, amount);

        let ctor = object::create_object(user_addr);
        let vault_signer = object::generate_signer(&ctor);
        let vault_addr = signer::address_of(&vault_signer);
        let extend_ref = object::generate_extend_ref(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        primary_fungible_store::deposit(vault_addr, fa);

        move_to(&vault_signer, LockedTokens {
            token, amount, unlock_at, extend_ref, delete_ref,
        });

        event::emit(TokensLocked {
            owner: user_addr, locker_addr: vault_addr,
            token: object::object_address(&token),
            amount, unlock_at, timestamp: now,
        });

        object::address_to_object<LockedTokens>(vault_addr)
    }

    public entry fun redeem_locked(
        user: &signer,
        locker: Object<LockedTokens>,
    ) acquires LockedTokens {
        let user_addr = signer::address_of(user);
        assert!(object::owner(locker) == user_addr, E_NOT_OWNER);

        let locker_addr = object::object_address(&locker);
        let LockedTokens { token, amount, unlock_at, extend_ref, delete_ref }
            = move_from<LockedTokens>(locker_addr);
        assert!(timestamp::now_seconds() >= unlock_at, E_STILL_LOCKED);

        let vault_signer = object::generate_signer_for_extending(&extend_ref);
        let fa = primary_fungible_store::withdraw(&vault_signer, token, amount);
        primary_fungible_store::deposit(user_addr, fa);

        object::delete(delete_ref);

        event::emit(TokensRedeemed {
            owner: user_addr, locker_addr,
            token: object::object_address(&token),
            amount, timestamp: timestamp::now_seconds(),
        });
    }

    // ===== Mode 2: VEST =====

    public entry fun create_vesting(
        user: &signer,
        token: Object<Metadata>,
        total_amount: u64,
        start_time: u64,
        end_time: u64,
    ) {
        create_vest(user, token, total_amount, start_time, end_time);
    }

    fun create_vest(
        user: &signer,
        token: Object<Metadata>,
        total_amount: u64,
        start_time: u64,
        end_time: u64,
    ): Object<VestedTokens> {
        assert!(total_amount > 0, E_ZERO_AMOUNT);
        assert!(end_time > start_time, E_INVALID_SCHEDULE);
        assert!(start_time >= timestamp::now_seconds(), E_INVALID_SCHEDULE);
        collect_fee(user);

        let user_addr = signer::address_of(user);
        let fa = primary_fungible_store::withdraw(user, token, total_amount);

        let ctor = object::create_object(user_addr);
        let vault_signer = object::generate_signer(&ctor);
        let vault_addr = signer::address_of(&vault_signer);
        let extend_ref = object::generate_extend_ref(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        primary_fungible_store::deposit(vault_addr, fa);

        move_to(&vault_signer, VestedTokens {
            token, total_amount, claimed_amount: 0,
            start_time, end_time, extend_ref, delete_ref,
        });

        event::emit(VestingCreated {
            owner: user_addr, vest_addr: vault_addr,
            token: object::object_address(&token),
            total_amount, start_time, end_time,
        });

        object::address_to_object<VestedTokens>(vault_addr)
    }

    public entry fun claim_vested(
        user: &signer,
        vest: Object<VestedTokens>,
    ) acquires VestedTokens {
        let user_addr = signer::address_of(user);
        assert!(object::owner(vest) == user_addr, E_NOT_OWNER);

        let vest_addr = object::object_address(&vest);

        let (claimable, remaining) = {
            let v = borrow_global_mut<VestedTokens>(vest_addr);
            let claimable = vested_available(v) - v.claimed_amount;
            assert!(claimable > 0, E_NOTHING_CLAIMABLE);
            v.claimed_amount = v.claimed_amount + claimable;
            let vault_signer = object::generate_signer_for_extending(&v.extend_ref);
            let fa = primary_fungible_store::withdraw(&vault_signer, v.token, claimable);
            primary_fungible_store::deposit(user_addr, fa);
            (claimable, v.total_amount - v.claimed_amount)
        };

        event::emit(VestingClaimed {
            owner: user_addr, vest_addr, claimed: claimable,
            remaining, timestamp: timestamp::now_seconds(),
        });

        if (remaining == 0) {
            let VestedTokens { token: _, total_amount: _, claimed_amount: _,
                start_time: _, end_time: _, extend_ref: _, delete_ref }
                = move_from<VestedTokens>(vest_addr);
            object::delete(delete_ref);
        };
    }

    fun vested_available(v: &VestedTokens): u64 {
        let now = timestamp::now_seconds();
        if (now <= v.start_time) return 0;
        if (now >= v.end_time) return v.total_amount;
        let elapsed = (now - v.start_time as u64);
        let duration = (v.end_time - v.start_time as u64);
        ((v.total_amount as u128) * (elapsed as u128) / (duration as u128) as u64)
    }

    // ===== Mode 3: STAKE =====

    public entry fun create_reward_pool(
        creator: &signer,
        staked_token: Object<Metadata>,
        reward_token: Object<Metadata>,
        max_rate: u64,
        stake_target: u64,
    ) {
        create_pool(creator, staked_token, reward_token, max_rate, stake_target);
    }

    fun create_pool(
        creator: &signer,
        staked_token: Object<Metadata>,
        reward_token: Object<Metadata>,
        max_rate: u64,
        stake_target: u64,
    ): Object<RewardPool> {
        assert!(max_rate > 0, E_ZERO_AMOUNT);
        assert!(stake_target > 0, E_ZERO_AMOUNT);
        collect_fee(creator);

        let creator_addr = signer::address_of(creator);
        let ctor = object::create_object(creator_addr);
        let pool_signer = object::generate_signer(&ctor);
        let pool_addr = signer::address_of(&pool_signer);
        let extend_ref = object::generate_extend_ref(&ctor);

        move_to(&pool_signer, RewardPool {
            staked_token, reward_token, max_rate, stake_target,
            acc_reward_per_share: 0,
            last_reward_time: timestamp::now_seconds(),
            total_staked: 0,
            reward_balance: 0,
            extend_ref,
        });

        event::emit(RewardPoolCreated {
            creator: creator_addr, pool_addr,
            staked_token: object::object_address(&staked_token),
            reward_token: object::object_address(&reward_token),
            max_rate, stake_target,
        });

        object::address_to_object<RewardPool>(pool_addr)
    }

    public entry fun deposit_rewards(
        depositor: &signer,
        pool: Object<RewardPool>,
        amount: u64,
    ) acquires RewardPool {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let pool_addr = object::object_address(&pool);
        let rp = borrow_global_mut<RewardPool>(pool_addr);

        let fa = primary_fungible_store::withdraw(depositor, rp.reward_token, amount);
        let pool_signer = object::generate_signer_for_extending(&rp.extend_ref);
        primary_fungible_store::deposit(signer::address_of(&pool_signer), fa);
        rp.reward_balance = rp.reward_balance + amount;

        event::emit(RewardsDeposited {
            depositor: signer::address_of(depositor),
            pool_addr, amount, new_balance: rp.reward_balance,
        });
    }

    public entry fun stake_tokens(
        user: &signer,
        pool: Object<RewardPool>,
        amount: u64,
    ) acquires RewardPool {
        create_stake(user, pool, amount);
    }

    fun create_stake(
        user: &signer,
        pool: Object<RewardPool>,
        amount: u64,
    ): Object<StakePosition> acquires RewardPool {
        assert!(amount > 0, E_ZERO_AMOUNT);
        collect_fee(user);

        let pool_addr = object::object_address(&pool);
        let rp = borrow_global_mut<RewardPool>(pool_addr);
        update_reward_pool(rp);

        let user_addr = signer::address_of(user);
        let fa = primary_fungible_store::withdraw(user, rp.staked_token, amount);

        let ctor = object::create_object(user_addr);
        let stake_signer = object::generate_signer(&ctor);
        let stake_addr = signer::address_of(&stake_signer);
        let extend_ref = object::generate_extend_ref(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        let pool_signer = object::generate_signer_for_extending(&rp.extend_ref);
        primary_fungible_store::deposit(signer::address_of(&pool_signer), fa);

        let reward_debt = (amount as u128) * rp.acc_reward_per_share / SCALE;
        move_to(&stake_signer, StakePosition {
            pool_addr, amount, reward_debt, extend_ref, delete_ref,
        });

        rp.total_staked = rp.total_staked + amount;

        event::emit(TokensStaked {
            user: user_addr, stake_addr, pool_addr,
            amount, timestamp: timestamp::now_seconds(),
        });

        object::address_to_object<StakePosition>(stake_addr)
    }

    public entry fun claim_stake_rewards(
        user: &signer,
        stake: Object<StakePosition>,
    ) acquires RewardPool, StakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let sp = borrow_global_mut<StakePosition>(stake_addr);
        let rp = borrow_global_mut<RewardPool>(sp.pool_addr);
        update_reward_pool(rp);

        let pending = pending_reward(sp.amount, rp.acc_reward_per_share, sp.reward_debt);
        assert!(pending > 0, E_NOTHING_CLAIMABLE);
        sp.reward_debt = (sp.amount as u128) * rp.acc_reward_per_share / SCALE;

        {
            let pool_signer = object::generate_signer_for_extending(&rp.extend_ref);
            let fa = primary_fungible_store::withdraw(&pool_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, fa);
        };

        event::emit(StakeRewardsClaimed {
            user: user_addr, stake_addr,
            amount: pending, timestamp: timestamp::now_seconds(),
        });
    }

    public entry fun unstake_tokens(
        user: &signer,
        stake: Object<StakePosition>,
    ) acquires RewardPool, StakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let StakePosition { pool_addr, amount, reward_debt, extend_ref: _, delete_ref }
            = move_from<StakePosition>(stake_addr);

        let rp = borrow_global_mut<RewardPool>(pool_addr);
        update_reward_pool(rp);

        let pending = pending_reward(amount, rp.acc_reward_per_share, reward_debt);

        let pool_signer = object::generate_signer_for_extending(&rp.extend_ref);

        if (pending > 0) {
            let reward_fa = primary_fungible_store::withdraw(&pool_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, reward_fa);
        };

        let staked_fa = primary_fungible_store::withdraw(&pool_signer, rp.staked_token, amount);
        primary_fungible_store::deposit(user_addr, staked_fa);

        rp.total_staked = rp.total_staked - amount;
        object::delete(delete_ref);

        event::emit(TokensUnstaked {
            user: user_addr, stake_addr, pool_addr, amount,
            rewards_claimed: pending, timestamp: timestamp::now_seconds(),
        });
    }

    // ===== Internal =====

    fun update_reward_pool(rp: &mut RewardPool) {
        let now = timestamp::now_seconds();
        if (now <= rp.last_reward_time) return;
        if (rp.total_staked == 0) {
            rp.last_reward_time = now;
            return
        };

        let elapsed = now - rp.last_reward_time;
        let rate = emission_rate(rp.total_staked, rp.max_rate, rp.stake_target);
        let total_reward_u128 = (elapsed as u128) * (rate as u128);
        let total_reward = if (total_reward_u128 > (rp.reward_balance as u128)) {
            rp.reward_balance
        } else {
            (total_reward_u128 as u64)
        };

        if (total_reward > 0) {
            let added_acc = (total_reward as u128) * SCALE / (rp.total_staked as u128);
            let actual_distributed = ((added_acc * (rp.total_staked as u128) / SCALE) as u64);
            rp.acc_reward_per_share = rp.acc_reward_per_share + added_acc;
            rp.reward_balance = rp.reward_balance - actual_distributed;
        };
        rp.last_reward_time = now;
    }

    fun emission_rate(total_staked: u64, max_rate: u64, stake_target: u64): u64 {
        let capped = if (total_staked > stake_target) stake_target else total_staked;
        (((capped as u128) * (max_rate as u128) / (stake_target as u128)) as u64)
    }

    fun pending_reward(amount: u64, acc: u128, debt: u128): u64 {
        let raw = (amount as u128) * acc / SCALE;
        if (raw > debt) ((raw - debt) as u64) else 0
    }

    // ===== Views =====

    #[view]
    public fun lock_info(locker: Object<LockedTokens>): (address, u64, u64) acquires LockedTokens {
        let l = borrow_global<LockedTokens>(object::object_address(&locker));
        (object::object_address(&l.token), l.amount, l.unlock_at)
    }

    #[view]
    public fun vest_info(vest: Object<VestedTokens>): (address, u64, u64, u64, u64) acquires VestedTokens {
        let v = borrow_global<VestedTokens>(object::object_address(&vest));
        (object::object_address(&v.token), v.total_amount, v.claimed_amount, v.start_time, v.end_time)
    }

    #[view]
    public fun vest_claimable(vest: Object<VestedTokens>): u64 acquires VestedTokens {
        let v = borrow_global<VestedTokens>(object::object_address(&vest));
        vested_available(v) - v.claimed_amount
    }

    #[view]
    public fun reward_pool_info(pool: Object<RewardPool>): (address, address, u64, u64, u64, u64) acquires RewardPool {
        let rp = borrow_global<RewardPool>(object::object_address(&pool));
        (
            object::object_address(&rp.staked_token),
            object::object_address(&rp.reward_token),
            rp.max_rate, rp.stake_target,
            rp.total_staked, rp.reward_balance,
        )
    }

    #[view]
    public fun stake_info(stake: Object<StakePosition>): (address, u64) acquires StakePosition {
        let sp = borrow_global<StakePosition>(object::object_address(&stake));
        (sp.pool_addr, sp.amount)
    }

    #[view]
    public fun stake_pending_reward(stake: Object<StakePosition>): u64 acquires RewardPool, StakePosition {
        let stake_addr = object::object_address(&stake);
        let sp = borrow_global<StakePosition>(stake_addr);
        let rp = borrow_global<RewardPool>(sp.pool_addr);
        let now = timestamp::now_seconds();
        let elapsed = if (now > rp.last_reward_time) now - rp.last_reward_time else 0;
        let rate = emission_rate(rp.total_staked, rp.max_rate, rp.stake_target);
        let extra = if (rp.total_staked > 0 && elapsed > 0) {
            let uncapped = (elapsed as u128) * (rate as u128);
            let capped = if (uncapped > (rp.reward_balance as u128)) {
                (rp.reward_balance as u128)
            } else { uncapped };
            capped * SCALE / (rp.total_staked as u128)
        } else { 0 };
        pending_reward(sp.amount, rp.acc_reward_per_share + extra, sp.reward_debt)
    }

    // ===== Test-only wrappers =====

    #[test_only]
    public fun lock_tokens_and_get(
        user: &signer,
        token: Object<Metadata>,
        amount: u64,
        unlock_at: u64,
    ): Object<LockedTokens> {
        create_lock(user, token, amount, unlock_at)
    }

    #[test_only]
    public fun create_vesting_and_get(
        user: &signer,
        token: Object<Metadata>,
        total_amount: u64,
        start_time: u64,
        end_time: u64,
    ): Object<VestedTokens> {
        create_vest(user, token, total_amount, start_time, end_time)
    }

    #[test_only]
    public fun create_pool_and_get(
        creator: &signer,
        staked_token: Object<Metadata>,
        reward_token: Object<Metadata>,
        max_rate: u64,
        stake_target: u64,
    ): Object<RewardPool> {
        create_pool(creator, staked_token, reward_token, max_rate, stake_target)
    }

    #[test_only]
    public fun stake_tokens_and_get(
        user: &signer,
        pool: Object<RewardPool>,
        amount: u64,
    ): Object<StakePosition> acquires RewardPool {
        create_stake(user, pool, amount)
    }
}
