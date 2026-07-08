// lib/qvac.js — QVAC OCR + Translation (runs fully offline on-device)
//
// Uses:
//   - GGML OCR plugin for text detection + recognition
//   - NMT Bergamot plugin for neural machine translation
//
// Both models are downloaded once on first use, then cached for offline operation.
// No cloud API calls ever happen — everything runs on the local device.

import {
  plugins, OCR_LATIN, WHISPER_TINY_Q8_0,
  BERGAMOT_EN_ES, BERGAMOT_ES_EN, BERGAMOT_FR_EN, BERGAMOT_EN_FR,
  BERGAMOT_DE_EN, BERGAMOT_EN_DE, BERGAMOT_IT_EN, BERGAMOT_EN_IT,
  BERGAMOT_PT_EN, BERGAMOT_EN_PT, BERGAMOT_NL_EN, BERGAMOT_EN_NL,
  BERGAMOT_RU_EN, BERGAMOT_EN_RU, BERGAMOT_JA_EN, BERGAMOT_EN_JA,
  BERGAMOT_KO_EN, BERGAMOT_EN_KO, BERGAMOT_ZH_EN, BERGAMOT_EN_ZH,
  QWEN3_600M_INST_Q4
} from '@qvac/sdk'
import { ocrPlugin } from '@qvac/sdk/ggml-ocr/plugin'
import { nmtPlugin } from '@qvac/sdk/nmtcpp-translation/plugin'
import { whisperPlugin } from '@qvac/sdk/whispercpp-transcription/plugin'
import { llmPlugin } from '@qvac/sdk/llamacpp-completion/plugin'

// Register plugins and get the SDK API (Bare runs in-process, nothing auto-registers)
const sdk = plugins([ocrPlugin, nmtPlugin, whisperPlugin, llmPlugin])

// ─── Model IDs (populated on init) ───────────────────────────────────────────
let ocrModelId = null
let nmtModelId = null
let whisperModelId = null
let llmModelId = null
let llmLoadingPromise = null

export function getSdk () {
  return sdk
}

export async function getLlmModelId () {
  if (llmModelId) return llmModelId
  if (llmLoadingPromise) return await llmLoadingPromise
  return null
}

// ─── Bergamot model map ──────────────────────────────────────────────────────
const BERGAMOT_MODELS = {
  'en-es': BERGAMOT_EN_ES, 'es-en': BERGAMOT_ES_EN,
  'en-fr': BERGAMOT_EN_FR, 'fr-en': BERGAMOT_FR_EN,
  'en-de': BERGAMOT_EN_DE, 'de-en': BERGAMOT_DE_EN,
  'en-it': BERGAMOT_EN_IT, 'it-en': BERGAMOT_IT_EN,
  'en-pt': BERGAMOT_EN_PT, 'pt-en': BERGAMOT_PT_EN,
  'en-nl': BERGAMOT_EN_NL, 'nl-en': BERGAMOT_NL_EN,
  'en-ru': BERGAMOT_EN_RU, 'ru-en': BERGAMOT_RU_EN,
  'en-ja': BERGAMOT_EN_JA, 'ja-en': BERGAMOT_JA_EN,
  'en-ko': BERGAMOT_EN_KO, 'ko-en': BERGAMOT_KO_EN,
  'en-zh': BERGAMOT_EN_ZH, 'zh-en': BERGAMOT_ZH_EN
}

/**
 * Initialise both QVAC models. Call once at startup.
 * Downloads ~50MB on first run, instant from cache afterwards.
 */
