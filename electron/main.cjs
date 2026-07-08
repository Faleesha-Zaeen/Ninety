// electron/main.cjs — Electron main process for Ninety.
//
// Bridges a headless Bare backend (backend-headless.js) to the renderer. The
// backend runs the untouched lib/qvac.js, lib/mesh.js, lib/wallet.js in their
// tested Bare runtime; this process only shuttles messages.
//
// Transport: a loopback TCP socket. On Windows, Bare cannot wrap the named
// pipes Node creates for a child's std streams, so we give the child NO std
// pipes (stdio: 'ignore') and talk to it over TCP instead. We open a server on
// 127.0.0.1:<ephemeral>, pass the port to the child, and it connects back.
//
// Role via argv:
//   electron electron/main.cjs --wallet-dir peer1-wallet
//   electron electron/main.cjs --wallet-dir peer2-wallet --topic <hex>

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const { spawn, execSync } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const PROJECT_ROOT = path.resolve(__dirname, '..')

// ─── VoiceSign automated live-UI test harness (env-gated, no effect in prod) ──
// NINETY_VOICE_TEST=<N> drives N real "hold to speak" cycles through the actual
// renderer MediaRecorder path, feeding a WAV as the microphone via Chromium's
// fake-audio-capture. NINETY_VOICE_WAV points at that WAV. Captures the full
// renderer+backend console stream to NINETY_VOICE_LOG for line-by-line analysis.
const VOICE_TEST_N = parseInt(process.env.NINETY_VOICE_TEST || '0', 10)
const VOICE_TEST_WAV = process.env.NINETY_VOICE_WAV || ''
const VOICE_TEST_LOG = process.env.NINETY_VOICE_LOG || ''
if (VOICE_TEST_N > 0) {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  if (VOICE_TEST_WAV) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', VOICE_TEST_WAV)
}
function vlog (s) { if (VOICE_TEST_LOG) { try { fs.appendFileSync(VOICE_TEST_LOG, s + '\n') } catch {} } }

// Optional file-based debug trace (Windows GUI Electron swallows main stdout).
const DEBUG_FILE = process.env.NINETY_DEBUG_FILE
function dbg (...a) {
  if (!DEBUG_FILE) return
  try { fs.appendFileSync(DEBUG_FILE, a.join(' ') + '\n') } catch {}
}

// Resolve the native Bare executable so we can spawn it directly (no cmd shim).
function resolveBare () {
  if (process.env.NINETY_BARE) return process.env.NINETY_BARE
  const isWin = process.platform === 'win32'
  const rt = `bare-runtime-${process.platform}-${process.arch}`
  const exe = isWin ? 'bare.exe' : 'bare'
  const candidates = []
  try {
    const found = execSync(isWin ? 'where bare' : 'which bare', { encoding: 'utf8' })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0]
    if (found) {
      const globalRoot = path.join(path.dirname(found), 'node_modules')
      candidates.push(path.join(globalRoot, 'bare', 'node_modules', rt, 'bin', exe))
      candidates.push(path.join(globalRoot, rt, 'bin', exe))
    }
  } catch {}
  candidates.push(path.join(PROJECT_ROOT, 'node_modules', rt, 'bin', exe))
  for (const c of candidates) { if (fs.existsSync(c)) return c }
  return isWin ? 'bare.exe' : 'bare' // last resort: hope it's on PATH
}

// ─── Role flags ───────────────────────────────────────────────────────────────
function parseArgs (argv) {
  let walletDir = 'peer1-wallet'
  let topic = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wallet-dir' && i + 1 < argv.length) { walletDir = argv[i + 1]; i++ }
    else if (argv[i] === '--topic' && i + 1 < argv.length) { topic = argv[i + 1]; i++ }
  }
  return { walletDir, topic }
}
const role = parseArgs(process.argv.slice(1))

// Separate Chromium profile per peer so two instances run at once cleanly.
app.setPath('userData', path.join(app.getPath('userData'), 'ninety-' + role.walletDir))

let win = null
let backend = null          // child process
let backendSock = null      // TCP socket to the child
let rendererReady = false
const outbox = []

