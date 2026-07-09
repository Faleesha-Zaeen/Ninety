// backend-headless.js — Ninety backend as a headless JSON service (Bare runtime).
//
// NOT a rewrite of the backend: it imports and calls the EXACT same functions
// used by index.js (lib/qvac.js, lib/mesh.js, lib/tips.js, lib/wallet.js) and
// exposes them to the Electron UI over a localhost TCP socket.
//
// Why TCP and not stdin/stdout: on Windows, Bare cannot wrap the named pipes
// that Node/Electron create for a child's std streams (it faults). Bare's own
// networking, on the other hand, is rock-solid (it's what the mesh uses). So
// Electron opens a loopback TCP server, passes us its port, and we connect.
// This process never touches process.stdin/stdout/stderr.
//
// Protocol (line-delimited JSON, both directions over the socket):
//   ← command:  {"id":1,"cmd":"read","path":"C:\\abs\\sign.jpg"}
//   → event:    {"ev":"ocr","id":1,"text":"…"}
//
// Usage (spawned by Electron main):
//   bare backend-headless.js --ipc-port <port> --wallet-dir peer1-wallet [<TOPIC_HEX>]

import process from 'bare-process'

process.on("uncaughtException", err => {
  const msg = "UNCAUGHT EXCEPTION:\n" + (err && err.stack ? err.stack : String(err)) + "\n";
  process.stderr.write(msg);
});

process.on("unhandledRejection", err => {
  const msg = "UNHANDLED REJECTION:\n" + (err && err.stack ? err.stack : String(err)) + "\n";
  process.stderr.write(msg);
});

import path from 'bare-path'
import tcp from 'bare-tcp'
import fs from 'bare-fs'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

// ─── CLI args (superset of index.js: adds --ipc-port) ─────────────────────────
let walletDir = null
let topicFromCli = null
let ipcPort = null
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wallet-dir' && i + 1 < args.length) { walletDir = args[i + 1]; i++ }
  else if (args[i] === '--ipc-port' && i + 1 < args.length) { ipcPort = parseInt(args[i + 1], 10); i++ }
  else if (!args[i].startsWith('-')) { if (!topicFromCli) topicFromCli = args[i] }
}

// ─── IPC socket + event emitter ───────────────────────────────────────────────
let sock = null
const preConnectLog = []

function emit (obj) {
  const line = JSON.stringify(obj) + '\n'
  if (sock) { try { sock.write(line) } catch {} }
  else preConnectLog.push(line)
}

// Route all library logging to the socket as log frames (Electron ignores them
// for UI but can surface them for debugging). Never write to std streams.
function logline (...a) {
  const line = a.map(x => (typeof x === 'string' ? x : safe(x))).join(' ')
  emit({ ev: 'log', line })
}
console.log = logline; console.info = logline; console.warn = logline
console.error = logline; console.debug = logline
function safe (v) { try { return JSON.stringify(v) } catch { return String(v) } }

// ─── Process-level safety net (THE root-cause fix) ────────────────────────────
// The @qvac/sdk Whisper/audio pipeline throws asynchronously — detached from the
// await chain in the read-voice handler — when it decodes a malformed or silent
// WebM (e.g. the user holds the mic and releases without speaking). Because that
// error surfaces on a later microtask with no local catch, and because Bare, like
// Node, exits the process on an unhandled exception/rejection when no listener is
// registered, the ENTIRE backend died (exit code 1), taking every other feature
// (Sign Reader, Wallet, Mesh, Reunite, …) down with it — even though the command
// itself had already failed gracefully with "No speech detected".
//
// A single feature's stray async fault must never kill the whole backend. These
// handlers absorb it, surface it as a log frame for debugging, and keep the
// process alive. Socket lifecycle exits (below) are unaffected.
process.on('uncaughtException', (err) => {
  emit({ ev: 'log', line: `[safety-net] uncaughtException absorbed (backend kept alive): ${err && (err.stack || err.message) || err}` })
})
process.on('unhandledRejection', (reason) => {
  emit({ ev: 'log', line: `[safety-net] unhandledRejection absorbed (backend kept alive): ${reason && (reason.stack || reason.message) || reason}` })
})

// ─── State (populated after connect + dynamic import) ─────────────────────────
let mesh = null
let peerKey = null
let myAddress = null
const peerAddresses = new Map()
let lib = null // { qvac, mesh, tips, wallet } function bag

// Mesh Offload: requestId -> { id, timer } for offload-request calls awaiting
// an offload-result/offload-error from the peer we delegated to. Feature 6
// (Escrowed Paid Compute) reuses this same map for compute jobs — entries get
// `type: 'compute'`, `targetPeer`, and `escrowLocked` alongside the existing fields.
const pendingOffloads = new Map()
let offloadSeq = 0

