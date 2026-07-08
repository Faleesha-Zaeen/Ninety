// index.js — Ninety: offline football fan companion
//
// Main entry point for the Bare runtime.
// Ties together: QVAC (OCR + translation), Pears mesh (tip gossip), WDK (USDt wallet).
//
// Usage:
//   bare index.js                          → Start as peer 1 (generates new topic)
//   bare index.js <TOPIC_HEX>              → Start as peer 2 (joins peer 1's topic)
//   bare index.js --wallet-dir ./peer1-wallet          → Peer 1 with custom wallet dir
//   bare index.js <TOPIC_HEX> --wallet-dir ./peer2-wallet  → Peer 2 with custom wallet dir
//
// Full loop:
//   1. User points camera / uploads image of a sign
//   2. QVAC OCR extracts text from the image (offline)
//   3. QVAC Bergamot translates the text (offline)
//   4. Mesh checks for related fan tips from nearby peers
//   5. User can drop a tip that gossips to all connected peers
//   6. User can pay a peer USDt directly (WDK, Sepolia testnet)

import process from 'bare-process'
import path from 'bare-path'

import { initQvac, readAndTranslate, translateText, setTranslationLang, shutdownQvac } from './lib/qvac.js'
import { createMesh } from './lib/mesh.js'
import { addTip, findTips, getAllTips, formatTip, mergeTips } from './lib/tips.js'
import { initWallet, getBalance, getEthBalance, sendUsdt, getAddress, shutdownWallet } from './lib/wallet.js'

// ─── CLI arguments ───────────────────────────────────────────────────────────
// Parse --wallet-dir flag and optional topic hex from argv
let walletDir = null
let topicFromCli = null

const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wallet-dir' && i + 1 < args.length) {
    walletDir = args[i + 1]
    i++ // skip the value
  } else if (!args[i].startsWith('-')) {
    // First non-flag argument is the topic hex
    if (!topicFromCli) topicFromCli = args[i]
  }
}

// ─── State ───────────────────────────────────────────────────────────────────
let mesh = null
let peerKey = null
let inputBuffer = ''
let processing = false

// Peer wallet addresses: Map<peerPublicKeyHex, walletAddress>
const peerAddresses = new Map()

// ─── Main ────────────────────────────────────────────────────────────────────

async function main () {
  console.log('==============================================')
  console.log('       NINETY - Football Fan Companion        ')
  console.log('   Offline sign reader | Translator | P2P     ')
  console.log('==============================================')
  console.log()

  // 1. Init QVAC models (OCR + Translation)
  console.log('--- Initialising QVAC (offline AI) ---')
  await initQvac()

  // 2. Init WDK wallet (self-custodial, Sepolia testnet)
  console.log()
  console.log('--- Initialising WDK wallet (Sepolia testnet) ---')
  const dataDir = walletDir || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.ninety')
  const myAddress = await initWallet(dataDir)

  // 3. Join the P2P mesh
  console.log()
  console.log('--- Joining P2P mesh (Pears Hyperswarm) ---')
  mesh = createMesh({
    onTipReceived: (tip) => {
      mergeTips([tip])
      console.log()
      console.log(`  * New tip from peer: "${tip.label}" @ ${tip.location}: ${tip.message}`)
      process.stdout.write('ninety> ')
    },
    onMessage: (msg, remotePeerKey) => {
      // Handle wallet address exchange
      if (msg.type === 'wallet-address' && msg.address) {
        peerAddresses.set(remotePeerKey, msg.address)
        console.log()
        console.log(`  [KEY] Peer wallet discovered: ${msg.address.substring(0, 10)}...${msg.address.substring(38)}`)
        process.stdout.write('ninety> ')
      }
      // Handle payment notifications
      if (msg.type === 'payment-received' && msg.amount) {
        console.log()
        console.log(`  [PAY] Payment received: ${msg.amount} from ${msg.from?.substring(0, 10)}...`)
        console.log(`     Tx: ${msg.hash}`)
        process.stdout.write('ninety> ')
      }
      
      // Snapshot Sync: peer asking for our recent tip history
      if (msg.type === 'history-request') {
        const last50OldestFirst = getAllTips().slice(0, 50).reverse()
        console.log(`[debug] Received history-request, sending back ${last50OldestFirst.length} tips`)
        mesh.sendTo(remotePeerKey, { type: 'history-response', tips: last50OldestFirst })
      }
      
      // Snapshot Sync: received recent tip history from a peer
      if (msg.type === 'history-response' && Array.isArray(msg.tips)) {
        console.log(`[debug] Received history-response with ${msg.tips.length} tips`)
        console.log(`[debug] Calling mergeTips with:`, msg.tips)
        mergeTips(msg.tips)
        // mergeTips automatically logs '[tips] Received remote tip...' for new tips.
        process.stdout.write('ninety> ')
      }
    },
    onPeerConnected: (remotePeerKey) => {
      // Send our wallet address to the newly connected peer
      mesh.broadcastRaw({ type: 'wallet-address', address: myAddress })
      console.log(`[mesh] Sent wallet address to ${remotePeerKey.substring(0, 12)}...`)
      
      console.log(`[debug] Sending history-request to peer ${remotePeerKey.substring(0, 12)}...`)
      mesh.sendTo(remotePeerKey, { type: 'history-request' })
    },
    topicHex: topicFromCli
  })
  peerKey = mesh.topicHex

  // 5. Start interactive REPL (stdin line buffering)
  startRepl()
}

