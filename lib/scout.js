import { getSdk, getLlmModelId } from './qvac.js'
import { updateTipInStore } from './tips.js'

/**
 * Truncate long text to prevent context window overflow on small local models.
 */
function limitText (text, maxLen = 600) {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.substring(0, maxLen) + '... [truncated]'
}

/**
 * Filter and format nearby mesh tips into a standard structured format.
 * Handles both string arrays and full tip object arrays.
 * @param {Array<string|Object>} tips
 * @returns {Array<{location: string, message: string}>}
 */
export function selectTips (tips) {
  if (!tips) return []
  return tips
    .filter(t => t !== null && t !== undefined)
    .map(tip => {
      if (typeof tip === 'string') {
        return { location: 'nearby', message: tip }
      }
      return {
        location: tip.location || 'nearby',
        message: tip.message || ''
      }
    })
    .filter(t => t.message.trim().length > 0)
}

/**
 * Builds the chat history context to feed to Qwen LLM.
 * @param {string} ocrText
 * @param {string} translatedText
 * @param {Array<{location: string, message: string}>} selectedTips
 * @param {string} currentLanguage
 * @returns {Array<Object>}
 */
export function buildHistory (ocrText, translatedText, selectedTips, currentLanguage = 'en') {
  const truncatedOcr = limitText(ocrText, 600)
  const truncatedTrans = limitText(translatedText, 600)
  const tipsText = (selectedTips && selectedTips.length > 0)
    ? selectedTips.map((tip, idx) => `${idx + 1}. [Location: ${limitText(tip.location, 50)}] ${limitText(tip.message, 200)}`).join('\n')
    : 'No tips available.'

  const langMap = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    nl: 'Dutch',
    ru: 'Russian',
    ja: 'Japanese',
    ko: 'Korean',
    zh: 'Chinese'
  }
  const languageName = langMap[currentLanguage.toLowerCase()] || currentLanguage

  return [
    {
      role: 'system',
      content: 'You are a helpful travel assistant. Analyze the sign, translation, and nearby community tips to provide a concise recommendation in the requested language.\n\n' +
        'Rules:\n' +
        '1. Provide a concise recommendation in exactly 2-3 sentences.\n' +
        '2. Rely ONLY on the provided tips. Do not hallucinate facts.\n' +
        '3. If there are no tips or no useful tips, explicitly state that there are no useful tips.\n' +
        '4. You must output a JSON object with the following fields: "recommendation" (string), "confidence" (string: "high", "medium", or "low"), "sourceCount" (number).\n\n' +
        'Example format: {"recommendation": "Skip this food court. Multiple nearby fans report long queues and high prices.", "confidence": "high", "sourceCount": 3}'
    },
    {
      role: 'user',
      content: `Sign text: "${truncatedOcr}"\nTranslation: "${truncatedTrans}"\nNearby Tips:\n${tipsText}\nRequested Language: ${languageName}`
    }
  ]
}

/**
 * High-level analysis function using local Qwen model.
 * @param {Object} params
 * @param {string} params.ocrText
 * @param {string} params.translatedText
 * @param {Array} params.nearbyTips
 * @param {string} [params.language]
 * @param {Object} [customSdk] - Optional mock SDK for testing
 * @returns {Promise<{recommendation: string, confidence: string, sourceCount: number}>}
 */
