// lib/wallet.js — WDK self-custodial wallet (Sepolia testnet USDt)
//
// Uses Tether's Wallet Development Kit (WDK) to create a self-custodial
// EVM wallet that holds USD₮ on Sepolia testnet. Keys are generated once
// and persisted locally — no server ever holds your funds.
//
// Sepolia USD₮ faucet: https://dashboard.pimlico.io/test-erc20-faucet

import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import fs from 'bare-fs'
import path from 'bare-path'
import { Interface, keccak256, toUtf8Bytes, MaxUint256 } from 'ethers' with { imports: 'bare-node-runtime/imports' }



// ─── Sepolia testnet config ──────────────────────────────────────────────────
const SEPOLIA_RPC = 'https://sepolia.drpc.org'
const SEPOLIA_CHAIN_ID = 11155111

// Sepolia testnet USD₮ contract (6 decimals, same as mainnet)
const USDT_CONTRACT = '0xd077A400968890Eacc75cdc901F0356c943e4fDb'
const USDT_DECIMALS = 6

// ─── State ───────────────────────────────────────────────────────────────────
let wdkInstance = null
let account = null
let walletAddress = null

// ─── Pending-payment queue ────────────────────────────────────────────────────
// A payment can be signed on-device but fail to reach the network (offline, or
// the RPC connection drops mid-send). Instead of silently failing we keep it here
// as "pending" and re-attempt the broadcast once connectivity returns. Simple
// in-memory array — no database, cleared on process exit (matches the demo scope).
const pendingPayments = []          // { id, to, amount, status, timestamp, hash|null }
let pendSeq = 0

// Manual offline switch — lets you force a pending state on purpose for testing.
// When true, sendUsdt() queues instead of broadcasting.
let offline = false

export function setOffline (v) {
  offline = !!v
  console.log(`[wallet] Offline mode ${offline ? 'ON — payments will queue' : 'OFF — will broadcast'}`)
  return offline
}
export function isOffline () { return offline }

/**
 * Return a shallow copy of the pending-payment queue (newest first).
 * @returns {Array<{id:string,to:string,amount:number,status:string,timestamp:number,hash:string|null}>}
 */
export function getPendingPayments () {
  return pendingPayments.slice().sort((a, b) => b.timestamp - a.timestamp)
}

// Heuristic: did this error come from lost connectivity (vs. a real failure like
// insufficient funds)? Those we queue; everything else still throws honestly.
function isConnectionError (err) {
  const m = ((err && err.message) || String(err)).toLowerCase()
  return /fetch failed|network|econn|enotfound|getaddrinfo|timeout|timed out|socket|offline|failed to fetch|could not connect|dns/.test(m)
}

// Queue a payment we could not broadcast. Returns the pending record.
function queuePending (to, amount) {
  const entry = {
    id: `pend:${Date.now()}:${++pendSeq}`,
    to,
    amount,
    status: 'pending',
    timestamp: Date.now(),
    hash: null
  }
  pendingPayments.push(entry)
  console.log(`[wallet] Payment queued (signed on-device, waiting to broadcast): ${amount} USDT → ${to.substring(0, 10)}...`)
  return { status: 'pending', id: entry.id, to, amount: `${amount} USDT` }
}

/**
 * Initialise the WDK wallet.
 * On first run: generates a new seed phrase and saves it locally.
 * On subsequent runs: loads the saved seed phrase.
 *
 * @param {string} dataDir — Directory to store seed phrase (e.g. ~/.ninety/)
 * @returns {Promise<string>} The wallet's EVM address
 */
export async function initWallet (dataDir) {
  const seedFile = path.join(dataDir, 'wallet-seed.txt')

  let seedPhrase

  // Try to load existing seed
  if (fs.existsSync(seedFile)) {
    seedPhrase = fs.readFileSync(seedFile, 'utf8').trim()
    console.log('[wallet] Loaded existing seed phrase from', seedFile)
  } else {
    // Generate new seed phrase (self-custodial — only you hold it)
    seedPhrase = WDK.getRandomSeedPhrase()
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(seedFile, seedPhrase, 'utf8')
    console.log('[wallet] Generated new seed phrase, saved to', seedFile)
  }

  // Register EVM wallet on Sepolia testnet
  wdkInstance = new WDK(seedPhrase)
    .registerWallet('ethereum', WalletManagerEvm, {
      provider: SEPOLIA_RPC,
      chainId: SEPOLIA_CHAIN_ID,
      transferMaxFee: 5000000000000000n, // 0.005 ETH max fee cap for ERC-20 transfers
      transactionMaxFee: 5000000000000000n
    })

  // Get the first account (index 0, BIP-44 path m/44'/60'/0'/0/0)
  account = await wdkInstance.getAccount('ethereum', 0)
  walletAddress = await account.getAddress()

  console.log('[wallet] Wallet ready on Sepolia testnet')
  console.log('[wallet] Address:', walletAddress)

  return walletAddress
}

