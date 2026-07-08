import { selectTips, buildHistory, scoutAnalyze, tagTipText, queueTip, delegateScout, isValidScoutResult } from './lib/scout.js'
import process from 'bare-process'
import b4a from 'b4a'

function assert (condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function assertEq (actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const mockSdk = {
  completion: (params) => {
    return {
      final: Promise.resolve({
        contentText: mockSdk.mockResponseText
      })
    }
  },
  mockResponseText: ''
}

async function runTests () {
  console.log('=== Running Scout Unit Tests ===')

  // 1. Tip selection
  console.log('Testing selectTips...')
  const rawTips = [
    'long queue',
    { location: 'Gate 5', message: 'better burgers' },
    { location: '', message: '   ' }, // should be ignored
    null
  ]
  const selected = selectTips(rawTips)
  assertEq(selected.length, 2)
  assertEq(selected[0].location, 'nearby')
  assertEq(selected[0].message, 'long queue')
  assertEq(selected[1].location, 'Gate 5')
  assertEq(selected[1].message, 'better burgers')

  // 2. Prompt history generation
  console.log('Testing buildHistory...')
  const history = buildHistory('Gate 3', 'Puerta 3', selected, 'es')
  assertEq(history.length, 2)
  assertEq(history[0].role, 'system')
  assertEq(history[1].role, 'user')
  assert(history[0].content.includes('JSON'), 'System prompt should require JSON')
  assert(history[1].content.includes('Puerta 3'), 'User prompt should contain translation')
  assert(history[1].content.includes('better burgers'), 'User prompt should contain tips')

  // 3. Valid JSON parsing
  console.log('Testing scoutAnalyze with valid JSON...')
  mockSdk.mockResponseText = '{"recommendation": "Go to Gate 5 for burgers.", "confidence": "high", "sourceCount": 2}'
  const result1 = await scoutAnalyze({
    ocrText: 'Gate 3',
    translatedText: 'Puerta 3',
    nearbyTips: rawTips,
    language: 'es'
  }, mockSdk)
  assertEq(result1.recommendation, 'Go to Gate 5 for burgers.')
  assertEq(result1.confidence, 'high')
  assertEq(result1.sourceCount, 2)

  // 4. Malformed model output / missing fields
  console.log('Testing scoutAnalyze with partial JSON...')
  mockSdk.mockResponseText = '{"recommendation": "Avoid Gate 3."}'
  const result2 = await scoutAnalyze({
    ocrText: 'Gate 3',
    translatedText: 'Puerta 3',
    nearbyTips: rawTips
  }, mockSdk)
  assertEq(result2.recommendation, 'Avoid Gate 3.')
  assertEq(result2.confidence, 'medium') // fallback
  assertEq(result2.sourceCount, 2) // fallback from tips length

  // 5. Non-JSON raw text fallback
  console.log('Testing scoutAnalyze with raw text fallback...')
  mockSdk.mockResponseText = 'Skip this place, too expensive.'
  const result3 = await scoutAnalyze({
    ocrText: 'Gate 3',
    translatedText: 'Puerta 3',
    nearbyTips: rawTips
  }, mockSdk)
  assertEq(result3.recommendation, 'Skip this place, too expensive.')
  assertEq(result3.confidence, 'medium')
  assertEq(result3.sourceCount, 2)

  // 6. Empty tip handling
  console.log('Testing scoutAnalyze with empty tips...')
  mockSdk.mockResponseText = 'No useful tips available.'
  const result4 = await scoutAnalyze({
    ocrText: 'Gate 3',
    translatedText: 'Puerta 3',
    nearbyTips: []
  }, mockSdk)
  assertEq(result4.recommendation, 'No useful tips available.')
  assertEq(result4.sourceCount, 0)

  // 7. Tagging valid JSON
  console.log('Testing tagTipText with valid JSON...')
  mockSdk.mockResponseText = '{"category":"food", "urgency":"low", "sentiment":"positive", "confidence":"high"}'
  const tag1 = await tagTipText('Burgers are great here!', mockSdk)
  assertEq(tag1.category, 'food')
  assertEq(tag1.urgency, 'low')
  assertEq(tag1.sentiment, 'positive')
  assertEq(tag1.confidence, 'high')

  // 8. Tagging malformed JSON
  console.log('Testing tagTipText with malformed JSON...')
  mockSdk.mockResponseText = '{"category":"food", "urgency":'
  const tag2 = await tagTipText('Burgers are great here!', mockSdk)
  assertEq(tag2.category, 'food') // extracted via field pattern from partial JSON
  assertEq(tag2.urgency, 'low')

  // 9. Tagging with invalid category
  console.log('Testing tagTipText with invalid category...')
  mockSdk.mockResponseText = '{"category":"drinks", "urgency":"low", "sentiment":"positive", "confidence":"high"}'
  const tag3 = await tagTipText('Burgers are great here!', mockSdk)
  assertEq(tag3.category, 'other') // fallback
  assertEq(tag3.urgency, 'low')

  // 10. Tagging with invalid urgency — keyword fallback maps "critical" to high
  console.log('Testing tagTipText with invalid urgency...')
  mockSdk.mockResponseText = '{"category":"food", "urgency":"critical", "sentiment":"positive", "confidence":"high"}'
  const tag4 = await tagTipText('Burgers are great here!', mockSdk)
  assertEq(tag4.category, 'food')
  assertEq(tag4.urgency, 'high') // keyword fallback: "critical" → high

  // 11. Tagging with invalid sentiment
  console.log('Testing tagTipText with invalid sentiment...')
  mockSdk.mockResponseText = '{"category":"food", "urgency":"low", "sentiment":"ecstatic", "confidence":"high"}'
  const tag5 = await tagTipText('Burgers are great here!', mockSdk)
  assertEq(tag5.category, 'food')
  assertEq(tag5.sentiment, 'neutral') // fallback

  // 12. Tagging empty tip
  console.log('Testing tagTipText with empty tip...')
  const tag6 = await tagTipText('', mockSdk)
  assertEq(tag6.category, 'other')
  assertEq(tag6.urgency, 'low')
  assertEq(tag6.sentiment, 'neutral')
  assertEq(tag6.confidence, 'low')

  // 13. Tagging very long tip
  console.log('Testing tagTipText with very long tip...')
  mockSdk.mockResponseText = '{"category":"safety", "urgency":"high", "sentiment":"negative", "confidence":"high"}'
  const tag7 = await tagTipText('🚨'.repeat(400), mockSdk)
  assertEq(tag7.category, 'safety')
  assertEq(tag7.urgency, 'high')

  // 14. Tagging unicode tip
  console.log('Testing tagTipText with unicode tip...')
  mockSdk.mockResponseText = '{"category":"gate", "urgency":"medium", "sentiment":"neutral", "confidence":"high"}'
  const tag8 = await tagTipText('😊 gate 3 is super crowded! 🚨', mockSdk)
  assertEq(tag8.category, 'gate')
  assertEq(tag8.urgency, 'medium')

  // 15. Queue processing and deduplication (same object queued twice)
  console.log('Testing queueTip and background processing/deduplication...')
  const tip = { id: 'test-1', message: 'Gate 3 is open', tagged: false }
  
  mockSdk.mockResponseText = '{"category":"gate", "urgency":"low", "sentiment":"neutral", "confidence":"high"}'
  
  let callbackCount = 0
  const onTagged = (tip) => {
    callbackCount++
    assertEq(tip.category, 'gate')
    assertEq(tip.tagged, true)
  }

  // Queue same object twice — second call is deduplicated because
  // processQueue sets tagged=true synchronously before awaiting
  queueTip(tip, mockSdk, onTagged)
  queueTip(tip, mockSdk, onTagged)
  
  // Wait for queue processing to complete
  await new Promise(resolve => setTimeout(resolve, 100))
  assertEq(callbackCount, 1, 'Deduplication should prevent tagging the same tip twice')

  // 16. isValidScoutResult validation
  console.log('Testing isValidScoutResult validation...')
  assert(isValidScoutResult({ id: '1', recommendation: 'ok', confidence: 'low', sourceCount: 0, provider: 'peer' }))
  assert(!isValidScoutResult({ id: '1', recommendation: 'ok' }), 'Missing fields should fail validation')
  assert(!isValidScoutResult({ id: '1', recommendation: 'ok', confidence: 'super', sourceCount: 0, provider: 'peer' }), 'Invalid confidence should fail validation')

  // Mock dependencies for delegateScout testing
  const mockCrypto = {
    randomBytes: (size) => b4a.from('a'.repeat(size * 2), 'hex')
  }
  const mockB4a = {
    toString: (buf, enc) => b4a.toString(buf, enc)
  }

  // 17. Request serialization
  console.log('Testing delegateScout request serialization...')
  let lastSentMsg = null
  const mockMesh = {
    getPeers: () => ['peer-key-123'],
    sendTo: (peer, msg) => {
      lastSentMsg = msg
      return true
    }
  }
  const peerCapabilities = new Map([['peer-key-123', ['scout']]])
  const pendingOffloads = new Map()
  const localScout = () => Promise.resolve({ recommendation: 'Local recommendation', confidence: 'medium', sourceCount: 0 })

  const runPromise = delegateScout({
    ocrText: 'Gate 3',
    translatedText: 'Puerta 3',
    nearbyTips: [],
    language: 'en',
    mesh: mockMesh,
    peerCapabilities,
    pendingOffloads,
    crypto: mockCrypto,
    b4a: mockB4a,
    timeoutMs: 100,
    localScoutAnalyze: localScout
  })

  assertEq(lastSentMsg.type, 'scout-request')
  assertEq(lastSentMsg.ocrText, 'Gate 3')
  assertEq(lastSentMsg.translatedText, 'Puerta 3')
  assertEq(lastSentMsg.language, 'en')
  assert(typeof lastSentMsg.id === 'string' && lastSentMsg.id.length > 0, 'Should generate request ID')

  // Resolve the pending promise to let it complete
  const pendingRequest = pendingOffloads.get(lastSentMsg.id)
  assert(pendingRequest !== undefined, 'Request should be in pendingOffloads')
  pendingRequest.resolve({
    id: lastSentMsg.id,
    recommendation: 'Peer recommendation',
    confidence: 'high',
    sourceCount: 1,
    provider: 'peer-key-123'
  })

  const res1 = await runPromise
  assertEq(res1.recommendation, 'Peer recommendation')
  assertEq(res1.provider, 'peer-key-123')
  assertEq(pendingOffloads.size, 0, 'pendingOffloads should be cleaned up')

  // 18. Timeout fallback
  console.log('Testing delegateScout timeout fallback...')
  const runTimeoutPromise = delegateScout({
    ocrText: 'Gate 3',
    translatedText: 'Puerta 3',
    nearbyTips: [],
    language: 'en',
    mesh: mockMesh,
    peerCapabilities,
    pendingOffloads,
    crypto: mockCrypto,
    b4a: mockB4a,
    timeoutMs: 50,
    localScoutAnalyze: localScout
  })
  
  const res2 = await runTimeoutPromise
  assertEq(res2.recommendation, 'Local recommendation')
  assertEq(res2.provider, 'Fallback: Local')
  assertEq(pendingOffloads.size, 0, 'pendingOffloads should be cleaned up after timeout')

  // 19. Peer disconnect during request
  console.log('Testing delegateScout peer disconnect during request...')
  const runDisconnectPromise = delegateScout({
    ocrText: 'Gate 3',
    translatedText: 'Puerta 3',
    nearbyTips: [],
    language: 'en',
    mesh: mockMesh,
    peerCapabilities,
    pendingOffloads,
    crypto: mockCrypto,
    b4a: mockB4a,
    timeoutMs: 1000,
    localScoutAnalyze: localScout
  })

  const requestToReject = Array.from(pendingOffloads.values())[0]
  requestToReject.reject(new Error('Peer disconnected'))

  const res3 = await runDisconnectPromise
  assertEq(res3.recommendation, 'Local recommendation')
  assertEq(res3.provider, 'Fallback: Local')
  assertEq(pendingOffloads.size, 0, 'pendingOffloads cleaned up after reject')

  // 20. Malformed response handling
  console.log('Testing delegateScout malformed response handling...')
  const runMalformedPromise = delegateScout({
    ocrText: 'Gate 3',
    translatedText: 'Puerta 3',
    nearbyTips: [],
    language: 'en',
    mesh: mockMesh,
    peerCapabilities,
    pendingOffloads,
    crypto: mockCrypto,
    b4a: mockB4a,
    timeoutMs: 1000,
    localScoutAnalyze: localScout
  })

  const malformedReqId = Array.from(pendingOffloads.keys())[0]
  const pendingMalformed = pendingOffloads.get(malformedReqId)
  pendingMalformed.reject(new Error('Malformed response received'))

  const res4 = await runMalformedPromise
  assertEq(res4.recommendation, 'Local recommendation')
  assertEq(res4.provider, 'Fallback: Local')

  // 21. Duplicate response handling
  console.log('Testing duplicate response resolution...')
  const runDuplicatePromise = delegateScout({
    ocrText: 'Gate 3',
    translatedText: 'Puerta 3',
    nearbyTips: [],
    language: 'en',
    mesh: mockMesh,
    peerCapabilities,
    pendingOffloads,
    crypto: mockCrypto,
    b4a: mockB4a,
    timeoutMs: 1000,
    localScoutAnalyze: localScout
  })

  const dupReqId = Array.from(pendingOffloads.keys())[0]
  const pendingDup = pendingOffloads.get(dupReqId)
  
  pendingDup.resolve({
    id: dupReqId,
    recommendation: 'First response',
    confidence: 'high',
    sourceCount: 1,
    provider: 'peer-key-123'
  })
  
  pendingOffloads.delete(dupReqId)

  const res5 = await runDuplicatePromise
  assertEq(res5.recommendation, 'First response')
  assertEq(pendingOffloads.has(dupReqId), false)

  console.log('\nAll Scout, Tagging, and Delegation unit tests PASSED successfully!')
  process.exit(0)
}

runTests().catch(err => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
