# Darbitex Final — Audit Source Bundle

**Version:** Final 0.1.0  
**Date:** 2026-04-14  
**Chain:** Aptos mainnet (pre-publish audit)  
**Compilation:** `aptos move compile --named-addresses darbitex=0x1` → clean, zero warnings  
**Total Move source:** 1978 lines across 3 production modules + 1 test stub  
**Upgrade policy:** `compatible` at launch, flips to `immutable` after 3-6 month soak

This bundle contains the **complete audit scope** for Darbitex Final, packaged as a single self-contained document for external AI audit submission. For context, design principles, threat model, and specific review questions, see the companion file `AUDIT-FINAL-SUBMISSION.md`.

---

## Module overview

| File | Lines | Purpose |
|---|---|---|
| `Move.toml` | 14 | Package manifest + framework dependency |
| `pool.move` | 807 | Core AMM primitives (Pool, LpPosition, FlashReceipt), swap + LP + flash + fee claim |
| `pool_factory.move` | 198 | Factory singleton with `asset_index` reverse lookup for sister-pool discovery |
| `arbitrage.move` | 973 | Programmable arbitrage: path + cycle + flash-triangle DFS, four entry surfaces (entry/compose/view), uniform 10% service charge |
| `tests.move` | 14 | Stub — **out of scope** |

---

## 1. Move.toml

```toml
[package]
name = "DarbitexFinal"
version = "0.1.0"
upgrade_policy = "compatible"
authors = ["Rera", "Claude (Anthropic)"]
license = "Unlicense"

[dependencies.AptosFramework]
git = "https://github.com/aptos-labs/aptos-core.git"
rev = "mainnet"
subdir = "aptos-move/framework/aptos-framework"

[addresses]
darbitex = "_"
```

---

## 2. pool.move

```move
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
}
```

---

## 3. pool_factory.move

