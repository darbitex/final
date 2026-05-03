// arb_apt_through_desnet.move — atomic 2-leg APT arb between DeSNet AMM
// and Darbitex AMM. Compile to .mv bytecode, bundle in frontend, submit as
// one-off Move script tx. No deployed package required.
//
// Direction:
//   desnet_first=true   : APT in → DeSNet → $TOKEN → Darbitex → APT out
//   desnet_first=false  : APT in → Darbitex → $TOKEN → DeSNet → APT out
//
// Atomicity: single tx, abort reverts both legs. User pays apt_in upfront
// from their primary store; script asserts final APT delta ≥ apt_in + min_profit
// before completing. Pre-existing $TOKEN balance handled via snapshot delta —
// withdraw only the amount this script's leg-1 produced, not whatever the
// user already had.
//
// Slippage: per-leg min_out gates plus the global min_profit floor.

script {
    use std::signer;
    use aptos_framework::object;
    use aptos_framework::primary_fungible_store;
    use aptos_framework::fungible_asset::{Self, Metadata};
    use desnet::amm as desnet_amm;
    use darbitex::pool as darbitex_pool;

    /// APT FA metadata addr (canonical 0xa with leading zeros).
    const APT_FA_ADDR: address =
        @0x000000000000000000000000000000000000000000000000000000000000000a;

    /// Local script-side abort codes. Kept in the 200 range to avoid visual
    /// collision with module errors.
    const E_NEGATIVE_PROFIT: u64 = 200;       // final APT < initial APT (arb lost money)
    const E_BELOW_MIN_PROFIT: u64 = 201;      // profitable but below caller's min_profit floor

    fun arb_apt_through_desnet(
        user: &signer,
        desnet_handle: vector<u8>,         // bytes — e.g. b"desnet" → DeSNet pool selector
        darbitex_pool_addr: address,        // Darbitex pool object addr (APT/$TOKEN)
        token_meta_addr: address,           // $TOKEN FA metadata addr
        apt_in: u64,                        // raw APT (octa) to commit upfront
        min_token_mid: u64,                 // slippage on leg 1 — minimum $TOKEN out
        min_apt_out: u64,                   // slippage on leg 2 — minimum APT out
        min_profit: u64,                    // global floor — final APT - apt_in must be ≥ this
        desnet_first: bool,                 // true = DeSNet first then Darbitex; false = reverse
    ) {
        let user_addr = signer::address_of(user);
        let token_meta = object::address_to_object<Metadata>(token_meta_addr);
        let apt_meta = object::address_to_object<Metadata>(APT_FA_ADDR);

        // Snapshot balances before — needed because:
        //   1. Profit check must measure DELTA, not absolute (user may have other APT)
        //   2. Token balance delta tells us how much $TOKEN this script's leg-1
        //      actually produced (so we don't over-withdraw pre-existing user tokens
        //      into leg 2).
        let apt_balance_before = primary_fungible_store::balance(user_addr, apt_meta);
        let token_balance_before = primary_fungible_store::balance(user_addr, token_meta);

        if (desnet_first) {
            // Leg 1: APT → $TOKEN via DeSNet. Pulls APT from user's primary store,
            // deposits $TOKEN to user's primary store. min_token_mid enforced inside.
            desnet_amm::swap_apt_for_token(user, desnet_handle, apt_in, min_token_mid);

            // Leg 2: $TOKEN → APT via Darbitex pool::swap (FA-in/FA-out). Use the
            // delta produced by leg 1 (not the full token store balance — preserves
            // any pre-existing user holdings).
            let token_balance_mid = primary_fungible_store::balance(user_addr, token_meta);
            let token_delta = token_balance_mid - token_balance_before;
            let token_fa = primary_fungible_store::withdraw(user, token_meta, token_delta);
            let apt_fa = darbitex_pool::swap(darbitex_pool_addr, user_addr, token_fa, min_apt_out);
            primary_fungible_store::deposit(user_addr, apt_fa);
        } else {
            // Leg 1: APT → $TOKEN via Darbitex.
            let apt_fa = primary_fungible_store::withdraw(user, apt_meta, apt_in);
            let token_fa = darbitex_pool::swap(darbitex_pool_addr, user_addr, apt_fa, min_token_mid);
            let token_amount = fungible_asset::amount(&token_fa);
            primary_fungible_store::deposit(user_addr, token_fa);

            // Leg 2: $TOKEN → APT via DeSNet. swap_token_for_apt pulls from primary
            // store, so deposit the FA first, then call. amount_in = exactly the
            // token_amount produced by leg 1.
            desnet_amm::swap_token_for_apt(user, desnet_handle, token_amount, min_apt_out);
        };

        // Profit check: final APT delta must be positive AND meet min_profit floor.
        let apt_balance_after = primary_fungible_store::balance(user_addr, apt_meta);
        assert!(apt_balance_after >= apt_balance_before, E_NEGATIVE_PROFIT);
        let profit = apt_balance_after - apt_balance_before;
        assert!(profit >= min_profit, E_BELOW_MIN_PROFIT);
    }
}
