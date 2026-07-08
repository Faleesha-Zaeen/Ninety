// test-onchain-proof.js — Feature 10 (On-chain Proof Panel) tests.
// Run with: bare test-onchain-proof.js
//
// Covers explorer URL generation, transaction formatting, rolling-history
// trimming, and static Foundry metadata rendering — all pure/data-layer logic
// in lib/onchain.js. No mocking needed: none of this touches the chain.

import {
  getExplorerTxUrl, getExplorerAddressUrl, formatTxEntry, trimHistory,
  recordTx, getTxHistory, getNetworkInfo, getFoundryReport, TX_TYPES
} from './lib/onchain.js'
import process from 'bare-process'

function assert (condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function assertEq (actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function runTests () {
  console.log('=== Running Feature 10 (On-chain Proof Panel) Tests ===')

  // 1. Explorer URL generation — always derived from the hash, never hardcoded.
  console.log('Testing explorer URL generation...')
  const hash = '0x2a69ece84674c99491d30a806e8499c6979370459462f295ff2a133568d5ef6e'
  assertEq(getExplorerTxUrl(hash), `https://sepolia.etherscan.io/tx/${hash}`)
  assertEq(getExplorerTxUrl(null), null, 'No hash -> no URL')
  assertEq(getExplorerTxUrl(undefined), null)
  const addr = '0x798Ac160f1f9f58bEeB1676Aa6eb107682a42A87'
  assertEq(getExplorerAddressUrl(addr), `https://sepolia.etherscan.io/address/${addr}`)
  assertEq(getExplorerAddressUrl(''), null)

  // 2. Transaction formatting.
  console.log('Testing transaction formatting...')
  const full = formatTxEntry({ hash, type: 'Reunite Deposit', timestamp: 12345, status: 'confirmed' })
  assertEq(full.hash, hash)
  assertEq(full.type, 'Reunite Deposit')
  assertEq(full.timestamp, 12345)
  assertEq(full.status, 'confirmed')
  assertEq(full.explorerUrl, getExplorerTxUrl(hash))

  const partial = formatTxEntry({ hash: '0xabc' })
  assertEq(partial.type, 'Unknown', 'Missing type should default to Unknown')
  assertEq(partial.status, 'confirmed', 'Missing status should default to confirmed')
  assert(typeof partial.timestamp === 'number', 'Missing timestamp should default to now')

  const noHash = formatTxEntry({ type: 'Compute Deposit' })
  assertEq(noHash.explorerUrl, null, 'No hash -> no explorer URL even with other fields present')

  assert(TX_TYPES.includes('Reunite Deposit') && TX_TYPES.includes('Compute Refund'), 'TX_TYPES should cover all documented labels')
  assertEq(TX_TYPES.length, 6)

  // 3. History trimming (pure function).
  console.log('Testing history trimming...')
  const long = Array.from({ length: 30 }, (_, i) => ({ hash: `0x${i}`, type: 'x', timestamp: i, status: 'confirmed' }))
  const trimmed = trimHistory(long, 20)
  assertEq(trimmed.length, 20)
  assertEq(trimmed[0].hash, '0x0', 'Trimming should keep the front of the array (caller controls order)')
  assertEq(trimHistory(long).length, 20, 'Default limit should be 20')
  assertEq(trimHistory([{ hash: '0x1' }], 20).length, 1, 'Short arrays should pass through unchanged')

  // 4. recordTx + getTxHistory — rolling window, newest-first, no-hash is a no-op.
  console.log('Testing recordTx rolling history (last 20, newest first)...')
  assertEq(recordTx('Reunite Deposit', null), null, 'recordTx with no hash should be a no-op')
  for (let i = 0; i < 25; i++) {
    recordTx('Compute Deposit', `0xjob${i}`)
  }
  const history = getTxHistory()
  assertEq(history.length, 20, 'History must be capped at 20 entries')
  assertEq(history[0].hash, '0xjob24', 'Newest transaction should be first')
  assertEq(history[19].hash, '0xjob5', 'Oldest surviving transaction should be the 20th-from-newest')
  assert(!history.some(t => t.hash === '0xjob0'), 'Entries beyond the rolling window must be dropped')

  const entry = recordTx('Reunite Release', '0xrelease1', 'confirmed')
  assertEq(entry.type, 'Reunite Release')
  assertEq(entry.explorerUrl, getExplorerTxUrl('0xrelease1'))
  assertEq(getTxHistory()[0].hash, '0xrelease1', 'Most recently recorded tx should lead the history')

  // getTxHistory must return a copy, not a live reference, so callers can't mutate the store.
  const snapshot = getTxHistory()
  snapshot.push({ hash: 'tampered' })
  assert(!getTxHistory().some(t => t.hash === 'tampered'), 'getTxHistory() must return a defensive copy')

  // 5. Network info.
  console.log('Testing network info...')
  const net = getNetworkInfo()
  assertEq(net.chainId, 11155111)
  assertEq(net.name, 'Sepolia Testnet')

  // 6. Static Foundry metadata rendering — sourced from the real committed
  // contracts/foundry-report.json (generated from actual build/deploy artifacts,
  // not invented numbers).
  console.log('Testing Foundry metadata rendering...')
  const report = getFoundryReport()
  assertEq(report.testsPassing, '23/23')
  assertEq(report.gasOptimized, true)
  assertEq(report.deploymentSizeBytes, 5528)
  assertEq(report.deploymentGas, 1128415)
  assert(getFoundryReport() === report, 'getFoundryReport() should cache and return the same object on repeat calls')

  console.log('\nAll Feature 10 (On-chain Proof Panel) tests PASSED successfully!')
  process.exit(0)
}

runTests().catch(err => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
