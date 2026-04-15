/// Type-only stub for `thalaswap_v2::pool::Pool`. The flashbot
/// satellite and the DarbitexThala adapter both reference this type
/// via `Object<Pool>` handles and never touch its fields. At runtime
/// the real Pool type at `0x7730cd28...` is what actually flows
/// through these handles — the stub layout below is a compile-time
/// placeholder and is never instantiated on-chain.
module thalaswap_v2::pool {
    struct Pool has key {
        _dummy: u64,
    }
}