```move
/// Darbitex — pool factory.
///
/// Creates canonical pools (one per sorted pair, deterministic
/// named-object address). Maintains a global asset→pools index used by
/// `arbitrage` for sister-pool discovery. Pure primitives + minimum
/// readers. No admin surface. The pool module owns the creation event
/// stream; the factory does not re-emit.

module darbitex::pool_factory {
    use std::signer;
    use std::vector;
    use std::bcs;
    use aptos_std::table::{Self, Table};
    use aptos_framework::account::{Self, SignerCapability};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::primary_fungible_store;

    use darbitex::pool;

    const FACTORY_SEED: vector<u8> = b"darbitex_factory";
    const POOL_SEED_PREFIX: vector<u8> = b"darbitex_pool";

    /// Hard cap on the per-call page size for `pools_containing_asset`.
    /// Bounds the per-call copy cost of the reverse index to a small
    /// constant regardless of how many pools reference any one asset.
    /// No cap on TOTAL pools per asset — callers (the arbitrage
    /// module and off-chain readers) paginate through the full set
    /// by looping `offset` if the page is saturated.
    const MAX_PAGE: u64 = 10;

    const E_NOT_ADMIN: u64 = 1;
    const E_ALREADY_INIT: u64 = 2;
    const E_NOT_INIT: u64 = 3;
    const E_WRONG_ORDER: u64 = 4;
    const E_ZERO: u64 = 5;

    /// Singleton at @darbitex. Owns the resource account under which all
    /// pool objects live and holds the asset→pools reverse index.
    struct Factory has key {
        signer_cap: SignerCapability,
        factory_addr: address,
        pool_addresses: vector<address>,
        /// Asset metadata address → list of pool addresses containing
        /// that asset as one of the two sides. Read via paginated
        /// `pools_containing_asset(asset, offset, limit)` to bound
        /// per-call copy cost.
        asset_index: Table<address, vector<address>>,
    }

    /// Require the pair in canonical sorted order (BCS byte order).
    fun assert_sorted(metadata_a: Object<Metadata>, metadata_b: Object<Metadata>) {
        let ba = bcs::to_bytes(&object::object_address(&metadata_a));
        let bb = bcs::to_bytes(&object::object_address(&metadata_b));
        assert!(ba < bb, E_WRONG_ORDER);
    }

    /// Deterministic seed from two raw asset addresses in the order
    /// supplied. Callers are responsible for passing them in canonical
    /// (BCS-sorted) order.
    fun derive_pair_seed_addrs(
        asset_a: address,
        asset_b: address,
    ): vector<u8> {
        let seed = POOL_SEED_PREFIX;
        vector::append(&mut seed, bcs::to_bytes(&asset_a));
        vector::append(&mut seed, bcs::to_bytes(&asset_b));
        seed
    }

    /// Object-typed convenience wrapper over `derive_pair_seed_addrs`.
    fun derive_pair_seed(
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
    ): vector<u8> {
        derive_pair_seed_addrs(
            object::object_address(&metadata_a),
            object::object_address(&metadata_b),
        )
    }

    /// Insert `pool_addr` into `asset_index[asset]`, creating the
    /// bucket on first touch. No cap on bucket length — ecosystem
    /// growth must not be gated by the factory. Arbitrage DFS
    /// paginates through the full bucket via MAX_PAGE-sized reads.
    fun index_asset(
        asset_index: &mut Table<address, vector<address>>,
        asset: address,
        pool_addr: address,
    ) {
        if (!table::contains(asset_index, asset)) {
            let v = vector::empty<address>();
            vector::push_back(&mut v, pool_addr);
            table::add(asset_index, asset, v);
        } else {
            let v = table::borrow_mut(asset_index, asset);
            vector::push_back(v, pool_addr);
        }
    }

    /// One-shot initializer. Called by the package publisher (`@darbitex`)
    /// once, immediately after publish.
    public entry fun init_factory(deployer: &signer) {
        assert!(signer::address_of(deployer) == @darbitex, E_NOT_ADMIN);
        assert!(!exists<Factory>(@darbitex), E_ALREADY_INIT);

        let (factory_signer, signer_cap) = account::create_resource_account(deployer, FACTORY_SEED);
        let factory_addr = signer::address_of(&factory_signer);

        move_to(deployer, Factory {
            signer_cap,
            factory_addr,
            pool_addresses: vector::empty(),
            asset_index: table::new(),
        });
    }

    /// Atomic canonical pool creation. Caller supplies seeding tokens
    /// with independent `amount_a`/`amount_b` — initial ratio is set by
    /// creator. Duplicate protection via `create_named_object` abort.
    public entry fun create_canonical_pool(
        creator: &signer,
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
        amount_a: u64,
        amount_b: u64,
    ) acquires Factory {
        assert!(exists<Factory>(@darbitex), E_NOT_INIT);
        assert!(amount_a > 0 && amount_b > 0, E_ZERO);
        // `assert_sorted` uses strict `<` on BCS bytes, which also
        // rejects same-token pairs (`bcs(a) < bcs(a)` is false).
        assert_sorted(metadata_a, metadata_b);

        let factory = borrow_global_mut<Factory>(@darbitex);
        let factory_signer = account::create_signer_with_capability(&factory.signer_cap);
        let factory_addr = factory.factory_addr;
        let creator_addr = signer::address_of(creator);

        let fa_a = primary_fungible_store::withdraw(creator, metadata_a, amount_a);
        let fa_b = primary_fungible_store::withdraw(creator, metadata_b, amount_b);
        primary_fungible_store::deposit(factory_addr, fa_a);
        primary_fungible_store::deposit(factory_addr, fa_b);

        let seed = derive_pair_seed(metadata_a, metadata_b);
        let ctor = object::create_named_object(&factory_signer, seed);

        let (pool_addr, _position) = pool::create_pool(
            &factory_signer,
            creator_addr,
            &ctor,
            metadata_a,
            metadata_b,
            amount_a,
            amount_b,
        );

        vector::push_back(&mut factory.pool_addresses, pool_addr);
        index_asset(&mut factory.asset_index, object::object_address(&metadata_a), pool_addr);
        index_asset(&mut factory.asset_index, object::object_address(&metadata_b), pool_addr);
    }

    // ===== Minimal readers =====

    #[view]
    public fun get_all_pools(): vector<address> acquires Factory {
        borrow_global<Factory>(@darbitex).pool_addresses
    }

    // Total number of pools containing `asset` as one of the two sides.
    // Cheap read (no copy). Lets the arbitrage module know whether to
    // paginate a second call when `limit` is saturated.
    #[view]
    public fun pools_containing_asset_count(asset: address): u64 acquires Factory {
        let f = borrow_global<Factory>(@darbitex);
        if (table::contains(&f.asset_index, asset)) {
            vector::length(table::borrow(&f.asset_index, asset))
        } else {
            0
        }
    }

    // Paginated reverse index lookup. Returns at most `min(limit,
    // MAX_PAGE)` pool addresses, starting at `offset` within the
    // asset's pool bucket. Empty if `asset` has no entries or `offset`
    // is past the end. Used by the arbitrage module for sister-pool
    // discovery and by off-chain indexers.
    #[view]
    public fun pools_containing_asset(
        asset: address,
        offset: u64,
        limit: u64,
    ): vector<address> acquires Factory {
        let result = vector::empty<address>();
        let f = borrow_global<Factory>(@darbitex);
        if (!table::contains(&f.asset_index, asset)) return result;

        let bucket = table::borrow(&f.asset_index, asset);
        let len = vector::length(bucket);
        if (offset >= len) return result;

        let capped = if (limit > MAX_PAGE) { MAX_PAGE } else { limit };
        // `remaining` is safe (offset < len is guaranteed above), and
        // `take = min(capped, remaining)` fits in u64 without overflow
        // because `take <= len - offset < len`.
        let remaining = len - offset;
        let take = if (capped > remaining) { remaining } else { capped };

        let i = 0;
        while (i < take) {
            vector::push_back(&mut result, *vector::borrow(bucket, offset + i));
            i = i + 1;
        };
        result
    }

    // Canonical pool address for any two asset metadata addresses,
    // without requiring the pool to exist. Sorts the inputs in BCS
    // byte order internally (caller does not need to pre-sort) and
    // returns the deterministic object address derived from the
    // factory seed + sorted pair. Pure address derivation — callers
    // must check `pool::pool_exists(addr)` before assuming the pool
    // is live.
    //
    // Used by the arbitrage module for O(1) direct-pool lookup when
    // computing the service-charge baseline, replacing a previously
    // O(N) reverse-index scan that could miss direct pools parked
    // past the pagination page size.
    #[view]
    public fun canonical_pool_address_of(
        asset_a: address,
        asset_b: address,
    ): address acquires Factory {
        let ba = bcs::to_bytes(&asset_a);
        let bb = bcs::to_bytes(&asset_b);
        let (sorted_a, sorted_b) = if (ba < bb) {
            (asset_a, asset_b)
        } else {
            (asset_b, asset_a)
        };
        let f = borrow_global<Factory>(@darbitex);
        let seed = derive_pair_seed_addrs(sorted_a, sorted_b);
        object::create_object_address(&f.factory_addr, seed)
    }
}
```

---

## 4. arbitrage.move

```move
/// Darbitex — arbitrage module.
///
/// Decentralized, agnostic, composable. Every capability is available
/// in three layers:
///
/// • **Entry wrappers** — `*_entry` functions callable from a wallet.
///   Handle deadline, primary-store withdraw/deposit, and call into
///   the compose layer.
///
/// • **Composable primitives** — `*_compose` functions taking raw
///   `FungibleAsset` values and returning the caller's share as a
///   `FungibleAsset`. No `&signer`, no primary-store coupling, no
///   deadline. External Move modules (Aave flash receivers, other
///   DEX satellites, custom arb bots) import these directly and
///   compose them into larger flows. Treasury cut is extracted
///   inside the compose function where applicable.
///
/// • **Quote views** — `quote_*` functions marked `#[view]` for
///   RPC-side path discovery without executing. Off-chain bots
///   precompute the best path / cycle / flash triangle, then either
///   call an entry function or pass the path to
///   `execute_path_compose` for minimum on-chain overhead.
///
/// Four execution surfaces:
///
///   1. `execute_path_compose`  — raw chained multi-hop swap; no
///      treasury cut. Pure composability primitive, mirrors
///      `pool::swap` semantics extended to a pool sequence.
///
///   2. `swap_compose`          — smart-routed single-swap: module
///      DFS-searches the best path from input to output asset,
///      executes, and splits any improvement over the canonical
///      direct-hop pool 90% to caller / 10% to treasury. If no
///      canonical direct pool exists, baseline is 0 and no service
///      charge applies (Darbitex is the only available route).
///
///   3. `close_triangle_compose` — real-capital cycle closure:
///      caller supplies a seed FA, module executes the best cycle
///      (length 3..MAX_CYCLE_LEN) starting and ending at the
///      seed's asset, splits profit 90% / 10%.
///
///   4. `close_triangle_flash_compose` — zero-capital flash cycle:
///      module finds a (borrow_pool, cycle) topology where the
///      borrow pool is disjoint from the cycle legs, flash-borrows
///      the anchor amount, runs the cycle, repays, and returns the
///      caller's 90% profit share.
///
/// All execution paths pay the 1 bps LP fee per pool touched via
/// `pool::swap`. External flash-loan providers (Aave) compose
/// trivially with `close_triangle_compose` or `swap_compose` by
/// withdrawing FA from their borrow callback and feeding it in.
/// Rebalancing across the pool graph is a natural side effect of
/// repeated cycle/routed execution; there is no "goal state" — arb
/// continues as long as profit remains.