/**
 * Get the current USD₮ balance on Sepolia.
 * @returns {Promise<{raw: bigint, formatted: string}>}
 */
export async function getBalance () {
  if (!account) throw new Error('[wallet] Not initialised - call initWallet() first')

  const raw = await account.getTokenBalance(USDT_CONTRACT)
  const formatted = formatUsdt(raw)
  return { raw, formatted }
}

/**
 * Get the native ETH balance (needed for gas on Sepolia).
 * @returns {Promise<{raw: bigint, formatted: string}>}
 */
export async function getEthBalance () {
  if (!account) throw new Error('[wallet] Not initialised - call initWallet() first')

  const raw = await account.getBalance()
  const eth = Number(raw) / 1e18
  return { raw, formatted: eth.toFixed(4) + ' ETH' }
}

/**
 * Send USD₮ to another address (peer-to-peer, no server).
 * @param {string} to — Recipient's EVM address
 * @param {number} amount — Amount in USDT (e.g. 5.50)
 * @returns {Promise<{hash: string, fee: bigint, amount: string}>}
 */
export async function sendUsdt (to, amount) {
  if (!account) throw new Error('[wallet] Not initialised - call initWallet() first')

  // Validate address up-front (cheap, no network) so a bad address always fails
  // loudly rather than sitting in the pending queue forever.
  if (!to.startsWith('0x') || to.length !== 42) {
    throw new Error(`Invalid recipient address: ${to}`)
  }

  // Forced offline (test switch): sign intent on-device, queue for later broadcast.
  if (offline) {
    return queuePending(to, amount)
  }

  try {
    return await broadcastTransfer(to, amount)
  } catch (err) {
    // Lost connectivity mid-send → queue instead of failing. Real errors re-throw.
    if (isConnectionError(err)) {
      console.log(`[wallet] Broadcast failed (connection): ${err.message} — queuing as pending`)
      return queuePending(to, amount)
    }
    throw err
  }
}

/**
 * The actual on-chain broadcast: the original WDK transfer path, unchanged.
 * Reused by both sendUsdt() (live) and flushPending() (retry) so there is a
 * single source of truth for the core payment logic.
 * @param {string} to
 * @param {number} amount
 * @returns {Promise<{status:'sent', hash:string, fee:bigint, amount:string}>}
 */
async function broadcastTransfer (to, amount) {
  // Convert USDT amount to base units (6 decimals)
  const baseAmount = BigInt(Math.round(amount * Math.pow(10, USDT_DECIMALS)))

  // Check balance
  const balance = await account.getTokenBalance(USDT_CONTRACT)
  if (balance < baseAmount) {
    throw new Error(`Insufficient USDT balance. Have: ${formatUsdt(balance)}, need: ${formatUsdt(baseAmount)}`)
  }

  // Check ETH for gas
  const ethBalance = await account.getBalance()
  if (ethBalance === 0n) {
    throw new Error('Need Sepolia ETH for gas. Visit https://sepoliafaucet.com')
  }

  console.log(`[wallet] Sending ${amount} USDT to ${to.substring(0, 10)}...`)

  // Execute the ERC-20 transfer
  const result = await account.transfer({
    token: USDT_CONTRACT,
    recipient: to,
    amount: baseAmount
  })

  console.log(`[wallet] Sent! Tx hash: ${result.hash}`)
  console.log(`[wallet] Gas fee: ${formatEth(result.fee)} ETH`)

  return {
    status: 'sent',
    hash: result.hash,
    fee: result.fee,
    amount: `${amount} USDT`
  }
}

/**
 * Attempt to broadcast every queued (pending) payment. Called when connectivity
 * returns. Each success flips the entry to "sent" and stamps its tx hash; each
 * still-failing one stays pending for the next attempt. Skipped entirely while
 * the offline switch is still on.
 * @returns {Promise<Array<{id:string,to:string,amount:number,status:string,hash:string|null,error?:string}>>}
 */
export async function flushPending () {
  if (offline) {
    console.log('[wallet] flushPending skipped — still offline')
    return []
  }
  const results = []
  for (const entry of pendingPayments) {
    if (entry.status !== 'pending') continue
    try {
      const r = await broadcastTransfer(entry.to, entry.amount)   // reuse core transfer
      entry.status = 'sent'
      entry.hash = r.hash
      results.push({ id: entry.id, to: entry.to, amount: entry.amount, status: 'sent', hash: r.hash, fee: String(r.fee) })
    } catch (err) {
      if (isConnectionError(err)) {
        results.push({ id: entry.id, to: entry.to, amount: entry.amount, status: 'pending', hash: null })
      } else {
        // Permanent failure (e.g. insufficient funds) — surface it, drop from queue.
        entry.status = 'failed'
        entry.error = err.message
        results.push({ id: entry.id, to: entry.to, amount: entry.amount, status: 'failed', hash: null, error: err.message })
      }
    }
  }
  // Drop entries that reached a terminal state so the queue only holds true pendings.
  for (let i = pendingPayments.length - 1; i >= 0; i--) {
    if (pendingPayments[i].status !== 'pending') pendingPayments.splice(i, 1)
  }
  return results
}

