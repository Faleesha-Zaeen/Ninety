# Ninety — Offline Football Fan Companion

Offline sign reader, translator, P2P fan tip mesh, and USDt wallet for away football fans.

## Tech Stack

- **QVAC** — On-device AI (OCR + Bergamot translation, fully offline)
- **Pears / Hyperswarm** — P2P mesh for fan tip gossip (no server)
- **WDK** — Self-custodial wallet (USDt on Sepolia testnet)
- **Bare** — Runtime (same as Pears native)

## Prerequisites

1. **Bare runtime** — `npm i -g bare` (or see https://bare.pears.com)
2. **Node.js ≥ 22.17** (for npm only)
3. **Sepolia ETH** — for gas fees (visit https://sepoliafaucet.com)
4. **Sepolia USDt** — for test payments (visit https://dashboard.pimlico.io/test-erc20-faucet)

## Install

```bash
cd Ninety
npm install
```

## Run (two peers)

**Peer 1** (generates a new topic):
```bash
bare index.js
```

Peer 1 will print a topic hex string. Copy it.

**Peer 2** (joins peer 1's topic):
```bash
bare index.js <PASTE_TOPIC_HEX_HERE>
```

## Test the Full Loop

### Step 1: Read a sign on Peer 1
```bash
ninety> read ./sign.jpg
```
Shows OCR result + translation + any matching tips.

### Step 2: Drop a tip on Peer 2
```bash
ninety> tip FoodStall Gate3 overpriced, better one around corner
```
The tip gossips to Peer 1 automatically.

### Step 3: Read the same sign on Peer 1
```bash
ninety> read ./sign.jpg
```
Now shows the tip from Peer 2 alongside the translation.

### Step 4: Check balances
```bash
ninety> balance
  USDt: 0.00
  ETH:  0.0500 (gas)
```

### Step 5: Pay Peer 2 for a taxi split
```bash
ninety> pay 5
  Sending 5 USDT to peer: 0x7169D388...
  ┌─── Payment Sent ──────────────────────
  │ Amount: 5 USDT
  │ To:     0x7169D388...58d90ba06
  │ Tx:     0xabc...
  │ Fee:    21000 wei
  └─────────────────────────────────────────
```

Peer 2 sees:
```
  💰 Payment received: 5 USDT from 0x1234...abcd
     Tx: 0xabc...
```

## Desktop UI (Electron)

A dark, matchday-themed Electron UI sits on top of the **exact same backend** —
`lib/qvac.js`, `lib/mesh.js`, `lib/wallet.js` are imported and called unchanged.
Each window runs its own headless Bare backend (`backend-headless.js`) and talks
to it over a loopback TCP socket, so two windows behave exactly like the two
terminals above — two real peers.

### Launch two windows (two peers)

Open **two terminals**.

**Peer 1** (generates a topic):
```bash
npm run ui:peer1
```
The window boots, then shows its **Match ID** in the scoreboard strip (top right).
Copy it (click the Match ID to copy).

**Peer 2** (joins Peer 1's topic):
```bash
npm run ui:peer2 -- --topic <PASTE_MATCH_ID>
```

Both windows use separate wallets (`peer1-wallet/`, `peer2-wallet/`) and separate
Chromium profiles, so they run side by side without conflict. When they discover
each other, the scoreboard dot turns green (**LIVE**) and each shows `PEERS: 1`.

### Test the read → tip → pay loop in the UI

1. **Sign reader** (Peer 1): click **Choose image**, pick `sign.jpg`. The detected
   text types in, then the translation appears below it, then any matching tips.
2. **Tip feed** (Peer 2): fill label / location / message, click **Drop tip**. It
   appears instantly on Peer 2 and fades into Peer 1's feed (the tab shows an
   unread badge).
3. **Wallet** (Peer 1): the USD₮ / ETH balance shows in scoreboard digits. Type an
   amount, click **Pay**. A toast confirms `Sent 1.00 USD₮ ✓`; Peer 2 gets a
   `Received 1 USDT ✓` toast. Both balances refresh.

> First launch downloads the QVAC models (~50 MB) once, then runs fully offline.
> If a window says *"Failed to launch Bare backend"*, make sure `bare` is installed
> (`npm i -g bare`) and on your PATH.

### Reunite — missing-person mesh alert with a bounty

A fourth tab, **Reunite**, reuses the same three engines: QVAC (OCR + translate),
Pears mesh (`broadcastRaw` gossip), and WDK (`sendUsdt`).

1. **Report** (Peer 1 → Reunite): choose a photo, enter a name + detail
   (e.g. "red jersey, number 10") and a USD₮ bounty, click **Broadcast alert**.
   QVAC reads any text in the photo (wristband/shirt) and translates the detail;
   the alert gossips to every peer.
2. **Receive + Found** (Peer 2 → Reunite, "Alerts near you"): sees the photo,
   name, translated detail, and bounty. Clicks **Found them** → a mesh message
   goes back to Peer 1.
3. **Confirm + pay bounty** (Peer 1): the report card flips to **Confirm & pay
   bounty**. Click it → the bounty is sent peer-to-peer via WDK, straight to the
   finder. Peer 2 gets a `Received … (bounty) ✓` toast; both balances update.

### Performance notes

Built for a low-end laptop (integrated graphics): solid fills and 1px borders
(no `backdrop-filter`, no stacked gradients, one small glow on the live dot only),
compositor-cheap `opacity`/`transform` transitions, and append-only list updates
(new tips/toasts never re-render the list). Two windows run simultaneously without
GPU strain.

## Commands (CLI REPL)

| Command | Description |
|---------|-------------|
| `read <path>` | OCR + translate a sign image |
| `translate <text>` | Translate arbitrary text |
| `lang <from> <to>` | Switch translation language |
| `tip <label> <loc> <msg>` | Drop a fan tip (gossips to peers) |
| `tips` | Show all known tips |
| `balance` | Show USDt + ETH balance |
| `pay <amount>` | Send USDt to connected peer (Sepolia testnet) |
| `address` | Show your wallet address |
| `peers` | Show connected peers |
| `topic` | Show current mesh topic |
| `help` | Show help |
| `quit` | Exit |

## How It Works

1. **QVAC OCR** extracts text from images using GGML ONNX models (runs locally)
2. **QVAC Bergamot** translates extracted text (NMT, runs locally)
3. **Pears Hyperswarm** discovers nearby peers over a shared topic
4. **Tips** are JSON messages broadcast to all connected peers
5. **WDK** creates a self-custodial EVM wallet on Sepolia testnet
6. **Wallet addresses** are exchanged automatically when peers connect
7. **Payments** use WDK `account.transfer()` for ERC-20 USDt sends
8. **No cloud calls** — everything runs on-device after first model download

## File Structure

```
Ninety/
├── index.js          # Main Bare worker (REPL + orchestration)
├── lib/
│   ├── qvac.js       # QVAC OCR + Translation wrapper
│   ├── mesh.js       # Pears Hyperswarm mesh + tip/wallet gossip
│   ├── tips.js       # Fan tip store + keyword matching
│   └── wallet.js     # WDK self-custodial wallet (Sepolia USDt)
├── qvac.config.json  # QVAC plugin config
└── package.json
```

## Wallet Details

- **Network**: Sepolia testnet (chain ID 11155111)
- **Token**: USDt (Tether USD, 6 decimals)
- **Contract**: `0x7169D38820dfd117c3fa1f22a697dba58d90ba06`
- **Key storage**: `~/.ninety/wallet-seed.txt` (BIP-39 seed phrase)
- **Self-custodial**: Only you hold your keys. No server, no escrow.
