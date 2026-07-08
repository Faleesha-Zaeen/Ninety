// electron/preload.cjs — safe bridge between renderer and main.
// Exposes a tiny, explicit API. No Node access leaks into the page.

const { contextBridge, ipcRenderer } = require('electron')
const QRCode = require('qrcode')
const jsQR = require('jsqr')

contextBridge.exposeInMainWorld('ninety', {
  // Fire a command object at the Bare backend (returns {ok} / {ok:false,error}).
  send: (command) => ipcRenderer.invoke('send-command', command),

  // Ask main who this window is (wallet dir + optional joined topic).
  getRole: () => ipcRenderer.invoke('get-role'),

  // Open a native file picker; resolves to { path, dataUrl } or null.
  pickImage: () => ipcRenderer.invoke('pick-image'),

  // Save a camera capture (data URL) to a temp file; resolves to { path, dataUrl } or null.
  saveCapture: (dataUrl) => ipcRenderer.invoke('save-capture', dataUrl),

  // Diagnostic: save a raw audio blob (base64) to disk so the user can inspect it.
  saveAudioBlob: (base64Data) => ipcRenderer.invoke('save-audio-blob', base64Data),

  // Expose QR generation and decoding
  generateQR: (text) => {
    try {
      return QRCode.toDataURL(text, { margin: 2, scale: 8 })
    } catch (err) {
      console.error('[preload] generateQR error:', err)
      throw err
    }
  },

  decodeQR: (rgbaData, width, height) => {
    try {
      const res = jsQR(rgbaData, width, height)
      return res ? res.data : null
    } catch (err) {
      console.error('[preload] decodeQR error:', err)
      return null
    }
  },

  saveSessionFile: (content, defaultName) => ipcRenderer.invoke('save-session-file', { content, defaultName }),

  // Subscribe to structured backend events. Returns an unsubscribe fn.
  onEvent: (handler) => {
    const listener = (_e, evt) => handler(evt)
    ipcRenderer.on('backend-event', listener)
    return () => ipcRenderer.removeListener('backend-event', listener)
  },

  // Backend lifecycle / debug streams.
  onLog: (handler) => ipcRenderer.on('backend-log', (_e, text) => handler(text)),
  onExit: (handler) => ipcRenderer.on('backend-exit', (_e, info) => handler(info)),
  onBackendError: (handler) => ipcRenderer.on('backend-error', (_e, info) => handler(info))
})