export async function scoutAnalyze (params, customSdk = null) {
  const { ocrText, translatedText, nearbyTips, language = 'en' } = params

  const selected = selectTips(nearbyTips)
  const history = buildHistory(ocrText, translatedText, selected, language)

  let rawText = ''
  if (customSdk) {
    console.log('[scout] Running analysis via custom mock SDK...')
    const run = customSdk.completion({
      modelId: 'mock-model',
      history,
      stream: false
    })
    const final = await run.final
    rawText = final.contentText || final.text || ''
  } else {
    const sdk = getSdk()
    const modelId = await getLlmModelId()
    if (!sdk) throw new Error('[scout] QVAC SDK is not initialized')
    if (!modelId) throw new Error('[scout] Qwen LLM model is not ready')

    console.log('[scout] Running analysis on-device via Qwen...')
    const run = sdk.completion({
      modelId,
      history,
      stream: false
    })
    const final = await run.final
    rawText = final.contentText || final.text || ''
  }

  console.log('[scout] Raw model response:', rawText)

  // JSON parsing and fallback extraction
  let parsed = null
  try {
    parsed = JSON.parse(rawText.trim())
  } catch (err) {
    const match = rawText.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        parsed = JSON.parse(match[0])
      } catch {}
    }
  }

  // Graceful fallback if parsing or extraction fails
  if (!parsed || typeof parsed.recommendation !== 'string') {
    console.log('[scout] JSON parsing failed or incomplete, using fallback extractor...')
    let cleanRec = rawText.replace(/[\{\}"]/g, '').trim()
    
    // If the raw response was JSON but formatting was slightly off
    if (cleanRec.includes('recommendation:')) {
      const idx = cleanRec.indexOf('recommendation:')
      cleanRec = cleanRec.substring(idx + 'recommendation:'.length).trim()
    }
    
    parsed = {
      recommendation: cleanRec || 'No useful tips available.',
      confidence: 'medium',
      sourceCount: selected.length
    }
  }

  return {
    recommendation: parsed.recommendation,
    confidence: parsed.confidence || 'medium',
    sourceCount: typeof parsed.sourceCount === 'number' ? parsed.sourceCount : selected.length
  }
}

// ─── Feature 9: Scout Match Briefing ──────────────────────────────────────────
// Reuses the exact same Qwen model + sdk.completion() call as scoutAnalyze()
// above — same modelId, same SDK, only the prompt and output shape differ.
// No new model, no new reasoning engine.

const BRIEFING_MAX_WORDS = 130

/**
 * Build the Scout prompt for a stadium match briefing from already-known data:
 * tagged community tips (Feature 4 — this includes Match Pulse score updates,
 * which are ingested as tips with location "Match Pulse"), active Reunite
 * alerts, and the most recent sign reading. Never invents data — categories
 * with nothing to say are simply absent from the prompt, and the model is
 * instructed to omit them naturally rather than mention their absence.
 * @param {Object} params
 * @param {Array} [params.tips] - tagged tips from lib.getAllTips()
 * @param {Array} [params.reuniteAlerts] - active (unresolved) Reunite alerts
 * @param {{original:string, translation:string}|null} [params.lastRead] - most recent sign reading
 * @returns {Array<Object>}
 */
export function buildBriefingHistory ({ tips = [], reuniteAlerts = [], lastRead = null } = {}) {
  const tipLines = tips.length
    ? tips.slice(0, 10).map(t => `- [${t.category || 'other'}/${t.urgency || 'low'}] ${t.location ? limitText(t.location, 50) + ': ' : ''}${limitText(t.message, 200)}`).join('\n')
    : 'None.'

  const alertLines = reuniteAlerts.length
    ? reuniteAlerts.slice(0, 10).map(a => `- ${limitText(a.name, 50) || 'Missing person'}: ${limitText(a.detail, 200) || 'no further detail'}`).join('\n')
    : 'None.'

  const signLine = (lastRead && (lastRead.original || lastRead.translation))
    ? `"${limitText(lastRead.original, 200) || ''}" -> "${limitText(lastRead.translation, 200) || ''}"`
    : 'None.'

  return [
    {
      role: 'system',
      content: 'You are a stadium PA-style briefing assistant. Summarize ONLY the information given below into ' +
        'a single spoken briefing for a fan standing in a noisy stadium.\n' +
        'Rules:\n' +
        `1. Keep it to about 80-120 words — short enough to speak in under 20 seconds.\n` +
        '2. Cover whichever of these apply, in order of importance: safety alerts, active Reunite/missing-person ' +
        'alerts, best nearby food recommendations, transport information, queue warnings, match score/status, ' +
        'other important crowd information.\n' +
        '3. If a category has no useful information, silently skip it — never say "no information available" ' +
        'or mention missing categories.\n' +
        '4. Never invent facts. Use ONLY the tips, alerts, and sign data provided below.\n' +
        '5. Plain spoken prose. No bullet points, no markdown, no headers, no category labels.\n' +
        '6. Output MUST be valid JSON only: {"briefing": string}.'
    },
    {
      role: 'user',
      content: `Tagged community tips (may include live match updates tagged "Match Pulse"):\n${tipLines}\n\n` +
        `Active Reunite alerts:\n${alertLines}\n\n` +
        `Most recent sign reading:\n${signLine}`
    }
  ]
}

// Safety net in case the model ignores the word-count instruction — never lets
// a briefing run long in a noisy stadium. Trims at a sentence boundary where
// possible; this only shortens, it never adds or changes wording.
function enforceBriefingLength (text, maxWords = BRIEFING_MAX_WORDS) {
  const trimmed = (text || '').trim()
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return trimmed
  const cut = words.slice(0, maxWords).join(' ')
  const lastSentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (lastSentenceEnd > cut.length * 0.5) return cut.slice(0, lastSentenceEnd + 1)
  return cut.replace(/[,;:]$/, '') + '.'
}

/**
 * Generate a concise spoken match briefing from currently-known app data.
 * Reuses the same on-device Qwen model as scoutAnalyze() — no new model load.
 * @param {Object} params
 * @param {Array} [params.tips]
 * @param {Array} [params.reuniteAlerts]
 * @param {Object|null} [params.lastRead]
 * @param {Object} [customSdk] - Optional mock SDK for testing
 * @returns {Promise<{briefing: string, sourceCount: number}>}
 */
export async function generateMatchBriefing (params = {}, customSdk = null) {
  const { tips = [], reuniteAlerts = [], lastRead = null } = params
  const history = buildBriefingHistory({ tips, reuniteAlerts, lastRead })
  const sourceCount = tips.length + reuniteAlerts.length + ((lastRead && (lastRead.original || lastRead.translation)) ? 1 : 0)

  let rawText = ''
  if (customSdk) {
    console.log('[briefing] Generating briefing via custom mock SDK...')
    const run = customSdk.completion({ modelId: 'mock-model', history, stream: false })
    const final = await run.final
    rawText = final.contentText || final.text || ''
  } else {
    const sdk = getSdk()
    const modelId = await getLlmModelId()
    if (!sdk) throw new Error('[briefing] QVAC SDK is not initialized')
    if (!modelId) throw new Error('[briefing] Qwen LLM model is not ready')

    console.log('[briefing] Generating briefing on-device via Qwen...')
    const run = sdk.completion({
      modelId,
      history,
      stream: false
    })
    const final = await run.final
    rawText = final.contentText || final.text || ''
  }

  console.log('[briefing] Raw model response:', rawText)

  // JSON parsing with fallback extraction (same shape as scoutAnalyze's parser).
  let parsed = null
  try {
    parsed = JSON.parse(rawText.trim())
  } catch (err) {
    const match = rawText.match(/\{[\s\S]*\}/)
    if (match) {
      try { parsed = JSON.parse(match[0]) } catch {}
    }
  }

  let briefing
  if (parsed && typeof parsed.briefing === 'string' && parsed.briefing.trim()) {
    briefing = parsed.briefing.trim()
  } else if (rawText && rawText.trim() && !rawText.includes('{')) {
    // Model ignored the JSON-only instruction but returned usable plain prose.
    briefing = rawText.trim()
  } else {
    briefing = sourceCount > 0
      ? 'Match briefing unavailable right now — could not summarize the current data.'
      : 'No live stadium information available right now.'
  }

  return {
    briefing: enforceBriefingLength(briefing),
    sourceCount
  }
}

export function buildTaggingHistory (tipText) {
  return [
    {
      role: 'system',
      content: 'You are a travel tip classifier. Classify the message into category, urgency, sentiment, and confidence.\n' +
        'Rules:\n' +
        '- category must be exactly one of: "food", "gate", "transport", "safety", "ticket", "queue", "merchandise", "toilet", "medical", "other".\n' +
        '- urgency must be exactly one of: "low", "medium", "high".\n' +
        '- sentiment must be exactly one of: "positive", "neutral", "negative".\n' +
        '- confidence must be exactly one of: "low", "medium", "high".\n' +
        '- Output MUST be valid JSON only: {"category": string, "urgency": string, "sentiment": string, "confidence": string}.\n' +
        'Never return explanations or free-form text. Output JSON only.'
    },
    {
      role: 'user',
      content: `Message: "${tipText}"`
    }
  ]
}

// Keyword-based fallback extractor for when the model outputs non-JSON text.
// Mirrors scoutAnalyze's plain-text fallback philosophy — the model may produce
// readable prose that contains the classification fields without valid JSON.
function extractTagsFromText (rawText) {
  const result = {}

  // Category keywords (most specific first to avoid false positives)
  if (/\b(medical|doctor|nurse|first.?aid|tent|paramedic|hospital)\b/i.test(rawText)) {
    result.category = 'medical'
  } else if (/\b(safety|security|danger|unsafe|evacuate|emergency|alert|warning|fire)\b/i.test(rawText)) {
    result.category = 'safety'
  } else if (/\b(food|burger|pizza|hot.?dog|sandwich|snack|meal|eat|stall|restaurant|drink|coffee|beer)\b/i.test(rawText)) {
    result.category = 'food'
  } else if (/\b(queue|line|wait|crowded|busy|congestion)\b/i.test(rawText)) {
    result.category = 'queue'
  } else if (/\b(gate|entrance|exit|door|section|sector)\b/i.test(rawText)) {
    result.category = 'gate'
  } else if (/\b(transport|bus|train|metro|subway|parking|shuttle|taxi|ride)\b/i.test(rawText)) {
    result.category = 'transport'
  } else if (/\b(ticket|entry|admission|scan|pass)\b/i.test(rawText)) {
    result.category = 'ticket'
  } else if (/\b(merchandise|shop|store|souvenir|jersey|scarf)\b/i.test(rawText)) {
    result.category = 'merchandise'
  } else if (/\b(toilet|bathroom|restroom|washroom|lavatory)\b/i.test(rawText)) {
    result.category = 'toilet'
  }

  // Urgency keywords
  if (/\burgen(t|cy)\b.*\b(high|urgent|immediate|critical)\b|\b(high|urgent|immediate|critical).*urgen/i.test(rawText)) {
    result.urgency = 'high'
  } else if (/\burgen(t|cy)\b.*\b(medium|moderate)\b|\bmedium.*urgen/i.test(rawText)) {
    result.urgency = 'medium'
  } else if (/\burgen(t|cy)\b.*\b(low|minor)\b|\blow.*urgen/i.test(rawText)) {
    result.urgency = 'low'
  }

  // Sentiment keywords
  if (/\bsentiment\b.*\b(positive|good|great|happy|excellent)\b|\b(positive|good|great|happy).*sentiment/i.test(rawText)) {
    result.sentiment = 'positive'
  } else if (/\bsentiment\b.*\b(negative|bad|terrible|awful|angry)\b|\b(negative|bad|terrible).*sentiment/i.test(rawText)) {
    result.sentiment = 'negative'
  } else if (/\bsentiment\b.*\b(neutral|mixed|okay)\b|\bneutral.*sentiment/i.test(rawText)) {
    result.sentiment = 'neutral'
  }

  // Try to extract field:value patterns from plain text (e.g. "category: food")
  const fieldPatterns = [
    [/category[\s:]+(\w+)/i, 'category'],
    [/urgency[\s:]+(\w+)/i, 'urgency'],
    [/sentiment[\s:]+(\w+)/i, 'sentiment'],
    [/confidence[\s:]+(\w+)/i, 'confidence']
  ]

  for (const [pattern, field] of fieldPatterns) {
    if (!result[field]) {
      const m = rawText.match(pattern)
      if (m) result[field] = m[1].toLowerCase().trim()
    }
  }

  return result
}

export async function tagTipText (tipText, customSdk = null) {
  if (!tipText || tipText.trim().length === 0) {
    return {
      category: 'other',
      urgency: 'low',
      sentiment: 'neutral',
      confidence: 'low'
    }
  }

  // Truncate long tips for tagging performance/safety
  const textToTag = tipText.substring(0, 300)
  const history = buildTaggingHistory(textToTag)

  let rawText = ''
  if (customSdk) {
    const run = customSdk.completion({
      modelId: 'mock-model',
      history,
      stream: false
    })
    const final = await run.final
    rawText = final.contentText || final.text || ''
  } else {
    const sdk = getSdk()
    const modelId = await getLlmModelId()
    if (!sdk) throw new Error('[scout-tagger] QVAC SDK is not initialized')
    if (!modelId) throw new Error('[scout-tagger] Qwen LLM model is not ready')

    const run = sdk.completion({
      modelId,
      history,
      stream: false
    })
    const final = await run.final
    rawText = final.contentText || final.text || ''
  }

  // Parse JSON
  let parsed = null
  try {
    parsed = JSON.parse(rawText.trim())
  } catch (err) {
    const match = rawText.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        parsed = JSON.parse(match[0])
      } catch {}
    }
  }

  // If the model returned valid JSON with all fields, use it directly.
  // Otherwise, attempt keyword/extraction-based fallback from the raw text.
  const ALLOWED_CATEGORIES = new Set(['food', 'gate', 'transport', 'safety', 'ticket', 'queue', 'merchandise', 'toilet', 'medical', 'other'])
  const ALLOWED_URGENCIES = new Set(['low', 'medium', 'high'])
  const ALLOWED_SENTIMENTS = new Set(['positive', 'neutral', 'negative'])
  const ALLOWED_CONFIDENCES = new Set(['low', 'medium', 'high'])

  // Extract fallback tags once and reuse across all fields
  const fallbackExtracted = rawText ? extractTagsFromText(rawText) : {}

  let category, urgency, sentiment, confidence

  if (parsed && parsed.category && ALLOWED_CATEGORIES.has(parsed.category.toLowerCase().trim())) {
    category = parsed.category.toLowerCase().trim()
  } else {
    category = (fallbackExtracted.category && ALLOWED_CATEGORIES.has(fallbackExtracted.category))
      ? fallbackExtracted.category
      : 'other'
  }

  if (parsed && parsed.urgency && ALLOWED_URGENCIES.has(parsed.urgency.toLowerCase().trim())) {
    urgency = parsed.urgency.toLowerCase().trim()
  } else {
    urgency = (fallbackExtracted.urgency && ALLOWED_URGENCIES.has(fallbackExtracted.urgency))
      ? fallbackExtracted.urgency
      : 'low'
  }

  if (parsed && parsed.sentiment && ALLOWED_SENTIMENTS.has(parsed.sentiment.toLowerCase().trim())) {
    sentiment = parsed.sentiment.toLowerCase().trim()
  } else {
    sentiment = (fallbackExtracted.sentiment && ALLOWED_SENTIMENTS.has(fallbackExtracted.sentiment))
      ? fallbackExtracted.sentiment
      : 'neutral'
  }

  confidence = (parsed && parsed.confidence && ALLOWED_CONFIDENCES.has(parsed.confidence.toLowerCase().trim()))
    ? parsed.confidence.toLowerCase().trim()
    : 'low'

  return { category, urgency, sentiment, confidence }
}

