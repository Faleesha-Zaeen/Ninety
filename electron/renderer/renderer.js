// renderer.js — Ninety UI logic.
// Talks to the Bare backend only through window.ninety (preload bridge).
// Design goals: append-only DOM updates, tiny per-event work, no re-renders.

const $ = (id) => document.getElementById(id)
const api = window.ninety

// Surface any uncaught renderer error instead of failing silently.
window.addEventListener('error', (e) => {
  console.error('[ui] error:', e.message)
  try { toast('warn', 'UI error', e.message) } catch {}
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[ui] rejection:', e.reason && e.reason.message)
})

// ─── Command id correlation (mostly for `read`; pushes need no id) ────────────
let cmdSeq = 0
function send (cmd, extra = {}) {
  const id = ++cmdSeq
  api.send({ id, cmd, ...extra })
  return id
}

// ─── Connection / peer tracking ──────────────────────────────────────────────
const peers = new Set()
function refreshLive () {
  const n = peers.size
  $('peerCount').textContent = String(n)
  const dot = $('liveDot'), txt = $('liveText')
  if (n > 0) { dot.classList.add('is-live'); txt.textContent = 'LIVE' }
  else { dot.classList.remove('is-live'); txt.textContent = 'WAITING' }
  const payBtn = $('payBtn')
  if (payBtn) payBtn.disabled = n === 0
}

function short (s, head = 6, tail = 4) {
  if (!s) return '—'
  return s.length <= head + tail ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

// Feature 6: human-readable label for a compute-escrow refund reason.
const COMPUTE_REFUND_REASONS = {
  timeout: 'peer did not respond in time',
  'peer-disconnected': 'peer disconnected mid-job',
  'provider-error': 'peer failed to compute',
  'malformed-result': 'peer returned an invalid result',
  'unknown-provider-address': 'provider address unknown',
  'send-failed': 'could not reach peer'
}
function reasonLabel (reason) {
  return COMPUTE_REFUND_REASONS[reason] || reason || 'compute job failed'
}

// ─── Boot overlay ─────────────────────────────────────────────────────────────
const bootStages = { qvac: 33, wallet: 66, mesh: 88 }
function setBoot (stage, message) {
  if (bootStages[stage]) $('bootFill').style.width = bootStages[stage] + '%'
  $('bootStatus').textContent = message
}
function bootDone () {
  $('bootFill').style.width = '100%'
  const boot = $('boot')
  boot.classList.add('hide')
  setTimeout(() => boot.remove(), 320)
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
let feedUnread = 0
let onchainRequested = false // Feature 10: fetch chain-info once, then only push updates
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'))
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('is-active'))
    tab.classList.add('is-active')
    const name = tab.dataset.tab
    $('panel-' + name).classList.add('is-active')
    // Release any live camera when leaving its tab (frees the device, saves power).
    if (name !== 'read' && typeof readCamera !== 'undefined') readCamera.stop()
    if (name !== 'reunite' && typeof reuniteCamera !== 'undefined') reuniteCamera.stop()
    if (name === 'feed') { feedUnread = 0; $('feedBadge').hidden = true }
    if (name === 'wallet') { send('balance'); send('peers'); send('pending-list') }
    if (name === 'reunite') { reuniteUnread = 0; $('reuniteBadge').hidden = true }
    // Feature 10: fetch once on first visit — the panel never polls after that,
    // it only updates live via 'tx-recorded' push events (see initOnchainProof).
    if (name === 'onchain' && !onchainRequested) { onchainRequested = true; send('chain-info') }
  })
})

// ─── Sign reader ──────────────────────────────────────────────────────────────
let activeRead = 0
let activeScout = 0
const ocrEl = $('ocrText'), transEl = $('transText')
const scoutCard = $('scoutCard'), scoutMeta = $('scoutMeta'), scoutText = $('scoutText'), scoutProvider = $('scoutProvider')

// Last successful read — fed straight to the Section Relay broadcast (no re-OCR).
let lastRead = { text: '', translation: '' }

// Mesh Offload: remembers the currently loaded image path so a timeout/failure
// can fall back to local processing without asking the user to re-pick.
let lastPickedPath = ''

// Both the file picker and the camera land here — identical downstream flow.
function showSignImage (picked) {
  const img = $('signPreview')
  if (picked.dataUrl) { img.src = picked.dataUrl; img.hidden = false }
  $('readChooser').hidden = true
  $('readCam').hidden = true
  $('readReview').hidden = true
  // reset output
  ocrEl.textContent = ''; ocrEl.classList.add('caret')
  transEl.textContent = '—'; transEl.classList.remove('caret')
  scoutCard.hidden = true; scoutText.textContent = '—'; scoutMeta.textContent = ''; scoutProvider.textContent = 'Reasoned by: Local Device'
  $('readTips').hidden = true; $('readTipsList').innerHTML = ''
  // reset relay state for the new read
  lastRead = { text: '', translation: '', tips: [] }
  $('broadcastSignBtn').hidden = true
  lastPickedPath = picked.path
  const offloadEl = $('offloadToggle')
  if (offloadEl && offloadEl.checked) {
    activeRead = send('offload-request', { path: picked.path })
  } else {
    activeRead = send('read', { path: picked.path })
  }
}

// Share the translation just produced with every peer in the section.
$('broadcastSignBtn').addEventListener('click', () => {
  if (!lastRead.translation && !lastRead.text) return
  send('broadcast-sign', { original: lastRead.text, translation: lastRead.translation })
})

$('pickBtn').addEventListener('click', async () => {
  const picked = await api.pickImage()
  if (!picked) return
  showSignImage(picked)
})

// ─── Voice Sign (Mic Input) ───────────────────────────────────────────────────
let micStream = null
let micRecorder = null
let micChunks = []
let micRecording = false
let micRecCount = 0  // Recording attempt counter (passes through to backend)
// micBusy spans the ENTIRE lifecycle of one recording: from the moment startMic()
// commits, through getUserMedia → recording → stop → the async onstop → blob →
// base64 → send. stopMic() nulls micRecorder synchronously, so without this lock a
// fast re-press during the async onstop gap would open a SECOND MediaRecorder while
// the first is still flushing — producing a truncated/empty blob ("No speech
// detected") or two overlapping capture sessions. This lock makes recordings
// strictly one-at-a-time regardless of how fast the button is pressed.
let micBusy = false
const micBtn = $('micBtn')

// Diagnostic: enumerate audio devices once so we can log which one is used.
;(async function enumerateAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter(d => d.kind === 'audioinput')
    console.debug('[mic] Available audio inputs:', inputs.length)
    for (const d of inputs) {
      console.debug(`[mic]   deviceId="${d.deviceId}" label="${d.label}" groupId="${d.groupId}"`)
    }
    // Log the default device
    const defaults = inputs.filter(d => d.deviceId === 'default')
    if (defaults.length > 0) {
      console.debug('[mic] Default audio input:', defaults[0].label)
    }
  } catch (err) {
    console.debug('[mic] enumerateDevices failed:', err.message)
  }
})()

async function startMic() {
  // Guard 0: a previous recording's full pipeline (record → onstop → send) is
  // still in flight. Blocks overlap even during the async gap after stopMic().
  if (micBusy) {
    console.debug('[mic] startMic blocked: previous recording still processing (micBusy)')
    toast('warn', 'One moment', 'Still finishing the last recording')
    return
  }
  // Guard 1: don't start if already recording.
  if (micRecording) return
  // Guard 2: don't start if a previous recorder hasn't fully stopped yet.
  // MediaRecorder.stop() is async — the 'inactive' transition and onstop fire
  // on a later microtask. Starting a new recording before the old one finishes
  // can cause encoder conflicts and silent audio.
  if (micRecorder && micRecorder.state !== 'inactive') {
    console.debug(`[mic] startMic blocked: previous recorder still in state "${micRecorder.state}"`)
    toast('warn', 'Wait for previous recording to finish', '')
    return
  }

  // Commit: claim the lock before any await so a rapid second press is blocked.
  micBusy = true
  const recNum = ++micRecCount
  console.debug(`========== RECORDING #${recNum} ==========`)
  console.debug(`[mic] Timestamp: ${new Date().toISOString()}`)
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // Assign to module global so stopMic() can access it.
    micStream = stream
    console.debug(`[mic] MediaStream identity: ${Object.prototype.toString.call(stream)}`)
    
    const tracks = stream.getAudioTracks()
    console.debug(`[mic] Number of audio tracks: ${tracks.length}`)
    for (const t of tracks) {
      console.debug(`[mic]   Track label="${t.label}"`)
      console.debug(`[mic]   Track.enabled=${t.enabled}`)
      console.debug(`[mic]   Track.muted=${t.muted}`)
      console.debug(`[mic]   Track.readyState=${t.readyState}`)
      try {
        const settings = t.getSettings()
        console.debug(`[mic]   Track.getSettings(): ${JSON.stringify(settings)}`)
      } catch (e) {
        console.debug(`[mic]   Track.getSettings() threw: ${e.message}`)
      }
      try {
        const constraints = t.getConstraints()
        console.debug(`[mic]   Track.getConstraints(): ${JSON.stringify(constraints)}`)
      } catch (e) {
        console.debug(`[mic]   Track.getConstraints() threw: ${e.message}`)
      }
    }
    
    // Check supported mime types and pick the best one
    let mimeType = ''
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    for (const mt of preferred) {
      if (MediaRecorder.isTypeSupported(mt)) {
        mimeType = mt
        break
      }
    }
    console.debug(`[mic] MediaRecorder mimeType: "${mimeType || '(browser default)'}"`)
    console.debug(`[mic] isTypeSupported('audio/webm;codecs=opus'): ${MediaRecorder.isTypeSupported('audio/webm;codecs=opus')}`)
    
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    console.debug(`[mic] MediaRecorder identity: ${Object.prototype.toString.call(recorder)}`)
    console.debug(`[mic] MediaRecorder.state BEFORE start: ${recorder.state}`)
    
    // Assign to module global so stopMic() can access it.
    micRecorder = recorder
    micChunks = []
    const startTime = Date.now()

    // CRITICAL: ondataavailable and onstop MUST use locally-captured `stream`,
    // `recorder`, `startTime`, `recNum`, and `chunks` — NOT the module-level
    // globals. Those globals get reassigned on the next startMic() call.
    const chunks = []
    micChunks = chunks
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => {
      const duration = Date.now() - startTime
      console.debug(`[mic] onstop fired (recording #${recNum})`)
      console.debug(`[mic]   recorder.state=${recorder.state}`)
      console.debug(`[mic]   tracks=${stream.getAudioTracks().length}`)
      for (const t of stream.getAudioTracks()) {
        console.debug(`[mic]   track readyState BEFORE stop: ${t.readyState}`)
      }
      
      // Stop the locally-captured stream, not the module-level micStream.
      stream.getTracks().forEach(t => t.stop())
      for (const t of stream.getAudioTracks()) {
        console.debug(`[mic]   track readyState AFTER stop: ${t.readyState}`)
      }
      console.debug(`[mic] MediaRecorder.state AFTER stop: ${recorder.state}`)
      
      if (chunks.length === 0) {
        console.debug(`[mic] onstop: NO CHUNKS COLLECTED — blob would be empty (recording #${recNum})`)
        micBusy = false   // release the lock — nothing will be sent
        return
      }
      const blob = new Blob(chunks)
      console.debug(`[mic] === STAGE: Blob generation ===`)
      console.debug(`[mic] Recording #${recNum}: duration=${duration}ms chunks=${chunks.length} blob.size=${blob.size} bytes blob.type="${blob.type}"`)
      
      // Diagnostic: save raw audio to disk so user can play it manually
      const reader = new FileReader()
      reader.onloadend = async () => {
        const dataUrl = reader.result
        const b64 = dataUrl.split(',')[1]
        console.debug(`[mic] === STAGE: Base64 encoding ===`)
        console.debug(`[mic] Recording #${recNum}: base64 length=${b64.length} chars (approx ${Math.round(b64.length * 0.75)} bytes raw)`)
        
        // Save the raw recorded audio to a temp file
        try {
          const saved = await api.saveAudioBlob(b64)
          if (saved && saved.ok) {
            console.debug(`[mic] === STAGE: File written ===`)
            console.debug(`[mic] Recording #${recNum}: file path=${saved.path} (file size/verification logged by QVAC backend)`)
          } else {
            console.debug(`[mic] Recording #${recNum}: saveAudioBlob returned:`, JSON.stringify(saved))
          }
        } catch (err) {
          console.debug(`[mic] Recording #${recNum}: saveAudioBlob threw: ${err.message}`)
        }
        
        console.debug(`[mic] === STAGE: Sending to backend ===`)
        console.debug(`[mic] Recording #${recNum}: sending read-voice (audioBase64 len=${b64.length})`)
        
        $('signPreview').hidden = true
        $('readChooser').hidden = false
        $('readCam').hidden = true
        $('readReview').hidden = true
        ocrEl.textContent = 'Transcribing…'; ocrEl.classList.add('caret')
        transEl.textContent = '—'; transEl.classList.remove('caret')
        scoutCard.hidden = true; scoutText.textContent = '—'; scoutMeta.textContent = ''; scoutProvider.textContent = 'Reasoned by: Local Device'
        $('readTips').hidden = true; $('readTipsList').innerHTML = ''
        lastRead = { text: '', translation: '', tips: [] }
        $('broadcastSignBtn').hidden = true
        lastPickedPath = ''
        activeRead = send('read-voice', { recNum, audioBase64: b64 })
        // Recording pipeline complete (sent to backend). Release the lock so the
        // next press is allowed. The backend serializes transcription itself, so
        // it is safe to record again while this one transcribes.
        micBusy = false
      }
      reader.onerror = () => { console.debug(`[mic] Recording #${recNum}: FileReader error`); micBusy = false }
      reader.readAsDataURL(blob)
    }
    recorder.start()
    micRecording = true
    micBtn.classList.add('recording')
    micBtn.querySelector('.entry-label').textContent = 'Recording…'
  } catch (err) {
    console.debug(`[mic] Recording #${recNum}: startMic getUserMedia FAILED: ${err.message} ${err.name}`)
    console.debug(`[mic]   stack: ${err.stack}`)
    micBusy = false   // release the lock — recording never started
    micRecording = false
    micBtn.classList.remove('recording')
    micBtn.querySelector('.entry-label').textContent = 'Hold to speak'
    toast('warn', 'Mic access denied', 'Check permissions')
  }
}

