/// Interface stub for the HyperionAdapter satellite. Only the `swap`
/// compose function is needed by flashbot — the full adapter exposes
/// pool_exists/get_pool/reserves as well, but the flashbot takes the
/// pool address from the caller and doesn't look them up on-chain.
module hyperion_adapter::adapter {
    use aptos_framework::fungible_asset::FungibleAsset;
    use aptos_framework::object::Object;
    use dex_contract::pool_v3::LiquidityPoolV3;

    /// FA-in / FA-out compose-style swap. `a_to_b = true` swaps the
    /// sorted-A side for the sorted-B side of the pool; the input FA
    /// must match the expected side. `min_out = 0` disables per-leg
    /// slippage; the flashbot enforces profit at the cycle level.
    public fun swap(
        _pool: Object<LiquidityPoolV3>,
        _a_to_b: bool,
        _fa_in: FungibleAsset,
        _min_out: u64,
    ): FungibleAsset {
        abort 0
    }
}
