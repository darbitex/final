/// Darbitex — pool primitive.
///
/// One canonical pool per pair. x*y=k constant product. 1 bps swap fee,
/// 1 bps flash fee, 100% LP. LP positions are Aptos objects with a
/// global fee accumulator + per-position debt snapshot. Flash loan
/// primitive (hot-potato receipt) is exposed for composable arb flows.
/// Zero admin surface.
///
/// `pool::swap` is a pure composable primitive with no callbacks into
/// external modules (no reentrancy surface). The `arbitrage` module
/// wraps `pool::swap` from the outside, providing smart-routing and
/// cycle-closure entry points that apply a 10% service charge on any
/// measurable surplus over a canonical direct-hop baseline.

module darbitex::pool {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::object::{Self, Object, ConstructorRef, ExtendRef, DeleteRef};
    use aptos_framework::fungible_asset::{Self, FungibleAsset, Metadata};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    friend darbitex::pool_factory;

    // ===== Constants =====

    const SWAP_FEE_BPS: u64 = 1;
    const FLASH_FEE_BPS: u64 = 1;
    const BPS_DENOM: u64 = 10_000;
    const MINIMUM_LIQUIDITY: u64 = 1_000;
    const SCALE: u128 = 1_000_000_000_000;
    const U64_MAX: u64 = 18446744073709551615;

    // ===== Errors =====

    const E_ZERO_AMOUNT: u64 = 1;
    const E_INSUFFICIENT_LIQUIDITY: u64 = 2;
    const E_SLIPPAGE: u64 = 3;
    const E_LOCKED: u64 = 4;
    const E_DISPROPORTIONAL: u64 = 5;
    const E_WRONG_POOL: u64 = 6;
    const E_INSUFFICIENT_LP: u64 = 7;
    const E_WRONG_TOKEN: u64 = 8;
    const E_K_VIOLATED: u64 = 9;
    const E_NOT_OWNER: u64 = 10;
    const E_NO_POSITION: u64 = 11;
    const E_NO_POOL: u64 = 12;
    const E_DEADLINE: u64 = 14;

    // ===== Structs =====

    /// Pool state. Config fields (metadata_a/b, extend_ref) are immutable
    /// after create_pool. Reserves + LP accumulators + locked flag mutate
    /// during normal operations.
    struct Pool has key {
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
        extend_ref: ExtendRef,

        reserve_a: u64,
        reserve_b: u64,
        lp_supply: u64,

        // LP fee global accumulators (cumulative per-share, scaled by SCALE).
        // 100% of swap + flash fee flows here.
        lp_fee_per_share_a: u128,
        lp_fee_per_share_b: u128,

        locked: bool,
    }

    /// LP position as an Aptos object. Each add_liquidity mints a new
    /// one. Transferable. Burned on remove_liquidity.
    struct LpPosition has key {
        pool_addr: address,
        shares: u64,
        fee_debt_a: u128,
        fee_debt_b: u128,
        delete_ref: DeleteRef,
    }

    /// Flash loan receipt. Hot-potato: no drop/store/key abilities. Must
    /// be consumed via flash_repay in the same TX.
    struct FlashReceipt {
        pool_addr: address,
        metadata: Object<Metadata>,
        amount: u64,
        fee: u64,
        k_before: u256,
    }

    // ===== Events =====

    #[event]
    struct PoolCreated has drop, store {
        pool_addr: address,
        metadata_a: address,
        metadata_b: address,
        creator: address,
        amount_a: u64,
        amount_b: u64,
        initial_lp: u64,
        timestamp: u64,
    }

    #[event]
    struct Swapped has drop, store {
        pool_addr: address,
        swapper: address,
        amount_in: u64,
        amount_out: u64,
        a_to_b: bool,
        lp_fee: u64,
        timestamp: u64,
    }

    #[event]
    struct LiquidityAdded has drop, store {
        pool_addr: address,
        provider: address,
        position_addr: address,
        amount_a: u64,
        amount_b: u64,
        shares_minted: u64,
        timestamp: u64,
    }

    #[event]
    struct LiquidityRemoved has drop, store {
        pool_addr: address,
        provider: address,
        position_addr: address,
        amount_a: u64,
        amount_b: u64,
        fees_a: u64,
        fees_b: u64,
        shares_burned: u64,
        timestamp: u64,
    }

