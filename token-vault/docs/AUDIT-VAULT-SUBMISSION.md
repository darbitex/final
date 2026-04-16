# Darbitex Token Vault — External Audit Submission (Round 1)

**Package:** `darbitex_vault`
**Version:** 0.1.0
**Date:** 2026-04-16
**Chain:** Aptos
**Dependencies:** AptosFramework only (zero Darbitex core dependency)
**Audit package size:** 1 Move source file (`sources/vault.move`), ~530 LoC production + ~280 LoC test, compile-clean with zero warnings
**Previous deploys:** Testnet at `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9` (Aptos testnet, **frozen to immutable**). All 9 entry functions and 6 views exercised on-chain. All abort paths validated.
**Planned mainnet publisher:** 3/5 multisig (same 5 owners as Darbitex Final treasury `0xdbce8911...`).
**Upgrade policy:** `compatible` at publish, will flip to `immutable` after mainnet smoke test.

---

## 1. What we are asking from you

You are reviewing a single Move source file for an **all-in-one token vault satellite** that provides three independent modes for ANY Aptos Fungible Asset token: **Lock** (time-based), **Vest** (linear vesting), and **Stake** (MasterChef-style reward pools). We want an **independent security review** focused on:

1. **Authorization correctness** — can any unauthorized party redeem, claim, or unstake someone else's position?
2. **Fund safety** — can tokens be permanently locked or stolen in any code path?
3. **Staking accumulator math** — is the MasterChef reward distribution correct? Can `reward_balance` underflow? Can `acc_reward_per_share` overflow?
4. **Vesting math** — is linear interpolation correct? Any rounding exploits?
5. **Fee collection** — is the 1 APT flat fee correctly collected and deposited to treasury?
6. **Same-token pool safety** — when `staked_token == reward_token`, does the commingled accounting hold?
7. **Object lifecycle** — are all objects cleanly created and deleted? Any dangling refs?
8. **Event completeness** — do events capture all state mutations with correct fields?

**Output format:**

```
## Findings

### HIGH-1: <title>
Location: vault.move:<line>
Description: <what>
Impact: <why it matters>
Recommended fix: <how>

### MEDIUM-1: ...
### LOW-1: ...
### INFORMATIONAL-1: ...

## Overall verdict
(GREEN / YELLOW / RED for mainnet publish readiness)
```

---

## 2. Architecture overview

Three independent modes in one module, zero admin, zero external dependencies beyond `aptos_framework`:

### Mode 1: Lock
Lock any FA token until a specified `unlock_at` timestamp. Tokens deposited into a per-lock vault object. Redeem returns full amount after unlock time.

### Mode 2: Vest
Linear vesting from `start_time` to `end_time`. Partial claims allowed mid-schedule. Full claim auto-deletes the vest object.

### Mode 3: Stake
Permissionless reward pools with MasterChef accumulator pattern. Anyone can create a pool, deposit rewards, and stake tokens. Dynamic emission: `rate = max_rate * min(staked, target) / target`. Rewards allocated in `update_reward_pool` and deducted from `reward_balance` at allocation time (not at claim time).

### Fee model
1 APT flat fee on creation operations only:
- `lock_tokens`, `create_vesting`, `create_reward_pool`, `stake_tokens` → 1 APT to treasury
- `redeem_locked`, `claim_vested`, `claim_stake_rewards`, `unstake_tokens`, `deposit_rewards` → free

### Design principles
- **Agnostic:** works with ANY Fungible Asset from any factory
- **Fire-and-forget:** immutable after deploy, zero admin
- **Permissionless:** anyone can create pools and deposit rewards
- **One-way rewards:** `deposit_rewards` has no withdraw counterpart
- **Block-explorer executable:** all entry args are `address` / `u64` / `Object<T>`
- **Transferable positions:** all objects use default ungated transfer

---

## 3. Entry surface (9 entries + 6 views)

### Lock
| Function | Fee | Description |
|----------|-----|-------------|
| `lock_tokens(user, token, amount, unlock_at)` | 1 APT | Lock FA tokens until `unlock_at` |
| `redeem_locked(user, locker)` | free | Redeem after unlock, deletes object |

### Vest
| Function | Fee | Description |
|----------|-----|-------------|
| `create_vesting(user, token, total_amount, start_time, end_time)` | 1 APT | Create linear vesting schedule |
| `claim_vested(user, vest)` | free | Claim pro-rata vested amount, auto-delete when fully claimed |