// ─── Interactive REPL via stdin data events (Bare-compatible) ─────────────────

function startRepl () {
  console.log()
  printHelp()

  try {
    process.stdin.resume()
    process.stdout.write('ninety> ')

    process.stdin.on('data', async (chunk) => {
      if (processing) return // Ignore input while processing a command

      const str = chunk.toString()
      for (let i = 0; i < str.length; i++) {
        const ch = str[i]
        if (ch === '\n' || ch === '\r') {
          const line = inputBuffer.trim()
          inputBuffer = ''
          if (line) {
            processing = true
            await handleCommand(line)
            processing = false
            process.stdout.write('ninety> ')
          }
        } else {
          inputBuffer += ch
        }
      }
    })
  } catch (err) {
    console.log('  [!] Interactive REPL unavailable (stdin not a TTY/pipe).')
    console.log(`  Error: ${err.message}`)
    console.log('  The app is running - QVAC, mesh, and wallet are active.')
    console.log('  Re-run in an interactive terminal for full REPL access.')
  }
}

// ─── Command handler ─────────────────────────────────────────────────────────

async function handleCommand (input) {
  const [cmd, ...args] = input.split(/\s+/)

  try {
    switch (cmd.toLowerCase()) {
      case 'read': {
        const imagePath = args.join(' ')
        if (!imagePath) {
          console.log('  Usage: read <path/to/image>')
          console.log('  Example: read ./sign.jpg')
          break
        }
        console.log(`  Reading sign: ${imagePath}`)
        const result = await readAndTranslate(imagePath)
        console.log()
        console.log('  +--- Sign Reader -----------------------')
        console.log(`  | Original:    ${result.original}`)
        console.log(`  | Translation: ${result.translation}`)
        console.log('  |')
        const tips = findTips(result.original)
        if (tips.length > 0) {
          console.log('  | Related tips from nearby fans:')
          for (const tip of tips.slice(0, 3)) {
            console.log(formatTip(tip))
          }
        } else {
          console.log('  | No tips found for this sign yet.')
          console.log('  | Use "tip <label> <location> <message>" to leave one.')
        }
        console.log('  +---------------------------------------')
        break
      }

      case 'translate': {
        const text = args.join(' ')
        if (!text) {
          console.log('  Usage: translate <text>')
          break
        }
        const translated = await translateText(text)
        console.log(`  -> ${translated}`)
        break
      }

      case 'lang': {
        if (args.length < 2) {
          console.log('  Usage: lang <from> <to>')
          console.log('  Example: lang en es')
          console.log('  Example: lang es en')
          break
        }
        await setTranslationLang(args[0], args[1])
        console.log(`  Language set: ${args[0]} -> ${args[1]}`)
        break
      }

      case 'tip': {
        if (args.length < 3) {
          console.log('  Usage: tip <label> <location> <message>')
          console.log('  Example: tip FoodStall Gate3 overpriced, better one around corner')
          break
        }
        const label = args[0]
        const location = args[1]
        const message = args.slice(2).join(' ')

        const tip = addTip(label, location, message, peerKey)
        mesh.broadcast(tip)
        console.log(`  Tip broadcast to mesh: "${tip.label}" @ ${tip.location}: ${tip.message}`)
        break
      }

      case 'tips': {
        const tips = getAllTips()
        if (tips.length === 0) {
          console.log('  No tips yet. Use "tip" to drop one.')
        } else {
          console.log(`  ${tips.length} tip(s):`)
          for (const tip of tips) {
            console.log(formatTip(tip))
          }
        }
        break
      }

      case 'balance': {
        const [usdt, eth] = await Promise.all([getBalance(), getEthBalance()])
        console.log(`  USDt: ${usdt.formatted}`)
        console.log(`  ETH:  ${eth.formatted} (gas)`)
        break
      }

      case 'pay': {
        // pay <amount> — sends USDt to the currently connected peer
        if (args.length < 1) {
          console.log('  Usage: pay <amount>')
          console.log('  Example: pay 5        -> sends 5.00 USDT to connected peer')
          console.log('  Example: pay 12.50    -> sends 12.50 USDT to connected peer')
          break
        }

        const amount = parseFloat(args[0])
        if (isNaN(amount) || amount <= 0) {
          console.log('  Invalid amount. Use a positive number (e.g. "pay 5").')
          break
        }

        // Find the connected peer's wallet address
        const peers = mesh.getPeers()
        if (peers.length === 0) {
          console.log('  No peers connected. Wait for a peer to join, then pay.')
          break
        }

        // Use the first connected peer's wallet address
        const peerHex = peers[0]
        const recipientAddress = peerAddresses.get(peerHex)
        if (!recipientAddress) {
          console.log('  Peer wallet address not yet known. Wait a moment and try again.')
          console.log('  (Wallet addresses are exchanged automatically when peers connect.)')
          break
        }

        console.log(`  Sending ${amount} USDT to peer: ${recipientAddress.substring(0, 10)}...`)
        const result = await sendUsdt(recipientAddress, amount)

        console.log()
        console.log('  +--- Payment Sent ----------------------')
        console.log(`  | Amount: ${amount} USDT`)
        console.log(`  | To:     ${recipientAddress.substring(0, 10)}...${recipientAddress.substring(38)}`)
        console.log(`  | Tx:     ${result.hash}`)
        console.log(`  | Fee:    ${result.fee} wei`)
        console.log('  +---------------------------------------')

        // Notify the recipient peer
        mesh.broadcastRaw({
          type: 'payment-received',
          amount: `${amount} USDT`,
          from: getAddress(),
          hash: result.hash
        })
        break
      }

      case 'address': {
        const addr = getAddress()
        console.log(`  Your wallet: ${addr}`)
        break
      }

      case 'peers': {
        const peers = mesh.getPeers()
        if (peers.length === 0) {
          console.log('  No peers connected. Waiting...')
        } else {
          console.log(`  ${peers.length} peer(s) connected:`)
          for (const p of peers) {
            const addr = peerAddresses.get(p)
            const addrStr = addr ? ` -> ${addr.substring(0, 8)}...` : ''
            console.log(`    ${p.substring(0, 16)}...${addrStr}`)
          }
        }
        break
      }

      case 'topic': {
        console.log(`  Current topic: ${mesh.topicHex}`)
        break
      }

      case 'help':
      case 'h':
      case '?':
        printHelp()
        break

      case 'quit':
      case 'exit':
      case 'q':
        console.log('Shutting down...')
        shutdownWallet()
        await shutdownQvac()
        await mesh.destroy()
        process.exit(0)
        break

      default:
        console.log(`  Unknown command: ${cmd}. Type "help" for commands.`)
    }
  } catch (err) {
    console.error('  Error:', err.message)
  }
}

// ─── Help text ───────────────────────────────────────────────────────────────

function printHelp () {
  console.log()
  console.log('  Commands:')
  console.log('    read <path>        - Read a sign image (OCR + translate)')
  console.log('    translate <text>   - Translate arbitrary text')
  console.log('    lang <from> <to>   - Switch translation language (e.g. "lang en es")')
  console.log('    tip <label> <loc> <msg> - Drop a fan tip (gossips to peers)')
  console.log('    tips               - Show all known tips')
  console.log('    balance            - Show USDt + ETH balance')
  console.log('    pay <amount>       - Send USDt to connected peer (Sepolia testnet)')
  console.log('    address            - Show your wallet address')
  console.log('    peers              - Show connected peers')
  console.log('    topic              - Show current mesh topic')
  console.log('    help               - Show this help')
  console.log('    quit               - Exit')
  console.log()
}

// ─── Run ─────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
