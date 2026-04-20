module darbitex_twamm::bridge {
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

    friend darbitex_twamm::executor;

    // ===== Constants =====
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;
    const TREASURY_BPS: u64 = 1_000; // 10%
    const BPS_DENOM: u64 = 10_000;

    // ===== Errors =====
    const E_DEADLINE: u64 = 1;
    const E_ZERO_AMOUNT: u64 = 2;
    const E_CANT_REPAY: u64 = 3;
    const E_INSUFFICIENT_OUT: u64 = 4;
    const E_SAME_TOKEN: u64 = 5;

    #[event]
    struct OmniSwapExecuted has drop, store {
        user: address, beneficiary: address, venue: u8,
        token_in: address, token_out: address,
        amount_in: u64, amount_out: u64, arb_executed: bool,
        arb_profit_beneficiary: u64, arb_profit_treasury: u64,
        timestamp: u64,
    }

    fun sqrt_u256(y: u256): u256 {
        if (y < 4) { if (y == 0) return 0; return 1; };
        let z = y; let x = y / 2 + 1;
        while (x < z) { z = x; x = (y / x + x) / 2; };
        z
    }

    fun calculate_optimal_borrow(
        darbitex_arb_pool: address,
        token_in: Object<Metadata>,
        oracle_reserve_in: u128,
        oracle_reserve_out: u128,
    ): u64 {
        if (oracle_reserve_in == 0 || oracle_reserve_out == 0) return 0;
        if (!pool::pool_exists(darbitex_arb_pool)) return 0;
        let (res_a, res_b) = pool::reserves(darbitex_arb_pool);
        let (meta_a, _meta_b) = pool::pool_tokens(darbitex_arb_pool);
        let is_in_a = (object::object_address(&token_in) == object::object_address(&meta_a));
        let (reserve_in, reserve_out) = if (is_in_a) { (res_a, res_b) } else { (res_b, res_a) };
        let k_u256 = (reserve_in as u256) * (reserve_out as u256);
        let target_in_squared_u256 = k_u256 * (oracle_reserve_in as u256) / (oracle_reserve_out as u256);
        let target_in = sqrt_u256(target_in_squared_u256);
        let optimal_in_darbitex = if (target_in > (reserve_in as u256)) { ((target_in - (reserve_in as u256)) as u64) } else { 0 };
        let raw_borrow = (((optimal_in_darbitex as u128) * oracle_reserve_out / oracle_reserve_in) as u64);
        let max_borrow = reserve_out / 2;
        let capped = if (raw_borrow > max_borrow) { max_borrow } else { raw_borrow };
        capped * 98 / 100 // Slightly more conservative for safety
    }

    /// DEPLOY BLOCKER FIX (Kimi R4): Using order_signer for flash loan logic.
    /// This prevents exposing the end-user's signer to external protocols (Aave).
    public(friend) fun omni_swap_thala_twamm(
        order_signer: &signer,
        token_in: Object<Metadata>,
        amount_in: u64,
        token_out: Object<Metadata>,
        min_amount_out: u64,
        thala_pool: address,
        darbitex_arb_pool: address,
        beneficiary: address,
        twamm_reserve_in: u128,
        twamm_reserve_out: u128,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        assert!(amount_in > 0, E_ZERO_AMOUNT);
        assert!(object::object_address(&token_in) != object::object_address(&token_out), E_SAME_TOKEN);
        let order_addr = signer::address_of(order_signer);

        // 1. External Leg (Thala)
        let fa_in = primary_fungible_store::withdraw(order_signer, token_in, amount_in);
        let thala_pool_obj = object::address_to_object<ThalaPool>(thala_pool);
        let fa_out = thala::swap(order_signer, thala_pool_obj, fa_in, token_out, min_amount_out);

        let amount_out = fungible_asset::amount(&fa_out);
        assert!(amount_out >= min_amount_out, E_INSUFFICIENT_OUT);
        primary_fungible_store::deposit(order_addr, fa_out);

        // 2. Internal MEV Leg (Darbitex Flash Arb)
        let auto_borrow_amount = calculate_optimal_borrow(darbitex_arb_pool, token_in, twamm_reserve_in, twamm_reserve_out);

        if (auto_borrow_amount > 0) {
            // Using order_signer (Internal Object) for flash loan - USER SIGNER NEVER PASSED TO AAVE
            let receipt = flashloan_logic::flash_loan_simple(order_signer, order_addr, object::object_address(&token_out), (auto_borrow_amount as u256), 0u16);
            
            // DEPLOY BLOCKER FIX (Kimi R4): Removed the dangerous pre-withdrawal balance check
            let fa_borrowed = primary_fungible_store::withdraw(order_signer, token_out, auto_borrow_amount);
            // Arb-leg: pass min_out=0 — final repay assertion (gross_out >= auto_borrow_amount) is the economic guard
            let fa_mid = thala::swap(order_signer, thala_pool_obj, fa_borrowed, token_in, 0);
            let fa_arb_result = pool::swap(darbitex_arb_pool, order_addr, fa_mid, 0);

            let gross_out = fungible_asset::amount(&fa_arb_result);
            assert!(gross_out >= auto_borrow_amount, E_CANT_REPAY);
            let profit_total = gross_out - auto_borrow_amount;

            let arb_profit_treasury = (((profit_total as u128) * (TREASURY_BPS as u128) / (BPS_DENOM as u128)) as u64);
            let arb_profit_beneficiary = profit_total - arb_profit_treasury;

            if (arb_profit_treasury > 0) primary_fungible_store::deposit(TREASURY, fungible_asset::extract(&mut fa_arb_result, arb_profit_treasury));
            if (arb_profit_beneficiary > 0) primary_fungible_store::deposit(beneficiary, fungible_asset::extract(&mut fa_arb_result, arb_profit_beneficiary));
            primary_fungible_store::deposit(order_addr, fa_arb_result);
            
            flashloan_logic::pay_flash_loan_simple(order_signer, receipt);

            event::emit(OmniSwapExecuted { user: order_addr, beneficiary, venue: 1, token_in: object::object_address(&token_in), token_out: object::object_address(&token_out), amount_in, amount_out, arb_executed: true, arb_profit_beneficiary, arb_profit_treasury, timestamp: timestamp::now_seconds() });
        } else {
            event::emit(OmniSwapExecuted { user: order_addr, beneficiary, venue: 1, token_in: object::object_address(&token_in), token_out: object::object_address(&token_out), amount_in, amount_out, arb_executed: false, arb_profit_beneficiary: 0, arb_profit_treasury: 0, timestamp: timestamp::now_seconds() });
        };
    }
}
