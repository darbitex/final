#[test_only]
module darbitex_factory::token_tests {
    use std::signer;
    use aptos_framework::account;
    use aptos_framework::aptos_coin;
    use aptos_framework::coin;
    use aptos_framework::fungible_asset::{Self, Metadata};
    use aptos_framework::object;
    use aptos_framework::primary_fungible_store;

    use darbitex_factory::token;

    const TOTAL_SUPPLY: u64 = 100_000_000_000_000_000;
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;

    fun setup_with_apt(aptos: &signer, factory: &signer, creator: &signer, apt_amount: u64) {
        account::create_account_for_test(signer::address_of(factory));
        account::create_account_for_test(signer::address_of(creator));
        account::create_account_for_test(TREASURY);

        let (burn_cap, mint_cap) = aptos_coin::initialize_for_test(aptos);
        coin::register<aptos_coin::AptosCoin>(creator);
        coin::register<aptos_coin::AptosCoin>(factory);
        let coins = coin::mint<aptos_coin::AptosCoin>(apt_amount, &mint_cap);
        coin::deposit(signer::address_of(creator), coins);
        coin::destroy_burn_cap(burn_cap);
        coin::destroy_mint_cap(mint_cap);

        token::init_factory(factory);
    }

    fun setup(aptos: &signer, factory: &signer, creator: &signer) {
        setup_with_apt(aptos, factory, creator, 200_000_000_000);
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    fun create_token_happy_path(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        let creator_addr = signer::address_of(creator);

        token::create_token(creator, b"Darbitex Token", b"DARB");

        assert!(token::token_exists(b"DARB"), 100);
        let addr = token::token_address(b"DARB");
        let meta = object::address_to_object<Metadata>(addr);
        let balance = primary_fungible_store::balance(creator_addr, meta);
        assert!(balance == TOTAL_SUPPLY, 101);
        assert!(fungible_asset::name(meta) == std::string::utf8(b"Darbitex Token"), 102);
        assert!(fungible_asset::symbol(meta) == std::string::utf8(b"DARB"), 103);
        assert!(fungible_asset::decimals(meta) == 8, 104);
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    fun tiered_fee_1_char(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        let apt_meta = object::address_to_object<Metadata>(@0xa);
        let before = primary_fungible_store::balance(TREASURY, apt_meta);
        token::create_token(creator, b"One Char", b"X");
        let after = primary_fungible_store::balance(TREASURY, apt_meta);
        assert!(after - before == 100_000_000_000, 150); // 1000 APT
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    fun tiered_fee_3_chars(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        let apt_meta = object::address_to_object<Metadata>(@0xa);
        let before = primary_fungible_store::balance(TREASURY, apt_meta);
        token::create_token(creator, b"Three", b"BTC");
        let after = primary_fungible_store::balance(TREASURY, apt_meta);
        assert!(after - before == 1_000_000_000, 151); // 10 APT
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    fun tiered_fee_5_plus_chars(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        let apt_meta = object::address_to_object<Metadata>(@0xa);
        let before = primary_fungible_store::balance(TREASURY, apt_meta);
        token::create_token(creator, b"Long Name", b"LONGTOKEN");
        let after = primary_fungible_store::balance(TREASURY, apt_meta);
        assert!(after - before == 10_000_000, 152); // 0.1 APT
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    fun get_creation_fee_view(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        assert!(token::get_creation_fee(b"X") == 100_000_000_000, 160);
        assert!(token::get_creation_fee(b"AB") == 10_000_000_000, 161);
        assert!(token::get_creation_fee(b"BTC") == 1_000_000_000, 162);
        assert!(token::get_creation_fee(b"DARB") == 100_000_000, 163);
        assert!(token::get_creation_fee(b"LONG1") == 10_000_000, 164);
        assert!(token::get_creation_fee(b"VERYLONGNAME") == 10_000_000, 165);
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    #[expected_failure]
    fun duplicate_symbol_aborts(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        token::create_token(creator, b"Token A", b"SAME");
        token::create_token(creator, b"Token B", b"SAME");
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    #[expected_failure(abort_code = 4, location = darbitex_factory::token)]
    fun empty_name_aborts(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        token::create_token(creator, b"", b"DARB");
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    #[expected_failure(abort_code = 3, location = darbitex_factory::token)]
    fun empty_symbol_aborts(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        token::create_token(creator, b"Token", b"");
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    fun burn_reduces_supply(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        let creator_addr = signer::address_of(creator);

        token::create_token(creator, b"Burnable", b"BURN");
        let addr = token::token_address(b"BURN");
        let meta = object::address_to_object<Metadata>(addr);

        let before = primary_fungible_store::balance(creator_addr, meta);
        let burn_amount: u64 = 1_000_000_000_000;
        token::burn(creator, meta, burn_amount);
        let after = primary_fungible_store::balance(creator_addr, meta);

        assert!(after == before - burn_amount, 200);
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B, bob = @0xA11CE)]
    fun transfer_works(aptos: &signer, factory: &signer, creator: &signer, bob: &signer) {
        setup(aptos, factory, creator);
        account::create_account_for_test(signer::address_of(bob));
        let creator_addr = signer::address_of(creator);
        let bob_addr = signer::address_of(bob);

        token::create_token(creator, b"Sendable", b"SEND");
        let addr = token::token_address(b"SEND");
        let meta = object::address_to_object<Metadata>(addr);

        let send_amount: u64 = 50_000_000_000_000_000;
        primary_fungible_store::transfer(creator, meta, bob_addr, send_amount);

        assert!(primary_fungible_store::balance(creator_addr, meta) == TOTAL_SUPPLY - send_amount, 300);
        assert!(primary_fungible_store::balance(bob_addr, meta) == send_amount, 301);
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    #[expected_failure(abort_code = 6, location = darbitex_factory::token)]
    fun emoji_symbol_aborts(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        token::create_token(creator, b"Emoji Token", b"\xf0\x9f\x94\xa5"); // 🔥
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    #[expected_failure(abort_code = 6, location = darbitex_factory::token)]
    fun space_in_symbol_aborts(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        token::create_token(creator, b"Space Token", b" APT");
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    fun token_not_exists_before_create(aptos: &signer, factory: &signer, creator: &signer) {
        setup(aptos, factory, creator);
        assert!(!token::token_exists(b"NOPE"), 400);
    }

    #[test(aptos = @0x1, factory = @darbitex_factory, creator = @0xB0B)]
    #[expected_failure]
    fun create_without_apt_aborts(aptos: &signer, factory: &signer, creator: &signer) {
        account::create_account_for_test(signer::address_of(factory));
        account::create_account_for_test(signer::address_of(creator));
        account::create_account_for_test(TREASURY);
        let (burn_cap, mint_cap) = aptos_coin::initialize_for_test(aptos);
        coin::register<aptos_coin::AptosCoin>(creator);
        coin::destroy_burn_cap(burn_cap);
        coin::destroy_mint_cap(mint_cap);
        token::init_factory(factory);
        // Creator has 0 APT — should abort on fee withdrawal
        token::create_token(creator, b"Broke", b"BROKE");
    }
}
