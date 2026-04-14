// Darbitex — tests stub.
//
// Full test suite (swap/LP/flash primitives, arbitrage trigger paths,
// cycle discovery, profit split, soft-skip, anti-reentrancy) lives
// here once the arbitrage module lands. This placeholder keeps the
// sources directory layout consistent during scaffolding.

#[test_only]
module darbitex::tests {
    #[test]
    fun sanity() {
        assert!(1 + 1 == 2, 0);
    }
}
