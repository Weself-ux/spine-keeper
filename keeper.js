import 'dotenv/config';
import fs from 'fs';
import { createPublicClient, createWalletClient, http, defineChain,
         parseAbiItem, keccak256, encodePacked } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { to6Floor } from './decimals.js';

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

  // net is the creator's share after Tiplyfi's fee; save a percentage of that.
  // Floor is intended here: a percentage of a tip rarely lands on a whole 6dp unit,
  // and sub-cent dust simply stays in the creator's wallet for the next sweep.
  const amount = to6Floor((log.args.net * BigInt(entry.savePct)) / 100n);
  if (amount === 0n) return;

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
}

async function poll() {
  const paused = await pub.readContract({
    address: EXECUTOR, abi: ABI, functionName: 'paused' });
  if (paused) { console.log('executor paused, standing down'); return; }

  const state = loadState();
  const head = await pub.getBlockNumber();
  // Arc has deterministic instant finality and no reorgs: no confirmation lag needed.
  const from = state.lastBlock ? BigInt(state.lastBlock) + 1n : head - 100n;
  if (from > head) return;

  // Arc's public RPC rate-limits eth_getLogs. Chunked; dedicated provider before mainnet.
  const CHUNK = 500n;
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
