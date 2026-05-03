// buy_one_sided.move — atomic single-tx "pure YAY" or "pure NAY" exposure.
//
// User commits `amount` of $creator_token. Script atomically:
//   1. opinion::deposit_balanced(amount) → user receives amount YAY + amount NAY
//      (vault grows by amount, pool unchanged, tax burned)
//   2. opinion::swap_<unwanted>_for_<wanted>(unwanted_delta, min_swap_out) →
//      user trades the unwanted side back into the pool for more wanted side
//
// End state: user holds ~2× wanted side for the same collateral, vs single
// `deposit_pick_side` which keeps only 1× wanted side and donates the
// opposite side to pool depth. Both legs revert together if anything fails.
//
// Pre-existing YAY/NAY balance handled via snapshot delta — won't over-
// withdraw user's prior holdings into the swap leg.

script {
    use std::signer;
    use aptos_framework::object;
    use aptos_framework::primary_fungible_store;
    use aptos_framework::fungible_asset::Metadata;
    use desnet::opinion;

    fun buy_one_sided(
        user: &signer,
        author_pid: address,
        seq: u64,
        amount: u64,         // collateral committed (raw $creator_token)
        min_swap_out: u64,   // slippage floor on the swap leg (raw)
        pure_yay: bool,      // true = keep YAY, swap NAY → YAY; false = mirror
    ) {
        let user_addr = signer::address_of(user);

        // Resolve YAY / NAY metadata addrs via the public view.
        let (yay_meta_addr, nay_meta_addr) = opinion::token_addrs(author_pid, seq);
        let yay_meta = object::address_to_object<Metadata>(yay_meta_addr);
        let nay_meta = object::address_to_object<Metadata>(nay_meta_addr);

        // Snapshot pre-deposit balances. Delta after deposit_balanced tells us
        // exactly how much YAY/NAY this script's leg-1 produced — protects
        // against over-withdrawing pre-existing user holdings into the swap.
        let yay_before = primary_fungible_store::balance(user_addr, yay_meta);
        let nay_before = primary_fungible_store::balance(user_addr, nay_meta);

        // Leg 1: deposit_balanced — vault +amount, mint amount YAY + amount NAY
        // both to user, pool reserves unchanged. Tax of amount × tax_bps / 10000
        // burned from user's $creator_token.
        opinion::deposit_balanced(user, author_pid, seq, amount);

        // Leg 2: swap the unwanted side back into the pool. Slippage floor
        // (min_swap_out) protects against pool moving between simulation and
        // submit. Tax on the swap is computed against spot-equivalent of input,
        // burned from user's $creator_token (separate from amount_in).
        if (pure_yay) {
            // Keep YAY, swap NAY for more YAY.
            let nay_delta = primary_fungible_store::balance(user_addr, nay_meta) - nay_before;
            opinion::swap_nay_for_yay(user, author_pid, seq, nay_delta, min_swap_out);
        } else {
            // Keep NAY, swap YAY for more NAY.
            let yay_delta = primary_fungible_store::balance(user_addr, yay_meta) - yay_before;
            opinion::swap_yay_for_nay(user, author_pid, seq, yay_delta, min_swap_out);
        };
    }
}
