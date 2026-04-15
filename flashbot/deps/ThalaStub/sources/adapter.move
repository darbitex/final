/// Interface stub for the DarbitexThala adapter satellite.
/// Signatures must match the live on-chain module at
/// `0x583d93de79a3f175f1e3751513b2be767f097376f22ea2e7a5aac331e60f206f`.
/// Bodies are `abort 0` — never executed, the runtime linker
/// dispatches calls to the real module.
module thala_adapter::adapter {
    use aptos_framework::fungible_asset::{FungibleAsset, Metadata};
    use aptos_framework::object::Object;

    use thalaswap_v2::pool::Pool;

    // View: quote meta_in → meta_out through a specific Thala pool.
    public fun quote(
        _pool_addr: address,
        _meta_in: address,
        _meta_out: address,
        _amount_in: u64,
    ): u64 {
        abort 0
    }

    // Compose-style swap: hand over FA, receive FA. Used by router for
    // flash-arb atomic composition.
    public fun swap(
        _user: &signer,
        _pool_obj: Object<Pool>,
        _fa_in: FungibleAsset,
        _meta_out: Object<Metadata>,
        _min_out: u64,
    ): FungibleAsset {
        abort 0
    }

    // Wallet-facing entry: withdraws from primary store, swaps, deposits.
    // Used by router for the meta-routing path when Thala wins.
    public entry fun swap_entry(
        _user: &signer,
        _pool_addr: address,
        _meta_in: address,
        _meta_out: address,
        _amount_in: u64,
        _min_out: u64,
        _deadline_unix: u64,
    ) {
        abort 0
    }

    // View: flat list of asset metadata addresses in a pool.
    public fun pool_assets(_pool_addr: address): vector<address> {
        abort 0
    }
}
