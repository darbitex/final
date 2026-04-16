# Darbitex Token Factory — External Audit Submission (Round 1)

**Package:** `darbitex_factory`
**Version:** 0.1.0
**Date:** 2026-04-16
**Chain:** Aptos
**Audit package size:** 1 Move source file (`sources/token.move`), 141 LoC, compile-clean with zero warnings
**Previous deploys:** Testnet smoke test at `0x0047a3e1...` — all 3 entries + 3 views + 5 abort paths exercised. Token creation, tiered fee, burn, transfer, duplicate-symbol rejection, zero-supply burn all verified on-chain.
**Planned mainnet publisher:** New 1/5 multisig (same 5 owners as Darbitex Final), raised to 3/5 after smoke test, then **package frozen to immutable** (no future upgrades).

---

## 1. What we are asking from you

You are reviewing a single Move source file for a **minimalist, fire-and-forget token factory** on Aptos. We want an **independent security review** focused on:

1. **Supply integrity** — after `create_token`, exactly 1B tokens exist. `MintRef` is dropped in the same function scope. Verify no path exists to mint additional tokens after creation.
2. **Fee collection correctness** — tiered pricing by symbol length (1000/100/10/1/0.1 APT). Verify fee is always collected before token creation, and that the fee goes to the hardcoded treasury.
3. **Symbol uniqueness** — enforced by `object::create_named_object(factory_signer, symbol)`. Verify this is truly unique and cannot be bypassed.
4. **Burn safety** — `burn()` uses a stored `BurnRef`. Verify callers can only burn their own tokens and cannot burn other users' tokens.
5. **Capability lifecycle** — `MintRef` dropped (no future minting), `BurnRef` stored (self-burn), `TransferRef` not generated (no freeze), `MutateMetadataRef` not generated (immutable metadata). Verify no capability leaks.
6. **FA composability** — tokens created by this factory must be standard Aptos Fungible Assets, composable with any DEX, wallet, bridge. Verify no custom dispatch hooks, no non-standard behavior.
7. **Event completeness** — `TokenCreated` event fields.
8. **Any admin override or trust escape we did not explicitly acknowledge.**

**Output format:**

```
## Findings

### HIGH-1: <title>
Location: token.move:<line>
Description: <what>
Impact: <why it matters>
Recommended fix: <how>

### MEDIUM-1: ...
### LOW-1: ...
### INFORMATIONAL-1: ...

## Design questions we want answered
## Overall verdict (green / yellow / red)
```

---

## 2. Project context

**Darbitex Token Factory** is a satellite for the Darbitex ecosystem on Aptos. It allows anyone to create a standard Fungible Asset token with just a name and symbol. All parameters are hardcoded:

- **Decimals:** 8 (same as APT)
- **Total supply:** 1,000,000,000 (1B) — 100% minted to creator at creation time
- **Post-creation:** MintRef dropped (fixed supply forever), BurnRef stored (anyone can burn their own tokens), no freeze capability, no metadata mutation

The factory charges a **tiered creation fee** based on symbol length (shorter = more premium, like ENS domain pricing):

| Symbol length | Fee |
|---|---|
| 1 char | 1000 APT |
| 2 chars | 100 APT |
| 3 chars | 10 APT |
| 4 chars | 1 APT |
| 5+ chars | 0.1 APT |

Fees go to the Darbitex treasury multisig (`0xdbce8911...`), same address that receives arbitrage service charges from the core AMM. Revenue from token creation fees funds the ecosystem's buy-and-burn mechanism for the native DARBITEX token.

**Symbol uniqueness** is enforced by `object::create_named_object(factory_signer, symbol)` — the Aptos object model guarantees that creating a named object with the same seed under the same account aborts. No explicit registry or Table needed.

**Design philosophy:**
- **Fire and forget.** After `create_token` returns, the factory retains zero control over the token. No admin, no pause, no metadata change, no additional minting.
- **Fully standard FA.** Tokens are created via `primary_fungible_store::create_primary_store_enabled_fungible_asset` — the same framework function used by APT, USDC, USDt. Composable with every Aptos DEX, wallet, and bridge.
- **Package will be frozen to immutable** after mainnet smoke test. No future upgrades possible.

---

