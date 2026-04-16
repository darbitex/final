#[test_only]
module darbitex_vault::vault_tests {
    use std::option;
    use std::signer;
    use std::string;

    use aptos_framework::account;
    use aptos_framework::aptos_coin;
    use aptos_framework::coin;
    use aptos_framework::fungible_asset::{Self, Metadata, MintRef};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex_vault::vault;

    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;
    const APT_FUND: u64 = 1_000_000_000; // 10 APT
    const TOKEN_SUPPLY: u64 = 100_000_000_00; // 100 tokens (8 dec)

    struct TestMints has key {
        mint_a: MintRef,
        mint_b: MintRef,
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

    fun setup(
        aptos: &signer,
        admin: &signer,
        user: &signer,
    ): (Object<Metadata>, Object<Metadata>) {
        timestamp::set_time_has_started_for_testing(aptos);

        let admin_addr = signer::address_of(admin);
        let user_addr = signer::address_of(user);
        account::create_account_for_test(admin_addr);
        account::create_account_for_test(user_addr);
        account::create_account_for_test(TREASURY);

        let (burn_cap, mint_cap) = aptos_coin::initialize_for_test(aptos);
        coin::register<aptos_coin::AptosCoin>(user);
        let coins = coin::mint<aptos_coin::AptosCoin>(APT_FUND, &mint_cap);
        coin::deposit(user_addr, coins);
        coin::destroy_burn_cap(burn_cap);
        coin::destroy_mint_cap(mint_cap);

        let (meta_a, mint_a) = create_fa(admin, b"TokenA");
        let (meta_b, mint_b) = create_fa(admin, b"TokenB");

        primary_fungible_store::mint(&mint_a, user_addr, TOKEN_SUPPLY);
        primary_fungible_store::mint(&mint_b, user_addr, TOKEN_SUPPLY);

        move_to(admin, TestMints { mint_a, mint_b });

        (meta_a, meta_b)
    }

