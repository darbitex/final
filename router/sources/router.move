/// Darbitex Router v0.1 — minimal stub for dep-resolution smoke test.
/// The full router logic will be added once Move.toml is known to resolve.
module darbitex_router::router {
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::object::Object;

    use darbitex::arbitrage;
    use thala_adapter::adapter as thala;
    use darbitex_aggregator::aggregator;

    /// Smoke: can we see all four venues from one module at compile time?
    #[view]
    public fun stub_quote_all(
        metadata_in: Object<Metadata>,
        metadata_out: Object<Metadata>,
        amount_in: u64,
        thala_pool: address,
        hyperion_pool: Object<dex_contract::pool_v3::LiquidityPoolV3>,
    ): (u64, u64, u64, u64, u64) {
        let meta_in_addr = aptos_framework::object::object_address(&metadata_in);
        let meta_out_addr = aptos_framework::object::object_address(&metadata_out);

        let (_, darbitex_out) = arbitrage::quote_best_path(
            meta_in_addr,
            meta_out_addr,
            amount_in,
        );
        let thala_out = thala::quote(thala_pool, meta_in_addr, meta_out_addr, amount_in);
        let hyperion_out = aggregator::quote_hyperion(hyperion_pool, metadata_in, amount_in);
        let cellana_vol = aggregator::quote_cellana(metadata_in, metadata_out, amount_in, false);
        let cellana_stab = aggregator::quote_cellana(metadata_in, metadata_out, amount_in, true);
        (darbitex_out, thala_out, hyperion_out, cellana_vol, cellana_stab)
    }
}