// ─── Renderer messaging (buffered until the page has loaded) ───────────────────
function sendToRenderer (channel, payload) {
  if (!rendererReady) { outbox.push([channel, payload]); return }
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
function flushOutbox () {
  rendererReady = true
  if (!win || win.isDestroyed()) return
  for (const [channel, payload] of outbox) win.webContents.send(channel, payload)
  outbox.length = 0
}

// ─── TCP server + backend spawn ───────────────────────────────────────────────
function startBackend () {
  const server = net.createServer((sock) => {
    backendSock = sock
    dbg('[main] backend connected')
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let evt
        try { evt = JSON.parse(line) } catch { continue }
        if (evt.ev === 'log') { dbg('[bare]', evt.line); sendToRenderer('backend-log', evt.line); continue }
        dbg('[main] evt:', evt.ev, evt.message || '')
        // IPC-TRACE: log key events from backend
        if (['status','ready','fatal','tip-tagged','tip-added','error'].includes(evt.ev)) {
          dbg('[ipc-trace]', Date.now(), evt.ev, JSON.stringify(evt).slice(0,200))
        }
        sendToRenderer('backend-event', evt)
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => { dbg('[main] backend socket closed') })
  })

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    const bareExe = resolveBare()
    const args = ['backend-headless.js', '--ipc-port', String(port), '--wallet-dir', role.walletDir]
    if (role.topic) args.push(role.topic)
    dbg('[main] listening on', port, '— spawning', bareExe, args.join(' '))
    backend = spawn(bareExe, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdoutBuf = ''
    let stderrBuf = ''

    backend.stdout.on('data', (data) => {
      const s = data.toString()
      stdoutBuf += s
      process.stdout.write(s)
    })

    backend.stderr.on('data', (data) => {
      const s = data.toString()
      stderrBuf += s
      process.stderr.write(s)
    })

    backend.on('error', (err) => {
      console.error('[main] backend process error listener:', err)
      dbg('[main] spawn error:', err.message)
      sendToRenderer('backend-error', { message: `Failed to launch Bare backend: ${err.message}. Is "bare" installed and on PATH?` })
    })

    backend.on('exit', (code, signal) => {
      console.log(`[main] backend process exit listener: code=${code}, signal=${signal}`)
      dbg('[main] backend exit code:', code)
      sendToRenderer('backend-exit', { code })

      if (code !== 0 && code !== null) {
        console.error('==================================================')
        console.error('BACKEND Headless Process Exited with Non-Zero Code')
        console.error(`Exit Code: ${code}`)
        console.error(`Signal: ${signal}`)
        console.error('--------------------------------------------------')
        console.error('COMPLETE STDERR:')
        console.error(stderrBuf)
        console.error('==================================================')
      }
    })

    backend.on('close', (code, signal) => {
      console.log(`[main] backend process close listener: code=${code}, signal=${signal}`)
    })
  })
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow () {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0a0d0f',
    title: `NINETY — ${role.walletDir}`,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.removeMenu()
  // Local trusted renderer — allow camera (getUserMedia) and other web permissions.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(true))
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())
  win.webContents.on('did-finish-load', () => { dbg('[main] renderer loaded'); flushOutbox() })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

  // ── VoiceSign live-UI test: capture console + auto-drive the mic button ──
  if (VOICE_TEST_N > 0) {
    win.webContents.on('console-message', (_e, _lvl, message) => vlog(message))
    win.webContents.once('did-finish-load', () => {
      // Wait for the backend to finish loading models, then run N real cycles ONCE.
      setTimeout(() => { runVoiceTest(win, VOICE_TEST_N) }, 20000)
    })
  }

  win.on('closed', () => { win = null; rendererReady = false })
}