## 3. Core design principles

These are **intentional**. If you find something that violates one, that's a HIGH finding.

1. **Fixed supply.** `MintRef` is generated, used once to mint 1B to creator, then dropped in the same function scope. No `MintRef` is stored anywhere. Supply is permanently fixed at creation.

2. **Self-burn only.** `BurnRef` is stored in a `BurnCap` resource at the token's metadata object address. The `burn()` entry function calls `primary_fungible_store::withdraw(caller, ...)` — the caller can only withdraw from their own primary store. No one can burn another user's tokens.

3. **No freeze.** `TransferRef` is never generated. No one (including the factory) can freeze any user's token balance. Tokens are freely transferable from the moment of creation.

4. **Immutable metadata.** `MutateMetadataRef` is never generated. Name, symbol, and decimals are frozen at creation time. No rug-pull via name/symbol change.

5. **Symbol uniqueness via object model.** `create_named_object(factory_signer, symbol)` derives a deterministic address from `(factory_resource_account, symbol)`. Attempting to create a token with the same symbol aborts with `EOBJECT_EXISTS` from the framework. No explicit registry needed — uniqueness is an emergent property of the object address space.

6. **Tiered fee as revenue mechanism.** Fee is collected BEFORE token creation (withdraw → deposit pattern). If the creator doesn't have enough APT, the transaction aborts before any state changes. Fee goes to a hardcoded treasury address — no admin can redirect it.

7. **Zero stored state per token (except BurnCap).** The factory stores only `SignerCapability` globally. Each token has one `BurnCap { burn_ref }` at its metadata address. No registry, no mapping, no vector of created tokens.

8. **Block-explorer executable.** All entry functions take primitives: `vector<u8>` for name/symbol, `Object<Metadata>` + `u64` for burn. Aptos Explorer "Run Function" works without a frontend.

---

## 4. Security model

### Trusted parties

- **Publisher multisig** (1/5 → 3/5 → package frozen to immutable): publishes and freezes the factory. After freeze, the upgrade cap is permanently inert.
- **Treasury multisig** (`0xdbce8911...`, 3/5): passive recipient of creation fees. Cannot touch factory state, tokens, or user balances.

### Untrusted parties

- Anyone can call `create_token` (if they pay the fee)
- Anyone can call `burn` (on their own tokens only)
- Anyone can read views (`token_exists`, `token_address`, `get_creation_fee`)
- Created tokens are permissionless standard FAs — anyone can transfer, trade, LP

### Threat model we care about

1. **Supply inflation** — can anyone mint tokens after creation? (MintRef must be provably dropped)
2. **Fee bypass** — can someone create a token without paying the fee?
3. **Fee redirection** — can someone redirect the fee to an address other than TREASURY?
4. **Symbol squatting bypass** — can two tokens share the same symbol?
5. **Burn abuse** — can someone burn tokens they don't own?
6. **BurnCap theft** — can someone extract the BurnRef from BurnCap and use it on arbitrary users' tokens?
7. **Factory signer leak** — can someone obtain the factory's resource account signer and create objects outside `create_token`?
8. **Non-standard FA** — could a factory-created token behave differently from standard FAs in any way?

---

## 5. Design decisions we want challenged

### D-1: MintRef drop pattern (line 88-89)

```move
let mint_ref = fungible_asset::generate_mint_ref(&ctor);
primary_fungible_store::mint(&mint_ref, creator_addr, TOTAL_SUPPLY);
// mint_ref dropped here — no future minting possible
```

Move's `MintRef` has `drop` ability. When the function scope ends, `mint_ref` is automatically dropped. **Question:** Is this provably the only way to generate a MintRef for this token? Can another module call `generate_mint_ref` on the same ConstructorRef later?

**Our answer:** No — `ConstructorRef` is ephemeral (no `store` or `key`), so it cannot be saved. Once `create_token` returns, the `ConstructorRef` is gone, and `generate_mint_ref` can never be called again. But we want independent verification.

### D-2: BurnCap stored at token metadata address (line 91)

```move
move_to(&token_signer, BurnCap { burn_ref });
```

The `BurnCap` is stored at the **token's** object address, not at the factory address or creator address. **Question:** Is this safe? Can anyone read or extract the `BurnRef` from the `BurnCap`?

