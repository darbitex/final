/// Atomic flash loan arbitrage: Aave (0 fee) → Hyperion → Darbitex → repay.
///
/// Standard satellite pattern: borrow from Aave, swap on external venue,
/// swap back on Darbitex, repay Aave, keep profit.

module hyperion_adapter::flash_arb {
    use std::signer;
    use aptos_framework::fungible_asset::{Self, Metadata};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;

    use dex_contract::pool_v3;
    use aave_pool::flashloan_logic;
    use darbitex::pool;

    use hyperion_adapter::adapter;

    // ===== Errors =====

    const E_NO_PROFIT: u64 = 1;
    const E_ZERO_AMOUNT: u64 = 2;

    // ===== Arb entry points =====

    /// Flash arb: borrow token_a from Aave → swap to token_b on Hyperion
    /// → swap token_b back to token_a on Darbitex → repay Aave → profit.
    ///
    /// Caller specifies the Hyperion pool, Darbitex pool, direction, and
    /// amount. Profit (if any) stays in the caller's primary_fungible_store.
    public entry fun arb_hyperion_to_darbitex(
        caller: &signer,
        hyperion_pool: Object<pool_v3::LiquidityPoolV3>,
        hyperion_a_to_b: bool,
        darbitex_pool: address,
        borrow_asset: Object<Metadata>,
        borrow_amount: u64,
        min_profit: u64,
    ) {
        assert!(borrow_amount > 0, E_ZERO_AMOUNT);
        let caller_addr = signer::address_of(caller);
        let borrow_asset_addr = object::object_address(&borrow_asset);

        // 1. Flash borrow from Aave (0 fee). Assets deposited to caller's store.
        let receipt = flashloan_logic::flash_loan_simple(
            caller,
            caller_addr,
            borrow_asset_addr,
            (borrow_amount as u256),
            0u16,  // referral code
        );

        // 2. Withdraw borrowed FA from caller's store.
        let fa_borrowed = primary_fungible_store::withdraw(
            caller, borrow_asset, borrow_amount,
        );

        // 3. Swap on Hyperion via adapter.
        let fa_mid = adapter::swap(
            hyperion_pool,
            hyperion_a_to_b,
            fa_borrowed,
            0,  // no min_out check here — final profit check below
        );

        // 4. Swap back on Darbitex.
        let fa_result = pool::swap(
            darbitex_pool,
            caller_addr,
            fa_mid,
            0,  // no min_out check here — final profit check below
        );

        // 5. Deposit result back to caller's store (Aave repay pulls from here).
        let result_amount = fungible_asset::amount(&fa_result);
        primary_fungible_store::deposit(caller_addr, fa_result);

        // 6. Repay Aave flash loan.
        flashloan_logic::pay_flash_loan_simple(caller, receipt);

        // 7. Verify profit: result_amount - borrow_amount >= min_profit.
        // After Aave repay, the remaining balance increase = profit.
        assert!(result_amount >= borrow_amount + min_profit, E_NO_PROFIT);
    }

    /// Reverse direction: borrow token_b → swap on Darbitex → swap on
    /// Hyperion → repay → profit.
    public entry fun arb_darbitex_to_hyperion(
        caller: &signer,
        darbitex_pool: address,
        hyperion_pool: Object<pool_v3::LiquidityPoolV3>,
        hyperion_a_to_b: bool,
        borrow_asset: Object<Metadata>,
        borrow_amount: u64,
        min_profit: u64,
    ) {
        assert!(borrow_amount > 0, E_ZERO_AMOUNT);
        let caller_addr = signer::address_of(caller);
        let borrow_asset_addr = object::object_address(&borrow_asset);

        // 1. Flash borrow from Aave.
        let receipt = flashloan_logic::flash_loan_simple(
            caller,
            caller_addr,
            borrow_asset_addr,
            (borrow_amount as u256),
            0u16,
        );

        // 2. Withdraw borrowed FA.
        let fa_borrowed = primary_fungible_store::withdraw(
            caller, borrow_asset, borrow_amount,
        );

        // 3. Swap on Darbitex first.
        let fa_mid = pool::swap(
            darbitex_pool,
            caller_addr,
            fa_borrowed,
            0,
        );

        // 4. Swap on Hyperion via adapter.
        let fa_result = adapter::swap(
            hyperion_pool,
            hyperion_a_to_b,
            fa_mid,
            0,
        );

        // 5. Deposit result, repay, check profit.
        let result_amount = fungible_asset::amount(&fa_result);
        primary_fungible_store::deposit(caller_addr, fa_result);
        flashloan_logic::pay_flash_loan_simple(caller, receipt);
        assert!(result_amount >= borrow_amount + min_profit, E_NO_PROFIT);
    }
}