function stopMic() {
  if (!micRecording || !micRecorder) return
  console.debug(`[mic] stopMic — recorder.state=${micRecorder.state}`)
  micRecorder.stop()
  micRecording = false
  micRecorder = null
  micStream = null
  micBtn.classList.remove('recording')
  micBtn.querySelector('.entry-label').textContent = 'Hold to speak'
}

micBtn.addEventListener('mousedown', startMic)
micBtn.addEventListener('mouseup', stopMic)
micBtn.addEventListener('mouseleave', stopMic)
micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startMic() })
micBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopMic() })

// language selector
function applyLang () {
  const from = $('langFrom').value, to = $('langTo').value
  if (from === to) return
  send('lang', { from, to })
}
$('langFrom').addEventListener('change', applyLang)
$('langTo').addEventListener('change', applyLang)

// lightweight typewriter (short strings only; single textContent write per tick)
function typewriter (el, text, done) {
  el.classList.add('caret')
  const chars = [...(text || '')]
  if (chars.length === 0) { el.textContent = '—'; el.classList.remove('caret'); done && done(); return }
  let i = 0
  const step = Math.max(1, Math.round(chars.length / 60)) // cap total ticks ~60
  const timer = setInterval(() => {
    i = Math.min(chars.length, i + step)
    el.textContent = chars.slice(0, i).join('')
    if (i >= chars.length) { clearInterval(timer); el.classList.remove('caret'); done && done() }
  }, 16)
}

function renderReadTips (tips) {
  const wrap = $('readTips'), list = $('readTipsList')
  if (!tips || tips.length === 0) return
  wrap.hidden = false
  for (const t of tips.slice(0, 5)) {
    const div = document.createElement('div')
    div.className = 'read-tip'
    div.innerHTML = `<b>${esc(t.label)}</b> · <span class="rt-meta">${esc(t.location)}</span><br>${esc(t.message)}`
    list.appendChild(div)
  }
}

function triggerScoutAnalysis () {
  const ocrText = lastRead.text || ''
  const translatedText = lastRead.translation || ''
  const nearbyTips = lastRead.tips || []
  const language = $('langTo').value || 'en'

  console.log('[scout] Triggering local scout-analyze command...', { ocrText, translatedText, nearbyTips, language })
  scoutCard.hidden = false
  scoutText.textContent = 'Thinking…'
  scoutText.classList.add('caret')
  scoutMeta.textContent = ''

  activeScout = send('scout-analyze', { ocrText, translatedText, nearbyTips, language })
}

// ─── Section Translator Relay (incoming) ──────────────────────────────────────
// History of the last 5 signs relayed by peers, newest first. Re-broadcasting the
// same sign bumps the existing entry to the top instead of adding a duplicate.
const RELAY_MAX = 5
let sectionHistory = []           // [{ id, original, translation, from, timestamp }]

function relayKey (sign) {
  return ((sign.original || '') + '|' + (sign.translation || '')).toLowerCase().trim()
}

function receiveSectionSign (sign) {
  const key = relayKey(sign)
  // dedup: drop any existing entry for the same sign, then put the fresh one on top
  sectionHistory = sectionHistory.filter(s => relayKey(s) !== key)
  sectionHistory.unshift(sign)
  sectionHistory = sectionHistory.slice(0, RELAY_MAX)
  renderSectionRelay()
}

function renderSectionRelay () {
  const wrap = $('sectionRelay'), banner = $('sectionBanner'), list = $('sectionList')
  if (sectionHistory.length === 0) { wrap.hidden = true; return }
  wrap.hidden = false

  // Small, non-blocking banner for the newest arrival.
  const top = sectionHistory[0]
  banner.hidden = false
  banner.innerHTML = `<span class="relay-by">Translated by ${esc(short(top.from, 6, 4))}:</span> <span class="relay-text">${esc(top.translation || top.original)}</span>`
  banner.classList.remove('flash'); void banner.offsetWidth; banner.classList.add('flash')  // restart flash

  // Full history, newest on top. Rebuilt from the (max 5) array — trivially cheap.
  list.innerHTML = ''
  for (const s of sectionHistory) {
    const row = document.createElement('div')
    row.className = 'relay-item'
    row.innerHTML = `
      <div class="relay-item-top">
        <span class="relay-item-by">${esc(short(s.from, 6, 4))}</span>
        <span class="relay-item-time">${ago(s.timestamp)}</span>
      </div>
      <div class="relay-item-trans">${esc(s.translation || '—')}</div>
      ${s.original ? `<div class="relay-item-orig">${esc(s.original)}</div>` : ''}`
    list.appendChild(row)
  }
}

// ─── Tip feed ─────────────────────────────────────────────────────────────────
let tipCount = 0
$('tipForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const label = $('tipLabel').value.trim()
  const location = $('tipLoc').value.trim()
  const message = $('tipMsg').value.trim()
  if (!label || !location || !message) return
  send('tip', { label, location, message })
  $('tipMsg').value = ''
})

function sentimentBadgeHtml (sentiment) {
  if (sentiment === 'positive') return `<span class="badge sentiment-badge" style="color: var(--accent); margin-right: 8px;">🟢 Positive</span>`
  if (sentiment === 'negative') return `<span class="badge sentiment-badge" style="color: var(--warn); margin-right: 8px;">🔴 Negative</span>`
  return `<span class="badge sentiment-badge" style="color: var(--muted); margin-right: 8px;">🟡 Neutral</span>`
}

function urgencyBadgeHtml (urgency) {
  if (urgency === 'high') {
    return `<span class="badge urgency-badge" style="color: var(--warn); font-weight: bold; background: rgba(255, 93, 99, 0.15); padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-right: 8px; border: 1px solid rgba(255, 93, 99, 0.3);">⚠️ URGENT</span>`
  }
  return ''
}

function categoryBadgeHtml (category) {
  if (!category || category === 'other') return ''
  return `<span class="badge category-badge" style="background: var(--bg-3); border: 1px solid var(--line-2); color: var(--muted); padding: 2px 6px; border-radius: 4px; text-transform: uppercase; font-size: 9px; letter-spacing: 0.5px;">${category}</span>`
}

function addTipCard (tip, mine) {
  $('feedEmpty') && $('feedEmpty').remove()
  const card = document.createElement('div')
  card.className = 'tip-card ' + (mine ? 'mine' : 'theirs')
  
  card.setAttribute('data-id', tip.id)
  card.setAttribute('data-category', tip.category || 'other')
  card.setAttribute('data-urgency', tip.urgency || 'low')
  card.setAttribute('data-sentiment', tip.sentiment || 'neutral')

  card.innerHTML = `
    <div class="tip-card-top">
      <span class="tip-tag ${mine ? 'you' : 'peer'}">${mine ? 'YOU' : 'PEER'}</span>
      <span class="tip-label">${esc(tip.label)}</span>
      <span class="tip-loc">· ${esc(tip.location)}</span>
      <span class="tip-time">${ago(tip.timestamp)}</span>
    </div>
    <div class="tip-msg">${esc(tip.message)}</div>
    <div class="tip-badges" style="display: flex; align-items: center; gap: 4px; margin-top: 8px; font-size: 11px;">
      ${sentimentBadgeHtml(tip.sentiment)}
      ${urgencyBadgeHtml(tip.urgency)}
      ${categoryBadgeHtml(tip.category)}
    </div>`

  $('feedList').prepend(card)                 // newest on top, append-only
  tipCount++
  $('feedCount').textContent = `${tipCount} tip${tipCount === 1 ? '' : 's'}`
  
  if (activeFilter && (tip.category || 'other') !== activeFilter) {
    card.style.display = 'none'
  }

  if (!mine && !$('panel-feed').classList.contains('is-active')) {
    feedUnread++
    const b = $('feedBadge'); b.hidden = false; b.textContent = String(feedUnread)
  }
}

function updateTipCard (tip) {
  const card = document.querySelector(`.tip-card[data-id="${tip.id}"]`)
  if (!card) {
    return
  }

  card.setAttribute('data-category', tip.category || 'other')
  card.setAttribute('data-urgency', tip.urgency || 'low')
  card.setAttribute('data-sentiment', tip.sentiment || 'neutral')

  const badgesEl = card.querySelector('.tip-badges')
  if (badgesEl) {
    badgesEl.innerHTML = `
      ${sentimentBadgeHtml(tip.sentiment)}
      ${urgencyBadgeHtml(tip.urgency)}
      ${categoryBadgeHtml(tip.category)}
    `
  }

  if (activeFilter) {
    if ((tip.category || 'other') === activeFilter) {
      card.style.display = ''
    } else {
      card.style.display = 'none'
    }
  } else {
    card.style.display = ''
  }
}