// Feature 6: refund the requester's locked escrow for a compute job that did
// not complete successfully (timeout, disconnect, provider error, malformed
// result). Centralised so every failure path releases funds the same way.
// Feature 10 (On-chain Proof Panel): record an already-happened escrow tx and
// push it to the renderer immediately — event-driven, never polled. Called
// right after existing escrow calls resolve; does not perform or duplicate
// any transaction logic itself, only formats/stores the hash those calls
// already returned.
function recordAndEmitTx (type, hash, status = 'confirmed') {
  const entry = lib.recordTx(type, hash, status)
  if (entry) emit({ ev: 'tx-recorded', tx: entry })
  return entry
}

async function refundComputeJob (jobId, uiId, reason) {
  try {
    const result = await lib.computeEscrowRefund(jobId)
    recordAndEmitTx('Compute Refund', result.hash)
    emit({ ev: 'compute-refunded', id: uiId, hash: result.hash, reason })
  } catch (err) {
    emit({ ev: 'compute-refund-failed', id: uiId, reason, message: err && err.message ? err.message : String(err) })
  }
}

// Capability negotiation: peerKeyHex -> string[] (list of capability flags)
const peerCapabilities = new Map()

// Feature 9 (Scout Match Briefing): lightweight caches of already-emitted data
// so a briefing can be generated without asking the renderer to resend its own
// UI state. Purely additive — populated alongside existing Reunite/Sign Reader
// emits below, never changes any existing emitted event or return value.
const reuniteAlertCache = new Map() // alertId -> { name, detail, found }
let lastSignReading = null // { original, translation } | null

// Scout delegation debug logger
const DEBUG_SCOUT = true
function scoutLog (...args) {
  if (DEBUG_SCOUT) {
    console.log('[Scout]', ...args)
  }
}

function isValidScoutResult (msg) {
  return msg &&
    typeof msg.id === 'string' &&
    typeof msg.recommendation === 'string' &&
    (msg.confidence === 'low' || msg.confidence === 'medium' || msg.confidence === 'high') &&
    typeof msg.sourceCount === 'number' &&
    typeof msg.provider === 'string'
}

// ─── Connect to Electron, then boot ───────────────────────────────────────────
if (!ipcPort) {
  // No IPC channel — nothing we can do (and we must not touch stderr). Exit.
  process.exit(2)
}

sock = tcp.connect(ipcPort, '127.0.0.1', () => {
  // flush anything logged during early import
  for (const l of preConnectLog) { try { sock.write(l) } catch {} }
  preConnectLog.length = 0
  boot().catch(err => {
    const msg = "BOOT EXCEPTION:\n" + (err && err.stack ? err.stack : String(err)) + "\n";
    process.stderr.write(msg);
    emit({ ev: 'fatal', message: err && err.message ? err.message : String(err) })
  })
})

// incoming commands (line-buffered)
let inBuf = ''
sock.on('data', (chunk) => {
  inBuf += chunk.toString()
  let nl
  while ((nl = inBuf.indexOf('\n')) !== -1) {
    const line = inBuf.slice(0, nl).trim()
    inBuf = inBuf.slice(nl + 1)
    if (line) handleLine(line)
  }
})
sock.on('error', () => { try { process.exit(1) } catch {} })
sock.on('close', () => { try { process.exit(0) } catch {} })