### Stake
| Function | Fee | Description |
|----------|-----|-------------|
| `create_reward_pool(creator, staked_token, reward_token, max_rate, stake_target)` | 1 APT | Create permissionless reward pool |
| `deposit_rewards(depositor, pool, amount)` | free | One-way reward deposit |
| `stake_tokens(user, pool, amount)` | 1 APT | Stake tokens in pool |
| `claim_stake_rewards(user, stake)` | free | Harvest pending rewards |
| `unstake_tokens(user, stake)` | free | Withdraw principal + pending rewards, delete position |

### Views
| Function | Returns |
|----------|---------|
| `lock_info(locker)` | (token, amount, unlock_at) |
| `vest_info(vest)` | (token, total, claimed, start, end) |
| `vest_claimable(vest)` | u64 |
| `reward_pool_info(pool)` | (staked_token, reward_token, max_rate, target, total_staked, reward_balance) |
| `stake_info(stake)` | (pool_addr, amount) |
| `stake_pending_reward(stake)` | u64 |

---

## 4. Error codes

| Code | Constant | Used in |
|------|----------|---------|
| 1 | E_NOT_OWNER | redeem_locked, claim_vested, claim_stake_rewards, unstake_tokens |
| 2 | E_STILL_LOCKED | redeem_locked |
| 3 | E_INVALID_UNLOCK | lock_tokens (unlock_at must be > now) |
| 4 | E_ZERO_AMOUNT | lock_tokens, create_vesting, create_reward_pool, deposit_rewards, stake_tokens |
| 5 | E_NOTHING_CLAIMABLE | claim_vested, claim_stake_rewards (no pending rewards) |
| 6 | E_INVALID_SCHEDULE | create_vesting (end <= start, or start < now) |

---

## 5. Key design decisions we want challenged

### D-1: reward_balance tracks unallocated emission budget
`reward_balance` is decremented in `update_reward_pool` when rewards are allocated to the accumulator, NOT when individual users claim. This prevents the multi-epoch underflow bug where accumulated `acc_reward_per_share` exceeds the actual reward pool. Claims withdraw directly from the pool's FA store without touching `reward_balance`.

**Question:** Is this allocation-time deduction correct and safe in all edge cases?

### D-2: 1 APT fee per stake position
Every `stake_tokens` call charges 1 APT. This deters the 1-unit-stake griefing attack (where an attacker stakes 1 token to round emission_rate to 0 and waste time). The tradeoff is that users wanting to add to their stake must create a new position.

**Question:** Is the fee-per-position tradeoff acceptable, or should there be an `add_to_stake` function?

### D-3: Permissionless reward pools with no admin
Anyone can create pools. Pool parameters (max_rate, stake_target, tokens) are immutable after creation. Deposited rewards cannot be recovered. No pause/close mechanism.

**Question:** Is this fire-and-forget design safe for a permissionless system?

### D-4: Same-token staked/reward pools allowed
When `staked_token == reward_token`, the pool's primary FA store holds both staked principal and reward tokens in a single balance. Accounting is maintained via `total_staked` and `reward_balance` fields separately.

**Question:** Can the commingled FA store cause any withdrawal failures?

### D-5: No minimum stake or lock duration
`lock_tokens` only requires `unlock_at > now`. `stake_tokens` only requires `amount > 0`. No minimum amounts or durations.

**Question:** Are there griefing vectors we're missing?

### D-6: Objects are transferable by default
All positions (LockedTokens, VestedTokens, StakePosition) are standard Aptos objects with ungated transfer. New owner inherits full rights.

**Question:** Any security implications of transferable vesting positions?

---

## 6. Threat-model walk-through per function

### 6.1 lock_tokens
- Assert `unlock_at > now` and `amount > 0`
- Collect 1 APT fee
- Withdraw tokens from user, deposit to vault object
- Create vault object with ExtendRef + DeleteRef
- **Cannot lock someone else's tokens:** `primary_fungible_store::withdraw` requires signer authority
- **Cannot set past unlock:** strict `>` check

