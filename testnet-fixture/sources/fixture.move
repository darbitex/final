/// Testnet-only fixture: create two fungible assets (TX and TY) and
/// expose a mint entry so the deployer can seed pools + user wallets
/// for smoke-testing darbitex-final and satellites on testnet.
///
/// NOT for mainnet. Zero access control beyond single-admin on init.

module testnet_fixture::fixture {
    use std::signer;
    use std::option;
    use std::string;
    use aptos_framework::fungible_asset::{Self, Metadata, MintRef};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;

    struct Registry has key {
        meta_x: Object<Metadata>,
        meta_y: Object<Metadata>,
        mint_x: MintRef,
        mint_y: MintRef,
    }

    const E_ALREADY_INIT: u64 = 1;
    const E_NOT_INIT: u64 = 2;

    public entry fun init_fixture(admin: &signer) {
        let admin_addr = signer::address_of(admin);
        assert!(!exists<Registry>(admin_addr), E_ALREADY_INIT);

        let (meta_x, mint_x) = create_fa(admin, b"tx_token", b"Testnet X", b"TX");
        let (meta_y, mint_y) = create_fa(admin, b"ty_token", b"Testnet Y", b"TY");

        move_to(admin, Registry { meta_x, meta_y, mint_x, mint_y });
    }

    fun create_fa(
        admin: &signer,
        seed: vector<u8>,
        name: vector<u8>,
        symbol: vector<u8>,
    ): (Object<Metadata>, MintRef) {
        let ctor = object::create_named_object(admin, seed);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &ctor,
            option::none(),
            string::utf8(name),
            string::utf8(symbol),
            8,
            string::utf8(b""),
            string::utf8(b""),
        );
        let mint_ref = fungible_asset::generate_mint_ref(&ctor);
        let metadata = object::object_from_constructor_ref<Metadata>(&ctor);
        (metadata, mint_ref)
    }

    public entry fun mint_both(
        admin: &signer,
        recipient: address,
        amount: u64,
    ) acquires Registry {
        let admin_addr = signer::address_of(admin);
        assert!(exists<Registry>(admin_addr), E_NOT_INIT);
        let reg = borrow_global<Registry>(admin_addr);
        primary_fungible_store::mint(&reg.mint_x, recipient, amount);
        primary_fungible_store::mint(&reg.mint_y, recipient, amount);
    }

    #[view]
    public fun meta_x(admin_addr: address): Object<Metadata> acquires Registry {
        borrow_global<Registry>(admin_addr).meta_x
    }

    #[view]
    public fun meta_y(admin_addr: address): Object<Metadata> acquires Registry {
        borrow_global<Registry>(admin_addr).meta_y
    }
}
