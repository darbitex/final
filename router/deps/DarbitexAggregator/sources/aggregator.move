/// Darbitex Aggregator — user-facing swap routing across Darbitex + external DEXes.
///
/// Zero flash-loan / arb surface by design. Arbitrage functionality stays in
/// the original adapter satellites (hyperion_adapter, liquidswap_adapter).
///
/// Exposes a small, cheap set of #[view] quotes and a small set of entry
/// functions that each route to exactly one venue. The frontend is responsible
/// for enumerating Hyperion fee tiers, picking the best net output across
/// venues, and calling the matching entry. This keeps the module simple and
/// robust (no on-chain abort-recovery loops), and avoids the LiquidSwap
/// `<X, Y>` generic dispatch problem entirely.

module darbitex_aggregator::aggregator {
    use std::signer;
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool as darbitex_pool;
    use darbitex::router as darbitex_router;
    use hyperion_adapter::adapter as hyperion;
    use liquidswap_adapter::darbitex_liquidswap as liquidswap;
    use dex_contract::pool_v3;
    use cellana::router as cellana_router;
    use cellana::liquidity_pool as cellana_pool;

    // ===== Errors =====

    const E_ZERO_AMOUNT: u64 = 1;
    const E_DEADLINE: u64 = 2;

    // ===== Views =====

    #[view]
    // Quote Darbitex pool. Single-pool view, no enumeration.
    public fun quote_darbitex(
        pool_addr: address,
        amount_in: u64,
        a_to_b: bool,
    ): u64 {
        darbitex_pool::get_amount_out(pool_addr, amount_in, a_to_b)
    }

    #[view]
    // Quote a specific Hyperion CLMM pool. Caller supplies the pool object,
    // typically obtained by enumerating tiers via
    // hyperion_adapter::adapter::get_pool off-chain.
    public fun quote_hyperion(
        pool: Object<pool_v3::LiquidityPoolV3>,
        token_in: Object<Metadata>,
        amount_in: u64,
    ): u64 {
        let (amount_out, _fee) = hyperion::get_amount_out(pool, token_in, amount_in);
        amount_out
    }

    #[view]
    // Quote LiquidSwap V0 stable curve. Requires compile-time type pair.
    // Frontend calls per-pair with hardcoded CoinType generics.
    public fun quote_liquidswap_stable<X, Y>(amount_in: u64): u64 {
        liquidswap::get_amount_out_stable<X, Y>(amount_in)
    }

    // ===== Hyperion pool discovery views =====
    // These wrap hyperion_adapter::adapter::{pool_exists, get_pool, reserves}
    // as #[view] so the frontend can cheap-query them. The underlying adapter
    // functions are plain public fun (not #[view]-annotated).

    #[view]
    public fun hyperion_pool_exists(
        meta_a: Object<Metadata>,
        meta_b: Object<Metadata>,
        fee_tier: u8,
    ): bool {
        hyperion::pool_exists(meta_a, meta_b, fee_tier)
    }

    #[view]
    public fun hyperion_get_pool(
        meta_a: Object<Metadata>,
        meta_b: Object<Metadata>,
        fee_tier: u8,
    ): address {
        object::object_address(&hyperion::get_pool(meta_a, meta_b, fee_tier))
    }

    #[view]
    public fun hyperion_reserves(
        pool: Object<pool_v3::LiquidityPoolV3>,
    ): (u64, u64) {
        hyperion::reserves(pool)
    }

    // ===== Cellana views =====
    // Cellana uses a dual-curve (stable/volatile) AMM with FA-native primitives.
    // The frontend is expected to try both is_stable values for a pair and
    // pick whichever has better output, since both can coexist per pair.

    #[view]
    // Quote a Cellana pool for the given direction + curve. Returns only the
    // net amount_out; Cellana's underlying get_amount_out returns (out, fee)
    // and the fee is dropped here.
    public fun quote_cellana(
        metadata_in: Object<Metadata>,
        metadata_out: Object<Metadata>,
        amount_in: u64,
        is_stable: bool,
    ): u64 {
        let (amount_out, _fee) = cellana_router::get_amount_out(
            amount_in,
            metadata_in,
            metadata_out,
            is_stable,
        );
        amount_out
    }

    #[view]
    // Cellana derives the pool address from (meta_a, meta_b, is_stable) via
    // its liquidity_pool object. Returned as plain address for cleaner
    // frontend consumption (no Object<T> unwrap needed).
    public fun cellana_pool_address(
        meta_a: Object<Metadata>,
        meta_b: Object<Metadata>,
        is_stable: bool,
    ): address {
        object::object_address(&cellana_pool::liquidity_pool(meta_a, meta_b, is_stable))
    }

    // ===== Entries =====

    /// Swap via Darbitex. Thin pass-through to `router::swap_with_deadline`.
    /// Kept here so the frontend has a single namespace
    /// (`darbitex_aggregator::aggregator::*`) for all venues.
    public entry fun swap_darbitex(
        caller: &signer,
        pool_addr: address,
        metadata_in: Object<Metadata>,
        amount_in: u64,
        min_out: u64,
        deadline: u64,
    ) {
        darbitex_router::swap_with_deadline(
            caller,
            pool_addr,
            metadata_in,
            amount_in,
            min_out,
            deadline,
        );
    }

    /// Swap via Hyperion CLMM pool. Withdraws FA from caller, routes through
    /// the adapter's composable `swap`, deposits output back.
    public entry fun swap_hyperion(
        caller: &signer,
        pool: Object<pool_v3::LiquidityPoolV3>,
        metadata_in: Object<Metadata>,
        a_to_b: bool,
        amount_in: u64,
        min_out: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() <= deadline, E_DEADLINE);
        assert!(amount_in > 0, E_ZERO_AMOUNT);
        let caller_addr = signer::address_of(caller);
        let fa_in = primary_fungible_store::withdraw(caller, metadata_in, amount_in);
        let fa_out = hyperion::swap(pool, a_to_b, fa_in, min_out);
        primary_fungible_store::deposit(caller_addr, fa_out);
    }

    /// Swap via LiquidSwap V0 stable curve. Thin pass-through to the existing
    /// liquidswap adapter entry. Type pair is fixed at compile time.
    public entry fun swap_liquidswap_stable<X, Y>(
        caller: &signer,
        metadata_in: Object<Metadata>,
        amount_in: u64,
        min_out: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() <= deadline, E_DEADLINE);
        liquidswap::swap_stable<X, Y>(caller, metadata_in, amount_in, min_out);
    }

    /// Swap via Cellana. Withdraws FA from caller, routes through Cellana's
    /// composable router::swap primitive, deposits output back. Supports both
    /// stable and volatile curves via the is_stable flag.
    public entry fun swap_cellana(
        caller: &signer,
        metadata_in: Object<Metadata>,
        metadata_out: Object<Metadata>,
        is_stable: bool,
        amount_in: u64,
        min_out: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() <= deadline, E_DEADLINE);
        assert!(amount_in > 0, E_ZERO_AMOUNT);
        let caller_addr = signer::address_of(caller);
        let fa_in = primary_fungible_store::withdraw(caller, metadata_in, amount_in);
        let fa_out = cellana_router::swap(fa_in, min_out, metadata_out, is_stable);
        primary_fungible_store::deposit(caller_addr, fa_out);
    }
}