export async function initQvac () {
  console.log('[qvac] Loading OCR model (first run downloads ~20MB)...')
  ocrModelId = await sdk.loadModel({
    modelSrc: OCR_LATIN,
    modelConfig: {
      langList: ['en'],
      magRatio: 1.5,
      defaultRotationAngles: [90, 180, 270],
      contrastRetry: false,
      lowConfidenceThreshold: 0.5,
      recognizerBatchSize: 1
    }
  })
  console.log('[qvac] OCR model ready:', ocrModelId)

  console.log('[qvac] Loading translation model (Bergamot EN->ES, first run downloads ~30MB)...')
  nmtModelId = await sdk.loadModel({
    modelSrc: BERGAMOT_EN_ES,
    modelConfig: {
      engine: 'Bergamot',
      from: 'en',
      to: 'es'
    }
  })
  console.log('[qvac] Translation model ready:', nmtModelId)

  console.log('[qvac] Loading speech-to-text model (WHISPER_TINY_Q8_0)...')
  whisperModelId = await sdk.loadModel({
    modelSrc: WHISPER_TINY_Q8_0,
    modelConfig: { language: 'en' }
  })
  console.log('[qvac] Whisper model ready:', whisperModelId)

  // Asynchronously trigger loading of Qwen 600M LLM model (do not block startup)
  console.log('[qvac] Triggering async load for Qwen LLM model (downloads ~380MB on first use)...')
  llmLoadingPromise = (async () => {
    try {
      const modelId = await sdk.loadModel({
        modelSrc: QWEN3_600M_INST_Q4
      })
      llmModelId = modelId
      console.log('[qvac] Qwen LLM model load complete:', llmModelId)
      return modelId
    } catch (err) {
      console.log('[qvac] Qwen LLM model load failed:', err.message)
      throw err
    }
  })()
}

/**
 * Set the target language for translation.
 * @param {string} from - Source language code (e.g. 'en', 'es')
 * @param {string} to   - Target language code (e.g. 'es', 'en')
 *
 * ROOT-CAUSE FIX (translation model lifecycle):
 *   Previously, if unloadModel() threw (e.g. "Failed to unload model <id>"),
 *   the function exited early and nmtModelId kept its OLD value — which now
 *   pointed to a partially-unloaded / invalid model. The next translateText()
 *   call would then fail with "Model with ID <id> not found", cascading the
 *   error across the entire pipeline (OCR succeeded, translation broke).
 *
 *   Fix: null-out nmtModelId BEFORE attempting any SDK operation, and wrap
 *   unloadModel() in try/catch so a failure cannot block loading the new
 *   model. If loadModel() also fails, nmtModelId stays null and translateText()
 *   gives an explicit "not loaded" error instead of a stale-ID error.
 */
export async function setTranslationLang (from, to) {
  const key = `${from}-${to}`
  const modelSrc = BERGAMOT_MODELS[key]
  if (!modelSrc) {
    throw new Error(`No Bergamot model for ${from}->${to}. Supported: ${Object.keys(BERGAMOT_MODELS).join(', ')}`)
  }

  console.log(`[translator] Requested pair: ${from} -> ${to}`)
  console.log(`[translator] Current model ID: ${nmtModelId}`)

  // Step 1 — save and immediately discard the old reference so translateText()
  // can never see a stale model ID, even if unload or load throws.
  const oldModelId = nmtModelId
  nmtModelId = null

  // Step 2 — try to unload the old model. Failure is non-fatal: we cannot let
  // an unload error cascade into blocking the new model load.
  if (oldModelId) {
    try {
      await sdk.unloadModel({ modelId: oldModelId, clearStorage: false })
      console.log(`[translator] Unload result: success (old model: ${oldModelId})`)
    } catch (err) {
      // unloadModel can fail if the SDK has already invalidated the model ID
      // or an internal error occurred. The old reference is already nulled
      // above, so translate() will never see a stale ID.
      console.log(`[translator] Unload result: FAILED - ${err && err.message ? err.message : String(err)} (old model: ${oldModelId})`)
    }
  }

  // Step 3 — load the new model. If this throws, nmtModelId stays null and
  // translateText() gives an explicit "not loaded" error.
  console.log(`[translator] Loading new model for ${from} -> ${to}...`)
  nmtModelId = await sdk.loadModel({
    modelSrc,
    modelConfig: { engine: 'Bergamot', from, to }
  })
  console.log(`[translator] Loaded model ID: ${nmtModelId}`)
}

