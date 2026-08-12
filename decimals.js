// Arc has two USDC precisions on one shared ledger: 18dp native (msg.value, plain
// sends, TipRouter's gross/net/fee) and 6dp ERC-20 (Permit2, balanceOf, transfers).
// Mixing them is a 1e12 error. Mirrors contracts/primitives/ArcDecimals.sol.
export const SCALE = 1000000000000n;

export function to6(amount18) {
  if (amount18 % SCALE !== 0n) throw new Error(`precision loss converting ${amount18}`);
  return amount18 / SCALE;
}

export const to6Floor = (amount18) => amount18 / SCALE;
export const to18 = (amount6) => amount6 * SCALE;
