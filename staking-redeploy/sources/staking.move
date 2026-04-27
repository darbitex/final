/// Darbitex LP staking — agnostic adoption/retention distribution primitive.
///
/// MasterChef-style accumulator distributing FA rewards to LP stakers of
/// `darbitex::pool` pools. Emission rate scales with the fraction of pool
/// LP that is actively staked:
///
///     emission_rate = total_staked_shares / pool::lp_supply * max_rate_per_sec
///
/// No `stake_target` parameter, no boost schedule, no admin lever.
/// Distribution intensity = function of community participation only.
///
/// Permissionless reward pool creation — multiple coexisting reward streams
/// per Darbitex pool by design (no singleton, no canonical-pair lock).
/// Token-agnostic: any FA reward token, any rate.
///
/// Accepts both naked `Object<LpPosition>` (via `stake_lp`) and locked
/// `Object<LockedPosition>` from `darbitex_lp_locker` (via `stake_locked_lp`).
/// Lock invariant inherited end-to-end: a locked-staked LP cannot have its
/// inner LpPosition extracted before the locker `unlock_at_seconds` deadline
/// regardless of staking package state.
///
/// Zero admin. No fees. No initial-reward mandate.

module darbitex_staking::staking {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, Metadata};
    use aptos_framework::object::{Self, Object, ExtendRef, DeleteRef};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool::{Self, LpPosition};
    use darbitex_lp_locker::lock::{Self, LockedPosition};

    // ===== Errors =====

    const E_NOT_OWNER: u64 = 1;
    const E_ZERO_AMOUNT: u64 = 2;
    const E_WRONG_POOL: u64 = 3;
    const E_NOTHING_CLAIMABLE: u64 = 4;
    const E_BAD_PARAMS: u64 = 5;
    const E_NOT_NAKED: u64 = 6;
    const E_NOT_LOCKED: u64 = 7;

    // ===== Constants =====

    const SCALE: u128 = 1_000_000_000_000;

    // ===== On-chain disclosure =====

    const WARNING: vector<u8> = b"DARBITEX LP STAKING is an agnostic adoption/retention distribution primitive on Aptos. The package deploys under a 3-of-5 multisig with upgrade_policy = compatible during a stabilization soak; after the soak the policy is intended to be flipped to immutable. Once immutable the package is permanently immutable - no admin authority, no pause, no upgrade, no policy parameter. Bugs are unrecoverable. Audit this code yourself before interacting. DESIGN: Pure-proportional staking primitive for any FA reward token. Emission rate equals total_staked_shares divided by pool lp_supply times max_rate_per_sec. There is NO stake_target parameter, NO boost schedule, NO admin lever. Distribution intensity is a function of community participation only. Token-agnostic - suitable for any retention reward, adoption incentive, or fair-launch experiment. The mechanism scales emission with the fraction of pool LP that is actively staked. LP that sits in the pool but is not wrapped in an LpStakePosition reduces emission proportionally - all participants treated symmetrically. Adoption-driven scaling is observable on-chain via staked_fraction_bps and unstaked_lp_shares views. KNOWN LIMITATIONS: (1) MULTIPLE REWARD POOLS PER DARBITEX POOL ALLOWED - anyone can create a reward pool for any Darbitex pool, with any reward token, any max_rate. Multiple coexisting reward streams per pool are by design. Frontends should display all reward pools per pool and let users choose. No singleton, no first-mover slot, no canonical-pair lock. Permissionless creation prevents adversarial squatting on a canonical slot. (2) POOL-DERIVED DENOMINATOR - Denominator equals pool::lp_supply, recomputed at every state-changing call. When other LPs add liquidity to the pool but do NOT stake, your emission rate decreases proportionally. When other LPs remove liquidity, your emission rate increases. INTENTIONAL design - emission tracks active staking participation, not just total liquidity. (3) NO STAKE_TARGET CAP - No creator-set parameter for emission ramp. The 100 percent mark is automatically pool::lp_supply (canonical truth). Creators cannot misconfigure; the formula is policy-free. (4) ADOPTION-DRIVEN EMISSION - LP existing in pool but not staked sits in denominator only and does not earn emission. Anyone holding LP can stake (and earn) or hold unstaked (and not earn). The formula treats all participants symmetrically; staked-fraction adoption alone determines emission rate. Observable on-chain via the views; no special role for any address. (5) BOTH NAKED AND LOCKED LP ACCEPTED - stake_lp accepts Object<LpPosition>; stake_locked_lp accepts Object<LockedPosition> from darbitex_lp_locker. Both unlock the same emission stream with no multiplier difference. Lock invariant from locker is INHERITED end-to-end - a locked-staked position cannot have its inner LpPosition extracted before locker unlock_at_seconds regardless of staking package state. Three-firewall composition: Aptos object ownership, staking module privacy, locker time-gate. (6) NO MULTIPLIER FOR LOCK DURATION - Naked and Locked LP earn equal rate per share. Multiplier-by-duration explicitly rejected because original-duration multiplier is gameable via wrapper transfer and remaining-time multiplier adds complexity. Future packages may layer multiplier via separate wrapper. (7) WRONG-POOL REJECTED - At stake-time the position pool is verified against the reward pool by FungibleAsset metadata equality between pool::pool_tokens and the asset_metadata of fees harvested at stake-time. Mismatched stake calls abort with E_WRONG_POOL before the LpStakePosition resource is created. (8) NO SLASHING - Staked LP is only voluntarily unstakeable by the owner. No admin path to seize, no automatic forfeiture. (9) EMISSION CAPPED BY FREE REWARD BALANCE - Emission is bounded by physical primary_fungible_store balance minus committed_rewards. committed_rewards represents pending already credited to acc_reward_per_share but unclaimed. Repeated update_pool calls cannot re-emit against committed coins. When free balance hits zero, accumulator stalls. Anyone can call deposit_rewards to top up; no admin gate. If never topped up, emission permanently stops. (10) PROPORTIONAL TO STAKED SHARES - Per-staker reward equals staker shares times the difference between current acc_reward_per_share and the staker acc_at_stake snapshot, divided by SCALE, computed in u256 to absorb large-share-times-large-acc products. Pool-derived denominator only affects AGGREGATE emission rate; per-staker split is by stake size. (11) NO INITIAL REWARD MANDATE - create_lp_reward_pool does not require any initial reward deposit. Empty reward pools are valid; emission stalls until someone calls deposit_rewards. Permissionless top-up. Creator-side empty-pool grief is bounded by gas plus storage; reward token value, supply, and decimals are unknowable to the contract so any minimum-floor would be policy noise. (12) UPGRADE POLICY - the package deploys with upgrade_policy = compatible during the stabilization soak, governed by a 3-of-5 multisig. Multisig owners can publish breaking upgrades during this window. After the soak the policy is intended to be set immutable, after which no party can publish further upgrades. Watch package upgrade events on-chain to confirm the transition. (13) AUTHORSHIP AND AUDIT DISCLOSURE - Built by solo developer working with Claude (Anthropic AI). All audits AI-based. NO professional human security audit firm has reviewed this code. Once the package is set immutable the protocol is ownerless and permissionless - no team, no foundation, no legal entity, no responsible party, no support channel. All losses borne entirely by users. (14) ACCUMULATOR OVERFLOW DOS - The acc_reward_per_share field is u128. Under adversarial parameters (max_rate_per_sec near u64::MAX, very small total_staked_shares, ~1.8 times 10 to the 7 update_pool calls) the accumulator could theoretically overflow. Move arithmetic overflow ABORTS the transaction. Once saturation is approached, every subsequent update_pool call aborts - which means every claim_rewards, unstake_naked, unstake_locked, deposit_rewards, and create_stake against that reward pool also aborts (all of these run update_pool). Stakers cannot claim, cannot unstake, cannot deposit more rewards. The reward pool is permanently bricked - principal LP positions and locked wrappers staked into it become inaccessible, not just unclaimed rewards. Practical reachability is extreme (would require approximately 18 million transactions at adversarial parameters), but the failure mode is principal lockout, not graceful emission halt. Treat as design accept matching Sui R3+R4 - no defensive cap is added because operating envelope makes it unreachable. (15) STAKE WRAPPER TRANSFERABILITY - LpStakePosition is an Aptos object resource freely transferable via object::transfer. Transferring the stake wrapper carries ALL economic rights to the new owner: the right to claim emission rewards via claim_rewards, the right to claim LP fees via claim_lp_fees, and the right to unstake via unstake_naked or unstake_locked which returns the underlying LpPosition or LockedPosition wrapper to the new owner. Custody transfer is the user voluntary act. Frontends should warn users that transferring the stake wrapper permanently transfers control of the staked LP, all unclaimed pending rewards, and all future emission rights. (16) UNKNOWN FUTURE LIMITATIONS - This list reflects only limitations identified at audit time. Future analysis or interactions may reveal additional risks. After the package is set immutable, newly discovered limitations CANNOT be patched. Treat preceding 15 items as non-exhaustive lower bound. By interacting with the staking package you confirm you have read and understood all 16 numbered limitations and accept full responsibility for any and all losses.";

    // ===== State =====

    /// Per-Darbitex-pool reward stream. Multiple instances per pool allowed.
    /// `committed_rewards` tracks unclaimed pending Σ across all stakers, so
    /// `update_pool` can cap emission at FREE balance (physical − committed)
    /// rather than physical alone — closes the over-credit re-emission path.
    struct LpRewardPool has key {
        pool_addr: address,
        reward_token: Object<Metadata>,
        max_rate_per_sec: u64,
        acc_reward_per_share: u128,
        last_reward_time_seconds: u64,
        total_staked_shares: u64,
        committed_rewards: u64,
        extend_ref: ExtendRef,
    }

    /// Variant union for staked LP. Module-private destructure ensures the
    /// inner handle is only extractable via the matching `unstake_*` entry.
    enum StakedLp has store {
        Naked(Object<LpPosition>),
        Locked(Object<LockedPosition>),
    }

    /// `acc_at_stake` is the per-share snapshot at stake/claim time. Pending
    /// is computed in u256 as `floor(shares · current_acc / SCALE) −
    /// floor(shares · acc_at_stake / SCALE)` to absorb large products that
    /// would overflow u128.
    struct LpStakePosition has key {
        reward_pool_addr: address,
        inner: StakedLp,
        shares: u64,
        acc_at_stake: u128,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    // ===== Events =====

    #[event]
    struct LpRewardPoolCreated has drop, store {
        creator: address,
        reward_pool_addr: address,
        pool_addr: address,
        reward_token: address,
        max_rate_per_sec: u64,
    }

    #[event]
    struct LpRewardsDeposited has drop, store {
        depositor: address,
        reward_pool_addr: address,
        amount: u64,
        new_balance: u64,
    }

    #[event]
    struct LpStaked has drop, store {
        user: address,
        stake_addr: address,
        reward_pool_addr: address,
        source_addr: address,
        shares: u64,
        locked_variant: bool,
    }

    #[event]
    struct LpRewardsClaimed has drop, store {
        user: address,
        stake_addr: address,
        reward_pool_addr: address,
        amount: u64,
    }

    #[event]
    struct LpFeesClaimed has drop, store {
        user: address,
        stake_addr: address,
        reward_pool_addr: address,
        fees_a: u64,
        fees_b: u64,
        locked_variant: bool,
    }

    #[event]
    struct LpUnstaked has drop, store {
        user: address,
        stake_addr: address,
        reward_pool_addr: address,
        source_addr: address,
        shares: u64,
        rewards_claimed: u64,
        locked_variant: bool,
    }

    // ===== Reward pool management =====

    public entry fun create_lp_reward_pool(
        creator: &signer,
        pool_addr: address,
        reward_token: Object<Metadata>,
        max_rate_per_sec: u64,
    ) {
        let _ = create_reward_pool(creator, pool_addr, reward_token, max_rate_per_sec);
    }

    fun create_reward_pool(
        creator: &signer,
        pool_addr: address,
        reward_token: Object<Metadata>,
        max_rate_per_sec: u64,
    ): Object<LpRewardPool> {
        assert!(pool::pool_exists(pool_addr), E_WRONG_POOL);
        assert!(max_rate_per_sec > 0, E_BAD_PARAMS);

        let creator_addr = signer::address_of(creator);
        let ctor = object::create_object(creator_addr);
        let rp_signer = object::generate_signer(&ctor);
        let rp_addr = signer::address_of(&rp_signer);

        move_to(&rp_signer, LpRewardPool {
            pool_addr,
            reward_token,
            max_rate_per_sec,
            acc_reward_per_share: 0,
            last_reward_time_seconds: timestamp::now_seconds(),
            total_staked_shares: 0,
            committed_rewards: 0,
            extend_ref: object::generate_extend_ref(&ctor),
        });

        event::emit(LpRewardPoolCreated {
            creator: creator_addr,
            reward_pool_addr: rp_addr,
            pool_addr,
            reward_token: object::object_address(&reward_token),
            max_rate_per_sec,
        });

        object::address_to_object<LpRewardPool>(rp_addr)
    }

    /// Permissionless top-up. Anyone can deposit any amount of the reward
    /// token to extend emission runway.
    public entry fun deposit_rewards(
        depositor: &signer,
        reward_pool: Object<LpRewardPool>,
        amount: u64,
    ) acquires LpRewardPool {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let rp_addr = object::object_address(&reward_pool);
        let rp = borrow_global_mut<LpRewardPool>(rp_addr);
        update_pool(rp, rp_addr);

        let fa = primary_fungible_store::withdraw(depositor, rp.reward_token, amount);
        primary_fungible_store::deposit(rp_addr, fa);
        let new_balance = primary_fungible_store::balance(rp_addr, rp.reward_token);

        event::emit(LpRewardsDeposited {
            depositor: signer::address_of(depositor),
            reward_pool_addr: rp_addr,
            amount,
            new_balance,
        });
    }

    // ===== Stake =====

    public entry fun stake_lp(
        user: &signer,
        reward_pool: Object<LpRewardPool>,
        position: Object<LpPosition>,
    ) acquires LpRewardPool {
        let _ = create_stake(user, reward_pool, StakedLp::Naked(position));
    }

    public entry fun stake_locked_lp(
        user: &signer,
        reward_pool: Object<LpRewardPool>,
        locked: Object<LockedPosition>,
    ) acquires LpRewardPool {
        let _ = create_stake(user, reward_pool, StakedLp::Locked(locked));
    }

    fun create_stake(
        user: &signer,
        reward_pool: Object<LpRewardPool>,
        inner: StakedLp,
    ): Object<LpStakePosition> acquires LpRewardPool {
        let rp_addr = object::object_address(&reward_pool);
        let rp = borrow_global_mut<LpRewardPool>(rp_addr);
        update_pool(rp, rp_addr);

        let user_addr = signer::address_of(user);
        let ctor = object::create_object(user_addr);
        let stake_signer = object::generate_signer(&ctor);
        let stake_addr = signer::address_of(&stake_signer);

        let (shares, source_addr, locked_variant) = match (&inner) {
            StakedLp::Naked(p) => (pool::position_shares(*p), object::object_address(p), false),
            StakedLp::Locked(l) => (lock::position_shares(*l), object::object_address(l), true),
        };
        assert!(shares > 0, E_ZERO_AMOUNT);

        let (fa_a, fa_b) = match (&inner) {
            StakedLp::Naked(p) => {
                let position = *p;
                object::transfer(user, position, stake_addr);
                pool::claim_lp_fees(&stake_signer, position)
            },
            StakedLp::Locked(l) => {
                let locked = *l;
                object::transfer(user, locked, stake_addr);
                lock::claim_fees_assets(&stake_signer, locked)
            },
        };

        let (expected_a, expected_b) = pool::pool_tokens(rp.pool_addr);
        assert!(fungible_asset::asset_metadata(&fa_a) == expected_a, E_WRONG_POOL);
        assert!(fungible_asset::asset_metadata(&fa_b) == expected_b, E_WRONG_POOL);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        let acc_at_stake = rp.acc_reward_per_share;
        move_to(&stake_signer, LpStakePosition {
            reward_pool_addr: rp_addr,
            inner,
            shares,
            acc_at_stake,
            extend_ref: object::generate_extend_ref(&ctor),
            delete_ref: object::generate_delete_ref(&ctor),
        });
        rp.total_staked_shares = rp.total_staked_shares + shares;

        event::emit(LpStaked {
            user: user_addr,
            stake_addr,
            reward_pool_addr: rp_addr,
            source_addr,
            shares,
            locked_variant,
        });

        object::address_to_object<LpStakePosition>(stake_addr)
    }

    // ===== Claim emission rewards =====

    public entry fun claim_rewards(
        user: &signer,
        stake: Object<LpStakePosition>,
    ) acquires LpRewardPool, LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let sp = borrow_global_mut<LpStakePosition>(stake_addr);
        let rp_addr = sp.reward_pool_addr;
        let rp = borrow_global_mut<LpRewardPool>(rp_addr);
        update_pool(rp, rp_addr);

        let pending = pending_reward(sp.shares, rp.acc_reward_per_share, sp.acc_at_stake);
        assert!(pending > 0, E_NOTHING_CLAIMABLE);
        sp.acc_at_stake = rp.acc_reward_per_share;
        rp.committed_rewards = rp.committed_rewards - pending;

        let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
        let fa = primary_fungible_store::withdraw(&rp_signer, rp.reward_token, pending);
        primary_fungible_store::deposit(user_addr, fa);

        event::emit(LpRewardsClaimed {
            user: user_addr,
            stake_addr,
            reward_pool_addr: rp_addr,
            amount: pending,
        });
    }

    // ===== Claim LP fees (proxies through inner variant) =====

    /// Routes through the inner variant: Naked → `pool::claim_lp_fees`,
    /// Locked → `lock::claim_fees_assets`. Does NOT call `update_pool` —
    /// emission accumulator is unaffected. Indexers / views querying
    /// `stake_pending_reward` immediately after may see stale acc until
    /// the next state-mutating call.
    public entry fun claim_lp_fees(
        user: &signer,
        stake: Object<LpStakePosition>,
    ) acquires LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        let sp = borrow_global<LpStakePosition>(stake_addr);
        let stake_signer = object::generate_signer_for_extending(&sp.extend_ref);

        let (fa_a, fa_b, locked_variant) = match (&sp.inner) {
            StakedLp::Naked(p) => {
                let (a, b) = pool::claim_lp_fees(&stake_signer, *p);
                (a, b, false)
            },
            StakedLp::Locked(l) => {
                let (a, b) = lock::claim_fees_assets(&stake_signer, *l);
                (a, b, true)
            },
        };

        let fees_a = fungible_asset::amount(&fa_a);
        let fees_b = fungible_asset::amount(&fa_b);
        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        event::emit(LpFeesClaimed {
            user: user_addr,
            stake_addr,
            reward_pool_addr: sp.reward_pool_addr,
            fees_a,
            fees_b,
            locked_variant,
        });
    }

    // ===== Unstake (typed variants) =====

    public entry fun unstake_naked(
        user: &signer,
        stake: Object<LpStakePosition>,
    ) acquires LpRewardPool, LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        {
            let sp_ref = borrow_global<LpStakePosition>(stake_addr);
            let is_naked = match (&sp_ref.inner) {
                StakedLp::Naked(_) => true,
                StakedLp::Locked(_) => false,
            };
            assert!(is_naked, E_NOT_NAKED);
        };

        let LpStakePosition { reward_pool_addr, inner, shares, acc_at_stake, extend_ref, delete_ref }
            = move_from<LpStakePosition>(stake_addr);

        let position = match (inner) {
            StakedLp::Naked(p) => p,
            StakedLp::Locked(_) => abort E_NOT_NAKED,
        };

        let rp = borrow_global_mut<LpRewardPool>(reward_pool_addr);
        update_pool(rp, reward_pool_addr);

        let pending = pending_reward(shares, rp.acc_reward_per_share, acc_at_stake);
        rp.total_staked_shares = rp.total_staked_shares - shares;

        if (pending > 0) {
            rp.committed_rewards = rp.committed_rewards - pending;
            let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
            let fa = primary_fungible_store::withdraw(&rp_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, fa);
        };

        let stake_signer = object::generate_signer_for_extending(&extend_ref);
        object::transfer(&stake_signer, position, user_addr);
        object::delete(delete_ref);

        event::emit(LpUnstaked {
            user: user_addr,
            stake_addr,
            reward_pool_addr,
            source_addr: object::object_address(&position),
            shares,
            rewards_claimed: pending,
            locked_variant: false,
        });
    }

    public entry fun unstake_locked(
        user: &signer,
        stake: Object<LpStakePosition>,
    ) acquires LpRewardPool, LpStakePosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(stake) == user_addr, E_NOT_OWNER);

        let stake_addr = object::object_address(&stake);
        {
            let sp_ref = borrow_global<LpStakePosition>(stake_addr);
            let is_locked = match (&sp_ref.inner) {
                StakedLp::Locked(_) => true,
                StakedLp::Naked(_) => false,
            };
            assert!(is_locked, E_NOT_LOCKED);
        };

        let LpStakePosition { reward_pool_addr, inner, shares, acc_at_stake, extend_ref, delete_ref }
            = move_from<LpStakePosition>(stake_addr);

        let locked = match (inner) {
            StakedLp::Locked(l) => l,
            StakedLp::Naked(_) => abort E_NOT_LOCKED,
        };

        let rp = borrow_global_mut<LpRewardPool>(reward_pool_addr);
        update_pool(rp, reward_pool_addr);

        let pending = pending_reward(shares, rp.acc_reward_per_share, acc_at_stake);
        rp.total_staked_shares = rp.total_staked_shares - shares;

        if (pending > 0) {
            rp.committed_rewards = rp.committed_rewards - pending;
            let rp_signer = object::generate_signer_for_extending(&rp.extend_ref);
            let fa = primary_fungible_store::withdraw(&rp_signer, rp.reward_token, pending);
            primary_fungible_store::deposit(user_addr, fa);
        };

        let stake_signer = object::generate_signer_for_extending(&extend_ref);
        object::transfer(&stake_signer, locked, user_addr);
        object::delete(delete_ref);

        event::emit(LpUnstaked {
            user: user_addr,
            stake_addr,
            reward_pool_addr,
            source_addr: object::object_address(&locked),
            shares,
            rewards_claimed: pending,
            locked_variant: true,
        });
    }

    // ===== Internal accumulator =====

    /// Advance accumulator state. Caps emission at FREE balance (physical −
    /// committed) to prevent re-emission against committed unclaimed coins.
    /// Time-remainder accumulation: clock only advances by `accounted_seconds`
    /// derived from `paid` via ceiling division — guarantees ≥1 sec advance
    /// when paid > 0 and avoids stalling on awkward parameters.
    fun update_pool(rp: &mut LpRewardPool, rp_addr: address) {
        let now = timestamp::now_seconds();
        if (now <= rp.last_reward_time_seconds) return;

        let pool_supply = pool::lp_supply(rp.pool_addr);
        let staked = rp.total_staked_shares;
        if (staked == 0 || pool_supply == 0) {
            rp.last_reward_time_seconds = now;
            return
        };

        let phys = primary_fungible_store::balance(rp_addr, rp.reward_token);
        let committed = rp.committed_rewards;
        let free = if (phys > committed) phys - committed else 0;

        let elapsed_u256 = ((now - rp.last_reward_time_seconds) as u256);
        let staked_u256 = (staked as u256);
        let supply_u256 = (pool_supply as u256);
        let max_rate_u256 = (rp.max_rate_per_sec as u256);
        let total_reward_u256 = elapsed_u256 * staked_u256 * max_rate_u256 / supply_u256;
        let free_u256 = (free as u256);
        let paid_u256 = if (total_reward_u256 > free_u256) free_u256 else total_reward_u256;
        let paid = (paid_u256 as u64);

        // Grief mitigation: paid==0 leaves clock pinned, elapsed accumulates.
        if (paid == 0) return;

        // Dust-leak guard: per_share_bump truncates to 0 when paid·SCALE < staked.
        // Skip clock + commit so paid stays in free balance for next call.
        let per_share_bump = (paid as u128) * SCALE / (staked as u128);
        if (per_share_bump == 0) return;

        rp.acc_reward_per_share = rp.acc_reward_per_share + per_share_bump;
        rp.committed_rewards = rp.committed_rewards + paid;

        // Ceiling division: guarantees accounted_seconds ≥ 1 when paid > 0.
        // Floor would truncate to 0 when paid·supply < staked·max_rate, leaving
        // the clock stalled while acc bumped — repeated calls would re-emit
        // against the same elapsed window.
        let denom = staked_u256 * max_rate_u256;
        let accounted_seconds_u256 = (paid_u256 * supply_u256 + denom - 1) / denom;
        rp.last_reward_time_seconds = rp.last_reward_time_seconds + (accounted_seconds_u256 as u64);
    }

    /// `floor(shares · current_acc / SCALE) − floor(shares · acc_at_stake / SCALE)`,
    /// computed in u256 to avoid u128 overflow on large products. Standard
    /// MasterChef-v2 rounding (each term floored independently).
    fun pending_reward(shares: u64, current_acc: u128, acc_at_stake: u128): u64 {
        let scale_u256 = (SCALE as u256);
        let raw = (shares as u256) * (current_acc as u256) / scale_u256;
        let debt = (shares as u256) * (acc_at_stake as u256) / scale_u256;
        if (raw <= debt) return 0;
        ((raw - debt) as u64)
    }

    // ===== Views =====

    #[view]
    public fun reward_pool_info(
        reward_pool: Object<LpRewardPool>,
    ): (address, address, u64, u64, u64, u64) acquires LpRewardPool {
        let rp_addr = object::object_address(&reward_pool);
        let rp = borrow_global<LpRewardPool>(rp_addr);
        let phys = primary_fungible_store::balance(rp_addr, rp.reward_token);
        (
            rp.pool_addr,
            object::object_address(&rp.reward_token),
            rp.max_rate_per_sec,
            rp.total_staked_shares,
            phys,
            rp.committed_rewards,
        )
    }

    #[view]
    public fun stake_info(
        stake: Object<LpStakePosition>,
    ): (address, address, u64, bool) acquires LpStakePosition {
        let sp = borrow_global<LpStakePosition>(object::object_address(&stake));
        let (source_addr, locked_variant) = match (&sp.inner) {
            StakedLp::Naked(p) => (object::object_address(p), false),
            StakedLp::Locked(l) => (object::object_address(l), true),
        };
        (sp.reward_pool_addr, source_addr, sp.shares, locked_variant)
    }

    #[view]
    public fun current_emission_rate_per_sec(
        reward_pool: Object<LpRewardPool>,
    ): u64 acquires LpRewardPool {
        let rp = borrow_global<LpRewardPool>(object::object_address(&reward_pool));
        let supply = pool::lp_supply(rp.pool_addr);
        if (supply == 0 || rp.total_staked_shares == 0) return 0;
        (((rp.total_staked_shares as u256) * (rp.max_rate_per_sec as u256) / (supply as u256)) as u64)
    }

    #[view]
    public fun staked_fraction_bps(
        reward_pool: Object<LpRewardPool>,
    ): u64 acquires LpRewardPool {
        let rp = borrow_global<LpRewardPool>(object::object_address(&reward_pool));
        let supply = pool::lp_supply(rp.pool_addr);
        if (supply == 0) return 0;
        (((rp.total_staked_shares as u128) * 10000 / (supply as u128)) as u64)
    }

    #[view]
    public fun unstaked_lp_shares(
        reward_pool: Object<LpRewardPool>,
    ): u64 acquires LpRewardPool {
        let rp = borrow_global<LpRewardPool>(object::object_address(&reward_pool));
        let supply = pool::lp_supply(rp.pool_addr);
        if (supply <= rp.total_staked_shares) 0 else supply - rp.total_staked_shares
    }

    #[view]
    public fun stake_pending_reward(
        stake: Object<LpStakePosition>,
    ): u64 acquires LpRewardPool, LpStakePosition {
        let stake_addr = object::object_address(&stake);
        let sp = borrow_global<LpStakePosition>(stake_addr);
        let rp_addr = sp.reward_pool_addr;
        let rp = borrow_global<LpRewardPool>(rp_addr);

        let now = timestamp::now_seconds();
        let pool_supply = pool::lp_supply(rp.pool_addr);
        let staked = rp.total_staked_shares;
        let acc = rp.acc_reward_per_share;

        if (now > rp.last_reward_time_seconds && staked > 0 && pool_supply > 0) {
            let phys = primary_fungible_store::balance(rp_addr, rp.reward_token);
            let committed = rp.committed_rewards;
            let free = if (phys > committed) phys - committed else 0;

            let elapsed_u256 = ((now - rp.last_reward_time_seconds) as u256);
            let staked_u256 = (staked as u256);
            let supply_u256 = (pool_supply as u256);
            let max_rate_u256 = (rp.max_rate_per_sec as u256);
            let total_reward_u256 = elapsed_u256 * staked_u256 * max_rate_u256 / supply_u256;
            let free_u256 = (free as u256);
            let paid_u256 = if (total_reward_u256 > free_u256) free_u256 else total_reward_u256;
            let paid = (paid_u256 as u64);

            if (paid > 0) {
                let bump = (paid as u128) * SCALE / (staked as u128);
                acc = acc + bump;
            };
        };

        pending_reward(sp.shares, acc, sp.acc_at_stake)
    }

    #[view]
    public fun read_warning(): vector<u8> { WARNING }

    // ===== Test-only handles =====

    #[test_only]
    public fun create_lp_reward_pool_and_get(
        creator: &signer,
        pool_addr: address,
        reward_token: Object<Metadata>,
        max_rate_per_sec: u64,
    ): Object<LpRewardPool> {
        create_reward_pool(creator, pool_addr, reward_token, max_rate_per_sec)
    }

    #[test_only]
    public fun stake_lp_and_get(
        user: &signer,
        reward_pool: Object<LpRewardPool>,
        position: Object<LpPosition>,
    ): Object<LpStakePosition> acquires LpRewardPool {
        create_stake(user, reward_pool, StakedLp::Naked(position))
    }

    #[test_only]
    public fun stake_locked_lp_and_get(
        user: &signer,
        reward_pool: Object<LpRewardPool>,
        locked: Object<LockedPosition>,
    ): Object<LpStakePosition> acquires LpRewardPool {
        create_stake(user, reward_pool, StakedLp::Locked(locked))
    }
}
