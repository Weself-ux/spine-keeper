import 'dotenv/config';
import fs from 'fs';
import { createPublicClient, createWalletClient, http, defineChain,
         parseAbiItem, decodeEventLog, keccak256, encodePacked } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { to6Floor } from './decimals.js';
import { notifyAutoSave } from './notify.js';

const arc = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC] } },
});

const account = privateKeyToAccount(process.env.KEEPER_PK);
const pub = createPublicClient({ chain: arc, transport: http() });
const wallet = createWalletClient({ account, chain: arc, transport: http() });

const EXECUTOR = process.env.EXECUTOR;
const TIP_ROUTER = process.env.TIP_ROUTER;
const ABI = JSON.parse(fs.readFileSync('./abi/PolicyExecutor.json', 'utf8'));

// Arc emits TWO Transfer logs per ERC-20 movement: system emitter 0xffff...fffe
// in 18dp and the ERC-20 interface 0x3600...0000 in 6dp. Any raw-Transfer watcher
// must filter on the ERC-20 emitter or every trigger fires twice. We subscribe to
// TipRouter's own Tipped event instead, so we are not exposed.
const EXECUTED = parseAbiItem(
  'event Executed(bytes32 indexed ruleHash, bytes32 indexed idemKey, address indexed user, address destination, uint256 amount)'
);
const TIPPED = parseAbiItem(
  'event Tipped(address indexed creator, address indexed tipper, uint256 gross, uint256 net, uint256 fee, bytes32 messageHash)'
);

const rules = JSON.parse(fs.readFileSync('./rules.json', 'utf8'));

// TipRouter emits gross/net/fee in 18dp (native USDC precision on Arc).
// PolicyExecutor moves funds via Permit2, which is the 6dp ERC-20 interface.
// Every amount crossing this boundary MUST be divided by SCALE. Getting this
// backwards is a 1e12 error -- the single highest-consequence bug on Arc.

const STATE = './state.json';
const loadState = () =>
  fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { lastBlock: null };
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

// Ecosystem idempotency standard: keccak256(ruleHash, triggerTxHash, triggerLogIndex).
// The same event always produces the same key, so a keeper restarting mid-run
// cannot double-execute. Consumed on-chain, not in this process.
function idemKey(ruleHash, txHash, logIndex) {
  return keccak256(encodePacked(
    ['bytes32', 'bytes32', 'uint256'], [ruleHash, txHash, BigInt(logIndex)]));
}

function ruleTuple(r) {
  return [r.user, r.subjectId, r.factory, r.ruleType,
          BigInt(r.maxPerExecution), BigInt(r.maxTotal),
          BigInt(r.expiry), BigInt(r.salt)];
}