// ─── Boot sequence (imports libs, runs the same init as index.js) ─────────────
async function boot () {
  // Dynamic import so the console override is already in place before any lib
  // module evaluates (and its top-level code runs) — keeps std streams untouched.
  const [qvac, meshMod, tips, wallet, scout, onchain] = await Promise.all([
    import('./lib/qvac.js'),
    import('./lib/mesh.js'),
    import('./lib/tips.js'),
    import('./lib/wallet.js'),
    import('./lib/scout.js'),
    import('./lib/onchain.js')
  ])
  lib = { ...qvac, ...tips, ...wallet, ...scout, ...onchain, createMesh: meshMod.createMesh }

  emit({ ev: 'status', stage: 'qvac', message: 'Loading offline AI models (OCR + translation)…' })
  await lib.initQvac()

  emit({ ev: 'status', stage: 'wallet', message: 'Opening wallet (Sepolia testnet)…' })
  const dataDir = walletDir || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.ninety')
  myAddress = await lib.initWallet(dataDir)

  emit({ ev: 'status', stage: 'mesh', message: 'Joining P2P mesh…' })
  mesh = lib.createMesh({
    onTipReceived: (tip) => {
      lib.mergeTips([tip])
      emit({ ev: 'tip-received', tip })
      lib.queueTip(tip, null, (updatedTip) => {
        emit({ ev: 'tip-tagged', tip: updatedTip })
      })
    },
    onMessage: (msg, remotePeerKey) => {
      if (msg.type === 'wallet-address' && msg.address) {
        peerAddresses.set(remotePeerKey, msg.address)
        if (msg.capabilities && msg.capabilities.includes('scout')) {
          peerCapabilities.set(remotePeerKey, ['scout'])
        }
        emit({ ev: 'peer-wallet', peer: remotePeerKey, address: msg.address })
      }
      if (msg.type === 'payment-received' && msg.amount) {
        emit({ ev: 'payment-received', amount: msg.amount, from: msg.from, hash: msg.hash })
      }
      // Snapshot Sync: peer asking for our recent tip history
      if (msg.type === 'history-request') {
        const last50OldestFirst = lib.getAllTips().slice(0, 50).reverse()
        console.log(`[debug] Received history-request, sending back ${last50OldestFirst.length} tips`)
        mesh.sendTo(remotePeerKey, { type: 'history-response', tips: last50OldestFirst })
      }
      // Snapshot Sync: received recent tip history from a peer
      if (msg.type === 'history-response' && Array.isArray(msg.tips)) {
        console.log(`[debug] Received history-response with ${msg.tips.length} tips`)
        console.log(`[debug] Calling lib.mergeTips with:`, msg.tips)
        const existingIds = new Set(lib.getAllTips().map(t => t.id))
        lib.mergeTips(msg.tips)
        for (const tip of msg.tips) {
          if (!existingIds.has(tip.id)) {
            emit({ ev: 'tip-received', tip })
            lib.queueTip(tip, null, (updatedTip) => {
              emit({ ev: 'tip-tagged', tip: updatedTip })
            })
          }
        }
      }
      // Reunite: a missing-person alert arrived from a peer
      if (msg.type === 'missing-report' && msg.report) {
        emit({ ev: 'missing-alert', report: msg.report })
        reuniteAlertCache.set(msg.report.id, { name: msg.report.name, detail: msg.report.detail, found: false })
      }
      if (msg.type === 'reunite' && msg.report) {
        const report = {
          ...msg.report,
          escrowTx: msg.escrowTx,
          contract: msg.contract,
          bounty: msg.amount,
          id: msg.alertId
        }
        emit({ ev: 'missing-alert', report })
        reuniteAlertCache.set(report.id, { name: report.name, detail: report.detail, found: false })
      }
      // Reunite: a photo chunk arrived from a peer
      if (msg.type === 'missing-photo-chunk' && msg.reportId) {
        emit({
          ev: 'missing-photo-chunk',
          reportId: msg.reportId,
          chunkIndex: msg.chunkIndex,
          totalChunks: msg.totalChunks,
          chunkData: msg.chunkData
        })
      }
      // Reunite: a peer says they found the child in one of our reports
      if (msg.type === 'found-person' && msg.reportId) {
        emit({ ev: 'found-notice', reportId: msg.reportId, finderKey: remotePeerKey, finderAddress: msg.finderAddress })
        const cached = reuniteAlertCache.get(msg.reportId)
        if (cached) cached.found = true
      }
      // Section Translator Relay: a peer broadcast a translated sign to the section
      if (msg.type === 'section-sign' && msg.sign) {
        emit({ ev: 'section-sign', sign: msg.sign, from: remotePeerKey })
      }
      // Mesh Offload: a peer asked us to run QVAC OCR+translate on their behalf.
      // Reuses the exact same lib.readSign/lib.translateText the Sign Reader uses.
      if (msg.type === 'offload-request' && msg.requestId && msg.imageBase64) {
        (async () => {
          try {
            const imgBuf = b4a.from(msg.imageBase64, 'base64')
            const ocr = await lib.readSign(imgBuf)
            const translation = await lib.translateText(ocr.text)
            mesh.sendTo(remotePeerKey, { type: 'offload-result', requestId: msg.requestId, original: ocr.text, translation })
          } catch (err) {
            mesh.sendTo(remotePeerKey, { type: 'offload-error', requestId: msg.requestId, message: err && err.message ? err.message : String(err) })
          }
        })()
      }
      // Mesh Offload: the peer we delegated to sent back an OCR+translate result.
      if (msg.type === 'offload-result' && msg.requestId) {
        const pending = pendingOffloads.get(msg.requestId)
        if (pending) {
          // Delete synchronously before any await so a duplicate offload-result
          // for the same requestId (e.g. a retransmit) finds no pending entry
          // and is silently ignored — the job can only complete once.
          clearTimeout(pending.timer)
          pendingOffloads.delete(msg.requestId)

          // Feature 6: a result missing either text field is treated as a failed
          // compute job (refund), not delivered to the UI as a real translation.
          const isMalformed = typeof msg.original !== 'string' || typeof msg.translation !== 'string'
          if (isMalformed) {
            emit({ ev: 'offload-failed', id: pending.id, message: 'Malformed compute result from peer' })
            if (pending.type === 'compute' && pending.escrowLocked) refundComputeJob(msg.requestId, pending.id, 'malformed-result')
            return
          }

          emit({ ev: 'offload-result', id: pending.id, original: msg.original || '', translation: msg.translation || '' })
          lastSignReading = { original: msg.original || '', translation: msg.translation || '' }
          const tips = lib.findTips(msg.original || '')
          emit({ ev: 'read-tips', id: pending.id, tips })
          emit({ ev: 'read-done', id: pending.id })

          const address = peerAddresses.get(remotePeerKey)
          if (pending.type === 'compute' && pending.escrowLocked) {
            // Feature 6: successful compute — release the locked escrow to the provider.
            if (address) {
              ;(async () => {
                try {
                  const result = await lib.computeEscrowRelease(msg.requestId, address)
                  recordAndEmitTx('Compute Release', result.hash)
                  emit({ ev: 'pay-compute-success', id: pending.id, hash: result.hash, provider: address })
                  mesh.broadcastRaw({ type: 'payment-received', amount: `${lib.COMPUTE_JOB_PRICE_USDT} USDt for compute`, from: lib.getAddress(), hash: result.hash })
                } catch (err) {
                  emit({ ev: 'pay-compute-failed', id: pending.id })
                }
              })()
            } else {
              // Never met the provider's wallet-address handshake — nothing to release to, refund instead.
              refundComputeJob(msg.requestId, pending.id, 'unknown-provider-address')
            }
          } else if (address) {
            // Escrow deposit wasn't available when this job was dispatched — old direct-pay behavior.
            ;(async () => {
              try {
                const result = await lib.sendUsdt(address, lib.COMPUTE_JOB_PRICE_USDT)
                emit({ ev: 'pay-compute-success', id: pending.id, hash: result.hash })
                if (result.status === 'sent') {
                  mesh.broadcastRaw({ type: 'payment-received', amount: `${lib.COMPUTE_JOB_PRICE_USDT} USDt for compute`, from: lib.getAddress(), hash: result.hash })
                }
              } catch (err) {
                emit({ ev: 'pay-compute-failed', id: pending.id })
              }
            })()
          }
        }
      }
      // Mesh Offload: the peer we delegated to failed (bad image, model error, etc).
      if (msg.type === 'offload-error' && msg.requestId) {
        const pending = pendingOffloads.get(msg.requestId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingOffloads.delete(msg.requestId)
          emit({ ev: 'offload-failed', id: pending.id, message: msg.message || 'Peer OCR failed' })
          if (pending.type === 'compute' && pending.escrowLocked) refundComputeJob(msg.requestId, pending.id, 'provider-error')
        }
      }
      // Scout Delegation: peer asking us to run Scout inference
      if (msg.type === 'scout-request' && msg.id && msg.ocrText !== undefined) {
        scoutLog('Received scout-request from peer')
        ;(async () => {
          try {
            const result = await lib.scoutAnalyze({
              ocrText: msg.ocrText,
              translatedText: msg.translatedText,
              nearbyTips: msg.nearbyTips,
              language: msg.language
            })
            mesh.sendTo(remotePeerKey, {
              type: 'scout-result',
              id: msg.id,
              ...result,
              provider: peerKey
            })
          } catch (err) {
            mesh.sendTo(remotePeerKey, {
              type: 'scout-result',
              id: msg.id,
              recommendation: 'Inference failed on peer.',
              confidence: 'low',
              sourceCount: 0,
              provider: peerKey
            })
          }
        })()
      }
      // Scout Delegation Response
      if (msg.type === 'scout-result' && msg.id) {
        const pending = pendingOffloads.get(msg.id)
        if (pending && pending.type === 'scout') {
          if (!isValidScoutResult(msg)) {
            scoutLog('Received malformed scout-result from peer')
            clearTimeout(pending.timer)
            pendingOffloads.delete(msg.id)
            pending.reject(new Error('Malformed response received'))
            return
          }
          pendingOffloads.delete(msg.id)
          clearTimeout(pending.timer)
          pending.resolve(msg)
        }
      }
    },
    onPeerConnected: (remotePeerKey) => {
      mesh.sendTo(remotePeerKey, { type: 'wallet-address', address: myAddress, capabilities: ['scout'] })
      console.log(`[debug] Sending history-request to peer ${remotePeerKey}`)
      mesh.sendTo(remotePeerKey, { type: 'history-request' })
      emit({ ev: 'peer-connected', peer: remotePeerKey })
      // A peer reconnecting is a natural "connection returned" signal — try to
      // drain any payments that were queued while offline.
      flushPendingAndAnnounce().then(() => {
        emit({ ev: 'pending-list', pending: lib.getPendingPayments() })
      }).catch(() => {})
    },
    onPeerDisconnected: (remotePeerKey) => {
      peerCapabilities.delete(remotePeerKey)
      peerAddresses.delete(remotePeerKey)
      emit({ ev: 'peer-disconnected', peer: remotePeerKey })
      for (const [requestId, pending] of pendingOffloads.entries()) {
        if (pending.type === 'scout' && pending.targetPeer === remotePeerKey) {
          scoutLog('Peer disconnected during request. Rejecting pending delegation.')
          clearTimeout(pending.timer)
          pendingOffloads.delete(requestId)
          pending.reject(new Error('Peer disconnected during request'))
        }
        // Feature 6: provider vanished mid-job — refund the requester's locked escrow.
        if (pending.type === 'compute' && pending.targetPeer === remotePeerKey) {
          clearTimeout(pending.timer)
          pendingOffloads.delete(requestId)
          emit({ ev: 'offload-failed', id: pending.id, message: 'Peer disconnected during compute' })
          if (pending.escrowLocked) refundComputeJob(requestId, pending.id, 'peer-disconnected')
        }
      }
    },
    topicHex: topicFromCli
  })
  peerKey = mesh.topicHex

  emit({ ev: 'ready', address: myAddress, topic: mesh.topicHex, peers: mesh.getPeers() })
}

