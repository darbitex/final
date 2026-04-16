#[test_only]
module darbitex_lp_locker::lock_tests {
    use std::option;
    use std::signer;
    use std::string;
    use std::bcs;

    use aptos_framework::account;
    use aptos_framework::fungible_asset::{Self, Metadata, MintRef};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool::{Self, LpPosition};
    use darbitex::pool_factory;

    use darbitex_lp_locker::lock;

    // ===== Test fixtures =====

    struct FaRefs has key {
        mint_ref_a: MintRef,
        mint_ref_b: MintRef,
    }

    const SEED_AMT: u64 = 1_000_000;
    const USER_AMT: u64 = 500_000;

    fun create_fa(creator: &signer, name: vector<u8>): (Object<Metadata>, MintRef) {
        let ctor = object::create_named_object(creator, name);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &ctor,
            option::none(),
            string::utf8(b"Test"),
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

    // Full setup: init factory, create 2 FAs, mint to seeder+user, create
    // pool, have user `add_liquidity` to get a fresh `Object<LpPosition>`.
    // Returns (user_position, locker_owner_addr).
    fun setup(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
    ): Object<LpPosition> {
        timestamp::set_time_has_started_for_testing(aptos);

        let darbitex_addr = signer::address_of(darbitex);
        let seeder_addr = signer::address_of(seeder);
        let user_addr = signer::address_of(user);
        account::create_account_for_test(darbitex_addr);
        account::create_account_for_test(seeder_addr);
        account::create_account_for_test(user_addr);

        let (meta_x, mint_x) = create_fa(darbitex, b"token_x");
        let (meta_y, mint_y) = create_fa(darbitex, b"token_y");
        let (meta_a, meta_b) = sort_pair(meta_x, meta_y);

        primary_fungible_store::mint(&mint_x, seeder_addr, SEED_AMT);
        primary_fungible_store::mint(&mint_y, seeder_addr, SEED_AMT);
        primary_fungible_store::mint(&mint_x, user_addr, USER_AMT);
        primary_fungible_store::mint(&mint_y, user_addr, USER_AMT);

        // Keep mint refs alive for potential later use in tests.
        move_to(darbitex, FaRefs { mint_ref_a: mint_x, mint_ref_b: mint_y });

        pool_factory::init_factory(darbitex);
        pool_factory::create_canonical_pool(seeder, meta_a, meta_b, SEED_AMT / 2, SEED_AMT / 2);

        let pool_addr = pool_factory::canonical_pool_address_of(
            object::object_address(&meta_a),
            object::object_address(&meta_b),
        );

        pool::add_liquidity(user, pool_addr, USER_AMT / 4, USER_AMT / 4, 1)
    }

    // ===== Tests =====

    // Lock + view: unlock_at and position_of return the stored values.
    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun lock_then_view(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
    ) {
        let position = setup(aptos, darbitex, seeder, user);
        let position_addr = object::object_address(&position);

        let locker = lock::lock_position_and_get(user, position, 1000);

        assert!(lock::unlock_at(locker) == 1000, 100);
        assert!(object::object_address(&lock::position_of(locker)) == position_addr, 101);
        assert!(object::owner(locker) == signer::address_of(user), 102);
        assert!(object::owner(position) != signer::address_of(user), 103);
    }

    // redeem before unlock_at should abort E_STILL_LOCKED.
    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    #[expected_failure(abort_code = 2, location = darbitex_lp_locker::lock)]
    fun redeem_before_unlock_aborts(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
    ) {
        let position = setup(aptos, darbitex, seeder, user);
        let locker = lock::lock_position_and_get(user, position, 1000);
        timestamp::update_global_time_for_test_secs(500);
        lock::redeem(user, locker);
    }

    // redeem after unlock_at returns the position to the user and
    // deletes the locker resource.
    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun redeem_after_unlock_returns_position(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
    ) {
        let position = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);

        let locker = lock::lock_position_and_get(user, position, 1000);
        let locker_addr = object::object_address(&locker);
        assert!(object::owner(position) == locker_addr, 300);

        timestamp::update_global_time_for_test_secs(2000);
        lock::redeem(user, locker);

        assert!(object::owner(position) == user_addr, 301);
        assert!(!object::object_exists<lock::LockedPosition>(locker_addr), 302);
    }

    // claim_fees by a non-owner aborts E_NOT_OWNER.
    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B, mallory = @0xDEAD)]
    #[expected_failure(abort_code = 1, location = darbitex_lp_locker::lock)]
    fun claim_fees_non_owner_aborts(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
        mallory: &signer,
    ) {
        account::create_account_for_test(signer::address_of(mallory));
        let position = setup(aptos, darbitex, seeder, user);
        let locker = lock::lock_position_and_get(user, position, 1000);
        lock::claim_fees(mallory, locker);
    }

    // Transferability invariant: after `object::transfer<LockedPosition>`
    // to a new owner, redeem by the new owner succeeds (lock state
    // carries across the transfer unchanged).
    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B, bob = @0xB00B)]
    fun transferred_locker_new_owner_can_redeem(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
        bob: &signer,
    ) {
        let bob_addr = signer::address_of(bob);
        account::create_account_for_test(bob_addr);

        let position = setup(aptos, darbitex, seeder, user);
        let locker = lock::lock_position_and_get(user, position, 1000);

        object::transfer(user, locker, bob_addr);
        assert!(object::owner(locker) == bob_addr, 400);
        assert!(lock::unlock_at(locker) == 1000, 401);

        timestamp::update_global_time_for_test_secs(2000);
        lock::redeem(bob, locker);
        assert!(object::owner(position) == bob_addr, 402);
    }

    // lock_position with unlock_at == now should abort E_INVALID_UNLOCK.
    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    #[expected_failure(abort_code = 3, location = darbitex_lp_locker::lock)]
    fun lock_rejects_unlock_at_eq_now(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
    ) {
        let position = setup(aptos, darbitex, seeder, user);
        // `set_time_has_started_for_testing` starts at 0; `now == 0`.
        lock::lock_position(user, position, 0);
    }

    // lock_position with unlock_at strictly in the past should abort.
    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    #[expected_failure(abort_code = 3, location = darbitex_lp_locker::lock)]
    fun lock_rejects_unlock_at_past(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
    ) {
        let position = setup(aptos, darbitex, seeder, user);
        timestamp::update_global_time_for_test_secs(500);
        lock::lock_position(user, position, 100);
    }

    // After lock, the LpPosition's owner is the locker_addr, which is
    // *not* the user's wallet. Verifies principal-lock invariant: the
    // user can no longer directly call `pool::remove_liquidity` because
    // the owner check would fail.
    #[test(aptos = @0x1, darbitex = @darbitex, seeder = @0xA11CE, user = @0xB0B)]
    fun lock_transfers_position_away_from_user(
        aptos: &signer,
        darbitex: &signer,
        seeder: &signer,
        user: &signer,
    ) {
        let position = setup(aptos, darbitex, seeder, user);
        let user_addr = signer::address_of(user);
        assert!(object::owner(position) == user_addr, 200);

        lock::lock_position(user, position, 1000);

        assert!(object::owner(position) != user_addr, 201);
    }
}
