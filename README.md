# Ninety — Offline Football Fan Companion

[![Platform](https://img.shields.io/badge/platform-Bare-brightgreen.svg)](https://bare.pears.com)
[![Runtime](https://img.shields.io/badge/runtime-Electron-blue.svg)](https://www.electronjs.org/)
[![Smart Contracts](https://img.shields.io/badge/contracts-Solidity-orange.svg)](https://soliditylang.org/)
[![Wallet](https://img.shields.io/badge/wallet-Tether_WDK-red.svg)](https://github.com/tether/wdk)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

*Offline sign reader, translator, P2P fan tip mesh, and self-custodial USD₮ wallet for away football fans.*

---

## Technology Stack

| Component | Technology | Description |
|---|---|---|
| **P2P Mesh** | Pears / Hyperswarm | Local DHT-based peer discovery and connection mesh |
| **On-device AI** | QVAC SDK | Local runtime for OCR, translation, whisper, and Qwen completion |
| **Local LLM** | Qwen 3 600M | Chat completion for Scout AI advice and Match Briefing summaries |
| **EVM Wallet** | Tether WDK | BIP-39 seed generation, offline signing, Sepolia USD₮/ETH transfer |
| **Smart Contracts** | Solidity (v0.8.20) | Security-audited escrow contract (`ReuniteEscrow.sol`) |
| **Tooling** | Foundry | Unit testing, gas profiling, and contract verification |
| **Runtime** | Bare + Electron | Cross-platform desktop interface sitting on native Bare modules |

---

## Problem

Away football fans visiting foreign cities and crowded stadiums face unique, stressful challenges:
1. **Network Congestion**: Stadiums with 50,000+ fans saturate cellular towers. Cloud-based translation and wallet apps fail completely due to zero connectivity.
2. **Language Barriers**: Road signs, transport notices, and menus are in the local language, causing confusion.
3. **Safety and Coordination**: Finding lost friends or missing children in high-density crowds is nearly impossible without working internet.
4. **Offline Micro-payments**: Small transactions like taxi splits, food purchase, or community tips require digital payments that do not depend on cloud gateways.

---

## Solution

**Ninety** is an offline-first companion application. It orchestrates local on-device AI pipelines, peer-to-peer mesh gossip, and a self-custodial EVM wallet to deliver translation, stadium crowd tips, missing person alerts, and micro-payments without relying on central servers or cellular internet connections. 

---

## Why Ninety is Different

Ninety's architecture stands on three pillars that form an interdependent system:

```
┌─────────────────────────────────────────────────────────────┐
│                       NINETY CORE                           │
├───────────────────┬───────────────────┬─────────────────────┤
│   On-device AI    │     P2P Mesh      │  Custodial Wallet   │
│    (QVAC SDK)     │   (Hyperswarm)    │     (Tether WDK)    │
└─────────┬─────────┴─────────┬─────────┴──────────┬──────────┘
          │                   │                    │
          ▼                   ▼                    ▼
   Offline OCR, NMT,   Gossip tips, signs  Escrow payments for
   and Scout summaries  and reunite alerts  compute & finders
```

Removing any single pillar breaks the product's core utility:
* **No AI**: The app cannot translate local signs, transcribe voice, or summarize stadium conditions.
* **No P2P Mesh**: The app becomes isolated, preventing fans from sharing safety alerts, community tips, or matching addresses for local payments.
* **No Wallet**: Fans cannot pay for services, split costs, or lock bounties and compute fees in escrow contracts.

---

## Architecture Diagram

The diagram below details the data flow and orchestration across components:

```
                       [ User Input / Camera Capture ]
                                      │
                                      ▼
                             [ QVAC AI Pipeline ]
                  ┌───────────────────┼───────────────────┐
                  ▼                   ▼                   ▼
            [ GGML OCR ]        [ Bergamot NMT ]   [ Whisper Speech ]
                  │                   │                   │
                  └───────────────────┼───────────────────┘
                                      ▼
                            [ Scout / Briefing ]
                              (Qwen 3 600M LLM)
                                      │
                                      ▼
                            [ Hyperswarm Mesh ]
                  ┌───────────────────┼───────────────────┐
                  ▼                   ▼                   ▼
             [ Tip Feed ]     [ Section Relay ]    [ Reunite Alerts ]
                  │                   │                   │
                  └───────────────────┼───────────────────┘
                                      ▼
                            [ WDK EVM Engine ]
                                      │
                       ┌──────────────┴──────────────┐
                       ▼                             ▼
               [ Direct Transfer ]          [ ReuniteEscrow ]
                (Offline Pending)            (Bounty/Compute)
                                                     │
                                                     ▼
                                            [ On-chain Proof ]
```

---

## Complete Feature Documentation

### 1. Offline OCR
* **Purpose**: Allows users to scan signs, posters, and tickets in foreign stadiums.
* **User Workflow**: The user takes a photo or uploads an image of a sign. The extracted text is instantly displayed.
* **Technology**: GGML OCR engine loaded via `@qvac/sdk`. Runs fully on-device.
* **Implementation Details**: Uses `OCR_LATIN` model configuration. Automatically handles rotational retries and mag-ratios for low-contrast images.

### 2. Offline Translation
* **Purpose**: Converts foreign sign text into the user's native language.
* **User Workflow**: Extracted OCR text is piped to the Bergamot translator. The translated text appears below the original.
* **Technology**: NMT Bergamot plugin loaded via `@qvac/sdk`.
* **Implementation Details**: Manages translation pairs (e.g. `es->en`, `en->es`) using on-device models that are loaded and cached dynamically.

### 3. Camera Capture
* **Purpose**: Captures signs, QR codes, and missing person photos directly within the app.
* **User Workflow**: Clicking "Use camera" starts a live preview. Clicking "Capture" takes a snapshot and pipes it downstream.
* **Technology**: WebRTC `getUserMedia` and HTML5 video/canvas in Electron.
* **Implementation Details**: The captured frame is converted to base64, sent via IPC to the backend, saved to a temporary file, and analyzed.

### 4. Voice Input
* **Purpose**: Hands-free text transcription and translation in noisy environments.
* **User Workflow**: Pressing the microphone icon records audio. The transcribed text and its translation are rendered on the screen.
* **Technology**: Whisper.cpp model (`WHISPER_TINY_Q8_0`) loaded via `@qvac/sdk`.
* **Implementation Details**: Audio is recorded in the renderer, converted to 16kHz mono WAV, and decoded locally by Whisper.

### 5. Read Aloud
* **Purpose**: Plays translated text out loud for taxi drivers, stewards, or merchants.
* **User Workflow**: Clicking the speaker icon reads the translation aloud.
* **Technology**: Web Speech API (`speechSynthesis`).
* **Implementation Details**: Automatically picks the best matching offline system voice based on the destination language code.

### 6. Scout AI
* **Purpose**: Combines sign translation with community tips to give context-aware stadium recommendations.
* **User Workflow**: Scanning a sign (e.g., "Gate 3") displays a "Scout Advice" card explaining transport queues, security, or food options nearby.
* **Technology**: Qwen 3 600M LLM model (`QWEN3_600M_INST_Q4`) loaded via `@qvac/sdk`.
* **Implementation Details**: Ingests translation history, local tips, and language preferences into a single system prompt to generate a JSON report.

### 7. AI Tip Tagging
* **Purpose**: Automatically indexes and categorizes community tips.
* **User Workflow**: Fans write a plain-text tip. The system tags it with a category, urgency, and sentiment.
* **Technology**: Background tagging queue orchestrated via the Qwen LLM.
* **Implementation Details**: Tips are processed sequentially in a background queue. If the LLM is busy, the queue deduplicates requests.

### 8. Tip Feed
* **Purpose**: Displays a live feed of all fan tips.
* **User Workflow**: Fans can view tips dropped by others, filter by category, or write and submit a new tip.
* **Technology**: DOM-rendering logic coupled with a local memory store.
* **Implementation Details**: Append-only rendering logic ensures the UI remains highly responsive.

### 9. Match Pulse
* **Purpose**: Delivers live match scores and game highlights.
* **User Workflow**: Highlights and scores automatically propagate to the tip feed, highlighted under the "Match Pulse" category.
* **Technology**: Ingested and distributed over the P2P mesh network.
* **Implementation Details**: Match updates are treated as high-urgency tips with the location set to "Match Pulse" for easy filtering.

### 10. Match Briefing
* **Purpose**: Generates a spoken stadium summary at the click of a button.
* **User Workflow**: Fans click "Generate Match Briefing". The app reads all known tips, Reunite alerts, and sign history, compiles them, and reads the summary aloud.
* **Technology**: Qwen 3 600M LLM + Web Speech TTS.
* **Implementation Details**: Prompt is formatted to output a valid JSON object. Uses fallback parsers if the LLM output is malformed.

### 11. Broadcast to Section
* **Purpose**: Relays a translated sign to all nearby fans.
* **User Workflow**: Fans click "Broadcast to section" next to a translated sign. The sign appears in other section history panels.
* **Technology**: Hyperswarm `broadcastRaw` messaging.
* **Implementation Details**: Shares the JSON sign metadata containing text, translation, and timestamps.

### 12. Delegated Scout Inference
* **Purpose**: Offloads heavy LLM workloads to a peer if the local device is low on battery or CPU.
* **User Workflow**: The local device detects a peer with `scout` capabilities and delegates the query. The peer processes the request and returns the result.
* **Technology**: Hyperswarm messaging.
* **Implementation Details**: Uses request-response pairing over the P2P connection to prevent broadcasting compute payloads to all peers.

### 13. Escrowed Paid Compute
* **Purpose**: Compensates peers who perform delegated AI inference.
* **User Workflow**: The requester deposits a fee into escrow. The provider processes the AI query, sends the result, and releases the fee.
* **Technology**: `ReuniteEscrow` smart contract.
* **Implementation Details**: If the provider fails to respond or disconnects, the requester reclaims their deposit after a timeout.

### 14. Wallet
* **Purpose**: Offline-first, self-custodial transactions.
* **User Workflow**: Displays USD₮ and gas ETH balances, and allows direct peer-to-peer transfers.
* **Technology**: Tether WDK wallet EVM engine.
* **Implementation Details**: Keys are derived from a BIP-39 mnemonic stored at `~/.ninety/wallet-seed.txt`.

### 15. QR Payments
* **Purpose**: Quick peer-to-peer transfers in chaotic stadiums.
* **User Workflow**: Peer A shows their QR code. Peer B scans it, entering the payment amount to send.
* **Technology**: `qrcode` generator and `jsQR` parser.
* **Implementation Details**: Integrates with the camera stream to capture and decode wallet addresses.

### 16. Pending Payments Queue
* **Purpose**: Allows transactions to be queued while offline.
* **User Workflow**: Offline payments are signed and queued locally. Once connection is restored, the queue is flushed automatically.
* **Technology**: In-memory queue + WDK transaction broadcaster.
* **Implementation Details**: Transactions are signed offline and kept in a pending list until an internet connection is established.

### 17. Reunite
* **Purpose**: Broadcasts missing person alerts to the stadium crowd.
* **User Workflow**: Parents report a missing child with details, photo, and a bounty. Other users receive the alert.
* **Technology**: Hyperswarm P2P messaging.
* **Implementation Details**: Slices images into base64 chunks and gossips them over the P2P mesh network.

### 18. Reunite Escrow
* **Purpose**: Guarantees payment to the finder of a missing child.
* **User Workflow**: The parent deposits the bounty into the escrow contract. Once found, they confirm the finder and the bounty is paid.
* **Technology**: `ReuniteEscrow` Solidity contract.
* **Implementation Details**: Only the reporter (parent) can release the bounty. If the alert remains unresolved, the parent can reclaim it after a timeout.

### 19. On-chain Proof Panel
* **Purpose**: Audit log of all escrow actions.
* **User Workflow**: Shows explorer links for deposits, releases, and refunds.
* **Technology**: Etherscan integration + Foundry report compiler.
* **Implementation Details**: Displays contract deployment addresses, recent transaction history, and static metadata.

### 20. Phrasebook
* **Purpose**: Offline translation guide for foreign stadiums.
* **User Workflow**: Users browse categories (Matchday, Emergency) and select a phrase to view and read aloud.
* **Technology**: Static local phrase database + Web Speech API.
* **Implementation Details**: Features offline read-aloud functionality in the stadium's native language.

### 21. Leaderboard
* **Purpose**: Incentivizes community contributions.
* **User Workflow**: Ranks peers based on tips dropped, alerts resolved, and computed offloads completed.
* **Technology**: Mesh data sync.
* **Implementation Details**: Rebuilds rankings dynamically from incoming mesh events.

---

## AI Pipeline

Ninety chains multiple on-device AI tasks together:

```
[ Image / Voice Input ] ──► [ Whisper Speech Transcription ] 
                                      │
                                      ▼
[ Camera Snapshot ] ──────► [ GGML OCR Text Detection ]
                                      │
                                      ▼
                            [ NMT Bergamot Translation ]
                                      │
                                      ▼
                            [ Qwen 3 600M LLM (Scout) ]
                                      │
                                      ▼
                            [ Qwen 3 600M LLM (Briefing) ]
                                      │
                                      ▼
                         [ Background AI Tip Tagging ]
```

---

## Networking

### 1. Hyperswarm & Peer Discovery
Peers generate or join a shared 32-byte topic hex key. Hyperswarm utilizes DHT (Distributed Hash Table) discovery to connect peers without a central registry.

### 2. Newline-Delimited JSON (NDJSON) Framing
To prevent TCP stream coalescing, all mesh messages are serialized with a trailing newline (`\n`). Incoming TCP data streams are buffered and parsed line-by-line.

### 3. Chunked Image Transfer
Reunite alert photos are resized, compressed to JPEG, converted to base64, and split into 16KB chunks. Peers gossip these chunks and reassemble the file locally.

```
[ Sender Photo ] ──► [ Compress ] ──► [ Base64 ] ──► [ 16KB Chunks ] ──► [ P2P Gossip ]
                                                                               │
                                                                               ▼
[ Recipient UI ] ◄── [ Render ] ◄── [ Reassemble ] ◄───────────────────────────┘
```

---

## Smart Contract

Ninety uses a gas-optimized escrow contract (`ReuniteEscrow.sol`) written in Solidity.

### Escrow State Machine
```
       Active 
      /      \
     /        \
  Paid      Refunded
```

* **Active**: Bounty deposited and locked.
* **Paid**: Finder confirmed; contract transfers bounty.
* **Refunded**: Timeout expired; reporter reclaims bounty.

### Security Properties
1. **SafeERC20**: Prevents silent transfer failures.
2. **Reentrancy Protection**: Employs the Checks-Effects-Interactions (CEI) pattern.
3. **Timed Reclaims**: Reclaiming bounty is locked until the `REFUND_TIMEOUT` has elapsed.
4. **Packed Storage**: Layout optimized to fit reporter address and status into a single slot.

---

## On-chain Proof

The panel tracks contract addresses, explorer links, and recent transactions:

* **Addresses**:
  * **ReuniteEscrow**: `0x798Ac160f1f9f58bEeB1676Aa6eb107682a42A87`
  * **USD₮ Contract**: `0xd077A400968890Eacc75cdc901F0356c943e4fDb`
* **Foundry Report Summary**:
  * **Test Coverage**: 23/23 unit tests passing.
  * **Contract Size**: 5,528 bytes.
  * **Deployment Gas**: 1,128,415 gas.

---

## Installation

### Prerequisites
1. **Bare Runtime**: `npm i -g bare`
2. **Node.js** (v22.17.0 or higher)
3. **Foundry** (for solidity tests)

### Setup
```bash
git clone https://github.com/Faleesha-Zaeen/Ninety.git
cd Ninety
npm install
```

### Running the App

#### Running CLI Peers
**Peer 1**:
```bash
bare index.js
```
*Note the topic hex generated.*

**Peer 2**:
```bash
bare index.js <TOPIC_HEX>
```

#### Running the Electron UI
**Peer 1**:
```bash
npm run ui:peer1
```
*Copy the Match ID from the top right.*

**Peer 2**:
```bash
npm run ui:peer2 -- --topic <PASTE_MATCH_ID>
```

---

## Demo Walkthrough

1. **Scan a Sign**:
   * Open the **Sign Reader** tab.
   * Click **Choose image** and select `sign.jpg`.
   * The text types in, followed by the translation.
2. **Drop a Tip**:
   * Open the **Tip Feed** tab.
   * Submit a tip (e.g. `Gate 3: Long queue, use Gate 5`).
   * The tip appears instantly and propagates to all connected peers.
3. **Generate Briefing**:
   * Click **Generate Match Briefing**.
   * The app reads all local tips and reads the summary aloud.
4. **Issue a Reunite Alert**:
   * Go to **Reunite** tab.
   * Enter details and a bounty, then click **Broadcast alert**.
   * Other peers receive the child's photo and translated info.
5. **Collect Bounty**:
   * A peer clicks **Found them** on the alert card.
   * The parent confirms and pays the bounty, transferring USD₮ via the smart contract.

---

## Project Structure

```
Ninety/
├── contracts/               # Solidity Smart Contracts
│   ├── src/
│   │   └── ReuniteEscrow.sol# Bounty & Compute Escrow
│   ├── test/
│   │   └── ReuniteEscrow.t.sol
│   └── foundry-report.json  # Compiled Gas & Size Metrics
├── electron/                # Electron UI Layer
│   ├── main.cjs             # IPC Bridge & Window Manager
│   ├── preload.cjs
│   └── renderer/
│       ├── index.html
│       ├── renderer.js      # App Controller
│       └── styles.css       # Matchday-themed Stylesheet
├── lib/                     # Headless Modules
│   ├── mesh.js              # P2P Hyperswarm Networking
│   ├── onchain.js           # On-chain Proof Panel Data
│   ├── qvac.js              # Local OCR & Translation
│   ├── scout.js             # LLM Scout AI advice
│   └── wallet.js            # WDK EVM Wallet Integration
├── test.js                  # Unit tests (Scout & Tagging)
├── test-compute-escrow.js   # Unit tests (Compute Escrow)
├── test-match-briefing.js   # Unit tests (Match Briefing)
├── test-onchain-proof.js    # Unit tests (On-chain proof)
├── index.js                 # CLI Entry point
├── backend-headless.js      # Headless Backend Process
└── package.json
```

---

## Testing

Run all unit tests in the Bare runtime environment:

```bash
# Run all tests
npm test

# Run individual test files
bare test.js
bare test-compute-escrow.js
bare test-match-briefing.js
bare test-onchain-proof.js
```

### Foundry Contract Tests
To compile and test the Solidity smart contracts:
```bash
cd contracts
forge test
forge test --gas-report
```

---

## Security

* **Self-custodial keys**: Wallet seed phrases are saved at `~/.ninety/wallet-seed.txt`. Ninety never transmits private keys or mnemonics over the network.
* **No backend server**: All data is transferred peer-to-peer over Hyperswarm.
* **Checked-Effects-Interactions (CEI)**: Smart contracts update local state before transferring tokens to prevent reentrancy attacks.
* **SafeERC20**: Prevents silent transfer failures when dealing with USD₮.

---

## Future Improvements

* **Decentralized Storage**: Integrate Hypercore/Hyperdrive for persistent offline history storage.
* **Local Multi-lingual Voice Synthesis**: Support local TTS models to replace browser speech dependencies.
* **Multi-token Bounties**: Extend the escrow contract to accept other stablecoins.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