module darbitex::arbitrage {
    use std::signer;
    use std::vector;
    use aptos_framework::event;
    use aptos_framework::object::{Self, Object};
    use aptos_framework::fungible_asset::{Self, FungibleAsset, Metadata};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool;
    use darbitex::pool_factory;

    // ===== Constants =====

    /// Treasury cut is 10% of surplus; caller/user gets the remaining 90%.
    const TREASURY_BPS: u64 = 1_000;
    const TOTAL_BPS: u64 = 10_000;

    /// Max path length for smart routing.
    const MAX_HOPS: u64 = 4;

    /// Max cycle length for triangle closure. Minimum is 3 (enforced
    /// at match time) because canonical pairs make 2-leg cycles
    /// impossible.
    const MAX_CYCLE_LEN: u64 = 5;

    /// Per-lookup page size for the factory's reverse index.
    const PAGE: u64 = 10;

    /// Soft DFS visit budget — maximum number of sister-pool
    /// candidates the recursive search will iterate through across
    /// the entire search tree per `find_best_*` call. Once exhausted,
    /// the DFS returns the best path found so far and stops
    /// exploring. Bounds worst-case gas to a predictable O(budget)
    /// regardless of ecosystem size, preventing gas-exhaustion DoS
    /// from junk-pool spam.
    const DFS_VISIT_BUDGET: u64 = 256;

    /// Treasury recipient for the protocol cut on arb surplus.
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;

    // ===== Errors =====

    const E_DEADLINE: u64 = 1;
    const E_ZERO: u64 = 2;
    const E_WRONG_POOL: u64 = 3;
    const E_SLIPPAGE: u64 = 4;
    const E_NO_CYCLE: u64 = 5;
    const E_MIN_PROFIT: u64 = 6;

    // ===== Types =====

    /// A path through the pool graph. `pools[i]` is the pool used for
    /// hop `i`; direction at each hop is inferred from the FA metadata
    /// at execution time (see `pool::swap`). `expected_out` is the
    /// simulated output at the final hop given the entry amount at
    /// hop 0.
    struct Path has copy, drop {
        pools: vector<address>,
        expected_out: u64,
    }

    /// A flash-based triangle: `borrow_pool` is the flash source,
    /// `cycle` is the closed cycle at anchor that must not include
    /// `borrow_pool`. `borrow_pool == @0x0` signals no valid topology.
    struct FlashTriangle has copy, drop {
        borrow_pool: address,
        cycle: Path,
    }

    fun empty_path(): Path {
        Path {
            pools: vector::empty(),
            expected_out: 0,
        }
    }

    // ===== Events =====

    #[event]
    struct RoutedSwap has drop, store {
        swapper: address,
        metadata_in: address,
        metadata_out: address,
        amount_in: u64,
        direct_out: u64,
        routed_out: u64,
        hops: u64,
        improvement: u64,
        treasury_cut: u64,
        caller_received: u64,
        timestamp: u64,
    }

    #[event]
    struct TriangleClosed has drop, store {
        caller: address,
        anchor: address,
        seed: u64,
        gross_out: u64,
        profit: u64,
        treasury_cut: u64,
        caller_received: u64,
        cycle_hops: u64,
        timestamp: u64,
    }

    #[event]
    struct FlashTriangleClosed has drop, store {
        caller: address,
        anchor: address,
        borrow_pool: address,
        amount: u64,
        flash_fee: u64,
        gross_out: u64,
        profit: u64,
        treasury_cut: u64,
        caller_received: u64,
        cycle_hops: u64,
        timestamp: u64,
    }

    #[event]
    struct PathExecuted has drop, store {
        swapper: address,
        metadata_in: address,
        metadata_out: address,
        amount_in: u64,
        baseline: u64,
        actual_out: u64,
        surplus: u64,
        treasury_cut: u64,
        caller_received: u64,
        hops: u64,
        is_cycle: bool,
        timestamp: u64,
    }

    // ===== Pure helpers =====

    /// For the pool at `pool_addr`, return the "other side" asset, the
    /// direction flag, and the simulated leg output assuming `current`
    /// is the input asset and `amount_in_left` is the amount entering
    /// the leg. If the pool does not contain `current`, returns
    /// `leg_out = 0` — caller detects and skips.
    fun simulate_leg(
        pool_addr: address,
        current: address,
        amount_in_left: u64,
    ): (address, bool, u64) {
        let (ma, mb) = pool::pool_tokens(pool_addr);
        let ma_addr = object::object_address(&ma);
        let mb_addr = object::object_address(&mb);
        let (ra, rb) = pool::reserves(pool_addr);
        if (ma_addr == current) {
            (mb_addr, true, pool::compute_amount_out(ra, rb, amount_in_left))
        } else if (mb_addr == current) {
            (ma_addr, false, pool::compute_amount_out(rb, ra, amount_in_left))
        } else {
            (@0x0, false, 0)
        }
    }

    /// Given a pool and the current input asset, return the "other
    /// side" asset (what comes out of the pool). `@0x0` if the pool
    /// does not contain `current`.
    fun asset_after_leg(pool_addr: address, current: address): address {
        let (ma, mb) = pool::pool_tokens(pool_addr);
        let ma_addr = object::object_address(&ma);
        let mb_addr = object::object_address(&mb);
        if (ma_addr == current) {
            mb_addr
        } else if (mb_addr == current) {
            ma_addr
        } else {
            @0x0
        }
    }

