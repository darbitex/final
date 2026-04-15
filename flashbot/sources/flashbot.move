/// Darbitex Flashbot v0.3 — cross-venue flash-arbitrage satellite.
///
/// Flash loan source: Aave V3 on Aptos (0 fee flash_loan_simple). Do
/// NOT use Darbitex's own flash pool as the borrow source — Final's
/// TVL is too small to be useful for real arb sizing.
///
/// Supported swap venues for the non-Darbitex leg:
///   - ThalaSwap V2 (via `run_arb` — from v0.1)
///   - Hyperion CLMM tier 1 / 5 bps (via `run_arb_hyperion` — v0.2)
///   - Cellana stable + volatile curves (via `run_arb_cellana` — v0.3)
/// Each external venue gets its own entry function because the Move
/// interfaces differ (Thala uses Object<Pool>, Hyperion uses
/// Object<LiquidityPoolV3> + an explicit a_to_b bool, Cellana has a
/// router that auto-resolves by `is_stable` + token pair). Caller
/// always picks leg order via the `<venue>_first` bool.
///
/// Profit split: 90% to caller, 10% to the Darbitex treasury. Matches
/// Final's existing `arbitrage::TREASURY_BPS = 1000` rule — the flash
/// arb surplus is the same "measurable surplus" concept, just realized
/// in a cycle instead of a route comparison. Everybody wins: caller
/// gets the overwhelming majority for being the trigger, protocol
/// gets sustenance for providing the infrastructure.
///
/// SCOPE DISCIPLINE: zero changes to Final's core package. Pure
/// satellite built on top of Final's public primitives. No dependency
/// on beta's deprecated modules.
module darbitex_flashbot::flashbot {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, Metadata};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool;

    use aave_pool::flashloan_logic;
    use thala_adapter::adapter as thala;
    use thalaswap_v2::pool::Pool as ThalaPool;
    use hyperion_adapter::adapter as hyperion;
    use dex_contract::pool_v3::LiquidityPoolV3 as HyperionPool;
    use cellana::router as cellana_router;

    // ===== Constants =====

    /// Darbitex treasury — same hardcoded constant as Final's
    /// arbitrage module. Changing it would require a package upgrade.
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;

    /// Treasury basis-point share of realized profit. Matches Final's
    /// `arbitrage::TREASURY_BPS = 1_000` (10%). Caller keeps 90%.
    const TREASURY_BPS: u64 = 1_000;
    const BPS_DENOM: u64 = 10_000;

    // ===== Errors =====

    /// Caller-supplied deadline is in the past.
    const E_DEADLINE: u64 = 1;
    /// `borrow_amount` is zero — no meaningful arb to execute.
    const E_ZERO_AMOUNT: u64 = 2;
    /// Round-trip output cannot even cover the flash principal.
    /// Off-chain indexers can map this to "the arb went net-negative
    /// before any split math was done".
    const E_CANT_REPAY: u64 = 3;
    /// Caller's net share (after the 10% treasury cut) is below the
    /// `min_net_profit` floor. The arb WAS profitable, just not
    /// profitable enough for the caller's stated threshold.
    const E_INSUFFICIENT_PROFIT: u64 = 4;

    // ===== Events =====

    #[event]
    struct FlashArbExecuted has drop, store {
        caller: address,
        /// true = swap leg 1 on Thala, leg 2 on Darbitex;
        /// false = Darbitex first, Thala second.
        thala_first: bool,
        borrow_asset: address,
        other_asset: address,
        darbitex_swap_pool: address,
        thala_swap_pool: address,
        borrowed: u64,
        gross_out: u64,
        profit_total: u64,
        caller_share: u64,
        treasury_share: u64,
        timestamp: u64,
    }

    #[event]
    struct HyperionFlashArbExecuted has drop, store {
        caller: address,
        /// true = swap leg 1 on Hyperion, leg 2 on Darbitex;
        /// false = Darbitex first, Hyperion second.
        hyperion_first: bool,
        /// Sort-order flag relative to the Hyperion pool. Retained
        /// for off-chain indexers that want to verify direction
        /// without re-deriving the sort.
        borrow_is_hyperion_side_a: bool,
        borrow_asset: address,
        other_asset: address,
        darbitex_swap_pool: address,
        hyperion_swap_pool: address,
        borrowed: u64,
        gross_out: u64,
        profit_total: u64,
        caller_share: u64,
        treasury_share: u64,
        timestamp: u64,
    }

    #[event]
    struct CellanaFlashArbExecuted has drop, store {
        caller: address,
        /// true = swap leg 1 on Cellana, leg 2 on Darbitex;
        /// false = Darbitex first, Cellana second.
        cellana_first: bool,
        /// Which Cellana curve was used (true = stable, false =
        /// volatile). Cellana runs both curves per pair; the router
        /// internally picks the pool that matches (from, to,
        /// is_stable).
        is_stable: bool,
        borrow_asset: address,
        other_asset: address,
        darbitex_swap_pool: address,
        borrowed: u64,
        gross_out: u64,
        profit_total: u64,
        caller_share: u64,
        treasury_share: u64,
        timestamp: u64,
    }

    // ===== Entry =====

    /// Execute an atomic cross-venue flash arbitrage.
    ///
    /// Flow (thala_first = false):
    /// 1. Flash-borrow `borrow_amount` of `borrow_asset` from Aave.
    /// 2. Withdraw the borrowed FA from the caller's primary store.
    /// 3. Swap borrow_asset → other_asset on Darbitex via
    ///    `pool::swap(darbitex_swap_pool, ...)`.
    /// 4. Swap other_asset → borrow_asset on Thala via
    ///    `thala_adapter::adapter::swap(thala_swap_pool, ...)`.
    /// 5. Assert the round-trip output covers the flash principal
    ///    (`E_CANT_REPAY`). Compute `profit_total`.
    /// 6. Split the profit 90/10 — `treasury_share` = 10%,
    ///    `caller_share` = 90%. Assert `caller_share >= min_net_profit`
    ///    (`E_INSUFFICIENT_PROFIT`).
    /// 7. Deposit the treasury slice to the hardcoded TREASURY (skip
    ///    on zero-share). Deposit the rest (borrow + caller_share)
    ///    back to caller's primary store.
    /// 8. Repay Aave via `pay_flash_loan_simple`, which pulls exactly
    ///    `borrow_amount` from the caller's store. What remains is
    ///    the caller's 90% share.
    /// 9. Emit `FlashArbExecuted`.
    ///
    /// When `thala_first = true` the swap order is reversed.
    ///
    /// `min_net_profit` semantics: this is the floor on the CALLER'S
    /// take-home AFTER the 10% treasury cut, not the gross profit.
    /// If you want net 100 X, pass 100 — the caller needs the arb to
    /// clear `(profit × 0.9) >= 100`, i.e., gross profit >= 111.1 X.
    public entry fun run_arb(
        caller: &signer,
        borrow_asset: Object<Metadata>,
        borrow_amount: u64,
        other_asset: Object<Metadata>,
        darbitex_swap_pool: address,
        thala_swap_pool: address,
        thala_first: bool,
        min_net_profit: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        assert!(borrow_amount > 0, E_ZERO_AMOUNT);
        let caller_addr = signer::address_of(caller);
        let borrow_asset_addr = object::object_address(&borrow_asset);

        // 1. Flash borrow from Aave (0 fee, deposits to caller's store).
        let receipt = flashloan_logic::flash_loan_simple(
            caller,
            caller_addr,
            borrow_asset_addr,
            (borrow_amount as u256),
            0u16,
        );

        // 2. Withdraw borrowed FA to compose through the swap chain.
        let fa_borrowed = primary_fungible_store::withdraw(
            caller,
            borrow_asset,
            borrow_amount,
        );

        // 3-4. Route through both venues in the chosen order.
        let fa_result = if (thala_first) {
            let thala_pool_obj = object::address_to_object<ThalaPool>(thala_swap_pool);
            let fa_mid = thala::swap(
                caller,
                thala_pool_obj,
                fa_borrowed,
                other_asset,
                0,
            );
            pool::swap(darbitex_swap_pool, caller_addr, fa_mid, 0)
        } else {
            let fa_mid = pool::swap(
                darbitex_swap_pool,
                caller_addr,
                fa_borrowed,
                0,
            );
            let thala_pool_obj = object::address_to_object<ThalaPool>(thala_swap_pool);
            thala::swap(
                caller,
                thala_pool_obj,
                fa_mid,
                borrow_asset,
                0,
            )
        };

        // 5. Profit guards. Two separate checks so off-chain readers
        //    can distinguish "arb was net-negative" from "arb was
        //    profitable but below caller's threshold".
        //
        //    Split in this order (not `>= borrow + min_profit`) to
        //    avoid an overflow risk on absurd inputs where
        //    `borrow_amount + min_net_profit > u64::MAX`.
        let gross_out = fungible_asset::amount(&fa_result);
        assert!(gross_out >= borrow_amount, E_CANT_REPAY);
        let profit_total = gross_out - borrow_amount;

        // 6. Split profit 90% caller / 10% treasury. Math widens to
        //    u128 to rule out overflow on whale-scale surpluses
        //    (mirrors Final's `arbitrage::TREASURY` widening).
        let treasury_share = (((profit_total as u128) * (TREASURY_BPS as u128)
            / (BPS_DENOM as u128)) as u64);
        let caller_share = profit_total - treasury_share;

        // `min_net_profit` is the floor on the CALLER'S take-home
        // (post-split), not on the gross arb profit. This is what
        // the caller actually receives, so asserting on the split
        // value matches user intuition ("I want at least X in my
        // wallet or don't execute").
        assert!(caller_share >= min_net_profit, E_INSUFFICIENT_PROFIT);

        // 7. Distribute the result FA. Treasury slice is extracted
        //    before the remainder touches the caller's store so
        //    Aave's pull-repay doesn't race the split. Guard against
        //    a zero treasury slice (can happen when profit_total
        //    rounds down below 10 raw units) because
        //    `fungible_asset::extract(0)` is not universally safe on
        //    all FA backends.
        if (treasury_share > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_result, treasury_share);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        primary_fungible_store::deposit(caller_addr, fa_result);

        // 8. Aave pull-repay. After this, the caller's store is net
        //    +caller_share (the borrow_amount was pulled out,
        //    leaving only the 90% profit share).
        flashloan_logic::pay_flash_loan_simple(caller, receipt);

        // 9. Event.
        event::emit(FlashArbExecuted {
            caller: caller_addr,
            thala_first,
            borrow_asset: borrow_asset_addr,
            other_asset: object::object_address(&other_asset),
            darbitex_swap_pool,
            thala_swap_pool,
            borrowed: borrow_amount,
            gross_out,
            profit_total,
            caller_share,
            treasury_share,
            timestamp: timestamp::now_seconds(),
        });
    }

    /// Execute an atomic cross-venue flash arbitrage between Darbitex
    /// and Hyperion CLMM. Same shape as `run_arb` but with Hyperion's
    /// `adapter::swap` as the non-Darbitex leg.
    ///
    /// Hyperion pools don't auto-infer swap direction from the input
    /// FA (unlike Darbitex's `pool::swap`), so the caller must pass
    /// `borrow_is_hyperion_side_a`: true if `borrow_asset` is the
    /// sorted-A side of the Hyperion pool (by BCS byte order), false
    /// otherwise. For the reverse-direction leg the a_to_b flag flips
    /// automatically. The frontend computes this bool once per pool
    /// via `adapter::get_pool` metadata or lexicographic comparison
    /// of the two asset addresses.
    ///
    /// `hyperion_first = false` executes: Darbitex leg 1, Hyperion leg 2.
    /// `hyperion_first = true`  executes: Hyperion leg 1, Darbitex leg 2.
    ///
    /// Profit split and `min_net_profit` semantics are identical to
    /// `run_arb` — 90% caller, 10% hardcoded TREASURY, floor is on the
    /// caller share post-split.
    public entry fun run_arb_hyperion(
        caller: &signer,
        borrow_asset: Object<Metadata>,
        borrow_amount: u64,
        other_asset: Object<Metadata>,
        darbitex_swap_pool: address,
        hyperion_swap_pool: address,
        borrow_is_hyperion_side_a: bool,
        hyperion_first: bool,
        min_net_profit: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        assert!(borrow_amount > 0, E_ZERO_AMOUNT);
        let caller_addr = signer::address_of(caller);
        let borrow_asset_addr = object::object_address(&borrow_asset);
        let other_asset_addr = object::object_address(&other_asset);
        let hyperion_pool_obj = object::address_to_object<HyperionPool>(hyperion_swap_pool);

        // 1. Flash borrow from Aave.
        let receipt = flashloan_logic::flash_loan_simple(
            caller,
            caller_addr,
            borrow_asset_addr,
            (borrow_amount as u256),
            0u16,
        );

        // 2. Withdraw borrowed FA for composition.
        let fa_borrowed = primary_fungible_store::withdraw(
            caller,
            borrow_asset,
            borrow_amount,
        );

        // 3-4. Route legs. When the input FA is `borrow_asset`, the
        // Hyperion a_to_b flag matches `borrow_is_hyperion_side_a`.
        // When the input FA is `other_asset`, the flag is flipped.
        let fa_result = if (hyperion_first) {
            // Leg 1: borrow_asset → other_asset on Hyperion
            let fa_mid = hyperion::swap(
                hyperion_pool_obj,
                borrow_is_hyperion_side_a,
                fa_borrowed,
                0,
            );
            // Leg 2: other_asset → borrow_asset on Darbitex
            pool::swap(darbitex_swap_pool, caller_addr, fa_mid, 0)
        } else {
            // Leg 1: borrow_asset → other_asset on Darbitex
            let fa_mid = pool::swap(
                darbitex_swap_pool,
                caller_addr,
                fa_borrowed,
                0,
            );
            // Leg 2: other_asset → borrow_asset on Hyperion
            // — direction is the opposite of leg 1's notional pair sort
            hyperion::swap(
                hyperion_pool_obj,
                !borrow_is_hyperion_side_a,
                fa_mid,
                0,
            )
        };

        // 5. Profit guards.
        let gross_out = fungible_asset::amount(&fa_result);
        assert!(gross_out >= borrow_amount, E_CANT_REPAY);
        let profit_total = gross_out - borrow_amount;

        // 6. 90/10 split with u128 widening (see run_arb for rationale).
        let treasury_share = (((profit_total as u128) * (TREASURY_BPS as u128)
            / (BPS_DENOM as u128)) as u64);
        let caller_share = profit_total - treasury_share;
        assert!(caller_share >= min_net_profit, E_INSUFFICIENT_PROFIT);

        // 7. Distribute.
        if (treasury_share > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_result, treasury_share);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        primary_fungible_store::deposit(caller_addr, fa_result);

        // 8. Aave pull-repay.
        flashloan_logic::pay_flash_loan_simple(caller, receipt);

        // 9. Event.
        event::emit(HyperionFlashArbExecuted {
            caller: caller_addr,
            hyperion_first,
            borrow_is_hyperion_side_a,
            borrow_asset: borrow_asset_addr,
            other_asset: other_asset_addr,
            darbitex_swap_pool,
            hyperion_swap_pool,
            borrowed: borrow_amount,
            gross_out,
            profit_total,
            caller_share,
            treasury_share,
            timestamp: timestamp::now_seconds(),
        });
    }

    /// Execute an atomic cross-venue flash arbitrage between Darbitex
    /// and Cellana. Unlike Thala/Hyperion which go through intermediate
    /// adapter satellites, Cellana's own `router::swap` exposes an
    /// FA-in/FA-out compose primitive natively — the router looks up
    /// `liquidity_pool(from_token, to_token, is_stable)` internally,
    /// so this satellite never holds a Cellana pool object handle.
    ///
    /// Cellana runs both stable and volatile curves per asset pair.
    /// The caller picks which curve via `is_stable: bool`. If the
    /// chosen curve doesn't have a pool for the given pair, Cellana's
    /// router aborts and the whole tx reverts cleanly.
    ///
    /// `cellana_first = false` executes: Darbitex leg 1, Cellana leg 2.
    /// `cellana_first = true`  executes: Cellana leg 1, Darbitex leg 2.
    ///
    /// Profit split and `min_net_profit` semantics are identical to
    /// `run_arb` / `run_arb_hyperion` — 90% caller, 10% hardcoded
    /// TREASURY, floor is on the caller share post-split.
    public entry fun run_arb_cellana(
        caller: &signer,
        borrow_asset: Object<Metadata>,
        borrow_amount: u64,
        other_asset: Object<Metadata>,
        darbitex_swap_pool: address,
        is_stable: bool,
        cellana_first: bool,
        min_net_profit: u64,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        assert!(borrow_amount > 0, E_ZERO_AMOUNT);
        let caller_addr = signer::address_of(caller);
        let borrow_asset_addr = object::object_address(&borrow_asset);
        let other_asset_addr = object::object_address(&other_asset);

        // 1. Flash borrow from Aave.
        let receipt = flashloan_logic::flash_loan_simple(
            caller,
            caller_addr,
            borrow_asset_addr,
            (borrow_amount as u256),
            0u16,
        );

        // 2. Withdraw borrowed FA for composition.
        let fa_borrowed = primary_fungible_store::withdraw(
            caller,
            borrow_asset,
            borrow_amount,
        );

        // 3-4. Route legs. Cellana's router internally resolves the
        // correct pool for (fa_in's metadata, to_token, is_stable) —
        // no Object<Pool> handle needed on our side.
        let fa_result = if (cellana_first) {
            // Leg 1: borrow_asset → other_asset on Cellana
            let fa_mid = cellana_router::swap(
                fa_borrowed,
                0,
                other_asset,
                is_stable,
            );
            // Leg 2: other_asset → borrow_asset on Darbitex
            pool::swap(darbitex_swap_pool, caller_addr, fa_mid, 0)
        } else {
            // Leg 1: borrow_asset → other_asset on Darbitex
            let fa_mid = pool::swap(
                darbitex_swap_pool,
                caller_addr,
                fa_borrowed,
                0,
            );
            // Leg 2: other_asset → borrow_asset on Cellana
            cellana_router::swap(
                fa_mid,
                0,
                borrow_asset,
                is_stable,
            )
        };

        // 5. Profit guards.
        let gross_out = fungible_asset::amount(&fa_result);
        assert!(gross_out >= borrow_amount, E_CANT_REPAY);
        let profit_total = gross_out - borrow_amount;

        // 6. 90/10 split with u128 widening.
        let treasury_share = (((profit_total as u128) * (TREASURY_BPS as u128)
            / (BPS_DENOM as u128)) as u64);
        let caller_share = profit_total - treasury_share;
        assert!(caller_share >= min_net_profit, E_INSUFFICIENT_PROFIT);

        // 7. Distribute.
        if (treasury_share > 0) {
            let fa_treasury = fungible_asset::extract(&mut fa_result, treasury_share);
            primary_fungible_store::deposit(TREASURY, fa_treasury);
        };
        primary_fungible_store::deposit(caller_addr, fa_result);

        // 8. Aave pull-repay.
        flashloan_logic::pay_flash_loan_simple(caller, receipt);

        // 9. Event.
        event::emit(CellanaFlashArbExecuted {
            caller: caller_addr,
            cellana_first,
            is_stable,
            borrow_asset: borrow_asset_addr,
            other_asset: other_asset_addr,
            darbitex_swap_pool,
            borrowed: borrow_amount,
            gross_out,
            profit_total,
            caller_share,
            treasury_share,
            timestamp: timestamp::now_seconds(),
        });
    }
}