let activeFilter = ''

function applyFilter (category) {
  const cards = document.querySelectorAll('.tip-card')
  cards.forEach(card => {
    const cat = card.getAttribute('data-category') || 'other'
    if (!category || cat === category) {
      card.style.display = ''
    } else {
      card.style.display = 'none'
    }
  })
}

const tipFiltersEl = $('tipFilters')
if (tipFiltersEl) {
  tipFiltersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-chip')
    if (!btn) return
    
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.remove('active')
      chip.style.background = 'var(--bg-2)'
      chip.style.borderColor = 'var(--line)'
      chip.style.color = 'var(--muted)'
      chip.style.fontWeight = 'normal'
    })
    
    btn.classList.add('active')
    btn.style.background = 'var(--bg-3)'
    btn.style.borderColor = 'var(--accent)'
    btn.style.color = 'var(--accent)'
    btn.style.fontWeight = '600'
    
    activeFilter = btn.getAttribute('data-filter')
    applyFilter(activeFilter)
  })
}

// ─── Wallet ───────────────────────────────────────────────────────────────────
$('refreshBtn').addEventListener('click', () => { send('balance'); send('peers') })
$('payBtn').addEventListener('click', () => {
  const amount = parseFloat($('payAmount').value)
  if (isNaN(amount) || amount <= 0) { toast('warn', 'Enter an amount', 'Use a positive number'); return }
  const to = $('payAddress') ? $('payAddress').value.trim() : ''
  send('pay', { amount, to: to || undefined })
  $('payBtn').disabled = true
  $('payBtn').textContent = 'Sending…'
})
$('payAmount').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('payBtn').click() })

// ── Pending payments ──
// Offline switch: forces payments to queue instead of broadcasting. Turning it
// off tells the backend the connection returned → it flushes the queue.
$('offlineToggle').addEventListener('change', (e) => {
  send('set-offline', { value: e.target.checked })
})

function renderPending (list) {
  const box = $('pendingBox'), el = $('pendingList')
  if (!list || list.length === 0) { box.hidden = true; el.innerHTML = ''; return }
  box.hidden = false
  el.innerHTML = ''
  for (const p of list) {
    const row = document.createElement('div')
    row.className = 'pending-item'
    row.innerHTML = `
      <div class="pending-top">
        <span class="pending-amount mono">${fmt(p.amount)} USD₮</span>
        <span class="pending-to mono">→ ${short(p.to, 6, 4)}</span>
      </div>
      <div class="pending-status">Signed • waiting to broadcast</div>`
    el.appendChild(row)
  }
}

function setBalance (usdt, eth) {
  $('usdtVal').textContent = usdt
  $('ethVal').textContent = (eth || '').replace(' ETH', '')
}
function bumpBalance () {
  const s = document.querySelector('.score-usdt')
  s.classList.add('bump'); setTimeout(() => s.classList.remove('bump'), 600)
}

$('addrBtn').addEventListener('click', () => copy($('addrBtn').dataset.full, 'Address copied'))
$('topicBtn').addEventListener('click', () => copy($('topicBtn').dataset.full, 'Match ID copied'))

// ─── Reunite (missing-person alerts) ──────────────────────────────────────────
let reuniteImage = null           // { path, dataUrl(full) }
let reuniteUnread = 0
const myReports = new Map()        // reportId -> { report, finderAddress }
const incomingPhotoChunks = new Map()
const completedPhotos = new Map()