async function handleTip(log) {
  const creator = log.args.creator.toLowerCase();
  const entry = rules[creator];
  if (!entry) return;

  // Hard ceiling on save percentage. Ruled: a creator may never auto-save more
  // than 50% of a tip. At 100% their wallet reaches zero and they cannot afford
  // the gas -- itself USDC on Arc -- to call revokeRule and turn it off. Clamp
  // here regardless of what rules.json says, so a bad config cannot exceed it.
  const pct = entry.savePct > 50 ? 50 : entry.savePct;

  // net is the creator's share after Tiplyfi's fee; save a percentage of that.
  // Floor is intended here: a percentage of a tip rarely lands on a whole 6dp unit,
  // and sub-cent dust simply stays in the creator's wallet for the next sweep.
  let amount = to6Floor((log.args.net * BigInt(pct)) / 100n);
  if (amount === 0n) return;

  // Gas reserve. The creator's wallet must always keep enough USDC to afford
  // revokeRule -- gas is USDC on Arc, so a wallet swept to zero cannot turn the
  // rule off. Sweep min(desired, balance - reserve); skip if under the reserve.
  // TESTNET VALUE: 0.1 USDC. Revisit for mainnet, where gas can spike.
  // Keeper-side by design: the contract is immutable and must not read balances.
  // This protects the HONEST keeper and against bugs; a malicious keeper is bounded
  // instead by the per-execution caps and the per-user daily limit.
  const RESERVE_6 = 100000n; // 0.1 USDC in 6dp
  const bal6 = to6Floor(await pub.getBalance({ address: entry.rule.user }));
  if (bal6 <= RESERVE_6) {
    console.warn(`SKIP  ${creator} balance=${bal6} at/under reserve=${RESERVE_6}`);
    return;
  }
  const spendable = bal6 - RESERVE_6;
  if (amount > spendable) {
    console.log(`clamp ${creator} ${amount} -> ${spendable} (gas reserve)`);
    amount = spendable;
  }

  const cap = BigInt(entry.rule.maxPerExecution);
  if (amount > cap) {
    console.warn(`SKIP  ${creator} amount=${amount} exceeds maxPerExecution=${cap}`);
    return;
  }

  const key = idemKey(entry.ruleHash, log.transactionHash, log.logIndex);

  const already = await pub.readContract({
    address: EXECUTOR, abi: ABI, functionName: 'consumed', args: [key] });
  if (already) { console.log(`skip  ${key.slice(0,10)} consumed`); return; }

  // Simulation is a filter, not a guarantee: state can change before inclusion.
  // The contract checks are the guarantee. This catches config errors cheaply.
  let request;
  try {
    ({ request } = await pub.simulateContract({
      address: EXECUTOR, abi: ABI, functionName: 'execute',
      args: [ruleTuple(entry.rule), amount, key], account }));
  } catch (err) {
    const name = err.cause?.data?.errorName || err.cause?.cause?.data?.errorName;
    console.error(`SIM FAIL ${creator} amount=${amount}:`,
                  name ? `${name}()` : (err.shortMessage || err.message));
    if (!name && err.metaMessages) console.error(err.metaMessages.join('\n'));
    return;
  }

  const hash = await wallet.writeContract(request);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  console.log(`exec  ${creator} ${amount} status=${rcpt.status} gas=${rcpt.gasUsed}`);
  console.log(`      ${hash}`);

  // Only notify on success. Never let mail failure affect the keeper loop.
  if (rcpt.status === 'success') {
    // The pinned vault address, read from the Executed event the executor emitted.
    // NOT entry.rule.subjectId, which is the bound id, not an address.
    let destination = null;
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== EXECUTOR.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: [EXECUTED], data: log.data, topics: log.topics });
        if (ev.eventName === 'Executed') { destination = ev.args.destination; break; }
      } catch { /* not an event we decode; skip */ }
    }
    await notifyAutoSave({
      to: entry.email || process.env.MAIL_TEST_TO,
      amount6: amount, txHash: hash,
      vault: destination, savePct: entry.savePct,
    });
  }
}

async function poll() {
  const paused = await pub.readContract({
    address: EXECUTOR, abi: ABI, functionName: 'paused' });
  if (paused) { console.log('executor paused, standing down'); return; }

  const state = loadState();
  const head = await pub.getBlockNumber();
  // Arc has deterministic instant finality and no reorgs: no confirmation lag needed.
  const from = state.lastBlock ? BigInt(state.lastBlock) + 1n : head - 20n;
  if (from > head) return;

  // Arc's public RPC rate-limits eth_getLogs. Chunked; dedicated provider before mainnet.
  // Arc's public RPC rejects wide eth_getLogs ranges outright. Tiplyfi's indexer
  // hit the same wall. A dedicated provider is required before mainnet.
  const CHUNK = 50n;
  for (let start = from; start <= head; start += CHUNK) {
    const end = (start + CHUNK - 1n) > head ? head : (start + CHUNK - 1n);
    const logs = await pub.getLogs({
      address: TIP_ROUTER, event: TIPPED, fromBlock: start, toBlock: end });
    for (const log of logs) await handleTip(log);
    saveState({ lastBlock: Number(end) });
  }
}

async function main() {
  console.log(`keeper up as ${account.address}`);
  console.log(`executor ${EXECUTOR}`);
  console.log(`watching ${TIP_ROUTER} for Tipped`);
  for (;;) {
    try { await poll(); }
    catch (e) { console.error('poll error:', e.shortMessage || e.message); }
    await new Promise((r) => setTimeout(r, 12000));
  }
}
main();