**Our answer:** `BurnCap` is a module-private struct — only `darbitex_factory::token` can `borrow_global` it. External modules cannot access it. The `burn()` function is the only public interface, and it enforces self-burn-only via `withdraw(caller, ...)`.

### D-3: Fee before creation ordering (lines 65-68)

```move
let fee = creation_fee(vector::length(&symbol));
let apt_meta = object::address_to_object<Metadata>(@0xa);
let fa = primary_fungible_store::withdraw(creator, apt_meta, fee);
primary_fungible_store::deposit(TREASURY, fa);
```

Fee is collected BEFORE `create_named_object`. If the symbol already exists, the fee is collected and then the transaction aborts on `create_named_object`. **Question:** Is the fee refunded on abort?

**Our answer:** Yes — Move's atomic transaction semantics guarantee full rollback on abort. The fee withdrawal is reverted. But we want confirmation.

### D-4: Tiered pricing model

**Question:** Is the pricing model sound? Any edge case where `creation_fee` returns an unexpected value?

**Our answer:** `symbol_len` is always `>= 1` (enforced by `E_EMPTY_SYMBOL` check above). The function covers all cases: 1, 2, 3, 4, else (5+). No gap, no overflow, pure constant lookup.

### D-5: No token count tracking

The factory doesn't track how many tokens have been created or maintain any list. Discovery is via events (`TokenCreated`) or deterministic address derivation (`token_address(symbol)`).

**Question:** Is this acceptable, or should there be a counter/registry for enumeration?

---

## 6. Threat-model walk-through per entry fn

### 6.1 `init_factory(deployer: &signer)`

- Asserts `deployer == @darbitex_factory` — only package publisher
- Asserts `!exists<Factory>` — one-shot
- Creates resource account from `FACTORY_SEED` — deterministic address
- Stores `SignerCapability` in `Factory` resource at `@darbitex_factory`
- **Attack surface:** None after init. `SignerCapability` is module-private, only accessible via `borrow_global<Factory>` inside `create_token`.

### 6.2 `create_token(creator: &signer, name: vector<u8>, symbol: vector<u8>)`

1. Assert factory initialized
2. Assert name and symbol non-empty
3. **Collect fee** — withdraw APT from creator, deposit to TREASURY. Abort if insufficient balance.
4. `create_named_object(factory_signer, symbol)` — abort if symbol taken
5. `create_primary_store_enabled_fungible_asset` — standard FA with metadata
6. `generate_mint_ref` → `mint` 1B to creator → `mint_ref` dropped (end of scope)
7. `generate_burn_ref` → stored in `BurnCap` at token object
8. Emit `TokenCreated` event

