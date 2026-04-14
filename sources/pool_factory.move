/// Darbitex — pool factory.
///
/// Creates canonical pools (one per sorted pair, deterministic
/// named-object address). Maintains a global asset→pools index used by
/// `arbitrage` for sister-pool discovery. Pure primitives + minimum
/// readers. No admin surface. The pool module owns the creation event
/// stream; the factory does not re-emit.

module darbitex::pool_factory {
    use std::signer;
    use std::vector;
    use std::bcs;
    use aptos_std::table::{Self, Table};
    use aptos_framework::account::{Self, SignerCapability};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::primary_fungible_store;

    use darbitex::pool;

    const FACTORY_SEED: vector<u8> = b"darbitex_factory";
    const POOL_SEED_PREFIX: vector<u8> = b"darbitex_pool";

    /// Hard cap on the per-call page size for `pools_containing_asset`.
    /// Bounds the per-call copy cost of the reverse index to a small
    /// constant regardless of how many pools reference any one asset.
    /// No cap on TOTAL pools per asset — callers (the arbitrage
    /// module and off-chain readers) paginate through the full set
    /// by looping `offset` if the page is saturated.
    const MAX_PAGE: u64 = 10;

    const E_NOT_ADMIN: u64 = 1;
    const E_ALREADY_INIT: u64 = 2;
    const E_NOT_INIT: u64 = 3;
    const E_WRONG_ORDER: u64 = 4;
    const E_ZERO: u64 = 5;

    /// Singleton at @darbitex. Owns the resource account under which all
    /// pool objects live and holds the asset→pools reverse index.
    struct Factory has key {
        signer_cap: SignerCapability,
        factory_addr: address,
        pool_addresses: vector<address>,
        /// Asset metadata address → list of pool addresses containing
        /// that asset as one of the two sides. Read via paginated
        /// `pools_containing_asset(asset, offset, limit)` to bound
        /// per-call copy cost.
        asset_index: Table<address, vector<address>>,
    }

    /// Require the pair in canonical sorted order (BCS byte order).
    fun assert_sorted(metadata_a: Object<Metadata>, metadata_b: Object<Metadata>) {
        let ba = bcs::to_bytes(&object::object_address(&metadata_a));
        let bb = bcs::to_bytes(&object::object_address(&metadata_b));
        assert!(ba < bb, E_WRONG_ORDER);
    }

    /// Deterministic seed from two raw asset addresses in the order
    /// supplied. Callers are responsible for passing them in canonical
    /// (BCS-sorted) order.
    fun derive_pair_seed_addrs(
        asset_a: address,
        asset_b: address,
    ): vector<u8> {
        let seed = POOL_SEED_PREFIX;
        vector::append(&mut seed, bcs::to_bytes(&asset_a));
        vector::append(&mut seed, bcs::to_bytes(&asset_b));
        seed
    }

    /// Object-typed convenience wrapper over `derive_pair_seed_addrs`.
    fun derive_pair_seed(
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
    ): vector<u8> {
        derive_pair_seed_addrs(
            object::object_address(&metadata_a),
            object::object_address(&metadata_b),
        )
    }

    /// Insert `pool_addr` into `asset_index[asset]`, creating the
    /// bucket on first touch. No cap on bucket length — ecosystem
    /// growth must not be gated by the factory. Arbitrage DFS
    /// paginates through the full bucket via MAX_PAGE-sized reads.
    fun index_asset(
        asset_index: &mut Table<address, vector<address>>,
        asset: address,
        pool_addr: address,
    ) {
        if (!table::contains(asset_index, asset)) {
            let v = vector::empty<address>();
            vector::push_back(&mut v, pool_addr);
            table::add(asset_index, asset, v);
        } else {
            let v = table::borrow_mut(asset_index, asset);
            vector::push_back(v, pool_addr);
        }
    }

    /// One-shot initializer. Called by the package publisher (`@darbitex`)
    /// once, immediately after publish.
    public entry fun init_factory(deployer: &signer) {
        assert!(signer::address_of(deployer) == @darbitex, E_NOT_ADMIN);
        assert!(!exists<Factory>(@darbitex), E_ALREADY_INIT);

        let (factory_signer, signer_cap) = account::create_resource_account(deployer, FACTORY_SEED);
        let factory_addr = signer::address_of(&factory_signer);

        move_to(deployer, Factory {
            signer_cap,
            factory_addr,
            pool_addresses: vector::empty(),
            asset_index: table::new(),
        });
    }

