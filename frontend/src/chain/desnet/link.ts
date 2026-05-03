import type { RpcPool } from "../rpc-pool";
import { DESNET_PACKAGE } from "../../config";
import type { MoveArg, MoveFn } from "./tx";

const MOD = "link";

export const SYNC_FN = `${DESNET_PACKAGE}::${MOD}::sync` as MoveFn;
export const UNSYNC_FN = `${DESNET_PACKAGE}::${MOD}::unsync` as MoveFn;

export function syncArgs(targetPid: string, syncerStakePos = "0x0"): MoveArg[] {
  return [targetPid, syncerStakePos];
}

export function unsyncArgs(targetPid: string): MoveArg[] {
  return [targetPid];
}

export async function isSynced(
  rpc: RpcPool,
  syncerPid: string,
  targetPid: string,
): Promise<boolean> {
  try {
    const r = await rpc.viewFn<[boolean]>(
      MOD + "::is_synced",
      [],
      [syncerPid, targetPid],
      DESNET_PACKAGE,
    );
    return Boolean(r[0]);
  } catch {
    return false;
  }
}

export async function syncCount(rpc: RpcPool, pidAddr: string): Promise<number> {
  const r = await rpc.viewFn<[string]>(MOD + "::sync_count", [], [pidAddr], DESNET_PACKAGE);
  return Number(r[0]);
}

export async function syncedByCount(rpc: RpcPool, pidAddr: string): Promise<number> {
  const r = await rpc.viewFn<[string]>(MOD + "::synced_by_count", [], [pidAddr], DESNET_PACKAGE);
  return Number(r[0]);
}
