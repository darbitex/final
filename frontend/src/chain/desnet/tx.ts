// Shared narrow types so the chain/desnet helpers produce values that the
// Aptos wallet adapter accepts without explicit casts at call sites.
//
// `MoveFn` mirrors @aptos-labs/ts-sdk's `MoveFunctionId` template literal
// type. Using a local alias keeps the helpers free of an SDK dependency
// (the SDK type lives behind several re-export indirections that move
// across versions).
//
// `MoveArg` is a relaxed superset of EntryFunctionArgumentTypes /
// SimpleEntryFunctionArgumentTypes — boolean | number | bigint | string |
// number[] covers every shape we actually emit. The wallet adapter
// accepts each of these.

export type MoveFn = `${string}::${string}::${string}`;

export type MoveArg =
  | boolean
  | number
  | bigint
  | string
  | number[]
  | string[]
  | number[][];
