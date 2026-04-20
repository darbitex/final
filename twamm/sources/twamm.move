module darbitex_twamm::executor {
    use std::signer;
    use std::vector;
    use aptos_framework::event;
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::object::{Self, Object, ExtendRef};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool;
    use darbitex_twamm::bridge;

    // ===== Errors =====
    const E_NOT_AUTHORIZED: u64 = 1;
    const E_TIME_NOT_ADVANCED: u64 = 2; // Renamed from E_ORDER_EXPIRED (value preserved for indexer compat)
    const E_NO_ORDER: u64 = 3;
    const E_NOT_ADMIN: u64 = 4;
    // const E_STALE_ORACLE: u64 = 5; // Removed v0.2.0 — auto-refresh in execute_virtual_order replaces stale abort
    const E_AMOUNT_TOO_SMALL: u64 = 6;
    const E_INSUFFICIENT_OUT: u64 = 7;
    const E_ALREADY_INITIALIZED: u64 = 8;
    const E_POOL_NOT_FOUND: u64 = 9;
    const E_NOT_OWNER: u64 = 10;

    // ===== Constants =====

    const MAX_ORACLE_AGE: u64 = 300; // 5 minutes
    const MAX_EMA_DEVIATION: u128 = 5;
    const MIN_OUTPUT_PCT: u64 = 95;

    // ===== State =====

    struct LongTermOrder has key {
        token_in: Object<Metadata>,
        token_out: Object<Metadata>,
        total_amount_in: u64,
        remaining_amount_in: u64,
        start_time: u64,
        end_time: u64,
        last_executed_time: u64,
        owner: address,
        extend_ref: ExtendRef,
    }

    struct EmaOracle has key {
        reserve_in: u128,
        reserve_out: u128,
        last_timestamp: u64,
    }

    struct AdminState has key {
        keeper_whitelist: vector<address>,
    }

    #[event]
    struct VirtualOrderExecuted has drop, store {
        owner: address,
        token_in: address,
        token_out: address,
        amount_in: u64,
        amount_out: u64,
        timestamp: u64,
    }

    #[event]
    struct AdminActionExecuted has drop, store {
        action_type: u8, // 1=AddKeeper, 2=RemoveKeeper, 3=ForceOracle
        actor: address,
        target: address,
        timestamp: u64,
    }

    #[event]
    struct OrderCancelled has drop, store {
        owner: address,
        order_address: address,
        token_in_refunded: u64,
        token_out_delivered: u64,
        timestamp: u64,
    }

    #[event]
    struct OrderCreated has drop, store {
        owner: address,
        order_address: address,
        token_in: address,
        token_out: address,
        amount_in: u64,
        duration_seconds: u64,
        start_time: u64,
        end_time: u64,
        timestamp: u64,
    }

    #[event]
    struct OracleRefreshed has drop, store {
        caller: address,
        darbitex_pool: address,
        reserve_in: u128,
        reserve_out: u128,
        timestamp: u64,
    }

    // ===== Admin & Oracle Functions =====

    fun init_module(admin: &signer) {
        move_to(admin, AdminState { keeper_whitelist: vector::empty() });
    }

    public entry fun add_keeper(admin: &signer, keeper: address) acquires AdminState {
        assert!(signer::address_of(admin) == @darbitex_twamm, E_NOT_ADMIN);
        let state = borrow_global_mut<AdminState>(@darbitex_twamm);
        if (!vector::contains(&state.keeper_whitelist, &keeper)) {
            vector::push_back(&mut state.keeper_whitelist, keeper);
        };
        event::emit(AdminActionExecuted { action_type: 1, actor: signer::address_of(admin), target: keeper, timestamp: timestamp::now_seconds() });
    }

    public entry fun remove_keeper(admin: &signer, keeper: address) acquires AdminState {
        assert!(signer::address_of(admin) == @darbitex_twamm, E_NOT_ADMIN);
        let state = borrow_global_mut<AdminState>(@darbitex_twamm);
        let (found, index) = vector::index_of(&state.keeper_whitelist, &keeper);
        if (found) {
            vector::remove(&mut state.keeper_whitelist, index);
        };
        event::emit(AdminActionExecuted { action_type: 2, actor: signer::address_of(admin), target: keeper, timestamp: timestamp::now_seconds() });
    }

    public entry fun init_ema_oracle(
        account: &signer,
        initial_reserve_in: u128,
        initial_reserve_out: u128,
    ) {
        let addr = signer::address_of(account);
        assert!(addr == @darbitex_twamm, E_NOT_ADMIN);
        assert!(initial_reserve_in > 0 && initial_reserve_out > 0, E_AMOUNT_TOO_SMALL);

        if (!exists<EmaOracle>(addr)) {
            move_to(account, EmaOracle {
                reserve_in: initial_reserve_in,
                reserve_out: initial_reserve_out,
                last_timestamp: timestamp::now_seconds(),
            });
        };
    }

    public entry fun force_update_oracle(
        admin: &signer,
        reserve_in: u128,
        reserve_out: u128,
    ) acquires EmaOracle {
        assert!(signer::address_of(admin) == @darbitex_twamm, E_NOT_ADMIN);
        assert!(reserve_in > 0 && reserve_out > 0, E_AMOUNT_TOO_SMALL);
        let oracle = borrow_global_mut<EmaOracle>(@darbitex_twamm);
        oracle.reserve_in = reserve_in;
        oracle.reserve_out = reserve_out;
        oracle.last_timestamp = timestamp::now_seconds();
        event::emit(AdminActionExecuted { action_type: 3, actor: signer::address_of(admin), target: @darbitex_twamm, timestamp: timestamp::now_seconds() });
    }

    // Note: stale oracle is auto-recovered inside execute_virtual_order
    // (see v0.2.0 auto-refresh block). No standalone permissionless entry
    // because wrong-pair pool supplied by arbitrary caller would be a DDoS
    // vector. Keeper whitelist + keeper-supplied darbitex_arb_pool (same
    // one used for MEV calc) is the trust boundary.

    public entry fun init_ema_from_pool(
        account: &signer,
        darbitex_pool: address,
        token_in: Object<Metadata>,
    ) {
        assert!(signer::address_of(account) == @darbitex_twamm, E_NOT_ADMIN);
        assert!(!exists<EmaOracle>(@darbitex_twamm), E_ALREADY_INITIALIZED);
        assert!(pool::pool_exists(darbitex_pool), E_POOL_NOT_FOUND);

        let (res_a, res_b) = pool::reserves(darbitex_pool);
        let (meta_a, _) = pool::pool_tokens(darbitex_pool);
        let (r_in, r_out) = if (
            object::object_address(&token_in) == object::object_address(&meta_a)
        ) {
            (res_a, res_b)
        } else {
            (res_b, res_a)
        };

        assert!(r_in > 0 && r_out > 0, E_AMOUNT_TOO_SMALL);

        if (!exists<EmaOracle>(@darbitex_twamm)) {
            move_to(account, EmaOracle {
                reserve_in: (r_in as u128),
                reserve_out: (r_out as u128),
                last_timestamp: timestamp::now_seconds(),
            });
        }
    }

    // ===== Order Functions =====

    public entry fun create_order(
        user: &signer,
        token_in: Object<Metadata>,
        token_out: Object<Metadata>,
        amount_in: u64,
        duration_seconds: u64,
    ) {
        assert!(amount_in > 0, E_AMOUNT_TOO_SMALL);
        assert!(duration_seconds > 0, E_AMOUNT_TOO_SMALL);
        let user_addr = signer::address_of(user);
        let constructor_ref = object::create_object(user_addr);
        let extend_ref = object::generate_extend_ref(&constructor_ref);
        let order_signer = object::generate_signer(&constructor_ref);

        let fa_in = primary_fungible_store::withdraw(user, token_in, amount_in);
        primary_fungible_store::deposit(signer::address_of(&order_signer), fa_in);

        let now = timestamp::now_seconds();
        let order_address = signer::address_of(&order_signer);
        move_to(&order_signer, LongTermOrder {
            token_in,
            token_out,
            total_amount_in: amount_in,
            remaining_amount_in: amount_in,
            start_time: now,
            end_time: now + duration_seconds,
            last_executed_time: now,
            owner: user_addr,
            extend_ref,
        });
        event::emit(OrderCreated {
            owner: user_addr,
            order_address,
            token_in: object::object_address(&token_in),
            token_out: object::object_address(&token_out),
            amount_in,
            duration_seconds,
            start_time: now,
            end_time: now + duration_seconds,
            timestamp: now,
        });
    }

    /// Owner-gated escape hatch. Sweeps remaining token_in + any undelivered
    /// token_out back to the original owner and marks the order inert
    /// (remaining_amount_in = 0), preventing further keeper execution.
    /// Closes the external-pause cascade: if Thala/Aave goes down for hours
    /// the owner can recover their capital without waiting on a fix.
    public entry fun cancel_order(
        user: &signer,
        order_address: address,
    ) acquires LongTermOrder {
        let order = borrow_global_mut<LongTermOrder>(order_address);
        assert!(signer::address_of(user) == order.owner, E_NOT_OWNER);
        // Idempotent guard — reject cancel on already-cancelled/completed order
        assert!(order.remaining_amount_in > 0, E_NO_ORDER);

        let order_signer = object::generate_signer_for_extending(&order.extend_ref);

        let bal_in = primary_fungible_store::balance(order_address, order.token_in);
        if (bal_in > 0) {
            let fa_in = primary_fungible_store::withdraw(&order_signer, order.token_in, bal_in);
            primary_fungible_store::deposit(order.owner, fa_in);
        };

        let bal_out = primary_fungible_store::balance(order_address, order.token_out);
        if (bal_out > 0) {
            let fa_out = primary_fungible_store::withdraw(&order_signer, order.token_out, bal_out);
            primary_fungible_store::deposit(order.owner, fa_out);
        };

        order.remaining_amount_in = 0;

        event::emit(OrderCancelled {
            owner: order.owner,
            order_address,
            token_in_refunded: bal_in,
            token_out_delivered: bal_out,
            timestamp: timestamp::now_seconds(),
        });
    }

    public entry fun execute_virtual_order(
        keeper: &signer,
        order_address: address,
        thala_pool: address,
        darbitex_arb_pool: address,
    ) acquires LongTermOrder, EmaOracle, AdminState {
        let keeper_addr = signer::address_of(keeper);
        let state = borrow_global<AdminState>(@darbitex_twamm);
        assert!(vector::contains(&state.keeper_whitelist, &keeper_addr), E_NOT_AUTHORIZED);

        let order = borrow_global_mut<LongTermOrder>(order_address);
        let now = timestamp::now_seconds();

        assert!(now > order.last_executed_time, E_TIME_NOT_ADVANCED);
        assert!(order.remaining_amount_in > 0, E_NO_ORDER);

        let time_elapsed = now - order.last_executed_time;
        let time_total = order.end_time - order.start_time;

        let amount_to_swap = if (now >= order.end_time) {
            order.remaining_amount_in
        } else {
            let swap_u128 = (order.total_amount_in as u128) * (time_elapsed as u128) / (time_total as u128);
            if (swap_u128 > (order.remaining_amount_in as u128)) {
                order.remaining_amount_in
            } else {
                (swap_u128 as u64)
            }
        };

        if (amount_to_swap == 0) return;

        order.remaining_amount_in = order.remaining_amount_in - amount_to_swap;
        order.last_executed_time = now;

        let oracle = borrow_global_mut<EmaOracle>(@darbitex_twamm);

        // v0.2.0 auto-refresh: if oracle stale, read darbitex_arb_pool (same
        // pool used below for MEV calc + blend) and reset. Keeper whitelist
        // at the top of this function is the trust gate — no new attacker
        // surface, no 3/5 multisig coordination needed for stale recovery.
        if (now - oracle.last_timestamp > MAX_ORACLE_AGE) {
            let (res_a, res_b) = pool::reserves(darbitex_arb_pool);
            let (meta_a, _) = pool::pool_tokens(darbitex_arb_pool);
            let is_in_a = (object::object_address(&order.token_in) == object::object_address(&meta_a));
            let (r_in, r_out) = if (is_in_a) { (res_a, res_b) } else { (res_b, res_a) };
            assert!(r_in > 0 && r_out > 0, E_AMOUNT_TOO_SMALL);
            oracle.reserve_in = (r_in as u128);
            oracle.reserve_out = (r_out as u128);
            oracle.last_timestamp = now;
            event::emit(OracleRefreshed {
                caller: keeper_addr,
                darbitex_pool: darbitex_arb_pool,
                reserve_in: (r_in as u128),
                reserve_out: (r_out as u128),
                timestamp: now,
            });
        };

        let order_signer = object::generate_signer_for_extending(&order.extend_ref);

        let min_implied_out = (
            (amount_to_swap as u128) * oracle.reserve_out / oracle.reserve_in
        );
        let min_out = ((min_implied_out * (MIN_OUTPUT_PCT as u128) / 100) as u64);

        let bal_before = primary_fungible_store::balance(order_address, order.token_out);

        // Call Bridge with TWAMM Oracle
        bridge::omni_swap_thala_twamm(
            &order_signer,
            order.token_in,
            amount_to_swap,
            order.token_out,
            (min_out * 90 / 100),
            thala_pool,
            darbitex_arb_pool,
            order_address,
            oracle.reserve_in,
            oracle.reserve_out,
            now + 60,
        );

        let bal_after = primary_fungible_store::balance(order_address, order.token_out);
        let actual_amount_out = bal_after - bal_before;

        assert!(actual_amount_out >= min_out, E_INSUFFICIENT_OUT);

        // MIN_SWAP_FOR_EMA removed in v0.2.0 — `ratio_ok` 5× gate + 10% smoothing + keeper whitelist provide sufficient manipulation bound. Removing the floor lets small-chunk TWAMM orders (0.00001 APT/tick scale) keep oracle fresh organically.
        if (actual_amount_out > 0) {
            let spot_cross = (actual_amount_out as u256) * (oracle.reserve_in as u256);
            let ema_cross = (oracle.reserve_out as u256) * (amount_to_swap as u256);

            let ratio_ok = spot_cross <= ema_cross * (MAX_EMA_DEVIATION as u256)
                        && spot_cross * (MAX_EMA_DEVIATION as u256) >= ema_cross;

            if (ratio_ok) {
                let (res_a, res_b) = pool::reserves(darbitex_arb_pool);
                let (meta_a, _) = pool::pool_tokens(darbitex_arb_pool);
                let is_in_a = (object::object_address(&order.token_in) == object::object_address(&meta_a));
                let (pool_r_in, pool_r_out) = if (is_in_a) { (res_a, res_b) } else { (res_b, res_a) };

                oracle.reserve_in = ((oracle.reserve_in * 9 + (pool_r_in as u128)) / 10);
                oracle.reserve_out = ((oracle.reserve_out * 9 + (pool_r_out as u128)) / 10);
                oracle.last_timestamp = now;
            };
        };

        event::emit(VirtualOrderExecuted {
            owner: order.owner,
            token_in: object::object_address(&order.token_in),
            token_out: object::object_address(&order.token_out),
            amount_in: amount_to_swap,
            amount_out: actual_amount_out,
            timestamp: now,
        });

        if (actual_amount_out > 0) {
            let fa_out = primary_fungible_store::withdraw(&order_signer, order.token_out, actual_amount_out);
            primary_fungible_store::deposit(order.owner, fa_out);
        };

        if (order.remaining_amount_in == 0) {
            let dust_out = primary_fungible_store::balance(order_address, order.token_out);
            if (dust_out > 0) {
                let fa_dust = primary_fungible_store::withdraw(&order_signer, order.token_out, dust_out);
                primary_fungible_store::deposit(order.owner, fa_dust);
            };
            let dust_in = primary_fungible_store::balance(order_address, order.token_in);
            if (dust_in > 0) {
                let fa_dust = primary_fungible_store::withdraw(&order_signer, order.token_in, dust_in);
                primary_fungible_store::deposit(order.owner, fa_dust);
            };
        }
    }
}