// Drives the ACTUAL renderer startMic()/stopMic() globals N times over the real
// MediaRecorder → IPC → backend path. Mic audio comes from the fake-capture WAV.
let voiceTestRan = false
async function runVoiceTest (win, n) {
  if (voiceTestRan) { vlog('[main] runVoiceTest already ran — skipping duplicate'); return }
  voiceTestRan = true
  vlog(`\n===== VOICE TEST START: ${n} cycles =====`)
  // Strictly serial: hold 2.5s, then wait until the UI settles (ocrText leaves the
  // "Transcribing…" state) before the next press, so recordings never overlap.
  const rapid = process.env.NINETY_VOICE_RAPID === '1'
  const script = `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ocr = () => (document.getElementById('ocrText')||{}).textContent || '';
    const N = ${n};
    const RAPID = ${rapid ? 'true' : 'false'};
    for (let i = 1; i <= N; i++) {
      console.debug('##### AUTODRIVE cycle ' + i + ' pressMic (recCountBefore=' + (typeof micRecCount!=='undefined'?micRecCount:'?') + ') #####');
      try { startMic(); } catch (e) { console.debug('AUTODRIVE startMic threw: ' + e.message); }
      await sleep(RAPID ? 900 : 2500);          // hold
      try { stopMic(); } catch (e) { console.debug('AUTODRIVE stopMic threw: ' + e.message); }
      if (RAPID) {
        // Rapid re-press: only a short gap — previous recording's async
        // onstop→FileReader→send may still be in flight → overlap.
        await sleep(400);
      } else {
        let waited = 0;
        while (waited < 12000) { await sleep(300); waited += 300; const t = ocr(); if (t && t !== 'Transcribing…') break; }
        await sleep(700);
      }
      console.debug('##### AUTODRIVE cycle ' + i + ' done, ocr="' + ocr() + '" #####');
    }
    if (RAPID) { await sleep(20000); }   // let any in-flight transcriptions settle
    console.debug('##### AUTODRIVE ALL DONE #####');
    return 'ok';
  })()`
  try { await win.webContents.executeJavaScript(script, true) } catch (e) { vlog('[main] runVoiceTest error: ' + e.message) }
  vlog('===== VOICE TEST FINISHED =====')
  setTimeout(() => { try { app.quit() } catch {} }, 1500)
}

// ─── IPC: renderer → backend ───────────────────────────────────────────────────
ipcMain.handle('send-command', (_e, command) => {
  if (!backendSock || backendSock.destroyed) return { ok: false, error: 'backend not connected' }
  try { backendSock.write(JSON.stringify(command) + '\n'); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('get-role', () => ({ walletDir: role.walletDir, topic: role.topic }))

ipcMain.handle('save-session-file', async (_e, { content, defaultName }) => {
  try {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export Session Feed',
      defaultPath: path.join(app.getPath('downloads'), defaultName || 'session-tips.json'),
      filters: [{ name: 'JSON Files', extensions: ['json'] }, { name: 'Text Files', extensions: ['txt'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' }
    fs.writeFileSync(res.filePath, content, 'utf8')
    return { ok: true, path: res.filePath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('pick-image', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a sign image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }]
  })
  if (res.canceled || !res.filePaths.length) return null
  const filePath = res.filePaths[0]
  try {
    const b = fs.readFileSync(filePath)
    const ext = path.extname(filePath).slice(1).toLowerCase()
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg'
    return { path: filePath, dataUrl: `data:${mime};base64,${b.toString('base64')}` }
  } catch { return { path: filePath, dataUrl: null } }
})

// Persist a camera capture (data URL) to a temp file so the backend OCR flow,
// which reads a file on disk, can treat it exactly like a file-picked image.
ipcMain.handle('save-capture', async (_e, dataUrl) => {
  try {
    const m = /^data:image\/(\w+);base64,(.+)$/s.exec(dataUrl || '')
    if (!m) return null
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
    const file = path.join(os.tmpdir(), `ninety-capture-${Date.now()}.${ext}`)
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'))
    return { path: file, dataUrl }
  } catch { return null }
})

// ─── Diagnostic: save a blob from the renderer to a temp file so the
// user can inspect the raw recorded audio that's being sent to Whisper.
ipcMain.handle('save-audio-blob', async (_e, base64Data) => {
  try {
    const file = path.join(os.tmpdir(), `ninety-mic-diagnostic-${Date.now()}.webm`)
    fs.writeFileSync(file, Buffer.from(base64Data, 'base64'))
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startBackend()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

function shutdownBackend () {
  try { if (backendSock && !backendSock.destroyed) backendSock.write(JSON.stringify({ cmd: 'quit' }) + '\n') } catch {}
  setTimeout(() => { try { if (backend && !backend.killed) backend.kill() } catch {} }, 300)
}

app.on('window-all-closed', () => { shutdownBackend(); app.quit() })
app.on('before-quit', () => { try { if (backend && !backend.killed) backend.kill() } catch {} })
