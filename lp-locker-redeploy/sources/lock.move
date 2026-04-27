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

    // ===== Errors =====

    const E_NOT_OWNER: u64 = 1;
    const E_STILL_LOCKED: u64 = 2;
    const E_INVALID_UNLOCK: u64 = 3;

    // ===== On-chain disclosure =====

    const WARNING: vector<u8> = b"DARBITEX LP LOCKER is a time-lock satellite for darbitex::pool::LpPosition on Aptos. The package deploys under a 3-of-5 multisig with upgrade_policy = compatible during a stabilization soak; after the soak the policy is intended to be flipped to immutable. Once immutable the package is permanently immutable - no admin authority, no pause, no upgrade, no early-unlock path. Bugs are unrecoverable. Audit this code yourself before interacting. KNOWN LIMITATIONS: (1) ONE-WAY TIME GATE - unlock_at_seconds is set once at lock_position and cannot be extended, shortened, or cancelled by anyone for any reason. There is no admin path to unlock early. The only routes to the underlying LpPosition are redeem_position after unlock_at_seconds or never. (2) CLOCK SOURCE - unlock_at_seconds is compared against Aptos framework timestamp::now_seconds, the block timestamp progressed by validators. Lock duration is sensitive to validator clock progression. Standard Aptos assumption. (3) WRAPPER TRANSFERABILITY - LockedPosition is an Aptos object resource freely transferable via object::transfer. Transferring the wrapper carries the lock state and the unlock_at_seconds deadline; the new owner inherits both the right to claim fees and the right to redeem at unlock_at_seconds. Only the inner LpPosition is time-gated, not the wrapper. (4) FEE PROXY - claim_fees_assets calls darbitex::pool::claim_lp_fees and returns FungibleAsset values to the caller. The claim_fees entry wrapper deposits both into the caller primary_fungible_store. Frontends and downstream wrappers are responsible for forwarding fees to the rightful end user. The locker performs no internal fee accounting. (5) POOL DEPENDENCY - claim_fees requires the underlying Pool resource to be live and unlocked. If the pool is degraded for unrelated reasons, fee claims may abort. redeem_position does NOT touch the pool and works regardless of pool state once unlock_at_seconds is reached - principal recovery is independent of pool liveness. (6) NO RESCUE - lost ownership of the LockedPosition wrapper has no recourse. No admin, no recovery, no pause. The wrapper itself is the only authentication. (7) NO COMPOSITION GUARANTEES - third-party modules that wrap LockedPosition (staking, lending, escrow, marketplace, vesting) provide their own invariants. This module guarantees only that LpPosition cannot exit a LockedPosition before unlock_at_seconds. Wrapping a LockedPosition inside an external wrapper is the user voluntary act and combines the trust assumptions of all layers. (8) UPGRADE POLICY - the package deploys with upgrade_policy = compatible during the stabilization soak, governed by a 3-of-5 multisig. Multisig owners can publish breaking upgrades during this window. After the soak the policy is intended to be set immutable, after which no party can publish further upgrades. Watch package upgrade events on-chain to confirm the transition. (9) AUTHORSHIP AND AUDIT DISCLOSURE - Darbitex LP Locker was built by a solo developer working with Claude (Anthropic AI). All audits performed are AI-based: multi-round Claude self-audit plus external LLM review. NO professional human security audit firm has reviewed this code. Once the package is set immutable the protocol is ownerless and permissionless - no team, no foundation, no legal entity, no responsible party, no support channel. All losses from bugs, exploits, user error, malicious counterparties, or any other cause whatsoever are borne entirely by users. (10) UNKNOWN FUTURE LIMITATIONS - This list reflects only the limitations identified at the time of audit. Future analysis, novel attack vectors, unforeseen interactions with other Aptos protocols, framework changes, market dynamics, or regulatory developments may reveal additional weaknesses, risks, or limitations not enumerated here. After the package is set immutable, newly discovered limitations CANNOT be patched - they become additional risks users continue to bear. Treat the preceding 9 items as a non-exhaustive lower bound on known risks, not a complete enumeration. By interacting with the locker (locking a position, claiming fees, redeeming, transferring the wrapper, or composing with downstream protocols) you confirm that you have read and understood all 10 numbered limitations and accept full responsibility for any and all losses.";

    // ===== State =====

    struct LockedPosition has key {
        position: Object<LpPosition>,
        unlock_at_seconds: u64,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    // ===== Events =====

    #[event]
    struct Locked has drop, store {
        locker_addr: address,
        owner: address,
        position_addr: address,
        unlock_at_seconds: u64,
    }

    #[event]
    struct FeesClaimed has drop, store {
        locker_addr: address,
        owner: address,
        position_addr: address,
        fees_a: u64,
        fees_b: u64,
    }

    #[event]
    struct Redeemed has drop, store {
        locker_addr: address,
        owner: address,
        position_addr: address,
    }

    // ===== Lock =====

    public entry fun lock_position(
        user: &signer,
        position: Object<LpPosition>,
        unlock_at_seconds: u64,
    ) {
        let _ = lock_position_and_get(user, position, unlock_at_seconds);
    }

    public fun lock_position_and_get(
        user: &signer,
        position: Object<LpPosition>,
        unlock_at_seconds: u64,
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
            position,
            unlock_at_seconds,
            extend_ref,
            delete_ref,
        });

        event::emit(Locked {
            locker_addr,
            owner: user_addr,
            position_addr,
            unlock_at_seconds,
        });

        object::object_from_constructor_ref<LockedPosition>(&ctor)
    }

    // ===== Claim fees =====

    /// Non-entry primitive: returns harvested LP fees as FungibleAsset
    /// values for the caller to route. Downstream wrappers compose here.
    public fun claim_fees_assets(
        user: &signer,
        locker: Object<LockedPosition>,
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

        event::emit(FeesClaimed {
            locker_addr,
            owner: user_addr,
            position_addr,
            fees_a,
            fees_b,
        });

        (fa_a, fa_b)
    }

    public entry fun claim_fees(
        user: &signer,
        locker: Object<LockedPosition>,
    ) acquires LockedPosition {
        let (fa_a, fa_b) = claim_fees_assets(user, locker);
        let user_addr = signer::address_of(user);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);
    }

    // ===== Redeem =====

    /// Non-entry primitive: consumes the wrapper, transfers the inner
    /// LpPosition to the caller, and returns its handle. Aborts unless
    /// `now >= unlock_at_seconds`.
    public fun redeem_position(
        user: &signer,
        locker: Object<LockedPosition>,
    ): Object<LpPosition> acquires LockedPosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(locker) == user_addr, E_NOT_OWNER);

        let locker_addr = object::object_address(&locker);
        {
            let l = borrow_global<LockedPosition>(locker_addr);
            assert!(timestamp::now_seconds() >= l.unlock_at_seconds, E_STILL_LOCKED);
        };

        let LockedPosition { position, unlock_at_seconds: _, extend_ref, delete_ref }
            = move_from<LockedPosition>(locker_addr);

        let locker_signer = object::generate_signer_for_extending(&extend_ref);
        object::transfer(&locker_signer, position, user_addr);
        let position_addr = object::object_address(&position);

        object::delete(delete_ref);

        event::emit(Redeemed {
            locker_addr,
            owner: user_addr,
            position_addr,
        });

        position
    }

    public entry fun redeem(
        user: &signer,
        locker: Object<LockedPosition>,
    ) acquires LockedPosition {
        let _ = redeem_position(user, locker);
    }

    // ===== Views =====

    #[view]
    public fun unlock_at_seconds(l: Object<LockedPosition>): u64 acquires LockedPosition {
        borrow_global<LockedPosition>(object::object_address(&l)).unlock_at_seconds
    }

    #[view]
    public fun is_unlocked(l: Object<LockedPosition>): bool acquires LockedPosition {
        let unlock = borrow_global<LockedPosition>(object::object_address(&l)).unlock_at_seconds;
        timestamp::now_seconds() >= unlock
    }

    #[view]
    public fun position_of(l: Object<LockedPosition>): Object<LpPosition> acquires LockedPosition {
        borrow_global<LockedPosition>(object::object_address(&l)).position
    }

    #[view]
    public fun position_shares(l: Object<LockedPosition>): u64 acquires LockedPosition {
        let pos = borrow_global<LockedPosition>(object::object_address(&l)).position;
        pool::position_shares(pos)
    }

    #[view]
    public fun read_warning(): vector<u8> { WARNING }
}
