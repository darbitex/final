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
        creator: address,
        reward_pool_addr: address,
        pool_addr: address,
        reward_token: address,
        max_rate: u64,
        stake_target: u64,
    }

    #[event]
    struct LpRewardsDeposited has drop, store {
        depositor: address,
        reward_pool_addr: address,
        amount: u64,
        new_balance: u64,
    }

    #[event]
    struct LpStaked has drop, store {
        user: address,
        stake_addr: address,
        reward_pool_addr: address,
        position_addr: address,
        shares: u64,
        timestamp: u64,
    }

    #[event]
    struct LpRewardsClaimed has drop, store {
        user: address,
        stake_addr: address,
        amount: u64,
        timestamp: u64,
    }

    #[event]
    struct LpFeesClaimed has drop, store {
        user: address,
        stake_addr: address,
        fees_a: u64,
        fees_b: u64,
        timestamp: u64,
    }

    #[event]
    struct LpUnstaked has drop, store {
        user: address,
        stake_addr: address,
        pool_addr: address,
        position_addr: address,
        shares: u64,
        rewards_claimed: u64,
        timestamp: u64,
    }

    fun collect_fee(user: &signer) {
        let apt_meta = object::address_to_object<Metadata>(@0xa);
        let fa = primary_fungible_store::withdraw(user, apt_meta, CREATION_FEE);
        primary_fungible_store::deposit(TREASURY, fa);
    }

    // ===== Create reward pool =====

    public entry fun create_lp_reward_pool(
        creator: &signer,
        pool_addr: address,
        reward_token: Object<Metadata>,
        max_rate: u64,
        stake_target: u64,
    ) {
        create_reward_pool(creator, pool_addr, reward_token, max_rate, stake_target);
    }

    fun create_reward_pool(
        creator: &signer,
        pool_addr: address,
        reward_token: Object<Metadata>,
        max_rate: u64,
        stake_target: u64,
    ): Object<LpRewardPool> {
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
            total_staked_shares: 0,
            reward_balance: 0,
            extend_ref: object::generate_extend_ref(&ctor),
        });

        event::emit(LpRewardPoolCreated {
            creator: creator_addr, reward_pool_addr: rp_addr, pool_addr,
            reward_token: object::object_address(&reward_token),
            max_rate, stake_target,
        });

        object::address_to_object<LpRewardPool>(rp_addr)
    }

    // ===== Deposit rewards =====

    public entry fun deposit_rewards(
        depositor: &signer,
        reward_pool: Object<LpRewardPool>,
        amount: u64,
    ) acquires LpRewardPool {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let rp_addr = object::object_address(&reward_pool);
        let rp = borrow_global_mut<LpRewardPool>(rp_addr);
        update_pool(rp);

        let fa = primary_fungible_store::withdraw(depositor, rp.reward_token, amount);
        let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
        primary_fungible_store::deposit(signer::address_of(&rp_signer), fa);
        rp.reward_balance = rp.reward_balance + amount;

        event::emit(LpRewardsDeposited {
            depositor: signer::address_of(depositor),
            reward_pool_addr: rp_addr, amount, new_balance: rp.reward_balance,
        });
    }

    // ===== Stake LP =====

    public entry fun stake_lp(
        user: &signer,
        reward_pool: Object<LpRewardPool>,
        position: Object<LpPosition>,
    ) acquires LpRewardPool {
        create_stake(user, reward_pool, position);
    }

    fun create_stake(
        user: &signer,
        reward_pool: Object<LpRewardPool>,
        position: Object<LpPosition>,
    ): Object<LpStakePosition> acquires LpRewardPool {
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

        object::address_to_object<LpStakePosition>(stake_addr)
    }

    // ===== Claim staking rewards =====

    public entry fun claim_rewards(
        user: &signer,
        stake: Object<LpStakePosition>,
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

    // ===== Claim LP fees (proxy) =====

    public entry fun claim_lp_fees(
        user: &signer,
        stake: Object<LpStakePosition>,
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

    // ===== Unstake =====

    public entry fun unstake_lp(
        user: &signer,
        stake: Object<LpStakePosition>,
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

    // ===== Internal =====

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

    // ===== Views =====

    #[view]
    public fun reward_pool_info(
        reward_pool: Object<LpRewardPool>,
    ): (address, address, u64, u64, u64, u64) acquires LpRewardPool {
        let rp = borrow_global<LpRewardPool>(object::object_address(&reward_pool));
        (
            rp.pool_addr,
            object::object_address(&rp.reward_token),
            rp.max_rate, rp.stake_target,
            rp.total_staked_shares, rp.reward_balance,
        )
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

    #[test_only]
    public fun create_lp_reward_pool_and_get(
        creator: &signer, pool_addr: address, reward_token: Object<Metadata>,
        max_rate: u64, stake_target: u64,
    ): Object<LpRewardPool> {
        create_reward_pool(creator, pool_addr, reward_token, max_rate, stake_target)
    }

    #[test_only]
    public fun stake_lp_and_get(
        user: &signer, reward_pool: Object<LpRewardPool>, position: Object<LpPosition>,
    ): Object<LpStakePosition> acquires LpRewardPool {
        create_stake(user, reward_pool, position)
    }
}