### 6.2 redeem_locked
- Assert `object::owner(locker) == user_addr`
- Destructure via `move_from`, assert `now >= unlock_at`
- Withdraw from vault using ExtendRef, deposit to user
- Delete object using DeleteRef
- **Ordering:** destructure FIRST, then assert time. If assert fails, tx aborts atomically — all state rolls back.

### 6.3 create_vesting
- Assert `total_amount > 0`, `end_time > start_time`, `start_time >= now`
- Tokens deposited to vest object

### 6.4 claim_vested
- Assert owner. Compute `claimable = vested_available(v) - v.claimed_amount`
- Assert `claimable > 0`
- Withdraw claimable from vest, deposit to user
- If fully claimed: `move_from` + `object::delete`
- **Rounding:** integer division truncates toward zero (user gets slightly less than pro-rata until full vesting). At `now >= end_time`, full `total_amount` is returned. No funds permanently lost.

### 6.5 create_reward_pool
- Assert `max_rate > 0` and `stake_target > 0`
- No admin, no DeleteRef — pool is immortal

### 6.6 deposit_rewards
- Assert `amount > 0`
- Anyone can deposit — permissionless
- One-way: no `withdraw_rewards` function exists

### 6.7 stake_tokens
- Assert `amount > 0`, collect fee
- Calls `update_reward_pool` to sync accumulator
- Deposits staked tokens to pool's FA store
- Sets `reward_debt` to current accumulator snapshot (standard MasterChef pattern)

### 6.8 claim_stake_rewards
- Assert owner, assert `pending > 0`
- Calls `update_reward_pool` to sync accumulator
- Computes pending via `pending_reward(amount, acc, debt)`
- Withdraws from pool's FA store, deposits to user
- Updates `reward_debt` to current snapshot

### 6.9 unstake_tokens
- Assert owner
- Destructure StakePosition via `move_from`
- Calls `update_reward_pool`
- Withdraws pending rewards + staked principal from pool's FA store
- Decrements `total_staked`, deletes position object

---

## 7. Staking math deep-dive

### Accumulator pattern
Standard MasterChef with 1e12 precision (`SCALE = 1_000_000_000_000`):

```
emission_rate = min(total_staked, stake_target) * max_rate / stake_target
total_reward = min(elapsed * rate, reward_balance)  // capped at budget
acc_reward_per_share += total_reward * SCALE / total_staked
reward_balance -= total_reward  // allocated, no longer available
```

### Pending reward calculation
```
pending = amount * acc_reward_per_share / SCALE - reward_debt
```

### Key invariant
`reward_balance` tracks **unallocated** emission budget. Once allocated to the accumulator, rewards are deducted from `reward_balance`. Individual claims withdraw directly from the pool's FA store. This ensures:
- No multi-epoch underflow (total allocated never exceeds deposited)
- Rounding always favors the pool (floor division per staker)
- Late claims always succeed (funds are in the FA store, not tracked by `reward_balance`)

### View function accuracy
`stake_pending_reward` simulates a hypothetical `update_reward_pool` call, capping emission at current `reward_balance`. This ensures the view never overestimates.

---

## 8. Pre-audit self-review results

### Internal audit (5 parallel AI auditors, 2026-04-16)
Auditors: Security, Math/Economics, Aptos Patterns, Edge Cases, ABI/Composability

**Critical finding fixed before this submission:**
- **reward_balance underflow** — original code deducted `reward_balance` only at claim time, not at allocation time. Over multiple epochs without claims, `acc_reward_per_share` could exceed `reward_balance` capacity, causing underflow on claim and **locking staked tokens**. Fixed by deducting in `update_reward_pool` and removing deduction in claim/unstake.

**Other findings acknowledged (no fix needed):**
- 1 APT fee per stake (design choice, deters griefing)
- No extend/increase/top-up operations (design choice, can add via compat upgrade)
- u128 overflow with adversarial `max_rate=u64::MAX` (self-inflicted, frontend can filter)
- Transferable positions (by design, same as LP locker)

### Unit test suite — 24/24 passing

