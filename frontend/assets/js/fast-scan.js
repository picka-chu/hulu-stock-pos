/**
 * Hulu Stock Fast Scan  v1.0
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  The goal: scan many products as fast as possible. Zero AI wait time.
 *
 *  FLOW:
 *  ┌─────────────┐   instant    ┌──────────────┐   tap Next   ┌────────────┐
 *  │  Scan BC    │ ──────────▶  │ Expiry photo │ ──────────▶  │ Fill price │
 *  │ (XScanner)  │              │ (no delay)   │              │ stock, sup │
 *  └─────────────┘              └──────────────┘              └─────┬──────┘
 *                                                                    │ tap Next
 *                                                          ┌─────────▼──────┐
 *                                                          │ Item CREATED   │
 *                                                          │ ai_status=     │
 *                                                          │ pending_ai     │
 *                                                          │ Added to queue │
 *                                                          └─────────┬──────┘
 *                                                                    │
 *                                                   Scan another ◀──┤ or
 *                                                                    │ tap Done
 *                                                          ┌─────────▼──────┐
 *                                                          │ Batch Gemini   │
 *                                                          │ request (1 API │
 *                                                          │ call for all)  │
 *                                                          └─────────┬──────┘
 *                                                                    │
 *                                                          ┌─────────▼──────┐
 *                                                          │ All items      │
 *                                                          │ updated in DB  │
 *                                                          │ ai_status=     │
 *                                                          │ completed      │
 *                                                          └────────────────┘
 *
 *  Camera strategy:
 *  - Barcode: XScanner (native BarcodeDetector → ZXing fallback, 80ms loop)
 *  - Expiry:  Dedicated <video> already running — no camera re-init delay
 *             Camera warms up during barcode scan so it's ready instantly.
 *
 *  Performance targets:
 *  - Barcode detection:  < 200 ms after pointing
 *  - Expiry capture:     0 ms delay (tap = frame captured immediately)
 *  - Item creation:      < 800 ms (one DB insert + optional image upload)
 *  - Per-item scan loop: < 3 seconds total user time
 * ══════════════════════════════════════════════════════════════════════════════
 */
'use strict';

