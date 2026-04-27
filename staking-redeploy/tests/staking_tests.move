#[test_only]
module darbitex_staking::staking_tests {
    use std::option;
    use std::signer;
    use std::string;
    use std::vector;
    use std::bcs;

    use aptos_framework::account;
    use aptos_framework::fungible_asset::{Self, Metadata, MintRef};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool::{Self, LpPosition};
    use darbitex::pool_factory;
    use darbitex_lp_locker::lock::{Self, LockedPosition};
    use darbitex_staking::staking::{Self, LpRewardPool, LpStakePosition};

    const SEED: u64 = 10_000_000;
    const USER_AMT: u64 = 5_000_000;
    const REWARD_DEPOSIT: u64 = 1_000_000;
    const MAX_RATE_PER_SEC: u64 = 100;

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

        let (meta_x, mint_x) = create_fa(darbitex, b"token_x");
        let (meta_y, mint_y) = create_fa(darbitex, b"token_y");
        let (meta_r, mint_r) = create_fa(darbitex, b"reward");
        let (meta_a, meta_b) = sort_pair(meta_x, meta_y);

        primary_fungible_store::mint(&mint_x, user_addr, SEED + USER_AMT);
        primary_fungible_store::mint(&mint_y, user_addr, SEED + USER_AMT);
        primary_fungible_store::mint(&mint_r, user_addr, REWARD_DEPOSIT * 4);

        move_to(darbitex, TestMints { mint_a: mint_x, mint_b: mint_y, mint_r });

        pool_factory::init_factory(darbitex);
        pool_factory::create_canonical_pool(user, meta_a, meta_b, SEED, SEED);

        let pool_addr = pool_factory::canonical_pool_address_of(
            object::object_address(&meta_a),
            object::object_address(&meta_b),
        );