// Downscale a picked image to a small JPEG thumbnail so it fits one mesh packet.
// (OCR still uses the full-res file on disk via reuniteImage.path.)
function thumbnail (dataUrl, max = 180) {
  return new Promise((resolve) => {
    if (!dataUrl) { resolve(null); return }
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      c.getContext('2d').drawImage(img, 0, 0, w, h)
      try { resolve(c.toDataURL('image/jpeg', 0.5)) } catch { resolve(null) }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

// Both the file picker and the camera land here — identical downstream flow.
function showReuniteImage (picked) {
  reuniteImage = picked
  const img = $('reunitePreview')
  if (picked.dataUrl) { img.src = picked.dataUrl; img.hidden = false }
  $('reuniteChooser').hidden = true
  $('reuniteCam').hidden = true
  $('reuniteReview').hidden = true
}

$('reunitePickBtn').addEventListener('click', async () => {
  const picked = await api.pickImage()   // reuse existing native picker
  if (!picked) return
  showReuniteImage(picked)
})

// ─── Camera capture ───────────────────────────────────────────────────────────
// One controller drives one dropzone. It only produces a { path, dataUrl } (by
// writing the capture to a temp file via api.saveCapture), then hands it to the
// same onImage() the file picker uses — no OCR/translate/gossip logic duplicated.
function makeCamera (cfg) {
  const el = (id) => $(id)
  let stream = null
  let capturedUrl = null

  function show (id) { el(id).hidden = false }
  function hide (id) { el(id).hidden = true }

  function showError (msg) {
    const e = el(cfg.error)
    e.textContent = msg; e.hidden = false
  }
  function clearError () { el(cfg.error).hidden = true }

  function stop () {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null }
    const v = el(cfg.video)
    if (v) v.srcObject = null
  }

  // Return to the chooser (both entry points still available).
  function reset () {
    stop()
    hide(cfg.cam); hide(cfg.review); show(cfg.chooser)
  }

  async function open () {
    clearError()
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('[camera] getUserMedia unavailable in this renderer')
      showError('No camera available on this device. Use “Choose file” instead.')
      return
    }
    try {
      // Plain live preview, no filters, no facing constraint (works on laptop + phone).
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    } catch (err) {
      console.error('[camera] getUserMedia rejected:', err && err.name, '-', err && err.message)
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      showError(denied
        ? 'Camera permission denied. Use “Choose file” instead.'
        : 'Could not start the camera. Use “Choose file” instead.')
      return
    }
    const tracks = stream.getVideoTracks()
    console.error('[camera] stream acquired,', tracks.length, 'video track(s):',
      tracks.map(t => `${t.label} enabled=${t.enabled} state=${t.readyState}`).join(', '))
    if (tracks.length === 0) {
      console.error('[camera] stream has no video track')
      stop()
      showError('No video from the camera. Use “Choose file” instead.')
      return
    }
    // Switch views BEFORE attaching so the <video> is laid out and visible when it paints.
    hide(cfg.chooser); hide(cfg.review); show(cfg.cam)
    const v = el(cfg.video)
    v.srcObject = stream
    v.onloadedmetadata = () => {
      v.play().catch(e => console.error('[camera] play() on loadedmetadata failed:', e && e.message))
    }
    try { await v.play() } catch (e) { console.error('[camera] initial play() failed:', e && e.message) }
  }

  function capture () {
    const v = el(cfg.video)
    const w = v.videoWidth, h = v.videoHeight
    if (!w || !h) return
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d').drawImage(v, 0, 0, w, h)
    try { capturedUrl = c.toDataURL('image/jpeg', 0.9) } catch { capturedUrl = null }
    if (!capturedUrl) { showError('Capture failed. Try again.'); reset(); return }
    stop()
    el(cfg.captured).src = capturedUrl
    hide(cfg.cam); show(cfg.review)
  }

  async function useShot () {
    if (!capturedUrl) return
    const btn = el(cfg.useBtn)
    btn.disabled = true; btn.textContent = 'Saving…'
    const saved = await api.saveCapture(capturedUrl)
    btn.disabled = false; btn.textContent = 'Use this photo'
    if (!saved) { showError('Could not save the photo. Try again or choose a file.'); return }
    hide(cfg.review)
    cfg.onImage(saved)              // identical path to file picker
  }

  el(cfg.camBtn).addEventListener('click', open)
  el(cfg.captureBtn).addEventListener('click', capture)
  el(cfg.cancelBtn).addEventListener('click', reset)
  el(cfg.retakeBtn).addEventListener('click', open)   // retake = drop the shot, reopen live
  el(cfg.useBtn).addEventListener('click', useShot)

  return { stop, reset }
}

const readCamera = makeCamera({
  chooser: 'readChooser', cam: 'readCam', review: 'readReview',
  video: 'readVideo', captured: 'readCaptured', error: 'readCamError',
  camBtn: 'readCamBtn', captureBtn: 'readCapture', cancelBtn: 'readCancelCam',
  retakeBtn: 'readRetake', useBtn: 'readUse',
  onImage: showSignImage
})
const reuniteCamera = makeCamera({
  chooser: 'reuniteChooser', cam: 'reuniteCam', review: 'reuniteReview',
  video: 'reuniteVideo', captured: 'reuniteCaptured', error: 'reuniteCamError',
  camBtn: 'reuniteCamBtn', captureBtn: 'reuniteCapture', cancelBtn: 'reuniteCancelCam',
  retakeBtn: 'reuniteRetake', useBtn: 'reuniteUse',
  onImage: showReuniteImage
})

// Compress/resize the image client-side BEFORE sending.
// Resizes to max 800px wide/height, JPEG quality ~70%.
function compressReuniteImage (dataUrl, max = 800, quality = 0.7) {
  return new Promise((resolve) => {
    if (!dataUrl) { resolve(null); return }
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        c.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(c.toDataURL('image/jpeg', quality))
      } catch (err) {
        console.error('[reunite-photo] Compression error:', err)
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

// Send compressed photo in chunks over the P2P mesh
async function sendPhotoInChunks (reportId, fullDataUrl) {
  try {
    const chunkSize = 5000 // ~5KB characters per chunk (safe from TCP fragmentation reads)
    const totalChunks = Math.ceil(fullDataUrl.length / chunkSize)

    for (let i = 0; i < totalChunks; i++) {
      const chunkData = fullDataUrl.slice(i * chunkSize, (i + 1) * chunkSize)
      send('broadcast-photo-chunk', {
        reportId,
        chunkIndex: i,
        totalChunks,
        chunkData
      })
      // Small delay to prevent TCP segment coalescing
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    console.debug('[reunite-photo] Broadcasted all chunks for:', reportId)
  } catch (err) {
    console.error('[reunite-photo] Chunk send failed:', err)
  }
}

$('reuniteBroadcast').addEventListener('click', async () => {
  const name = $('reuniteName').value.trim()
  const detail = $('reuniteDetail').value.trim()
  const bounty = parseFloat($('reuniteBounty').value)

  if (!name) { toast('warn', 'Name required', 'Enter the person’s name'); return }
  if (isNaN(bounty) || bounty <= 0) { toast('warn', 'Bounty required', 'Enter a USD₮ bounty amount'); return }

  const btn = $('reuniteBroadcast')
  btn.disabled = true
  btn.textContent = 'Broadcasting…'

  try {
    let thumbUrl = null
    let fullCompressed = null
    let imgPath = null

    if (reuniteImage) {
      imgPath = reuniteImage.path
      try {
        // Create 100px thumbnail for instant inline preview
        thumbUrl = await thumbnail(reuniteImage.dataUrl, 100)
        // Compress the original to max 800px wide @ 70% quality
        fullCompressed = await compressReuniteImage(reuniteImage.dataUrl, 800, 0.7)
      } catch (err) {
        console.debug('[reunite-photo] Photo compression failed (sending text-only):', err)
      }
    }

    // Broadcast the main text alert first (with the inline thumbnail, if any)
    const res = await send('report-missing', {
      path: imgPath,
      dataUrl: thumbUrl,
      name,
      detail,
      bounty
    })

    // If there is a high-res photo, start chunking it in the background
    if (fullCompressed && res && res.report && res.report.id) {
      // Cache it locally so we don't have to fetch it or rebuild
      completedPhotos.set(res.report.id, fullCompressed)
      // Trigger background chunk broadcast
      sendPhotoInChunks(res.report.id, fullCompressed)
    }

  } catch (err) {
    console.error('[reunite] Broadcast click handler failed:', err)
    toast('warn', 'Broadcast failed', err.message)
  } finally {
    btn.disabled = false
    btn.textContent = 'Broadcast alert'
  }
})

function renderMyAlert (report) {
  $('myAlertsWrap').hidden = false
  let card = document.getElementById('rep-' + report.id)
  const finder = myReports.get(report.id)
  const found = finder && finder.finderAddress
  if (!card) {
    card = document.createElement('div')
    card.className = 'alert-card mine'
    card.id = 'rep-' + report.id
    $('myAlerts').prepend(card)
  }
  const displayPhoto = completedPhotos.get(report.id) || report.dataUrl
  card.innerHTML = `
    <img class="alert-photo img-rep-${report.id}" src="${displayPhoto || ''}" ${!displayPhoto ? 'style="display:none;"' : ''} alt="">
    <div class="alert-body">
      <div class="alert-top">
        <span class="alert-name">${esc(report.name)}</span>
        ${report.escrowTx
          ? `<span class="alert-bounty-escrow" style="margin-left: auto; text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
              <span class="alert-status paid" style="font-size: 10px; font-weight: 800; color: var(--accent); margin: 0;">Bounty Locked ✓</span>
              <span style="font: 700 12px var(--mono); color: var(--text);">${fmt(report.bounty)} USD₮</span>
              <span style="font: 400 9px var(--mono); color: var(--muted-2);">Escrow transaction: ${short(report.escrowTx)}</span>
              <span style="font: 400 9px var(--mono); color: var(--muted-2);">Contract address: ${short(report.contract)}</span>
             </span>`
          : `<span class="alert-bounty">${fmt(report.bounty)} USD₮</span>`
        }
      </div>
      ${report.detail ? `<div class="alert-detail">${esc(report.detail)}</div>` : ''}
      <div class="alert-actions">
        ${found
          ? `<span class="alert-status found">Found — pay bounty</span>
             <button class="btn-accent btn-small" data-pay="${report.id}">Confirm &amp; pay bounty</button>`
          : `<span class="alert-status">Broadcast · waiting</span>`}
      </div>
    </div>`
  const payBtn = card.querySelector('[data-pay]')
  if (payBtn) payBtn.addEventListener('click', () => {
    payBtn.disabled = true; payBtn.textContent = 'Paying…'
    send('pay-bounty', { reportId: report.id, amount: report.bounty, toAddress: finder.finderAddress, escrowTx: report.escrowTx })
  })
}

function renderIncomingAlert (report) {
  $('reuniteEmpty') && $('reuniteEmpty').remove()
  if (document.getElementById('inc-' + report.id)) return
  const card = document.createElement('div')
  card.className = 'alert-card'
  card.id = 'inc-' + report.id
  const displayPhoto = completedPhotos.get(report.id) || report.dataUrl
  card.innerHTML = `
    <img class="alert-photo img-rep-${report.id}" src="${displayPhoto || ''}" ${!displayPhoto ? 'style="display:none;"' : ''} alt="">
    <div class="alert-body">
      <div class="alert-top">
        <span class="alert-name">${esc(report.name)}</span>
        ${report.escrowTx
          ? `<span class="alert-bounty-escrow" style="margin-left: auto; text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
              <span class="alert-status paid" style="font-size: 10px; font-weight: 800; color: var(--accent); margin: 0;">Bounty Locked ✓</span>
              <span style="font: 700 12px var(--mono); color: var(--text);">${fmt(report.bounty)} USD₮</span>
              <span style="font: 400 9px var(--mono); color: var(--muted-2);">Escrow transaction: ${short(report.escrowTx)}</span>
              <span style="font: 400 9px var(--mono); color: var(--muted-2);">Contract address: ${short(report.contract)}</span>
             </span>`
          : `<span class="alert-bounty">${fmt(report.bounty)} USD₮</span>`
        }
      </div>
      ${report.translatedDetail ? `<div class="alert-trans">${esc(report.translatedDetail)}</div>` : ''}
      ${report.detail ? `<div class="alert-detail">${esc(report.detail)}</div>` : ''}
      ${report.ocrText ? `<div class="alert-ocr">Text on photo: ${esc(report.ocrText)}</div>` : ''}
      <div class="alert-actions">
        <button class="btn-accent btn-small" data-found="${report.id}">Found them</button>
      </div>
    </div>`
  $('incomingAlerts').prepend(card)
  const foundBtn = card.querySelector('[data-found]')
  foundBtn.addEventListener('click', () => {
    foundBtn.disabled = true
    foundBtn.textContent = 'Reported found ✓'
    send('found-them', { reportId: report.id })
  })
  if (!$('panel-reunite').classList.contains('is-active')) {
    reuniteUnread++
    const b = $('reuniteBadge'); b.hidden = false; b.textContent = String(reuniteUnread)
  }
}

// ─── Toasts ─────────────────────────────────────────────────────────────────
function toast (kind, title, sub) {
  const el = document.createElement('div')
  el.className = 'toast' + (kind === 'warn' ? ' warn' : '')
  el.innerHTML = `<span class="toast-check">${kind === 'warn' ? '!' : '✓'}</span>
    <span class="toast-body"><span class="toast-title">${esc(title)}</span>${sub ? `<span class="toast-sub">${esc(sub)}</span>` : ''}</span>`
  $('toasts').appendChild(el)
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220) }, 3600)
}

// ─── Backend event dispatch ───────────────────────────────────────────────────
api.onEvent((evt) => {
  switch (evt.ev) {
    case 'status': setBoot(evt.stage, evt.message); break
    case 'ready':
      $('topicBtn').textContent = short(evt.topic, 8, 6)
      $('topicBtn').dataset.full = evt.topic
      $('addrBtn').textContent = evt.address
      $('addrBtn').dataset.full = evt.address
      ;(evt.peers || []).forEach(p => peers.add(p))
      refreshLive()
      bootDone()
      send('balance')
      break

    case 'ocr':
      if (evt.id !== activeRead) break
      lastRead.text = evt.text || ''
      typewriter(ocrEl, evt.text || '(no text detected)')
      break
    case 'translation':
      if (evt.id !== activeRead) break
      lastRead.translation = evt.text || ''
      typewriter(transEl, evt.text || '—')
      // Offer to relay once we have something worth sharing.
      if (lastRead.translation || lastRead.text) $('broadcastSignBtn').hidden = false
      break
    case 'read-tips':
      if (evt.id !== activeRead) break
      renderReadTips(evt.tips)
      break
    case 'read-done':
      if (evt.id !== activeRead) break
      triggerScoutAnalysis()
      break
    case 'scout-result':
      if (evt.id !== activeScout) break
      scoutCard.hidden = false
      scoutMeta.textContent = `Confidence: ${evt.confidence || 'medium'} · Sources: ${evt.sourceCount || 0}`
      typewriter(scoutText, evt.recommendation || 'No useful tips available.')
      
      if (evt.provider === 'Fallback: Local') {
        scoutProvider.textContent = 'Fallback: Local'
      } else if (evt.provider === 'Local Device') {
        scoutProvider.textContent = 'Reasoned by: Local Device'
      } else {
        const shortId = evt.provider ? evt.provider.substring(0, 8) : 'unknown'
        scoutProvider.textContent = `Reasoned by: Peer ${shortId}`
      }
      break

    // ── Mesh Offload: delegated QVAC OCR+translate on a connected peer ──
    case 'compute-escrow-locked':
      if (evt.id !== activeRead) break
      toast('ok', 'Escrow Locked ✓', `${evt.amount} USDt held · ${short(evt.contract, 6, 4)}`)
      break
    case 'offload-sent':
      if (evt.id !== activeRead) break
      toast('ok', 'Offloading to peer…', 'Pending — waiting for result')
      break
    case 'offload-result':
      if (evt.id !== activeRead) break
      lastRead.text = evt.original || ''
      lastRead.translation = evt.translation || ''
      typewriter(ocrEl, evt.original || '(no text detected)')
      typewriter(transEl, evt.translation || '—')
      if (lastRead.translation || lastRead.text) $('broadcastSignBtn').hidden = false
      break
    case 'pay-compute-success':
      toast('ok', 'Completed — escrow released', [
        evt.provider ? 'Provider ' + short(evt.provider, 6, 4) : null,
        evt.hash ? 'tx ' + short(evt.hash, 8, 6) : 'queued'
      ].filter(Boolean).join(' · '))
      bumpBalance(); send('balance')
      break
    case 'pay-compute-failed':
      toast('warn', 'Escrow release failed, OCR result still delivered')
      break
    case 'compute-refunded':
      toast('warn', 'Refunded', `${reasonLabel(evt.reason)} · tx ${short(evt.hash, 8, 6)}`)
      bumpBalance(); send('balance')
      break
    case 'compute-refund-failed':
      toast('warn', 'Refund failed', evt.message || reasonLabel(evt.reason))
      break

    case 'offload-timeout':
      if (evt.id !== activeRead) break
      toast('warn', 'Offload failed, processing locally', 'peer did not respond in time')
      activeRead = send('read', { path: lastPickedPath })
      break
    case 'offload-failed':
      if (evt.id !== activeRead) break
      toast('warn', 'Offload failed, processing locally', evt.message || 'peer error')
      activeRead = send('read', { path: lastPickedPath })
      break

    // ── Section Translator Relay ──
    case 'sign-broadcast': {
      const btn = $('broadcastSignBtn')
      btn.textContent = 'Broadcast ✓'
      setTimeout(() => { btn.textContent = 'Broadcast to section' }, 1600)
      receiveSectionSign({ ...evt.sign, from: evt.sign.from || evt.from })
      toast('ok', 'Broadcast to section', evt.sign.translation || evt.sign.original)
      break
    }
    case 'section-sign':
      receiveSectionSign({ ...evt.sign, from: evt.sign.from || evt.from })
      toast('ok', 'Section translation', esc(evt.sign.translation || evt.sign.original))
      break

    case 'translate-result': break
    case 'lang-set': toast('ok', `Language set`, `${evt.from.toUpperCase()} → ${evt.to.toUpperCase()}`); break

    case 'tip-added': addTipCard(evt.tip, true); break
    case 'tip-received': addTipCard(evt.tip, false); break
    case 'tip-tagged':
      updateTipCard(evt.tip); break
    case 'tips-list':
      (evt.tips || []).slice().reverse().forEach(t => addTipCard(t, false))
      break

    case 'balance': setBalance(evt.usdt, evt.eth); break

    case 'peer-connected':
      peers.add(evt.peer); refreshLive(); send('balance')
      toast('ok', 'Peer connected', short(evt.peer, 8, 6))
      break
    case 'peer-wallet':
      peers.add(evt.peer); refreshLive()
      $('payTo').textContent = 'Peer: ' + short(evt.address, 8, 6)
      break
    case 'peers-list':
      peers.clear(); (evt.peers || []).forEach(p => peers.add(p.peer))
      refreshLive()
      { const withAddr = (evt.peers || []).find(p => p.address)
        $('payTo').textContent = withAddr ? 'Peer: ' + short(withAddr.address, 8, 6) : 'No peer connected yet' }
      break

    case 'pay-result':
      $('payBtn').disabled = peers.size === 0
      $('payBtn').textContent = 'Pay'
      $('payAmount').value = ''
      toast('ok', `Sent ${fmt(evt.amount)} USD₮`, 'tx ' + short(evt.hash, 8, 6))
      bumpBalance(); send('balance')
      break
    case 'payment-received':
      toast('ok', `Received ${evt.amount}`, 'from ' + short(evt.from, 8, 6))
      bumpBalance(); send('balance')
      break

    // ── Pending payments ──
    case 'pay-pending':
      // reset whichever button initiated it
      $('payBtn').disabled = peers.size === 0
      $('payBtn').textContent = 'Pay'
      $('payAmount').value = ''
      if (evt.reportId) {                       // a bounty that queued
        const card = document.getElementById('rep-' + evt.reportId)
        const btn = card && card.querySelector('[data-pay]')
        if (btn) { btn.disabled = false; btn.textContent = 'Confirm & pay bounty' }
      }
      toast('ok', 'Signed on-device.', 'Sending when connected.')
      break
    case 'pending-list':
      renderPending(evt.pending)
      break
    case 'pending-flushed':
      for (const r of (evt.results || [])) {
        if (r.status === 'sent') toast('ok', `Sent ${fmt(r.amount)} USD₮`, 'tx ' + short(r.hash, 8, 6))
        else if (r.status === 'failed') toast('warn', 'Payment failed', r.error || 'could not broadcast')
      }
      bumpBalance(); send('balance'); send('pending-list')
      break
    case 'offline-state':
      $('offlineToggle').checked = evt.offline
      break

    // ── Reunite ──
    case 'missing-reported': {
      const btn = $('reuniteBroadcast'); btn.disabled = false; btn.textContent = 'Broadcast alert'
      myReports.set(evt.report.id, { report: evt.report, finderAddress: null })
      renderMyAlert(evt.report)
      toast('ok', 'Alert broadcast', evt.report.name + ' · ' + fmt(evt.report.bounty) + ' USD₮')
      // clear the form
      $('reuniteName').value = ''; $('reuniteDetail').value = ''; $('reuniteBounty').value = ''
      $('reunitePreview').hidden = true; $('reuniteChooser').hidden = false; reuniteImage = null
      break
    }
    case 'missing-alert':
      renderIncomingAlert(evt.report)
      toast('ok', 'Missing person alert', esc(evt.report.name))
      break
    case 'missing-photo-chunk': {
      try {
        const { reportId, chunkIndex, totalChunks, chunkData } = evt
        if (!reportId || chunkData == null) break

        if (!incomingPhotoChunks.has(reportId)) {
          incomingPhotoChunks.set(reportId, new Array(totalChunks).fill(null))
        }

        const chunks = incomingPhotoChunks.get(reportId)
        chunks[chunkIndex] = chunkData

        // Check if we have received all chunks
        const isComplete = chunks.every(c => c !== null)
        if (isComplete) {
          const fullDataUrl = chunks.join('')
          completedPhotos.set(reportId, fullDataUrl)
          incomingPhotoChunks.delete(reportId)

          // Update the DOM image elements (for both my alerts and incoming alerts)
          document.querySelectorAll('.img-rep-' + reportId).forEach(img => {
            img.src = fullDataUrl
            img.style.display = 'block'
          })
          console.debug('[reunite-photo] Photo fully reassembled for:', reportId)
        }
      } catch (err) {
        console.debug('[reunite-photo] Chunk reassembly error:', err)
      }
      break
    }
    case 'found-notice': {
      const entry = myReports.get(evt.reportId)
      if (entry) {
        entry.finderAddress = evt.finderAddress
        renderMyAlert(entry.report)
        toast('ok', 'Someone found them!', 'Confirm & pay the bounty')
      }
      break
    }
    case 'found-ack': break
    case 'bounty-paid': {
      const card = document.getElementById('rep-' + evt.reportId)
      if (card) {
        const actions = card.querySelector('.alert-actions')
        if (actions) actions.innerHTML = '<span class="alert-status paid">Bounty paid ✓</span>'
      }
      toast('ok', `Bounty paid ${fmt(evt.amount)} USD₮`, 'tx ' + short(evt.hash, 8, 6))
      bumpBalance(); send('balance')
      break
    }

    case 'error':
      if (evt.cmd === 'pay') { $('payBtn').disabled = peers.size === 0; $('payBtn').textContent = 'Pay' }
      if (evt.cmd === 'report-missing') { const b = $('reuniteBroadcast'); b.disabled = false; b.textContent = 'Broadcast alert' }
      if (evt.cmd === 'scout-analyze') {
        scoutText.textContent = 'Failed to analyze'
        scoutText.classList.remove('caret')
      }
      toast('warn', prettyCmd(evt.cmd) + ' failed', evt.message)
      if (evt.id === activeRead) { ocrEl.classList.remove('caret'); transEl.classList.remove('caret') }
      break
    case 'fatal':
      toast('warn', 'Backend error', evt.message)
      break
  }
})

api.onLog((text) => { console.debug('[bare]', text) })
api.onExit((info) => toast('warn', 'Backend stopped', 'exit code ' + info.code))
api.onBackendError((info) => { setBoot('mesh', info.message); toast('warn', 'Launch failed', info.message) })

// ─── Role badge ───────────────────────────────────────────────────────────────
api.getRole().then(role => {
  const isPeer2 = (role.walletDir || '').includes('peer2')
  $('roleBadge').textContent = isPeer2 ? 'PEER 2' : 'PEER 1'
})

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function fmt (n) { return Number(n).toFixed(2) }
function prettyCmd (c) { return ({ pay: 'Payment', read: 'Read', tip: 'Tip', lang: 'Language', 'report-missing': 'Report', 'pay-bounty': 'Bounty payment', 'found-them': 'Found', 'offload-request': 'Offload' })[c] || 'Command' }
function ago (ts) {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h' : Math.floor(h / 24) + 'd'
}
async function copy (text, msg) {
  if (!text) return
  try { await navigator.clipboard.writeText(text); toast('ok', msg, short(text, 10, 6)) }
  catch { toast('warn', 'Copy failed', '') }
}

// ─── FullVoice: text-to-speech for translated output (ADD-ONLY — no existing code modified) ──
// Uses the Web Speech API (window.speechSynthesis) built into Chromium / Electron.
// On Windows this maps to SAPI voices — fully offline, zero dependencies.
;(function initFullVoice () {
  // Bail out silently if speechSynthesis is unavailable (should never happen in Electron).
  if (typeof speechSynthesis === 'undefined') {
    console.debug('[tts] speechSynthesis not available — FullVoice disabled')
    return
  }

  const ttsBtn = $('ttsPlayBtn')
  let lastSpokenText = ''

  // ── Language code mapping (app uses short 2-letter codes; SAPI wants BCP-47) ──
  const langMap = {
    en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE',
    it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL', ru: 'ru-RU',
    ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN'
  }

  function getTtsLang () {
    try { return langMap[$('langTo').value] || 'en-US' } catch { return 'en-US' }
  }

  // ── Core speak function — try/catch wrapping, silent no-op on failure ──
  function speak (text) {
    try {
      if (!text || text === '—') return
      speechSynthesis.cancel()              // stop any in-flight utterance
      const utt = new SpeechSynthesisUtterance(text)
      utt.lang = getTtsLang()
      utt.rate = 1.0
      utt.pitch = 1.0
      utt.volume = 1.0

      // Try to pick a matching voice for the target language.
      try {
        const voices = speechSynthesis.getVoices()
        const lang = utt.lang.toLowerCase()
        const match = voices.find(v => v.lang.toLowerCase() === lang) ||
                      voices.find(v => v.lang.toLowerCase().startsWith(lang.slice(0, 2)))
        if (match) utt.voice = match
      } catch { /* proceed with default voice */ }

      utt.onstart = () => { try { ttsBtn.classList.add('speaking') } catch {} }
      utt.onend   = () => { try { ttsBtn.classList.remove('speaking') } catch {} }
      utt.onerror = () => { try { ttsBtn.classList.remove('speaking') } catch {} }

      lastSpokenText = text
      ttsBtn.hidden = false
      speechSynthesis.speak(utt)
      console.debug('[tts] speaking:', text.slice(0, 60), '| lang:', utt.lang)
    } catch (err) {
      // Silent no-op — never crash the app or block the text from displaying.
      console.debug('[tts] speak error (no-op):', err && err.message)
    }
  }

  // ── Manual replay button ──
  ttsBtn.addEventListener('click', () => {
    try { speak(lastSpokenText || transEl.textContent) } catch {}
  })

  // ── Auto-play hook: patch into the event dispatch for 'translation' events ──
  // We subscribe to backend events with a SECOND listener (append-only, doesn't
  // touch the existing api.onEvent). This listener only cares about 'translation'
  // and 'offload-result' events to trigger auto-play.
  api.onEvent((evt) => {
    try {
      if (evt.ev === 'translation' && evt.id === activeRead) {
        const text = evt.text || ''
        if (text && text !== '—') {
          // Slight delay so the typewriter has started rendering the text visually first.
          setTimeout(() => speak(text), 350)
        }
      }
      if (evt.ev === 'offload-result' && evt.id === activeRead) {
        const text = evt.translation || ''
        if (text && text !== '—') {
          setTimeout(() => speak(text), 350)
        }
      }
    } catch { /* silent no-op */ }
  })

  // ── Feature 9 hook: let other features (Match Briefing) request speech without
  // reaching into this closure — decoupled via a custom event, same ADD-ONLY
  // philosophy as everything else in this IIFE. Silent no-op if this listener was
  // never registered (speechSynthesis unavailable) — callers never need to check.
  window.addEventListener('ninety:speak', (e) => { try { speak(e.detail || '') } catch {} })

  // ── Pre-load voices (Chrome/Electron loads them asynchronously) ──
  try { speechSynthesis.getVoices() } catch {}
  try {
    speechSynthesis.addEventListener('voiceschanged', () => {
      console.debug('[tts] voices loaded:', speechSynthesis.getVoices().length)
    })
  } catch {}

  console.debug('[tts] FullVoice TTS initialized')
})()

// ─── Mesh Health Badge: read-only live status indicator (ADD-ONLY) ────────────
// Reads existing state (peers Set, backend events) via a separate onEvent listener.
// Never modifies any existing variables or event flows.
;(function initMeshHealthBadge () {
  try {
    const mhPeerCount   = $('mhPeerCount')
    const mhSyncDot     = $('mhSyncDot')
    const mhSyncText    = $('mhSyncText')
    const mhPendingCount = $('mhPendingCount')

    if (!mhPeerCount || !mhSyncDot || !mhSyncText || !mhPendingCount) {
      console.debug('[mesh-badge] DOM elements missing — badge disabled')
      return
    }

    let pendingCount = 0
    let isReady = false

    // ── Update helpers — each wrapped in try/catch ──
    function updatePeerCount () {
      try {
        // Read from the existing `peers` Set (declared at module scope in renderer.js).
        const count = typeof peers !== 'undefined' ? peers.size : 0
        mhPeerCount.textContent = String(count)
      } catch { mhPeerCount.textContent = '—' }
    }

    function updateSyncStatus () {
      try {
        const count = typeof peers !== 'undefined' ? peers.size : 0
        // Remove all state classes
        mhSyncDot.classList.remove('synced', 'syncing', 'waiting')

        if (!isReady) {
          mhSyncDot.classList.add('syncing')
          mhSyncText.textContent = 'Starting…'
        } else if (count > 0) {
          mhSyncDot.classList.add('synced')
          mhSyncText.textContent = 'Synced'
        } else {
          mhSyncDot.classList.add('waiting')
          mhSyncText.textContent = 'Waiting for peers'
        }
      } catch {
        mhSyncText.textContent = '—'
      }
    }

    function updatePendingCount (count) {
      try {
        pendingCount = count
        mhPendingCount.textContent = String(count)
      } catch { mhPendingCount.textContent = '—' }
    }

    // ── Subscribe a READ-ONLY event listener (doesn't touch the existing one) ──
    api.onEvent((evt) => {
      try {
        switch (evt.ev) {
          case 'ready':
            isReady = true
            updatePeerCount()
            updateSyncStatus()
            break

          case 'peer-connected':
          case 'peer-wallet':
          case 'peers-list':
            // The existing handler already updates the `peers` Set before this fires.
            // We just re-read it on next tick to ensure it's settled.
            setTimeout(() => { updatePeerCount(); updateSyncStatus() }, 0)
            break

          case 'pending-list':
            updatePendingCount((evt.pending || []).length)
            break

          case 'pay-pending':
            // A payment was queued — increment pending count optimistically.
            updatePendingCount(pendingCount + 1)
            break

          case 'pending-flushed':
            // Payments were flushed — the actual count will arrive via pending-list
            // shortly after (the existing handler sends('pending-list')). Set to 0
            // as an optimistic guess; the pending-list event will correct it.
            updatePendingCount(0)
            break

          case 'pay-result':
            // A direct (non-queued) payment succeeded — no pending count change,
            // but the existing handler sends('pending-list') → we'll catch it above.
            break
        }
      } catch { /* silent no-op */ }
    })

    // Initial state
    updatePeerCount()
    updateSyncStatus()
    console.debug('[mesh-badge] Mesh Health Badge initialized')
  } catch (err) {
    console.debug('[mesh-badge] init error (no-op):', err && err.message)
  }
})()

// ─── QR Wallet Share (ADD-ONLY) ──────────────────────────────────────────────
;(function initQrWalletShare () {
  try {
    const showQrBtn = $('showQrBtn')
    const qrShareWrap = $('qrShareWrap')
    const qrImage = $('qrImage')
    const scanPayBtn = $('scanPayBtn')
    const walletCam = $('walletCam')
    const walletVideo = $('walletVideo')
    const walletCancelCam = $('walletCancelCam')
    const walletCamError = $('walletCamError')

    if (!showQrBtn || !qrShareWrap || !qrImage || !scanPayBtn || !walletCam || !walletVideo || !walletCancelCam) {
      console.debug('[qr] DOM elements missing — QR features disabled')
      return
    }

    // 1. Show My QR Code
    showQrBtn.addEventListener('click', async () => {
      try {
        if (!qrShareWrap.hidden) {
          qrShareWrap.hidden = true
          showQrBtn.textContent = 'Show my QR'
          return
        }

        const addrBtn = $('addrBtn')
        const address = addrBtn ? (addrBtn.dataset.full || addrBtn.textContent) : ''
        if (!address || address === '—') {
          toast('warn', 'Address not ready', 'Please wait for the wallet to load')
          return
        }

        const dataUrl = await api.generateQR(address)
        qrImage.src = dataUrl
        qrShareWrap.hidden = false
        showQrBtn.textContent = 'Hide my QR'
      } catch (err) {
        console.error('[qr] Show QR failed:', err)
        toast('warn', 'QR Generation failed', 'Could not generate QR code')
      }
    })

    // 2. Scan to Pay
    let scanning = false
    let scannerStream = null

    function stopScanning () {
      try {
        scanning = false
        if (scannerStream) {
          scannerStream.getTracks().forEach(t => t.stop())
          scannerStream = null
        }
        walletVideo.srcObject = null
        walletCam.hidden = true
        walletCamError.hidden = true
      } catch (err) {
        console.error('[qr] Stop scanning error:', err)
      }
    }

    async function startScanning () {
      try {
        walletCamError.hidden = true
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          walletCamError.textContent = 'Camera not supported or blocked'
          walletCamError.hidden = false
          return
        }

        scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        walletVideo.srcObject = scannerStream
        walletCam.hidden = false
        scanning = true
        
        walletVideo.onloadedmetadata = () => {
          walletVideo.play().catch(e => console.error('[qr] video play failed:', e))
        }

        // Scan frame loop
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        
        function scanFrame () {
          if (!scanning) return
          try {
            if (walletVideo.readyState === walletVideo.HAVE_ENOUGH_DATA) {
              canvas.width = walletVideo.videoWidth
              canvas.height = walletVideo.videoHeight
              ctx.drawImage(walletVideo, 0, 0, canvas.width, canvas.height)
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
              const code = api.decodeQR(imgData.data, canvas.width, canvas.height)
              
              if (code) {
                const cleaned = code.trim()
                if (cleaned.startsWith('0x') && cleaned.length === 42) {
                  const payAddress = $('payAddress')
                  if (payAddress) payAddress.value = cleaned
                  toast('ok', 'Wallet QR Scanned', cleaned.slice(0, 8) + '...' + cleaned.slice(-6))
                  stopScanning()
                  return
                }
              }
            }
          } catch (err) {
            console.debug('[qr] scanFrame exception:', err)
          }
          requestAnimationFrame(scanFrame)
        }

        requestAnimationFrame(scanFrame)
      } catch (err) {
        console.error('[qr] Start scanning failed:', err)
        walletCamError.textContent = 'Could not start camera: ' + err.message
        walletCamError.hidden = false
        scanning = false
        if (scannerStream) {
          scannerStream.getTracks().forEach(t => t.stop())
          scannerStream = null
        }
      }
    }

    scanPayBtn.addEventListener('click', () => {
      if (scanning) stopScanning()
      else startScanning()
    })

    walletCancelCam.addEventListener('click', stopScanning)

    // 3. Auto-fill address from backend events (to auto-fill on peer connect)
    api.onEvent((evt) => {
      try {
        const payAddress = $('payAddress')
        if (!payAddress) return

        if (evt.ev === 'peer-wallet') {
          if (evt.address && !payAddress.value) {
            payAddress.value = evt.address
          }
        } else if (evt.ev === 'peers-list') {
          const withAddr = (evt.peers || []).find(p => p.address)
          if (withAddr && !payAddress.value) {
            payAddress.value = withAddr.address
          }
        }
      } catch {}
    })

  } catch (err) {
    console.error('[qr] initialization failed:', err)
  }
})()

// ─── Offline Phrasebook (ADD-ONLY) ───────────────────────────────────────────
;(function initOfflinePhrasebook () {
  try {
    const listEl = $('phrasebookList')
    const targetLangEl = $('pbTargetLang')
    const overlay = $('stadiumOverlay')
    const closeOverlayBtn = $('closeStadiumBtn')
    const stadiumText = $('stadiumText')
    const stadiumOrig = $('stadiumOrig')

    if (!listEl || !targetLangEl || !overlay || !closeOverlayBtn || !stadiumText || !stadiumOrig) {
      console.debug('[phrasebook] DOM elements missing — phrasebook disabled')
      return
    }

    const phrases = [
      "Where is gate [number]?",
      "Where is the nearest exit?",
      "I need medical help",
      "Where is the bathroom?",
      "I lost my ticket",
      "Where is my seat / section?",
      "Is this seat taken?",
      "Can I get water?",
      "Where is the metro/train station?",
      "How much does this cost?",
      "I don't understand",
      "Can you help me?"
    ]

    const db = {
      es: {
        "Where is gate [number]?": "¿Dónde está la puerta [número]?",
        "Where is the nearest exit?": "¿Dónde está la salida más cercana?",
        "I need medical help": "Necesito ayuda médica",
        "Where is the bathroom?": "¿Dónde está el baño?",
        "I lost my ticket": "Perdí mi entrada",
        "Where is my seat / section?": "¿Dónde está mi asiento / sección?",
        "Is this seat taken?": "¿Está ocupado este asiento?",
        "Can I get water?": "¿Puedo tomar agua?",
        "Where is the metro/train station?": "¿Dónde está la estación de metro/tren?",
        "How much does this cost?": "¿Cuánto cuesta esto?",
        "I don't understand": "No entiendo",
        "Can you help me?": "¿Me puede ayudar?"
      },
      fr: {
        "Where is gate [number]?": "Où se trouve la porte [numéro] ?",
        "Where is the nearest exit?": "Où se trouve la sortie la plus proche ?",
        "I need medical help": "J'ai besoin d'une assistance médicale",
        "Where is the bathroom?": "Où sont les toilettes ?",
        "I lost my ticket": "J'ai perdu mon billet",
        "Where is my seat / section?": "Où se trouve mon siège / ma section ?",
        "Is this seat taken?": "Ce siège est-il occupé ?",
        "Can I get water?": "Puis-je avoir de l'eau ?",
        "Where is the metro/train station?": "Où se trouve la station de métro/train ?",
        "How much does this cost?": "Combien cela coûte-t-il ?",
        "I don't understand": "Je ne comprends pas",
        "Can you help me?": "Pouvez-vous m'aider ?"
      },
      de: {
        "Where is gate [number]?": "Wo ist Tor [Nummer]?",
        "Where is the nearest exit?": "Wo ist der nächste Ausgang?",
        "I need medical help": "Ich brauche medizinische Hilfe",
        "Where is the bathroom?": "Wo ist die Toilette?",
        "I lost my ticket": "Ich habe mein Ticket verloren",
        "Where is my seat / section?": "Wo ist mein Sitzplatz / Bereich?",
        "Is this seat taken?": "Ist dieser Platz besetzt?",
        "Can I get water?": "Kann ich Wasser haben?",
        "Where is the metro/train station?": "Wo ist der U-Bahn-/Bahnhof?",
        "How much does this cost?": "Wie viel kostet das?",
        "I don't understand": "Ich verstehe nicht",
        "Can you help me?": "Können Sie mir helfen?"
      }
    }

    function getTargetLang () {
      try {
        const langEl = $('langTo')
        return langEl ? langEl.value : 'es'
      } catch {
        return 'es'
      }
    }

    function renderPhrases () {
      try {
        const lang = getTargetLang()
        targetLangEl.textContent = lang.toUpperCase()
        listEl.innerHTML = ''

        const dict = db[lang] || {}

        phrases.forEach(phrase => {
          const trans = dict[phrase] || phrase // fallback to original if not precomputed

          const card = document.createElement('div')
          card.className = 'phrase-card'
          card.style.cssText = 'background: var(--bg-2); border: 1px solid var(--line); border-radius: var(--r); padding: 12px 16px; cursor: pointer; transition: background .15s, border-color .15s;'
          
          card.innerHTML = `
            <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 4px;">${esc(trans)}</div>
            <div style="font-size: 11px; color: var(--muted);">${esc(phrase)}</div>
          `

          card.addEventListener('mouseenter', () => {
            card.style.background = 'var(--bg-3)'
            card.style.borderColor = 'var(--accent-dim)'
          })
          card.addEventListener('mouseleave', () => {
            card.style.background = 'var(--bg-2)'
            card.style.borderColor = 'var(--line)'
          })

          card.addEventListener('click', () => {
            try {
              stadiumText.textContent = trans
              stadiumOrig.textContent = phrase
              overlay.hidden = false
            } catch (err) {
              console.error('[phrasebook] Open overlay failed:', err)
            }
          })

          listEl.appendChild(card)
        })
      } catch (err) {
        console.error('[phrasebook] Render phrases failed:', err)
      }
    }

    // Toggle overlay off
    function closeOverlay () {
      overlay.hidden = true
    }
    closeOverlayBtn.addEventListener('click', closeOverlay)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target === closeOverlayBtn) closeOverlay()
    })

    // Listen for target language changes
    const langToEl = $('langTo')
    if (langToEl) {
      langToEl.addEventListener('change', () => {
        setTimeout(renderPhrases, 100)
      })
    }

    // Initial render
    renderPhrases()
    console.debug('[phrasebook] Offline Phrasebook initialized')
  } catch (err) {
    console.error('[phrasebook] initialization failed:', err)
  }
})()