/**
 * Run OCR on an image (file path or Buffer).
 * Returns extracted text blocks with optional bounding boxes.
 */
export async function readSign (imageInput) {
  if (!ocrModelId) throw new Error('[qvac] OCR model not loaded - call initQvac() first')

  console.log('[qvac] Running OCR on image...')
  const { blocks } = sdk.ocr({
    modelId: ocrModelId,
    image: imageInput,
    options: { paragraph: false }
  })

  const results = await blocks
  const fullText = results.map(b => b.text).join(' ')
  console.log('[qvac] OCR result:', fullText)

  return {
    text: fullText,
    blocks: results.map(b => ({
      text: b.text,
      bbox: b.bbox,
      confidence: b.confidence
    }))
  }
}

/**
 * Strip language-control tokens that the Bergamot/Marian NMT engine inserts
 * into its output (e.g. ">>por<<Olá?" → "Olá?"). These are ISO-639-3 language
 * tags that signal the target language to the decoder but are not part of the
 * translated content and must not reach the user.
 *
 * Patterns removed (always at the start of the string):
 *   - >>xxx<<   (3-letter lang code with double brackets, e.g. >>por<<)
 *   - >>xxx<    (3-letter lang code with mismatched brackets, e.g. >>por<)
 *   - <2xx>     (tokenizer control token, e.g. <2pt>, <2es>)
 *
 * We remove ONLY these known control-token patterns. Legitimate angle
 * brackets in the translated text (e.g. "x < y" or HTML entities) are
 * preserved because the patterns are anchored to the start of the string
 * and use a strict letter-only code format.
 */
function cleanTranslationText (raw) {
  if (!raw) return raw
  let cleaned = raw
  // >>xxx<< or >>xxx<  — Bergamot language tag (3-letter ISO 639-3 code)
  cleaned = cleaned.replace(/^>>[a-z]{2,3}<{1,2}/, '')
  // <2xx> — tokenizer control token
  cleaned = cleaned.replace(/^<2[a-z]{2}>/, '')
  return cleaned
}

/**
 * Translate text using the locally-loaded Bergamot NMT model.
 * Fully offline — no network call.
 */
export async function translateText (text) {
  if (!nmtModelId) throw new Error('[qvac] Translation model not loaded - call initQvac() first')

  console.log(`[translator] Translate model ID: ${nmtModelId}`)
  console.log(`[qvac] Translating: "${text.substring(0, 50)}..."`)
  const result = sdk.translate({
    modelId: nmtModelId,
    text,
    modelType: 'nmtcpp-translation',
    stream: false
  })

  const translatedRaw = await result.text
  const translated = cleanTranslationText(translatedRaw)
  if (translated !== translatedRaw) {
    console.log(`[translator] Raw translation: ${JSON.stringify(translatedRaw)}`)
    console.log(`[translator] Cleaned translation: ${JSON.stringify(translated)}`)
  }
  console.log('[qvac] Translation result:', translated)
  return translated
}

/**
 * Transcribe audio using the locally-loaded Whisper model.
 * Fully offline — no network call.
 * @param {string} audioBase64 - Base64-encoded audio data
 * @param {number|string} [recNum] - Recording counter for correlating logs
 */
