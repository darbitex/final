import {
  Aptos,
  AptosConfig,
  type InputViewFunctionData,
  type MoveValue,
} from "@aptos-labs/ts-sdk";
import { NETWORK, PACKAGE, RPC_LIST, type RpcEndpoint } from "../config";

// Power-user escape hatch — identical semantics to Beta. JSON array of
// URLs under `darbitex.rpcOverride` is prepended to every pool.
function readRpcOverride(): RpcEndpoint[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem("darbitex.rpcOverride");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((x): x is string => typeof x === "string" && x.startsWith("http"))
        .map((url) => ({ url }));
    }
  } catch {
    // ignore malformed override
  }
  return [];
}

// Transient = safe to retry on another provider. Rate limits, gateway
// errors, browser fetch network errors.
//
// IMPORTANT: 404 is deterministic — a missing resource / missing account
// returns the same answer on every provider, so retrying is pure waste
// (burns the Geomi budget + falls through to public fallbacks). Same for
// 400/401/403. Only true "server couldn't process" conditions rotate.
export function isTransientError(err: unknown): boolean {
  const asErr = err as { name?: string; message?: string; status?: number };

  // Preferred path: the SDK surfaces the HTTP status code on the thrown
  // error object. Trust the status code before falling back to message
  // heuristics — message parsing was historically too permissive and
  // mis-tagged 404s as transient via the "json"/"unexpected token"
  // catch-all.
  if (typeof asErr?.status === "number") {
    const s = asErr.status;
    if (s === 429) return true;
    if (s >= 500 && s <= 599) return true;
    return false; // 4xx (incl. 404) → deterministic miss, don't rotate
  }

  const msg = String(asErr?.message ?? err).toLowerCase();
  if (asErr?.name === "TypeError" && msg.includes("fetch")) return true;

  // Never rotate on a resource-not-found message, even if the SDK
  // forgot to attach a status code.
  if (
    msg.includes("resource not found") ||
    msg.includes("resource_not_found") ||
    msg.includes("not found") ||
    msg.includes("404")
  ) {
    return false;
  }

  return (
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("504") ||
    msg.includes("rate limit") ||
    msg.includes("too many") ||
    msg.includes("service unavailable") ||
    msg.includes("bad gateway") ||
    msg.includes("failed to fetch") ||
    msg.includes("fetch failed") ||
    msg.includes("networkerror") ||
    msg.includes("load failed") ||
    msg.includes("timeout") ||
    msg.includes("aborted")
  );
}

export class RpcExhaustedError extends Error {
  constructor(poolName: string) {
    super(`RPC pool "${poolName}" — all endpoints cooling`);
    this.name = "RpcExhaustedError";
  }
}

export type RpcPoolOptions = {
  maxInFlight?: number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
};

export type RpcPool = {
  readonly name: string;
  rotatedView<T extends MoveValue[] = MoveValue[]>(
    payload: InputViewFunctionData,
  ): Promise<T>;
  rotatedGetResource<T>(
    accountAddress: string,
    resourceType: string,
  ): Promise<T>;
  viewFn<T extends MoveValue[] = MoveValue[]>(
    fn: string,
    typeArguments?: string[],
    functionArguments?: unknown[],
    packageOverride?: string,
  ): Promise<T>;
  // First client in the rotation — exposed for SDK calls that go beyond
  // view/getAccountResource (e.g. submitTransaction, waitForTransaction,
  // getCurrentFungibleAssetBalances). These don't participate in the
  // cooldown/rotation logic because failures are intentional (wrong
  // password, nonce race) rather than load-induced.
  readonly primary: Aptos;
};

