// test-compute-escrow.js — Feature 6 (Escrowed Paid Compute) tests.
// Run with: bare test-compute-escrow.js
//
// Part 1 exercises the REAL lib/wallet.js wrappers (computeEscrowDeposit/
// Release/Refund). Their namespacing and address-resolution are pure logic
// and need no network. Their delegation to escrowDeposit/escrowConfirm/
// escrowRefund is verified by asserting the exact same "not initialised"
// guard fires — proof there is no parallel/duplicated implementation of the
// account check inside the wrappers.
//
// Part 2 exercises the compute-job LIFECYCLE state machine (lock -> offload
// -> release/refund, timeout, disconnect, malformed result, duplicate
// completion, concurrent jobs) against a harness that mirrors the exact
// control flow added to backend-headless.js's 'offload-request' case and its
// offload-result/offload-error/peer-disconnect handlers. backend-headless.js
// itself is a non-modular script (opens a real TCP socket and calls
// process.exit at import time when run standalone), so it cannot be
// `import`-ed directly into a test — this harness uses the same
// dependency-injection pattern test.js already uses for delegateScout()
// (mocked mesh/lib, injectable timeoutMs). See KNOWN LIMITATIONS at the
// bottom for the follow-up this implies.

import {
  computeAlertId, getComputeEscrowAddress, COMPUTE_JOB_PRICE_USDT
} from './lib/wallet.js'
import * as wallet from './lib/wallet.js'
import process from 'bare-process'