export async function transcribeAudio (audioBase64, recNum) {
  recNum = recNum || '?'
  console.log(`========== QVAC RECORDING #${recNum} ==========`)
  
  if (!whisperModelId) throw new Error(`[qvac] Recording #${recNum}: Whisper model not loaded - call initQvac() first`)

  // The @qvac/sdk client expects `audioChunk` to be EITHER a filePath STRING or a
  // raw-bytes Buffer — NOT a { type, value } object. Passing the object made the
  // client run `({type,value}).toString('base64')` → the literal "[object Object]",
  // which the server then base64-decodes → "Invalid input" thrown async → the SDK's
  // own Bare.on('unhandledRejection') handler calls Bare.exit(1), killing the whole
  // in-process backend. We write the audio to a temp file and pass its PATH (string),
  // which routes through the SDK's FFmpeg decoder (it content-probes the container,
  // so browser WebM/Opus decodes fine) to the PCM whisper.cpp expects.
  const bfs = (await import('bare-fs')).default
  const bpath = (await import('bare-path')).default
  const bos = (await import('bare-os')).default
  const tmpDir = (bos.tmpdir && bos.tmpdir()) || process.env.TEMP || process.env.TMP || '.'

  // Sweep stale temp files from previous calls. We deliberately do NOT delete the
  // current request's file inline: the SDK's transcription pipeline opens the audio
  // file more than once and can access it AFTER the transcribe promise resolves.
  // Deleting it eagerly triggered an async AUDIO_FILE_NOT_FOUND deep in the SDK, which — being
  // unhandled — hit the SDK's own Bare.on('unhandledRejection') → Bare.exit(1) and
  // killed the whole in-process backend. Sweeping old files (older than 2 min) on the
  // next call bounds disk usage without racing the SDK's async lifecycle.
  try {
    const now = Date.now()
    for (const name of bfs.readdirSync(tmpDir)) {
      if (!name.startsWith('ninety-voice-')) continue
      const p = bpath.join(tmpDir, name)
      try { if (now - bfs.statSync(p).mtimeMs > 120000) bfs.unlinkSync(p) } catch {}
    }
  } catch {}

  // `.wav` extension puts it in the SDK's FORMATS_NEEDING_DECODE list so the audio
  // is decoded (not read as raw PCM); ffmpeg probes the real bytes, so the actual
  // container (WebM/Opus from MediaRecorder) is what matters, not the name.
  //
  // BUT: if the raw bytes from the browser are NOT a valid audio container that
  // the SDK's bundled FFmpeg can decode, whisper.cpp receives silence or garbage.
  const tmpFile = bpath.join(tmpDir, `ninety-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
  bfs.writeFileSync(tmpFile, Buffer.from(audioBase64, 'base64'))
  
  // ── File diagnostics ──
  console.log(`[qvac] Recording #${recNum}: === STAGE: File Writing ===`)
  console.log(`[qvac] Recording #${recNum}: Audio written to: ${tmpFile}`)
  let fileSize = 0
  try { fileSize = bfs.statSync(tmpFile).size } catch {}
  console.log(`[qvac] Recording #${recNum}: File exists: ${fileSize > 0 ? 'YES' : 'NO'}`)
  console.log(`[qvac] Recording #${recNum}: File size: ${fileSize} bytes`)
  console.log(`[qvac] Recording #${recNum}: Audio input base64 length: ${audioBase64.length} chars`)
  
  // Read first 16 bytes to show the file signature (magic bytes) for format identification
  try {
    const fd = bfs.openSync(tmpFile, 'r')
    const magicBuf = Buffer.alloc(16)
    bfs.readSync(fd, magicBuf, 0, 16, 0)
    bfs.closeSync(fd)
    const hex = magicBuf.toString('hex')
    const ascii = magicBuf.toString('utf8').replace(/[^\x20-\x7e]/g, '.')
    console.log(`[qvac] Recording #${recNum}: File magic bytes (hex): ${hex}`)
    console.log(`[qvac] Recording #${recNum}: File magic bytes (ascii): ${ascii}`)
    // WebM starts with 1a 45 df a3 (EBML header), WAV starts with RIFF, Ogg starts with OggS
    if (hex.startsWith('1a45dfa3')) console.log(`[qvac] Recording #${recNum}: File format: WebM/Matroska`)
    else if (hex.startsWith('52494646')) console.log(`[qvac] Recording #${recNum}: File format: RIFF (WAV/AVI)`)
    else if (hex.startsWith('4f676753')) console.log(`[qvac] Recording #${recNum}: File format: Ogg`)
    else console.log(`[qvac] Recording #${recNum}: File format: UNKNOWN (may not be decodable)`)
  } catch (err) {
    console.log(`[qvac] Recording #${recNum}: Could not read magic bytes: ${err.message}`)
  }
  // ── End file diagnostics ──

  console.log(`[qvac] Recording #${recNum}: === STAGE: Audio Conversion (Whisper/FFmpeg) ===`)
  console.log(`[qvac] Recording #${recNum}: Running speech-to-text on audio (filePath): ${tmpFile}`)
  // sdk.transcribe() returns a decorated Promise<string> (the transcript text with
  // a `requestId` prop) — NOT an object with a `.text` field. Awaiting `result.text`
  // yields undefined; await the promise itself.
  const result = sdk.transcribe({
    modelId: whisperModelId,
    audioChunk: tmpFile   // filePath STRING — correct client API shape
  })
  let transcribed
  try {
    transcribed = (await result) || ''
    console.log(`[qvac] Recording #${recNum}: === STAGE: Transcription Result ===`)
    console.log(`[qvac] Recording #${recNum}: Raw transcription: ${JSON.stringify(transcribed)}`)
  } catch (err) {
    console.log(`[qvac] Recording #${recNum}: SDK transcribe() THREW: ${err.message}`)
    console.log(`[qvac] Recording #${recNum}: SDK error stack: ${err.stack}`)
    throw err  // Do NOT suppress — let the caller handle it
  }

  // whisper.cpp emits blank-audio markers and a small set of well-known
  // hallucinations when fed silence/non-speech (a held-but-silent mic release).
  // Treat those as empty so the caller reports "No speech detected" instead of
  // surfacing "you." / "Thank you." Only whole-output matches are filtered, so a
  // genuine spoken sentence is never touched.
  const norm = transcribed.trim().toLowerCase().replace(/[.!?¡¿]+$/g, '').trim()
  const SILENCE_HALLUCINATIONS = new Set([
    '', 'you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
    'thank you for watching', 'bye', 'bye.', '[blank_audio]', '[silence]', '(silence)'
  ])
  if (SILENCE_HALLUCINATIONS.has(norm) || /^\[.*\]$/.test(norm)) {
    console.log('[qvac] Filtered whisper silence-hallucination -> treating as no speech')
    return ''
  }
  return transcribed
}

/**
 * Convenience: OCR + translate in one call.
 * Reads a sign image, returns original + translated text.
 */
export async function readAndTranslate (imageInput) {
  const ocrResult = await readSign(imageInput)
  const translation = await translateText(ocrResult.text)
  return {
    original: ocrResult.text,
    translation,
    blocks: ocrResult.blocks
  }
}

/**
 * Cleanup: unload all models to free memory.
 */
export async function shutdownQvac () {
  if (ocrModelId) {
    await sdk.unloadModel({ modelId: ocrModelId, clearStorage: false })
    ocrModelId = null
  }
  if (nmtModelId) {
    try {
      await sdk.unloadModel({ modelId: nmtModelId, clearStorage: false })
    } catch (err) {
      console.log(`[translator] Shutdown unload failed (non-fatal): ${err && err.message ? err.message : String(err)}`)
    }
    nmtModelId = null
  }
  if (whisperModelId) {
    await sdk.unloadModel({ modelId: whisperModelId, clearStorage: false })
    whisperModelId = null
  }
  if (llmModelId) {
    try {
      await sdk.unloadModel({ modelId: llmModelId, clearStorage: false })
    } catch {}
    llmModelId = null
  }
  console.log('[qvac] All models unloaded.')
}
