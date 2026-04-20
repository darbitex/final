module darbitex_twamm::bridge {
    use std::signer;
    use std::vector;
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, Metadata};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool;
    use aave_pool::flashloan_logic;
    use thala_adapter::adapter as thala;
    use thalaswap_v2::pool::{Self as thala_pool_v2, Pool as ThalaPool};

    friend darbitex_twamm::executor;

    // ===== Constants =====
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;
    const TREASURY_BPS: u64 = 1_000; // 10%
    const BPS_DENOM: u64 = 10_000;

    // Minimum arb size floor — skip MEV if computed optimal borrow is below this.
    // Value in token_out raw units. Current: 1000 = 0.001 USDC (USDC is 6 decimals)
    // ≈ $0.001 economic floor. Prevents gas-waste on dust arbs where profit < gas cost.
    // ASSUMES token_out has 6 decimals (USDC). For other token_out (e.g., APT 8 dec),
    // effective USD threshold differs — adjust or parameterize in future upgrade.
    const MIN_ARB_AMOUNT: u64 = 1000;

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

    /// v0.5.0 Thala-direct arb formula.
    /// Compares Darbitex pool (post-DEX-leg) directly against Thala pool reserves —
    /// no oracle involvement. Classic 2-AMM constant-product arb.
    ///
    /// Returns (direction, borrow_amount) — borrow always in token_out units.
    /// direction:
    ///   0 = prices match (or one pool missing) — skip MEV
    ///   1 = forward (P_darb > P_thala): Flash Y → Thala Y→X → Darbitex X→Y → repay
    ///   2 = reverse (P_darb < P_thala): Flash Y → Darbitex Y→X → Thala X→Y → repay
    ///
    /// Optimal borrow derived from profit-maximization over 2-AMM constant product:
    ///   Δy* = (sqrt(k_D × k_T) - boundary_term) / (dx + tx)
    /// where boundary_term differs per direction. 98% fee/slippage buffer applied.
    /// Thala pool assumed weighted 50/50 (standard CP). Non-50/50 weighted pools
    /// will see over-borrow, caught by final `gross_out >= borrow` assertion.
    fun calculate_optimal_borrow(
        darbitex_arb_pool: address,
        thala_pool_obj: Object<ThalaPool>,
        token_in: Object<Metadata>,
    ): (u8, u64) {
        if (!pool::pool_exists(darbitex_arb_pool)) return (0, 0);

        // Darbitex reserves oriented to order's token_in
        let (d_res_a, d_res_b) = pool::reserves(darbitex_arb_pool);
        let (d_meta_a, _) = pool::pool_tokens(darbitex_arb_pool);
        let is_in_a_d = (object::object_address(&token_in) == object::object_address(&d_meta_a));
        let (dx, dy) = if (is_in_a_d) { (d_res_a, d_res_b) } else { (d_res_b, d_res_a) };

        // Thala reserves oriented to the same order's token_in
        let t_balances = thala_pool_v2::pool_balances(thala_pool_obj);
        let t_metas = thala_pool_v2::pool_assets_metadata(thala_pool_obj);
        if (vector::length(&t_balances) < 2 || vector::length(&t_metas) < 2) return (0, 0);
        let t_meta_0 = *vector::borrow(&t_metas, 0);
        let t_meta_1 = *vector::borrow(&t_metas, 1);
        let token_in_addr = object::object_address(&token_in);
        let is_in_a_t = (token_in_addr == object::object_address(&t_meta_0));
        let is_in_b_t = (token_in_addr == object::object_address(&t_meta_1));
        // Guard: Thala pool must contain order's token_in — prevents wrong-pair pools
        // from keeper (misconfig or attack) triggering garbage-math MEV. Pair must
        // also match token_out implicitly (if 2-asset pool has token_in, other is token_out).
        if (!is_in_a_t && !is_in_b_t) return (0, 0);
        let (tx, ty) = if (is_in_a_t) {
            (*vector::borrow(&t_balances, 0), *vector::borrow(&t_balances, 1))
        } else {
            (*vector::borrow(&t_balances, 1), *vector::borrow(&t_balances, 0))
        };

        if (dx == 0 || dy == 0 || tx == 0 || ty == 0) return (0, 0);

        // Direction detection: cross-multiply P_darb (dy/dx) vs P_thala (ty/tx)
        let dy_tx = (dy as u256) * (tx as u256);
        let dx_ty = (dx as u256) * (ty as u256);

        // k products for optimal formula
        let k_d = (dx as u256) * (dy as u256);
        let k_t = (tx as u256) * (ty as u256);
        let sqrt_k_product = sqrt_u256(k_d * k_t);
        let sum_x = (dx as u256) + (tx as u256);

        if (dy_tx > dx_ty) {
            // Case A: P_darb > P_thala. Flow: Thala Y→X, Darbitex X→Y.
            // optimal_y_in = (sqrt(k_D × k_T) - dx × ty) / (dx + tx)
            if (sqrt_k_product <= dx_ty) return (0, 0);
            let optimal_u256 = (sqrt_k_product - dx_ty) / sum_x;
            // Cap in u256 space BEFORE cast to avoid silent truncation for huge pools
            let max_borrow_u256 = ((ty / 2) as u256);
            let capped_u256 = if (optimal_u256 > max_borrow_u256) max_borrow_u256 else optimal_u256;
            let capped = (capped_u256 as u64);  // safe — ≤ ty/2 which fits in u64
            let buffered = capped * 98 / 100;
            if (buffered < MIN_ARB_AMOUNT) return (0, 0);
            (1, buffered)
        } else if (dx_ty > dy_tx) {
            // Case B: P_darb < P_thala. Flow: Darbitex Y→X, Thala X→Y.
            // optimal_y_in = (sqrt(k_D × k_T) - tx × dy) / (dx + tx)
            let tx_dy = (tx as u256) * (dy as u256);
            if (sqrt_k_product <= tx_dy) return (0, 0);
            let optimal_u256 = (sqrt_k_product - tx_dy) / sum_x;
            let max_borrow_u256 = ((dy / 2) as u256);
            let capped_u256 = if (optimal_u256 > max_borrow_u256) max_borrow_u256 else optimal_u256;
            let capped = (capped_u256 as u64);
            let buffered = capped * 98 / 100;
            if (buffered < MIN_ARB_AMOUNT) return (0, 0);
            (2, buffered)
        } else {
            (0, 0)
        }
    }

    /// v0.5.0: DEX leg on Darbitex, MEV leg uses Thala reserves directly (no oracle).
    /// Signature cleaned — oracle reserves no longer passed (compared internally to Thala).
    public(friend) fun omni_swap_thala_twamm(
        order_signer: &signer,
        token_in: Object<Metadata>,
        amount_in: u64,
        token_out: Object<Metadata>,
        min_amount_out: u64,
        thala_pool: address,
        darbitex_arb_pool: address,
        beneficiary: address,
        deadline: u64,
    ) {
        assert!(timestamp::now_seconds() < deadline, E_DEADLINE);
        assert!(amount_in > 0, E_ZERO_AMOUNT);
        assert!(object::object_address(&token_in) != object::object_address(&token_out), E_SAME_TOKEN);
        let order_addr = signer::address_of(order_signer);

        // 1. Internal DEX Leg (Darbitex) — v0.3.0
        // User TWAMM chunks execute on Darbitex pool (internal price-setter).
        // This: (a) generates AMM fee revenue to LP, (b) moves our pool so
        // oracle EMA can actually diverge via 10% blend lag, (c) validates
        // oracle-as-a-service activity. Thala pool arg reserved for MEV leg
        // (external arb target).
        let fa_in = primary_fungible_store::withdraw(order_signer, token_in, amount_in);
        let thala_pool_obj = object::address_to_object<ThalaPool>(thala_pool);
        let fa_out = pool::swap(darbitex_arb_pool, order_addr, fa_in, min_amount_out);

        let amount_out = fungible_asset::amount(&fa_out);
        assert!(amount_out >= min_amount_out, E_INSUFFICIENT_OUT);
        primary_fungible_store::deposit(order_addr, fa_out);

        // 2. MEV Leg — v0.5.0 Thala-direct symmetric arb
        let (arb_direction, auto_borrow_amount) = calculate_optimal_borrow(darbitex_arb_pool, thala_pool_obj, token_in);

        if (auto_borrow_amount > 0) {
            // Flash loan token_out from Aave (0-fee). Same borrow currency for
            // both directions — only swap order differs.
            let receipt = flashloan_logic::flash_loan_simple(order_signer, order_addr, object::object_address(&token_out), (auto_borrow_amount as u256), 0u16);
            let fa_borrowed = primary_fungible_store::withdraw(order_signer, token_out, auto_borrow_amount);

            // min_out=0 on inner legs — economic guard is final gross_out check
            let fa_arb_result = if (arb_direction == 1) {
                // Case A (forward): Darbitex overpriced — Thala cheap, Darbitex dear.
                // Flash USDC → Thala USDC→APT → Darbitex APT→USDC → repay
                let fa_mid = thala::swap(order_signer, thala_pool_obj, fa_borrowed, token_in, 0);
                pool::swap(darbitex_arb_pool, order_addr, fa_mid, 0)
            } else {
                // Case B (reverse): Darbitex underpriced — Darbitex cheap, Thala dear.
                // Flash USDC → Darbitex USDC→APT → Thala APT→USDC → repay
                let fa_mid = pool::swap(darbitex_arb_pool, order_addr, fa_borrowed, 0);
                thala::swap(order_signer, thala_pool_obj, fa_mid, token_out, 0)
            };

            let gross_out = fungible_asset::amount(&fa_arb_result);
            assert!(gross_out >= auto_borrow_amount, E_CANT_REPAY);
            let profit_total = gross_out - auto_borrow_amount;

            let arb_profit_treasury = (((profit_total as u128) * (TREASURY_BPS as u128) / (BPS_DENOM as u128)) as u64);
            let arb_profit_beneficiary = profit_total - arb_profit_treasury;

            if (arb_profit_treasury > 0) primary_fungible_store::deposit(TREASURY, fungible_asset::extract(&mut fa_arb_result, arb_profit_treasury));
            if (arb_profit_beneficiary > 0) primary_fungible_store::deposit(beneficiary, fungible_asset::extract(&mut fa_arb_result, arb_profit_beneficiary));
            primary_fungible_store::deposit(order_addr, fa_arb_result);

            flashloan_logic::pay_flash_loan_simple(order_signer, receipt);

            event::emit(OmniSwapExecuted { user: order_addr, beneficiary, venue: arb_direction, token_in: object::object_address(&token_in), token_out: object::object_address(&token_out), amount_in, amount_out, arb_executed: true, arb_profit_beneficiary, arb_profit_treasury, timestamp: timestamp::now_seconds() });
        } else {
            event::emit(OmniSwapExecuted { user: order_addr, beneficiary, venue: 0, token_in: object::object_address(&token_in), token_out: object::object_address(&token_out), amount_in, amount_out, arb_executed: false, arb_profit_beneficiary: 0, arb_profit_treasury: 0, timestamp: timestamp::now_seconds() });
        };
    }
}