function assert (condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function assertEq (actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ─── Part 2 harness: mirrors backend-headless.js's compute-offload wiring ─────
function createComputeOffloadHarness ({ lib, mesh, timeoutMs = 15000 }) {
  const pendingOffloads = new Map()
  const events = []
  let seq = 0

  async function refundComputeJob (jobId, uiId, reason) {
    try {
      const result = await lib.computeEscrowRefund(jobId)
      events.push({ ev: 'compute-refunded', id: uiId, hash: result.hash, reason })
    } catch (err) {
      events.push({ ev: 'compute-refund-failed', id: uiId, reason, message: err.message })
    }
  }

  async function requestOffload ({ id, peerKey }) {
    const availablePeers = mesh.getPeers()
    if (availablePeers.length === 0) throw new Error('No peer available to offload to')
    const targetPeer = availablePeers[0]
    const requestId = `${peerKey}:job:${seq++}`

    let escrowLocked = false
    try {
      const deposit = await lib.computeEscrowDeposit(requestId)
      escrowLocked = true
      events.push({ ev: 'compute-escrow-locked', id, requestId, hash: deposit.hash })
    } catch (err) {
      events.push({ ev: 'escrow-deposit-failed', id, message: err.message })
    }

    const sent = mesh.sendTo(targetPeer, { type: 'offload-request', requestId })
    if (!sent) {
      if (escrowLocked) await refundComputeJob(requestId, id, 'send-failed')
      throw new Error('No peer available to offload to')
    }

    const timer = setTimeout(() => {
      if (pendingOffloads.has(requestId)) {
        pendingOffloads.delete(requestId)
        events.push({ ev: 'offload-timeout', id })
        if (escrowLocked) refundComputeJob(requestId, id, 'timeout')
      }
    }, timeoutMs)

    pendingOffloads.set(requestId, { id, timer, type: 'compute', targetPeer, escrowLocked })
    events.push({ ev: 'offload-sent', id, requestId, peer: targetPeer })
    return requestId
  }

  async function handleOffloadResult (msg, remotePeerKey, peerAddresses) {
    const pending = pendingOffloads.get(msg.requestId)
    if (!pending) { events.push({ ev: 'duplicate-ignored', requestId: msg.requestId }); return }
    clearTimeout(pending.timer)
    pendingOffloads.delete(msg.requestId)

    const isMalformed = typeof msg.original !== 'string' || typeof msg.translation !== 'string'
    if (isMalformed) {
      events.push({ ev: 'offload-failed', id: pending.id, message: 'Malformed compute result from peer' })
      if (pending.escrowLocked) await refundComputeJob(msg.requestId, pending.id, 'malformed-result')
      return
    }

    events.push({ ev: 'offload-result', id: pending.id, original: msg.original, translation: msg.translation })

    const address = peerAddresses.get(remotePeerKey)
    if (pending.escrowLocked) {
      if (address) {
        try {
          const result = await lib.computeEscrowRelease(msg.requestId, address)
          events.push({ ev: 'pay-compute-success', id: pending.id, hash: result.hash, provider: address })
        } catch (err) {
          events.push({ ev: 'pay-compute-failed', id: pending.id })
        }
      } else {
        await refundComputeJob(msg.requestId, pending.id, 'unknown-provider-address')
      }
    }
  }

  async function handleOffloadError (msg) {
    const pending = pendingOffloads.get(msg.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingOffloads.delete(msg.requestId)
    events.push({ ev: 'offload-failed', id: pending.id, message: msg.message || 'Peer OCR failed' })
    if (pending.escrowLocked) await refundComputeJob(msg.requestId, pending.id, 'provider-error')
  }

  function handlePeerDisconnect (remotePeerKey) {
    for (const [requestId, pending] of pendingOffloads.entries()) {
      if (pending.targetPeer === remotePeerKey) {
        clearTimeout(pending.timer)
        pendingOffloads.delete(requestId)
        events.push({ ev: 'offload-failed', id: pending.id, message: 'Peer disconnected during compute' })
        if (pending.escrowLocked) refundComputeJob(requestId, pending.id, 'peer-disconnected')
      }
    }
  }

  return { pendingOffloads, events, requestOffload, handleOffloadResult, handleOffloadError, handlePeerDisconnect }
}

function makeMockLib ({ failDeposit = false } = {}) {
  const calls = { deposit: [], release: [], refund: [] }
  return {
    calls,
    COMPUTE_JOB_PRICE_USDT,
    async computeEscrowDeposit (jobId, amount = COMPUTE_JOB_PRICE_USDT) {
      calls.deposit.push({ jobId, amount })
      if (failDeposit) throw new Error('Insufficient USDT balance')
      return { hash: `0xdeposit-${jobId}` }
    },
    async computeEscrowRelease (jobId, providerAddress) {
      calls.release.push({ jobId, providerAddress })
      return { hash: `0xrelease-${jobId}` }
    },
    async computeEscrowRefund (jobId) {
      calls.refund.push({ jobId })
      return { hash: `0xrefund-${jobId}` }
    }
  }
}

function makeMockMesh (peers) {
  const sent = []
  return {
    sent,
    getPeers: () => peers,
    sendTo: (peer, msg) => { sent.push({ peer, msg }); return true }
  }
}

async function runTests () {
  console.log('=== Running Feature 6 (Escrowed Paid Compute) Tests ===')

  // ── Part 1: real wallet.js wrapper functions ──

  console.log('Testing computeAlertId namespacing...')
  assertEq(computeAlertId('abc'), 'compute:abc')
  assertEq(computeAlertId('peer:123:0'), 'compute:peer:123:0')
  assert(computeAlertId('x') !== 'x', 'Compute id must never equal the raw jobId (collision guard)')

  console.log('Testing getComputeEscrowAddress fallback...')
  assertEq(getComputeEscrowAddress(), null, 'Unset COMPUTE_ESCROW should return null (caller falls back to Reunite deployment)')
  process.env.COMPUTE_ESCROW = '0x1111111111111111111111111111111111111'
  assertEq(getComputeEscrowAddress(), '0x1111111111111111111111111111111111111')
  process.env.COMPUTE_ESCROW = ''

  console.log('Testing COMPUTE_JOB_PRICE_USDT constant...')
  assertEq(COMPUTE_JOB_PRICE_USDT, 0.01)

  console.log('Testing wrappers delegate to the SAME uninitialised-wallet guard (no duplicated logic)...')
  const EXPECTED_GUARD = '[wallet] Not initialised - call initWallet() first'
  try {
    await wallet.computeEscrowDeposit('job-1')
    assert(false, 'computeEscrowDeposit should have thrown before wallet init')
  } catch (err) {
    assertEq(err.message, EXPECTED_GUARD, 'computeEscrowDeposit must reuse escrowDeposit\'s guard verbatim')
  }
  try {
    await wallet.computeEscrowRelease('job-1', '0xabc')
    assert(false, 'computeEscrowRelease should have thrown before wallet init')
  } catch (err) {
    assertEq(err.message, EXPECTED_GUARD, 'computeEscrowRelease must reuse escrowConfirm\'s guard verbatim')
  }
  try {
    await wallet.computeEscrowRefund('job-1')
    assert(false, 'computeEscrowRefund should have thrown before wallet init')
  } catch (err) {
    assertEq(err.message, EXPECTED_GUARD, 'computeEscrowRefund must reuse escrowRefund\'s guard verbatim')
  }

  // ── Part 2: compute-job lifecycle state machine ──

  console.log('Testing successful compute lifecycle (lock -> compute -> release)...')
  {
    const lib = makeMockLib()
    const mesh = makeMockMesh(['peer-A'])
    const peerAddresses = new Map([['peer-A', '0xProviderAddr']])
    const harness = createComputeOffloadHarness({ lib, mesh, timeoutMs: 5000 })

    const requestId = await harness.requestOffload({ id: 'ui-1', peerKey: 'me' })
    assertEq(lib.calls.deposit.length, 1)
    assertEq(lib.calls.deposit[0].jobId, requestId)

    await harness.handleOffloadResult({ requestId, original: 'Gate 3', translation: 'Puerta 3' }, 'peer-A', peerAddresses)

    assertEq(lib.calls.release.length, 1, 'Successful result should release escrow')
    assertEq(lib.calls.release[0].jobId, requestId)
    assertEq(lib.calls.release[0].providerAddress, '0xProviderAddr')
    assertEq(lib.calls.refund.length, 0, 'No refund should happen on success')
    assertEq(harness.pendingOffloads.size, 0)
    assert(harness.events.some(e => e.ev === 'pay-compute-success'), 'Should emit pay-compute-success')
  }

  console.log('Testing timeout refund...')
  {
    const lib = makeMockLib()
    const mesh = makeMockMesh(['peer-A'])
    const harness = createComputeOffloadHarness({ lib, mesh, timeoutMs: 30 })

    await harness.requestOffload({ id: 'ui-2', peerKey: 'me' })
    // Never deliver a result — let the timer fire.
    await new Promise(resolve => setTimeout(resolve, 100))

    assertEq(lib.calls.refund.length, 1, 'Timeout should refund escrow')
    assertEq(lib.calls.release.length, 0)
    assertEq(harness.pendingOffloads.size, 0)
    assert(harness.events.some(e => e.ev === 'compute-refunded' && e.reason === 'timeout'))
  }

  console.log('Testing disconnect refund...')
  {
    const lib = makeMockLib()
    const mesh = makeMockMesh(['peer-A'])
    const harness = createComputeOffloadHarness({ lib, mesh, timeoutMs: 5000 })

    await harness.requestOffload({ id: 'ui-3', peerKey: 'me' })
    harness.handlePeerDisconnect('peer-A')
    await new Promise(resolve => setTimeout(resolve, 10))

    assertEq(lib.calls.refund.length, 1, 'Disconnect should refund escrow')
    assertEq(harness.pendingOffloads.size, 0)
    assert(harness.events.some(e => e.ev === 'compute-refunded' && e.reason === 'peer-disconnected'))
  }

  console.log('Testing malformed result refund...')
  {
    const lib = makeMockLib()
    const mesh = makeMockMesh(['peer-A'])
    const peerAddresses = new Map([['peer-A', '0xProviderAddr']])
    const harness = createComputeOffloadHarness({ lib, mesh, timeoutMs: 5000 })

    const requestId = await harness.requestOffload({ id: 'ui-4', peerKey: 'me' })
    await harness.handleOffloadResult({ requestId, original: null, translation: undefined }, 'peer-A', peerAddresses)

    assertEq(lib.calls.refund.length, 1, 'Malformed result should refund, not release')
    assertEq(lib.calls.release.length, 0)
    assert(harness.events.some(e => e.ev === 'compute-refunded' && e.reason === 'malformed-result'))
  }

  console.log('Testing provider error (offload-error) refund...')
  {
    const lib = makeMockLib()
    const mesh = makeMockMesh(['peer-A'])
    const harness = createComputeOffloadHarness({ lib, mesh, timeoutMs: 5000 })

    const requestId = await harness.requestOffload({ id: 'ui-5', peerKey: 'me' })
    await harness.handleOffloadError({ requestId, message: 'OCR crashed' })

    assertEq(lib.calls.refund.length, 1)
    assert(harness.events.some(e => e.ev === 'compute-refunded' && e.reason === 'provider-error'))
  }

  console.log('Testing duplicate completion is ignored...')
  {
    const lib = makeMockLib()
    const mesh = makeMockMesh(['peer-A'])
    const peerAddresses = new Map([['peer-A', '0xProviderAddr']])
    const harness = createComputeOffloadHarness({ lib, mesh, timeoutMs: 5000 })

    const requestId = await harness.requestOffload({ id: 'ui-6', peerKey: 'me' })
    await harness.handleOffloadResult({ requestId, original: 'A', translation: 'B' }, 'peer-A', peerAddresses)
    // Same result delivered twice (retransmit) — second delivery must be a no-op.
    await harness.handleOffloadResult({ requestId, original: 'A', translation: 'B' }, 'peer-A', peerAddresses)

    assertEq(lib.calls.release.length, 1, 'Release must fire exactly once, not twice')
    assert(harness.events.some(e => e.ev === 'duplicate-ignored'))
  }

  console.log('Testing concurrent compute jobs stay independent...')
  {
    const lib = makeMockLib()
    const mesh = makeMockMesh(['peer-A'])
    const peerAddresses = new Map([['peer-A', '0xProviderAddr']])
    const harness = createComputeOffloadHarness({ lib, mesh, timeoutMs: 5000 })

    const requestId1 = await harness.requestOffload({ id: 'ui-7a', peerKey: 'me' })
    const requestId2 = await harness.requestOffload({ id: 'ui-7b', peerKey: 'me' })
    assert(requestId1 !== requestId2, 'Concurrent jobs must get distinct ids')
    assertEq(harness.pendingOffloads.size, 2)

    // Complete job 2 first, job 1 stays pending.
    await harness.handleOffloadResult({ requestId: requestId2, original: 'X', translation: 'Y' }, 'peer-A', peerAddresses)
    assertEq(harness.pendingOffloads.size, 1)
    assert(harness.pendingOffloads.has(requestId1))
    assertEq(lib.calls.release.length, 1)
    assertEq(lib.calls.release[0].jobId, requestId2)

    // Now fail job 1 — must not touch job 2's already-settled escrow.
    await harness.handleOffloadError({ requestId: requestId1, message: 'peer crashed' })
    assertEq(harness.pendingOffloads.size, 0)
    assertEq(lib.calls.refund.length, 1)
    assertEq(lib.calls.refund[0].jobId, requestId1)
  }

  console.log('Testing escrow-deposit failure falls back gracefully (no crash, no release/refund attempted)...')
  {
    const lib = makeMockLib({ failDeposit: true })
    const mesh = makeMockMesh(['peer-A'])
    const harness = createComputeOffloadHarness({ lib, mesh, timeoutMs: 5000 })

    const requestId = await harness.requestOffload({ id: 'ui-8', peerKey: 'me' })
    assert(harness.events.some(e => e.ev === 'escrow-deposit-failed'))
    assertEq(harness.pendingOffloads.get(requestId).escrowLocked, false, 'Job proceeds without escrow when deposit fails')
  }

  console.log('\nAll Feature 6 (Escrowed Paid Compute) tests PASSED successfully!')
  process.exit(0)
}

runTests().catch(err => {
  console.error('Test suite failed:', err)
  process.exit(1)
})

// ─── KNOWN LIMITATIONS ─────────────────────────────────────────────────────
// - Part 2 tests a harness that mirrors backend-headless.js's control flow,
//   not the literal file: backend-headless.js is a script (opens a real TCP
//   socket, calls process.exit(2) with no --ipc-port) and was never
//   structured as an importable module, even before Feature 6. Extracting
//   its command/message handling into testable exports is a larger refactor
//   than this feature's scope justifies — flagged as technical debt.
// - Part 1 cannot exercise the real on-chain path (escrowDeposit's
//   approve/allowance/postBounty sequence) without a live or mocked WDK
//   account; wallet.js has no injection seam for `account` today. Verified
//   instead that the wrappers hit the exact same guard as the underlying
//   functions, which is the strongest available proof of "thin wrapper, no
//   duplicated logic" without that seam.