let tagQueue = []
let tagProcessing = false

export function queueTip (tip, customSdk = null, onTagged = null) {
  if (!tip || !tip.id) return
  // Skip if already tagged — prevents re-queueing after processQueue completes
  if (tip.tagged) return

  tagQueue.push({ tip, customSdk, onTagged })
  processQueue()
}

async function processQueue () {
  if (tagProcessing) return
  if (tagQueue.length === 0) return

  tagProcessing = true
  const { tip, customSdk, onTagged } = tagQueue.shift()

  // Mark as tagged immediately to prevent re-queueing during async wait
  tip.tagged = true

  try {
    const tags = await tagTipText(tip.message, customSdk)

    // Update local store and tip object reference (same object)
    updateTipInStore(tip.id, tags)
    Object.assign(tip, tags)
  } catch (err) {
    // Tagging failed — tip is already marked tagged=true so it won't re-queue
  } finally {
    if (onTagged) {
      try { onTagged(tip) } catch {}
    }
    tagProcessing = false
    // Process next item
    processQueue()
  }
}

export function isValidScoutResult (msg) {
  return msg &&
    typeof msg.id === 'string' &&
    typeof msg.recommendation === 'string' &&
    (msg.confidence === 'low' || msg.confidence === 'medium' || msg.confidence === 'high') &&
    typeof msg.sourceCount === 'number' &&
    typeof msg.provider === 'string'
}