// Broadcast every queued payment (if any), emit results, and gossip a
// payment-received to peers for each one that actually settled. Shared by the
// explicit flush command, the offline-OFF toggle, and peer reconnection.
async function flushPendingAndAnnounce (id) {
  if (!lib || lib.isOffline()) return
  if (lib.getPendingPayments().length === 0) return
  const results = await lib.flushPending()   // reuses the WDK transfer core
  emit({ ev: 'pending-flushed', id, results })
  for (const r of results) {
    if (r.status === 'sent') {
      mesh.broadcastRaw({ type: 'payment-received', amount: `${r.amount} USDT`, from: lib.getAddress(), hash: r.hash })
    }
  }
}

// ─── Command dispatch ─────────────────────────────────────────────────────────
async function handleLine (line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, cmd } = msg
  if (!lib && cmd !== undefined) { emit({ ev: 'error', id, cmd, message: 'Backend still starting' }); return }
  try {
    switch (cmd) {
      case 'read': {
        if (!msg.path) throw new Error('read requires an image path')
        emit({ ev: 'read-start', id })
        const ocr = await lib.readSign(msg.path)
        emit({ ev: 'ocr', id, text: ocr.text, blocks: ocr.blocks })
        const translation = await lib.translateText(ocr.text)
        emit({ ev: 'translation', id, text: translation })
        lastSignReading = { original: ocr.text, translation }
        const tips = lib.findTips(ocr.text)
        emit({ ev: 'read-tips', id, tips })
        emit({ ev: 'read-done', id })
        break
      }
      case 'read-voice': {
        const recNum = msg.recNum || '?'
        try {
          console.log(`========== BACKEND RECORDING #${recNum} ==========`)
          console.log(`[debug] Recording #${recNum}: read-voice received. audioBase64.length=${msg.audioBase64 ? msg.audioBase64.length : 0}`)
          if (!msg.audioBase64) {
            console.log(`[debug] Recording #${recNum}: ERROR — no audioBase64 in message`)
            throw new Error('read-voice requires audio data')
          }
          // Prevent hitting the QVAC SDK's async unhandled rejection bug (which crashes the 
          // entire process with "Invalid input" when fed an empty or abnormally tiny WebM container).
          // A 0-second WebM from the browser is ~200-300 bytes. A 1-second clip is ~8-10KB+.
          if (msg.audioBase64.length < 1000) {
            console.log(`[debug] Recording #${recNum}: audio payload too small (${msg.audioBase64.length} chars < 1000), treating as no speech`)
            throw new Error('No speech detected')
          }
          emit({ ev: 'read-start', id })
          console.log(`[debug] Recording #${recNum}: Starting transcribeAudio. Payload size: ${msg.audioBase64.length} chars`)
          
          let timeoutTimer
          const timeout = new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => reject(new Error('Transcription timed out, try again')), 15000)
          })
          
          // Prevent unhandled promise rejection if transcribeAudio wins the race
          // but the timeout hasn't fired yet.
          timeout.catch(() => {})

          let transcribedText
          try {
            console.log(`[debug] Recording #${recNum}: Calling lib.transcribeAudio()`)
            transcribedText = await Promise.race([
              lib.transcribeAudio(msg.audioBase64, recNum),
              timeout
            ])
            console.log(`[debug] Recording #${recNum}: transcribeAudio returned: ${JSON.stringify(transcribedText)}`)
          } finally {
            clearTimeout(timeoutTimer)
          }
          
          if (!transcribedText || transcribedText.trim().length === 0) {
            console.log(`[debug] Recording #${recNum}: transcribeAudio returned empty/falsy after whisper processing`)
            throw new Error('No speech detected')
          }
          console.log(`[debug] Recording #${recNum}: TRANSCRIPTION SUCCESS — "${transcribedText.substring(0, 80)}"`)
          emit({ ev: 'ocr', id, text: transcribedText, blocks: [] })
          const translation = await lib.translateText(transcribedText)
          emit({ ev: 'translation', id, text: translation })
          lastSignReading = { original: transcribedText, translation }
          const tips = lib.findTips(transcribedText)
          emit({ ev: 'read-tips', id, tips })
          emit({ ev: 'read-done', id })
        } catch (err) {
          console.error(`[debug] Recording #${recNum}: read-voice ERROR: ${err.message}`)
          console.error(`[debug] Recording #${recNum}: stack: ${err.stack}`)
          throw err // Re-throw so handleLine emits the error to the UI
        }
        break
      }
      case 'scout-analyze': {
        const { ocrText, translatedText, nearbyTips, language } = msg
        try {
          const availablePeers = mesh.getPeers().filter(p => {
            const caps = peerCapabilities.get(p)
            return caps && caps.includes('scout')
          })

          let result = null
          let fallbackOccurred = false

          if (availablePeers.length > 0) {
            const targetPeer = availablePeers[0]
            const requestId = b4a.toString(crypto.randomBytes(16), 'hex')
            scoutLog('Delegating to peer', targetPeer.substring(0, 12))

            const sent = mesh.sendTo(targetPeer, {
              type: 'scout-request',
              id: requestId,
              ocrText,
              translatedText,
              nearbyTips,
              language
            })

            if (sent) {
              const start = Date.now()
              let timer
              const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => {
                  scoutLog('Timeout')
                  reject(new Error('Delegation timed out'))
                }, 5000)
              })

              const responsePromise = new Promise((resolve, reject) => {
                pendingOffloads.set(requestId, {
                  type: 'scout',
                  id,
                  resolve,
                  reject,
                  timer,
                  targetPeer
                })
              })

              try {
                const response = await Promise.race([responsePromise, timeoutPromise])
                scoutLog('Peer responded in', Date.now() - start, 'ms')
                result = response
              } catch (err) {
                scoutLog('Delegation failed, falling back to local:', err.message)
                fallbackOccurred = true
              } finally {
                pendingOffloads.delete(requestId)
                clearTimeout(timer)
              }
            } else {
              fallbackOccurred = true
            }
          }

          if (!result) {
            const localResult = await lib.scoutAnalyze({ ocrText, translatedText, nearbyTips, language })
            result = {
              ...localResult,
              provider: fallbackOccurred ? 'Fallback: Local' : 'Local Device'
            }
          }

          emit({ ev: 'scout-result', id, ...result })
        } catch (err) {
          emit({ ev: 'error', id, cmd, message: err.message })
        }
        break
      }

      // ── Feature 9: Scout Match Briefing — reuses Scout/Qwen (lib.generateMatchBriefing,
      // same completion() pipeline as scout-analyze above) over data already tracked by
      // existing features: tagged tips (Feature 4, includes Match Pulse-as-tips),
      // Reunite alerts (reuniteAlertCache above), and the last sign reading (lastSignReading).
      case 'generate-match-briefing': {
        try {
          const tips = lib.getAllTips()
          const reuniteAlerts = Array.from(reuniteAlertCache.values()).filter(a => !a.found)
          const result = await lib.generateMatchBriefing({ tips, reuniteAlerts, lastRead: lastSignReading })
          emit({
            ev: 'match-briefing',
            id,
            briefing: result.briefing,
            sourceCount: result.sourceCount,
            generatedAt: Date.now()
          })
        } catch (err) {
          emit({ ev: 'error', id, cmd, message: err.message })
        }
        break
      }

      case 'translate':
        emit({ ev: 'translate-result', id, text: await lib.translateText(msg.text || '') }); break
      case 'lang':
        await lib.setTranslationLang(msg.from, msg.to)
        emit({ ev: 'lang-set', id, from: msg.from, to: msg.to }); break
      case 'tip': {
        const tip = lib.addTip(msg.label, msg.location, msg.message, peerKey)
        mesh.broadcast(tip)
        emit({ ev: 'tip-added', id, tip })
        lib.queueTip(tip, null, (updatedTip) => {
          emit({ ev: 'tip-tagged', tip: updatedTip })
        })
        break
      }
      case 'tips':
        emit({ ev: 'tips-list', id, tips: lib.getAllTips() }); break
      case 'balance': {
        const [usdt, eth] = await Promise.all([lib.getBalance(), lib.getEthBalance()])
        emit({ ev: 'balance', id, usdt: usdt.formatted, eth: eth.formatted }); break
      }
      case 'pay': {
        const amount = parseFloat(msg.amount)
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount')
        let recipient = msg.to
        if (!recipient) {
          const peers = mesh.getPeers()
          if (peers.length === 0) throw new Error('No peers connected')
          recipient = peerAddresses.get(peers[0])
        }
        if (!recipient) throw new Error('Peer wallet address not known yet')
        const result = await lib.sendUsdt(recipient, amount)
        if (result.status === 'pending') {
          // Signed on-device but no connection to broadcast — queued, not sent.
          emit({ ev: 'pay-pending', id, pendingId: result.id, amount, to: recipient })
          emit({ ev: 'pending-list', pending: lib.getPendingPayments() })
        } else {
          emit({ ev: 'pay-result', id, amount, to: recipient, hash: result.hash, fee: String(result.fee) })
          mesh.broadcastRaw({ type: 'payment-received', amount: `${amount} USDT`, from: lib.getAddress(), hash: result.hash })
        }
        break
      }
      case 'address':
        emit({ ev: 'address', id, address: lib.getAddress() }); break
      case 'peers':
        emit({ ev: 'peers-list', id, peers: mesh.getPeers().map(p => ({ peer: p, address: peerAddresses.get(p) || null })) }); break
      case 'topic':
        emit({ ev: 'topic', id, topic: mesh.topicHex }); break

      // ── Feature 10: On-chain Proof Panel — one-shot snapshot, no polling.
      // Renderer requests this once on panel mount; live updates after that
      // arrive via 'tx-recorded' events (see recordAndEmitTx above). Every
      // value here is read from data existing features already produce.
      case 'chain-info': {
        const reuniteAddress = lib.getEscrowAddress()
        const computeAddress = lib.getComputeEscrowAddress() || reuniteAddress
        emit({
          ev: 'chain-info',
          id,
          wallet: { address: lib.getAddress(), explorerUrl: lib.getExplorerAddressUrl(lib.getAddress()) },
          reuniteEscrow: { address: reuniteAddress, explorerUrl: lib.getExplorerAddressUrl(reuniteAddress) },
          computeEscrow: { address: computeAddress, explorerUrl: lib.getExplorerAddressUrl(computeAddress) },
          network: lib.getNetworkInfo(),
          history: lib.getTxHistory(),
          foundry: lib.getFoundryReport()
        })
        break
      }

      // ── Reunite: report a missing person (reuses QVAC OCR + translate + mesh) ──
      case 'report-missing': {
        let ocrText = ''
        if (msg.path) {
          try {
            const ocr = await lib.readSign(msg.path)
            ocrText = ocr.text || ''
          } catch (e) {
            console.log('[backend] OCR failed (continuing text-only):', e.message)
          }
        }
        let translatedDetail = ''
        try { translatedDetail = await lib.translateText(msg.detail || '') } catch {}  // reuse QVAC translate
        const report = {
          id: `${peerKey}:${Date.now()}`,
          name: msg.name || '',
          detail: msg.detail || '',
          translatedDetail,
          ocrText,
          bounty: msg.bounty,
          dataUrl: msg.dataUrl || null,        // small thumbnail from the UI
          reporterAddress: myAddress
        }
        // Attempt escrow deposit
        try {
          console.log(`[escrow] Attempting escrow deposit for alert ${report.id}...`)
          const depositResult = await lib.escrowDeposit(report.id, report.bounty)
          report.escrowTx = depositResult.hash
          report.contract = lib.getEscrowAddress()
          console.log(`[escrow] Deposit successful. Tx: ${report.escrowTx}, contract: ${report.contract}`)
          recordAndEmitTx('Reunite Deposit', depositResult.hash)
        } catch (err) {
          console.warn(`[escrow] Escrow deposit failed, falling back to direct payment:`, err.message)
        }

        if (report.escrowTx) {
          mesh.broadcastRaw({
            type: 'reunite',
            alertId: report.id,
            escrowTx: report.escrowTx,
            contract: report.contract,
            amount: report.bounty,
            report
          })
        } else {
          mesh.broadcastRaw({ type: 'missing-report', report })
        }
        reuniteAlertCache.set(report.id, { name: report.name, detail: report.detail, found: false })
        emit({ ev: 'missing-reported', id, report })
        break
      }

      // ── Reunite: broadcast a chunk of a compressed photo ──
      case 'broadcast-photo-chunk': {
        mesh.broadcastRaw({
          type: 'missing-photo-chunk',
          reportId: msg.reportId,
          chunkIndex: msg.chunkIndex,
          totalChunks: msg.totalChunks,
          chunkData: msg.chunkData
        })
        emit({ ev: 'photo-chunk-sent', id })
        break
      }

      // ── Reunite: tell the reporter we found the child ──
      case 'found-them': {
        if (!msg.reportId) throw new Error('found-them requires a reportId')
        mesh.broadcastRaw({ type: 'found-person', reportId: msg.reportId, finderAddress: myAddress })
        emit({ ev: 'found-ack', id, reportId: msg.reportId })
        break
      }

      // ── Reunite: reporter confirms and pays the bounty (reuses WDK pay) ──
      case 'pay-bounty': {
        const amount = parseFloat(msg.amount)
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid bounty amount')
        if (!msg.toAddress) throw new Error('No finder address to pay')
        
        if (msg.escrowTx) {
          console.log(`[escrow] Waiting for deposit transaction ${msg.escrowTx} to be confirmed...`)
          await lib.waitForReceipt(msg.escrowTx)
          console.log(`[escrow] Deposit confirmed! Proceeding with release...`)
          const result = await lib.escrowConfirm(msg.reportId, msg.toAddress)
          recordAndEmitTx('Reunite Release', result.hash)
          emit({ ev: 'bounty-paid', id, reportId: msg.reportId, amount, to: msg.toAddress, hash: result.hash })
          mesh.broadcastRaw({ type: 'payment-received', amount: `${amount} USDT (bounty)`, from: lib.getAddress(), hash: result.hash })
        } else {
          const result = await lib.sendUsdt(msg.toAddress, amount)       // reuse WDK transfer
          if (result.status === 'pending') {
            emit({ ev: 'pay-pending', id, pendingId: result.id, amount, to: msg.toAddress, reportId: msg.reportId })
            emit({ ev: 'pending-list', pending: lib.getPendingPayments() })
            break
          }
          emit({ ev: 'bounty-paid', id, reportId: msg.reportId, amount, to: msg.toAddress, hash: result.hash })
          mesh.broadcastRaw({ type: 'payment-received', amount: `${amount} USDT (bounty)`, from: lib.getAddress(), hash: result.hash })
        }
        break
      }
      // ── Pending payments: toggle offline, list queue, flush when connected ──
      case 'set-offline': {
        const value = lib.setOffline(!!msg.value)
        emit({ ev: 'offline-state', id, offline: value })
        // Turning offline OFF = "connection returned" → auto-broadcast the queue.
        if (!value) await flushPendingAndAnnounce(id)
        emit({ ev: 'pending-list', id, pending: lib.getPendingPayments() })
        break
      }
      case 'flush-pending': {
        await flushPendingAndAnnounce(id)
        emit({ ev: 'pending-list', id, pending: lib.getPendingPayments() })
        break
      }
      case 'pending-list':
        emit({ ev: 'pending-list', id, pending: lib.getPendingPayments() }); break

      // ── Section Translator Relay: gossip an already-translated sign to peers ──
      // Reuses the QVAC output the UI already has (no re-OCR/re-translate) and the
      // same mesh gossip as tips (broadcastRaw), same as Reunite alerts.
      case 'broadcast-sign': {
        const original = (msg.original || '').trim()
        const translation = (msg.translation || '').trim()
        if (!original && !translation) throw new Error('Read a sign first — nothing to broadcast')
        const sign = {
          id: `${myAddress}:${Date.now()}`,
          original,
          translation,
          from: myAddress,
          timestamp: Date.now()
        }
        mesh.broadcastRaw({ type: 'section-sign', sign })   // reuse mesh gossip
        emit({ ev: 'sign-broadcast', id, sign })
        break
      }

      // ── Mesh Offload: delegate QVAC OCR+translate to a connected peer ──
      // Reuses lib.readSign/lib.translateText on the RECEIVING side (see onMessage
      // 'offload-request' above) — this side just ships the image and waits.
      case 'offload-request': {
        if (!msg.path) throw new Error('offload-request requires an image path')
        const availablePeers = mesh.getPeers()
        if (availablePeers.length === 0) throw new Error('No peer available to offload to')
        const targetPeer = availablePeers[0]
        const requestId = `${peerKey}:${Date.now()}:${offloadSeq++}`
        const imageBase64 = b4a.toString(fs.readFileSync(msg.path), 'base64')

        // Feature 6: lock payment in escrow BEFORE delegating compute to the peer.
        // Falls back to old direct-pay-on-success if the deposit itself fails
        // (e.g. insufficient balance) — same fallback philosophy as report-missing.
        let escrowLocked = false
        try {
          const deposit = await lib.computeEscrowDeposit(requestId)
          escrowLocked = true
          recordAndEmitTx('Compute Deposit', deposit.hash)
          emit({
            ev: 'compute-escrow-locked',
            id,
            requestId,
            amount: lib.COMPUTE_JOB_PRICE_USDT,
            contract: lib.getComputeEscrowAddress() || lib.getEscrowAddress(),
            hash: deposit.hash
          })
        } catch (err) {
          console.warn('[escrow] Compute escrow deposit failed, falling back to direct pay-on-success:', err.message)
        }

        const sent = mesh.sendTo(targetPeer, { type: 'offload-request', requestId, imageBase64 })
        if (!sent) {
          if (escrowLocked) refundComputeJob(requestId, id, 'send-failed')
          throw new Error('No peer available to offload to')
        }
        const timer = setTimeout(() => {
          if (pendingOffloads.has(requestId)) {
            pendingOffloads.delete(requestId)
            emit({ ev: 'offload-timeout', id })
            if (escrowLocked) refundComputeJob(requestId, id, 'timeout')
          }
        }, 15000)
        pendingOffloads.set(requestId, { id, timer, type: 'compute', targetPeer, escrowLocked })
        emit({ ev: 'offload-sent', id, requestId, peer: targetPeer })
        break
      }

      case 'quit':
        emit({ ev: 'quitting', id })
        lib.shutdownWallet()
        await lib.shutdownQvac()
        await mesh.destroy()
        process.exit(0); break
      default:
        emit({ ev: 'error', id, cmd, message: `Unknown command: ${cmd}` })
    }
  } catch (err) {
    emit({ ev: 'error', id, cmd, message: err.message })
  }
}