// Factory. Each call produces a fully independent pool: own Aptos client
// array, own semaphore, own cooldown/cursor state. A rate-limit storm on
// pool A cannot poison pool B. Combined with lazy routing + no background
// pollers, inactive pages contribute zero traffic to the per-IP budget.
export function createRpcPool(name: string, opts: RpcPoolOptions = {}): RpcPool {
  const MAX_IN_FLIGHT = opts.maxInFlight ?? 2;
  const BASE_COOLDOWN_MS = opts.baseCooldownMs ?? 3_000;
  const MAX_COOLDOWN_MS = opts.maxCooldownMs ?? 60_000;

  const effectiveList: RpcEndpoint[] = [...readRpcOverride(), ...RPC_LIST];

  const aptosClients: Aptos[] = effectiveList.map(
    (ep) =>
      new Aptos(
        new AptosConfig({
          network: NETWORK,
          fullnode: ep.url,
          clientConfig: ep.headers ? { HEADERS: ep.headers } : undefined,
        }),
      ),
  );

  const cooldownUntil: number[] = new Array(aptosClients.length).fill(0);
  const failureStreak: number[] = new Array(aptosClients.length).fill(0);

  let inFlight = 0;
  const waiters: Array<() => void> = [];
  let cursor = 0;

  function acquireSlot(): Promise<void> {
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        inFlight += 1;
        resolve();
      });
    });
  }

  function releaseSlot(): void {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  function markCooling(idx: number): void {
    failureStreak[idx] += 1;
    const step = Math.min(failureStreak[idx] - 1, 5);
    const cool = Math.min(BASE_COOLDOWN_MS * Math.pow(2, step), MAX_COOLDOWN_MS);
    cooldownUntil[idx] = Date.now() + cool;
  }

  function markSuccess(idx: number): void {
    failureStreak[idx] = 0;
  }

  function buildTryOrder(): number[] {
    const now = Date.now();
    const available: number[] = [];
    const nearlyReady: number[] = [];
    for (let i = 0; i < aptosClients.length; i++) {
      const idx = (cursor + i) % aptosClients.length;
      const remaining = cooldownUntil[idx] - now;
      if (remaining <= 0) available.push(idx);
      else if (remaining <= 1_000) nearlyReady.push(idx);
    }
    cursor = (cursor + 1) % aptosClients.length;
    return [...available, ...nearlyReady];
  }

  async function rotatedView<T extends MoveValue[] = MoveValue[]>(
    payload: InputViewFunctionData,
  ): Promise<T> {
    await acquireSlot();
    try {
      const tryOrder = buildTryOrder();
      if (tryOrder.length === 0) throw new RpcExhaustedError(name);
      let lastErr: unknown = null;
      for (const idx of tryOrder) {
        try {
          const res = await aptosClients[idx].view({ payload });
          markSuccess(idx);
          return res as T;
        } catch (e) {
          if (isTransientError(e)) {
            markCooling(idx);
            lastErr = e;
            continue;
          }
          throw e;
        }
      }
      throw lastErr ?? new RpcExhaustedError(name);
    } finally {
      releaseSlot();
    }
  }

  async function rotatedGetResource<T>(
    accountAddress: string,
    resourceType: string,
  ): Promise<T> {
    await acquireSlot();
    try {
      const tryOrder = buildTryOrder();
      if (tryOrder.length === 0) throw new RpcExhaustedError(name);
      let lastErr: unknown = null;
      for (const idx of tryOrder) {
        try {
          const res = (await aptosClients[idx].getAccountResource({
            accountAddress,
            resourceType: resourceType as `${string}::${string}::${string}`,
          })) as T;
          markSuccess(idx);
          return res;
        } catch (e) {
          if (isTransientError(e)) {
            markCooling(idx);
            lastErr = e;
            continue;
          }
          throw e;
        }
      }
      throw lastErr ?? new RpcExhaustedError(name);
    } finally {
      releaseSlot();
    }
  }

  async function viewFn<T extends MoveValue[] = MoveValue[]>(
    fn: string,
    typeArguments: string[] = [],
    functionArguments: unknown[] = [],
    packageOverride?: string,
  ): Promise<T> {
    const pkg = packageOverride ?? PACKAGE;
    const payload: InputViewFunctionData = {
      function: `${pkg}::${fn}` as `${string}::${string}::${string}`,
      typeArguments,
      functionArguments: functionArguments as InputViewFunctionData["functionArguments"],
    };
    return rotatedView<T>(payload);
  }

  return {
    name,
    rotatedView,
    rotatedGetResource,
    viewFn,
    primary: aptosClients[0],
  };
}

// Helpers shared across pools.
export function toRaw(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}

export function fromRaw(raw: bigint | string | number, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function normMeta(m: string): string {
  return m.replace(/^0x0+/, "0x").toLowerCase();
}

export function metaEq(a: string, b: string): boolean {
  return normMeta(a) === normMeta(b);
}
