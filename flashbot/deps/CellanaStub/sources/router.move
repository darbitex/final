/// Interface stub for `cellana::router::swap`. Cellana runs both
/// stable and volatile curves per pair — the caller picks via
/// `is_stable`. The router internally looks up
/// `liquidity_pool(from_token, to_token, is_stable)` and routes
/// through it; flashbot never holds the Pool object directly.
///
/// On-chain signature (verified 2026-04-15 via REST
/// /accounts/0x4bf51972.../module/router):
///   swap(fa_in, min_out, to_token, is_stable) -> FungibleAsset
module cellana::router {
    use aptos_framework::fungible_asset::{FungibleAsset, Metadata};
    use aptos_framework::object::Object;

    public fun swap(
        _fa_in: FungibleAsset,
        _amount_out_min: u64,
        _to_token: Object<Metadata>,
        _is_stable: bool,
    ): FungibleAsset {
        abort 0
    }
}