| # | Test | Scenario |
|---|------|----------|
| 1 | lock_happy_path | Lock tokens, verify lock_info view |
| 2 | redeem_after_unlock | Lock → advance time → redeem, balance restored |
| 3 | redeem_before_unlock_aborts | E_STILL_LOCKED |
| 4 | lock_unlock_at_past_aborts | E_INVALID_UNLOCK |
| 5 | lock_zero_amount_aborts | E_ZERO_AMOUNT |
| 6 | redeem_non_owner_aborts | E_NOT_OWNER |
| 7 | vest_happy_path | Create vest, verify vest_info view |
| 8 | vest_claim_partial | Claim at 50% through schedule |
| 9 | vest_claim_full_deletes | Full claim, object auto-deleted |
| 10 | vest_claim_before_start_aborts | E_NOTHING_CLAIMABLE |
| 11 | vest_invalid_schedule_aborts | E_INVALID_SCHEDULE |
| 12 | vest_claimable_view | View accuracy at 0%/25%/75%/100% |
| 13 | stake_pool_and_deposit | Create pool + deposit, verify pool_info |
| 14 | stake_and_claim_rewards | Stake → advance 10s → claim, verify reward amount |
| 15 | unstake_returns_principal_and_rewards | Full unstake flow, position deleted |
| 16 | stake_pending_view | View accuracy at 0s/5s/20s |
| 17 | create_pool_zero_rate_aborts | E_ZERO_AMOUNT |
| 18 | stake_zero_amount_aborts | E_ZERO_AMOUNT |
| 19 | stake_under_target_emits_less | 50% of target → 50% emission rate |
| 20 | reward_balance_caps_emission | Rewards exhausted, user gets exactly deposit |
| 21 | claim_stake_zero_pending_aborts | E_NOTHING_CLAIMABLE (same block) |
| 22 | view_caps_at_reward_balance | View caps pending at reward_balance |
| 23 | multi_epoch_claim_no_underflow | Exhaust rewards over time, no underflow on unstake |
| 24 | stake_info_view | Verify stake_info returns (pool_addr, amount) |

### Testnet smoke test (2026-04-16)
All 3 modes exercised on Aptos testnet:
- Lock: lock → view → redeem (after unlock)
- Vest: create → view accruing → full claim (auto-delete)
- Stake: create pool → deposit rewards → stake → view pending → unstake (principal + rewards)
- **Critical test:** staked 0.01 APT with only 500 octas rewards, waited 15s (rewards should exhaust at 5s), unstaked successfully with exactly 500 rewards. No underflow.
- Package frozen to immutable on testnet. Re-publish rejected with `EUPGRADE_IMMUTABLE`.

---

## 9. Source code

