import type { RpcPool } from "../rpc-pool";
import { DESNET_PACKAGE } from "../../config";
import type { MoveArg, MoveFn } from "./tx";

const MOD = "press";

export const PRESS_FN = `${DESNET_PACKAGE}::${MOD}::press` as MoveFn;
export const ENABLE_PRESS_FN = `${DESNET_PACKAGE}::${MOD}::enable_press` as MoveFn;

export function pressArgs(authorPid: string, mintSeq: number, stakePos = "0x0"): MoveArg[] {
  return [authorPid, mintSeq.toString(), stakePos];
}

export function enablePressArgs(mintSeq: number, supplyCap: number, windowDays: number): MoveArg[] {
  return [mintSeq.toString(), supplyCap, windowDays];
}

export async function isPressEnabled(
  rpc: RpcPool,
  authorPid: string,
  mintSeq: number,
): Promise<boolean> {
  try {
    const r = await rpc.viewFn<[boolean]>(
      MOD + "::is_press_enabled",
      [],
      [authorPid, mintSeq.toString()],
      DESNET_PACKAGE,
    );
    return Boolean(r[0]);
  } catch {
    return false;
  }
}

export async function pressedCount(
  rpc: RpcPool,
  authorPid: string,
  mintSeq: number,
): Promise<number> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::pressed_count",
    [],
    [authorPid, mintSeq.toString()],
    DESNET_PACKAGE,
  );
  return Number(r[0]);
}

export async function hasPressed(
  rpc: RpcPool,
  presserPid: string,
  authorPid: string,
  mintSeq: number,
): Promise<boolean> {
  try {
    const r = await rpc.viewFn<[boolean]>(
      MOD + "::has_pressed",
      [],
      [presserPid, authorPid, mintSeq.toString()],
      DESNET_PACKAGE,
    );
    return Boolean(r[0]);
  } catch {
    return false;
  }
}
