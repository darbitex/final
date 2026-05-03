import { DESNET_PACKAGE } from "../../config";
import type { MoveArg, MoveFn } from "./tx";

const MOD = "pulse";

export const SPARK_FN = `${DESNET_PACKAGE}::${MOD}::spark` as MoveFn;
export const UNSPARK_FN = `${DESNET_PACKAGE}::${MOD}::unspark` as MoveFn;
export const ECHO_FN = `${DESNET_PACKAGE}::${MOD}::echo` as MoveFn;
export const UNECHO_FN = `${DESNET_PACKAGE}::${MOD}::unecho` as MoveFn;

// `actor_stake_position_addr` is @0x0 when caller has no LP-stake position
// AND the target's gate (if any) doesn't require LP-stake. The Move side
// short-circuits if no gate is set.
export function sparkArgs(targetAuthor: string, targetSeq: number, stakePos = "0x0"): MoveArg[] {
  return [targetAuthor, targetSeq.toString(), stakePos];
}

export function unsparkArgs(targetAuthor: string, targetSeq: number): MoveArg[] {
  return [targetAuthor, targetSeq.toString()];
}

export function echoArgs(targetAuthor: string, targetSeq: number, stakePos = "0x0"): MoveArg[] {
  return [targetAuthor, targetSeq.toString(), stakePos];
}

export function unechoArgs(targetAuthor: string, targetSeq: number): MoveArg[] {
  return [targetAuthor, targetSeq.toString()];
}