    #[event]
    struct LpFeesClaimed has drop, store {
        pool_addr: address,
        position_addr: address,
        claimer: address,
        fees_a: u64,
        fees_b: u64,
        timestamp: u64,
    }

    #[event]
    struct FlashBorrowed has drop, store {
        pool_addr: address,
        metadata: address,
        amount: u64,
        fee: u64,
        timestamp: u64,
    }

    #[event]
    struct FlashRepaid has drop, store {
        pool_addr: address,
        metadata: address,
        amount: u64,
        fee: u64,
        timestamp: u64,
    }

    // ===== Internal helpers =====

    /// Babylonian integer sqrt for initial LP share computation.
    fun sqrt(x: u128): u128 {
        if (x == 0) return 0;
        let z = (x + 1) / 2;
        let y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        };
        y
    }

    /// Pure x*y=k swap math with SWAP_FEE_BPS wedge. u256 intermediates
    /// prevent overflow on adversarial reserves near u64::MAX. Public so
    /// the arbitrage module can simulate cycle outputs stateless during
    /// ternary search without re-reading pool state per iteration.
    public fun compute_amount_out(
        reserve_in: u64,
        reserve_out: u64,
        amount_in: u64,
    ): u64 {
        let amount_in_after_fee = (amount_in as u256) * ((BPS_DENOM - SWAP_FEE_BPS) as u256);
        let numerator = amount_in_after_fee * (reserve_out as u256);
        let denominator = (reserve_in as u256) * (BPS_DENOM as u256) + amount_in_after_fee;
        ((numerator / denominator) as u64)
    }

    /// Pure flash-fee computation: `amount * FLASH_FEE_BPS / BPS_DENOM`,
    /// floored up to 1 so dust borrows still pay a unit. Public so the
    /// arbitrage module can pre-compute repayment obligations for
    /// flash-based triangle closure without simulating the borrow.
    public fun compute_flash_fee(amount: u64): u64 {
        let fee_raw = (((amount as u256) * (FLASH_FEE_BPS as u256) / (BPS_DENOM as u256)) as u64);
        if (fee_raw == 0) { 1 } else { fee_raw }
    }

    /// Credit `fee` to the LP per-share accumulator on the side the fee
    /// was collected. Returns the accrued amount (== fee) for event
    /// attribution. Zero-credit on dust fees (fee=0) is a silent no-op.
    fun accrue_fee(pool: &mut Pool, fee: u64, a_side: bool): u64 {
        if (fee > 0 && pool.lp_supply > 0) {
            let add = (fee as u128) * SCALE / (pool.lp_supply as u128);
            if (a_side) {
                pool.lp_fee_per_share_a = pool.lp_fee_per_share_a + add;
            } else {
                pool.lp_fee_per_share_b = pool.lp_fee_per_share_b + add;
            }
        };
        fee
    }

    /// Compute `(per_share_current - per_share_debt) * shares / SCALE` in
    /// u256 to avoid overflow, return u64.
    fun pending_from_accumulator(
        per_share_current: u128,
        per_share_debt: u128,
        shares: u64,
    ): u64 {
        if (per_share_current <= per_share_debt) return 0;
        let delta = per_share_current - per_share_debt;
        let product = (delta as u256) * (shares as u256);
        let scaled = product / (SCALE as u256);
        (scaled as u64)
    }

    /// Mint a fresh LpPosition object for `owner_addr` with the given
    /// shares and debt snapshot.
    fun mint_lp_position(
        owner_addr: address,
        pool_addr: address,
        shares: u64,
        initial_debt_a: u128,
        initial_debt_b: u128,
    ): Object<LpPosition> {
        let ctor = object::create_object(owner_addr);
        let pos_signer = object::generate_signer(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        move_to(&pos_signer, LpPosition {
            pool_addr,
            shares,
            fee_debt_a: initial_debt_a,
            fee_debt_b: initial_debt_b,
            delete_ref,
        });

        object::object_from_constructor_ref<LpPosition>(&ctor)
    }

    // ===== Pool Creation (friend-only) =====

    /// Atomic pool + initial LP position creation. Called only by
    /// pool_factory::create_canonical_pool. Returns (pool_addr, position).
    public(friend) fun create_pool(
        factory_signer: &signer,
        creator_addr: address,
        constructor_ref: &ConstructorRef,
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
        amount_a: u64,
        amount_b: u64,
    ): (address, Object<LpPosition>) {
        // Creator picks the initial reserve ratio by choosing
        // (amount_a, amount_b) — this is the only place the ratio is
        // set from outside the invariant. Later LPs go through
        // `add_liquidity`, which enforces an optimal-pair match against
        // the live reserves plus `min_shares_out` slippage protection.
        assert!(amount_a > 0 && amount_b > 0, E_ZERO_AMOUNT);
        // Note: same-token pair rejection lives in the factory's
        // `assert_sorted` (strict `<` on BCS bytes). `create_pool` is
        // friend-only, reachable exclusively through
        // `pool_factory::create_canonical_pool`, so metadata_a and
        // metadata_b are guaranteed distinct at this point.

        let pool_signer = object::generate_signer(constructor_ref);
        let pool_addr = signer::address_of(&pool_signer);
        let extend_ref = object::generate_extend_ref(constructor_ref);

        let pool_transfer_ref = object::generate_transfer_ref(constructor_ref);
        object::disable_ungated_transfer(&pool_transfer_ref);

        let fa_a = primary_fungible_store::withdraw(factory_signer, metadata_a, amount_a);
        let fa_b = primary_fungible_store::withdraw(factory_signer, metadata_b, amount_b);
        primary_fungible_store::deposit(pool_addr, fa_a);
        primary_fungible_store::deposit(pool_addr, fa_b);

        // Initial LP shares = sqrt(a*b). MINIMUM_LIQUIDITY shares are
        // locked as dead shares so the first depositor cannot corner
        // the position via a later-stage ratio squeeze.
        let initial_lp_u128 = sqrt((amount_a as u128) * (amount_b as u128));
        assert!(initial_lp_u128 > (MINIMUM_LIQUIDITY as u128), E_INSUFFICIENT_LIQUIDITY);
        let initial_lp = (initial_lp_u128 as u64);
        let creator_shares = initial_lp - MINIMUM_LIQUIDITY;

        let now = timestamp::now_seconds();

        move_to(&pool_signer, Pool {
            metadata_a,
            metadata_b,
            extend_ref,
            reserve_a: amount_a,
            reserve_b: amount_b,
            lp_supply: initial_lp,
            lp_fee_per_share_a: 0,
            lp_fee_per_share_b: 0,
            locked: false,
        });

        let position = mint_lp_position(creator_addr, pool_addr, creator_shares, 0, 0);
        let position_addr = object::object_address(&position);

        event::emit(PoolCreated {
            pool_addr,
            metadata_a: object::object_address(&metadata_a),
            metadata_b: object::object_address(&metadata_b),
            creator: creator_addr,
            amount_a,
            amount_b,
            initial_lp,
            timestamp: now,
        });

        event::emit(LiquidityAdded {
            pool_addr,
            provider: creator_addr,
            position_addr,
            amount_a,
            amount_b,
            shares_minted: creator_shares,
            timestamp: now,
        });

        (pool_addr, position)
    }

    // ===== Swap =====

    /// Composable swap primitive. Takes FungibleAsset and returns
    /// FungibleAsset. No &signer — authorization happens at the caller's
    /// FA withdraw. `swapper` is recorded in the Swapped event for
    /// attribution only.
    public fun swap(
        pool_addr: address,
        swapper: address,
        fa_in: FungibleAsset,
        min_out: u64,
    ): FungibleAsset acquires Pool {
        assert!(exists<Pool>(pool_addr), E_NO_POOL);
        let pool = borrow_global_mut<Pool>(pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;

        let in_metadata = fungible_asset::asset_metadata(&fa_in);
        let amount_in = fungible_asset::amount(&fa_in);
        assert!(amount_in > 0, E_ZERO_AMOUNT);

        let a_to_b =
            if (object::object_address(&in_metadata) == object::object_address(&pool.metadata_a)) {
                true
            } else {
                assert!(
                    object::object_address(&in_metadata) == object::object_address(&pool.metadata_b),
                    E_WRONG_TOKEN,
                );
                false
            };

        let (reserve_in, reserve_out) = if (a_to_b) {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        let amount_out = compute_amount_out(reserve_in, reserve_out, amount_in);

        assert!(amount_out >= min_out, E_SLIPPAGE);
        assert!(amount_out < reserve_out, E_INSUFFICIENT_LIQUIDITY);

        let fee = amount_in * SWAP_FEE_BPS / BPS_DENOM;
        let lp_fee = accrue_fee(pool, fee, a_to_b);

        if (a_to_b) {
            pool.reserve_a = pool.reserve_a + amount_in - lp_fee;
            pool.reserve_b = pool.reserve_b - amount_out;
        } else {
            pool.reserve_a = pool.reserve_a - amount_out;
            pool.reserve_b = pool.reserve_b + amount_in - lp_fee;
        };

        primary_fungible_store::deposit(pool_addr, fa_in);
        let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
        let out_metadata = if (a_to_b) { pool.metadata_b } else { pool.metadata_a };
        let fa_out = primary_fungible_store::withdraw(&pool_signer, out_metadata, amount_out);

        pool.locked = false;

        event::emit(Swapped {
            pool_addr,
            swapper,
            amount_in,
            amount_out,
            a_to_b,
            lp_fee,
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Liquidity =====

    /// Add liquidity. Mints a new LpPosition NFT to the provider; each
    /// call mints a separate position (no merging).
    ///
    /// `amount_a_desired`/`amount_b_desired` are maxima. The function
    /// picks the optimal pair: the side whose desired amount more
    /// tightly matches the current reserve ratio is used in full, and
    /// the other side uses only the proportional amount. The unused
    /// buffer stays in the caller's wallet.
    ///
    /// `min_shares_out` is the slippage floor on minted shares.
    public fun add_liquidity(
        provider: &signer,
        pool_addr: address,
        amount_a_desired: u64,
        amount_b_desired: u64,
        min_shares_out: u64,
    ): Object<LpPosition> acquires Pool {
        assert!(exists<Pool>(pool_addr), E_NO_POOL);
        assert!(amount_a_desired > 0 && amount_b_desired > 0, E_ZERO_AMOUNT);

        let pool = borrow_global_mut<Pool>(pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;

        // u64 cast guard: for ratios > 2^64:1 the u256 product overflows
        // u64. Explicit assert produces E_INSUFFICIENT_LIQUIDITY instead
        // of an opaque arithmetic abort.
        let amount_b_optimal_u256 =
            (amount_a_desired as u256) * (pool.reserve_b as u256)
                / (pool.reserve_a as u256);
        assert!(amount_b_optimal_u256 <= (U64_MAX as u256), E_INSUFFICIENT_LIQUIDITY);
        let amount_b_optimal = (amount_b_optimal_u256 as u64);
        let (amount_a, amount_b) = if (amount_b_optimal <= amount_b_desired) {
            (amount_a_desired, amount_b_optimal)
        } else {
            let amount_a_optimal_u256 =
                (amount_b_desired as u256) * (pool.reserve_a as u256)
                    / (pool.reserve_b as u256);
            assert!(amount_a_optimal_u256 <= (U64_MAX as u256), E_INSUFFICIENT_LIQUIDITY);
            let amount_a_optimal = (amount_a_optimal_u256 as u64);
            // Mathematically guaranteed by the if-branch condition under
            // the x*y=k invariant — kept as an explicit invariant check.
            assert!(amount_a_optimal <= amount_a_desired, E_DISPROPORTIONAL);
            (amount_a_optimal, amount_b_desired)
        };

        assert!(amount_a > 0 && amount_b > 0, E_ZERO_AMOUNT);

        // Shares minted proportionally; min as a guard against integer
        // rounding asymmetry between the two sides.
        let lp_a = (
            ((amount_a as u256) * (pool.lp_supply as u256) / (pool.reserve_a as u256)) as u64
        );
        let lp_b = (
            ((amount_b as u256) * (pool.lp_supply as u256) / (pool.reserve_b as u256)) as u64
        );
        let shares = if (lp_a < lp_b) { lp_a } else { lp_b };
        assert!(shares > 0, E_ZERO_AMOUNT);
        assert!(shares >= min_shares_out, E_SLIPPAGE);

        let provider_addr = signer::address_of(provider);

        let fa_a = primary_fungible_store::withdraw(provider, pool.metadata_a, amount_a);
        let fa_b = primary_fungible_store::withdraw(provider, pool.metadata_b, amount_b);
        primary_fungible_store::deposit(pool_addr, fa_a);
        primary_fungible_store::deposit(pool_addr, fa_b);

        pool.reserve_a = pool.reserve_a + amount_a;
        pool.reserve_b = pool.reserve_b + amount_b;
        pool.lp_supply = pool.lp_supply + shares;

        let debt_a = pool.lp_fee_per_share_a;
        let debt_b = pool.lp_fee_per_share_b;

        let position = mint_lp_position(provider_addr, pool_addr, shares, debt_a, debt_b);
        let position_addr = object::object_address(&position);

        event::emit(LiquidityAdded {
            pool_addr,
            provider: provider_addr,
            position_addr,
            amount_a,
            amount_b,
            shares_minted: shares,
            timestamp: timestamp::now_seconds(),
        });

        pool.locked = false;
        position
    }

    /// Burn LpPosition and return proportional reserves PLUS accumulated
    /// LP fees in one shot. `min_amount_a`/`min_amount_b` are slippage
    /// floors on the proportional reserve payout (not fee claims).
    public fun remove_liquidity(
        provider: &signer,
        position: Object<LpPosition>,
        min_amount_a: u64,
        min_amount_b: u64,
    ): (FungibleAsset, FungibleAsset) acquires Pool, LpPosition {
        let provider_addr = signer::address_of(provider);
        assert!(object::owner(position) == provider_addr, E_NOT_OWNER);

        let position_addr = object::object_address(&position);
        assert!(exists<LpPosition>(position_addr), E_NO_POSITION);

        let LpPosition {
            pool_addr,
            shares,
            fee_debt_a,
            fee_debt_b,
            delete_ref,
        } = move_from<LpPosition>(position_addr);

        assert!(exists<Pool>(pool_addr), E_NO_POOL);
        let pool = borrow_global_mut<Pool>(pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;
        assert!(shares > 0, E_ZERO_AMOUNT);
        assert!(pool.lp_supply >= shares, E_INSUFFICIENT_LP);

        let claim_a = pending_from_accumulator(pool.lp_fee_per_share_a, fee_debt_a, shares);
        let claim_b = pending_from_accumulator(pool.lp_fee_per_share_b, fee_debt_b, shares);

        let amount_a = (
            ((shares as u256) * (pool.reserve_a as u256) / (pool.lp_supply as u256)) as u64
        );
        let amount_b = (
            ((shares as u256) * (pool.reserve_b as u256) / (pool.lp_supply as u256)) as u64
        );

        assert!(amount_a >= min_amount_a, E_SLIPPAGE);
        assert!(amount_b >= min_amount_b, E_SLIPPAGE);

        pool.lp_supply = pool.lp_supply - shares;
        assert!(pool.lp_supply >= MINIMUM_LIQUIDITY, E_INSUFFICIENT_LIQUIDITY);
        pool.reserve_a = pool.reserve_a - amount_a;
        pool.reserve_b = pool.reserve_b - amount_b;

        let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
        let fa_a = primary_fungible_store::withdraw(&pool_signer, pool.metadata_a, amount_a + claim_a);
        let fa_b = primary_fungible_store::withdraw(&pool_signer, pool.metadata_b, amount_b + claim_b);

        event::emit(LiquidityRemoved {
            pool_addr,
            provider: provider_addr,
            position_addr,
            amount_a,
            amount_b,
            fees_a: claim_a,
            fees_b: claim_b,
            shares_burned: shares,
            timestamp: timestamp::now_seconds(),
        });

        object::delete(delete_ref);

        pool.locked = false;
        (fa_a, fa_b)
    }

    // ===== Fee Claims =====

    /// Harvest accumulated LP fees without touching position's shares.
    /// Resets debt snapshot to current per_share so future accumulation
    /// starts from zero. Runs under the pool lock to stay safe if FA
    /// operations ever gain dispatch callbacks.
    public fun claim_lp_fees(
        provider: &signer,
        position: Object<LpPosition>,
    ): (FungibleAsset, FungibleAsset) acquires Pool, LpPosition {
        let provider_addr = signer::address_of(provider);
        assert!(object::owner(position) == provider_addr, E_NOT_OWNER);

        let position_addr = object::object_address(&position);
        assert!(exists<LpPosition>(position_addr), E_NO_POSITION);

        let pos = borrow_global_mut<LpPosition>(position_addr);
        assert!(exists<Pool>(pos.pool_addr), E_NO_POOL);

        let pool = borrow_global_mut<Pool>(pos.pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;

        let claim_a = pending_from_accumulator(pool.lp_fee_per_share_a, pos.fee_debt_a, pos.shares);
        let claim_b = pending_from_accumulator(pool.lp_fee_per_share_b, pos.fee_debt_b, pos.shares);

        pos.fee_debt_a = pool.lp_fee_per_share_a;
        pos.fee_debt_b = pool.lp_fee_per_share_b;

        let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
        let fa_a = if (claim_a > 0) {
            primary_fungible_store::withdraw(&pool_signer, pool.metadata_a, claim_a)
        } else {
            fungible_asset::zero(pool.metadata_a)
        };
        let fa_b = if (claim_b > 0) {
            primary_fungible_store::withdraw(&pool_signer, pool.metadata_b, claim_b)
        } else {
            fungible_asset::zero(pool.metadata_b)
        };

        pool.locked = false;

        event::emit(LpFeesClaimed {
            pool_addr: pos.pool_addr,
            position_addr,
            claimer: provider_addr,
            fees_a: claim_a,
            fees_b: claim_b,
            timestamp: timestamp::now_seconds(),
        });

        (fa_a, fa_b)
    }

    // ===== Flash loan =====

    /// Flash borrow `amount` of `metadata` from the pool. Returns
    /// borrowed FA and a FlashReceipt hot-potato that must be consumed
    /// via flash_repay in the same TX. Pool is locked during the borrow
    /// span — swap/LP/flash ops abort until repay.
    public fun flash_borrow(
        pool_addr: address,
        metadata: Object<Metadata>,
        amount: u64,
    ): (FungibleAsset, FlashReceipt) acquires Pool {
        assert!(exists<Pool>(pool_addr), E_NO_POOL);
        assert!(amount > 0, E_ZERO_AMOUNT);

        let pool = borrow_global_mut<Pool>(pool_addr);
        assert!(!pool.locked, E_LOCKED);
        pool.locked = true;

        let metadata_addr = object::object_address(&metadata);
        let is_a = metadata_addr == object::object_address(&pool.metadata_a);
        assert!(is_a || metadata_addr == object::object_address(&pool.metadata_b), E_WRONG_TOKEN);

        let (reserve_in, reserve_out) = if (is_a) {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };
        assert!(amount < reserve_in, E_INSUFFICIENT_LIQUIDITY);

        // Record k_before in u256 for safe repay-time invariant check.
        let k_before = (reserve_in as u256) * (reserve_out as u256);

        let fee = compute_flash_fee(amount);

        let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
        let fa_out = primary_fungible_store::withdraw(&pool_signer, metadata, amount);

        event::emit(FlashBorrowed {
            pool_addr,
            metadata: metadata_addr,
            amount,
            fee,
            timestamp: timestamp::now_seconds(),
        });

        let receipt = FlashReceipt {
            pool_addr,
            metadata,
            amount,
            fee,
            k_before,
        };

        (fa_out, receipt)
    }

    /// Repay flash borrow with principal + fee. Consumes the hot-potato
    /// receipt and releases the lock.
    ///
    /// Reserve accounting: `flash_borrow` does NOT decrement reserve_a/b
    /// when the borrowed amount leaves the store — the `locked` flag
    /// guarantees no one reads reserves during the borrow span.
    /// Therefore `flash_repay` must NOT add the principal back; doing so
    /// would inflate reserves by `amount` and break solvency. Only the
    /// fee is routed to LP via `accrue_fee`.
    public fun flash_repay(
        pool_addr: address,
        fa_in: FungibleAsset,
        receipt: FlashReceipt,
    ) acquires Pool {
        let FlashReceipt { pool_addr: r_pool, metadata, amount, fee, k_before } = receipt;
        assert!(pool_addr == r_pool, E_WRONG_POOL);

        let repay_total = amount + fee;
        // Strict equality prevents silent donation of excess — the
        // surplus would be deposited as untracked reserve drift.
        assert!(fungible_asset::amount(&fa_in) == repay_total, E_INSUFFICIENT_LIQUIDITY);
        assert!(
            object::object_address(&fungible_asset::asset_metadata(&fa_in)) == object::object_address(&metadata),
            E_WRONG_TOKEN,
        );

        let pool = borrow_global_mut<Pool>(pool_addr);

        primary_fungible_store::deposit(pool_addr, fa_in);

        // Fee is pure LP revenue. Reserves unchanged — they were never
        // decremented at borrow time.
        let is_a = object::object_address(&metadata) == object::object_address(&pool.metadata_a);
        let _lp = accrue_fee(pool, fee, is_a);

        // k-invariant: post-repay reserves product must be >= pre-borrow
        // snapshot. With the reserve-unchanged model above, equality is
        // the expected case.
        let k_after = (pool.reserve_a as u256) * (pool.reserve_b as u256);
        assert!(k_after >= k_before, E_K_VIOLATED);

        pool.locked = false;

        event::emit(FlashRepaid {
            pool_addr,
            metadata: object::object_address(&metadata),
            amount,
            fee,
            timestamp: timestamp::now_seconds(),
        });
    }

    // ===== LP management entry wrappers (deadline-guarded) =====
    //
    // Swap entry is deliberately NOT here — users swap via the
    // `arbitrage` module, which wraps `pool::swap` with smart routing
    // and cycle closure and applies a 10% service charge on any
    // measurable surplus over the canonical direct-hop baseline.
    // Direct `pool::swap` is the pure composable primitive, callable
    // only from Move code (no wallet-facing entry).

    public entry fun add_liquidity_entry(
        provider: &signer,
        pool_addr: address,
        amount_a: u64,
        amount_b: u64,
        min_shares_out: u64,
        deadline: u64,
    ) acquires Pool {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let _ = add_liquidity(provider, pool_addr, amount_a, amount_b, min_shares_out);
    }

    public entry fun remove_liquidity_entry(
        provider: &signer,
        position: Object<LpPosition>,
        min_amount_a: u64,
        min_amount_b: u64,
        deadline: u64,
    ) acquires Pool, LpPosition {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let provider_addr = signer::address_of(provider);
        let (fa_a, fa_b) = remove_liquidity(provider, position, min_amount_a, min_amount_b);
        primary_fungible_store::deposit(provider_addr, fa_a);
        primary_fungible_store::deposit(provider_addr, fa_b);
    }

    public entry fun claim_lp_fees_entry(
        provider: &signer,
        position: Object<LpPosition>,
        deadline: u64,
    ) acquires Pool, LpPosition {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let provider_addr = signer::address_of(provider);
        let (fa_a, fa_b) = claim_lp_fees(provider, position);
        primary_fungible_store::deposit(provider_addr, fa_a);
        primary_fungible_store::deposit(provider_addr, fa_b);
    }

    // ===== Minimal state readers =====
    //
    // Only what the arbitrage module + frontend pool list need. LP
    // position views (supply, fees, pending) are intentionally omitted
    // — client-side RPC can read resources directly.

    #[view]
    public fun pool_exists(pool_addr: address): bool {
        exists<Pool>(pool_addr)
    }

    #[view]
    public fun reserves(pool_addr: address): (u64, u64) acquires Pool {
        let p = borrow_global<Pool>(pool_addr);
        (p.reserve_a, p.reserve_b)
    }

    #[view]
    public fun pool_tokens(pool_addr: address): (Object<Metadata>, Object<Metadata>) acquires Pool {
        let p = borrow_global<Pool>(pool_addr);
        (p.metadata_a, p.metadata_b)
    }

    #[view]
    public fun lp_supply(pool_addr: address): u64 acquires Pool {
        borrow_global<Pool>(pool_addr).lp_supply
    }

    #[view]
    public fun position_shares(pos: Object<LpPosition>): u64 acquires LpPosition {
        borrow_global<LpPosition>(object::object_address(&pos)).shares
    }
}
