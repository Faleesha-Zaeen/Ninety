// lib/tips.js — Fan tip store + keyword matching
//
// Tips are short community-sourced notes about football match locations.
// Each tip has a label (sign text it relates to), a location hint, and a message.
// Tips are stored locally and gossiped to nearby peers over the mesh.

// In-memory tip store: Map<label_lowercased, Tip[]>
const tipStore = new Map()

/**
 * @typedef {Object} Tip
 * @property {string} id        - Unique tip ID (peerKey:timestamp)
 * @property {string} label     - The sign/label this tip relates to (lowercase)
 * @property {string} location  - Rough location description
 * @property {string} message   - The tip content
 * @property {number} timestamp - Unix timestamp
 * @property {string} peerKey   - Public key of the peer that created this tip
 */

/**
 * Add a tip to the local store.
 * @param {string} label    - Sign text this tip relates to (case-insensitive)
 * @param {string} location - Rough location (e.g. "Gate 3 North", "Sector B")
 * @param {string} message  - The tip (e.g. "overpriced, better one around corner")
 * @param {string} peerKey  - Public key of the creating peer
 * @returns {Tip} The created tip
 */
export function addTip (label, location, message, peerKey) {
  const key = label.toLowerCase().trim()
  const tip = {
    id: `${peerKey}:${Date.now()}`,
    label: key,
    location,
    message,
    timestamp: Date.now(),
    peerKey,
    category: 'other',
    urgency: 'low',
    sentiment: 'neutral',
    confidence: 'low'
  }
  if (!tipStore.has(key)) {
    tipStore.set(key, [])
  }
  tipStore.get(key).push(tip)

  console.log(`[tips] Added tip for "${key}": ${message}`)
  return tip
}

/**
 * Find tips related to a keyword (fuzzy match).
 * Matches if the tip label contains the keyword or vice versa.
 * @param {string} keyword - The keyword to search for
 * @returns {Tip[]} Matching tips, most recent first
 */
export function findTips (keyword) {
  const kw = keyword.toLowerCase().trim()
  const matches = []

  for (const [label, tips] of tipStore) {
    // Exact label match
    if (label === kw) {
      matches.push(...tips)
      continue
    }
    // Partial match: keyword contains label or label contains keyword
    if (label.includes(kw) || kw.includes(label)) {
      matches.push(...tips)
      continue
    }
    // Word-level match: any word from label appears in keyword
    const labelWords = label.split(/\s+/)
    if (labelWords.some(w => kw.includes(w) && w.length > 2)) {
      matches.push(...tips)
    }
  }

  // Sort by timestamp (newest first)
  matches.sort((a, b) => b.timestamp - a.timestamp)
  return matches
}

/**
 * Get all tips (for debugging/display).
 * @returns {Tip[]}
 */
export function getAllTips () {
  const all = []
  for (const tips of tipStore.values()) {
    all.push(...tips)
  }
  return all.sort((a, b) => b.timestamp - a.timestamp)
}

/**
 * Merge tips received from a remote peer.
 * Deduplicates by tip ID.
 * @param {Tip[]} remoteTips - Tips from another peer
 */
export function mergeTips (remoteTips) {
  for (const tip of remoteTips) {
    const key = tip.label.toLowerCase().trim()
    if (!tipStore.has(key)) {
      tipStore.set(key, [])
    }
    const existing = tipStore.get(key)
    if (!existing.find(t => t.id === tip.id)) {
      if (!tip.category) {
        tip.category = 'other'
        tip.urgency = 'low'
        tip.sentiment = 'neutral'
        tip.confidence = 'low'
      }
      existing.push(tip)
      console.log(`[tips] Received remote tip for "${key}": ${tip.message}`)
    }
  }
}

/**
 * Format a tip for display.
 */
export function formatTip (tip) {
  const age = formatAge(tip.timestamp)
  return `  [${age}] "${tip.label}" @ ${tip.location}: ${tip.message}`
}

/**
 * Format a timestamp as a human-readable age string.
 */
function formatAge (timestamp) {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Find and update metadata tags for a tip in the local store.
 * @param {string} tipId
 * @param {Object} tags
 * @returns {Tip|null} Updated tip or null if not found
 */
export function updateTipInStore (tipId, tags) {
  for (const tips of tipStore.values()) {
    const found = tips.find(t => t.id === tipId)
    if (found) {
      Object.assign(found, tags)
      return found
    }
  }
  return null
}
