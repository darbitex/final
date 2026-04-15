/// Hyperion CLMM adapter for Darbitex meta router.
///
/// Thin wrapper around Hyperion's pool_v3::swap composable primitive.
/// Simplifies the (u64, FA, FA) return into a single FA output,
/// merging leftover back or asserting it's zero for exact_in swaps.

module hyperion_adapter::adapter {
    use aptos_framework::fungible_asset::{Self, FungibleAsset, Metadata};
    use aptos_framework::object::Object;

    use dex_contract::pool_v3;
    use dex_contract::tick_math;

    // ===== Errors =====

    const E_ZERO_AMOUNT: u64 = 1;
    const E_MIN_OUT: u64 = 2;
    const E_LEFTOVER: u64 = 3;

    // ===== Composable primitive =====

    /// Single-hop swap through a Hyperion CLMM pool.
    /// Takes FungibleAsset in, returns FungibleAsset out.
    /// Aborts if output < min_out.
    public fun swap(
        pool: Object<pool_v3::LiquidityPoolV3>,
        a_to_b: bool,
        fa_in: FungibleAsset,
        min_out: u64,
    ): FungibleAsset {
        let amount_in = fungible_asset::amount(&fa_in);
        assert!(amount_in > 0, E_ZERO_AMOUNT);

        // For a_to_b (price goes down), use min_sqrt_price as limit.
        // For b_to_a (price goes up), use max_sqrt_price as limit.
        // This allows the swap to traverse the full tick range.
        let sqrt_price_limit = if (a_to_b) {
            tick_math::min_sqrt_price()
        } else {
            tick_math::max_sqrt_price()
        };

        let (_amount_used, leftover, fa_out) = pool_v3::swap(
            pool,
            a_to_b,
            true,           // exact_in
            amount_in,
            fa_in,
            sqrt_price_limit,
        );

        // For exact_in, leftover should be zero (all input consumed).
        // Destroy the empty FA. If not empty, abort — partial fill means
        // the pool couldn't fill the full amount (insufficient liquidity
        // in the price range).
        assert!(fungible_asset::amount(&leftover) == 0, E_LEFTOVER);
        fungible_asset::destroy_zero(leftover);

        let out_amount = fungible_asset::amount(&fa_out);
        assert!(out_amount >= min_out, E_MIN_OUT);

        fa_out
    }

    // ===== Views (pass-through to Hyperion) =====

    /// Quote: how much out for a given amount_in on a specific pool.
    /// Returns (amount_out, fee_amount).
    public fun get_amount_out(
        pool: Object<pool_v3::LiquidityPoolV3>,
        token_in: Object<Metadata>,
        amount_in: u64,
    ): (u64, u64) {
        pool_v3::get_amount_out(pool, token_in, amount_in)
    }

    /// Check if a Hyperion pool exists for a given pair + fee tier.
    public fun pool_exists(
        meta_a: Object<Metadata>,
        meta_b: Object<Metadata>,
        fee_tier: u8,
    ): bool {
        pool_v3::liquidity_pool_exists(meta_a, meta_b, fee_tier)
    }

    /// Get the pool object for a given pair + fee tier.
    public fun get_pool(
        meta_a: Object<Metadata>,
        meta_b: Object<Metadata>,
        fee_tier: u8,
    ): Object<pool_v3::LiquidityPoolV3> {
        pool_v3::liquidity_pool(meta_a, meta_b, fee_tier)
    }

    /// Get reserves of a pool.
    public fun reserves(
        pool: Object<pool_v3::LiquidityPoolV3>,
    ): (u64, u64) {
        pool_v3::pool_reserve_amount(pool)
    }
}