export async function delegateScout (params) {
  const {
    ocrText,
    translatedText,
    nearbyTips,
    language,
    mesh,
    peerCapabilities,
    pendingOffloads,
    crypto,
    b4a,
    timeoutMs = 5000,
    localScoutAnalyze
  } = params

  // 1. Capability Check
  const availablePeers = mesh.getPeers().filter(p => {
    const caps = peerCapabilities.get(p)
    return caps && caps.includes('scout')
  })

  let result = null
  let fallbackOccurred = false

  if (availablePeers.length > 0) {
    const targetPeer = availablePeers[0]
    // Cryptographically random request ID
    const requestId = b4a.toString(crypto.randomBytes(16), 'hex')
    console.log(`[Scout] Delegating to peer ${targetPeer.substring(0, 12)}`)

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
          console.log('[Scout] Timeout')
          reject(new Error('Delegation timed out'))
        }, timeoutMs)
      })

      const responsePromise = new Promise((resolve, reject) => {
        pendingOffloads.set(requestId, {
          type: 'scout',
          resolve,
          reject,
          timer,
          targetPeer
        })
      })

      try {
        const response = await Promise.race([responsePromise, timeoutPromise])
        console.log(`[Scout] Peer responded in ${Date.now() - start} ms`)
        result = response
      } catch (err) {
        console.log(`[Scout] Falling back to local: ${err.message}`)
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
    const localResult = await localScoutAnalyze({ ocrText, translatedText, nearbyTips, language })
    result = {
      ...localResult,
      provider: fallbackOccurred ? 'Fallback: Local' : 'Local Device'
    }
  }

  return result
}