    /// Atomic canonical pool creation. Caller supplies seeding tokens
    /// with independent `amount_a`/`amount_b` — initial ratio is set by
    /// creator. Duplicate protection via `create_named_object` abort.
    public entry fun create_canonical_pool(
        creator: &signer,
        metadata_a: Object<Metadata>,
        metadata_b: Object<Metadata>,
        amount_a: u64,
        amount_b: u64,
    ) acquires Factory {
        assert!(exists<Factory>(@darbitex), E_NOT_INIT);
        assert!(amount_a > 0 && amount_b > 0, E_ZERO);
        // `assert_sorted` uses strict `<` on BCS bytes, which also
        // rejects same-token pairs (`bcs(a) < bcs(a)` is false).
        assert_sorted(metadata_a, metadata_b);

        let factory = borrow_global_mut<Factory>(@darbitex);
        let factory_signer = account::create_signer_with_capability(&factory.signer_cap);
        let factory_addr = factory.factory_addr;
        let creator_addr = signer::address_of(creator);

        let fa_a = primary_fungible_store::withdraw(creator, metadata_a, amount_a);
        let fa_b = primary_fungible_store::withdraw(creator, metadata_b, amount_b);
        primary_fungible_store::deposit(factory_addr, fa_a);
        primary_fungible_store::deposit(factory_addr, fa_b);

        let seed = derive_pair_seed(metadata_a, metadata_b);
        let ctor = object::create_named_object(&factory_signer, seed);

        let (pool_addr, _position) = pool::create_pool(
            &factory_signer,
            creator_addr,
            &ctor,
            metadata_a,
            metadata_b,
            amount_a,
            amount_b,
        );

        vector::push_back(&mut factory.pool_addresses, pool_addr);
        index_asset(&mut factory.asset_index, object::object_address(&metadata_a), pool_addr);
        index_asset(&mut factory.asset_index, object::object_address(&metadata_b), pool_addr);
    }

    // ===== Minimal readers =====

    #[view]
    public fun get_all_pools(): vector<address> acquires Factory {
        borrow_global<Factory>(@darbitex).pool_addresses
    }

    // Total number of pools containing `asset` as one of the two sides.
    // Cheap read (no copy). Lets the arbitrage module know whether to
    // paginate a second call when `limit` is saturated.
    #[view]
    public fun pools_containing_asset_count(asset: address): u64 acquires Factory {
        let f = borrow_global<Factory>(@darbitex);
        if (table::contains(&f.asset_index, asset)) {
            vector::length(table::borrow(&f.asset_index, asset))
        } else {
            0
        }
    }

    // Paginated reverse index lookup. Returns at most `min(limit,
    // MAX_PAGE)` pool addresses, starting at `offset` within the
    // asset's pool bucket. Empty if `asset` has no entries or `offset`
    // is past the end. Used by the arbitrage module for sister-pool
    // discovery and by off-chain indexers.
    #[view]
    public fun pools_containing_asset(
        asset: address,
        offset: u64,
        limit: u64,
    ): vector<address> acquires Factory {
        let result = vector::empty<address>();
        let f = borrow_global<Factory>(@darbitex);
        if (!table::contains(&f.asset_index, asset)) return result;

        let bucket = table::borrow(&f.asset_index, asset);
        let len = vector::length(bucket);
        if (offset >= len) return result;

        let capped = if (limit > MAX_PAGE) { MAX_PAGE } else { limit };
        // `remaining` is safe (offset < len is guaranteed above), and
        // `take = min(capped, remaining)` fits in u64 without overflow
        // because `take <= len - offset < len`.
        let remaining = len - offset;
        let take = if (capped > remaining) { remaining } else { capped };

        let i = 0;
        while (i < take) {
            vector::push_back(&mut result, *vector::borrow(bucket, offset + i));
            i = i + 1;
        };
        result
    }

    // Canonical pool address for any two asset metadata addresses,
    // without requiring the pool to exist. Sorts the inputs in BCS
    // byte order internally (caller does not need to pre-sort) and
    // returns the deterministic object address derived from the
    // factory seed + sorted pair. Pure address derivation — callers
    // must check `pool::pool_exists(addr)` before assuming the pool
    // is live.
    //
    // Used by the arbitrage module for O(1) direct-pool lookup when
    // computing the service-charge baseline, replacing a previously
    // O(N) reverse-index scan that could miss direct pools parked
    // past the pagination page size.
    #[view]
    public fun canonical_pool_address_of(
        asset_a: address,
        asset_b: address,
    ): address acquires Factory {
        let ba = bcs::to_bytes(&asset_a);
        let bb = bcs::to_bytes(&asset_b);
        let (sorted_a, sorted_b) = if (ba < bb) {
            (asset_a, asset_b)
        } else {
            (asset_b, asset_a)
        };
        let f = borrow_global<Factory>(@darbitex);
        let seed = derive_pair_seed_addrs(sorted_a, sorted_b);
        object::create_object_address(&f.factory_addr, seed)
    }
}
