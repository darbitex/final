/// ThalaSwap V2 adapter for Darbitex aggregator.
///
/// Thin primitive-only wrapper around Thala's `pool::swap_exact_in_*`.
/// Frontend hands this package plain addresses + u64s; the adapter
/// does the `Object<Pool>`, `Object<Metadata>`, and `Option<address>`
/// conversions that the Aptos TS SDK can't encode cleanly from the
/// browser side (see `feedback_pure_frontend_venue_risk.md`).
///
/// v0.1.0 supports weighted and stable pools. Metastable variants
/// exist on-chain but are deferred — add them when a metastable pair
/// actually matters for aggregated routing.

module thala_adapter::adapter {
    use std::option;
    use std::signer;
    use std::vector;

    use aptos_framework::fungible_asset::{Self, FungibleAsset, Metadata};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use thalaswap_v2::pool::{Self, Pool};

    // ===== Errors =====

    const E_DEADLINE: u64 = 1;
    const E_MIN_OUT: u64 = 2;
    const E_UNSUPPORTED_POOL: u64 = 3;
    const E_ZERO_AMOUNT: u64 = 4;

    // ===== Constants (mirror of thalaswap_v2::pool private consts) =====
    // Metastable const (102) is NOT declared in Thala's interface; verified
    // 2026-04-14 by scanning all 470 live pools and finding exactly 1 with
    // pool_type=102 (`0xce9e3b2437fd2c...`).

    const POOL_TYPE_STABLE: u8 = 100;
    const POOL_TYPE_WEIGHTED: u8 = 101;
    const POOL_TYPE_METASTABLE: u8 = 102;

    // ===== Views =====

    // Quote `amount_in` of `meta_in` → `meta_out` through a specific
    // Thala pool. Dispatches by pool type across weighted / stable /
    // metastable. Returns 0 for any unknown pool type (forward-compat
    // for a hypothetical future Thala curve).
    #[view]
    public fun quote(
        pool_addr: address,
        meta_in: address,
        meta_out: address,
        amount_in: u64,
    ): u64 {
        let pool_obj = object::address_to_object<Pool>(pool_addr);
        let meta_in_obj = object::address_to_object<Metadata>(meta_in);
        let meta_out_obj = object::address_to_object<Metadata>(meta_out);
        let pt = pool::pool_type(pool_obj);
        let preview = if (pt == POOL_TYPE_WEIGHTED) {
            pool::preview_swap_exact_in_weighted(
                pool_obj, meta_in_obj, meta_out_obj, amount_in, option::none<address>(),
            )
        } else if (pt == POOL_TYPE_STABLE) {
            pool::preview_swap_exact_in_stable(
                pool_obj, meta_in_obj, meta_out_obj, amount_in, option::none<address>(),
            )
        } else if (pt == POOL_TYPE_METASTABLE) {
            pool::preview_swap_exact_in_metastable(
                pool_obj, meta_in_obj, meta_out_obj, amount_in, option::none<address>(),
            )
        } else {
            return 0
        };
        let (_, _, amount_out, _, _, _, _, _, _, _) = pool::swap_preview_info(preview);
        amount_out
    }

    // Pool type discriminator: 100 = stable, 101 = weighted, other = unsupported here.
    #[view]
    public fun pool_type_of(pool_addr: address): u8 {
        pool::pool_type(object::address_to_object<Pool>(pool_addr))
    }

    // Flat list of asset metadata addresses in a pool, preserving on-chain order.
    #[view]
    public fun pool_assets(pool_addr: address): vector<address> {
        let pool_obj = object::address_to_object<Pool>(pool_addr);
        let metas = pool::pool_assets_metadata(pool_obj);
        let out = vector::empty<address>();
        let i = 0;
        let n = vector::length(&metas);
        while (i < n) {
            vector::push_back(&mut out, object::object_address(vector::borrow(&metas, i)));
            i = i + 1;
        };
        out
    }

    // ===== Composable primitive =====

    /// Take a `FungibleAsset` in, return a `FungibleAsset` out. Caller
    /// handles withdraw/deposit. Aborts if the quote after slippage
    /// would underflow `min_out`, or if the pool type is unsupported.
    /// `user` is passed through to Thala for its trader-fee registry.
    public fun swap(
        user: &signer,
        pool_obj: Object<Pool>,
        fa_in: FungibleAsset,
        meta_out: Object<Metadata>,
        min_out: u64,
    ): FungibleAsset {
        assert!(fungible_asset::amount(&fa_in) > 0, E_ZERO_AMOUNT);
        let pt = pool::pool_type(pool_obj);
        let fa_out = if (pt == POOL_TYPE_WEIGHTED) {
            pool::swap_exact_in_weighted(user, pool_obj, fa_in, meta_out)
        } else if (pt == POOL_TYPE_STABLE) {
            pool::swap_exact_in_stable(user, pool_obj, fa_in, meta_out)
        } else if (pt == POOL_TYPE_METASTABLE) {
            pool::swap_exact_in_metastable(user, pool_obj, fa_in, meta_out)
        } else {
            abort E_UNSUPPORTED_POOL
        };
        assert!(fungible_asset::amount(&fa_out) >= min_out, E_MIN_OUT);
        fa_out
    }

    // ===== User-facing entry wrapper =====

    /// Single-hop Thala swap. Frontend passes pure addresses + u64s.
    /// Withdraws from the user's primary store, runs the swap, deposits
    /// the output back to the user. Deadline in unix seconds.
    public entry fun swap_entry(
        user: &signer,
        pool_addr: address,
        meta_in: address,
        meta_out: address,
        amount_in: u64,
        min_out: u64,
        deadline_unix: u64,
    ) {
        assert!(timestamp::now_seconds() <= deadline_unix, E_DEADLINE);
        let pool_obj = object::address_to_object<Pool>(pool_addr);
        let meta_in_obj = object::address_to_object<Metadata>(meta_in);
        let meta_out_obj = object::address_to_object<Metadata>(meta_out);
        let fa_in = primary_fungible_store::withdraw(user, meta_in_obj, amount_in);
        let fa_out = swap(user, pool_obj, fa_in, meta_out_obj, min_out);
        primary_fungible_store::deposit(signer::address_of(user), fa_out);
    }
}