        (meta_a, meta_b, meta_r, pool_addr)
    }

    fun setup_with_rp(
        aptos: &signer,
        darbitex: &signer,
        user: &signer,
    ): (Object<Metadata>, address, Object<LpRewardPool>) {
        let (_, _, meta_r, pool_addr) = setup(aptos, darbitex, user);
        let rp = staking::create_lp_reward_pool_and_get(
            user, pool_addr, meta_r, MAX_RATE_PER_SEC,
        );
        staking::deposit_rewards(user, rp, REWARD_DEPOSIT);
        (meta_r, pool_addr, rp)
    }

    fun fresh_position(user: &signer, pool_addr: address): Object<LpPosition> {
        pool::add_liquidity(user, pool_addr, USER_AMT / 2, USER_AMT / 2, 1)
    }

    // ===== 1. Reward pool creation =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun create_pool_happy_path(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, _, meta_r, pool_addr) = setup(aptos, darbitex, user);
        let rp = staking::create_lp_reward_pool_and_get(user, pool_addr, meta_r, MAX_RATE_PER_SEC);
        let (pa, rt, mr, ts, phys, comm) = staking::reward_pool_info(rp);
        assert!(pa == pool_addr, 1);
        assert!(rt == object::object_address(&meta_r), 2);
        assert!(mr == MAX_RATE_PER_SEC, 3);
        assert!(ts == 0, 4);
        assert!(phys == 0, 5);
        assert!(comm == 0, 6);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 3, location = darbitex_staking::staking)]
    fun create_pool_wrong_pool_aborts(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, _, meta_r, _) = setup(aptos, darbitex, user);
        staking::create_lp_reward_pool(user, @0xDEAD, meta_r, MAX_RATE_PER_SEC);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 5, location = darbitex_staking::staking)]
    fun create_pool_zero_rate_aborts(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, _, meta_r, pool_addr) = setup(aptos, darbitex, user);
        staking::create_lp_reward_pool(user, pool_addr, meta_r, 0);
    }

    // ===== 2. Permissionless deposit =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun deposit_rewards_increases_phys(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let _ = pool_addr;
        let (_, _, _, _, phys, _) = staking::reward_pool_info(rp);
        assert!(phys == REWARD_DEPOSIT, 100);

        staking::deposit_rewards(user, rp, REWARD_DEPOSIT);
        let (_, _, _, _, phys2, _) = staking::reward_pool_info(rp);
        assert!(phys2 == REWARD_DEPOSIT * 2, 101);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 2, location = darbitex_staking::staking)]
    fun deposit_zero_aborts(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, _, rp) = setup_with_rp(aptos, darbitex, user);
        staking::deposit_rewards(user, rp, 0);
    }

    // ===== 3. Stake naked =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun stake_naked_happy_path(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let position = fresh_position(user, pool_addr);
        let pos_addr = object::object_address(&position);
        let shares = pool::position_shares(position);

        let stake = staking::stake_lp_and_get(user, rp, position);
        let (rp_addr_out, source_addr, staked_shares, locked_variant) = staking::stake_info(stake);
        assert!(rp_addr_out == object::object_address(&rp), 200);
        assert!(source_addr == pos_addr, 201);
        assert!(staked_shares == shares, 202);
        assert!(!locked_variant, 203);
    }

    // ===== 4. Stake locked =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun stake_locked_happy_path(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let position = fresh_position(user, pool_addr);
        let shares = pool::position_shares(position);

        let locked = lock::lock_position_and_get(user, position, 100_000);
        let locked_addr = object::object_address(&locked);

        let stake = staking::stake_locked_lp_and_get(user, rp, locked);
        let (_, source_addr, staked_shares, locked_variant) = staking::stake_info(stake);
        assert!(source_addr == locked_addr, 300);
        assert!(staked_shares == shares, 301);
        assert!(locked_variant, 302);
        assert!(object::owner(locked) == object::object_address(&stake), 303);
    }

    // ===== 5. Claim rewards =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun claim_rewards_after_time(aptos: &signer, darbitex: &signer, user: &signer) {
        let (meta_r, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let user_addr = signer::address_of(user);
        let position = fresh_position(user, pool_addr);
        let stake = staking::stake_lp_and_get(user, rp, position);

        let before = primary_fungible_store::balance(user_addr, meta_r);
        timestamp::update_global_time_for_test_secs(10);
        staking::claim_rewards(user, stake);
        let after = primary_fungible_store::balance(user_addr, meta_r);
        assert!(after > before, 400);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 4, location = darbitex_staking::staking)]
    fun claim_zero_pending_aborts(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let position = fresh_position(user, pool_addr);
        let stake = staking::stake_lp_and_get(user, rp, position);
        staking::claim_rewards(user, stake);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B, mallory = @0xDEAD)]
    #[expected_failure(abort_code = 1, location = darbitex_staking::staking)]
    fun claim_non_owner_aborts(
        aptos: &signer, darbitex: &signer, user: &signer, mallory: &signer,
    ) {
        account::create_account_for_test(signer::address_of(mallory));
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let position = fresh_position(user, pool_addr);
        let stake = staking::stake_lp_and_get(user, rp, position);
        timestamp::update_global_time_for_test_secs(10);
        staking::claim_rewards(mallory, stake);
    }

    // ===== 6. Claim LP fees dispatch =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun claim_lp_fees_naked_dispatches(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let user_addr = signer::address_of(user);
        let position = fresh_position(user, pool_addr);
        let stake = staking::stake_lp_and_get(user, rp, position);

        let (tok_a, _) = pool::pool_tokens(pool_addr);
        let swap_fa = primary_fungible_store::withdraw(user, tok_a, 500_000);
        let fa_out = pool::swap(pool_addr, user_addr, swap_fa, 1);
        primary_fungible_store::deposit(user_addr, fa_out);

        staking::claim_lp_fees(user, stake);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun claim_lp_fees_locked_dispatches(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let user_addr = signer::address_of(user);
        let position = fresh_position(user, pool_addr);
        let locked = lock::lock_position_and_get(user, position, 100_000);
        let stake = staking::stake_locked_lp_and_get(user, rp, locked);

        let (tok_a, _) = pool::pool_tokens(pool_addr);
        let swap_fa = primary_fungible_store::withdraw(user, tok_a, 500_000);
        let fa_out = pool::swap(pool_addr, user_addr, swap_fa, 1);
        primary_fungible_store::deposit(user_addr, fa_out);

        staking::claim_lp_fees(user, stake);
    }

    // ===== 7. Unstake typed variants =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun unstake_naked_happy_path(aptos: &signer, darbitex: &signer, user: &signer) {
        let (meta_r, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let user_addr = signer::address_of(user);
        let position = fresh_position(user, pool_addr);
        let stake = staking::stake_lp_and_get(user, rp, position);
        let stake_addr = object::object_address(&stake);

        let before = primary_fungible_store::balance(user_addr, meta_r);
        timestamp::update_global_time_for_test_secs(10);
        staking::unstake_naked(user, stake);
        let after = primary_fungible_store::balance(user_addr, meta_r);

        assert!(after > before, 700);
        assert!(object::owner(position) == user_addr, 701);
        assert!(!object::object_exists<LpStakePosition>(stake_addr), 702);

        let (_, _, _, ts, _, _) = staking::reward_pool_info(rp);
        assert!(ts == 0, 703);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun unstake_locked_returns_locked_handle(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let user_addr = signer::address_of(user);
        let position = fresh_position(user, pool_addr);
        let locked = lock::lock_position_and_get(user, position, 100_000);
        let locked_addr = object::object_address(&locked);
        let stake = staking::stake_locked_lp_and_get(user, rp, locked);

        timestamp::update_global_time_for_test_secs(10);
        staking::unstake_locked(user, stake);

        // Locked wrapper returned to user; LpPosition still pinned inside locker.
        assert!(object::owner(locked) == user_addr, 800);
        assert!(object::object_exists<LockedPosition>(locked_addr), 801);
        // Inner LpPosition still owned by locker, not user.
        assert!(object::owner(position) != user_addr, 802);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 6, location = darbitex_staking::staking)]
    fun unstake_naked_on_locked_aborts(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let position = fresh_position(user, pool_addr);
        let locked = lock::lock_position_and_get(user, position, 100_000);
        let stake = staking::stake_locked_lp_and_get(user, rp, locked);
        staking::unstake_naked(user, stake);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 7, location = darbitex_staking::staking)]
    fun unstake_locked_on_naked_aborts(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let position = fresh_position(user, pool_addr);
        let stake = staking::stake_lp_and_get(user, rp, position);
        staking::unstake_locked(user, stake);
    }

    // ===== 8. Pending view =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun pending_view_increases_with_time(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let _ = rp;
        let position = fresh_position(user, pool_addr);
        let stake = staking::stake_lp_and_get(user, rp, position);

        assert!(staking::stake_pending_reward(stake) == 0, 900);
        timestamp::update_global_time_for_test_secs(5);
        let p5 = staking::stake_pending_reward(stake);
        assert!(p5 > 0, 901);
        timestamp::update_global_time_for_test_secs(20);
        let p20 = staking::stake_pending_reward(stake);
        assert!(p20 > p5, 902);
    }

    // ===== 9. Free balance caps emission (B3 over-credit guard) =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun free_balance_caps_cumulative_payout(aptos: &signer, darbitex: &signer, user: &signer) {
        let (meta_r, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let user_addr = signer::address_of(user);
        let position = fresh_position(user, pool_addr);
        let stake = staking::stake_lp_and_get(user, rp, position);

        let before = primary_fungible_store::balance(user_addr, meta_r);
        timestamp::update_global_time_for_test_secs(10_000_000);
        staking::unstake_naked(user, stake);
        let after = primary_fungible_store::balance(user_addr, meta_r);
        let claimed = after - before;
        assert!(claimed <= REWARD_DEPOSIT, 1000);
    }

    // ===== 10. Multi-staker B3 over-credit safety =====
    // A and B both stake; A claims mid-flight; B unstakes after pool exhausted.
    // Without committed_rewards cap, B's unstake could abort due to pending > balance.

    #[test(aptos = @0x1, darbitex = @darbitex, alice = @0xA11CE, bob = @0xB0B)]
    fun multi_staker_committed_cap_no_abort(
        aptos: &signer, darbitex: &signer, alice: &signer, bob: &signer,
    ) {
        timestamp::set_time_has_started_for_testing(aptos);
        let darbitex_addr = signer::address_of(darbitex);
        let alice_addr = signer::address_of(alice);
        let bob_addr = signer::address_of(bob);
        account::create_account_for_test(darbitex_addr);
        account::create_account_for_test(alice_addr);
        account::create_account_for_test(bob_addr);

        let (meta_x, mint_x) = create_fa(darbitex, b"token_x");
        let (meta_y, mint_y) = create_fa(darbitex, b"token_y");
        let (meta_r, mint_r) = create_fa(darbitex, b"reward");
        let (meta_a, meta_b) = sort_pair(meta_x, meta_y);

        primary_fungible_store::mint(&mint_x, alice_addr, SEED + USER_AMT);
        primary_fungible_store::mint(&mint_y, alice_addr, SEED + USER_AMT);
        primary_fungible_store::mint(&mint_x, bob_addr, USER_AMT);
        primary_fungible_store::mint(&mint_y, bob_addr, USER_AMT);
        primary_fungible_store::mint(&mint_r, alice_addr, REWARD_DEPOSIT);

        move_to(darbitex, TestMints { mint_a: mint_x, mint_b: mint_y, mint_r });
        pool_factory::init_factory(darbitex);
        pool_factory::create_canonical_pool(alice, meta_a, meta_b, SEED, SEED);
        let pool_addr = pool_factory::canonical_pool_address_of(
            object::object_address(&meta_a), object::object_address(&meta_b),
        );
        let rp = staking::create_lp_reward_pool_and_get(alice, pool_addr, meta_r, MAX_RATE_PER_SEC);
        staking::deposit_rewards(alice, rp, REWARD_DEPOSIT);

        // Alice stakes first.
        let alice_pos = pool::add_liquidity(alice, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let alice_stake = staking::stake_lp_and_get(alice, rp, alice_pos);

        timestamp::update_global_time_for_test_secs(10);

        // Bob stakes.
        let bob_pos = pool::add_liquidity(bob, pool_addr, USER_AMT / 2, USER_AMT / 2, 1);
        let bob_stake = staking::stake_lp_and_get(bob, rp, bob_pos);

        timestamp::update_global_time_for_test_secs(20);

        // Alice claims mid-flight.
        staking::claim_rewards(alice, alice_stake);

        // Race time forward past balance exhaustion.
        timestamp::update_global_time_for_test_secs(10_000_000);

        // Both must succeed without abort. With over-credit bug, Bob's unstake
        // would abort because pending > free reward_balance.
        staking::unstake_naked(bob, bob_stake);
        staking::unstake_naked(alice, alice_stake);

        // Cumulative reward distribution must be ≤ deposit.
        let alice_rwd = primary_fungible_store::balance(alice_addr, meta_r);
        let bob_rwd = primary_fungible_store::balance(bob_addr, meta_r);
        // Alice started with REWARD_DEPOSIT, sent it all into rp via deposit_rewards.
        // After claims, her reward balance comes purely from her stake earnings.
        let total_paid = alice_rwd + bob_rwd;
        assert!(total_paid <= REWARD_DEPOSIT, 1100);
    }

    // ===== 11. Multiple reward pools per Darbitex pool coexist =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun multiple_reward_pools_coexist(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, _, meta_r, pool_addr) = setup(aptos, darbitex, user);

        let rp1 = staking::create_lp_reward_pool_and_get(user, pool_addr, meta_r, 100);
        let rp2 = staking::create_lp_reward_pool_and_get(user, pool_addr, meta_r, 200);

        assert!(object::object_address(&rp1) != object::object_address(&rp2), 1200);

        let (pa1, _, mr1, _, _, _) = staking::reward_pool_info(rp1);
        let (pa2, _, mr2, _, _, _) = staking::reward_pool_info(rp2);
        assert!(pa1 == pool_addr, 1201);
        assert!(pa2 == pool_addr, 1202);
        assert!(mr1 == 100, 1203);
        assert!(mr2 == 200, 1204);
    }

    // ===== 12. Lock invariant inherited (3-firewall) =====
    // After unstake_locked, the LockedPosition is still time-gated. User cannot
    // call lock::redeem before unlock_at_seconds even with the wrapper handle.

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    #[expected_failure(abort_code = 2, location = darbitex_lp_locker::lock)]
    fun lock_invariant_after_unstake_locked(
        aptos: &signer, darbitex: &signer, user: &signer,
    ) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        let position = fresh_position(user, pool_addr);
        let locked = lock::lock_position_and_get(user, position, 100_000);
        let stake = staking::stake_locked_lp_and_get(user, rp, locked);

        timestamp::update_global_time_for_test_secs(50);
        staking::unstake_locked(user, stake);

        // Time still < 100_000 → redeem must abort E_STILL_LOCKED=2.
        lock::redeem(user, locked);
    }

    // ===== 13. Adoption views =====

    #[test(aptos = @0x1, darbitex = @darbitex, user = @0xB0B)]
    fun adoption_views_track_state(aptos: &signer, darbitex: &signer, user: &signer) {
        let (_, pool_addr, rp) = setup_with_rp(aptos, darbitex, user);
        assert!(staking::staked_fraction_bps(rp) == 0, 1300);
        let supply_before = pool::lp_supply(pool_addr);
        assert!(staking::unstaked_lp_shares(rp) == supply_before, 1301);
        assert!(staking::current_emission_rate_per_sec(rp) == 0, 1302);

        let position = fresh_position(user, pool_addr);
        let staked_shares = pool::position_shares(position);
        let stake = staking::stake_lp_and_get(user, rp, position);
        let _ = stake;

        let supply_after = pool::lp_supply(pool_addr);
        assert!(staking::staked_fraction_bps(rp) > 0, 1303);
        assert!(
            staking::unstaked_lp_shares(rp) == supply_after - staked_shares,
            1304,
        );
        assert!(staking::current_emission_rate_per_sec(rp) > 0, 1305);
    }

    // ===== 14. WARNING text byte-anchors field names =====

    #[test]
    fun warning_anchors_field_names() {
        let w = staking::read_warning();
        assert!(contains(&w, b"acc_at_stake"), 1400);
        assert!(contains(&w, b"committed_rewards"), 1401);
        assert!(contains(&w, b"max_rate_per_sec"), 1402);
        assert!(contains(&w, b"acc_reward_per_share"), 1403);
        assert!(contains(&w, b"total_staked_shares"), 1404);
        assert!(contains(&w, b"pool::lp_supply"), 1405);
        assert!(contains(&w, b"staked_fraction_bps"), 1406);
        assert!(contains(&w, b"unstaked_lp_shares"), 1407);
        assert!(contains(&w, b"darbitex_lp_locker"), 1408);
        assert!(contains(&w, b"E_WRONG_POOL"), 1409);
    }

    // ===== 15. WARNING covers the multiple-pools / no-mandate disclosure =====

    #[test]
    fun warning_covers_design_disclosures() {
        let w = staking::read_warning();
        assert!(contains(&w, b"MULTIPLE REWARD POOLS PER DARBITEX POOL ALLOWED"), 1500);
        assert!(contains(&w, b"NO INITIAL REWARD MANDATE"), 1501);
        assert!(contains(&w, b"NO STAKE_TARGET CAP"), 1502);
        assert!(contains(&w, b"NO MULTIPLIER FOR LOCK DURATION"), 1503);
        assert!(contains(&w, b"ACCUMULATOR OVERFLOW DOS"), 1504);
        assert!(contains(&w, b"STAKE WRAPPER TRANSFERABILITY"), 1505);
        assert!(contains(&w, b"object::transfer"), 1506);
    }

    // ===== Helpers =====

    fun contains(haystack: &vector<u8>, needle: vector<u8>): bool {
        let h_len = vector::length(haystack);
        let n_len = vector::length(&needle);
        if (n_len == 0) return true;
        if (n_len > h_len) return false;
        let limit = h_len - n_len + 1;
        let i = 0;
        while (i < limit) {
            let j = 0;
            let ok = true;
            while (j < n_len) {
                if (*vector::borrow(haystack, i + j) != *vector::borrow(&needle, j)) {
                    ok = false;
                    break
                };
                j = j + 1;
            };
            if (ok) return true;
            i = i + 1;
        };
        false
    }
}
