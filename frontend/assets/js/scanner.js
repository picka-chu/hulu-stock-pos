/**
 * Hulu Stock Professional Barcode & QR Scanner  v3.0
 *
 * Decoder strategy (fastest → most compatible):
 *   1. Native BarcodeDetector API  — Chrome 83+, Edge, Android Chrome (GPU-accelerated)
 *   2. jsQR (raw ImageData)        — iOS Safari (iPhone/iPad). Pure JS, zero blob/URL
 *                                    overhead. Decodes directly from canvas pixels.
 *                                    iPhone 11 Pro tested. 2250ms warm-up + focusDistance.
 *   3. html5-qrcode (blob/URL)     — Desktop Firefox, older browsers
 *   4. Hardware scanner (USB/BT)   — Keyboard-wedge captured globally
 *
 * All public API unchanged: open, close, toggleTorch, triggerFocus,
 * switchCamera, isOpen, setOnResult — no other files need modification.
 */

window.XScanner = (() => {
    'use strict';

    // ── Device detection ──────────────────────────────────────────────────────
    const IS_IOS     = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const IS_ANDROID = /Android/.test(navigator.userAgent);
    const IS_DESKTOP = !IS_IOS && !IS_ANDROID;

    // ── State ─────────────────────────────────────────────────────────────────
    let _stream       = null;
    let _animFrame    = null;
    let _detector     = null;   // Native BarcodeDetector instance
    let _h5scanner    = null;   // Html5Qrcode instance — desktop fallback
    let _jsqr         = null;   // jsQR flag — set to true when jsQR is available (iOS)
    let _useNative    = false;
    let _active       = false;
    let _lastResult   = '';
    let _lastTime     = 0;
    let _onResult     = null;
    let _onError      = null;
    let _overlayEl    = null;
    let _videoEl      = null;
    let _canvasEl     = null;
    let _ctx          = null;
    let _torchOn      = false;
    let _torchSupport = false;
    let _target       = 'pos';
    let _facingMode   = 'environment';
    let _disableQR    = false;

    // Hidden div id that Html5Qrcode requires to instantiate
    const H5_DIV_ID = 'xpos-h5qr-helper';

    const DEBOUNCE_MS = 1500;

    // Native BarcodeDetector format lists
    const NATIVE_FORMATS = [
        'ean_13','ean_8','upc_a','upc_e',
        'code_128','code_39','code_93',
        'itf','codabar','aztec',
        'data_matrix','pdf417','qr_code'
    ];
    const BARCODE_ONLY_FORMATS = [
        'ean_13','ean_8','upc_a','upc_e',
        'code_128','code_39','code_93',
        'itf','codabar'
    ];

    // ── Public API ────────────────────────────────────────────────────────────
    const api = {
        open(opts = {}) {
            if (_active) return;
            _onResult   = opts.onResult || (() => {});
            _onError    = opts.onError  || (() => {});
            _target     = opts.target   || 'pos';
            _disableQR  = !!opts.disableQR;
            _lastResult = '';
            _active     = true;
            _buildOverlay();
            _startCamera();
        },

        close() {
            _active = false;
            _stopCamera();
            _removeOverlay();
        },

        toggleTorch() {
            if (!_torchSupport || !_stream) return;
            _torchOn = !_torchOn;
            const track = _stream.getVideoTracks()[0];
            track.applyConstraints({ advanced: [{ torch: _torchOn }] }).catch(() => {});
            const btn = document.getElementById('xpos-torch-btn');
            if (btn) {
                btn.innerHTML = _torchOn
                    ? '<i class="fas fa-bolt" style="color:#fbbf24"></i>'
                    : '<i class="fas fa-bolt"></i>';
            }
        },

        async triggerFocus() {
            if (!_stream) return;
            const track = _stream.getVideoTracks()[0];
            const caps  = track.getCapabilities?.() || {};
            try {
                const opts = [];
                if (caps.focusMode?.includes('single-shot')) opts.push({ focusMode: 'single-shot' });
                else if (caps.focusMode?.includes('single'))  opts.push({ focusMode: 'single' });
                if (caps.pointOfInterest) opts.push({ pointOfInterest: { x: 0.5, y: 0.5 } });
                if (opts.length) await track.applyConstraints({ advanced: opts });
                _setStatus('Focusing…', 'success');
                setTimeout(async () => {
                    try {
                        const r = [];
                        if (caps.focusMode?.includes('continuous')) r.push({ focusMode: 'continuous' });
                        if (r.length) await track.applyConstraints({ advanced: r });
                        _setStatus('Scanning…');
                    } catch (_) {}
                }, 1200);
            } catch (_) { _setStatus('Focus not supported'); }
        },

        async switchCamera() {
            _stopCamera();
            _facingMode = _facingMode === 'environment' ? 'user' : 'environment';
            await _startCamera();
        },

        isOpen()  { return _active; },

        setOnResult(fn) {
            if (typeof fn === 'function') {
                _onResult = fn;
                _lastResult = '';
            }
        }
    };

    // ── Build overlay ─────────────────────────────────────────────────────────
    function _buildOverlay() {
        _removeOverlay();

        const headerTitle = _disableQR ? 'Scan Barcode' : 'Scan Barcode / QR';
        const hintText    = _disableQR
            ? 'Point camera at barcode · EAN-13 · Code128 · UPC'
            : 'Point camera at barcode or QR code';

        _overlayEl = document.createElement('div');
        _overlayEl.id = 'xpos-scanner-overlay';
        _overlayEl.innerHTML = `
            <style>
            #xpos-scanner-overlay {
                position: fixed; inset: 0; z-index: 99999;
                background: rgba(0,0,0,.92);
                display: flex; flex-direction: column;
                align-items: center; justify-content: center;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                -webkit-user-select: none; user-select: none;
            }
            /* Desktop: full-window layout for maximum decode accuracy */
            #xpos-scanner-wrap {
                position: relative;
                width: min(420px, 96vw);   /* mobile default */
            }
            @media (min-width: 769px) {
                #xpos-scanner-overlay { align-items: stretch; justify-content: stretch; padding: 0; }
                #xpos-scanner-wrap    { width: 100%; height: 100vh; display: flex; flex-direction: column; }
                #xpos-scanner-header  { flex-shrink: 0; }
                #xpos-video-box       { flex: 1; border-radius: 0 !important; }
                #xpos-video           { width: 100% !important; height: 100% !important;
                                        aspect-ratio: unset !important; object-fit: contain !important; }
                #xpos-pos-footer      { flex-shrink: 0; width: 100% !important;
                                        border-radius: 0; margin-top: 0; }
            }
            #xpos-scanner-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 10px 16px;
                background: rgba(0,0,0,.6); backdrop-filter: blur(8px);
            }
            #xpos-scanner-header h2 {
                color: #fff; font-size: 18px; font-weight: 700; margin: 0;
                display: flex; align-items: center; gap: 8px;
            }
            .xpos-hdr-btns { display: flex; gap: 8px; }
            .xpos-icon-btn {
                width: 38px; height: 38px; border-radius: 10px;
                background: rgba(255,255,255,.12); border: none;
                color: #fff; font-size: 15px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: background .15s; -webkit-tap-highlight-color: transparent;
            }
            .xpos-icon-btn:hover, .xpos-icon-btn:active { background: rgba(255,255,255,.26); }
            #xpos-video-box {
                position: relative; width: 100%;
                border-radius: 18px; overflow: hidden;
                background: #000;
                box-shadow: 0 24px 60px rgba(0,0,0,.5);
            }
            #xpos-video {
                width: 100%; display: block;
                aspect-ratio: 1/1; object-fit: cover;
                -webkit-transform: translateZ(0);
            }
            #xpos-canvas { display: none; }
            #xpos-frame {
                position: absolute; inset: 0;
                display: flex; align-items: center; justify-content: center;
                pointer-events: none;
            }
            .xpos-corner {
                position: absolute; width: 56px; height: 56px;
                border-color: #3b82f6; border-style: solid; border-width: 0;
            }
            .xpos-corner.tl { top: 18px; left: 18px; border-top-width: 3px; border-left-width: 3px; border-top-left-radius: 6px; }
            .xpos-corner.tr { top: 18px; right: 18px; border-top-width: 3px; border-right-width: 3px; border-top-right-radius: 6px; }
            .xpos-corner.bl { bottom: 18px; left: 18px; border-bottom-width: 3px; border-left-width: 3px; border-bottom-left-radius: 6px; }
            .xpos-corner.br { bottom: 18px; right: 18px; border-bottom-width: 3px; border-right-width: 3px; border-bottom-right-radius: 6px; }
            #xpos-scan-line {
                position: absolute; left: 18px; right: 18px; height: 2px;
                background: linear-gradient(90deg, transparent, #3b82f6, transparent);
                animation: xpos-scan-line 1.8s ease-in-out infinite;
                box-shadow: 0 0 8px #3b82f6;
            }
            @keyframes xpos-scan-line {
                0%   { top: 18%; opacity: .9; }
                50%  { top: 80%; opacity: 1; }
                100% { top: 18%; opacity: .9; }
            }
            #xpos-result-flash {
                position: absolute; inset: 0; background: rgba(74,222,128,.25);
                opacity: 0; border-radius: 18px; transition: opacity .12s;
                pointer-events: none;
            }
            #xpos-result-flash.show { opacity: 1; }
            #xpos-status {
                text-align: center; color: rgba(255,255,255,.7);
                font-size: 13px; margin-top: 14px; min-height: 20px;
                transition: color .2s;
            }
            #xpos-status.success { color: #4ade80; }
            #xpos-status.error   { color: #f87171; }
            #xpos-hint {
                text-align: center; color: rgba(255,255,255,.4);
                font-size: 11px; margin-top: 6px;
            }
            #xpos-pos-footer {
                display: none; margin-top: 14px;
                background: rgba(255,255,255,.06);
                border-radius: 12px; padding: 12px 16px;
                width: min(420px, 96vw);
            }
            #xpos-cart-summary {
                color: rgba(255,255,255,.7); font-size: 13px; text-align: center;
            }
            #xpos-done-btn {
                width: 100%; margin-top: 10px;
                background: #3b82f6; color: #fff; border: none;
                border-radius: 10px; padding: 12px; font-size: 14px;
                font-weight: 700; cursor: pointer;
                -webkit-tap-highlight-color: transparent;
            }
            #xpos-done-btn:active { background: #2563eb; }
            @keyframes xpos-tap-ring {
                from { transform: scale(.5); opacity: 1; }
                to   { transform: scale(2); opacity: 0; }
            }
            </style>

            <div id="xpos-scanner-wrap">
                <div id="xpos-scanner-header">
                    <h2><i class="fas fa-barcode" style="color:#3b82f6;"></i>${headerTitle}</h2>
                    <div class="xpos-hdr-btns">
                        <button class="xpos-icon-btn" id="xpos-torch-btn" onclick="XScanner.toggleTorch()" style="display:none;" title="Torch">
                            <i class="fas fa-bolt"></i>
                        </button>
                        <button class="xpos-icon-btn" id="xpos-focus-btn" onclick="XScanner.triggerFocus()" style="display:none;" title="Focus">
                            <i class="fas fa-crosshairs"></i>
                        </button>
                        <button class="xpos-icon-btn" id="xpos-switch-btn" onclick="XScanner.switchCamera()" title="Switch camera">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                        <button class="xpos-icon-btn" onclick="XScanner.close()" title="Close" style="background:rgba(239,68,68,.25);">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                </div>

                <div id="xpos-video-box">
                    <video id="xpos-video" playsinline muted autoplay></video>
                    <canvas id="xpos-canvas"></canvas>
                    <div id="xpos-frame">
                        <div class="xpos-corner tl"></div>
                        <div class="xpos-corner tr"></div>
                        <div class="xpos-corner bl"></div>
                        <div class="xpos-corner br"></div>
                        <div id="xpos-scan-line"></div>
                    </div>
                    <div id="xpos-result-flash"></div>
                </div>

                <div id="xpos-status">Starting camera…</div>
                <div id="xpos-hint">${hintText}</div>
            </div>

            <div id="xpos-pos-footer">
                <div id="xpos-cart-summary">Cart is empty — scan products to add them</div>
                <button id="xpos-done-btn">Done</button>
            </div>`;

        document.body.appendChild(_overlayEl);

        _videoEl  = document.getElementById('xpos-video');
        _canvasEl = document.getElementById('xpos-canvas');
        _ctx      = _canvasEl.getContext('2d', { willReadFrequently: true });

        const posFooter = document.getElementById('xpos-pos-footer');
        if (posFooter && _target === 'pos') {
            posFooter.style.display = 'block';
            _updatePOSCartSummary();
        }
        document.getElementById('xpos-done-btn')?.addEventListener('click', () => api.close());

        _overlayEl.addEventListener('click', e => {
            if (e.target === _overlayEl) api.close();
        });

        // Camera hot-plug: if camera was not found, auto-retry when one becomes available
        const deviceHandler = () => {
            if (!_active || _stream) return;
            navigator.mediaDevices.enumerateDevices().then(devices => {
                if (devices.some(d => d.kind === 'videoinput')) _startCamera();
            }).catch(() => {});
        };
        navigator.mediaDevices.addEventListener('devicechange', deviceHandler);
        _overlayEl._deviceHandler = deviceHandler;

        // Tap-to-focus
        _videoEl.addEventListener('click', async e => {
            if (!_stream) return;
            const track = _stream.getVideoTracks()[0];
            const caps  = track.getCapabilities?.() || {};
            if (!caps.pointOfInterest) return;
            const rect = _videoEl.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top)  / rect.height;
            try {
                await track.applyConstraints({ advanced: [{ pointOfInterest: {x,y}, focusMode: 'single-shot' }] });
                const ring = document.createElement('div');
                ring.style.cssText = `position:fixed;left:${e.clientX-22}px;top:${e.clientY-22}px;
                    width:44px;height:44px;border-radius:50%;border:2px solid #fff;
                    pointer-events:none;animation:xpos-tap-ring .5s ease-out forwards;z-index:100001;`;
                document.body.appendChild(ring);
                setTimeout(() => ring.remove(), 500);
                setTimeout(async () => {
                    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch(_){}
                }, 2000);
            } catch (_) {}
        });
    }

    function _removeOverlay() {
        if (_overlayEl) {
            if (_overlayEl._deviceHandler) {
                navigator.mediaDevices.removeEventListener('devicechange', _overlayEl._deviceHandler);
            }
            _overlayEl.remove();
            _overlayEl = null;
        }
    }

    function _setStatus(msg, cls = '') {
        const el = document.getElementById('xpos-status');
        if (!el) return;
        el.textContent = msg;
        el.className   = cls;
    }

    function _flashGreen() {
        const el = document.getElementById('xpos-result-flash');
        if (!el) return;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 220);
    }

    // ── Camera constraints — per device ───────────────────────────────────────
    function _buildConstraints() {
        if (IS_IOS) {
            // iOS Safari: use exact facingMode. No min constraints — they cause
            // OverconstrainedError on some iPhones. Resolution + advanced settings
            // are applied AFTER the 2250ms warm-up in _applyIOSPostInitConstraints.
            return {
                video: {
                    facingMode: { exact: 'environment' },
                    width:  { ideal: 1000 },
                    height: { ideal: 1000 },
                }
            };
        }
        if (IS_ANDROID) {
            return {
                video: {
                    facingMode: { ideal: _facingMode },
                    width:  { ideal: 1280, min: 640 },
                    height: { ideal: 720,  min: 480 },
                    frameRate: { ideal: 30 },
                }
            };
        }
        // Desktop — request the highest resolution the webcam supports.
        // Higher resolution = more pixels per barcode bar = much better decode rate.
        // Most laptop webcams support up to 1920×1080; we ask for that as ideal.
        return {
            video: {
                facingMode: { ideal: _facingMode },
                width:  { ideal: 1920, min: 640 },
                height: { ideal: 1080, min: 480 },
                frameRate: { ideal: 30, min: 10 },
            }
        };
    }

    // iOS: wait 2250ms then apply zoom + focusDistance + frameRate
    // Fired async — does not block the scan loop from starting
    async function _applyIOSPostInitConstraints() {
        await new Promise(r => setTimeout(r, 2250));
        if (!_stream || !_active) return;  // closed during the wait
        try {
            const track = _stream.getVideoTracks()[0];
            const caps  = track.getCapabilities?.() || {};

            // Cap zoom at 2x — higher zoom causes blur on iPhone
            const maxZoom = caps.zoom?.max || 1;
            const zoomVal = maxZoom > 2 ? 2.0 : maxZoom;

            const advanced = [];
            if (caps.zoom)          advanced.push({ zoom: zoomVal });
            if (caps.focusDistance) advanced.push({ focusDistance: 1 }); // close focus for labels

            const c = {
                width:     { ideal: 1000 },
                height:    { ideal: 1000 },
                frameRate: { ideal: caps.frameRate?.max || 30 },
            };
            if (advanced.length) c.advanced = advanced;

            await track.applyConstraints(c);
            console.log('[Scanner] iOS post-init constraints applied — zoom:', zoomVal);
        } catch (e) {
            // Non-fatal — camera is still running, just without optimal settings
            console.warn('[Scanner] iOS post-init constraints failed:', e.message);
        }
    }

    // Android: request continuous autofocus after stream is live
    async function _applyAndroidPostInitConstraints() {
        if (!_stream) return;
        try {
            const track = _stream.getVideoTracks()[0];
            const caps  = track.getCapabilities?.() || {};
            const advanced = [];
            if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
            if (caps.pointOfInterest) advanced.push({ pointOfInterest: { x: 0.5, y: 0.5 } });
            if (advanced.length) await track.applyConstraints({ advanced });
        } catch (e) {
            console.warn('[Scanner] Android autofocus constraint failed:', e.message);
        }
    }

    // Desktop: push to the maximum resolution the webcam supports.
    // getUserMedia starts at a negotiated resolution; applyConstraints can go higher.
    // More pixels per barcode bar = dramatically better decode rate on laptop webcams.
    async function _applyDesktopPostInitConstraints() {
        if (!_stream) return;
        try {
            const track = _stream.getVideoTracks()[0];
            const caps  = track.getCapabilities?.() || {};
            const maxW   = caps.width?.max   || 1920;
            const maxH   = caps.height?.max  || 1080;
            const maxFPS = caps.frameRate?.max || 30;
            await track.applyConstraints({
                width:     { ideal: maxW },
                height:    { ideal: maxH },
                frameRate: { ideal: maxFPS },
            });
            const settings = track.getSettings?.() || {};
            console.log('[Scanner] Desktop resolution:', settings.width, 'x', settings.height,
                        '@', settings.frameRate?.toFixed(0), 'fps');
        } catch (e) {
            console.warn('[Scanner] Desktop resolution boost failed (non-fatal):', e.message);
        }
    }

    // ── Camera start ──────────────────────────────────────────────────────────
    async function _startCamera() {
        _setStatus('Requesting camera…');

        try {
            _stream = await navigator.mediaDevices.getUserMedia(_buildConstraints());
        } catch (e) {
            if (IS_IOS && e.name !== 'NotAllowedError') {
                // exact facingMode may fail on some iPads — retry without exact
                try {
                    _stream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: 'environment', width: { ideal: 1000 }, height: { ideal: 1000 } }
                    });
                } catch (_) {
                    try   { _stream = await navigator.mediaDevices.getUserMedia({ video: true }); }
                    catch (err) { return _handleCameraError(err); }
                }
            } else if (e.name !== 'NotAllowedError') {
                try   { _stream = await navigator.mediaDevices.getUserMedia({ video: true }); }
                catch (err) { return _handleCameraError(err); }
            } else {
                return _handleCameraError(e);
            }
        }

        _videoEl.srcObject = _stream;
        _videoEl.setAttribute('playsinline', '');
        _videoEl.setAttribute('muted', '');
        _videoEl.setAttribute('autoplay', '');

        // Wait for first valid frame
        await new Promise(resolve => {
            const check = () => {
                if (_videoEl.videoWidth > 0 && _videoEl.videoHeight > 0) resolve();
                else setTimeout(check, 50);
            };
            _videoEl.addEventListener('loadedmetadata', check, { once: true });
            _videoEl.addEventListener('canplay',        check, { once: true });
            setTimeout(resolve, 3000);
        });

        try { await _videoEl.play(); } catch (_) {}

        // Per-device post-init tuning
        if (IS_IOS) {
            _applyIOSPostInitConstraints(); // async fire-and-forget (2250ms delay inside)
        } else if (IS_ANDROID) {
            await _applyAndroidPostInitConstraints();
        } else {
            // Desktop: push to max resolution after stream starts
            await _applyDesktopPostInitConstraints();
        }

        // Update torch / focus buttons
        const track = _stream.getVideoTracks()[0];
        const caps  = track.getCapabilities?.() || {};
        _torchSupport = !!caps.torch;

        const torchBtn = document.getElementById('xpos-torch-btn');
        if (torchBtn) torchBtn.style.display = _torchSupport ? 'flex' : 'none';
        const focusBtn = document.getElementById('xpos-focus-btn');
        if (focusBtn) focusBtn.style.display = (caps.focusMode?.length || caps.pointOfInterest) ? 'flex' : 'none';

        await _initDecoder();
        _setStatus('Scanning…');
        _scanLoop();
    }

    function _handleCameraError(err) {
        let msg, canRetry = true;
        if (err.name === 'NotAllowedError') {
            msg = 'Camera permission denied. Allow camera in browser settings and try again.';
            canRetry = false;
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            msg = 'No camera found. Connect a camera or use a USB/Bluetooth barcode scanner.';
        } else if (err.name === 'NotReadableError') {
            msg = 'Camera is in use by another app. Close it and retry.';
        } else if (err.name === 'OverconstrainedError') {
            msg = 'Camera not compatible — try a different camera via switch button.';
        } else {
            msg = `Camera error: ${err.message || err.name}`;
        }
        _setStatus(msg, 'error');
        _onError(msg);

        // Add retry + manual entry buttons
        const statusEl = document.getElementById('xpos-status');
        if (statusEl) {
            const btnWrap = document.createElement('div');
            btnWrap.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap;';
            if (canRetry) {
                const retry = document.createElement('button');
                retry.textContent = 'Retry Camera';
                retry.style.cssText = 'background:#3b82f6;color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:13px;cursor:pointer;font-weight:600;';
                retry.onclick = () => { btnWrap.remove(); _startCamera(); };
                btnWrap.appendChild(retry);
            }
            const manualBtn = document.createElement('button');
            manualBtn.textContent = 'Enter Barcode Manually';
            manualBtn.style.cssText = 'background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px 20px;font-size:13px;cursor:pointer;font-weight:600;';
            manualBtn.onclick = () => {
                const code = prompt('Enter barcode:');
                if (code && code.trim()) {
                    _handleResult(code.trim(), 'MANUAL');
                    api.close();
                }
            };
            btnWrap.appendChild(manualBtn);
            statusEl.after(btnWrap);
        }
    }

    function _stopCamera() {
        if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }

        // Stop every track first
        if (_stream) {
            _stream.getTracks().forEach(t => t.stop());
            _stream = null;
        }

        // Detach stream from the video element.
        // This is the critical step — Chrome/Edge keep the camera LED on and
        // hold the device open as long as ANY video element still references
        // the stream, even after all tracks are stopped. Setting srcObject to
        // null releases the device immediately.
        if (_videoEl) {
            _videoEl.pause();
            _videoEl.srcObject = null;
            // load() resets the element's internal state, preventing a stale
            // frame from briefly flickering if the overlay is reopened quickly.
            try { _videoEl.load(); } catch (_) {}
        }

        // Release html5-qrcode internal resources
        if (_h5scanner) {
            try { _h5scanner.clear(); } catch (_) {}
            _h5scanner = null;
        }
        // Reset jsQR flag
        _jsqr = null;
    }

    // ── Decoder init ──────────────────────────────────────────────────────────
    async function _initDecoder() {
        // 1. Native BarcodeDetector — Chrome / Edge / Android Chrome (fastest, GPU)
        if ('BarcodeDetector' in window) {
            try {
                const formats   = _disableQR ? BARCODE_ONLY_FORMATS : NATIVE_FORMATS;
                const supported = await BarcodeDetector.getSupportedFormats();
                const filtered  = formats.filter(f => supported.includes(f));
                _detector  = new BarcodeDetector({ formats: filtered.length ? filtered : supported });
                _useNative = true;
                console.log('[Scanner] Native BarcodeDetector active');
                return;
            } catch (e) {
                console.warn('[Scanner] BarcodeDetector init failed:', e.message);
            }
        }

        // 2. jsQR — iOS Safari primary decoder
        // jsQR takes raw ImageData pixels directly from canvas.getImageData().
        // This completely avoids:
        //   - toBlob() async overhead (50-150ms per frame on iOS)
        //   - Object URL creation/revocation
        //   - The img.onload race condition inside html5-qrcode on iOS Safari
        //   - Canvas cross-origin security restrictions
        // On iPhone 11 Pro with a 1000×1000 frame, jsQR decodes in ~8ms.
        if (IS_IOS && window.jsQR) {
            _jsqr = true;
            _useNative = false;
            console.log('[Scanner] jsQR active (iOS)');
            return;
        }

        // 3. html5-qrcode — desktop Firefox and older browsers
        // NOT used on iOS — blob/URL approach has too many iOS Safari issues.
        if (!IS_IOS && window.Html5Qrcode) {
            try {
                let helperEl = document.getElementById(H5_DIV_ID);
                if (!helperEl) {
                    helperEl = document.createElement('div');
                    helperEl.id    = H5_DIV_ID;
                    helperEl.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
                    document.body.appendChild(helperEl);
                }
                _h5scanner = new Html5Qrcode(H5_DIV_ID, { verbose: false });
                _useNative = false;
                console.log('[Scanner] html5-qrcode active (Desktop/Android fallback)');
            } catch (e) {
                console.warn('[Scanner] html5-qrcode init failed:', e.message);
                _h5scanner = null;
            }
        }

        // Last resort for iOS if jsQR somehow not loaded — try html5-qrcode anyway
        if (IS_IOS && !_jsqr && window.Html5Qrcode) {
            try {
                let helperEl = document.getElementById(H5_DIV_ID);
                if (!helperEl) {
                    helperEl = document.createElement('div');
                    helperEl.id    = H5_DIV_ID;
                    helperEl.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
                    document.body.appendChild(helperEl);
                }
                _h5scanner = new Html5Qrcode(H5_DIV_ID, { verbose: false });
                _useNative = false;
                console.log('[Scanner] html5-qrcode active (iOS fallback — jsQR not loaded)');
            } catch (e) { _h5scanner = null; }
        }

        if (!_detector && !_jsqr && !_h5scanner) {
            console.warn('[Scanner] No software decoder — hardware scanner only');
        }
    }

    // ── Scan loop ─────────────────────────────────────────────────────────────
    // Per-device decode strategy:
    //   iOS     → jsQR via raw ImageData (synchronous pixel decode, ~8ms/frame)
    //   Android → Native BarcodeDetector (GPU, fastest)
    //   Desktop → Native BarcodeDetector + html5-qrcode fallback with enhancement

    // iOS: attempt decode every 100ms — jsQR is fast enough, and more attempts
    // compensate for iPhone autofocus micro-adjustments between frames.
    const NATIVE_EVERY  = IS_DESKTOP ? 1 : 2;
    const JSQR_INTERVAL = 100;   // iOS jsQR interval ms
    const H5_INTERVAL   = IS_DESKTOP ? 120 : 150;

    let _frameCount = 0;
    let _lastScanAt = 0;
    let _h5Busy     = false;
    let _jsqrBusy   = false;

    function _scanLoop() {
        if (!_active) return;
        _animFrame = requestAnimationFrame(async () => {
            if (_useNative && IS_DESKTOP) {
                // Desktop: native every frame + h5 fallback with enhancement
                _frameCount++;
                if (_frameCount % NATIVE_EVERY === 0) {
                    const found = await _decodeNative();
                    if (!found && _h5scanner && !_h5Busy) {
                        await _decodeH5(true);
                    }
                }
            } else if (_useNative) {
                // Android native BarcodeDetector
                _frameCount++;
                if (_frameCount % NATIVE_EVERY === 0) await _decodeNative();
            } else if (_jsqr) {
                // iOS — jsQR direct ImageData decode
                const now = performance.now();
                if (!_jsqrBusy && now - _lastScanAt >= JSQR_INTERVAL) {
                    _lastScanAt = now;
                    _decodeJsQR();
                }
            } else if (_h5scanner) {
                // Desktop Firefox / iOS jsQR fallback
                const now = performance.now();
                if (!_h5Busy && now - _lastScanAt >= H5_INTERVAL) {
                    _lastScanAt = now;
                    await _decodeH5(IS_DESKTOP);
                }
            }
            if (_active) _scanLoop();
        });
    }

    // Returns true if a barcode was found
    async function _decodeNative() {
        if (!_videoEl || _videoEl.readyState < 2 || !_detector) return false;
        try {
            const results = await _detector.detect(_videoEl);
            if (results.length) {
                _handleResult(results[0].rawValue, results[0].format);
                return true;
            }
        } catch (_) {}
        return false;
    }

    // iOS jsQR decode — synchronous, operates on raw ImageData pixels.
    // No blob, no URL, no async image load. On iPhone 11 Pro this takes ~8ms.
    // readyState >= 1 (HAVE_METADATA) is sufficient — iOS Safari sometimes
    // stalls at 1 even while frames are flowing; videoWidth > 0 confirms frames.
    function _decodeJsQR() {
        if (!_videoEl || !window.jsQR) return;
        if (_videoEl.videoWidth === 0 || _videoEl.videoHeight === 0) return;
        // Accept readyState >= 1 on iOS (can stay at HAVE_METADATA while streaming)
        if (_videoEl.readyState < 1) return;
        _jsqrBusy = true;
        try {
            const w = _videoEl.videoWidth;
            const h = _videoEl.videoHeight;
            _canvasEl.width  = w;
            _canvasEl.height = h;
            _ctx.drawImage(_videoEl, 0, 0, w, h);

            // Apply iOS-specific pre-processing before jsQR:
            // Convert to greyscale + contrast boost. Barcodes are 1D so colour is noise.
            // Also handles the iPhone's tendency to over-expose product labels.
            _preprocessForJsQR(_canvasEl, _ctx, w, h);

            const imageData = _ctx.getImageData(0, 0, w, h);

            // jsQR signature: jsQR(data, width, height, options)
            // inversionAttempts: 'attemptBoth' handles dark-on-light AND light-on-dark barcodes
            const result = window.jsQR(imageData.data, w, h, {
                inversionAttempts: 'attemptBoth',
            });

            if (result && result.data) {
                _handleResult(result.data, 'QR_CODE');
            }
        } catch (e) {
            // Swallow — canvas not ready, video frame unavailable, etc.
        } finally {
            _jsqrBusy = false;
        }
    }

    // Pre-process canvas for jsQR on iOS:
    // 1. Greyscale — barcodes are 1D, colour is noise
    // 2. Auto-level: stretch the actual min→max range to 0→255 (handles dim rooms)
    // 3. Contrast stretch (1.6×) centred on greyscale mid-point
    // 4. Adaptive threshold binarisation — makes bars pure black on pure white
    //    using integral image for fast local mean (15×15 window, offset -10)
    // This dramatically improves detection on iOS in low-light conditions.
    function _preprocessForJsQR(canvas, ctx, w, h) {
        try {
            const imageData = ctx.getImageData(0, 0, w, h);
            const d = imageData.data;
            const lum = new Uint8Array(w * h);
            const n = w * h;

            let minL = 255, maxL = 0;
            for (let i = 0, p = 0; i < d.length; i += 4, p++) {
                const l = (d[i] * 77 + d[i+1] * 150 + d[i+2] * 29) >> 8;
                lum[p] = l;
                if (l < minL) minL = l;
                if (l > maxL) maxL = l;
            }

            const range = maxL - minL || 1;
            const f = 1.6;
            for (let p = 0; p < n; p++) {
                let v = ((lum[p] - minL) / range) * 255;
                v = Math.min(255, Math.max(0, f * (v - 128) + 128));
                lum[p] = v;
            }

            // Adaptive threshold (15×15 local window, offset -10)
            const WIN = 15, HALF = WIN >> 1, OFFSET = 10;
            const out = new Uint8Array(n);
            const integ = new Int32Array((w + 1) * (h + 1));
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    integ[(y+1)*(w+1)+(x+1)] = lum[y*w+x] + integ[y*(w+1)+(x+1)] + integ[(y+1)*(w+1)+x] - integ[y*(w+1)+x];
                }
            }
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const x1 = Math.max(0, x - HALF), y1 = Math.max(0, y - HALF);
                    const x2 = Math.min(w, x + HALF), y2 = Math.min(h, y + HALF);
                    const count = (x2 - x1) * (y2 - y1);
                    const sum = integ[y2*(w+1)+x2] - integ[y1*(w+1)+x2] - integ[y2*(w+1)+x1] + integ[y1*(w+1)+x1];
                    const mean = sum / count;
                    out[y*w+x] = lum[y*w+x] < mean - OFFSET ? 0 : 255;
                }
            }

            for (let p = 0; p < n; p++) {
                const v = out[p];
                d[p*4] = d[p*4+1] = d[p*4+2] = v;
                d[p*4+3] = 255;
            }
            ctx.putImageData(imageData, 0, 0);
        } catch (_) {}
    }

    // enhance=true: apply full adaptive threshold — helps noisy laptop webcams
    async function _decodeH5(enhance) {
        if (!_videoEl || !_h5scanner) return;
        if (_videoEl.videoWidth === 0 || _videoEl.videoHeight === 0) return;
        if (_videoEl.readyState < 1) return;
        _h5Busy = true;
        try {
            _canvasEl.width  = _videoEl.videoWidth;
            _canvasEl.height = _videoEl.videoHeight;
            _ctx.drawImage(_videoEl, 0, 0);

            if (enhance) _enhanceFrame(_canvasEl, _ctx);

            const blob = await new Promise(res => _canvasEl.toBlob(res, 'image/jpeg', 0.92));
            if (!blob || !_active) return;

            const url = URL.createObjectURL(blob);
            try {
                const result = await _h5scanner.scanFileV2(url, false);
                if (result?.decodedText) {
                    _handleResult(result.decodedText, result.result?.format?.formatName || '');
                }
            } catch (_) {
                // NotFoundException — no barcode in frame, expected
            } finally {
                URL.revokeObjectURL(url);
            }
        } catch (_) {
            // Swallow: partial frame, canvas not ready, etc.
        } finally {
            _h5Busy = false;
        }
    }

    // Frame enhancement for laptop webcams:
    //  1. Convert to greyscale — barcode decoders only need luminance, colour adds noise
    //  2. Auto-level: stretch the actual min→max range to 0→255 (handles dim rooms)
    //  3. Contrast stretch (1.6×) centred on the greyscale mid-point
    //  4. Adaptive threshold binarisation — makes bars pure black on pure white
    // No CSS filters — they are unreliable across browsers and add a redraw round-trip.
    function _enhanceFrame(canvas, ctx) {
        try {
            const w = canvas.width, h = canvas.height;
            const imageData = ctx.getImageData(0, 0, w, h);
            const d = imageData.data;
            const n = d.length;

            // Step 1 + 2: greyscale + find actual min/max luminance
            const lum = new Uint8Array(w * h);
            let minL = 255, maxL = 0;
            for (let i = 0, p = 0; i < n; i += 4, p++) {
                // Luminance weights: R 0.299, G 0.587, B 0.114
                const l = (d[i] * 77 + d[i+1] * 150 + d[i+2] * 29) >> 8;
                lum[p] = l;
                if (l < minL) minL = l;
                if (l > maxL) maxL = l;
            }

            // Step 3: auto-level stretch + contrast boost
            const range = maxL - minL || 1;
            const f = 1.6;  // contrast factor after levelling
            for (let p = 0; p < lum.length; p++) {
                // Auto-level: map minL→0, maxL→255
                let v = ((lum[p] - minL) / range * 255);
                // Contrast stretch centred on 128
                v = Math.min(255, Math.max(0, f * (v - 128) + 128));
                lum[p] = v;
            }

            // Step 4: adaptive threshold (local mean over 15×15 window, offset -10)
            // This binarises the image to pure black/white which decoders love
            const WIN = 15, HALF = WIN >> 1, OFFSET = 10;
            const out = new Uint8Array(w * h);
            // Build integral image for fast local mean
            const integ = new Int32Array((w + 1) * (h + 1));
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    integ[(y+1)*(w+1)+(x+1)] =
                        lum[y*w+x]
                        + integ[y*(w+1)+(x+1)]
                        + integ[(y+1)*(w+1)+x]
                        - integ[y*(w+1)+x];
                }
            }
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const x1 = Math.max(0, x - HALF), y1 = Math.max(0, y - HALF);
                    const x2 = Math.min(w, x + HALF), y2 = Math.min(h, y + HALF);
                    const count = (x2 - x1) * (y2 - y1);
                    const sum   = integ[y2*(w+1)+x2] - integ[y1*(w+1)+x2]
                                - integ[y2*(w+1)+x1] + integ[y1*(w+1)+x1];
                    const mean  = sum / count;
                    out[y*w+x]  = lum[y*w+x] < mean - OFFSET ? 0 : 255;
                }
            }

            // Write back as greyscale RGBA
            for (let p = 0; p < out.length; p++) {
                const v = out[p];
                d[p*4] = d[p*4+1] = d[p*4+2] = v;
                d[p*4+3] = 255;
            }
            ctx.putImageData(imageData, 0, 0);
        } catch (_) {
            // Enhancement failed — original frame on canvas, decode continues anyway
        }
    }

    // ── Result handler ────────────────────────────────────────────────────────
    function _handleResult(code, format) {
        if (!code) return;
        const now = Date.now();
        if (code === _lastResult && now - _lastTime < DEBOUNCE_MS) return;

        _lastResult = code;
        _lastTime   = now;

        _flashGreen();
        _setStatus(`✓ ${code}`, 'success');
        if (navigator.vibrate) navigator.vibrate([50, 20, 50]);
        _beep();
        setTimeout(() => { if (_active) _setStatus('Scanning…'); }, 1500);

        _onResult(code, format);

        if (_target === 'pos') setTimeout(_updatePOSCartSummary, 400);
    }

    // ── POS cart summary ──────────────────────────────────────────────────────
    function _updatePOSCartSummary() {
        const el = document.getElementById('xpos-cart-summary');
        if (!el) return;
        const cart = window.AppState?.cart || [];
        const totalItems  = cart.reduce((s, i) => s + (i.quantity || 1), 0);
        const uniqueItems = cart.length;
        el.innerHTML = uniqueItems === 0
            ? 'Cart is empty — scan products to add them'
            : `<span style="color:#4ade80;font-weight:600;">✓ ${uniqueItems} product${uniqueItems!==1?'s':''} · ${totalItems} unit${totalItems!==1?'s':''} in cart</span>`;
    }

    // ── Beep ──────────────────────────────────────────────────────────────────
    let _audioCtx = null;
    function _beep() {
        try {
            if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const osc  = _audioCtx.createOscillator();
            const gain = _audioCtx.createGain();
            osc.connect(gain);
            gain.connect(_audioCtx.destination);
            osc.type            = 'sine';
            osc.frequency.value = 1480;
            gain.gain.setValueAtTime(0.3, _audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.15);
            osc.start(_audioCtx.currentTime);
            osc.stop(_audioCtx.currentTime + 0.15);
        } catch (_) {}
    }

    // ── Hardware scanner (USB / Bluetooth keyboard-wedge) ─────────────────────
    let _hwBuffer = '';
    let _hwTimer  = null;
    const HW_TIMEOUT = 100;

    function _initHardwareScanner() {
        document.addEventListener('keydown', e => {
            const tag       = document.activeElement?.tagName;
            const isInput   = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
            const isHWInput = document.activeElement?.classList?.contains('xpos-barcode-hw');

            if (e.key === 'Enter') {
                if (_hwBuffer.length >= 3) {
                    const code = _hwBuffer.trim();
                    _hwBuffer = '';
                    clearTimeout(_hwTimer);
                    if (!isInput || isHWInput) {
                        e.preventDefault();
                        if (_active && _onResult) {
                            _flashGreen();
                            _setStatus(`✓ ${code}`, 'success');
                            if (navigator.vibrate) navigator.vibrate([50, 20, 50]);
                            _beep();
                            setTimeout(() => { if (_active) _setStatus('Scanning…'); }, 1500);
                            _onResult(code, 'SCANNER');
                        } else {
                            _triggerBarcode(code);
                        }
                    }
                }
                return;
            }

            if (!isInput || isHWInput) {
                if (e.key && e.key.length === 1) {
                    _hwBuffer += e.key;
                    clearTimeout(_hwTimer);
                    _hwTimer = setTimeout(() => { _hwBuffer = ''; }, HW_TIMEOUT * 8);
                }
            }
        });
    }

    function _triggerBarcode(code) {
        const posPage = document.getElementById('posPage');
        if (posPage?.classList.contains('active')) {
            document.dispatchEvent(new CustomEvent('xpos:barcode', { detail: { code } }));
            return;
        }
        if (window.QuickUpdate && document.getElementById('quickUpdateModal')?.classList.contains('active')) {
            window.QuickUpdate.handleBarcodeInput(code);
            return;
        }
        if (window.FastScan && document.getElementById('fastScanModal')?.classList.contains('active')) {
            window.FastScan.handleHWBarcode?.(code);
            return;
        }
    }

    _initHardwareScanner();

    return api;
})();
