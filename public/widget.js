(function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────────────────────────
  var scriptEl = document.currentScript ||
    document.querySelector('script[src*="widget.js"]');
  var baseUrl = new URL(scriptEl.src).origin;

  // Get tenantId from script src or data attribute
  var tenantId = scriptEl.getAttribute('data-tenant-id');
  if (!tenantId) {
    // Extract from src URL pattern: /widget/SA_01/widget.js
    var srcMatch = scriptEl.src.match(/\/widget\/([^\/]+)\/widget\.js/);
    if (srcMatch) tenantId = srcMatch[1];
  }

  // Default bot name (will be overridden if config loads)
  var botName = scriptEl.getAttribute('data-bot-name') || 'Salon Assistant';
  var primaryColor = scriptEl.getAttribute('data-primary-color') || '#8b4a6b';

  // wsBaseUrl: Railway URL for WebSocket — Vercel can't upgrade WS connections.
  // Populated from salon-config; falls back to baseUrl (works in local dev).
  var wsBaseUrl = baseUrl;

  // Fetch salon config if tenantId is available (async, doesn't block)
  if (tenantId) {
    fetch(baseUrl + '/salon-config/' + tenantId)
      .then(function (res) { return res.json(); })
      .then(function (config) {
        if (config && config.bot_name) {
          botName = config.bot_name;
          salonName = config.salon_name || botName; // Store salon name
        }
        if (config && config.ws_url) {
          wsBaseUrl = config.ws_url;
        }
      });
  }

  // ── Session ID (persistent across page loads) ──────────────────────────────
  var SESSION_KEY = 'salon_bot_session';
  var sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#salonbot-wrap{position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px}',
    '#salonbot-toggle{width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;background:' + primaryColor + ';color:#fff;font-size:24px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.25);transition:transform .2s}',
    '#salonbot-toggle:hover{transform:scale(1.08)}',
    '#salonbot-window{display:none;flex-direction:column;position:absolute;bottom:68px;right:0;width:370px;height:480px;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.2);background:#fff}',
    '#salonbot-window.open{display:flex}',
    '#salonbot-header{background:' + primaryColor + ';color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:15px}',
    '#salonbot-call{background:none;border:none;color:white;font-size:20px;cursor:pointer;padding:4px;line-height:1;}',
    '#salonbot-call:hover{opacity:.8;}',
    '#salonbot-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:0}',
    '#salonbot-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;min-height:80px;font-size:14px!important}',
    '.sb-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:14px!important;line-height:1.45;word-break:break-word;white-space:pre-wrap}',
    '.sb-msg img{height:1.2em!important;width:auto!important;vertical-align:middle!important;display:inline-block!important}',
    '.sb-bot{background:#f0f0f0;color:#222;align-self:flex-start;border-bottom-left-radius:4px}',
    '.sb-user{background:' + primaryColor + ';color:#fff;align-self:flex-end;border-bottom-right-radius:4px}',
    '.sb-typing{display:flex;gap:4px;padding:10px 14px;align-items:center}',
    '.sb-dot{width:7px;height:7px;background:#aaa;border-radius:50%;animation:sb-bounce .9s infinite}',
    '.sb-dot:nth-child(2){animation-delay:.2s}.sb-dot:nth-child(3){animation-delay:.4s}',
    '@keyframes sb-bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}',
    '#salonbot-form{display:flex;border-top:1px solid #eee;padding:8px}',
    '#salonbot-input{flex:1;border:1px solid #ddd;border-radius:20px;padding:8px 14px;outline:none;font-size:14px}',
    '#salonbot-input:focus{border-color:' + primaryColor + '}',
    '#salonbot-send{margin-left:8px;width:36px;height:36px;border-radius:50%;border:none;background:' + primaryColor + ';color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '#salonbot-send:disabled{opacity:.5;cursor:default}'
  ].join('');
  document.head.appendChild(style);

  // ── DOM ────────────────────────────────────────────────────────────────────
  var wrap = document.createElement('div');
  wrap.id = 'salonbot-wrap';
  wrap.innerHTML = [
    '<button id="salonbot-toggle" aria-label="Open chat">💬</button>',
    '<div id="salonbot-window" role="dialog" aria-label="' + botName + ' chat">',
    '  <div id="salonbot-header">',
    '    <span>' + botName + '</span>',
    '<button id="salonbot-call" aria-label="Voice Call">📞</button>',
    '    <button id="salonbot-close" aria-label="Close">✕</button>',
    '  </div>',
    '  <div id="salonbot-messages"></div>',
    '  <form id="salonbot-form" autocomplete="off">',
    '    <input id="salonbot-input" type="text" placeholder="Type a message…" maxlength="500" />',
    '    <button id="salonbot-send" type="submit" aria-label="Send">➤</button>',
    '  </form>',
    '</div>'
  ].join('');
  document.body.appendChild(wrap);

  // ── Element refs ───────────────────────────────────────────────────────────
  var toggleBtn = document.getElementById('salonbot-toggle');
  var chatWin = document.getElementById('salonbot-window');
  var closeBtn = document.getElementById('salonbot-close');
  var messages = document.getElementById('salonbot-messages');
  var form = document.getElementById('salonbot-form');
  var input = document.getElementById('salonbot-input');
  var sendBtn = document.getElementById('salonbot-send');
  var callBtn = document.getElementById('salonbot-call');

  var opened = false;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function appendMsg(text, role) {
    var div = document.createElement('div');
    div.className = 'sb-msg ' + (role === 'bot' ? 'sb-bot' : 'sb-user');
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function showTyping() {
    var el = document.createElement('div');
    el.className = 'sb-msg sb-bot sb-typing';
    el.innerHTML = '<span class="sb-dot"></span><span class="sb-dot"></span><span class="sb-dot"></span>';
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function setLoading(on) {
    sendBtn.disabled = on;
    input.disabled = on;
  }

  // ── Voice Call State ───────────────────────────────────────────────────────
  // ── Tone synthesiser (dial/connect/end beeps) ──────────────────────────────
  var toneCtx = null;
  function getToneCtx() {
    if (!toneCtx || toneCtx.state === 'closed') toneCtx = new AudioContext();
    return toneCtx;
  }

  // Repeating 425 Hz dial beep: 0.4s on / 0.6s off — like WhatsApp ringing
  var dialInterval = null;
  function startDialTone() {
    stopDialTone();
    function beep() {
      var ctx = getToneCtx();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.frequency.value = 425;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.38);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    }
    beep();
    dialInterval = setInterval(beep, 1000);
  }
  function stopDialTone() {
    if (dialInterval) { clearInterval(dialInterval); dialInterval = null; }
  }

  // Connected jingle: two rising tones (600 Hz then 900 Hz)
  function playConnectedSound() {
    stopDialTone();
    var ctx = getToneCtx();
    [600, 900].forEach(function (freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.22, ctx.currentTime + i * 0.14);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + i * 0.14 + 0.13);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.14);
      osc.stop(ctx.currentTime + i * 0.14 + 0.15);
    });
  }

  // Ended tone: two falling tones (800 Hz then 500 Hz)
  function playEndedSound() {
    stopDialTone();
    var ctx = getToneCtx();
    [800, 500].forEach(function (freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.22, ctx.currentTime + i * 0.15);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + i * 0.15 + 0.14);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.16);
    });
  }

  // All call state kept in one object so cleanup is reliable and complete.
  var call = {
    ws: null,
    stream: null,       // MediaStream (microphone)
    audioCtx: null,     // Single AudioContext reused for the whole call
    processor: null,    // ScriptProcessorNode
    src: null,          // MediaStreamSource
    playbackCtx: null,  // Separate AudioContext for playback
    playbackQueue: [],
    isPlaying: false,
  };

  // FIX: teardown closes WS, stops mic, and closes both AudioContexts.
  // Previously "End Call" only removed the modal — mic + WS kept running.
  function teardownCall() {
    console.log('[call] teardownCall()');
    stopDialTone();
    if (call.processor) { try { call.processor.disconnect(); } catch (_) { } call.processor = null; }
    if (call.src) { try { call.src.disconnect(); } catch (_) { } call.src = null; }
    if (call.stream) {
      console.log('[call] stopping local microphone stream');
      call.stream.getTracks().forEach(function (t) { t.stop(); });
      call.stream = null;
    }
    if (call.audioCtx) { try { call.audioCtx.close(); } catch (_) { } call.audioCtx = null; }
    if (call.playbackCtx) { try { call.playbackCtx.close(); } catch (_) { } call.playbackCtx = null; }
    call.playbackQueue = [];
    call.isPlaying = false;
    if (call.ws) {
      console.log('[call] closing websocket');
      try { call.ws.close(); } catch (_) { }
      call.ws = null;
    }
  }

  // ── Voice Call Modal ───────────────────────────────────────────────────────
  function startVoiceCallModal() {
    console.log('[call] startVoiceCallModal()');
    // Prevent duplicate modals
    var existing = document.getElementById('salonbot-call-modal');
    if (existing) {
      console.log('[call] call modal already open');
      return;
    }

    var modal = document.createElement('div');
    modal.id = 'salonbot-call-modal';
    modal.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.7);' +
      'display:flex;justify-content:center;align-items:center;z-index:2147483647;';

    modal.innerHTML =
      '<div style="background:#fff;padding:30px;border-radius:20px;width:340px;text-align:center;">' +
      '<div style="font-size:48px;margin-bottom:12px;">📞</div>' +
      '<h2 style="margin-bottom:10px;">Voice Call</h2>' +
      '<p id="call-status" style="color:#666;margin-bottom:20px;">Connecting...</p>' +
      '<button id="call-end" style="padding:10px 28px;background:#e74c3c;color:#fff;border:none;border-radius:10px;font-size:15px;cursor:pointer;">End Call</button>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('call-end').onclick = function () {
      teardownCall();
      modal.remove();
    };

    startVoiceCall(modal);
  }

  function clearPlayback() {
    call.playbackQueue = [];
    call.isPlaying = false;
    if (call.playbackCtx) {
      try { call.playbackCtx.close(); } catch (_) { }
      call.playbackCtx = null;
    }
  }

  // ── Gemini Voice Call (WebSocket) ──────────────────────────────────────────
  function startVoiceCall(modal) {
    var wsUrl = wsBaseUrl.replace('https', 'wss').replace('http', 'ws') + '/api/call?tenantId=' + encodeURIComponent(tenantId);
    console.log('[call] startVoiceCall() connecting to', wsUrl);

    startDialTone();
    var ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    call.ws = ws;

    ws.onopen = function () {
      console.log('[call] websocket onopen');
      playConnectedSound();
      setCallStatus('Connected 🟢');
      startMicrophone(ws);
      // Ask server to send the greeting trigger to Gemini
      ws.send(JSON.stringify({ type: 'greet', sessionId: sessionId }));
      ws.send(JSON.stringify({ type: 'greet' }));
    };

    ws.onmessage = function (e) {
      console.log('[call] websocket onmessage, type:', typeof e.data);
      if (typeof e.data !== 'string') {
        // Binary = PCM16 audio from Gemini
        console.log('[call] websocket audio chunk received:', e.data.byteLength || '(unknown bytes)');
        call.playbackQueue.push(e.data);
        processPlaybackQueue();
      } else {
        try {
          var msg = JSON.parse(e.data);
          console.log('[call] websocket text message:', msg);
          if (msg.type === 'interrupted') {
            clearPlayback();
          }
          if (msg.type === 'text') {
            console.log('[call] Transcript:', msg.text);
          }
        } catch (err) {
          console.error('[call] websocket text parse error', err, 'data:', e.data);
        }
      }
    };

    ws.onerror = function (err) {
      console.error('[call] WebSocket error', err);
      setCallStatus('Connection error ❌');
    };

    ws.onclose = function () {
      playEndedSound();
      setCallStatus('Call ended');
      teardownCall();
    };
  }

  function setCallStatus(text) {
    var el = document.getElementById('call-status');
    if (el) el.textContent = text;
  }

  // ── Microphone capture → Gemini ────────────────────────────────────────────
  // Uses AudioWorklet (128-sample chunks at 16kHz) for clean, low-latency capture.
  // AudioWorklet code is injected as a Blob URL — no separate file needed.
  async function startMicrophone(ws) {
    console.log('[call] startMicrophone()');
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      console.log('[call] getUserMedia success', stream);
      call.stream = stream;

      var ctx = new AudioContext(); // native rate (usually 48000 Hz); worklet downsamples to 16kHz
      call.audioCtx = ctx;

      // Inject worklet as a Blob so we don't need a separate .js file on the server
      var workletCode = [
        'var TARGET_RATE = 16000;',
        'class PcmCapture extends AudioWorkletProcessor {',
        '  constructor() {',
        '    super();',
        '    // sampleRate global = actual AudioContext rate (e.g. 48000)',
        '    this._ratio = sampleRate / TARGET_RATE;',
        '    this._acc = 0;',
        '  }',
        '  process(inputs) {',
        '    var ch = inputs[0][0];',
        '    if (!ch || !ch.length) return true;',
        '    var out = [];',
        '    for (var i = 0; i < ch.length; i++) {',
        '      this._acc += 1;',
        '      if (this._acc >= this._ratio) {',
        '        this._acc -= this._ratio;',
        '        out.push(Math.max(-32768, Math.min(32767, Math.round(ch[i] * 32768))));',
        '      }',
        '    }',
        '    if (out.length > 0) {',
        '      var pcm = new Int16Array(out);',
        '      this.port.postMessage(pcm.buffer, [pcm.buffer]);',
        '    }',
        '    return true;',
        '  }',
        '}',
        'registerProcessor("pcm-capture", PcmCapture);'
      ].join('\n');

      var blob = new Blob([workletCode], { type: 'application/javascript' });
      var blobUrl = URL.createObjectURL(blob);

      await ctx.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);

      var src = ctx.createMediaStreamSource(stream);
      call.src = src;

      var worklet = new AudioWorkletNode(ctx, 'pcm-capture');
      call.processor = worklet;

      worklet.port.onmessage = function (e) {
        if (!call.ws || call.ws.readyState !== WebSocket.OPEN) return;
        call.ws.send(e.data);
      };

      src.connect(worklet);
      // AudioWorkletNode does NOT need to connect to destination — no local playback of mic
      // worklet.connect(ctx.destination); // required by some browsers to keep graph alive; silent output
    } catch (err) {
      console.error('[call] Microphone error:', err);
      setCallStatus('Mic access denied ❌');
    }
  }

  // ── Play PCM16 audio from Gemini ───────────────────────────────────────────

  function processPlaybackQueue() {
    if (call.isPlaying || call.playbackQueue.length === 0) return;
    call.isPlaying = true;
    console.log('[call] processPlaybackQueue: next item, queue length', call.playbackQueue.length);
    playPCM16(call.playbackQueue.shift());
  }

  function playPCM16(buffer) {
    console.log('[call] playPCM16() -- received audio chunk', buffer.byteLength || '(unknown bytes)');
    // Gemini Live API outputs 24kHz PCM16. Use native-rate AudioContext and
    // linear-interpolation upsample so playback pitch/speed is always correct
    // regardless of whether the browser honours a non-standard sample rate hint.
    const GEMINI_RATE = 24000;

    if (!call.playbackCtx) {
      call.playbackCtx = new AudioContext(); // native rate (usually 48000 Hz)
    }

    const ctx = call.playbackCtx;
    const ctxRate = ctx.sampleRate;

    // Convert Int16 -> Float32
    const int16 = new Int16Array(buffer);
    const float = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float[i] = int16[i] / 32768;
    }

    // Upsample from GEMINI_RATE to ctxRate via linear interpolation
    let samples;
    if (GEMINI_RATE !== ctxRate) {
      const ratio = ctxRate / GEMINI_RATE; // e.g. 48000/24000 = 2
      samples = new Float32Array(Math.round(float.length * ratio));
      for (let i = 0; i < samples.length; i++) {
        const src = i / ratio;
        const lo = Math.floor(src);
        const hi = Math.min(lo + 1, float.length - 1);
        const frac = src - lo;
        samples[i] = float[lo] * (1 - frac) + float[hi] * frac;
      }
    } else {
      samples = float;
    }

    // Create audio buffer at the context's native rate
    const audioBuffer = ctx.createBuffer(1, samples.length, ctxRate);
    audioBuffer.getChannelData(0).set(samples);

    // Play it
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = function () {
      console.log('[call] playPCM16 playback ended');
      call.isPlaying = false;
      processPlaybackQueue();
    };
    source.start();
  }

  // ── Open / close chat ──────────────────────────────────────────────────────
  function open() {
    opened = true;
    chatWin.classList.add('open');
    toggleBtn.textContent = '✕';
    input.focus();
    if (!messages.hasChildNodes()) {
      appendMsg('Hi! 👋 How can I help you today? Ask me about prices, deals, locations, or booking.', 'bot');
    }
  }

  function close() {
    opened = false;
    chatWin.classList.remove('open');
    toggleBtn.textContent = '💬';
  }

  toggleBtn.addEventListener('click', function () { opened ? close() : open(); });
  callBtn.addEventListener('click', startVoiceCallModal);
  closeBtn.addEventListener('click', close);

  // ── Send message ───────────────────────────────────────────────────────────
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;

    input.value = '';
    appendMsg(text, 'user');
    setLoading(true);

    var typing = showTyping();

    fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId: sessionId, tenantId: tenantId })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        messages.removeChild(typing);
        appendMsg(data.reply || "Sorry, I couldn't respond. Please try again.", 'bot');
      })
      .catch(function () {
        messages.removeChild(typing);
        appendMsg('Network error. Please check your connection and try again.', 'bot');
      })
      .finally(function () {
        setLoading(false);
        input.focus();
      });
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  });

})();