    // ===== LOCK TESTS =====

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun lock_happy_path(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        let user_addr = signer::address_of(user);
        let bal_before = primary_fungible_store::balance(user_addr, meta_a);

        let locker = vault::lock_tokens_and_get(user, meta_a, 5_000_000_00, 1000);

        let bal_after = primary_fungible_store::balance(user_addr, meta_a);
        assert!(bal_before - bal_after == 5_000_000_00, 100);
        assert!(object::owner(locker) == user_addr, 101);

        let (token_addr, amount, unlock_at) = vault::lock_info(locker);
        assert!(token_addr == object::object_address(&meta_a), 102);
        assert!(amount == 5_000_000_00, 103);
        assert!(unlock_at == 1000, 104);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun redeem_after_unlock(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        let user_addr = signer::address_of(user);
        let bal_before = primary_fungible_store::balance(user_addr, meta_a);

        let locker = vault::lock_tokens_and_get(user, meta_a, 1_000_000_00, 500);
        timestamp::update_global_time_for_test_secs(600);
        vault::redeem_locked(user, locker);

        let bal_after = primary_fungible_store::balance(user_addr, meta_a);
        assert!(bal_after == bal_before, 200);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    #[expected_failure(abort_code = 2, location = darbitex_vault::vault)]
    fun redeem_before_unlock_aborts(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        let locker = vault::lock_tokens_and_get(user, meta_a, 1_000_000_00, 1000);
        timestamp::update_global_time_for_test_secs(500);
        vault::redeem_locked(user, locker);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    #[expected_failure(abort_code = 3, location = darbitex_vault::vault)]
    fun lock_unlock_at_past_aborts(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        timestamp::update_global_time_for_test_secs(500);
        vault::lock_tokens(user, meta_a, 1_000_000_00, 100);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    #[expected_failure(abort_code = 4, location = darbitex_vault::vault)]
    fun lock_zero_amount_aborts(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        vault::lock_tokens(user, meta_a, 0, 1000);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B, mallory = @0xDEAD)]
    #[expected_failure(abort_code = 1, location = darbitex_vault::vault)]
    fun redeem_non_owner_aborts(
        aptos: &signer, admin: &signer, user: &signer, mallory: &signer,
    ) {
        let (meta_a, _) = setup(aptos, admin, user);
        account::create_account_for_test(signer::address_of(mallory));
        let locker = vault::lock_tokens_and_get(user, meta_a, 1_000_000_00, 500);
        timestamp::update_global_time_for_test_secs(600);
        vault::redeem_locked(mallory, locker);
    }

    // ===== VEST TESTS =====

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun vest_happy_path(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        let user_addr = signer::address_of(user);

        let vest = vault::create_vesting_and_get(user, meta_a, 10_000, 100, 200);

        assert!(object::owner(vest) == user_addr, 300);
        let (token_addr, total, claimed, start, end) = vault::vest_info(vest);
        assert!(token_addr == object::object_address(&meta_a), 301);
        assert!(total == 10_000, 302);
        assert!(claimed == 0, 303);
        assert!(start == 100, 304);
        assert!(end == 200, 305);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun vest_claim_partial(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        let user_addr = signer::address_of(user);

        let vest = vault::create_vesting_and_get(user, meta_a, 10_000, 100, 200);
        let bal_after_vest = primary_fungible_store::balance(user_addr, meta_a);

        timestamp::update_global_time_for_test_secs(150);
        assert!(vault::vest_claimable(vest) == 5_000, 310);

        vault::claim_vested(user, vest);
        let bal_after_claim = primary_fungible_store::balance(user_addr, meta_a);
        assert!(bal_after_claim - bal_after_vest == 5_000, 311);

        let (_, _, claimed, _, _) = vault::vest_info(vest);
        assert!(claimed == 5_000, 312);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun vest_claim_full_deletes(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        let user_addr = signer::address_of(user);
        let bal_before = primary_fungible_store::balance(user_addr, meta_a);

        let vest = vault::create_vesting_and_get(user, meta_a, 10_000, 100, 200);
        let vest_addr = object::object_address(&vest);

        timestamp::update_global_time_for_test_secs(300);
        vault::claim_vested(user, vest);

        let bal_after = primary_fungible_store::balance(user_addr, meta_a);
        assert!(bal_after == bal_before, 320);
        assert!(!object::object_exists<vault::VestedTokens>(vest_addr), 321);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    #[expected_failure(abort_code = 5, location = darbitex_vault::vault)]
    fun vest_claim_before_start_aborts(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        let vest = vault::create_vesting_and_get(user, meta_a, 10_000, 100, 200);
        timestamp::update_global_time_for_test_secs(50);
        vault::claim_vested(user, vest);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    #[expected_failure(abort_code = 6, location = darbitex_vault::vault)]
    fun vest_invalid_schedule_aborts(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);
        vault::create_vesting(user, meta_a, 10_000, 200, 100);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun vest_claimable_view(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, _) = setup(aptos, admin, user);

        let vest = vault::create_vesting_and_get(user, meta_a, 10_000, 100, 200);

        assert!(vault::vest_claimable(vest) == 0, 330);

        timestamp::update_global_time_for_test_secs(125);
        assert!(vault::vest_claimable(vest) == 2_500, 331);

        timestamp::update_global_time_for_test_secs(175);
        assert!(vault::vest_claimable(vest) == 7_500, 332);

        timestamp::update_global_time_for_test_secs(999);
        assert!(vault::vest_claimable(vest) == 10_000, 333);
    }

    // ===== STAKE TESTS =====

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun stake_pool_and_deposit(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);

        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        let (stk_addr, rwd_addr, max_rate, target, total_staked, balance) =
            vault::reward_pool_info(pool);
        assert!(stk_addr == object::object_address(&meta_a), 400);
        assert!(rwd_addr == object::object_address(&meta_b), 401);
        assert!(max_rate == 100, 402);
        assert!(target == 1_000, 403);
        assert!(total_staked == 0, 404);
        assert!(balance == 0, 405);

        vault::deposit_rewards(user, pool, 50_000);
        let (_, _, _, _, _, balance2) = vault::reward_pool_info(pool);
        assert!(balance2 == 50_000, 406);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun stake_and_claim_rewards(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);
        let user_addr = signer::address_of(user);

        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::deposit_rewards(user, pool, 50_000);

        let stake = vault::stake_tokens_and_get(user, pool, 1_000);

        let reward_bal_before = primary_fungible_store::balance(user_addr, meta_b);

        timestamp::update_global_time_for_test_secs(10);
        vault::claim_stake_rewards(user, stake);

        let reward_bal_after = primary_fungible_store::balance(user_addr, meta_b);
        assert!(reward_bal_after - reward_bal_before == 1_000, 410);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun unstake_returns_principal_and_rewards(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);
        let user_addr = signer::address_of(user);

        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::deposit_rewards(user, pool, 50_000);

        let stk_bal_before = primary_fungible_store::balance(user_addr, meta_a);
        let rwd_bal_before = primary_fungible_store::balance(user_addr, meta_b);

        let stake = vault::stake_tokens_and_get(user, pool, 1_000);
        let stake_addr = object::object_address(&stake);

        timestamp::update_global_time_for_test_secs(10);
        vault::unstake_tokens(user, stake);

        let stk_bal_after = primary_fungible_store::balance(user_addr, meta_a);
        let rwd_bal_after = primary_fungible_store::balance(user_addr, meta_b);

        assert!(stk_bal_after == stk_bal_before, 420);
        assert!(rwd_bal_after - rwd_bal_before == 1_000, 421);

        let (_, _, _, _, total_staked, _) = vault::reward_pool_info(pool);
        assert!(total_staked == 0, 422);
        assert!(!object::object_exists<vault::StakePosition>(stake_addr), 423);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun stake_pending_view(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);

        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::deposit_rewards(user, pool, 50_000);
        let stake = vault::stake_tokens_and_get(user, pool, 1_000);

        assert!(vault::stake_pending_reward(stake) == 0, 430);

        timestamp::update_global_time_for_test_secs(5);
        assert!(vault::stake_pending_reward(stake) == 500, 431);

        timestamp::update_global_time_for_test_secs(20);
        assert!(vault::stake_pending_reward(stake) == 2_000, 432);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    #[expected_failure(abort_code = 4, location = darbitex_vault::vault)]
    fun create_pool_zero_rate_aborts(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);
        vault::create_reward_pool(user, meta_a, meta_b, 0, 1_000);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    #[expected_failure(abort_code = 4, location = darbitex_vault::vault)]
    fun stake_zero_amount_aborts(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);
        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::stake_tokens(user, pool, 0);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun stake_under_target_emits_less(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);

        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::deposit_rewards(user, pool, 50_000);

        let stake = vault::stake_tokens_and_get(user, pool, 500);

        timestamp::update_global_time_for_test_secs(10);
        let pending = vault::stake_pending_reward(stake);
        assert!(pending == 500, 440);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    #[expected_failure(abort_code = 5, location = darbitex_vault::vault)]
    fun claim_stake_zero_pending_aborts(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);
        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::deposit_rewards(user, pool, 50_000);
        let stake = vault::stake_tokens_and_get(user, pool, 1_000);
        vault::claim_stake_rewards(user, stake);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun view_caps_at_reward_balance(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);
        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::deposit_rewards(user, pool, 500);
        let stake = vault::stake_tokens_and_get(user, pool, 1_000);

        timestamp::update_global_time_for_test_secs(100);
        let pending = vault::stake_pending_reward(stake);
        assert!(pending == 500, 460);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun multi_epoch_claim_no_underflow(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);
        let user_addr = signer::address_of(user);

        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::deposit_rewards(user, pool, 500);
        let stake = vault::stake_tokens_and_get(user, pool, 1_000);

        let rwd_before = primary_fungible_store::balance(user_addr, meta_b);

        timestamp::update_global_time_for_test_secs(100);
        vault::unstake_tokens(user, stake);

        let rwd_after = primary_fungible_store::balance(user_addr, meta_b);
        assert!(rwd_after - rwd_before == 500, 470);

        let (_, _, _, _, total_staked, balance) = vault::reward_pool_info(pool);
        assert!(total_staked == 0, 471);
        assert!(balance == 0, 472);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun stake_info_view(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);

        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::deposit_rewards(user, pool, 50_000);
        let stake = vault::stake_tokens_and_get(user, pool, 1_000);

        let (pool_addr, amount) = vault::stake_info(stake);
        assert!(pool_addr == object::object_address(&pool), 480);
        assert!(amount == 1_000, 481);
    }

    #[test(aptos = @0x1, admin = @darbitex_vault, user = @0xB0B)]
    fun reward_balance_caps_emission(aptos: &signer, admin: &signer, user: &signer) {
        let (meta_a, meta_b) = setup(aptos, admin, user);
        let user_addr = signer::address_of(user);

        let pool = vault::create_pool_and_get(user, meta_a, meta_b, 100, 1_000);
        vault::deposit_rewards(user, pool, 500);

        let rwd_before = primary_fungible_store::balance(user_addr, meta_b);
        let stake = vault::stake_tokens_and_get(user, pool, 1_000);

        timestamp::update_global_time_for_test_secs(100);
        vault::unstake_tokens(user, stake);

        let rwd_after = primary_fungible_store::balance(user_addr, meta_b);
        assert!(rwd_after - rwd_before == 500, 450);
    }
}
