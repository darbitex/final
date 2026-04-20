/// Type-only stub for `thalaswap_v2::pool::Pool`. The flashbot
/// satellite and the DarbitexThala adapter both reference this type
/// via `Object<Pool>` handles and never touch its fields. At runtime
/// the real Pool type at `0x7730cd28...` is what actually flows
/// through these handles — the stub layout below is a compile-time
/// placeholder and is never instantiated on-chain.
///
/// v0.5.0 additions: two view function declarations so TWAMM bridge
/// can read Thala pool reserves on-chain (Thala-as-arb-reference).
/// Bodies `abort 0` — runtime linker dispatches to real Thala V2.
module thalaswap_v2::pool {
    use aptos_framework::object::Object;
    use aptos_framework::fungible_asset::Metadata;

    struct Pool has key {
        _dummy: u64,
    }

    public fun pool_balances(_pool: Object<Pool>): vector<u64> {
        abort 0
    }

    public fun pool_assets_metadata(_pool: Object<Pool>): vector<Object<Metadata>> {
        abort 0
    }
}
