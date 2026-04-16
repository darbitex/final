module darbitex_factory::token {
    use std::signer;
    use std::option;
    use std::string;
    use std::vector;
    use aptos_framework::account::{Self, SignerCapability};
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, BurnRef, Metadata};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;

    const DECIMALS: u8 = 8;
    const TOTAL_SUPPLY: u64 = 100_000_000_000_000_000; // 1B × 10^8
    const FACTORY_SEED: vector<u8> = b"darbitex_token_factory";
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;

    const E_NOT_INIT: u64 = 1;
    const E_ALREADY_INIT: u64 = 2;
    const E_EMPTY_SYMBOL: u64 = 3;
    const E_EMPTY_NAME: u64 = 4;
    const E_NO_BURN_CAP: u64 = 5;
    const E_INVALID_SYMBOL: u64 = 6;

    struct Factory has key {
        signer_cap: SignerCapability,
        factory_addr: address,
    }

    struct BurnCap has key {
        burn_ref: BurnRef,
    }

    #[event]
    struct TokenCreated has drop, store {
        creator: address,
        token_addr: address,
        name: string::String,
        symbol: string::String,
        total_supply: u64,
        fee_paid: u64,
    }

    public entry fun init_factory(deployer: &signer) {
        let deployer_addr = signer::address_of(deployer);
        assert!(deployer_addr == @darbitex_factory, E_NOT_INIT);
        assert!(!exists<Factory>(@darbitex_factory), E_ALREADY_INIT);

        let (factory_signer, signer_cap) = account::create_resource_account(deployer, FACTORY_SEED);
        let factory_addr = signer::address_of(&factory_signer);

        move_to(deployer, Factory { signer_cap, factory_addr });
    }

    public entry fun create_token(
        creator: &signer,
        name: vector<u8>,
        symbol: vector<u8>,
    ) acquires Factory {
        assert!(exists<Factory>(@darbitex_factory), E_NOT_INIT);
        let factory = borrow_global<Factory>(@darbitex_factory);
        let factory_signer = account::create_signer_with_capability(&factory.signer_cap);

        assert!(!vector::is_empty(&name), E_EMPTY_NAME);
        assert!(!vector::is_empty(&symbol), E_EMPTY_SYMBOL);

        let i = 0;
        let len = vector::length(&symbol);
        while (i < len) {
            let b = *vector::borrow(&symbol, i);
            assert!(b >= 0x21 && b <= 0x7e, E_INVALID_SYMBOL);
            i = i + 1;
        };

        let fee = creation_fee(vector::length(&symbol));
        let apt_meta = object::address_to_object<Metadata>(@0xa);
        let fa = primary_fungible_store::withdraw(creator, apt_meta, fee);
        primary_fungible_store::deposit(TREASURY, fa);

        let ctor = object::create_named_object(&factory_signer, symbol);
        let token_signer = object::generate_signer(&ctor);
        let token_addr = signer::address_of(&token_signer);

        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &ctor,
            option::some((TOTAL_SUPPLY as u128)),
            string::utf8(name),
            string::utf8(symbol),
            DECIMALS,
            string::utf8(b""),
            string::utf8(b""),
        );

        let mint_ref = fungible_asset::generate_mint_ref(&ctor);
        let burn_ref = fungible_asset::generate_burn_ref(&ctor);

        let creator_addr = signer::address_of(creator);
        primary_fungible_store::mint(&mint_ref, creator_addr, TOTAL_SUPPLY);
        // mint_ref dropped here — no future minting possible

        move_to(&token_signer, BurnCap { burn_ref });

        event::emit(TokenCreated {
            creator: creator_addr,
            token_addr,
            name: string::utf8(name),
            symbol: string::utf8(symbol),
            total_supply: TOTAL_SUPPLY,
            fee_paid: fee,
        });
    }

    public entry fun burn(
        caller: &signer,
        token: Object<Metadata>,
        amount: u64,
    ) acquires BurnCap {
        let token_addr = object::object_address(&token);
        assert!(exists<BurnCap>(token_addr), E_NO_BURN_CAP);

        let cap = borrow_global<BurnCap>(token_addr);
        let fa = primary_fungible_store::withdraw(caller, token, amount);
        fungible_asset::burn(&cap.burn_ref, fa);
    }

    fun creation_fee(symbol_len: u64): u64 {
        if (symbol_len == 1) 100_000_000_000        // 1000 APT
        else if (symbol_len == 2) 10_000_000_000    // 100 APT
        else if (symbol_len == 3) 1_000_000_000     // 10 APT
        else if (symbol_len == 4) 100_000_000       // 1 APT
        else 10_000_000                              // 0.1 APT (5+)
    }

    #[view]
    public fun get_creation_fee(symbol: vector<u8>): u64 {
        creation_fee(vector::length(&symbol))
    }

    #[view]
    public fun token_exists(symbol: vector<u8>): bool acquires Factory {
        let factory = borrow_global<Factory>(@darbitex_factory);
        let addr = object::create_object_address(&factory.factory_addr, symbol);
        object::object_exists<Metadata>(addr)
    }

    #[view]
    public fun token_address(symbol: vector<u8>): address acquires Factory {
        let factory = borrow_global<Factory>(@darbitex_factory);
        object::create_object_address(&factory.factory_addr, symbol)
    }
}
