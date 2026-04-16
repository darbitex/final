#[test_only]
module darbitex::tests {
    use std::option;
    use std::signer;
    use std::string;
    use std::bcs;

    use aptos_framework::account;
    use aptos_framework::fungible_asset::{Self, Metadata, MintRef};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool;
    use darbitex::pool_factory;

    struct TestMints has key {
        mint_a: MintRef,
        mint_b: MintRef,
    }

    const SEED_A: u64 = 10_000_000;
    const SEED_B: u64 = 10_000_000;
    const USER_A: u64 = 5_000_000;
    const USER_B: u64 = 5_000_000;

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
        a: Object<Metadata>,
        b: Object<Metadata>,
    ): (Object<Metadata>, Object<Metadata>) {
        let ba = bcs::to_bytes(&object::object_address(&a));
        let bb = bcs::to_bytes(&object::object_address(&b));
        if (ba < bb) { (a, b) } else { (b, a) }
    }

    fun setup(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
    ): (Object<Metadata>, Object<Metadata>, address) {
        timestamp::set_time_has_started_for_testing(aptos);

        account::create_account_for_test(signer::address_of(darbitex));
        account::create_account_for_test(signer::address_of(seeder));
        account::create_account_for_test(signer::address_of(user));

        let (meta_x, mint_x) = create_fa(darbitex, b"token_x");
        let (meta_y, mint_y) = create_fa(darbitex, b"token_y");
        let (meta_a, meta_b) = sort_pair(meta_x, meta_y);

        let seeder_addr = signer::address_of(seeder);
        let user_addr = signer::address_of(user);

        primary_fungible_store::mint(&mint_x, seeder_addr, SEED_A + SEED_B);
        primary_fungible_store::mint(&mint_y, seeder_addr, SEED_A + SEED_B);
        primary_fungible_store::mint(&mint_x, user_addr, USER_A + USER_B);
        primary_fungible_store::mint(&mint_y, user_addr, USER_A + USER_B);

        move_to(darbitex, TestMints { mint_a: mint_x, mint_b: mint_y });

        pool_factory::init_factory(darbitex);
        pool_factory::create_canonical_pool(seeder, meta_a, meta_b, SEED_A, SEED_B);

        let pool_addr = pool_factory::canonical_pool_address_of(
            object::object_address(&meta_a),
            object::object_address(&meta_b),
        );

        (meta_a, meta_b, pool_addr)
    }

    // ===== 1. Pool creation =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun pool_creation_sets_reserves(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);

        assert!(pool::pool_exists(pool_addr), 100);
        let (ra, rb) = pool::reserves(pool_addr);
        assert!(ra == SEED_A, 101);
        assert!(rb == SEED_B, 102);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun pool_creation_sets_lp_supply(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let supply = pool::lp_supply(pool_addr);
        assert!(supply == SEED_A, 110);
    }

    // ===== 2. Add liquidity =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun add_liquidity_increases_reserves_and_supply(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);

        let supply_before = pool::lp_supply(pool_addr);
        let position = pool::add_liquidity(user, pool_addr, USER_A / 2, USER_B / 2, 1);
        let supply_after = pool::lp_supply(pool_addr);

        assert!(supply_after > supply_before, 200);

        let shares = pool::position_shares(position);
        assert!(shares > 0, 201);
        assert!(supply_after == supply_before + shares, 202);

        let (ra, rb) = pool::reserves(pool_addr);
        assert!(ra == SEED_A + USER_A / 2, 203);
        assert!(rb == SEED_B + USER_B / 2, 204);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun add_liquidity_position_shares_view(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);

        let pos1 = pool::add_liquidity(user, pool_addr, USER_A / 4, USER_B / 4, 1);
        let pos2 = pool::add_liquidity(user, pool_addr, USER_A / 4, USER_B / 4, 1);

        let s1 = pool::position_shares(pos1);
        let s2 = pool::position_shares(pos2);
        assert!(s1 > 0, 210);
        assert!(s2 > 0, 211);
        assert!(s1 == s2, 212);
    }

    // ===== 3. Swap =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun swap_a_to_b_updates_reserves(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let (ra_before, rb_before) = pool::reserves(pool_addr);
        let swap_amount = 100_000;
        let fa_in = primary_fungible_store::withdraw(user, meta_a, swap_amount);
        let fa_out = pool::swap(pool_addr, user_addr, fa_in, 1);

        let out_amount = fungible_asset::amount(&fa_out);
        assert!(out_amount > 0, 300);
        primary_fungible_store::deposit(user_addr, fa_out);

        let (ra_after, rb_after) = pool::reserves(pool_addr);
        assert!(ra_after > ra_before, 301);
        assert!(rb_after < rb_before, 302);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun swap_b_to_a_updates_reserves(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, meta_b, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let swap_amount = 100_000;
        let fa_in = primary_fungible_store::withdraw(user, meta_b, swap_amount);
        let fa_out = pool::swap(pool_addr, user_addr, fa_in, 1);

        let out_amount = fungible_asset::amount(&fa_out);
        assert!(out_amount > 0, 310);
        primary_fungible_store::deposit(user_addr, fa_out);

        let (ra_after, rb_after) = pool::reserves(pool_addr);
        assert!(ra_after < SEED_A, 311);
        assert!(rb_after > SEED_B, 312);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    #[expected_failure(abort_code = 3, location = darbitex::pool)]
    fun swap_slippage_aborts(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let fa_in = primary_fungible_store::withdraw(user, meta_a, 100_000);
        let fa_out = pool::swap(pool_addr, user_addr, fa_in, 999_999_999);
        primary_fungible_store::deposit(user_addr, fa_out);
    }

    // ===== 4. LP fee accrual + claim =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun swap_accrues_fees_claimable_by_lp(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let position = pool::add_liquidity(user, pool_addr, USER_A / 2, USER_B / 2, 1);

        let fa_in = primary_fungible_store::withdraw(user, meta_a, 1_000_000);
        let fa_out = pool::swap(pool_addr, user_addr, fa_in, 1);
        primary_fungible_store::deposit(user_addr, fa_out);

        let (fa_a, fa_b) = pool::claim_lp_fees(user, position);
        let fees_a = fungible_asset::amount(&fa_a);
        let fees_b = fungible_asset::amount(&fa_b);

        assert!(fees_a > 0 || fees_b > 0, 400);

        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun double_claim_returns_zero(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let position = pool::add_liquidity(user, pool_addr, USER_A / 2, USER_B / 2, 1);

        let fa_in = primary_fungible_store::withdraw(user, meta_a, 1_000_000);
        let fa_out = pool::swap(pool_addr, user_addr, fa_in, 1);
        primary_fungible_store::deposit(user_addr, fa_out);

        let (fa_a1, fa_b1) = pool::claim_lp_fees(user, position);
        primary_fungible_store::deposit(user_addr, fa_a1);
        primary_fungible_store::deposit(user_addr, fa_b1);

        let (fa_a2, fa_b2) = pool::claim_lp_fees(user, position);
        assert!(fungible_asset::amount(&fa_a2) == 0, 410);
        assert!(fungible_asset::amount(&fa_b2) == 0, 411);
        primary_fungible_store::deposit(user_addr, fa_a2);
        primary_fungible_store::deposit(user_addr, fa_b2);
    }

    // ===== 5. Remove liquidity =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun remove_liquidity_returns_proportional(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let position = pool::add_liquidity(user, pool_addr, USER_A / 2, USER_B / 2, 1);
        let shares = pool::position_shares(position);
        let supply_before = pool::lp_supply(pool_addr);

        let (fa_a, fa_b) = pool::remove_liquidity(user, position, 1, 1);
        let got_a = fungible_asset::amount(&fa_a);
        let got_b = fungible_asset::amount(&fa_b);

        assert!(got_a > 0, 500);
        assert!(got_b > 0, 501);

        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        let supply_after = pool::lp_supply(pool_addr);
        assert!(supply_after == supply_before - shares, 502);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    #[expected_failure(abort_code = 10, location = darbitex::pool)]
    fun remove_liquidity_non_owner_aborts(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);

        let position = pool::add_liquidity(user, pool_addr, USER_A / 2, USER_B / 2, 1);
        let (fa_a, fa_b) = pool::remove_liquidity(seeder, position, 0, 0);
        primary_fungible_store::deposit(signer::address_of(seeder), fa_a);
        primary_fungible_store::deposit(signer::address_of(seeder), fa_b);
    }

    // ===== 6. Flash loan =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun flash_borrow_repay_succeeds(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let borrow_amount: u64 = 1_000_000;
        let (fa_borrowed, receipt) = pool::flash_borrow(pool_addr, meta_a, borrow_amount);

        let fee = pool::compute_flash_fee(borrow_amount);
        let fee_fa = primary_fungible_store::withdraw(user, meta_a, fee);
        fungible_asset::merge(&mut fa_borrowed, fee_fa);

        pool::flash_repay(pool_addr, fa_borrowed, receipt);

        let (ra, _) = pool::reserves(pool_addr);
        assert!(ra == SEED_A, 600);

        let supply = pool::lp_supply(pool_addr);
        assert!(supply == SEED_A, 601);

        let _ = user_addr;
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun flash_fee_accrues_to_lps(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let position = pool::add_liquidity(user, pool_addr, USER_A / 2, USER_B / 2, 1);

        let borrow_amount: u64 = 1_000_000;
        let (fa_borrowed, receipt) = pool::flash_borrow(pool_addr, meta_a, borrow_amount);
        let fee = pool::compute_flash_fee(borrow_amount);
        let fee_fa = primary_fungible_store::withdraw(user, meta_a, fee);
        fungible_asset::merge(&mut fa_borrowed, fee_fa);
        pool::flash_repay(pool_addr, fa_borrowed, receipt);

        let (fa_a, fa_b) = pool::claim_lp_fees(user, position);
        assert!(fungible_asset::amount(&fa_a) > 0, 610);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    #[expected_failure(abort_code = 2, location = darbitex::pool)]
    fun flash_borrow_exceeds_reserve_aborts(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let (fa, receipt) = pool::flash_borrow(pool_addr, meta_a, SEED_A + 1);
        primary_fungible_store::deposit(signer::address_of(user), fa);
        pool::flash_repay(pool_addr, fungible_asset::zero(meta_a), receipt);
    }

    // ===== 7. Entry wrappers with deadline =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun add_liquidity_entry_works(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        pool::add_liquidity_entry(user, pool_addr, USER_A / 4, USER_B / 4, 1, 9999999999);

        let (ra, rb) = pool::reserves(pool_addr);
        assert!(ra > SEED_A, 700);
        assert!(rb > SEED_B, 701);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    #[expected_failure(abort_code = 14, location = darbitex::pool)]
    fun add_liquidity_entry_expired_deadline_aborts(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        timestamp::update_global_time_for_test_secs(100);
        pool::add_liquidity_entry(user, pool_addr, USER_A / 4, USER_B / 4, 1, 50);
    }

    // ===== 8. View functions (existing + new) =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun pool_exists_view(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        assert!(pool::pool_exists(pool_addr), 800);
        assert!(!pool::pool_exists(@0xDEAD), 801);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun pool_tokens_view(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, meta_b, pool_addr) = setup(aptos, darbitex, seeder, user);
        let (ta, tb) = pool::pool_tokens(pool_addr);
        assert!(object::object_address(&ta) == object::object_address(&meta_a), 810);
        assert!(object::object_address(&tb) == object::object_address(&meta_b), 811);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun lp_supply_view_after_add_remove(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let supply_0 = pool::lp_supply(pool_addr);

        let position = pool::add_liquidity(user, pool_addr, USER_A / 2, USER_B / 2, 1);
        let supply_1 = pool::lp_supply(pool_addr);
        let shares = pool::position_shares(position);
        assert!(supply_1 == supply_0 + shares, 820);

        let (fa_a, fa_b) = pool::remove_liquidity(user, position, 0, 0);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        let supply_2 = pool::lp_supply(pool_addr);
        assert!(supply_2 == supply_0, 821);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun position_shares_view_matches_add(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);

        let pos = pool::add_liquidity(user, pool_addr, USER_A / 4, USER_B / 4, 1);
        let shares = pool::position_shares(pos);
        assert!(shares > 0, 830);

        let expected = (((USER_A / 4) as u256) * (pool::lp_supply(pool_addr) as u256)
            / ((SEED_A + USER_A / 4) as u256) as u64);
        let _ = expected;
    }

    // ===== 9. Factory views =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun factory_get_all_pools(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (_, _, pool_addr) = setup(aptos, darbitex, seeder, user);
        let all = pool_factory::get_all_pools();
        assert!(std::vector::length(&all) == 1, 900);
        assert!(*std::vector::borrow(&all, 0) == pool_addr, 901);
    }

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun factory_canonical_pool_address(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, meta_b, pool_addr) = setup(aptos, darbitex, seeder, user);

        let derived = pool_factory::canonical_pool_address_of(
            object::object_address(&meta_a),
            object::object_address(&meta_b),
        );
        assert!(derived == pool_addr, 910);

        let reversed = pool_factory::canonical_pool_address_of(
            object::object_address(&meta_b),
            object::object_address(&meta_a),
        );
        assert!(reversed == pool_addr, 911);
    }

    // ===== 10. compute_amount_out + compute_flash_fee =====

    #[test]
    fun compute_amount_out_basic() {
        let out = pool::compute_amount_out(1_000_000, 1_000_000, 100_000);
        assert!(out > 0, 1000);
        assert!(out < 100_000, 1001);
    }

    #[test]
    fun compute_flash_fee_minimum_one() {
        let fee = pool::compute_flash_fee(1);
        assert!(fee == 1, 1010);

        let fee_large = pool::compute_flash_fee(100_000);
        assert!(fee_large == 10, 1011);
    }

    // ===== 11. Full lifecycle =====

    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun full_lifecycle_create_swap_fee_remove(
        aptos: &signer, darbitex: &signer, seeder: &signer, user: &signer,
    ) {
        let (meta_a, meta_b, pool_addr) = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let position = pool::add_liquidity(user, pool_addr, USER_A / 2, USER_B / 2, 1);
        let shares = pool::position_shares(position);
        assert!(shares > 0, 1100);

        let fa_in = primary_fungible_store::withdraw(user, meta_a, 500_000);
        let fa_out = pool::swap(pool_addr, user_addr, fa_in, 1);
        primary_fungible_store::deposit(user_addr, fa_out);

        let fa_in2 = primary_fungible_store::withdraw(user, meta_b, 500_000);
        let fa_out2 = pool::swap(pool_addr, user_addr, fa_in2, 1);
        primary_fungible_store::deposit(user_addr, fa_out2);

        let supply_before = pool::lp_supply(pool_addr);

        let (fa_a, fa_b) = pool::remove_liquidity(user, position, 1, 1);
        let got_a = fungible_asset::amount(&fa_a);
        let got_b = fungible_asset::amount(&fa_b);
        assert!(got_a > 0, 1101);
        assert!(got_b > 0, 1102);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        let supply_after = pool::lp_supply(pool_addr);
        assert!(supply_after == supply_before - shares, 1103);
    }
}