/**
 * Get the wallet's EVM address.
 * @returns {string}
 */
export function getAddress () {
  return walletAddress
}

export function getEscrowAddress () {
  return process.env.REUNITE_ESCROW || '0x798Ac160f1f9f58bEeB1676Aa6eb107682a42A87'
}

// Feature 6: optional dedicated ReuniteEscrow deployment for compute jobs, with
// a short REFUND_TIMEOUT (REFUND_TIMEOUT is immutable per-deployment, not
// per-alert — see contracts/script/DeployComputeEscrow.s.sol). When unset,
// compute jobs fall back to the Reunite deployment (getEscrowAddress()) below —
// safe because compute alert ids are namespaced (see computeAlertId), just with
// Reunite's longer 24h refund window instead of a fast one.
export function getComputeEscrowAddress () {
  return process.env.COMPUTE_ESCROW || null
}

export async function waitForReceipt (hash) {
  while (true) {
    const receipt = await account.getTransactionReceipt(hash)
    if (receipt) return receipt
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

async function sendTxWithBuffer (tx) {
  if (!tx.gasLimit) {
    try {
      const from = walletAddress
      const estimatedGas = await account._provider.estimateGas({
        from,
        ...tx
      })
      // Add 20% gas buffer
      tx.gasLimit = (estimatedGas * 120n) / 100n
      console.log(`[wallet] Estimated gas: ${estimatedGas.toString()}, using gasLimit with buffer: ${tx.gasLimit.toString()}`)
    } catch (err) {
      console.warn(`[wallet] Gas estimation failed, proceeding with default gas: ${err.message}`)
    }
  } else {
    console.log(`[wallet] Using pre-set gasLimit: ${tx.gasLimit.toString()}`)
  }
  return await account.sendTransaction(tx)
}

export async function escrowDeposit (alertId, amount, escrowAddressOverride) {
  if (!account) throw new Error('[wallet] Not initialised - call initWallet() first')

  const escrowAddress = escrowAddressOverride || getEscrowAddress()
  if (!escrowAddress) {
    throw new Error('REUNITE_ESCROW address not configured')
  }

  // Convert USDT amount to base units (6 decimals)
  const baseAmount = BigInt(Math.round(amount * Math.pow(10, USDT_DECIMALS)))

  // Check balance
  const balance = await account.getTokenBalance(USDT_CONTRACT)
  if (balance < baseAmount) {
    throw new Error(`Insufficient USDT balance. Have: ${formatUsdt(balance)}, need: ${formatUsdt(baseAmount)}`)
  }

  // Check ETH for gas
  const ethBalance = await account.getBalance()
  if (ethBalance === 0n) {
    throw new Error('Need Sepolia ETH for gas')
  }

  const allowance = await account.getAllowance(USDT_CONTRACT, escrowAddress)
  if (allowance < baseAmount) {
    console.log(`[wallet] Approving escrow ${escrowAddress} for max allowance...`)
    // Approve escrow contract to spend USDt
    const approveTx = await account.approve({
      token: USDT_CONTRACT,
      spender: escrowAddress,
      amount: MaxUint256
    })
    console.log(`[wallet] Approved! Tx: ${approveTx.hash}. Waiting for confirmation...`)
    await waitForReceipt(approveTx.hash)
    
    console.log(`[wallet] Waiting for allowance state to update...`)
    while (true) {
      const currentAllowance = await account.getAllowance(USDT_CONTRACT, escrowAddress)
      if (currentAllowance >= baseAmount) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    // Brief delay for load balancer consistency
    await new Promise(resolve => setTimeout(resolve, 2000))
    console.log(`[wallet] Approval confirmed!`)
  } else {
    console.log(`[wallet] Existing allowance of ${formatUsdt(allowance)} USDT is sufficient. Skipping approve.`)
  }

  console.log(`[wallet] Depositing ${amount} USDT into escrow...`)
  const hashedId = keccak256(toUtf8Bytes(alertId))
  const escrowInterface = new Interface([
    'function postBounty(bytes32 alertId, uint256 amount)'
  ])
  const tx = {
    to: escrowAddress,
    value: 0,
    data: escrowInterface.encodeFunctionData('postBounty', [hashedId, baseAmount]),
    gasLimit: 250000n
  }

  const result = await sendTxWithBuffer(tx)
  console.log(`[wallet] Deposit Tx broadcasted! Hash: ${result.hash}`)

  return {
    status: 'sent',
    hash: result.hash,
    fee: result.fee,
    amount: `${amount} USDT`
  }
}

export async function escrowConfirm (alertId, finder, escrowAddressOverride) {
  if (!account) throw new Error('[wallet] Not initialised - call initWallet() first')

  const escrowAddress = escrowAddressOverride || getEscrowAddress()
  if (!escrowAddress) {
    throw new Error('REUNITE_ESCROW address not configured')
  }

  const hashedId = keccak256(toUtf8Bytes(alertId))
  const escrowInterface = new Interface([
    'function confirmFinder(bytes32 alertId, address finder)'
  ])
  const tx = {
    to: escrowAddress,
    value: 0,
    data: escrowInterface.encodeFunctionData('confirmFinder', [hashedId, finder]),
    gasLimit: 250000n
  }

  console.log(`[wallet] Confirming finder ${finder} for alert ${alertId}...`)
  const result = await sendTxWithBuffer(tx)
  console.log(`[wallet] Confirm Tx broadcasted! Hash: ${result.hash}`)

  return {
    status: 'sent',
    hash: result.hash,
    fee: result.fee
  }
}

export async function escrowRefund (alertId, escrowAddressOverride) {
  if (!account) throw new Error('[wallet] Not initialised - call initWallet() first')

  const escrowAddress = escrowAddressOverride || getEscrowAddress()
  if (!escrowAddress) {
    throw new Error('REUNITE_ESCROW address not configured')
  }

  const hashedId = keccak256(toUtf8Bytes(alertId))
  const escrowInterface = new Interface([
    'function reclaim(bytes32 alertId)'
  ])
  const tx = {
    to: escrowAddress,
    value: 0,
    data: escrowInterface.encodeFunctionData('reclaim', [hashedId]),
    gasLimit: 200000n
  }

  console.log(`[wallet] Reclaiming bounty for alert ${alertId}...`)
  const result = await sendTxWithBuffer(tx)
  console.log(`[wallet] Reclaim Tx broadcasted! Hash: ${result.hash}`)

  return {
    status: 'sent',
    hash: result.hash,
    fee: result.fee
  }
}

// ─── Feature 6: Escrowed Paid Compute ─────────────────────────────────────────
// ReuniteEscrow is reused as-is (Option A) — its postBounty/confirmFinder/reclaim
// state machine is already generic over any bytes32 id. These are thin wrappers
// that namespace compute job ids under a "compute:" prefix before delegating to
// the existing escrowDeposit/escrowConfirm/escrowRefund functions, which already
// hash their string id with keccak256(toUtf8Bytes(id)) before hitting the
// contract. The prefix guarantees a compute job id can never collide with a raw
// Reunite alertId in the shared _alerts mapping, without touching escrow logic
// or the contract itself.
export const COMPUTE_JOB_PRICE_USDT = 0.01

export function computeAlertId (jobId) {
  return `compute:${jobId}`
}

/**
 * Lock payment for a compute job before delegating it to a peer.
 * @param {string} jobId — unique id for this compute request (e.g. offload requestId)
 * @param {number} [amount] — price in USDT, defaults to COMPUTE_JOB_PRICE_USDT
 */
export async function computeEscrowDeposit (jobId, amount = COMPUTE_JOB_PRICE_USDT) {
  return escrowDeposit(computeAlertId(jobId), amount, getComputeEscrowAddress())
}

/**
 * Release locked payment to the provider after a successful compute result.
 * @param {string} jobId
 * @param {string} providerAddress
 */
export async function computeEscrowRelease (jobId, providerAddress) {
  return escrowConfirm(computeAlertId(jobId), providerAddress, getComputeEscrowAddress())
}

/**
 * Refund the requester's locked payment (timeout, disconnect, provider
 * failure, or a malformed result).
 * @param {string} jobId
 */
export async function computeEscrowRefund (jobId) {
  return escrowRefund(computeAlertId(jobId), getComputeEscrowAddress())
}

/**
 * Format a raw USDT amount (6 decimals) to human-readable.
 */
function formatUsdt (raw) {
  return (Number(raw) / Math.pow(10, USDT_DECIMALS)).toFixed(2)
}

/**
 * Format a raw wei amount (18 decimals) to human-readable ETH.
 * Gas fees are native ETH — divide by 10^18, NOT the 10^6 used for USDT.
 */
function formatEth (raw) {
  return (Number(raw) / 1e18).toFixed(6)
}

/**
 * Cleanup: dispose WDK and clear keys from memory.
 */
export function shutdownWallet () {
  if (wdkInstance) {
    wdkInstance.dispose()
    wdkInstance = null
    account = null
    walletAddress = null
  }
  console.log('[wallet] Wallet disposed.')
}