    /// Walk `pool_path` from `start` asset and return the final
    /// asset the path ends at. Returns `@0x0` if any pool in the
    /// sequence does not contain the current-side asset.
    fun trace_path_end(pool_path: &vector<address>, start: address): address {
        let current = start;
        let n = vector::length(pool_path);
        let i = 0;
        while (i < n) {
            let pool_addr = *vector::borrow(pool_path, i);
            current = asset_after_leg(pool_addr, current);
            if (current == @0x0) return @0x0;
            i = i + 1;
        };
        current
    }

    /// Look up the direct `from` → `to` pool via the factory's
    /// deterministic canonical address derivation (O(1), no
    /// pagination scan) and return its simulated output for
    /// `amount_in`. Returns 0 if no pool exists at the derived
    /// address — caller interprets as "no baseline, no service
    /// charge applied".
    ///
    /// This avoids the pagination-miss bug where a reverse-index
    /// scan bounded by `PAGE` could fail to surface a direct pool
    /// parked at index ≥ PAGE and cause the service charge to be
    /// incorrectly skipped.
    fun compute_direct_baseline(
        from: address,
        to: address,
        amount_in: u64,
    ): u64 {
        if (from == to) return 0;
        let canonical = pool_factory::canonical_pool_address_of(from, to);
        if (!pool::pool_exists(canonical)) return 0;
        let (_, _, leg_out) = simulate_leg(canonical, from, amount_in);
        leg_out
    }

    /// Copy `path_pools` and append one more leg.
    fun push_leg(
        path_pools: &vector<address>,
        pool_addr: address,
    ): vector<address> {
        let new_pools = *path_pools;
        vector::push_back(&mut new_pools, pool_addr);
        new_pools
    }

    // ===== Search: linear A → B path =====

    /// Find the best path from `from` to `to` carrying `amount_in`.
    /// DFS up to MAX_HOPS deep, pruning revisited assets and pools.
    /// Bounded by `DFS_VISIT_BUDGET` — once exhausted the search
    /// stops and returns the best path found so far. Empty Path if
    /// no path reaches `to` within the budget.
    fun find_best_path(
        from: address,
        to: address,
        amount_in: u64,
    ): Path {
        let best = empty_path();
        let visited = vector::empty<address>();
        vector::push_back(&mut visited, from);
        let pools = vector::empty<address>();
        let budget = DFS_VISIT_BUDGET;
        dfs_path(from, to, amount_in, &pools, &visited, &mut best, &mut budget);
        best
    }

    fun dfs_path(
        current: address,
        target: address,
        amount_in_left: u64,
        path_pools: &vector<address>,
        visited: &vector<address>,
        best: &mut Path,
        budget: &mut u64,
    ) {
        let depth = vector::length(path_pools);
        if (depth >= MAX_HOPS || *budget == 0) return;

        // Lazy-paginated iteration over sister pools. Fetches one
        // PAGE at a time and only requests the next page if budget
        // remains. This bounds total fetch + allocation cost to
        // O(PAGE × max_pages_touched_before_budget_exhausts), which
        // is tightly coupled to the DFS budget — an attacker with N
        // junk pools cannot force the search to allocate an
        // N-element vector upfront. Fixes the `fetch_all_sister_pools`
        // DoS vector flagged by Gemini R2 HIGH-1.
        let offset = 0;
        let exhausted = false;
        while (!exhausted && *budget > 0) {
            let batch = pool_factory::pools_containing_asset(current, offset, PAGE);
            let batch_n = vector::length(&batch);
            if (batch_n == 0) {
                exhausted = true;
            } else {
                let i = 0;
                while (i < batch_n && *budget > 0) {
                    *budget = *budget - 1;
                    let pool_addr = *vector::borrow(&batch, i);
                    if (!vector::contains(path_pools, &pool_addr)) {
                        let (other, _a_to_b, leg_out) =
                            simulate_leg(pool_addr, current, amount_in_left);
                        if (leg_out > 0) {
                            if (other == target) {
                                if (leg_out > best.expected_out) {
                                    let new_pools = push_leg(path_pools, pool_addr);
                                    best.pools = new_pools;
                                    best.expected_out = leg_out;
                                };
                            } else if (!vector::contains(visited, &other)) {
                                let new_pools = push_leg(path_pools, pool_addr);
                                let new_visited = *visited;
                                vector::push_back(&mut new_visited, other);
                                dfs_path(
                                    other,
                                    target,
                                    leg_out,
                                    &new_pools,
                                    &new_visited,
                                    best,
                                    budget,
                                );
                            };
                        };
                    };
                    i = i + 1;
                };
                if (batch_n < PAGE) {
                    exhausted = true;
                } else {
                    offset = offset + batch_n;
                };
            };
        };
    }

    // ===== Search: closed cycle A → ... → A =====

    /// Find the best cycle closed at `anchor` carrying `seed_amount`
    /// of anchor through it. Cycle length in [3, MAX_CYCLE_LEN].
    /// `exclude_pool` is skipped entirely from candidates — pass
    /// `@0x0` for no exclusion, or a flash-borrow source address to
    /// prevent its reuse as a cycle leg (that pool is locked during
    /// flash and cannot host a swap).
    ///
    /// Wraps `find_best_cycle_internal` with a fresh DFS visit budget.
    /// Callers that want to share a budget across multiple cycle
    /// searches (e.g., `find_best_flash_triangle` iterating over
    /// borrow candidates) should call `_internal` directly with
    /// their own `&mut u64`.
    fun find_best_cycle(
        anchor: address,
        seed_amount: u64,
        exclude_pool: address,
    ): Path {
        let budget = DFS_VISIT_BUDGET;
        find_best_cycle_internal(anchor, seed_amount, exclude_pool, &mut budget)
    }

    fun find_best_cycle_internal(
        anchor: address,
        seed_amount: u64,
        exclude_pool: address,
        budget: &mut u64,
    ): Path {
        let best = empty_path();
        let visited = vector::empty<address>();
        vector::push_back(&mut visited, anchor);
        let pools = vector::empty<address>();
        dfs_cycle(
            anchor,
            anchor,
            seed_amount,
            exclude_pool,
            &pools,
            &visited,
            &mut best,
            budget,
        );
        best
    }

