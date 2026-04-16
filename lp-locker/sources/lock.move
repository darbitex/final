/// Darbitex LP Locker — external satellite.
///
/// Wraps a `darbitex::pool::LpPosition` object inside a `LockedPosition`
/// Aptos object with a time-based unlock gate. LP fees remain harvestable
/// throughout the lock period; only the principal (the LpPosition itself)
/// is gated. The wrapper is a standard Aptos object — owner transfer via
/// `object::transfer<LockedPosition>` carries the lock state with it.
///
/// Zero admin surface. Each locker is independent. No global registry.
/// Discovery is via `getAccountOwnedObjects` on the user's wallet.
///
/// Event attribution: `FeesClaimed` deliberately omits `pool_addr` because
/// `LpPosition.pool_addr` is module-private in `darbitex::pool` and
/// exposing it would require a core upgrade (violates zero-core-touch).
/// Off-chain indexers correlate this event with core's `LpFeesClaimed`
/// by matching `position_addr` within the same transaction.

module darbitex_lp_locker::lock {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::object::{Self, Object, ExtendRef, DeleteRef};
    use aptos_framework::fungible_asset;
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool::{Self, LpPosition};

    const E_NOT_OWNER: u64 = 1;
    const E_STILL_LOCKED: u64 = 2;
    const E_INVALID_UNLOCK: u64 = 3;

    struct LockedPosition has key {
        position: Object<LpPosition>,
        unlock_at: u64,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    #[event]
    struct Locked has drop, store {
        locker_addr: address,
        owner: address,
        position_addr: address,
        unlock_at: u64,
        timestamp: u64,
    }

    #[event]
    struct FeesClaimed has drop, store {
        locker_addr: address,
        owner: address,
        position_addr: address,
        fees_a: u64,
        fees_b: u64,
        timestamp: u64,
    }

    #[event]
    struct Redeemed has drop, store {
        locker_addr: address,
        owner: address,
        position_addr: address,
        timestamp: u64,
    }

    public entry fun lock_position(
        user: &signer,
        position: Object<LpPosition>,
        unlock_at: u64,
    ) {
        let _ = lock_position_and_get(user, position, unlock_at);
    }

    /// Same as `lock_position` but returns the new locker handle. Split
    /// out so integration callers (and tests) can get at the handle
    /// without scanning owned objects. Keeping the entry point as a
    /// thin wrapper preserves the block-explorer-executable property.
    public fun lock_position_and_get(
        user: &signer,
        position: Object<LpPosition>,
        unlock_at: u64,
    ): Object<LockedPosition> {
        let now = timestamp::now_seconds();
        assert!(unlock_at > now, E_INVALID_UNLOCK);

        let user_addr = signer::address_of(user);
        let ctor = object::create_object(user_addr);
        let locker_signer = object::generate_signer(&ctor);
        let locker_addr = signer::address_of(&locker_signer);
        let extend_ref = object::generate_extend_ref(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        object::transfer(user, position, locker_addr);
        let position_addr = object::object_address(&position);

        move_to(&locker_signer, LockedPosition {
            position,
            unlock_at,
            extend_ref,
            delete_ref,
        });

        event::emit(Locked {
            locker_addr,
            owner: user_addr,
            position_addr,
            unlock_at,
            timestamp: now,
        });

        object::object_from_constructor_ref<LockedPosition>(&ctor)
    }

    public entry fun claim_fees(
        user: &signer,
        locker: Object<LockedPosition>,
    ) acquires LockedPosition {
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

        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        event::emit(FeesClaimed {
            locker_addr,
            owner: user_addr,
            position_addr,
            fees_a,
            fees_b,
            timestamp: timestamp::now_seconds(),
        });
    }

    public entry fun redeem(
        user: &signer,
        locker: Object<LockedPosition>,
    ) acquires LockedPosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(locker) == user_addr, E_NOT_OWNER);

        let locker_addr = object::object_address(&locker);
        let LockedPosition { position, unlock_at, extend_ref, delete_ref }
            = move_from<LockedPosition>(locker_addr);
        assert!(timestamp::now_seconds() >= unlock_at, E_STILL_LOCKED);

        let locker_signer = object::generate_signer_for_extending(&extend_ref);
        object::transfer(&locker_signer, position, user_addr);
        let position_addr = object::object_address(&position);

        object::delete(delete_ref);

        event::emit(Redeemed {
            locker_addr,
            owner: user_addr,
            position_addr,
            timestamp: timestamp::now_seconds(),
        });
    }

    #[view]
    public fun unlock_at(l: Object<LockedPosition>): u64 acquires LockedPosition {
        borrow_global<LockedPosition>(object::object_address(&l)).unlock_at
    }

    #[view]
    public fun position_of(l: Object<LockedPosition>): Object<LpPosition> acquires LockedPosition {
        borrow_global<LockedPosition>(object::object_address(&l)).position
    }
}