**Attack surface:**
- **Fee bypass:** Impossible — `withdraw` aborts if balance insufficient
- **Supply inflation:** MintRef dropped, ConstructorRef ephemeral — no second mint path
- **Symbol collision:** `create_named_object` guarantees uniqueness
- **Metadata spoofing:** name/symbol come from creator input (intended — it's their token)

### 6.3 `burn(caller: &signer, token: Object<Metadata>, amount: u64)`

1. Assert `BurnCap` exists at token address (validates it's a factory-created token)
2. `withdraw(caller, token, amount)` — caller can only withdraw from own store
3. `fungible_asset::burn(&burn_ref, fa)` — supply decreases

**Attack surface:**
- **Burn others' tokens:** Impossible — `withdraw` enforces `signer` ownership
- **BurnRef extraction:** `BurnCap` is module-private, only `borrow_global` inside this module

---

## 7. Pre-audit self-review + testnet evidence

### Self-audit (8 categories, per SOP)

1. **ABI verification** — all framework calls verified against source: `create_named_object`, `create_primary_store_enabled_fungible_asset`, `generate_mint_ref`, `generate_burn_ref`, `primary_fungible_store::mint/withdraw/deposit`, `fungible_asset::burn`. ✅
2. **Arg order/types** — 3 entries, all primitive or Object<T>. ✅
3. **Math** — zero arithmetic in our code. Fee lookup is pure constants. ✅
4. **Reentrancy** — no callbacks, no dispatch hooks, no mutable state during cross-module calls. ✅
5. **Edge cases** — empty name/symbol, duplicate symbol, 0 APT, burn 0, burn > balance, burn to 0 supply, symbol at 32-char framework limit. All verified. ✅
6. **Interactions** — standalone module, zero Darbitex module imports. ✅
7. **Error codes** — 5 distinct: E_NOT_INIT=1, E_ALREADY_INIT=2, E_EMPTY_SYMBOL=3, E_EMPTY_NAME=4, E_NO_BURN_CAP=5. ✅
8. **Events** — `TokenCreated` with creator, token_addr, name, symbol, total_supply, fee_paid. ✅

**Verdict:** GREEN with 0 blocking findings.

### Unit tests — 12/12 passing

| # | Test | Scenario |
|---|---|---|
| 1 | `create_token_happy_path` | 1B minted to creator, metadata correct |
| 2 | `tiered_fee_1_char` | 1-char symbol charges 1000 APT |
| 3 | `tiered_fee_3_chars` | 3-char symbol charges 10 APT |
| 4 | `tiered_fee_5_plus_chars` | 5+-char symbol charges 0.1 APT |
| 5 | `get_creation_fee_view` | All 6 tiers verified via view |
| 6 | `duplicate_symbol_aborts` | Same symbol → EOBJECT_EXISTS |
| 7 | `empty_name_aborts` | Empty name → E_EMPTY_NAME |
| 8 | `empty_symbol_aborts` | Empty symbol → E_EMPTY_SYMBOL |
| 9 | `burn_reduces_supply` | Burn 1000 tokens, balance decreases |
| 10 | `transfer_works` | Standard FA transfer between wallets |
| 11 | `token_not_exists_before_create` | View returns false |
| 12 | `create_without_apt_aborts` | 0 APT → abort on fee withdrawal |

### Testnet smoke test (Aptos testnet, `0x0047a3e1...`)

1. **Publish + init_factory** ✅
2. **create_token("Test Token", "TEST1")** ✅ — balance = 1B, metadata correct
3. **Duplicate "TEST1"** ✅ abort `EOBJECT_EXISTS`
4. **burn(1000 tokens)** ✅ — balance = 999,999,000
5. **Burn ALL remaining** ✅ — balance = 0, `ConcurrentSupply.value = 0`
6. **Verified:** symbol still taken after 0-supply burn (metadata object persists)
7. **token_exists / token_address / get_creation_fee** views all working ✅

---

## 8. Source code

**File:** `sources/token.move` — 141 LoC

```move
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
```

---

## 9. Ranked areas of concern

1. **§5 D-1: MintRef drop is provably permanent** — verify ConstructorRef cannot be saved or regenerated
2. **§5 D-3: Fee refund on abort** — verify atomic rollback restores APT on duplicate-symbol abort
3. **§5 D-2: BurnCap isolation** — verify no external module can access the BurnRef
4. **§4 Threat #7: Factory signer leak** — verify `SignerCapability` is inaccessible outside `create_token`
5. **§4 Threat #8: FA standard compliance** — verify no dispatch hooks or non-standard behavior

---

## 10. What we considered and got right

1. **MintRef drop in same scope** — provably fixed supply without external verification
2. **BurnRef as module-private resource** — self-burn only, no admin burn
3. **No TransferRef / MutateMetadataRef** — zero freeze power, immutable metadata
4. **Symbol uniqueness via object model** — zero-cost, zero-storage uniqueness
5. **Tiered ENS-style pricing** — shorter symbols are scarcer and more valuable
6. **Fee before creation** — no state change if fee fails
7. **Hardcoded treasury** — no admin can redirect revenue
8. **Package will be frozen to immutable** — strongest possible trust guarantee
9. **Zero Darbitex module imports** — fully standalone, no cross-dependency risk
10. **Standard FA via `create_primary_store_enabled_fungible_asset`** — same function as APT/USDC/USDt

---

## 11. Out of scope

- Aptos framework correctness (trusted)
- Token economics / market dynamics of created tokens
- Frontend UX for token creation
- Whether specific token names/symbols are appropriate
- How created tokens are used in pools/LP/staking after creation

---

**End of submission.** Findings format in §1. Verdict request: **green / yellow / red** for mainnet publish.
