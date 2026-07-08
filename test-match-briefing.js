// test-match-briefing.js — Feature 9 (Scout Match Briefing) tests.
// Run with: bare test-match-briefing.js
//
// generateMatchBriefing() reuses the exact same customSdk injection pattern as
// scoutAnalyze() in lib/scout.js (see test.js) — no new mocking approach needed.
//
// TTS ("Read Aloud") is pure browser Web Speech API code living in the renderer
// (no DOM/Electron test harness exists anywhere in this repo — test.js and
// test-compute-escrow.js are both bare-runtime-only, backend-side tests). What
// IS testable here, and is tested below, is the actual contract that guarantees
// "TTS unavailable never blocks the text": generateMatchBriefing() has zero
// dependency on any TTS/speech API — the briefing text is produced and returned
// the same way whether or not a renderer ever calls the (separate, decoupled)
// 'ninety:speak' event. The DOM-level behavior (button always renders text,
// Read Aloud is a no-op when speechSynthesis is undefined) is covered in the
// Manual QA checklist instead.

import { buildBriefingHistory, generateMatchBriefing } from './lib/scout.js'
import process from 'bare-process'

function assert (condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function assertEq (actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const mockSdk = {
  completion: () => ({ final: Promise.resolve({ contentText: mockSdk.mockResponseText }) }),
  mockResponseText: ''
}

function wordCount (text) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

async function runTests () {
  console.log('=== Running Feature 9 (Scout Match Briefing) Tests ===')

  // 1. Empty data — briefing still makes sense, no invented facts.
  console.log('Testing empty data...')
  mockSdk.mockResponseText = '{"briefing": "All quiet around the stadium right now — no active alerts or notable updates."}'
  const r1 = await generateMatchBriefing({ tips: [], reuniteAlerts: [], lastRead: null }, mockSdk)
  assertEq(r1.sourceCount, 0)
  assert(r1.briefing.length > 0, 'Briefing should still be non-empty with no data')
  assert(!/no information available/i.test(r1.briefing), 'Should not literally say "no information available"')

  // 2. Only tips.
  console.log('Testing only tips...')
  const foodTips = [
    { id: 't1', category: 'food', urgency: 'low', sentiment: 'positive', location: 'Gate 3', message: 'Burgers at stall 12 are great and no queue' },
    { id: 't2', category: 'queue', urgency: 'medium', sentiment: 'negative', location: 'Gate 5', message: 'Long queue at the north entrance' }
  ]
  mockSdk.mockResponseText = '{"briefing": "Grab burgers at stall 12 near Gate 3 — short queue. Avoid the north entrance at Gate 5, queues are long there."}'
  const r2 = await generateMatchBriefing({ tips: foodTips, reuniteAlerts: [], lastRead: null }, mockSdk)
  assertEq(r2.sourceCount, 2)
  assert(r2.briefing.includes('stall 12') || r2.briefing.length > 0)

  // 3. Only Match Pulse (Match Pulse ships as tagged tips with location "Match Pulse" — Feature 4/backend reuse).
  console.log('Testing only Match Pulse (tips tagged "Match Pulse")...')
  const pulseTips = [
    { id: 'p1', category: 'other', urgency: 'low', sentiment: 'positive', location: 'Match Pulse', message: '⚽ [Live Relay] GOAL! Arsenal scores! Current score: Arsenal 1 - 0 Chelsea' }
  ]
  mockSdk.mockResponseText = '{"briefing": "Arsenal lead Chelsea 1-0 after a goal moments ago."}'
  const r3 = await generateMatchBriefing({ tips: pulseTips, reuniteAlerts: [], lastRead: null }, mockSdk)
  assertEq(r3.sourceCount, 1)
  assert(r3.briefing.includes('1-0') || r3.briefing.length > 0)
  const history3 = buildBriefingHistory({ tips: pulseTips, reuniteAlerts: [], lastRead: null })
  assert(history3[1].content.includes('Match Pulse'), 'Prompt should surface the Match Pulse tip')

  // 4. Reunite only.
  console.log('Testing Reunite alerts only...')
  const alerts = [{ id: 'a1', name: 'Sam, age 8', detail: 'Last seen near Gate 2, wearing a blue jersey' }]
  mockSdk.mockResponseText = '{"briefing": "Reunite alert: Sam, age 8, last seen near Gate 2 in a blue jersey. If seen, please alert stadium staff."}'
  const r4 = await generateMatchBriefing({ tips: [], reuniteAlerts: alerts, lastRead: null }, mockSdk)
  assertEq(r4.sourceCount, 1)
  assert(r4.briefing.toLowerCase().includes('sam'))

  // 5. Mixed data (tips + pulse + reunite + sign reading).
  console.log('Testing mixed data...')
  mockSdk.mockResponseText = '{"briefing": "Safety first: Sam, age 8, missing near Gate 2. Arsenal lead 1-0. Burgers at stall 12 near Gate 3, but avoid the Gate 5 queue."}'
  const r5 = await generateMatchBriefing({
    tips: [...foodTips, ...pulseTips],
    reuniteAlerts: alerts,
    lastRead: { original: 'GATE 3', translation: 'Gate 3' }
  }, mockSdk)
  assertEq(r5.sourceCount, foodTips.length + pulseTips.length + alerts.length + 1)
  assert(r5.briefing.length > 0)

  // 6. Malformed model output — fallback extraction, never throws.
  console.log('Testing malformed model output (broken JSON)...')
  mockSdk.mockResponseText = '{"briefing": "Cut off mid-sente'
  const r6 = await generateMatchBriefing({ tips: foodTips, reuniteAlerts: [], lastRead: null }, mockSdk)
  assert(typeof r6.briefing === 'string' && r6.briefing.length > 0, 'Malformed JSON must still yield a usable briefing string')

  // 6b. Malformed: completely non-JSON, non-prose garbage.
  console.log('Testing malformed model output (garbage, no braces)...')
  mockSdk.mockResponseText = ''
  const r6b = await generateMatchBriefing({ tips: [], reuniteAlerts: [], lastRead: null }, mockSdk)
  assert(typeof r6b.briefing === 'string' && r6b.briefing.length > 0, 'Empty model output must still yield a fallback string, never throw')

  // 6c. Malformed: model ignored JSON instruction, returned plain prose.
  console.log('Testing malformed model output (plain prose, not JSON)...')
  mockSdk.mockResponseText = 'Everything is calm around the stadium tonight.'
  const r6c = await generateMatchBriefing({ tips: [], reuniteAlerts: [], lastRead: null }, mockSdk)
  assertEq(r6c.briefing, 'Everything is calm around the stadium tonight.')

  // 7. Length safety net — model ignores the word-count instruction.
  console.log('Testing briefing length enforcement (model runs long)...')
  const longSentence = 'This is a filler sentence used only to pad the briefing well past the spoken limit for this test case.'
  mockSdk.mockResponseText = JSON.stringify({ briefing: Array(20).fill(longSentence).join(' ') })
  const r7 = await generateMatchBriefing({ tips: foodTips, reuniteAlerts: [], lastRead: null }, mockSdk)
  assert(wordCount(r7.briefing) <= 131, `Briefing must be trimmed to a spoken-length budget, got ${wordCount(r7.briefing)} words`)

  // 8. "TTS unavailable" contract: generation has zero dependency on any speech API.
  console.log('Testing briefing generation has no TTS dependency (TTS-unavailable safe by construction)...')
  assert(typeof globalThis.speechSynthesis === 'undefined', 'Sanity check: bare runtime has no speechSynthesis, matching a TTS-unavailable environment')
  mockSdk.mockResponseText = '{"briefing": "Quiet night, nothing to report."}'
  const r8 = await generateMatchBriefing({ tips: [], reuniteAlerts: [], lastRead: null }, mockSdk)
  assert(typeof r8.briefing === 'string' && r8.briefing.length > 0, 'Briefing generation must succeed with no speech API present at all')

  console.log('\nAll Feature 9 (Scout Match Briefing) tests PASSED successfully!')
  process.exit(0)
}

runTests().catch(err => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