    fun dfs_cycle(
        current: address,
        anchor: address,
        amount_in_left: u64,
        exclude_pool: address,
        path_pools: &vector<address>,
        visited: &vector<address>,
        best: &mut Path,
        budget: &mut u64,
    ) {
        let depth = vector::length(path_pools);
        if (depth >= MAX_CYCLE_LEN || *budget == 0) return;

        // Lazy-paginated iteration — same pattern as `dfs_path`,
        // bounds fetch cost to the DFS budget.
        let offset = 0;
        let exhausted = false;
        while (!exhausted && *budget > 0) {
            let batch = pool_factory::pools_containing_asset(current, offset, PAGE);
            let batch_n = vector::length(&batch);
            if (batch_n == 0) {
                exhausted = true;
            } else {
                let i = 0;
                while (i < batch_n && *budget > 0) {
                    *budget = *budget - 1;
                    let pool_addr = *vector::borrow(&batch, i);
                    if (pool_addr != exclude_pool
                        && !vector::contains(path_pools, &pool_addr)) {
                        let (other, _a_to_b, leg_out) =
                            simulate_leg(pool_addr, current, amount_in_left);
                        if (leg_out > 0) {
                            if (other == anchor) {
                                // Closing leg — accept only if cycle has ≥ 3 legs.
                                if (depth + 1 >= 3 && leg_out > best.expected_out) {
                                    let new_pools = push_leg(path_pools, pool_addr);
                                    best.pools = new_pools;
                                    best.expected_out = leg_out;
                                };
                            } else if (!vector::contains(visited, &other)) {
                                let new_pools = push_leg(path_pools, pool_addr);
                                let new_visited = *visited;
                                vector::push_back(&mut new_visited, other);
                                dfs_cycle(
                                    other,
                                    anchor,
                                    leg_out,
                                    exclude_pool,
                                    &new_pools,
                                    &new_visited,
                                    best,
                                    budget,
                                );
                            };
                        };
                    };
                    i = i + 1;
                };
                if (batch_n < PAGE) {
                    exhausted = true;
                } else {
                    offset = offset + batch_n;
                };
            };
        };
    }

    // ===== Search: flash-triangle topology =====

    /// Iterate every pool containing `anchor` as a flash-borrow
    /// candidate; for each, verify the pool has enough anchor-side
    /// reserve to lend `amount`, then run a cycle search excluding
    /// that pool from cycle legs. Return the (borrow_pool, cycle)
    /// tuple with the highest net profit. `borrow_pool == @0x0`
    /// signals no valid topology — either the ecosystem lacks a
    /// disjoint pool, every candidate has insufficient reserve, or
    /// every candidate yields a loss after the flash fee.
    ///
    /// The reserve check mirrors `pool::flash_borrow`'s strict
    /// `amount < reserve_in` so unviable borrow sources fail fast
    /// at discovery instead of aborting mid-execution with an
    /// opaque `E_INSUFFICIENT_LIQUIDITY`.
    ///
    /// **Shared DFS visit budget.** The single `DFS_VISIT_BUDGET`
    /// is drawn down across ALL per-candidate cycle searches via
    /// `find_best_cycle_internal`. Without sharing, an attacker
    /// spawning many junk pools containing `anchor` would
    /// multiply the worst-case simulate_leg count by the candidate
    /// count, re-introducing gas-griefing DoS even with per-search
    /// DFS budgets. With shared budget, total work is bounded at
    /// O(DFS_VISIT_BUDGET) regardless of candidate count. The
    /// trade-off is that early-iteration candidates with
    /// unproductive DFS can starve later candidates of budget; in
    /// legitimate ecosystems the per-candidate cost is modest and
    /// the shared budget distributes naturally.
    fun find_best_flash_triangle(
        anchor: address,
        amount: u64,
    ): FlashTriangle {
        let best = FlashTriangle {
            borrow_pool: @0x0,
            cycle: empty_path(),
        };
        let best_net: u64 = 0;

        let flash_fee = pool::compute_flash_fee(amount);
        let required = amount + flash_fee;

        // Single budget shared across every cycle search.
        let budget = DFS_VISIT_BUDGET;

        // Lazy-paginated iteration over borrow candidates — same
        // pattern as `dfs_path` / `dfs_cycle`. Without this, a
        // densely-spammed `asset_index[anchor]` would force an
        // upfront allocation of the full bucket regardless of
        // budget, re-introducing the griefing surface fixed for
        // the DFS layer.
        //
        // Budget is decremented per outer-loop iteration BEFORE the
        // liquidity pre-check, so junk pools that fail the reserve
        // check still consume budget. Without this, an attacker
        // seeding many minimum-liquidity pools paired with the
        // anchor could force unbounded storage reads in the outer
        // loop (pool_tokens + reserves per candidate) even when no
        // `find_best_cycle_internal` call ever executes to draw
        // down budget. Fixes Claude R3 MEDIUM-1.
        let offset = 0;
        let exhausted = false;
        while (!exhausted && budget > 0) {
            let batch = pool_factory::pools_containing_asset(anchor, offset, PAGE);
            let batch_n = vector::length(&batch);
            if (batch_n == 0) {
                exhausted = true;
            } else {
                let i = 0;
                while (i < batch_n && budget > 0) {
                    budget = budget - 1;
                    let borrow_pool = *vector::borrow(&batch, i);

                    // Liquidity pre-check: does this pool actually
                    // have enough anchor to lend `amount`? Mirrors
                    // `pool::flash_borrow`'s strict check. Defensive
                    // `else if` on the b-side guards against a
                    // hypothetical factory bug that would allow an
                    // asset_index entry to reference a pool not
                    // actually containing the anchor.
                    let (ma, mb) = pool::pool_tokens(borrow_pool);
                    let ma_addr = object::object_address(&ma);
                    let mb_addr = object::object_address(&mb);
                    let (ra, rb) = pool::reserves(borrow_pool);
                    let anchor_reserve = if (anchor == ma_addr) {
                        ra
                    } else if (anchor == mb_addr) {
                        rb
                    } else {
                        0
                    };

                    if (anchor_reserve > amount) {
                        let cycle = find_best_cycle_internal(
                            anchor,
                            amount,
                            borrow_pool,
                            &mut budget,
                        );
                        if (cycle.expected_out > required) {
                            let net = cycle.expected_out - required;
                            if (net > best_net) {
                                best_net = net;
                                best.borrow_pool = borrow_pool;
                                best.cycle = cycle;
                            };
                        };
                    };
                    i = i + 1;
                };
                if (batch_n < PAGE) {
                    exhausted = true;
                } else {
                    offset = offset + batch_n;
                };
            };
        };
        best
    }

    // ===== Execution (internal) =====