window.FastScan = (() => {

  /* ── Modal ID ───────────────────────────────────────────────────────────── */
  const MODAL_ID = 'fastScanModal';

  /* ── Session state ──────────────────────────────────────────────────────── */
  const SESSION = {
    queue:           [],     // [{item_id, barcode, expiry_image_b64, name}]
    branchId:        null,   // locked at open() — never drifts mid-session
    cameraAvailable: null,   // null = unknown, true/false = detected
    current: {
      barcode:       null,
      expiryB64:     null,
      phase:         'barcode',   // 'barcode' | 'expiry' | 'details'
    },
    expiryStream:  null,   // MediaStream kept alive
    expiryVideo:   null,   // <video> element reference
    expiryCanvas:  null,   // <canvas> for capture
    processing:    false,
  };

  /* ── Phase IDs ──────────────────────────────────────────────────────────── */
  const PH = {
    barcode:  'fsPhaseBarcode',
    expiry:   'fsPhaseExpiry',
    details:  'fsPhaseDetails',
    done:     'fsPhaseDone',
  };

  /* ════════════════════════════════════════════════════════════════════════
   *  OPEN / CLOSE
   * ════════════════════════════════════════════════════════════════════════ */

  async function _showBranchPicker() {
    // Called when Fast Scan opens with no branch selected.
    // Shows a branch selection overlay inside the modal so user must pick before scanning.
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    // Build branch options from AppState or fetch fresh
    let branches = [];
    try {
        const res = await window.BranchesAPI.list({ active_only: true });
        branches = Array.isArray(res) ? res : [];
    } catch (e) {
        branches = [];
    }

    if (!branches.length) {
        showToast('No active branches found — contact your administrator', 'error');
        // Close modal since we can't proceed
        modal.classList.remove('active');
        modal.style.display = 'none';
        return;
    }

    // Inject picker UI into the modal body
    const body = modal.querySelector('.modal-body') || modal.querySelector('div');
    if (!body) return;

    const picker = document.createElement('div');
    picker.id = 'fsBranchPicker';
    picker.style.cssText = 'padding:24px 16px;text-align:center;';
    picker.innerHTML = `
        <div style="font-size:2rem;margin-bottom:12px;">🏪</div>
        <h3 style="font-size:15px;font-weight:700;color:var(--text-1);margin-bottom:6px;">Select a Branch</h3>
        <p style="font-size:12px;color:var(--text-3);margin-bottom:18px;line-height:1.5;">
            Choose which branch these items belong to before scanning.
        </p>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
            ${branches.map(b => `
                <button onclick="window.FastScan._pickBranch('${b.id}','${(b.name||'').replace(/'/g,"\\'")}','${b.is_active}')"
                    style="padding:12px 16px;border-radius:var(--radius);
                           border:1.5px solid var(--border);background:var(--surface);
                           color:var(--text-1);font-size:14px;font-weight:600;
                           cursor:pointer;text-align:left;transition:var(--transition);"
                    onmouseover="this.style.borderColor='var(--primary)';this.style.background='var(--primary-ultra,#eff6ff)'"
                    onmouseout="this.style.borderColor='var(--border)';this.style.background='var(--surface)'">
                    <i class="fas fa-code-branch" style="color:var(--primary);margin-right:8px;"></i>
                    ${b.name}
                </button>
            `).join('')}
        </div>
        <button onclick="window.FastScan.close()"
            style="background:none;border:none;color:var(--text-3);font-size:12px;cursor:pointer;">
            Cancel
        </button>`;

    // Hide the scanner phases, show picker
    modal.querySelectorAll('.fs-phase').forEach(el => el.style.display = 'none');
    body.prepend(picker);
  }

  function _pickBranch(branchId, branchName, isActive) {
    if (isActive === 'false') {
        showToast(`Branch "${branchName}" is deactivated — choose another`, 'error');
        return;
    }
    // Set the branch in AppState and session
    if (!window.AppState) window.AppState = {};
    window.AppState.branch = { id: branchId, name: branchName, is_active: true };
    SESSION.branchId = branchId;

    // Remove picker, show scanner
    const picker = document.getElementById('fsBranchPicker');
    if (picker) picker.remove();

    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.querySelectorAll('.fs-phase').forEach(el => el.style.display = '');

    showToast(`Branch set to ${branchName}`, 'success');

    // Now actually start scanning
    _showPhase('barcode');
    _startBarcodeScanner();
    _ensureSuppliers();
  }

  async function open() {
    _resetSession();
    const modal = document.getElementById(MODAL_ID);
    if (!modal) { console.error('[FastScan] Modal not found'); return; }
    modal.classList.add('active');
    modal.style.display = 'flex';   // force flex — empty string unreliable vs inline style

    // Lock branch at open() time — can't drift if admin switches branch mid-session
    SESSION.branchId = window.AppState?.branch?.id
                    || window.AppState?.currentUser?.branch_id
                    || null;

    // If no branch selected, show inline branch picker BEFORE allowing scan
    // This prevents items being created with branch_id=null
    if (!SESSION.branchId) {
        const role = window.AppState?.currentUser?.role;
        if (role && role !== 'cashier') {
            // Show branch picker overlay inside the modal instead of proceeding
            _showBranchPicker();
            return;  // don't start scanning until branch is chosen
        }
    }

    // Check camera availability
    SESSION.cameraAvailable = await _checkCameraAvailable();

    if (SESSION.cameraAvailable) {
        // Re-acquire element refs (they persist across sessions)
        SESSION.expiryVideo  = document.getElementById('fsExpiryVideo');
        SESSION.expiryCanvas = document.getElementById('fsExpiryCanvas');
        // Reset expiry UI so previous session's captured image never bleeds through
        _resetExpiryCaptureUI();
        // Warm up expiry camera immediately in background while user scans barcode
        _warmExpiryCamera();   // fire-and-forget
    } else {
        // No camera — hide the expiry photo phase, show hint
        const expiryPhase = document.getElementById('fsPhaseExpiry');
        if (expiryPhase) {
            const hint = expiryPhase.querySelector('#fsCameraUnavailableHint');
            if (!hint) {
                const h = document.createElement('div');
                h.id = 'fsCameraUnavailableHint';
                h.style.cssText = 'padding:12px 16px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:10px;font-size:13px;color:#f59e0b;margin-top:8px;text-align:center;';
                h.innerHTML = '<i class="fas fa-camera-slash" style="margin-right:6px;"></i>No camera detected — expiry date step will be skipped.<br><span style="font-size:11px;opacity:.8;">You can enter the expiry date manually in the next step.</span>';
                expiryPhase.appendChild(h);
            }
        }
    }

    _showPhase('barcode');
    _startBarcodeScanner();
    _ensureSuppliers();
  }

  // Check if camera is available (non-blocking)
  async function _checkCameraAvailable() {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.some(d => d.kind === 'videoinput');
    } catch {
        return false;
    }
  }

  function close() {
    _stopExpiryCamera();
    window.XScanner?.close();
    const modal = document.getElementById(MODAL_ID);
    if (modal) {
        modal.classList.remove('active');
        modal.style.display = 'none';
    }
    // Delete any pending_ai items from DB that were queued but not processed
    // so they don't show up as orphaned "queued" items in the item list
    _cleanupPendingItems();
    _resetSession();
  }

  function _cleanupPendingItems() {
    if (!SESSION.queue || SESSION.queue.length === 0) return;
    // Fire-and-forget: delete each queued item from DB silently
    SESSION.queue.forEach(q => {
        if (q.item_id && !q.processed) {
            window.ItemsAPI?.delete(q.item_id).catch(() => {});
        }
    });
  }

  function _resetSession() {
    SESSION.queue   = [];
    SESSION.branchId = null;
    SESSION.current = { barcode: null, expiryB64: null, phase: 'barcode' };
    SESSION.processing = false;
    _updateQueueBadge();
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  PHASE SWITCHER
   * ════════════════════════════════════════════════════════════════════════ */

  function _showPhase(name) {
    SESSION.current.phase = name;
    Object.values(PH).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    const el = document.getElementById(PH[name]);
    if (el) el.style.display = 'flex';
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  PHASE 1 — BARCODE SCAN  (XScanner overlay)
   * ════════════════════════════════════════════════════════════════════════ */

  function _startBarcodeScanner() {
    if (!window.XScanner) {
      _setBcHint('❌ Scanner not available — refresh the page');
      _addManualEntryBtn();
      return;
    }
    _setBcHint('Point camera at barcode…');
    // If scanner overlay is already open from a previous scan in this session,
    // just re-register the result callback — avoids camera restart delay
    if (window.XScanner.isOpen()) {
      window.XScanner.setOnResult?.((code) => {
        window.XScanner.close();
        SESSION.current.barcode = code;
        _onBarcodeScanned(code);
      });
      return;
    }
    window.XScanner.open({
      target: 'fast-scan',
      disableQR: true,
      onResult: (code) => {
        window.XScanner.close();
        SESSION.current.barcode = code;
        _onBarcodeScanned(code);
      },
      onError: (msg) => {
        _setBcHint('❌ ' + msg);
        _addManualEntryBtn();
      },
    });
  }

  function _addManualEntryBtn() {
    const area = document.getElementById('fsBcResult');
    if (!area) return;
    // Only add if not already present
    if (document.getElementById('fsManualEntryBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'fsManualEntryBtn';
    btn.innerHTML = '<i class="fas fa-keyboard"></i> Enter Barcode Manually';
    btn.style.cssText = 'display:flex;width:100%;margin-top:10px;padding:12px;border-radius:10px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.7);border:1px dashed rgba(255,255,255,.15);font-size:13px;font-weight:600;cursor:pointer;align-items:center;justify-content:center;gap:8px;';
    btn.onclick = () => {
      const code = prompt('Enter barcode:');
      if (code && code.trim()) {
        _onBarcodeScanned(code.trim());
      }
    };
    area.appendChild(btn);
  }

  function _setBcHint(msg) {
    const el = document.getElementById('fsBcHint');
    if (el) el.textContent = msg;
  }

  function _onBarcodeScanned(code) {
    const el = document.getElementById('fsBcResult');
    if (el) {
      el.style.display = 'block';
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:14px 16px;
             background:rgba(16,185,129,.08);border-top:1px solid rgba(16,185,129,.2);
             border-bottom:1px solid rgba(16,185,129,.2);">
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(16,185,129,.15);
                      flex-shrink:0;display:flex;align-items:center;justify-content:center;">
            <i class="fas fa-check" style="color:#10b981;font-size:14px;"></i>
          </div>
          <div>
            <p style="font-size:11px;color:#10b981;font-weight:700;margin:0;text-transform:uppercase;letter-spacing:.06em;">Barcode detected</p>
            <p style="font-size:15px;color:var(--text-1);font-weight:800;font-family:monospace;margin:2px 0 0;" id="_fsScannedCode"></p>
          </div>
        </div>`;
    }
    // Set barcode text safely (no XSS)
    const codeEl = document.getElementById('_fsScannedCode');
    if (codeEl) codeEl.textContent = code;
    // Skip expiry photo if no camera — go straight to details
    setTimeout(() => {
        if (SESSION.cameraAvailable === false) {
            _showPhase('details');
            _buildDetailsPanel();
        } else {
            _showPhase('expiry');
        }
    }, 350);
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  EXPIRY CAMERA — warm up during barcode scan, ready instantly
   * ════════════════════════════════════════════════════════════════════════ */

  async function _warmExpiryCamera() {
    if (SESSION.expiryStream) return;   // already running
    const v = SESSION.expiryVideo;
    if (!v) return;

    const isIOS     = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isAndroid = /Android/.test(navigator.userAgent);

    // Per-device constraints — mirrors the strategy in scanner.js
    let constraints;
    if (isIOS) {
      // iOS: exact facingMode required, no min constraints (cause OverconstrainedError)
      // Advanced settings (zoom, focusDistance, frameRate) applied after 2250ms warm-up
      constraints = {
        audio: false,
        video: {
          facingMode: { exact: 'environment' },
          width:  { ideal: 1000 },
          height: { ideal: 1000 },
        },
      };
    } else if (isAndroid) {
      constraints = {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1280, min: 640 },
          height: { ideal: 720,  min: 480 },
          frameRate: { ideal: 30 },
        },
      };
    } else {
      // Desktop
      constraints = {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1280, min: 640 },
          height: { ideal: 720,  min: 480 },
        },
      };
    }

    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        if (isIOS && e.name !== 'NotAllowedError') {
          // exact facingMode failed on some iPads — retry without exact
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { facingMode: 'environment', width: { ideal: 1000 }, height: { ideal: 1000 } },
            });
          } catch (_) {
            stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
          }
        } else {
          throw e;
        }
      }

      SESSION.expiryStream = stream;
      v.srcObject = stream;

      // Show/hide torch button based on capability
      const track2 = stream.getVideoTracks()[0];
      const caps2 = track2.getCapabilities?.() || {};
      const torchBtn = document.getElementById('fsTorchBtn');
      if (torchBtn) torchBtn.style.display = caps2.torch ? 'flex' : 'none';
      v.setAttribute('playsinline', '');  // iOS: prevent full-screen takeover
      v.setAttribute('muted', '');
      v.setAttribute('autoplay', '');

      // Wait for first valid frame
      await new Promise(resolve => {
        const check = () => {
          if (v.videoWidth > 0 && v.videoHeight > 0) resolve();
          else setTimeout(check, 50);
        };
        v.addEventListener('loadedmetadata', check, { once: true });
        v.addEventListener('canplay',        check, { once: true });
        setTimeout(resolve, 3000);
      });

      await v.play().catch(() => {});

      const track = stream.getVideoTracks()[0];
      const caps  = track.getCapabilities?.() || {};

      if (isIOS) {
        // iOS post-init: wait 2250ms then apply zoom cap + focusDistance
        // Fire-and-forget — camera is usable immediately, this just improves it
        (async () => {
          await new Promise(r => setTimeout(r, 2250));
          if (!SESSION.expiryStream) return;  // closed during wait
          try {
            const maxZoom = caps.zoom?.max || 1;
            const zoomVal = maxZoom > 2 ? 2.0 : maxZoom;
            const advanced = [];
            if (caps.zoom)          advanced.push({ zoom: zoomVal });
            if (caps.focusDistance) advanced.push({ focusDistance: 1 });
            const c = {
              width:     { ideal: 1000 },
              height:    { ideal: 1000 },
              frameRate: { ideal: caps.frameRate?.max || 30 },
            };
            if (advanced.length) c.advanced = advanced;
            await track.applyConstraints(c);
          } catch (_) { /* non-fatal */ }
        })();
      } else {
        // Android / Desktop: apply continuous autofocus immediately
        const advancedOpts = [];
        if (caps.focusMode?.includes('continuous')) advancedOpts.push({ focusMode: 'continuous' });
        else if (caps.focusMode?.includes('single')) advancedOpts.push({ focusMode: 'single' });
        if (caps.pointOfInterest) advancedOpts.push({ pointOfInterest: { x: 0.5, y: 0.5 } });
        if (advancedOpts.length) await track.applyConstraints({ advanced: advancedOpts }).catch(() => {});
      }

    } catch (err) {
      console.warn('[FastScan] expiry camera warm-up failed:', err.message);
    }
  }

  let _fsTorchOn = false;

  function toggleTorch() {
    if (!SESSION.expiryStream) return;
    _fsTorchOn = !_fsTorchOn;
    const track = SESSION.expiryStream.getVideoTracks()[0];
    track.applyConstraints({ advanced: [{ torch: _fsTorchOn }] }).catch(() => {});
    const btn = document.getElementById('fsTorchBtn');
    if (btn) btn.innerHTML = _fsTorchOn
      ? '<i class="fas fa-bolt" style="color:#fbbf24"></i>'
      : '<i class="fas fa-bolt"></i>';
  }

  function _stopExpiryCamera() {
    if (SESSION.expiryStream) {
      SESSION.expiryStream.getTracks().forEach(t => t.stop());
      SESSION.expiryStream = null;
    }
    if (SESSION.expiryVideo) {
      SESSION.expiryVideo.pause();
      SESSION.expiryVideo.srcObject = null;
      try { SESSION.expiryVideo.load(); } catch (_) {}
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  PHASE 2 — EXPIRY PHOTO CAPTURE
   * ════════════════════════════════════════════════════════════════════════ */

  async function captureExpiry() {
    const v = SESSION.expiryVideo;
    const c = SESSION.expiryCanvas;

    // If camera not ready yet, try to start it now
    if (!SESSION.expiryStream || !v?.srcObject) {
      await _warmExpiryCamera();
      await new Promise(r => setTimeout(r, 600));
    }

    if (!v || v.readyState < 2 || !v.videoWidth) {
      showToast('Camera not ready — try again', 'error'); return;
    }

    // Capture frame instantly
    c.width  = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const dataUrl = c.toDataURL('image/jpeg', 0.88);
    SESSION.current.expiryB64 = dataUrl.split(',')[1];

    // Show frozen frame
    v.style.display = 'none';
    c.style.display = 'block';

    // Haptic + visual feedback
    if (navigator.vibrate) navigator.vibrate(60);
    _flashCapture();

    // Show retake / next buttons
    const capBtn    = document.getElementById('fsExpCapBtn');
    const retakeBtn = document.getElementById('fsExpRetakeBtn');
    const nextBtn   = document.getElementById('fsExpNextBtn');
    if (capBtn)    capBtn.style.display    = 'none';
    if (retakeBtn) retakeBtn.style.display = 'flex';
    if (nextBtn)   nextBtn.style.display   = 'flex';

    // Chip confirmation
    const chip = document.getElementById('fsExpChip');
    if (chip) {
      chip.style.display = 'flex';
      chip.innerHTML = `<i class="fas fa-check-circle" style="color:#10b981;font-size:14px;"></i>
                        <span style="font-size:12px;color:#10b981;font-weight:600;">Expiry photo captured</span>`;
    }
  }

  function _resetExpiryCaptureUI() {
    // Reset the visual state of the expiry capture UI (video/canvas/buttons/chip)
    // WITHOUT touching SESSION.current.expiryB64 — that is managed separately
    const v = SESSION.expiryVideo;
    const c = SESSION.expiryCanvas;
    if (v) { v.style.display = 'block'; }
    if (c) {
        c.style.display = 'none';
        // Clear canvas so old image doesn't show when next item reaches expiry phase
        const ctx = c.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, c.width, c.height);
    }
    const capBtn    = document.getElementById('fsExpCapBtn');
    const retakeBtn = document.getElementById('fsExpRetakeBtn');
    const nextBtn   = document.getElementById('fsExpNextBtn');
    if (capBtn)    capBtn.style.display    = 'flex';
    if (retakeBtn) retakeBtn.style.display = 'none';
    if (nextBtn)   nextBtn.style.display   = 'none';
    const chip = document.getElementById('fsExpChip');
    if (chip) chip.style.display = 'none';
  }

  function retakeExpiry() {
    SESSION.current.expiryB64 = null;
    _resetExpiryCaptureUI();
  }

  function skipExpiry() {
    SESSION.current.expiryB64 = null;
    _showPhase('details');
    _buildDetailsPanel();
  }

  function expiryNext() {
    if (!SESSION.current.expiryB64) { showToast('Please capture the expiry photo first', 'error'); return; }
    _showPhase('details');
    _buildDetailsPanel();
    // NOTE: Do NOT call retakeExpiry() here — it would null SESSION.current.expiryB64
    // before confirmItem() has a chance to save it to the queue.
    // The expiry UI panel will be reset by _resetSession() after the item is confirmed.
  }

  function _flashCapture() {
    const overlay = document.getElementById('fsExpFlash');
    if (!overlay) return;
    overlay.style.opacity = '0.6';
    setTimeout(() => { overlay.style.opacity = '0'; }, 120);
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  PHASE 3 — FILL DETAILS
   * ════════════════════════════════════════════════════════════════════════ */

  function _buildDetailsPanel() {
    const el = document.getElementById('fsDetailsContent');
    if (!el) return;

    const suppliers = window.AppState?.suppliers || [];
    const supOpts   = suppliers.map(s =>
      `<option value="${s.id}">${s.name}</option>`).join('');

    const bc = SESSION.current.barcode || '';

    el.innerHTML = `
      <div class="form-group" style="background:var(--bg);border:1px solid var(--border);
           border-radius:var(--radius);padding:12px 14px;margin-bottom:16px;
           display:flex;align-items:center;gap:10px;">
        <i class="fas fa-barcode" style="color:#f59e0b;font-size:16px;flex-shrink:0;"></i>
        <div>
          <p style="font-size:10px;color:var(--text-3);margin:0;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Barcode</p>
          <p style="font-size:15px;color:var(--text-1);font-weight:800;font-family:monospace;margin:2px 0 0;" id="_fsBcDisplay"></p>
        </div>
      </div>

      <div class="grid grid-cols-1" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div class="form-group" style="margin:0;">
          <label class="form-label">Buy Price *</label>
          <input type="number" id="fsBuyPrice" class="form-input" placeholder="0.00" min="0" step="0.01" autocomplete="off">
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label">Sell Price *</label>
          <input type="number" id="fsSellPrice" class="form-input" placeholder="0.00" min="0" step="0.01" autocomplete="off">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div class="form-group" style="margin:0;">
          <label class="form-label">Quantity</label>
          <input type="number" id="fsStock" class="form-input" value="0" min="0" step="1" autocomplete="off">
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label">Min Stock Alert</label>
          <input type="number" id="fsMinStock" class="form-input" value="10" min="0" step="1" autocomplete="off">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Supplier</label>
        <select id="fsSupplier" class="form-select" autocomplete="off">
          <option value="">— No supplier —</option>
          ${supOpts}
        </select>
      </div>`;

    // Set barcode text safely after innerHTML
    const bcEl = document.getElementById('_fsBcDisplay');
    if (bcEl) bcEl.textContent = bc || '—';

    // FIX: Always show expiry date field regardless of camera availability.
    // - No camera: user types it manually (only input)
    // - Camera + photo taken: pre-filled note shown; user can also type override
    // - Camera + photo skipped: field is empty, user can type it manually
    const expGroup = document.createElement('div');
    expGroup.className = 'form-group';
    const hasPhoto = !!SESSION.current.expiryB64;
    const cameraHint = SESSION.cameraAvailable
        ? (hasPhoto
            ? '<span style="font-size:11px;color:#10b981;"><i class="fas fa-camera" style="margin-right:3px;"></i>Expiry photo captured — AI will read the date. Override below if needed.</span>'
            : '<span style="font-size:11px;color:var(--text-3);">No expiry photo — enter date manually or leave blank.</span>')
        : '';
    expGroup.innerHTML = `
        <label class="form-label" style="display:flex;align-items:center;gap:6px;">
            Expiry Date
            <span style="font-size:10px;background:#fef3c7;color:#92400e;padding:2px 6px;border-radius:4px;font-weight:600;">IMPORTANT</span>
        </label>
        ${cameraHint ? `<div style="margin-bottom:6px;">${cameraHint}</div>` : ''}
        <input type="date" id="fsExpiryDate" class="form-input" autocomplete="off"
               style="${hasPhoto ? 'border-color:#10b981;background:#f0fdf4;' : ''}"
               min="${new Date().toISOString().split('T')[0]}">
        <p style="font-size:10px;color:var(--text-3);margin-top:4px;">
            <i class="fas fa-info-circle" style="margin-right:3px;"></i>
            ${hasPhoto ? 'AI will attempt to read from photo. Verify the date below.' : 'Enter manually if the product has an expiry date.'}
        </p>`;
    el.appendChild(expGroup);

    // Focus buy price immediately
    setTimeout(() => document.getElementById('fsBuyPrice')?.focus(), 80);
  }

  function _numInput(label, id, val = '', ph = '0.00', step = '0.01') {
    return `
      <label style="display:block;">
        <span style="font-size:11px;font-weight:700;color:rgba(255,255,255,.5);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.05em;">${label}</span>
        <input type="number" id="${id}" value="${val}" placeholder="${ph}" min="0" step="${step}"
          autocomplete="off"
          style="width:100%;padding:12px 14px;border:1.5px solid rgba(255,255,255,.12);border-radius:10px;
                 font-size:14px;color:var(--text-1);background:rgba(255,255,255,.06);outline:none;
                 box-sizing:border-box;transition:border-color .15s;"
          onfocus="this.style.borderColor='var(--primary)'" onblur="this.style.borderColor='rgba(255,255,255,.12)'">
      </label>`;
  }

  async function confirmItem() {
    const g = id => document.getElementById(id)?.value?.trim() || '';

    const buyPrice  = parseFloat(g('fsBuyPrice'))  || 0;
    const sellPrice = parseFloat(g('fsSellPrice')) || 0;
    const stock     = parseInt(g('fsStock'))    || 0;
    const minStock  = parseInt(g('fsMinStock')) || 10;
    const supplierId = g('fsSupplier') || null;
    const expiryDate = g('fsExpiryDate') || null;

    // Validation — block on missing required fields
    if (sellPrice <= 0) {
        showToast('❌ Sell price is required — enter a sell price before continuing', 'error');
        document.getElementById('fsSellPrice')?.focus();
        return;
    }
    if (buyPrice <= 0) {
        showToast('❌ Buy price is required — enter a buy price before continuing', 'error');
        document.getElementById('fsBuyPrice')?.focus();
        return;
    }
    if (stock < 0) {
        showToast('❌ Stock quantity cannot be negative', 'error');
        document.getElementById('fsStock')?.focus();
        return;
    }
    if (minStock < 0) {
        showToast('❌ Min stock level cannot be negative', 'error');
        document.getElementById('fsMinStock')?.focus();
        return;
    }
    if (sellPrice < buyPrice) {
        showToast('⚠️ Sell price is lower than buy price — you will lose money on this item', 'warning');
        // Warn but don't block — could be intentional clearance
    }

    // Expiry date warning - but don't block
    if (!expiryDate && !SESSION.current.expiryB64) {
        showToast('⚠️ No expiry date set — this item will not have an expiry date', 'warning', 4000);
    } else if (expiryDate) {
        // Validate expiry date is in the future
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const expDate = new Date(expiryDate);
        if (expDate < today) {
            showToast('⚠️ Expiry date is in the past — item may already be expired', 'warning', 4000);
        }
    }

    const btn = document.getElementById('fsConfirmBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

    try {
      // Read manual expiry date — always present now regardless of camera availability
      const manualExpiry = document.getElementById('fsExpiryDate')?.value || null;
      const payload = {
        barcode:         SESSION.current.barcode || null,
        expiry_image:    SESSION.current.expiryB64 || null,
        expiry_date:     manualExpiry || null,   // user-typed override, takes priority
        buy_price:       buyPrice,
        sell_price:      sellPrice,
        stock_quantity:  stock,
        min_stock_level: minStock,
        supplier_id:     supplierId,
        branch_id:       SESSION.branchId,  // locked at open() time
      };

      // Client-side duplicate guard — check queue first (instant, no API needed)
      const alreadyInQueue = payload.barcode
        ? SESSION.queue.find(q => q.barcode && q.barcode === payload.barcode)
        : null;
      if (alreadyInQueue) {
        showToast(`⚠️ Barcode "${payload.barcode}" already in this session's queue`, 'warning');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Next →'; }
        return;
      }

      const res = await window.API.post('/fast-scan/item', payload);

      if (res?.item_id) {
        // Add to in-memory queue (new or reused pending_ai item)
        SESSION.queue.push({
          item_id:      res.item_id,
          barcode:      SESSION.current.barcode,
          expiry_image: SESSION.current.expiryB64,
          expiry_date:  manualExpiry || null,  // preserve manual date as fallback
          name:         res.name,
        });

        _updateQueueBadge();
        if (res.reused) {
          showToast(`♻️ Re-queued existing item — AI will re-identify it`, 'info');
        } else {
          _showItemAddedFeedback(res.item_id, SESSION.current.barcode);
        }

        // Reset for next scan
        SESSION.current.barcode   = null;
        SESSION.current.expiryB64 = null;

        // Go back to barcode scan
        setTimeout(() => {
          _showPhase('barcode');
          const bcRes = document.getElementById('fsBcResult');
          if (bcRes) bcRes.style.display = 'none';
          // Reset expiry camera UI so old image doesn't bleed into next item's capture
          _resetExpiryCaptureUI();
          _startBarcodeScanner();
        }, 600);
      }
    } catch (err) {
      // Safely extract message — err could be Error, string, or {detail:{message:...}}
      let msg = 'Failed to save item';
      if (typeof err === 'string') msg = err;
      else if (err?.message && typeof err.message === 'string') msg = err.message;
      else if (err?.detail?.message) msg = err.detail.message;
      else if (err?.detail && typeof err.detail === 'string') msg = err.detail;
      // 409 = completed item with this barcode already exists in DB
      if (msg.includes('already exists') || msg.includes('already scanned') || msg.includes('already used')) {
        const cleanMsg = msg.replace('Barcode already exists: ', '').replace(/'/g, '');
        showToast(`⚠️ Barcode already in inventory as "${cleanMsg}" — skip or use a different product`, 'warning');
      } else {
        showToast(msg, 'error');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Next →'; }
    }
  }

  function _showItemAddedFeedback(itemId, barcode) {
    // Brief toast
    showToast(`✅ Item queued${barcode ? ' · ' + barcode : ''} — scan next product`, 'success');

    // Update running count label
    const cnt = document.getElementById('fsQueueCount');
    if (cnt) {
      cnt.textContent = SESSION.queue.length;
      cnt.style.animation = 'none';
      requestAnimationFrame(() => { cnt.style.animation = ''; });
    }
  }

  function _updateQueueBadge() {
    const cnt  = document.getElementById('fsQueueCount');
    const pill = document.getElementById('fsQueuePill');
    const n    = SESSION.queue.length;
    if (cnt)  cnt.textContent  = n;
    if (pill) pill.style.display = n > 0 ? 'flex' : 'none';
    // Update Done button label
    const doneBtn = document.getElementById('fsDoneBtn');
    if (doneBtn) doneBtn.textContent = n > 0
      ? `Done — Process ${n} item${n > 1 ? 's' : ''} with AI`
      : 'Done';
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  DONE — trigger batch Gemini processing
   * ════════════════════════════════════════════════════════════════════════ */

  async function done() {
    if (SESSION.queue.length === 0) {
      close();
      if (typeof loadItems === 'function') loadItems();
      return;
    }

    // Close scanner if still open
    window.XScanner?.close();
    _showPhase('done');
    _renderProcessingUI(SESSION.queue.length);

    // Build batch payload — send images and manual expiry dates, then free images from memory
    const items = SESSION.queue.map(q => ({
      item_id:      q.item_id,
      barcode:      q.barcode,
      expiry_image: q.expiry_image,
      expiry_date:  q.expiry_date || null,  // manual fallback if AI can't read the photo
    }));
    // Log batch payload for debugging expiry issues
    items.forEach(it => {
        console.log(`[FastScan] batch item: id=${it.item_id} barcode=${it.barcode} has_expiry_image=${!!it.expiry_image} expiry_date=${it.expiry_date}`);
    });
    // Clear image data from memory now that it's been sent (save RAM)
    SESSION.queue.forEach(q => { q.expiry_image = null; });

    try {
      _setDoneStatus('🔍 Checking local database…', 20);
      const res = await window.API.post('/fast-scan/batch-process', { items });

      const updated = res?.updated ?? 0;
      const failed  = res?.failed  ?? 0;
      const total   = res?.total   ?? SESSION.queue.length;

      if (failed > 0) {
        _setDoneStatus(`⚠️ ${updated}/${total} identified · ${failed} failed`, 90);
      } else {
        _setDoneStatus('✅ All items identified!', 100);
      }
      // Mark queue items as processed so close() won't try to delete them
      SESSION.queue.forEach(q => { q.processed = true; });

      // Reload items table
      if (typeof loadItems === 'function') {
        await loadItems().catch(() => {});
      }

      setTimeout(() => {
        close();
        const msg = failed > 0
          ? `✅ ${updated}/${total} items identified · ${failed} need manual review`
          : `✅ ${updated}/${total} items identified by AI`;
        showToast(msg, failed > 0 ? 'warning' : 'success');
      }, 1500);

    } catch (err) {
      _setDoneStatus('⚠️ AI processing failed — items saved, retry later', 0);
      const retryBtn = document.getElementById('fsDoneRetryBtn');
      if (retryBtn) retryBtn.style.display = 'flex';
      showToast('Items were saved. AI fill failed: ' + (err?.message || 'unknown error'), 'error');
    }
  }

  function _renderProcessingUI(count) {
    const el = document.getElementById('fsDoneContent');
    if (!el) return;
    el.innerHTML = `
      <div style="text-align:center;padding:32px 24px 20px;">
        <div style="width:64px;height:64px;border-radius:50%;border:4px solid var(--border);
                    border-top-color:#f59e0b;animation:spin .8s linear infinite;
                    margin:0 auto 24px;" id="fsSpinner"></div>
        <h3 style="font-size:18px;font-weight:800;color:var(--text-1);margin:0 0 8px;">
          Identifying ${count} product${count > 1 ? 's' : ''}…
        </h3>
        <p style="font-size:13px;color:var(--text-3);margin:0 0 28px;line-height:1.6;">
          Gemini AI is searching each barcode online,<br>filling names, brands and expiry dates.
        </p>
        <div style="width:100%;height:6px;background:var(--border);border-radius:99px;overflow:hidden;margin-bottom:12px;">
          <div id="fsDoneBar" style="height:100%;width:0%;background:#f59e0b;border-radius:99px;transition:width .6s ease;"></div>
        </div>
        <p id="fsDoneStatus" style="font-size:12px;color:var(--text-3);min-height:18px;"></p>
      </div>
      <div style="padding:0 18px 20px;">
        <button id="fsDoneRetryBtn" onclick="FastScan._retryFailed()"
          style="display:none;width:100%;padding:13px;border-radius:var(--radius);
                 background:#f59e0b;color:#fff;border:none;font-size:14px;font-weight:700;cursor:pointer;
                 align-items:center;justify-content:center;gap:8px;">
          <i class="fas fa-redo"></i> Retry AI Processing
        </button>
      </div>`;

    requestAnimationFrame(() => {
      const bar = document.getElementById('fsDoneBar');
      if (bar) bar.style.width = '20%';
    });
  }

  function _setDoneStatus(msg, pct) {
    const bar     = document.getElementById('fsDoneBar');
    const status  = document.getElementById('fsDoneStatus');
    const spinner = document.getElementById('fsSpinner');
    if (bar)    bar.style.width = pct + '%';
    if (status) status.textContent = msg;
    if (pct >= 100 && spinner) {
      spinner.style.borderTopColor = '#10b981';
      spinner.style.borderColor    = '#10b981';
      spinner.style.animation      = 'none';
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  HELPERS
   * ════════════════════════════════════════════════════════════════════════ */

  async function _ensureSuppliers() {
    if (window.AppState?.suppliers?.length) return;
    try {
      const s = await window.SuppliersAPI?.list();
      if (window.AppState) window.AppState.suppliers = s || [];
    } catch {}
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  PUBLIC API
   * ════════════════════════════════════════════════════════════════════════ */
  // ── Retry only failed items ────────────────────────────────────────────────
  async function _retryFailed() {
    try {
      const result = await window.API.post('/fast-scan/retry', {});
      showToast(`↩️ Retrying ${result.total || 0} pending items…`, 'info');
      _setDoneStatus('🔄 Retrying failed items…', 30);
      if (result.updated > 0) {
        _setDoneStatus(`✅ ${result.updated} items recovered!`, 100);
        if (typeof loadItems === 'function') loadItems().catch(() => {});
        setTimeout(() => close(), 1500);
      } else {
        _setDoneStatus('⚠️ Items still pending — try again later', 0);
      }
    } catch (err) {
      showToast(err?.message || 'Retry failed', 'error');
    }
  }

  return {
    open, close, toggleTorch,
    _pickBranch, done, _retryFailed,
    captureExpiry, retakeExpiry, skipExpiry, expiryNext,
    confirmItem,
    handleHWBarcode: (code) => { if (code) _onBarcodeScanned(code); },
  };

})();
