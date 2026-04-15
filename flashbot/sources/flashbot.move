/// Darbitex Flashbot v0.1 — cross-venue flash-arbitrage satellite.
///
/// Flash loan source: Aave V3 on Aptos (0 fee flash_loan_simple). Do
/// NOT use Darbitex's own flash pool as the borrow source — Final's
/// TVL is too small to be useful for real arb sizing.
///
/// Swap venues for v0.1: Darbitex Final × ThalaSwap V2. Caller picks
/// the order via `thala_first: bool`. Hyperion and Cellana come in a
/// later version.
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

    // ===== Event =====

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
}