    /// Chain-execute a pool sequence: each leg feeds its output into
    /// the next leg's input. Direction is inferred automatically by
    /// `pool::swap` from the FA's metadata. Per-leg `min_out = 0`;
    /// the overall output check is enforced by the caller.
    fun execute_pool_list(
        swapper: address,
        pool_path: &vector<address>,
        fa_in: FungibleAsset,
    ): FungibleAsset {
        let fa = fa_in;
        let n = vector::length(pool_path);
        let i = 0;
        while (i < n) {
            let pool_addr = *vector::borrow(pool_path, i);
            fa = pool::swap(pool_addr, swapper, fa, 0);
            i = i + 1;
        };
        fa
    }

    fun execute_path(
        swapper: address,
        path: &Path,
        fa_in: FungibleAsset,
    ): FungibleAsset {
        execute_pool_list(swapper, &path.pools, fa_in)
    }

    // ===== Composable: raw pool-path execution (no treasury cut) =====

    /// Execute a pre-computed multi-hop path through the specified
    /// pools. Each leg pays its 1 bps LP fee via `pool::swap`.
    /// Direction at each leg is inferred from the FA's metadata —
    /// the caller provides only the pool sequence.
    ///
    /// Service charge rule (applied uniformly across the module): if
    /// the execution produces output exceeding its baseline, 10% of
    /// the surplus goes to treasury. Baseline is computed as:
    ///
    ///   • Cycle (end_asset == start_asset): baseline = amount_in.
    ///     Surplus is the cycle profit.
    ///   • Linear (end_asset != start_asset): baseline = direct pool
    ///     output for (start, end) if such a pool exists; otherwise
    ///     baseline = 0. Surplus is the improvement over the direct
    ///     hop.
    ///
    /// If `output <= baseline` (no value added) the charge is zero —
    /// the caller receives the full output. If no direct pool exists
    /// for a linear path, baseline = 0 and the charge is also zero
    /// because there is no measurable improvement to charge against.
    public fun execute_path_compose(
        swapper: address,
        pool_path: vector<address>,
        fa_in: FungibleAsset,
        min_out: u64,
    ): FungibleAsset {
        let path_len = vector::length(&pool_path);
        assert!(path_len > 0, E_ZERO);

        // Enforce pool uniqueness in the caller-supplied path. DFS
        // paths are unique by construction, but external callers
        // (Move modules building paths programmatically) could pass
        // a sequence that visits the same pool twice, breaking the
        // simulation-to-execution determinism invariant and
        // producing unexpected reserve mutations. O(n²) in path
        // length; bounded by MAX_HOPS so max 6 comparisons.
        let i = 0;
        while (i < path_len) {
            let j = i + 1;
            while (j < path_len) {
                assert!(
                    *vector::borrow(&pool_path, i) != *vector::borrow(&pool_path, j),
                    E_WRONG_POOL,
                );
                j = j + 1;
            };
            i = i + 1;
        };

        let in_metadata_obj = fungible_asset::asset_metadata(&fa_in);
        let in_addr = object::object_address(&in_metadata_obj);
        let amount_in = fungible_asset::amount(&fa_in);
        assert!(amount_in > 0, E_ZERO);

        // Pre-pass: trace the path's end asset (validates the path
        // at the same time — any pool that doesn't host the current
        // side sets end_asset to @0x0).
        let end_asset = trace_path_end(&pool_path, in_addr);
        assert!(end_asset != @0x0, E_WRONG_POOL);

        let is_cycle = end_asset == in_addr;
        let baseline = if (is_cycle) {
            amount_in
        } else {
            compute_direct_baseline(in_addr, end_asset, amount_in)
        };

        let fa_out = execute_pool_list(swapper, &pool_path, fa_in);
        let actual_out = fungible_asset::amount(&fa_out);
        assert!(actual_out >= min_out, E_SLIPPAGE);

        let surplus = if (baseline > 0 && actual_out > baseline) {
            actual_out - baseline
        } else {
            0
        };
        let treasury_cut =
            (((surplus as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);

        if (treasury_cut > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_out, treasury_cut);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        let caller_received = fungible_asset::amount(&fa_out);

        event::emit(PathExecuted {
            swapper,
            metadata_in: in_addr,
            metadata_out: end_asset,
            amount_in,
            baseline,
            actual_out,
            surplus,
            treasury_cut,
            caller_received,
            hops: vector::length(&pool_path),
            is_cycle,
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Composable: smart-routed swap =====

    /// Smart-routed swap: find the best path from the input asset
    /// to `metadata_out` and execute it. Caller receives
    /// `actual_out - treasury_cut` as the returned FA; treasury
    /// receives 10% of the improvement over the canonical
    /// direct-hop baseline via internal deposit.
    ///
    /// The direct baseline is derived via
    /// `pool_factory::canonical_pool_address_of(in, out)` — an O(1)
    /// deterministic lookup. If no canonical direct pool exists,
    /// baseline is 0 and no service charge applies (Darbitex is not
    /// adding measurable value when it is the only available route).
    ///
    /// Aborts on slippage below `min_out`, zero input, or no route
    /// found. No deadline (entry wrapper enforces that).
    public fun swap_compose(
        swapper: address,
        metadata_out: Object<Metadata>,
        fa_in: FungibleAsset,
        min_out: u64,
    ): FungibleAsset {
        let in_metadata_obj = fungible_asset::asset_metadata(&fa_in);
        let in_addr = object::object_address(&in_metadata_obj);
        let out_addr = object::object_address(&metadata_out);
        let amount_in = fungible_asset::amount(&fa_in);
        assert!(amount_in > 0, E_ZERO);
        assert!(in_addr != out_addr, E_WRONG_POOL);

        // Canonical direct-hop baseline via deterministic address
        // derivation. If no direct pool exists, baseline = 0 and the
        // fallback path is whatever the DFS search returned.
        let direct_addr = pool_factory::canonical_pool_address_of(in_addr, out_addr);
        let direct_exists = pool::pool_exists(direct_addr);
        let direct_out = if (direct_exists) {
            let (ma, _mb) = pool::pool_tokens(direct_addr);
            let (ra, rb) = pool::reserves(direct_addr);
            let (r_in, r_out) = if (in_addr == object::object_address(&ma)) {
                (ra, rb)
            } else {
                (rb, ra)
            };
            pool::compute_amount_out(r_in, r_out, amount_in)
        } else {
            0
        };

        // Search the full graph for a better multi-hop route.
        let best = find_best_path(in_addr, out_addr, amount_in);

        // Choose the yield-maximizing option. If best DFS beats
        // direct, use it; else fall back to the direct pool path
        // (assuming the canonical direct pool exists).
        let chosen = if (best.expected_out > direct_out) {
            best
        } else if (direct_exists) {
            let pools = vector::empty<address>();
            vector::push_back(&mut pools, direct_addr);
            Path { pools, expected_out: direct_out }
        } else {
            // No direct pool, DFS found nothing. `best` is empty;
            // the non-zero check below will abort.
            best
        };

        // Reject empty-path / zero-output scenarios explicitly. The
        // combination of `expected_out > 0` and the existing slippage
        // floor catches three cases: (a) no route found at all
        // (empty path → 0), (b) dust-size input where final leg
        // produces 0 output, (c) standard slippage below `min_out`.
        // Prevents silent no-op where `min_out = 0` callers would
        // otherwise receive their input FA back unchanged with an
        // event misattributing the swap as succeeded.
        assert!(chosen.expected_out > 0, E_SLIPPAGE);
        assert!(chosen.expected_out >= min_out, E_SLIPPAGE);

        let fa_out = execute_path(swapper, &chosen, fa_in);
        let actual_out = fungible_asset::amount(&fa_out);
        assert!(actual_out >= min_out, E_SLIPPAGE);

        // Service charge applies only when a canonical direct pool
        // EXISTS as a baseline. If no direct pool exists (`direct_out
        // == 0`), Darbitex is the only available route — philosophy
        // rule "no baseline = no charge" kicks in. This guard must
        // match `execute_path_compose`'s `baseline > 0 && ...` check
        // for uniform behavior across the compose layer; without it,
        // zero-baseline scenarios would silently tax 10% of the full
        // swap output.
        let improvement = if (direct_out > 0 && actual_out > direct_out) {
            actual_out - direct_out
        } else {
            0
        };
        let treasury_cut =
            (((improvement as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);

        if (treasury_cut > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_out, treasury_cut);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        let caller_received = fungible_asset::amount(&fa_out);

        event::emit(RoutedSwap {
            swapper,
            metadata_in: in_addr,
            metadata_out: out_addr,
            amount_in,
            direct_out,
            routed_out: actual_out,
            hops: vector::length(&chosen.pools),
            improvement,
            treasury_cut,
            caller_received,
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Composable: real-capital cycle closure =====

    /// Close a triangular cycle using the provided `fa_seed` as
    /// capital. The anchor asset is inferred from the seed's
    /// metadata. Module searches for the best cycle of length ≥ 3
    /// that starts and ends at the anchor, executes it, and splits
    /// gross profit 10% to treasury (deposited internally) / 90% to
    /// caller (returned as FA).
    ///
    /// `min_net_profit` is the caller's minimum take-home AFTER the
    /// treasury cut — not the gross profit. If no cycle clears this
    /// floor, the TX aborts and the seed returns via rollback.
    public fun close_triangle_compose(
        caller: address,
        fa_seed: FungibleAsset,
        min_net_profit: u64,
    ): FungibleAsset {
        let anchor_metadata_obj = fungible_asset::asset_metadata(&fa_seed);
        let anchor_addr = object::object_address(&anchor_metadata_obj);
        let seed_amount = fungible_asset::amount(&fa_seed);
        assert!(seed_amount > 0, E_ZERO);

        let cycle = find_best_cycle(anchor_addr, seed_amount, @0x0);
        assert!(cycle.expected_out > 0, E_NO_CYCLE);

        // Pre-check using simulated cycle output. The net caller cut
        // after treasury split must meet the floor.
        assert!(cycle.expected_out >= seed_amount, E_MIN_PROFIT);
        let expected_gross = cycle.expected_out - seed_amount;
        let expected_treasury =
            (((expected_gross as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);
        let expected_net = expected_gross - expected_treasury;
        assert!(expected_net >= min_net_profit, E_MIN_PROFIT);

        let fa_out = execute_path(caller, &cycle, fa_seed);
        let actual_out = fungible_asset::amount(&fa_out);

        // Post-execution sanity: deterministic integer math implies
        // actual_out == cycle.expected_out, but re-verifying the
        // invariant here is a cheap safety net against future
        // refactors of the simulation / execution paths.
        assert!(actual_out >= seed_amount, E_MIN_PROFIT);
        let profit = actual_out - seed_amount;
        let treasury_cut =
            (((profit as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);
        let net_to_caller = profit - treasury_cut;
        assert!(net_to_caller >= min_net_profit, E_MIN_PROFIT);

        if (treasury_cut > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_out, treasury_cut);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        let caller_received = fungible_asset::amount(&fa_out);

        event::emit(TriangleClosed {
            caller,
            anchor: anchor_addr,
            seed: seed_amount,
            gross_out: actual_out,
            profit,
            treasury_cut,
            caller_received,
            cycle_hops: vector::length(&cycle.pools),
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Composable: flash-loan cycle closure (zero capital) =====

    /// Zero-capital cycle closure via internal flash loan. Module
    /// finds a (borrow_pool, cycle) topology where the borrow pool
    /// is disjoint from cycle legs, flash-borrows `amount` of
    /// `anchor_metadata` from the borrow pool, executes the cycle,
    /// repays the flash, and returns the caller's profit share as
    /// the returned FA. Treasury 10% is deposited internally.
    ///
    /// `min_net_profit` is the caller's minimum take-home AFTER the
    /// treasury cut and the flash-loan repayment (principal + flash
    /// fee) — not the gross cycle output.
    ///
    /// Returns a FA whose amount is the caller's net share (the
    /// principal + flash fee have already been repaid to the borrow
    /// pool before return).
    ///
    /// This path requires an ecosystem with at least one pool that
    /// contains the anchor AND is disjoint from the cycle. For a
    /// 3-pool canonical ecosystem where every pool is in the cycle
    /// the search returns no topology and the function aborts with
    /// `E_NO_CYCLE`; a 4+ pool ecosystem (e.g., adding APT/stAPT
    /// or APT/USD1 alongside the core three) activates it.
    public fun close_triangle_flash_compose(
        caller: address,
        anchor_metadata: Object<Metadata>,
        amount: u64,
        min_net_profit: u64,
    ): FungibleAsset {
        assert!(amount > 0, E_ZERO);
        let anchor_addr = object::object_address(&anchor_metadata);

        let flash = find_best_flash_triangle(anchor_addr, amount);
        assert!(flash.borrow_pool != @0x0, E_NO_CYCLE);

        let flash_fee = pool::compute_flash_fee(amount);
        let required = amount + flash_fee;

        // Pre-check: net caller take-home after flash repay + treasury
        // cut must meet the floor.
        assert!(flash.cycle.expected_out >= required, E_MIN_PROFIT);
        let expected_gross = flash.cycle.expected_out - required;
        let expected_treasury =
            (((expected_gross as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);
        let expected_net = expected_gross - expected_treasury;
        assert!(expected_net >= min_net_profit, E_MIN_PROFIT);

        // Flash-borrow the anchor. The hot-potato FlashReceipt must
        // be consumed by flash_repay before this function returns —
        // the Move type system enforces this statically.
        let (fa_borrowed, receipt) =
            pool::flash_borrow(flash.borrow_pool, anchor_metadata, amount);

        let fa_out = execute_path(caller, &flash.cycle, fa_borrowed);
        let actual_out = fungible_asset::amount(&fa_out);

        // Post-execution sanity. Deterministic math implies
        // actual_out == flash.cycle.expected_out; the re-check guards
        // against future refactors and keeps the repay extract safe.
        assert!(actual_out >= required, E_MIN_PROFIT);

        // Split the cycle output: repayment to the flash source,
        // profit to caller + treasury.
        let fa_repay = fungible_asset::extract(&mut fa_out, required);
        pool::flash_repay(flash.borrow_pool, fa_repay, receipt);

        let profit = actual_out - required;
        let treasury_cut =
            (((profit as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64);
        let net_to_caller = profit - treasury_cut;
        assert!(net_to_caller >= min_net_profit, E_MIN_PROFIT);

        if (treasury_cut > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_out, treasury_cut);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        let caller_received = fungible_asset::amount(&fa_out);

        event::emit(FlashTriangleClosed {
            caller,
            anchor: anchor_addr,
            borrow_pool: flash.borrow_pool,
            amount,
            flash_fee,
            gross_out: actual_out,
            profit,
            treasury_cut,
            caller_received,
            cycle_hops: vector::length(&flash.cycle.pools),
            timestamp: timestamp::now_seconds(),
        });

        fa_out
    }

    // ===== Entry wrappers =====

    /// Smart-routed swap from a user's primary store. Thin wrapper
    /// around `swap_compose` with deadline + store integration.
    /// Takes `metadata_in` / `metadata_out` directly — the canonical
    /// direct pool is derived internally, no pool address needed
    /// from the caller.
    public entry fun swap_entry(
        user: &signer,
        metadata_in: Object<Metadata>,
        metadata_out: Object<Metadata>,
        amount_in: u64,
        min_out: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let user_addr = signer::address_of(user);
        let fa_in = primary_fungible_store::withdraw(user, metadata_in, amount_in);
        let fa_out = swap_compose(user_addr, metadata_out, fa_in, min_out);
        primary_fungible_store::deposit(user_addr, fa_out);
    }

    /// Real-capital cycle closure from a caller's primary store.
    /// `min_net_profit` is the caller's take-home floor AFTER the
    /// 10% treasury cut, not gross.
    public entry fun close_triangle(
        caller: &signer,
        anchor_metadata: Object<Metadata>,
        seed_amount: u64,
        min_net_profit: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let caller_addr = signer::address_of(caller);
        let fa_seed = primary_fungible_store::withdraw(caller, anchor_metadata, seed_amount);
        let fa_out = close_triangle_compose(caller_addr, fa_seed, min_net_profit);
        primary_fungible_store::deposit(caller_addr, fa_out);
    }

    /// Zero-capital flash cycle closure. Caller pays only gas;
    /// profit is deposited to their primary store. `min_net_profit`
    /// is the caller's take-home floor AFTER flash repay and the
    /// 10% treasury cut.
    public entry fun close_triangle_flash(
        caller: &signer,
        anchor_metadata: Object<Metadata>,
        amount: u64,
        min_net_profit: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        let caller_addr = signer::address_of(caller);
        let fa_out = close_triangle_flash_compose(caller_addr, anchor_metadata, amount, min_net_profit);
        primary_fungible_store::deposit(caller_addr, fa_out);
    }

    // ===== Quote views (off-chain path discovery) =====

    // Quote the best linear path from `from` to `to` carrying
    // `amount_in`. Returns (pools, expected_out) of the
    // yield-maximizing path up to MAX_HOPS. expected_out = 0 means
    // no path exists.
    #[view]
    public fun quote_best_path(
        from: address,
        to: address,
        amount_in: u64,
    ): (vector<address>, u64) {
        let best = find_best_path(from, to, amount_in);
        (best.pools, best.expected_out)
    }

    // Quote the best closed cycle at `anchor` carrying `seed_amount`.
    // Returns (pools, expected_out) of the cycle with the highest
    // gross output. expected_out = 0 means no cycle exists.
    #[view]
    public fun quote_best_cycle(
        anchor: address,
        seed_amount: u64,
    ): (vector<address>, u64) {
        let best = find_best_cycle(anchor, seed_amount, @0x0);
        (best.pools, best.expected_out)
    }

    // Quote the best flash-triangle topology at `anchor` for a
    // borrow of `amount`. Returns (borrow_pool, pools,
    // expected_out). borrow_pool == @0x0 means no valid topology
    // was found.
    #[view]
    public fun quote_best_flash_triangle(
        anchor: address,
        amount: u64,
    ): (address, vector<address>, u64) {
        let flash = find_best_flash_triangle(anchor, amount);
        (
            flash.borrow_pool,
            flash.cycle.pools,
            flash.cycle.expected_out,
        )
    }

    // Quote an arbitrary pre-computed path: simulate feeding
    // `amount_in` of `from` through each pool in `pool_path`
    // sequentially, returning the final output. Returns 0 if the
    // path is invalid (a pool in the sequence does not contain the
    // current asset).
    #[view]
    public fun quote_path(
        pool_path: vector<address>,
        from: address,
        amount_in: u64,
    ): u64 {
        let current = from;
        let amt = amount_in;
        let n = vector::length(&pool_path);
        let i = 0;
        while (i < n) {
            let pool_addr = *vector::borrow(&pool_path, i);
            let (other, _, leg_out) = simulate_leg(pool_addr, current, amt);
            if (leg_out == 0) return 0;
            current = other;
            amt = leg_out;
            i = i + 1;
        };
        amt
    }
}
```

---

**End of audit source bundle.**

For review format, threat model, and specific review questions see `AUDIT-FINAL-SUBMISSION.md`.
