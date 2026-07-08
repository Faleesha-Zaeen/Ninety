// lib/mesh.js — Pears Hyperswarm mesh for fan tips
//
// Two or more peers discover each other over Hyperswarm (no server needed).
// They gossip fan tips: any peer can drop a tip, and it propagates to all
// connected peers automatically. Uses JSON messages over raw TCP connections.

import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import process from 'bare-process'

/**
 * Create a mesh node that connects to peers and gossips tips.
 *
 * @param {Object} opts
 * @param {Function} opts.onTipReceived - Called when a remote tip arrives: (tip) => void
 * @param {Function} [opts.onMessage] - Called for ALL message types: (msg, peerKey) => void
 * @param {Function} [opts.onPeerConnected] - Called when a new peer connects: (remotePeerKey) => void
 * @param {Function} [opts.onPeerDisconnected] - Called when a peer disconnects: (remotePeerKey) => void
 * @param {string} [opts.topicHex] - Topic hex to join (from CLI arg or discovery)
 * @returns {{ broadcast, broadcastRaw, getPeers, destroy, topicHex }}
 */
export function createMesh ({ onTipReceived, onMessage, onPeerConnected, onPeerDisconnected, topicHex }) {
  const swarm = new Hyperswarm()
  const peerKey = b4a.toString(swarm.keyPair.publicKey, 'hex')
  const conns = []

  // Use provided topic or generate one
  let topic
  if (topicHex) {
    topic = b4a.from(topicHex, 'hex')
    console.log(`[mesh] Joining existing topic: ${topicHex}`)
  } else {
    topic = crypto.randomBytes(32)
    console.log(`[mesh] Generated new topic: ${b4a.toString(topic, 'hex')}`)
  }

  // Handle incoming connections from other peers
  swarm.on('connection', conn => {
    const remote = b4a.toString(conn.remotePublicKey, 'hex')
    console.log(`[mesh] Connected to peer: ${remote.substring(0, 12)}...`)
    conns.push(conn)

    // Notify caller so it can exchange wallet addresses with the new peer
    if (onPeerConnected) onPeerConnected(remote)

    conn.once('close', () => {
      const idx = conns.indexOf(conn)
      if (idx !== -1) conns.splice(idx, 1)
      console.log(`[mesh] Peer disconnected: ${remote.substring(0, 12)}...`)
      if (onPeerDisconnected) onPeerDisconnected(remote)
    })

    // Handle incoming messages (tips + general)
    conn.on('data', data => {
      try {
        const msg = JSON.parse(data.toString())
        // Forward all valid messages to onMessage if provided
        if (onMessage) onMessage(msg, remote)
        // Tip-specific handling (existing behavior)
        if (msg.type === 'tip' && msg.tip) {
          console.log(`[mesh] Received tip from ${remote.substring(0, 8)}...`)
          onTipReceived(msg.tip)
        }
        if (msg.type === 'tip-bulk' && Array.isArray(msg.tips)) {
          console.log(`[mesh] Received ${msg.tips.length} tips from ${remote.substring(0, 8)}...`)
          for (const tip of msg.tips) {
            onTipReceived(tip)
          }
        }
      } catch (e) {
        // Ignore malformed messages
      }
    })

    conn.on('error', e => {
      console.log(`[mesh] Connection error: ${e.message}`)
    })
  })

  // Join the topic (both client and server — any peer can discover any other)
  const discovery = swarm.join(topic, { client: true, server: true })

  // Once announced to the DHT, log the topic so other peers can join
  discovery.flushed().then(() => {
    console.log(`[mesh] Topic announced. Share this with peer 2:`)
    console.log(`[mesh]   bare index.js ${b4a.toString(topic, 'hex')}`)
  })

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Broadcast a tip to all connected peers.
   * @param {import('./tips.js').Tip} tip
   */
  function broadcast (tip) {
    const msg = JSON.stringify({ type: 'tip', tip })
    const buf = b4a.from(msg)
    for (const conn of conns) {
      try {
        conn.write(buf)
      } catch (e) {
        // Connection may have closed
      }
    }
  }

  /**
   * Get list of connected peer public keys.
   * @returns {string[]}
   */
  function getPeers () {
    return conns.map(c => b4a.toString(c.remotePublicKey, 'hex'))
  }

  /**
   * Broadcast an arbitrary JSON message to all connected peers.
   * @param {Object} msg - The message object (will be JSON-serialized)
   */
  function broadcastRaw (msg) {
    const buf = b4a.from(JSON.stringify(msg))
    for (const conn of conns) {
      try {
        conn.write(buf)
      } catch (e) {
        // Connection may have closed
      }
    }
  }

  /**
   * Destroy the swarm and all connections.
   */
  async function destroy () {
    for (const conn of conns) {
      try { conn.destroy() } catch {}
    }
    await swarm.destroy()
  }

  /**
   * Mesh Offload: send a JSON message to exactly one peer by public key,
   * instead of gossiping it to everyone (used for delegated-compute
   * request/response pairs so only the requester gets the result).
   * @param {string} peerKeyHex - remote public key (as given to onPeerConnected/onMessage)
   * @param {Object} msg - the message object (will be JSON-serialized)
   * @returns {boolean} whether a matching connection was found and written to
   */
  function sendTo (peerKeyHex, msg) {
    const conn = conns.find(c => b4a.toString(c.remotePublicKey, 'hex') === peerKeyHex)
    if (!conn) return false
    try {
      conn.write(b4a.from(JSON.stringify(msg)))
      return true
    } catch (e) {
      return false
    }
  }

  return { broadcast, broadcastRaw, getPeers, sendTo, destroy, topicHex: b4a.toString(topic, 'hex') }
}