// ─── Tip Leaderboard (ADD-ONLY) ──────────────────────────────────────────────
;(function initTipLeaderboard () {
  try {
    const tipsSent = new Map()       // addressOrKey -> count
    const usdtSent = new Map()       // address -> totalAmount
    const peerToWallet = new Map()   // peerKey -> walletAddress
    let localPeerKey = null

    // ── Rebuild and render the leaderboard ──
    function rebuildLeaderboard () {
      try {
        const listEl = $('leaderboardList')
        if (!listEl) return

        const stats = new Map() // resolvedAddress -> { tips: 0, usdt: 0 }

        // 1. Accumulate tips
        for (const [key, count] of tipsSent) {
          const resolved = peerToWallet.get(key) || key
          if (!stats.has(resolved)) {
            stats.set(resolved, { tips: 0, usdt: 0 })
          }
          stats.get(resolved).tips += count
        }

        // 2. Accumulate USDT
        for (const [addr, amount] of usdtSent) {
          if (!stats.has(addr)) {
            stats.set(addr, { tips: 0, usdt: 0 })
          }
          stats.get(addr).usdt += amount
        }

        // Convert Map to sorted array
        const rows = []
        for (const [addr, item] of stats) {
          // Skip placeholder peer keys if resolved address already exists
          if (addr.length !== 42 && Array.from(peerToWallet.values()).includes(addr)) {
            continue
          }

          rows.push({
            address: addr,
            tips: item.tips,
            usdt: item.usdt,
            score: item.usdt * 10 + item.tips // ranking formula
          })
        }

        // Rank highest to lowest score
        rows.sort((a, b) => b.score - a.score)

        if (rows.length === 0) {
          listEl.innerHTML = '<div id="leaderboardEmpty" class="feed-empty">No contributions recorded yet. Drop tips or send payments to top the board!</div>'
          return
        }

        listEl.innerHTML = ''
        rows.forEach((row, index) => {
          const div = document.createElement('div')
          div.className = 'leaderboard-row'
          div.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--bg-2); border: 1px solid var(--line); border-radius: var(--r); margin-bottom: 8px;'

          const rank = index + 1
          const dispAddr = row.address.startsWith('0x') ? short(row.address, 6, 4) : short(row.address, 8, 6)

          div.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 14px; font-weight: 700; color: var(--accent); min-width: 20px;">#${rank}</span>
              <span class="mono" style="font-size: 13px; color: var(--text);">${esc(dispAddr)}</span>
            </div>
            <div style="display: flex; gap: 16px; font-size: 12px; color: var(--muted);">
              <div><span style="color: var(--text); font-weight: 600;">${row.tips}</span> tips</div>
              <div><span style="color: var(--text); font-weight: 600;">${row.usdt.toFixed(2)}</span> USDT</div>
            </div>
          `
          listEl.appendChild(div)
        })
      } catch (err) {
        console.error('[leaderboard] rebuild error:', err)
      }
    }

    // ── Listen for mesh activity ──
    api.onEvent((evt) => {
      try {
        const myAddress = $('addrBtn') ? ($('addrBtn').dataset.full || $('addrBtn').textContent) : null

        switch (evt.ev) {
          case 'ready':
            localPeerKey = evt.topic
            if (evt.address) {
              peerToWallet.set(evt.topic, evt.address)
            }
            rebuildLeaderboard()
            break

          case 'peer-wallet':
            if (evt.peer && evt.address) {
              peerToWallet.set(evt.peer, evt.address)
            }
            rebuildLeaderboard()
            break

          case 'peers-list':
            (evt.peers || []).forEach(p => {
              if (p.peer && p.address) {
                peerToWallet.set(p.peer, p.address)
              }
            })
            rebuildLeaderboard()
            break

          case 'tip-added':
            if (evt.tip) {
              const key = myAddress || 'Local User'
              tipsSent.set(key, (tipsSent.get(key) || 0) + 1)
            }
            rebuildLeaderboard()
            break

          case 'tip-received':
            if (evt.tip) {
              const key = evt.tip.peerKey || 'Peer'
              tipsSent.set(key, (tipsSent.get(key) || 0) + 1)
            }
            rebuildLeaderboard()
            break

          case 'tips-list':
            tipsSent.clear();
            (evt.tips || []).forEach(t => {
              const key = t.peerKey || 'Peer'
              tipsSent.set(key, (tipsSent.get(key) || 0) + 1)
            })
            rebuildLeaderboard()
            break

          case 'pay-result':
            if (evt.amount) {
              const key = myAddress || 'Local User'
              const amt = parseFloat(evt.amount) || 0
              if (amt > 0) {
                usdtSent.set(key, (usdtSent.get(key) || 0) + amt)
              }
            }
            rebuildLeaderboard()
            break

          case 'payment-received':
            if (evt.from && evt.amount) {
              const amt = parseFloat(evt.amount) || 0
              if (amt > 0) {
                usdtSent.set(evt.from, (usdtSent.get(evt.from) || 0) + amt)
              }
            }
            rebuildLeaderboard()
            break

          case 'pay-compute-success':
            if (myAddress) {
              usdtSent.set(myAddress, (usdtSent.get(myAddress) || 0) + 0.01)
            }
            rebuildLeaderboard()
            break
        }
      } catch (err) {
        console.debug('[leaderboard] Event processing error:', err)
      }
    })

  } catch (err) {
    console.error('[leaderboard] initialization failed:', err)
  }
})()

// ─── Mock Match Mode (ADD-ONLY) ──────────────────────────────────────────────
;(function initMockMatchMode () {
  try {
    const startBtn = $('startDemoBtn')
    const stopBtn = $('stopDemoBtn')

    if (!startBtn || !stopBtn) {
      console.debug('[mock-match] DOM elements missing — Mock Match Mode disabled')
      return
    }

    let activeTimers = []

    const script = [
      { delay: 0,     label: "Match Update", location: "Stadium", message: "⚽ Kickoff! The match has officially started." },
      { delay: 8000,  label: "Match Update", location: "Stadium", message: "🔥 Goal! Team A scores an amazing opening goal! 1-0" },
      { delay: 18000, label: "Match Update", location: "Stadium", message: "⏳ Half-time whistle blows. Players heading to the tunnel." },
      { delay: 28000, label: "Match Update", location: "Stadium", message: "🏃 Second half begins. Team B looks hungry for an equalizer." },
      { delay: 38000, label: "Match Update", location: "Stadium", message: "🔥 Goal! Team B equalizes with a brilliant header! 1-1" },
      { delay: 48000, label: "Match Update", location: "Stadium", message: "🏁 Full-time! A thrilling 1-1 draw. What a match!" }
    ]

    function clearTimers () {
      activeTimers.forEach(t => clearTimeout(t))
      activeTimers = []
    }

    function stopDemo () {
      try {
        clearTimers()
        startBtn.textContent = 'Start Demo'
        startBtn.disabled = false
        stopBtn.hidden = true
        stopBtn.style.display = 'none'
        toast('ok', 'Demo Stopped', 'Mock match events cancelled')
      } catch (err) {
        console.error('[mock-match] stop error:', err)
      }
    }

    function startDemo () {
      try {
        clearTimers()
        startBtn.textContent = 'Demo Running…'
        startBtn.disabled = true
        stopBtn.hidden = false
        stopBtn.style.display = 'inline-flex'
        
        toast('ok', 'Demo Started', 'Scripted match events will broadcast')

        script.forEach(event => {
          const t = setTimeout(() => {
            try {
              // Send the tip using the existing API command.
              // This routes directly through the backend, broadcasts to the mesh,
              // and appears on all peers automatically!
              send('tip', {
                label: event.label,
                location: event.location,
                message: event.message
              })

              // If it's the final event, reset button state
              if (event.delay === script[script.length - 1].delay) {
                setTimeout(() => {
                  try {
                    startBtn.textContent = 'Start Demo'
                    startBtn.disabled = false
                    stopBtn.hidden = true
                    stopBtn.style.display = 'none'
                  } catch {}
                }, 2000)
              }
            } catch (err) {
              console.debug('[mock-match] Broadcast tick error:', err)
            }
          }, event.delay)
          
          activeTimers.push(t)
        })
      } catch (err) {
        console.error('[mock-match] start error:', err)
        stopDemo()
      }
    }

    startBtn.addEventListener('click', startDemo)
    stopBtn.addEventListener('click', stopDemo)

  } catch (err) {
    console.error('[mock-match] initialization failed:', err)
  }
})()

// ─── Session Export (ADD-ONLY) ───────────────────────────────────────────────
;(function initSessionExport () {
  try {
    const exportBtn = $('exportSessionBtn')
    if (!exportBtn) {
      console.debug('[export] DOM elements missing — Session Export disabled')
      return
    }

    exportBtn.addEventListener('click', async () => {
      try {
        const cards = document.querySelectorAll('#feedList .tip-card')
        if (cards.length === 0) {
          toast('warn', 'Feed is empty', 'Add some tips or start mock match first')
          return
        }

        const data = []
        cards.forEach(card => {
          const sender = card.querySelector('.tip-tag') ? card.querySelector('.tip-tag').textContent.trim() : ''
          const label = card.querySelector('.tip-label') ? card.querySelector('.tip-label').textContent.trim() : ''
          const location = card.querySelector('.tip-loc') ? card.querySelector('.tip-loc').textContent.trim().replace(/^·\s*/, '') : ''
          const message = card.querySelector('.tip-msg') ? card.querySelector('.tip-msg').textContent.trim() : ''
          const time = card.querySelector('.tip-time') ? card.querySelector('.tip-time').textContent.trim() : ''
          
          data.push({
            sender,
            label,
            location,
            message,
            time
          })
        })

        const content = JSON.stringify(data, null, 2)
        const result = await api.saveSessionFile(content, 'session-tips.json')
        
        if (result && result.ok) {
          toast('ok', 'Session exported', 'Saved to ' + short(result.path, 15, 10))
        } else if (result && result.error && result.error !== 'canceled') {
          toast('warn', 'Export failed', result.error)
        }
      } catch (err) {
        console.error('[export] click handler error:', err)
        toast('warn', 'Export failed', err.message)
      }
    })

  } catch (err) {
    console.error('[export] initialization failed:', err)
  }
})()

// ─── Match Pulse Live Relay (ADD-ONLY) ───────────────────────────────────────
;(function initMatchPulse () {
  try {
    const startBtn = $('startPulseBtn')
    const stopBtn = $('stopPulseBtn')
    const select = $('pulseTeamSelect')
    const statusText = $('pulseStatus')

    if (!startBtn || !stopBtn || !select || !statusText) {
      console.debug('[pulse] DOM elements missing — Match Pulse disabled')
      return
    }

    let activeTimers = []
    let pollInterval = null
    let relaying = false

    function clearRelay () {
      activeTimers.forEach(t => clearTimeout(t))
      activeTimers = []
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
      relaying = false
    }

    function stopRelay () {
      try {
        clearRelay()
        startBtn.textContent = 'Start Relay'
        startBtn.disabled = false
        select.disabled = false
        stopBtn.hidden = true
        stopBtn.style.display = 'none'
        statusText.textContent = 'Relay live sports API events to offline mesh'
        statusText.style.color = 'var(--muted)'
        toast('ok', 'Relay Stopped', 'Match Pulse live relay disconnected')
      } catch (err) {
        console.error('[pulse] stop error:', err)
      }
    }

    async function fetchMatchData (teamId) {
      const url = `https://www.thesportsdb.com/api/v1/json/3/eventslast.php?id=${teamId}`
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 6000)

      try {
        const response = await fetch(url, { signal: controller.signal })
        clearTimeout(timeoutId)
        if (!response.ok) throw new Error('API server returned status ' + response.status)
        const data = await response.json()
        return data
      } catch (err) {
        clearTimeout(timeoutId)
        throw err
      }
    }

    async function startRelay () {
      try {
        clearRelay()
        const teamId = select.value
        
        startBtn.textContent = 'Connecting…'
        startBtn.disabled = true
        select.disabled = true
        statusText.textContent = 'Connecting to sports API...'
        statusText.style.color = 'var(--accent)'

        let data
        try {
          data = await fetchMatchData(teamId)
        } catch (err) {
          console.error('[pulse] fetch error:', err)
          toast('warn', 'Match data unavailable (offline)', 'Falling back to offline Mock Match Mode')
          statusText.textContent = 'Match data unavailable — offline'
          statusText.style.color = 'var(--warn)'
          startBtn.textContent = 'Start Relay'
          startBtn.disabled = false
          select.disabled = false
          return
        }

        if (!data || !data.results || data.results.length === 0) {
          toast('warn', 'No match found', 'No recent matches for this team')
          stopRelay()
          return
        }

        const match = data.results[0]
        const homeTeam = match.strHomeTeam
        const awayTeam = match.strAwayTeam
        const homeScore = parseInt(match.intHomeScore) || 0
        const awayScore = parseInt(match.intAwayScore) || 0
        const league = match.strLeague || 'Football League'

        relaying = true
        startBtn.textContent = 'Relay Active'
        stopBtn.hidden = false
        stopBtn.style.display = 'inline-flex'
        statusText.textContent = 'This peer is online and relaying live match data to the offline mesh'
        statusText.style.color = 'var(--accent)'
        
        toast('ok', 'Relay Connected', `${homeTeam} vs ${awayTeam} live`)

        send('tip', {
          label: "Live Match",
          location: "Match Pulse",
          message: `📡 [Live Relay Connected] Relaying ${homeTeam} vs ${awayTeam} (${league}) live data to the offline mesh.`
        })

        let currentHome = 0
        let currentAway = 0
        let delay = 6000

        const tKick = setTimeout(() => {
          send('tip', {
            label: "Live Match",
            location: "Match Pulse",
            message: `⚽ [Live Relay] Kickoff! ${homeTeam} vs ${awayTeam} match is underway.`
          })
        }, 3000)
        activeTimers.push(tKick)

        for (let i = 0; i < homeScore; i++) {
          const tGoal = setTimeout(() => {
            currentHome++
            send('tip', {
              label: "Live Match",
              location: "Match Pulse",
              message: `🔥 [Live Relay] GOAL! ${homeTeam} scores! Current score: ${homeTeam} ${currentHome} - ${currentAway} ${awayTeam}`
            })
          }, delay)
          activeTimers.push(tGoal)
          delay += 10000
        }

        for (let i = 0; i < awayScore; i++) {
          const tGoal = setTimeout(() => {
            currentAway++
            send('tip', {
              label: "Live Match",
              location: "Match Pulse",
              message: `🔥 [Live Relay] GOAL! ${awayTeam} scores! Current score: ${homeTeam} ${currentHome} - ${currentAway} ${awayTeam}`
            })
          }, delay)
          activeTimers.push(tGoal)
          delay += 10000
        }

        const tEnd = setTimeout(() => {
          send('tip', {
            label: "Live Match",
            location: "Match Pulse",
            message: `🏁 [Live Relay] Full-time! Final score: ${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}. Relay complete.`
          })
          
          setTimeout(() => {
            if (relaying) stopRelay()
          }, 3000)
        }, delay)
        activeTimers.push(tEnd)

        pollInterval = setInterval(async () => {
          try {
            await fetchMatchData(teamId)
          } catch (err) {
            console.error('[pulse] background poll failed:', err)
            toast('warn', 'Relay connection lost', 'Match Pulse disconnected')
            statusText.textContent = 'Match data unavailable — connection lost'
            statusText.style.color = 'var(--warn)'
            stopRelay()
          }
        }, 15000)

      } catch (err) {
        console.error('[pulse] start relay error:', err)
        stopRelay()
      }
    }

    startBtn.addEventListener('click', startRelay)
    stopBtn.addEventListener('click', stopRelay)

  } catch (err) {
    console.error('[pulse] initialization failed:', err)
  }
})()

// ─── Feature 9: Scout Match Briefing (ADD-ONLY) ────────────────────────────────
// One-button spoken summary. Backend does all the work (lib.generateMatchBriefing,
// reusing the same Scout/Qwen pipeline as scout-analyze) — this just sends the
// command, waits for the correlated response, and renders it. "Read Aloud" reuses
// FullVoice via the same 'ninety:speak' hook it exposes below.
;(function initMatchBriefing () {
  try {
    const btn = $('generateBriefingBtn')
    const card = $('briefingCard')
    const metaEl = $('briefingMeta')
    const textEl = $('briefingText')
    const readAloudBtn = $('briefingReadAloudBtn')

    if (!btn || !card || !metaEl || !textEl || !readAloudBtn) {
      console.debug('[briefing] DOM elements missing — Match Briefing disabled')
      return
    }

    let activeBriefing = null
    let lastBriefingText = ''

    btn.addEventListener('click', () => {
      btn.disabled = true
      btn.textContent = 'Generating…'
      activeBriefing = send('generate-match-briefing')
    })

    readAloudBtn.addEventListener('click', () => {
      if (!lastBriefingText) return
      // Silent no-op if FullVoice never registered (speechSynthesis unavailable) —
      // the briefing text stays visible either way. Never fails.
      window.dispatchEvent(new CustomEvent('ninety:speak', { detail: lastBriefingText }))
    })

    api.onEvent((evt) => {
      try {
        if (evt.ev === 'match-briefing' && evt.id === activeBriefing) {
          btn.disabled = false
          btn.textContent = 'Generate Match Briefing'
          lastBriefingText = evt.briefing || ''
          textEl.textContent = lastBriefingText || 'No live stadium information available right now.'
          const time = new Date(evt.generatedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          metaEl.textContent = `${time} · ${evt.sourceCount || 0} source${evt.sourceCount === 1 ? '' : 's'}`
          card.hidden = false
        }
        if (evt.ev === 'error' && evt.id === activeBriefing) {
          btn.disabled = false
          btn.textContent = 'Generate Match Briefing'
          toast('warn', 'Briefing failed', evt.message || 'could not generate briefing')
        }
      } catch (err) {
        console.debug('[briefing] event handling error:', err)
      }
    })
  } catch (err) {
    console.error('[briefing] initialization failed:', err)
  }
})()

// ─── Feature 10: On-chain Proof Panel (ADD-ONLY) ───────────────────────────────
// Renders blockchain activity that already exists (escrow tx hashes returned by
// existing wallet.js calls). Fetches 'chain-info' once when the tab is first
// opened (see the tab-click handler above) then only updates live via
// 'tx-recorded' push events emitted right after each existing escrow call
// resolves — this panel never polls.
;(function initOnchainProof () {
  try {
    const networkEl = $('onchainNetwork')
    const walletAddrEl = $('onchainWalletAddr')
    const reuniteAddrEl = $('onchainReuniteAddr')
    const computeAddrEl = $('onchainComputeAddr')
    const testsEl = $('onchainTestsPassing')
    const gasOptEl = $('onchainGasOptimized')
    const sizeEl = $('onchainDeploySize')
    const gasEl = $('onchainDeployGas')
    const txList = $('onchainTxList')
    const txEmpty = $('onchainTxEmpty')

    if (!networkEl || !walletAddrEl || !reuniteAddrEl || !computeAddrEl || !txList) {
      console.debug('[onchain] DOM elements missing — On-chain Proof panel disabled')
      return
    }

    function setAddrLink (el, info) {
      if (!info || !info.address) { el.textContent = '—'; el.removeAttribute('href'); return }
      el.textContent = short(info.address, 8, 6)
      el.href = info.explorerUrl || '#'
    }

    function txRow (tx) {
      const row = document.createElement('div')
      row.className = 'out-block onchain-tx-row'
      row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 10px;'
      const time = new Date(tx.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      row.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span style="font-size: 12px; color: var(--text); font-weight: 600;">${esc(tx.type || 'Unknown')}</span>
          <a href="${esc(tx.explorerUrl || '#')}" target="_blank" rel="noopener" class="mono" style="font-size: 11px; color: var(--accent);">${esc(short(tx.hash, 10, 8))}</a>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
          <span style="font-size: 11px; color: var(--muted);">${esc(time)}</span>
          <span style="font-size: 10px; color: var(--muted); text-transform: uppercase;">${esc(tx.status || 'confirmed')}</span>
        </div>
      `
      return row
    }

    function prependTx (tx) {
      if (txEmpty) txEmpty.hidden = true
      txList.insertBefore(txRow(tx), txList.firstChild)
      const rows = txList.querySelectorAll('.onchain-tx-row')
      if (rows.length > 20) rows[rows.length - 1].remove()
    }

    function renderChainInfo (evt) {
      networkEl.textContent = evt.network ? `${evt.network.name} (chain ${evt.network.chainId})` : '—'
      setAddrLink(walletAddrEl, evt.wallet)
      setAddrLink(reuniteAddrEl, evt.reuniteEscrow)
      setAddrLink(computeAddrEl, evt.computeEscrow)

      const f = evt.foundry || {}
      testsEl.textContent = f.testsPassing || '—'
      gasOptEl.textContent = f.gasOptimized == null ? '—' : (f.gasOptimized ? 'Yes' : 'No')
      sizeEl.textContent = f.deploymentSizeBytes != null ? `${f.deploymentSizeBytes.toLocaleString()} bytes` : '—'
      gasEl.textContent = f.deploymentGas != null ? f.deploymentGas.toLocaleString() : '—'

      txList.querySelectorAll('.onchain-tx-row').forEach(n => n.remove())
      const history = evt.history || []
      if (history.length === 0) {
        if (txEmpty) txEmpty.hidden = false
      } else {
        if (txEmpty) txEmpty.hidden = true
        for (const tx of history) txList.appendChild(txRow(tx))
      }
    }

    api.onEvent((evt) => {
      try {
        if (evt.ev === 'chain-info') renderChainInfo(evt)
        if (evt.ev === 'tx-recorded' && evt.tx) prependTx(evt.tx)
      } catch (err) {
        console.debug('[onchain] event handling error:', err)
      }
    })
  } catch (err) {
    console.error('[onchain] initialization failed:', err)
  }
})()