**File:** `sources/vault.move` — ~530 LoC (excluding #[test_only] wrappers)

```move
module darbitex_vault::vault {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::object::{Self, Object, ExtendRef, DeleteRef};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    const SCALE: u128 = 1_000_000_000_000;
    const CREATION_FEE: u64 = 100_000_000; // 1 APT
    const TREASURY: address = @0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576;

    const E_NOT_OWNER: u64 = 1;
    const E_STILL_LOCKED: u64 = 2;
    const E_INVALID_UNLOCK: u64 = 3;
    const E_ZERO_AMOUNT: u64 = 4;
    const E_NOTHING_CLAIMABLE: u64 = 5;
    const E_INVALID_SCHEDULE: u64 = 6;

    struct LockedTokens has key {
        token: Object<Metadata>,
        amount: u64,
        unlock_at: u64,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    struct VestedTokens has key {
        token: Object<Metadata>,
        total_amount: u64,
        claimed_amount: u64,
        start_time: u64,
        end_time: u64,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    struct RewardPool has key {
        staked_token: Object<Metadata>,
        reward_token: Object<Metadata>,
        max_rate: u64,
        stake_target: u64,
        acc_reward_per_share: u128,
        last_reward_time: u64,
        total_staked: u64,
        reward_balance: u64,
        extend_ref: ExtendRef,
    }

    struct StakePosition has key {
        pool_addr: address,
        amount: u64,
        reward_debt: u128,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    #[event]
    struct TokensLocked has drop, store {
        owner: address, locker_addr: address, token: address,
        amount: u64, unlock_at: u64, timestamp: u64,
    }

    #[event]
    struct TokensRedeemed has drop, store {
        owner: address, locker_addr: address, token: address,
        amount: u64, timestamp: u64,
    }

    #[event]
    struct VestingCreated has drop, store {
        owner: address, vest_addr: address, token: address,
        total_amount: u64, start_time: u64, end_time: u64,
    }

    #[event]
    struct VestingClaimed has drop, store {
        owner: address, vest_addr: address,
        claimed: u64, remaining: u64, timestamp: u64,
    }

    #[event]
    struct RewardPoolCreated has drop, store {
        creator: address, pool_addr: address,
        staked_token: address, reward_token: address,
        max_rate: u64, stake_target: u64,
    }

    #[event]
    struct RewardsDeposited has drop, store {
        depositor: address, pool_addr: address,
        amount: u64, new_balance: u64,
    }

    #[event]
    struct TokensStaked has drop, store {
        user: address, stake_addr: address, pool_addr: address,
        amount: u64, timestamp: u64,
    }

    #[event]
    struct StakeRewardsClaimed has drop, store {
        user: address, stake_addr: address,
        amount: u64, timestamp: u64,
    }

    #[event]
    struct TokensUnstaked has drop, store {
        user: address, stake_addr: address,
        amount: u64, rewards_claimed: u64, timestamp: u64,
    }

    fun collect_fee(user: &signer) {
        let apt_meta = object::address_to_object<Metadata>(@0xa);
        let fa = primary_fungible_store::withdraw(user, apt_meta, CREATION_FEE);
        primary_fungible_store::deposit(TREASURY, fa);
    }

    public entry fun lock_tokens(
        user: &signer, token: Object<Metadata>, amount: u64, unlock_at: u64,
    ) {
        create_lock(user, token, amount, unlock_at);
    }

    fun create_lock(
        user: &signer, token: Object<Metadata>, amount: u64, unlock_at: u64,
    ): Object<LockedTokens> {
        let now = timestamp::now_seconds();
        assert!(unlock_at > now, E_INVALID_UNLOCK);
        assert!(amount > 0, E_ZERO_AMOUNT);
        collect_fee(user);

        let user_addr = signer::address_of(user);
        let fa = primary_fungible_store::withdraw(user, token, amount);

        let ctor = object::create_object(user_addr);
        let vault_signer = object::generate_signer(&ctor);
        let vault_addr = signer::address_of(&vault_signer);
        let extend_ref = object::generate_extend_ref(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        primary_fungible_store::deposit(vault_addr, fa);

        move_to(&vault_signer, LockedTokens {
            token, amount, unlock_at, extend_ref, delete_ref,
        });

        event::emit(TokensLocked {
            owner: user_addr, locker_addr: vault_addr,
            token: object::object_address(&token),
            amount, unlock_at, timestamp: now,
        });

        object::address_to_object<LockedTokens>(vault_addr)
    }

    public entry fun redeem_locked(
        user: &signer, locker: Object<LockedTokens>,
    ) acquires LockedTokens {
        let user_addr = signer::address_of(user);
        assert!(object::owner(locker) == user_addr, E_NOT_OWNER);

        let locker_addr = object::object_address(&locker);
        let LockedTokens { token, amount, unlock_at, extend_ref, delete_ref }
            = move_from<LockedTokens>(locker_addr);
        assert!(timestamp::now_seconds() >= unlock_at, E_STILL_LOCKED);

        let vault_signer = object::generate_signer_for_extending(&extend_ref);
        let fa = primary_fungible_store::withdraw(&vault_signer, token, amount);
        primary_fungible_store::deposit(user_addr, fa);

        object::delete(delete_ref);

        event::emit(TokensRedeemed {
            owner: user_addr, locker_addr,
            token: object::object_address(&token),
            amount, timestamp: timestamp::now_seconds(),
        });
    }

    public entry fun create_vesting(
        user: &signer, token: Object<Metadata>,
        total_amount: u64, start_time: u64, end_time: u64,
    ) {
        create_vest(user, token, total_amount, start_time, end_time);
    }

    fun create_vest(
        user: &signer, token: Object<Metadata>,
        total_amount: u64, start_time: u64, end_time: u64,
    ): Object<VestedTokens> {
        assert!(total_amount > 0, E_ZERO_AMOUNT);
        assert!(end_time > start_time, E_INVALID_SCHEDULE);
        assert!(start_time >= timestamp::now_seconds(), E_INVALID_SCHEDULE);
        collect_fee(user);

        let user_addr = signer::address_of(user);
        let fa = primary_fungible_store::withdraw(user, token, total_amount);

        let ctor = object::create_object(user_addr);
        let vault_signer = object::generate_signer(&ctor);
        let vault_addr = signer::address_of(&vault_signer);
        let extend_ref = object::generate_extend_ref(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        primary_fungible_store::deposit(vault_addr, fa);

        move_to(&vault_signer, VestedTokens {
            token, total_amount, claimed_amount: 0,
            start_time, end_time, extend_ref, delete_ref,
        });

        event::emit(VestingCreated {
            owner: user_addr, vest_addr: vault_addr,
            token: object::object_address(&token),
            total_amount, start_time, end_time,
        });

        object::address_to_object<VestedTokens>(vault_addr)
    }

    public entry fun claim_vested(
        user: &signer, vest: Object<VestedTokens>,
    ) acquires VestedTokens {
        let user_addr = signer::address_of(user);
        assert!(object::owner(vest) == user_addr, E_NOT_OWNER);

        let vest_addr = object::object_address(&vest);
        let v = borrow_global_mut<VestedTokens>(vest_addr);

        let claimable = vested_available(v) - v.claimed_amount;
        assert!(claimable > 0, E_NOTHING_CLAIMABLE);

        v.claimed_amount = v.claimed_amount + claimable;

        let vault_signer = object::generate_signer_for_extending(&v.extend_ref);
        let fa = primary_fungible_store::withdraw(&vault_signer, v.token, claimable);
        primary_fungible_store::deposit(user_addr, fa);

        let remaining = v.total_amount - v.claimed_amount;

        event::emit(VestingClaimed {
            owner: user_addr, vest_addr, claimed: claimable,
            remaining, timestamp: timestamp::now_seconds(),
        });

        if (remaining == 0) {
            let VestedTokens { token: _, total_amount: _, claimed_amount: _,
                start_time: _, end_time: _, extend_ref: _, delete_ref }
                = move_from<VestedTokens>(vest_addr);
            object::delete(delete_ref);
        };
    }

    fun vested_available(v: &VestedTokens): u64 {
        let now = timestamp::now_seconds();
        if (now <= v.start_time) return 0;
        if (now >= v.end_time) return v.total_amount;
        let elapsed = (now - v.start_time as u64);
        let duration = (v.end_time - v.start_time as u64);
        ((v.total_amount as u128) * (elapsed as u128) / (duration as u128) as u64)
    }

    public entry fun create_reward_pool(
        creator: &signer, staked_token: Object<Metadata>,
        reward_token: Object<Metadata>, max_rate: u64, stake_target: u64,
    ) {
        create_pool(creator, staked_token, reward_token, max_rate, stake_target);
    }

    fun create_pool(
        creator: &signer, staked_token: Object<Metadata>,
        reward_token: Object<Metadata>, max_rate: u64, stake_target: u64,
    ): Object<RewardPool> {
        assert!(max_rate > 0, E_ZERO_AMOUNT);
        assert!(stake_target > 0, E_ZERO_AMOUNT);
        collect_fee(creator);

        let creator_addr = signer::address_of(creator);
        let ctor = object::create_object(creator_addr);
        let pool_signer = object::generate_signer(&ctor);
        let pool_addr = signer::address_of(&pool_signer);
        let extend_ref = object::generate_extend_ref(&ctor);

        move_to(&pool_signer, RewardPool {
            staked_token, reward_token, max_rate, stake_target,
            acc_reward_per_share: 0,
            last_reward_time: timestamp::now_seconds(),
            total_staked: 0, reward_balance: 0, extend_ref,
        });

        event::emit(RewardPoolCreated {
            creator: creator_addr, pool_addr,
            staked_token: object::object_address(&staked_token),
            reward_token: object::object_address(&reward_token),
            max_rate, stake_target,
        });

        object::address_to_object<RewardPool>(pool_addr)
    }

    public entry fun deposit_rewards(
        depositor: &signer, pool: Object<RewardPool>, amount: u64,
    ) acquires RewardPool {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let pool_addr = object::object_address(&pool);
        let rp = borrow_global_mut<RewardPool>(pool_addr);

        let fa = primary_fungible_store::withdraw(depositor, rp.reward_token, amount);
        let pool_signer = object::generate_signer_for_extending(&rp.extend_ref);
        primary_fungible_store::deposit(signer::address_of(&pool_signer), fa);
        rp.reward_balance = rp.reward_balance + amount;

        event::emit(RewardsDeposited {
            depositor: signer::address_of(depositor),
            pool_addr, amount, new_balance: rp.reward_balance,
        });
    }

    public entry fun stake_tokens(
        user: &signer, pool: Object<RewardPool>, amount: u64,
    ) acquires RewardPool {
        create_stake(user, pool, amount);
    }

    fun create_stake(
        user: &signer, pool: Object<RewardPool>, amount: u64,
    ): Object<StakePosition> acquires RewardPool {
        assert!(amount > 0, E_ZERO_AMOUNT);
        collect_fee(user);

        let pool_addr = object::object_address(&pool);
        let rp = borrow_global_mut<RewardPool>(pool_addr);
        update_reward_pool(rp);

        let user_addr = signer::address_of(user);
        let fa = primary_fungible_store::withdraw(user, rp.staked_token, amount);

        let ctor = object::create_object(user_addr);
        let stake_signer = object::generate_signer(&ctor);
        let stake_addr = signer::address_of(&stake_signer);
        let extend_ref = object::generate_extend_ref(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        let pool_signer = object::generate_signer_for_extending(&rp.extend_ref);
        primary_fungible_store::deposit(signer::address_of(&pool_signer), fa);

        let reward_debt = (amount as u128) * rp.acc_reward_per_share / SCALE;
        move_to(&stake_signer, StakePosition {
            pool_addr, amount, reward_debt, extend_ref, delete_ref,
        });

        rp.total_staked = rp.total_staked + amount;

        event::emit(TokensStaked {
            user: user_addr, stake_addr, pool_addr,
            amount, timestamp: timestamp::now_seconds(),
        });

        object::address_to_object<StakePosition>(stake_addr)
    }

    public entry fun claim_stake_rewards(
        user: &signer, stake: Object<StakePosition>,
    ) acquires RewardPool, StakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let sp = borrow_global_mut<StakePosition>(stake_addr);
        let rp = borrow_global_mut<RewardPool>(sp.pool_addr);
        update_reward_pool(rp);

        let pending = pending_reward(sp.amount, rp.acc_reward_per_share, sp.reward_debt);
        assert!(pending > 0, E_NOTHING_CLAIMABLE);
        sp.reward_debt = (sp.amount as u128) * rp.acc_reward_per_share / SCALE;

        {
            let pool_signer = object::generate_signer_for_extending(&rp.extend_ref);
            let fa = primary_fungible_store::withdraw(&pool_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, fa);
        };

        event::emit(StakeRewardsClaimed {
            user: user_addr, stake_addr,
            amount: pending, timestamp: timestamp::now_seconds(),
        });
    }

    public entry fun unstake_tokens(
        user: &signer, stake: Object<StakePosition>,
    ) acquires RewardPool, StakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let StakePosition { pool_addr, amount, reward_debt, extend_ref: _, delete_ref }
            = move_from<StakePosition>(stake_addr);

        let rp = borrow_global_mut<RewardPool>(pool_addr);
        update_reward_pool(rp);

        let pending = pending_reward(amount, rp.acc_reward_per_share, reward_debt);

        let pool_signer = object::generate_signer_for_extending(&rp.extend_ref);

        if (pending > 0) {
            let reward_fa = primary_fungible_store::withdraw(&pool_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, reward_fa);
        };

        let staked_fa = primary_fungible_store::withdraw(&pool_signer, rp.staked_token, amount);
        primary_fungible_store::deposit(user_addr, staked_fa);

        rp.total_staked = rp.total_staked - amount;
        object::delete(delete_ref);

        event::emit(TokensUnstaked {
            user: user_addr, stake_addr, amount,
            rewards_claimed: pending, timestamp: timestamp::now_seconds(),
        });
    }

    fun update_reward_pool(rp: &mut RewardPool) {
        let now = timestamp::now_seconds();
        if (now <= rp.last_reward_time) return;
        if (rp.total_staked == 0) {
            rp.last_reward_time = now;
            return
        };

        let elapsed = now - rp.last_reward_time;
        let rate = emission_rate(rp.total_staked, rp.max_rate, rp.stake_target);
        let total_reward_u128 = (elapsed as u128) * (rate as u128);
        let total_reward = if (total_reward_u128 > (rp.reward_balance as u128)) {
            rp.reward_balance
        } else {
            (total_reward_u128 as u64)
        };

        if (total_reward > 0) {
            rp.acc_reward_per_share = rp.acc_reward_per_share
                + (total_reward as u128) * SCALE / (rp.total_staked as u128);
            rp.reward_balance = rp.reward_balance - total_reward;
        };
        rp.last_reward_time = now;
    }

    fun emission_rate(total_staked: u64, max_rate: u64, stake_target: u64): u64 {
        let capped = if (total_staked > stake_target) stake_target else total_staked;
        (((capped as u128) * (max_rate as u128) / (stake_target as u128)) as u64)
    }

    fun pending_reward(amount: u64, acc: u128, debt: u128): u64 {
        let raw = (amount as u128) * acc / SCALE;
        if (raw > debt) ((raw - debt) as u64) else 0
    }

    #[view]
    public fun lock_info(locker: Object<LockedTokens>): (address, u64, u64) acquires LockedTokens {
        let l = borrow_global<LockedTokens>(object::object_address(&locker));
        (object::object_address(&l.token), l.amount, l.unlock_at)
    }

    #[view]
    public fun vest_info(vest: Object<VestedTokens>): (address, u64, u64, u64, u64) acquires VestedTokens {
        let v = borrow_global<VestedTokens>(object::object_address(&vest));
        (object::object_address(&v.token), v.total_amount, v.claimed_amount, v.start_time, v.end_time)
    }

    #[view]
    public fun vest_claimable(vest: Object<VestedTokens>): u64 acquires VestedTokens {
        let v = borrow_global<VestedTokens>(object::object_address(&vest));
        vested_available(v) - v.claimed_amount
    }

    #[view]
    public fun reward_pool_info(pool: Object<RewardPool>): (address, address, u64, u64, u64, u64) acquires RewardPool {
        let rp = borrow_global<RewardPool>(object::object_address(&pool));
        (
            object::object_address(&rp.staked_token),
            object::object_address(&rp.reward_token),
            rp.max_rate, rp.stake_target,
            rp.total_staked, rp.reward_balance,
        )
    }

    #[view]
    public fun stake_info(stake: Object<StakePosition>): (address, u64) acquires StakePosition {
        let sp = borrow_global<StakePosition>(object::object_address(&stake));
        (sp.pool_addr, sp.amount)
    }

    #[view]
    public fun stake_pending_reward(stake: Object<StakePosition>): u64 acquires RewardPool, StakePosition {
        let stake_addr = object::object_address(&stake);
        let sp = borrow_global<StakePosition>(stake_addr);
        let rp = borrow_global<RewardPool>(sp.pool_addr);
        let now = timestamp::now_seconds();
        let elapsed = if (now > rp.last_reward_time) now - rp.last_reward_time else 0;
        let rate = emission_rate(rp.total_staked, rp.max_rate, rp.stake_target);
        let extra = if (rp.total_staked > 0 && elapsed > 0) {
            let uncapped = (elapsed as u128) * (rate as u128);
            let capped = if (uncapped > (rp.reward_balance as u128)) {
                (rp.reward_balance as u128)
            } else { uncapped };
            capped * SCALE / (rp.total_staked as u128)
        } else { 0 };
        pending_reward(sp.amount, rp.acc_reward_per_share + extra, sp.reward_debt)
    }
}
```

---

## 10. Ranked areas of concern

1. **Staking accumulator correctness** — verify `reward_balance` is deducted at allocation time (not claim time) and that this prevents multi-epoch underflow.
2. **Same-token pool accounting** — when `staked_token == reward_token`, verify that sequential `withdraw` calls from the same FA store cannot fail.
3. **Vesting `claim_vested` object cleanup** — `borrow_global_mut` followed by `move_from` in the `remaining == 0` branch. Verify borrow is dead before `move_from`.
4. **`vested_available` rounding** — verify no user can claim more than `total_amount` through repeated partial claims.
5. **View function `stake_pending_reward`** — verify it correctly caps at `reward_balance` and never overestimates.

---

## 11. Out of scope

- Aptos framework correctness (object, fungible_asset, primary_fungible_store, timestamp) — trusted
- Frontend UX — not shipped
- Economic analysis of fee model — design choice
- Tax/legal/compliance — out of scope
- Other Darbitex packages — this package has zero cross-package dependencies

---

**End of submission.** Please audit the source in §9. Findings format in §1. Verdict: **GREEN / YELLOW / RED** for mainnet publish readiness.
