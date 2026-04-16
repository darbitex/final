#[test_only]
module darbitex_staking::staking_tests {
    use std::option;
    use std::signer;
    use std::string;
    use std::bcs;

    use aptos_framework::account;
    use aptos_framework::aptos_coin;
    use aptos_framework::coin;
    use aptos_framework::fungible_asset::{Self, Metadata, MintRef};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool;
    use darbitex::pool_factory;
    use darbitex_staking::staking;

    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;
    const APT_FUND: u64 = 500_000_000;
    const SEED: u64 = 10_000_000;
    const USER_AMT: u64 = 5_000_000;
    const REWARD_DEPOSIT: u64 = 50_000;

    struct TestMints has key {
        mint_a: MintRef,
        mint_b: MintRef,
        mint_r: MintRef,
    }

    fun create_fa(creator: &signer, name: vector<u8>): (Object<Metadata>, MintRef) {
        let ctor = object::create_named_object(creator, name);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &ctor,
            option::none(),
            string::utf8(name),
            string::utf8(b"T"),
            8,
            string::utf8(b""),
            string::utf8(b""),
        );
        let mint_ref = fungible_asset::generate_mint_ref(&ctor);
        let metadata = object::object_from_constructor_ref<Metadata>(&ctor);
        (metadata, mint_ref)
    }

    fun sort_pair(
        a: Object<Metadata>, b: Object<Metadata>,
    ): (Object<Metadata>, Object<Metadata>) {
        let ba = bcs::to_bytes(&object::object_address(&a));
        let bb = bcs::to_bytes(&object::object_address(&b));
        if (ba < bb) { (a, b) } else { (b, a) }
    }

    fun setup(
        aptos: &signer,
        darbitex: &signer,
        user: &signer,
    ): (Object<Metadata>, Object<Metadata>, Object<Metadata>, address) {
        timestamp::set_time_has_started_for_testing(aptos);

        let darbitex_addr = signer::address_of(darbitex);
        let user_addr = signer::address_of(user);
        account::create_account_for_test(darbitex_addr);
        account::create_account_for_test(user_addr);
        account::create_account_for_test(TREASURY);

        let (burn_cap, mint_cap) = aptos_coin::initialize_for_test(aptos);
        coin::register<aptos_coin::AptosCoin>(user);
        let coins = coin::mint<aptos_coin::AptosCoin>(APT_FUND, &mint_cap);
        coin::deposit(user_addr, coins);
        coin::destroy_burn_cap(burn_cap);
        coin::destroy_mint_cap(mint_cap);

        let (meta_x, mint_x) = create_fa(darbitex, b"token_x");
        let (meta_y, mint_y) = create_fa(darbitex, b"token_y");
        let (meta_r, mint_r) = create_fa(darbitex, b"reward");
        let (meta_a, meta_b) = sort_pair(meta_x, meta_y);

        primary_fungible_store::mint(&mint_x, user_addr, SEED + USER_AMT);
        primary_fungible_store::mint(&mint_y, user_addr, SEED + USER_AMT);
        primary_fungible_store::mint(&mint_r, user_addr, REWARD_DEPOSIT * 2);

        move_to(darbitex, TestMints { mint_a: mint_x, mint_b: mint_y, mint_r });

        pool_factory::init_factory(darbitex);
        pool_factory::create_canonical_pool(user, meta_a, meta_b, SEED, SEED);

        let pool_addr = pool_factory::canonical_pool_address_of(
            object::object_address(&meta_a),
            object::object_address(&meta_b),
        );

        (meta_a, meta_b, meta_r, pool_addr)
    }

    fun setup_with_pool(
        aptos: &signer,
        darbitex: &signer,
        user: &signer,
    ): (Object<Metadata>, address, Object<staking::LpRewardPool>) {
        let (_, _, meta_r, pool_addr) = setup(aptos, darbitex, user);

        let rp = staking::create_lp_reward_pool_and_get(
            user, pool_addr, meta_r, 100, 1_000_000,
        );
        staking::deposit_rewards(user, rp, REWARD_DEPOSIT);

        (meta_r, pool_addr, rp)
    }

    // ===== 1. Create reward pool =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun create_pool_happy_path(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, _, meta_r, pool_addr) = setup(aptos, darbitex, user);

        let rp = staking::create_lp_reward_pool_and_get(
            user, pool_addr, meta_r, 100, 1_000_000,
        );
        let (pa, rt, mr, st, ts, rb) = staking::reward_pool_info(rp);
        assert!(pa == pool_addr, 100);
        assert!(rt == object::object_address(&meta_r), 101);
        assert!(mr == 100, 102);
        assert!(st == 1_000_000, 103);
        assert!(ts == 0, 104);
        assert!(rb == 0, 105);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 3, location = darbitex_staking::staking)]
    fun create_pool_wrong_pool_aborts(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, _, meta_r, _) = setup(aptos, darbitex, user);
        staking::create_lp_reward_pool(user, @0xDEAD, meta_r, 100, 1_000_000);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 2, location = darbitex_staking::staking)]
    fun create_pool_zero_rate_aborts(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, _, meta_r, pool_addr) = setup(aptos, darbitex, user);
        staking::create_lp_reward_pool(user, pool_addr, meta_r, 0, 1_000_000);
    }

    // ===== 2. Deposit rewards =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun deposit_rewards_increases_balance(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, _, meta_r, pool_addr) = setup(aptos, darbitex, user);
        let rp = staking::create_lp_reward_pool_and_get(
            user, pool_addr, meta_r, 100, 1_000_000,
        );

        staking::deposit_rewards(user, rp, REWARD_DEPOSIT);
        let (_, _, _, _, _, rb) = staking::reward_pool_info(rp);
        assert!(rb == REWARD_DEPOSIT, 200);
    }

    // ===== 3. Stake LP =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun stake_lp_happy_path(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_pool(aptos, darbitex, user);

        let position = pool::add_liquidity(user, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let shares = pool::position_shares(position);
        let pos_addr = object::object_address(&position);

        let stake = staking::stake_lp_and_get(user, rp, position);
        let (rp_addr, staked_pos_addr, staked_shares) = staking::stake_info(stake);
        assert!(rp_addr == object::object_address(&rp), 300);
        assert!(staked_pos_addr == pos_addr, 301);
        assert!(staked_shares == shares, 302);

        let (_, _, _, _, ts, _) = staking::reward_pool_info(rp);
        assert!(ts == shares, 303);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun stake_validates_correct_pool(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_pool(aptos, darbitex, user);

        let position = pool::add_liquidity(user, pool_addr, USER_AMT / 4, USER_AMT / 4, 1);
        let _stake = staking::stake_lp_and_get(user, rp, position);
    }

    // ===== 4. Claim staking rewards =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun claim_rewards_after_time(aptos: &signer, darbitex: &signer, user: &signer) {
        let (meta_r, pool_addr, rp) = setup_with_pool(aptos, darbitex, user);
        let user_addr = signer::address_of(user);

        let position = pool::add_liquidity(user, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let _stake = staking::stake_lp_and_get(user, rp, position);

        let rwd_before = primary_fungible_store::balance(user_addr, meta_r);
        timestamp::update_global_time_for_test_secs(10);
        staking::claim_rewards(user, _stake);
        let rwd_after = primary_fungible_store::balance(user_addr, meta_r);

        assert!(rwd_after > rwd_before, 400);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 4, location = darbitex_staking::staking)]
    fun claim_zero_pending_aborts(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_pool(aptos, darbitex, user);

        let position = pool::add_liquidity(user, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let stake = staking::stake_lp_and_get(user, rp, position);
        staking::claim_rewards(user, stake);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 1, location = darbitex_staking::staking)]
    fun claim_non_owner_aborts(
        aptos: &signer, darbitex: &signer, user: &signer,
    ) {
        let (_, pool_addr, rp) = setup_with_pool(aptos, darbitex, user);

        let position = pool::add_liquidity(user, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let stake = staking::stake_lp_and_get(user, rp, position);

        timestamp::update_global_time_for_test_secs(10);
        staking::claim_rewards(darbitex, stake);
    }

    // ===== 5. Claim LP fees (proxy) =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun claim_lp_fees_proxy(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_pool(aptos, darbitex, user);
        let user_addr = signer::address_of(user);

        let position = pool::add_liquidity(user, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let stake = staking::stake_lp_and_get(user, rp, position);

        let (tok_a, _) = pool::pool_tokens(pool_addr);
        let swap_fa = primary_fungible_store::withdraw(user, tok_a, 500_000);
        let fa_out = pool::swap(pool_addr, user_addr, swap_fa, 1);
        primary_fungible_store::deposit(user_addr, fa_out);

        staking::claim_lp_fees(user, stake);
    }

    // ===== 6. Unstake =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun unstake_returns_position_and_rewards(aptos: &signer, darbitex: &signer, user: &signer) {
        let (meta_r, pool_addr, rp) = setup_with_pool(aptos, darbitex, user);
        let user_addr = signer::address_of(user);

        let position = pool::add_liquidity(user, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let pos_addr = object::object_address(&position);
        let stake = staking::stake_lp_and_get(user, rp, position);
        let stake_addr = object::object_address(&stake);

        let rwd_before = primary_fungible_store::balance(user_addr, meta_r);
        timestamp::update_global_time_for_test_secs(10);
        staking::unstake_lp(user, stake);
        let rwd_after = primary_fungible_store::balance(user_addr, meta_r);

        assert!(rwd_after > rwd_before, 600);
        assert!(object::owner(position) == user_addr, 601);
        assert!(!object::object_exists<staking::LpStakePosition>(stake_addr), 602);

        let (_, _, _, _, ts, _) = staking::reward_pool_info(rp);
        assert!(ts == 0, 603);

        let _ = pos_addr;
    }

    // ===== 7. Pending reward view =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun pending_view_increases_with_time(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_pool(aptos, darbitex, user);

        let position = pool::add_liquidity(user, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let stake = staking::stake_lp_and_get(user, rp, position);

        assert!(staking::stake_pending_reward(stake) == 0, 700);

        timestamp::update_global_time_for_test_secs(5);
        let p5 = staking::stake_pending_reward(stake);
        assert!(p5 > 0, 701);

        timestamp::update_global_time_for_test_secs(20);
        let p20 = staking::stake_pending_reward(stake);
        assert!(p20 > p5, 702);
    }

    // ===== 8. Reward balance caps emission =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun reward_balance_caps_emission(aptos: &signer, darbitex: &signer, user: &signer) {
        let (meta_r, pool_addr, rp) = setup_with_pool(aptos, darbitex, user);
        let user_addr = signer::address_of(user);

        let position = pool::add_liquidity(user, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let _stake = staking::stake_lp_and_get(user, rp, position);

        let rwd_before = primary_fungible_store::balance(user_addr, meta_r);

        timestamp::update_global_time_for_test_secs(99999);
        staking::unstake_lp(user, _stake);

        let rwd_after = primary_fungible_store::balance(user_addr, meta_r);
        let claimed = rwd_after - rwd_before;
        assert!(claimed <= REWARD_DEPOSIT, 800);
    }
}
