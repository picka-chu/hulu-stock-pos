/**
 * Hulu Stock Smart Scan  v11.0
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  NEW FLOW — Add with AI:
 *
 *  STEP 1 — Barcode scan (ZXing live)
 *    User points camera at barcode → detected instantly
 *
 *  STEP 2 — Expiry photo
 *    User captures expiry/best-before stamp photo
 *    ↓ Gemini job fires in BACKGROUND immediately after capture
 *
 *  STEP 3 — Fill details (PARALLEL with Gemini)
 *    User fills: buy price, sell price, stock qty, min stock, supplier
 *    Progress bar shows Gemini job status live
 *
 *  STEP 4 — Next (wait if Gemini not done)
 *    If Gemini is still running → show spinner until done
 *    Then transition to review
 *
 *  STEP 5 — Review
 *    All Gemini fields + user fields shown together
 *    User can edit anything, then clicks "Add Item"
 *    → closes modal, opens item form pre-filled, user saves
 *
 *  GEMINI: uses Google Search grounding to identify product by barcode
 *  CATEGORY: backend checks/creates specific subcategory automatically
 * ══════════════════════════════════════════════════════════════════════════════
 */
'use strict';

const SmartScan = (() => {

  /* ── Caches ─────────────────────────────────────────────────────────────── */
  let _usageCache = null, _usageFetchedAt = 0;
  let _catCache   = null, _catFetchedAt   = 0;

  /* ── AI wizard state ─────────────────────────────────────────────────────── */
  const S = {
    barcode:      null,   // scanned barcode string
    expiryPhoto:  null,   // { dataUrl, base64 }
    geminiResult: null,   // backend response
    geminiDone:   false,
    geminiError:  null,
    geminiPromise: null,  // the in-flight promise
    stream:       null,
    videoEl:      null,
    canvasEl:     null,
  };

  /* ── Bulk scanner state ──────────────────────────────────────────────────── */
  const BULK = {
    stream: null, videoEl: null,
    scanning: false, paused: false,
    items: [], lastBarcode: null, lastScanAt: 0,
    pendingQtyResolve: null,
  };

  /* ══════════════════════════════════════════════════════════════════════════
   *  CAMERA UTILITIES
   * ══════════════════════════════════════════════════════════════════════════ */

  function _stopStream(s) { s?.getTracks().forEach(t => t.stop()); }

  async function _openCamera(videoEl, forBarcode = false) {
    const focusOpts = {
      focusMode: 'continuous',
      exposureMode: 'continuous',
      whiteBalanceMode: 'continuous',
    };
    if (forBarcode) focusOpts.focusDistance = 0.2;

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: forBarcode ? 1280 : 1920, max: forBarcode ? 1280 : 1920 },
        height: { ideal: forBarcode ?  720 : 1080, max: forBarcode ?  720 : 1080 },
        frameRate: { ideal: 30, min: 15 },
        advanced: [focusOpts],
      },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = stream;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('muted', '');

    await new Promise((resolve) => {
      const t = setTimeout(() => resolve(), 2000);
      videoEl.onloadedmetadata = () => {
        clearTimeout(t);
        videoEl.play().then(resolve).catch(resolve);
      };
    });

    try {
      const track = stream.getVideoTracks()[0];
      const caps  = track.getCapabilities?.() ?? {};
      const opts  = {};
      if (caps.focusMode?.includes('continuous'))        opts.focusMode        = 'continuous';
      if (caps.exposureMode?.includes('continuous'))     opts.exposureMode     = 'continuous';
      if (caps.whiteBalanceMode?.includes('continuous')) opts.whiteBalanceMode = 'continuous';
      if (forBarcode && caps.zoom) opts.zoom = Math.min(1.2, caps.zoom.max ?? 1.2);
      if (Object.keys(opts).length) await track.applyConstraints({ advanced: [opts] });
    } catch {}

    return stream;
  }

  function _captureFrame(videoEl, canvasEl) {
    canvasEl.width  = videoEl.videoWidth  || 1280;
    canvasEl.height = videoEl.videoHeight || 720;
    canvasEl.getContext('2d').drawImage(videoEl, 0, 0);
    const dataUrl = canvasEl.toDataURL('image/jpeg', 0.92);
    return { dataUrl, base64: dataUrl.split(',')[1] };
  }

  async function _resizeToMax(dataUrl, maxW = 1600) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => {
        if (img.width <= maxW) { res(dataUrl); return; }
        const c = document.createElement('canvas');
        c.width = maxW; c.height = Math.round(img.height * maxW / img.width);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.91));
      };
      img.onerror = () => res(dataUrl);
      img.src = dataUrl;
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  USAGE + CATEGORIES + SUPPLIERS
   * ══════════════════════════════════════════════════════════════════════════ */

  async function _getUsage(force = false) {
    const now = Date.now();
    if (!force && _usageCache && now - _usageFetchedAt < 60000) return _usageCache;
    try {
      const r = await window.API.get('/vision/usage');
      _usageCache = r; _usageFetchedAt = now; return r;
    } catch { return { used: 0, limit: 500, remaining: 500 }; }
  }

  async function _getCategories(force = false) {
    const now = Date.now();
    if (!force && _catCache && now - _catFetchedAt < 120000) return _catCache;
    try {
      const cats = await window.CategoriesAPI.list();
      _catCache = cats; _catFetchedAt = now; return cats || [];
    } catch { return []; }
  }

  async function _ensureSuppliersLoaded() {
    if (window.AppState?.suppliers?.length) return;
    try {
      const suppliers = await window.SuppliersAPI.list();
      if (window.AppState) window.AppState.suppliers = suppliers || [];
    } catch {}
  }

  function _renderUsagePill(id, usage) {
    const el = document.getElementById(id); if (!el || !usage) return;
    const pct = usage.limit ? Math.round(usage.used / usage.limit * 100) : 0;
    const col = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981';
    el.innerHTML = `<span style="font-size:11px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:99px;padding:2px 10px;color:rgba(255,255,255,.8);display:inline-flex;align-items:center;gap:5px;">
      <span style="width:6px;height:6px;border-radius:50%;background:${col};flex-shrink:0;display:inline-block;"></span>
      ${usage.used}/${usage.limit} AI scans</span>`;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  PHASE SWITCHER
   * ══════════════════════════════════════════════════════════════════════════ */

  // Panels: 'barcode' | 'expiry' | 'details' | 'waiting' | 'review'
  function _showPhase(phase) {
    const panels = ['bcPanel', 'expiryPanel', 'detailsPanel', 'waitingPanel', 'ocrReviewPanel'];
    const map    = { bcPanel:'barcode', expiryPanel:'expiry', detailsPanel:'details', waitingPanel:'waiting', ocrReviewPanel:'review' };
    panels.forEach(id => {
      const el = document.getElementById(id); if (!el) return;
      el.style.display = (map[id] === phase) ? 'flex' : 'none';
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  OPEN / CLOSE
   * ══════════════════════════════════════════════════════════════════════════ */

  async function openCameraOCRModal() {
    // Reset all state
    S.barcode = null; S.expiryPhoto = null;
    S.geminiResult = null; S.geminiDone = false;
    S.geminiError = null; S.geminiPromise = null;
    _stopStream(S.stream); S.stream = null;

    const modal = document.getElementById('cameraOCRModal');
    if (!modal) return;
    modal.style.display = ''; modal.classList.add('active');

    const [usage] = await Promise.all([
      _getUsage(), _getCategories(), _ensureSuppliersLoaded(),
    ]);
    _renderUsagePill('ocrUsagePill', usage);

    _showPhase('barcode');
    _startBarcodePhase();
  }

  function closeCameraOCRModal() {
    S.geminiPromise = null; // abandon in-flight if any
    _stopStream(S.stream); S.stream = null;
    window.XScanner?.close();
    const modal = document.getElementById('cameraOCRModal');
    if (modal) modal.classList.remove('active');
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  STEP 1 — BARCODE SCAN
   * ══════════════════════════════════════════════════════════════════════════ */

  function _startBarcodePhase() {
    if (!window.XScanner) {
      _setBcStatus('❌ Scanner not loaded — refresh page'); return;
    }
    _setBcStatus('🔍 Point camera at barcode…');
    window.XScanner.open({
      onResult: (code) => {
        window.XScanner.close();
        S.barcode = code;
        _setBcStatus(`<span style="color:#10b981;font-weight:700;">✅ ${code}</span>`);
        // Show confirm card then auto-advance to expiry step
        _showBarcodeConfirm(code);
      },
      onError: (msg) => _setBcStatus('❌ ' + msg),
      target: 'smartscan',
    });
  }

  function _setBcStatus(html) {
    const el = document.getElementById('bcStatus'); if (el) el.innerHTML = html;
  }

  function _showBarcodeConfirm(code) {
    const card = document.getElementById('bcResultCard');
    if (!card) return;
    card.style.display = 'block';
    card.innerHTML = `
      <div style="padding:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <span style="width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block;flex-shrink:0;"></span>
          <span style="font-size:11px;color:#10b981;font-weight:700;text-transform:uppercase;letter-spacing:.07em;">Barcode Scanned</span>
        </div>
        <p style="font-size:16px;font-weight:800;color:#fff;font-family:monospace;margin:0 0 14px;">${code}</p>
        <div style="display:flex;gap:8px;">
          <button onclick="SmartScan._proceedToExpiry()" style="flex:1;padding:13px;border-radius:11px;background:var(--primary);color:#fff;border:none;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">
            <i class="fas fa-arrow-right"></i> Next: Scan Expiry
          </button>
          <button onclick="SmartScan._rescanBarcode()" style="padding:13px 14px;border-radius:11px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.65);border:1px solid rgba(255,255,255,.12);font-size:13px;font-weight:600;cursor:pointer;">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>`;
  }

  function _rescanBarcode() {
    const card = document.getElementById('bcResultCard');
    if (card) card.style.display = 'none';
    S.barcode = null;
    _startBarcodePhase();
  }

  function _proceedToExpiry() {
    _showPhase('expiry');
    S.videoEl  = document.getElementById('ocrAiVideo');
    S.canvasEl = document.getElementById('ocrAiCanvas');
    _startExpiryCamera();
    _setStepLabel('📅 EXPIRY DATE');
    const hint = document.getElementById('ocrAiHint');
    if (hint) hint.textContent = 'Move close to the expiry / best-before stamp. Hold steady.';
    const g = document.getElementById('ocrAiGuide');
    if (g) { g.style.width = '80%'; g.style.height = '30%'; }
    _showCaptureButtons('live');
  }

  async function _startExpiryCamera() {
    try {
      _stopStream(S.stream);
      S.stream = await _openCamera(S.videoEl, false);
    } catch (err) {
      showToast(err.message || 'Camera error', 'error');
      closeCameraOCRModal();
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  STEP 2 — EXPIRY PHOTO CAPTURE
   * ══════════════════════════════════════════════════════════════════════════ */

  async function ocrCapture() {
    if (!S.videoEl || !S.videoEl.videoWidth) { showToast('Camera not ready', 'error'); return; }

    const raw     = _captureFrame(S.videoEl, S.canvasEl);
    const dataUrl = await _resizeToMax(raw.dataUrl);
    S.expiryPhoto = { dataUrl, base64: dataUrl.split(',')[1] };

    // Freeze frame
    if (S.videoEl) S.videoEl.style.display = 'none';
    if (S.canvasEl) {
      S.canvasEl.style.display = 'block';
      const img = new Image();
      img.onload = () => { S.canvasEl.width = img.naturalWidth; S.canvasEl.height = img.naturalHeight; S.canvasEl.getContext('2d').drawImage(img, 0, 0); };
      img.src = dataUrl;
    }

    _showCaptureButtons('captured');
    const chip = document.getElementById('ocrAiChip');
    if (chip) { chip.style.display = 'block'; chip.innerHTML = '<p style="font-size:12px;color:#10b981;margin:0;">✅ Expiry photo captured — press Next</p>'; }

    // 🔥 FIRE GEMINI IN BACKGROUND immediately
    _fireGeminiInBackground();
  }

  function ocrRetake() {
    S.expiryPhoto = null;
    S.geminiResult = null; S.geminiDone = false; S.geminiError = null; S.geminiPromise = null;
    if (S.videoEl) S.videoEl.style.display = 'block';
    if (S.canvasEl) S.canvasEl.style.display = 'none';
    const chip = document.getElementById('ocrAiChip');
    if (chip) chip.style.display = 'none';
    _showCaptureButtons('live');
    if (!S.stream) _startExpiryCamera();
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  BACKGROUND GEMINI JOB
   * ══════════════════════════════════════════════════════════════════════════ */

  async function _fireGeminiInBackground() {
    S.geminiDone = false; S.geminiError = null; S.geminiResult = null;

    const cats    = await _getCategories(true);
    const catRefs = cats.map(c => ({ id: c.id, name: c.name }));

    const payload = {
      barcode:      S.barcode || null,
      expiry_image: S.expiryPhoto?.base64 || null,
      categories:   catRefs,
      branch_id:    window.AppState?.branch?.id || window.AppState?.currentUser?.branch_id || null,
    };

    S.geminiPromise = window.API.post('/vision/scan', payload)
      .then(result => {
        S.geminiResult = result;
        S.geminiDone   = true;
        S.geminiError  = null;
        _onGeminiProgress(100, '✅ Product identified!');
        // Reload categories in case a new one was created
        _catCache = null;
        _getCategories(true).catch(() => {});
        if (typeof loadCategoriesForSelect === 'function') loadCategoriesForSelect().catch(() => {});
      })
      .catch(err => {
        S.geminiDone  = true;
        S.geminiError = err?.message || err?.detail || 'AI scan failed';
        _onGeminiProgress(0, `⚠️ ${S.geminiError}`);
      });
  }

  function _onGeminiProgress(pct, msg) {
    // Update progress bar in details panel (if visible)
    const bar = document.getElementById('geminiProgressBar');
    const txt = document.getElementById('geminiProgressText');
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.innerHTML  = msg;
    // If waiting panel is visible, resolve it
    if (_waitingResolve) { _waitingResolve(); _waitingResolve = null; }
  }

  let _waitingResolve = null;

  /* ══════════════════════════════════════════════════════════════════════════
   *  STEP 3 — DETAILS PANEL (parallel fill while Gemini runs)
   * ══════════════════════════════════════════════════════════════════════════ */

  function ocrNextStep() {
    // Advance from expiry panel → details panel
    _stopStream(S.stream); S.stream = null;
    _showPhase('details');
    _buildDetailsPanel();
    _tickGeminiProgress();
  }

  function _buildDetailsPanel() {
    const el = document.getElementById('detailsContent'); if (!el) return;

    const suppliers = window.AppState?.suppliers || [];
    const supplierOptions = suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');

    const numField = (label, id, val = '', ph = '0.00', step = '0.01') =>
      `<label style="display:block;">
        <span style="font-size:11px;font-weight:700;color:var(--text-3);display:block;margin-bottom:5px;">${label}</span>
        <input type="number" id="${id}" value="${val}" placeholder="${ph}" min="0" step="${step}" autocomplete="off"
          style="width:100%;padding:11px 12px;border:1.5px solid var(--border);border-radius:10px;font-size:14px;background:var(--surface);color:var(--text-1);box-sizing:border-box;outline:none;transition:border-color .15s;"
          onfocus="this.style.borderColor='var(--primary)'" onblur="this.style.borderColor='var(--border)'">
       </label>`;

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        ${numField('Buy Price *', 'dtBuyPrice', '', '0.00')}
        ${numField('Sell Price *', 'dtSellPrice', '', '0.00')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        ${numField('Stock Qty', 'dtStock', '0', '0', '1')}
        ${numField('Min Stock Alert', 'dtMinStock', '10', '10', '1')}
      </div>
      <label style="display:block;margin-bottom:4px;">
        <span style="font-size:11px;font-weight:700;color:var(--text-3);display:block;margin-bottom:5px;">Supplier</span>
        <select id="dtSupplier" autocomplete="off"
          style="width:100%;padding:11px 12px;border:1.5px solid var(--border);border-radius:10px;font-size:14px;color:var(--text-1);background:var(--surface);outline:none;box-sizing:border-box;appearance:none;transition:border-color .15s;"
          onfocus="this.style.borderColor='var(--primary)'" onblur="this.style.borderColor='var(--border)'">
          <option value="">— No supplier —</option>
          ${supplierOptions}
        </select>
      </label>`;
  }

  let _progressInterval = null;

  function _tickGeminiProgress() {
    if (_progressInterval) clearInterval(_progressInterval);
    const bar = document.getElementById('geminiProgressBar');
    const txt = document.getElementById('geminiProgressText');
    if (!bar) return;

    if (S.geminiDone) {
      bar.style.width = S.geminiError ? '100%' : '100%';
      bar.style.background = S.geminiError ? '#f59e0b' : '#10b981';
      if (txt) txt.innerHTML = S.geminiError ? `⚠️ ${S.geminiError}` : '✅ Product identified!';
      return;
    }

    // Animate progress from 5% → 85% while Gemini works
    let pct = 5;
    bar.style.width = pct + '%';
    bar.style.background = 'var(--primary)';
    if (txt) txt.innerHTML = '🔍 Searching product database…';

    const msgs = [
      { at: 15, msg: '🌐 Google Search running…' },
      { at: 35, msg: '📦 Identifying product…' },
      { at: 55, msg: '🏷️ Matching category…' },
      { at: 70, msg: '📅 Reading expiry date…' },
      { at: 82, msg: '✨ Almost done…' },
    ];

    _progressInterval = setInterval(() => {
      if (S.geminiDone) {
        clearInterval(_progressInterval); _progressInterval = null;
        bar.style.width = '100%';
        bar.style.background = S.geminiError ? '#f59e0b' : '#10b981';
        if (txt) txt.innerHTML = S.geminiError ? `⚠️ ${S.geminiError}` : '✅ Product identified!';
        return;
      }
      pct = Math.min(pct + (pct < 50 ? 2 : 0.8), 85);
      bar.style.width = pct + '%';
      const step = msgs.slice().reverse().find(m => pct >= m.at);
      if (step && txt) txt.innerHTML = step.msg;
    }, 400);
  }

  async function ocrGoToReview() {
    // If Gemini is still running, show waiting panel
    if (!S.geminiDone) {
      _showPhase('waiting');
      await new Promise(resolve => { _waitingResolve = resolve; });
    }

    // If Gemini errored, allow continuing without AI data
    if (S.geminiError) {
      showToast('AI scan had issues — you can fill details manually', 'warning');
    }

    if (_progressInterval) { clearInterval(_progressInterval); _progressInterval = null; }
    _showPhase('review');
    _buildReview();
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  STEP 5 — REVIEW
   * ══════════════════════════════════════════════════════════════════════════ */

  function _buildReview() {
    const el = document.getElementById('ocrExtractedData'); if (!el) return;

    const d  = S.geminiResult || {};
    const g  = id => document.getElementById(id)?.value?.trim() || '';

    const conf    = d.confidence ? Math.round(d.confidence * 100) : null;
    const confCol = conf >= 85 ? '#10b981' : conf >= 60 ? '#f59e0b' : '#ef4444';
    const confBadge = conf
      ? `<span style="font-size:11px;background:${confCol}22;color:${confCol};padding:2px 10px;border-radius:99px;border:1px solid ${confCol}44;font-weight:700;">✨ ${conf}% confidence · Gemini AI + Google Search</span>`
      : (S.geminiError ? `<span style="font-size:11px;background:#f59e0b22;color:#f59e0b;padding:2px 10px;border-radius:99px;border:1px solid #f59e0b44;font-weight:700;">⚠️ AI scan unavailable — fill manually</span>` : '');

    const field = (icon, label, id, val, type = 'text', ph = '') =>
      `<label style="display:block;margin-bottom:11px;">
        <span style="font-size:11px;font-weight:600;color:var(--text-3);display:flex;align-items:center;gap:5px;margin-bottom:4px;">
          <i class="fas ${icon}" style="color:var(--primary);font-size:10px;"></i>${label}
        </span>
        <input id="${id}" value="${(val||'').replace(/"/g,'&quot;')}" placeholder="${ph}" type="${type}" autocomplete="off"
          style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;color:var(--text-1);background:var(--surface);outline:none;box-sizing:border-box;transition:border-color .15s;"
          onfocus="this.style.borderColor='var(--primary)'" onblur="this.style.borderColor='var(--border)'">
       </label>`;

    const numFieldRv = (label, id, val = '') =>
      `<label style="display:block;">
        <span style="font-size:11px;font-weight:600;color:var(--text-3);display:block;margin-bottom:4px;">${label}</span>
        <input type="number" id="${id}" value="${val}" min="0" step="0.01" autocomplete="off"
          style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;background:var(--surface);color:var(--text-1);box-sizing:border-box;outline:none;transition:border-color .15s;"
          onfocus="this.style.borderColor='var(--primary)'" onblur="this.style.borderColor='var(--border)'">
       </label>`;

    // Category selector
    const cats = window.AppState?.categories || [];
    const catOpts = cats.map(c => `<option value="${c.id}" ${c.id === d.category_id ? 'selected' : ''}>${c.name}</option>`).join('');
    const newCatNote = d.category_created
      ? `<span style="font-size:10px;background:#10b98122;color:#10b981;padding:1px 7px;border-radius:99px;border:1px solid #10b98144;margin-left:6px;">✨ Auto-created</span>` : '';
    const categoryField = `
      <label style="display:block;margin-bottom:11px;">
        <span style="font-size:11px;font-weight:600;color:var(--text-3);display:flex;align-items:center;gap:5px;margin-bottom:4px;">
          <i class="fas fa-tag" style="color:var(--primary);font-size:10px;"></i>Category${newCatNote}
        </span>
        <select id="rvCategory" autocomplete="off"
          style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;color:var(--text-1);background:var(--surface);outline:none;box-sizing:border-box;appearance:none;transition:border-color .15s;"
          onfocus="this.style.borderColor='var(--primary)'" onblur="this.style.borderColor='var(--border)'">
          <option value="">— No category —</option>
          ${catOpts}
        </select>
      </label>`;

    // Supplier selector — carry over from details panel
    const suppliers   = window.AppState?.suppliers || [];
    const chosenSupId = g('dtSupplier');
    const supOpts     = suppliers.map(s => `<option value="${s.id}" ${s.id === chosenSupId ? 'selected' : ''}>${s.name}</option>`).join('');
    const supplierField = `
      <label style="display:block;margin-bottom:11px;">
        <span style="font-size:11px;font-weight:600;color:var(--text-3);display:flex;align-items:center;gap:5px;margin-bottom:4px;">
          <i class="fas fa-truck" style="color:var(--primary);font-size:10px;"></i>Supplier
        </span>
        <select id="rvSupplier" autocomplete="off"
          style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;color:var(--text-1);background:var(--surface);outline:none;box-sizing:border-box;appearance:none;transition:border-color .15s;"
          onfocus="this.style.borderColor='var(--primary)'" onblur="this.style.borderColor='var(--border)'">
          <option value="">— No supplier —</option>
          ${supOpts}
        </select>
      </label>`;

    // Carry over pricing from details panel
    const buy    = g('dtBuyPrice');
    const sell   = g('dtSellPrice');
    const stock  = g('dtStock')    || '0';
    const minStk = g('dtMinStock') || '10';

    el.innerHTML = `
      <div style="margin-bottom:14px;">${confBadge}</div>

      ${!d.product_name && !S.geminiError ? '' : ''}
      ${field('fa-box', 'Product Name *', 'rvName', d.product_name, 'text', 'Enter product name…')}
      ${field('fa-barcode', 'Barcode', 'rvBarcode', d.barcode || S.barcode, 'text', 'Barcode number')}
      ${field('fa-calendar', 'Expiry Date', 'rvExpiry', d.expiry_date, 'date')}
      ${field('fa-trademark', 'Brand', 'rvBrand', d.brand, 'text', 'Brand / manufacturer')}
      ${field('fa-align-left', 'Description', 'rvDesc', d.description, 'text', 'Short description')}
      ${categoryField}
      ${supplierField}

      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0;">
      <p style="font-size:12px;font-weight:700;color:var(--text-2);margin:0 0 12px;">💰 Pricing &amp; Stock</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        ${numFieldRv('Buy Price', 'rvBuyPrice', buy)}
        ${numFieldRv('Sell Price', 'rvSellPrice', sell)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${numFieldRv('Stock Qty', 'rvStock', stock)}
        ${numFieldRv('Min Stock Alert', 'rvMinStock', minStk)}
      </div>`;
  }

  async function ocrFillForm() {
    const g = id => document.getElementById(id)?.value?.trim() || '';
    const d = S.geminiResult || {};

    const name       = g('rvName')       || d.product_name || '';
    const bc         = g('rvBarcode')    || d.barcode || S.barcode || '';
    const expiry     = g('rvExpiry')     || d.expiry_date || '';
    const brand      = g('rvBrand')      || d.brand || '';
    const desc       = g('rvDesc')       || d.description || '';
    const catId      = g('rvCategory')   || d.category_id || '';
    const supplierId = g('rvSupplier');
    const buy        = g('rvBuyPrice');
    const sell       = g('rvSellPrice');
    const stock      = g('rvStock')   || '0';
    const minStk     = g('rvMinStock') || '10';

    closeCameraOCRModal();
    openItemModal();

    setTimeout(() => {
      const s = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
      s('itemName', name); s('itemBarcode', bc); s('itemDescription', desc);
      s('itemExpiryDate', expiry); s('itemBuyPrice', buy); s('itemSellPrice', sell);
      s('itemStock', stock); s('itemMinStock', minStk);
      if (brand) s('itemBrand', brand);
      if (catId)      { const c = document.getElementById('itemCategory'); if (c) c.value = catId; }
      if (supplierId) { const c = document.getElementById('itemSupplier'); if (c) c.value = supplierId; }
      const conf = d.confidence ? ` (${Math.round(d.confidence*100)}% confidence)` : '';
      showToast(`✨ Form filled from AI scan${conf}`, 'success');
    }, 160);
  }

  function ocrRetryFromStart() {
    S.barcode = null; S.expiryPhoto = null;
    S.geminiResult = null; S.geminiDone = false;
    S.geminiError = null; S.geminiPromise = null;
    if (_progressInterval) { clearInterval(_progressInterval); _progressInterval = null; }
    const card = document.getElementById('bcResultCard');
    if (card) { card.style.display = 'none'; card.innerHTML = ''; }
    _showPhase('barcode');
    _startBarcodePhase();
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  SHARED UI HELPERS
   * ══════════════════════════════════════════════════════════════════════════ */

  function _setStepLabel(text) {
    const el = document.getElementById('ocrAiLabel');
    if (el) el.innerHTML = `<span style="display:inline-block;background:rgba(0,0,0,.65);backdrop-filter:blur(6px);color:#fff;padding:5px 16px;border-radius:99px;font-size:12px;font-weight:700;letter-spacing:.05em;">${text}</span>`;
  }

  function _showCaptureButtons(state) {
    const show = (id, vis) => { const el = document.getElementById(id); if (el) el.style.display = vis ? 'flex' : 'none'; };
    show('ocrAiSkipBtn',   state === 'live');
    show('ocrAiCapBtn',    state === 'live');
    show('ocrAiRetakeBtn', state === 'captured');
    show('ocrAiNextBtn',   state === 'captured');
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  BULK SCANNER
   * ══════════════════════════════════════════════════════════════════════════ */

  function openBulkScannerModal() {
    const modal = document.getElementById('bulkScannerModal'); if (!modal) return;
    modal.style.display = ''; modal.classList.add('active');
    BULK.items = []; BULK.lastBarcode = null; BULK.lastScanAt = 0;
    _bulkRenderList(); _bulkSetStatus('Ready — press Start Scanner');
    const sb = document.getElementById('bulkStartBtn'), pb = document.getElementById('bulkPauseBtn');
    if (sb) sb.style.display = ''; if (pb) pb.style.display = 'none';
  }

  function closeBulkScanner() {
    _bulkStop();
    document.getElementById('bulkScannerModal')?.classList.remove('active');
  }

  async function startBulkScanner() {
    const area = document.getElementById('bulkScannerArea'); if (!area) return;
    area.innerHTML = '';
    const video = document.createElement('video');
    video.setAttribute('autoplay',''); video.setAttribute('playsinline',''); video.setAttribute('muted','');
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px;display:block;';
    area.style.position = 'relative'; area.appendChild(video);
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    overlay.innerHTML = `<div style="position:absolute;left:10%;right:10%;top:25%;height:50%;border:2px solid rgba(16,185,129,.8);border-radius:8px;box-shadow:0 0 0 9999px rgba(0,0,0,.4);"></div>
      <div id="bulkScanLine" style="position:absolute;left:10%;right:10%;top:25%;height:2px;background:linear-gradient(90deg,transparent,#10b981,transparent);animation:scanLine 1.5s ease-in-out infinite;"></div>
      <style>@keyframes scanLine{0%{top:25%}100%{top:75%}}</style>`;
    area.appendChild(overlay);
    try { BULK.stream = await _openCamera(video); BULK.videoEl = video; }
    catch (err) { _bulkSetStatus('❌ ' + err.message); return; }
    await new Promise(r => { if (video.readyState >= 2) r(); else { video.addEventListener('canplay', r, {once:true}); setTimeout(r, 3000); } });
    const sb = document.getElementById('bulkStartBtn'), pb = document.getElementById('bulkPauseBtn');
    if (sb) sb.style.display = 'none'; if (pb) pb.style.display = '';
    BULK.scanning = true; BULK.paused = false;
    _bulkSetStatus('🔍 Scanning…');

    // Use html5-qrcode for iOS Safari compatibility (ZXing removed — canvas
    // cross-origin restriction breaks it on iOS Safari).
    // Strategy: draw each video frame to a hidden canvas → toBlob → scanFileV2.
    // Native BarcodeDetector is used first where available (Chrome/Android).
    const nativeDetector = await _initBulkDecoder();
    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');
    const h5     = !nativeDetector && window.Html5Qrcode ? _getH5Scanner() : null;

    const loop = async () => {
      if (!BULK.scanning) return;
      if (!BULK.paused && video.readyState >= 2 && video.videoWidth > 0) {
        try {
          let code = null;
          if (nativeDetector) {
            // Native BarcodeDetector — fastest path (Chrome / Android)
            const results = await nativeDetector.detect(video);
            if (results.length) code = results[0].rawValue;
          } else if (h5) {
            // html5-qrcode via canvas blob — works on iOS Safari
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
            if (blob) {
              const url = URL.createObjectURL(blob);
              try {
                const result = await h5.scanFileV2(url, false);
                if (result?.decodedText) code = result.decodedText;
              } catch (_) { /* NotFoundException — no barcode in frame */ }
              finally { URL.revokeObjectURL(url); }
            }
          }
          if (code && code !== BULK.lastBarcode && Date.now() - BULK.lastScanAt > 1500) {
            BULK.lastBarcode = code; BULK.lastScanAt = Date.now();
            await _bulkHandleScan(code);
          }
        } catch (_) {}
      }
      if (BULK.scanning) setTimeout(loop, 200);
    };
    loop();
  }

  async function _initBulkDecoder() {
    if ('BarcodeDetector' in window) {
      try {
        const supported = await BarcodeDetector.getSupportedFormats();
        return new BarcodeDetector({ formats: supported });
      } catch (_) {}
    }
    return null;
  }

  function _getH5Scanner() {
    if (!window.Html5Qrcode) return null;
    try {
      const divId = 'xpos-bulk-h5qr-helper';
      let el = document.getElementById(divId);
      if (!el) {
        el = document.createElement('div');
        el.id = divId;
        el.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
        document.body.appendChild(el);
      }
      return new Html5Qrcode(divId, { verbose: false });
    } catch (_) { return null; }
  }

  function _bulkStop() {
    BULK.scanning = false; _stopStream(BULK.stream); BULK.stream = null; BULK.videoEl = null;
    const area = document.getElementById('bulkScannerArea');
    if (area) area.innerHTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;"><div style="text-align:center;"><i class="fas fa-barcode" style="font-size:2.5rem;opacity:.3;color:#fff;display:block;margin-bottom:8px;"></i><p style="font-size:12px;color:rgba(255,255,255,.4);margin:0;">Press Start Scanner</p></div></div>`;
    const sb = document.getElementById('bulkStartBtn'), pb = document.getElementById('bulkPauseBtn');
    if (sb) sb.style.display = ''; if (pb) pb.style.display = 'none';
  }

  function pauseBulkScanner() {
    BULK.paused = !BULK.paused;
    const btn = document.getElementById('bulkPauseBtn');
    if (btn) btn.innerHTML = BULK.paused ? '<i class="fas fa-play"></i> Resume' : '<i class="fas fa-pause"></i> Pause';
    _bulkSetStatus(BULK.paused ? '⏸ Paused' : '🔍 Scanning…');
  }

  function _bulkSetStatus(msg) { const el = document.getElementById('bulkScanStatus'); if (el) el.textContent = msg; }

  async function _bulkHandleScan(code) {
    _bulkSetStatus(`Found: ${code}`);
    const ex = BULK.items.find(i => i.barcode === code);
    if (ex) { ex.quantity++; _bulkRenderList(); _bulkSetStatus(`✅ ${ex.name} ×${ex.quantity}`); return; }
    let item = null;
    try { const r = await window.API.get(`/items?barcode=${encodeURIComponent(code)}&limit=1`); item = r?.data?.[0] || r?.[0] || null; } catch {}
    if (item) { BULK.items.push({ id: item.id, barcode: code, name: item.name, quantity: 1, found: true }); _bulkRenderList(); _bulkSetStatus(`✅ ${item.name}`); return; }
    _bulkSetStatus(`❓ Unknown: ${code}`);
    const qty = await _bulkPromptQty(code);
    BULK.items.push({ id: null, barcode: code, name: `Unknown (${code})`, quantity: qty || 1, found: false });
    _bulkRenderList(); _bulkSetStatus('🔍 Scanning…');
  }

  function _bulkRenderList() {
    const listEl = document.getElementById('bulkScannedList'), countEl = document.getElementById('bulkScanCount'),
          footerEl = document.getElementById('bulkFooter'), totalEl = document.getElementById('bulkTotalLabel'),
          confirmBtn = document.getElementById('bulkConfirmBtn');
    const total = BULK.items.reduce((s, i) => s + i.quantity, 0);
    if (countEl) countEl.textContent = `${BULK.items.length} scanned`;
    if (footerEl) footerEl.style.display = BULK.items.length ? '' : 'none';
    if (totalEl) totalEl.textContent = `${BULK.items.length} products · ${total} units`;
    if (confirmBtn) confirmBtn.disabled = !BULK.items.length;
    if (!listEl) return;
    if (!BULK.items.length) { listEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-3);font-size:13px;"><i class="fas fa-inbox" style="font-size:1.5rem;display:block;margin-bottom:8px;opacity:.35;"></i>Scanned items appear here</div>`; return; }
    listEl.innerHTML = BULK.items.map((item, idx) => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="width:32px;height:32px;border-radius:8px;background:${item.found ? '#d1fae5':'#fef3c7'};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i class="fas ${item.found ? 'fa-check':'fa-question'}" style="font-size:12px;color:${item.found ? '#059669':'#d97706'};"></i>
        </div>
        <div style="flex:1;min-width:0;">
          <p style="font-size:13px;font-weight:600;color:var(--text-1);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.name}</p>
          <p style="font-size:11px;color:var(--text-3);margin:1px 0 0;">${item.barcode}</p>
        </div>
        <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
          <button onclick="SmartScan._bulkQty(${idx},-1)" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:var(--surface);font-size:16px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;">−</button>
          <span style="font-size:14px;font-weight:700;min-width:28px;text-align:center;">${item.quantity}</span>
          <button onclick="SmartScan._bulkQty(${idx},1)"  style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:var(--surface);font-size:16px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;">+</button>
          <button onclick="SmartScan._bulkDel(${idx})" style="width:28px;height:28px;border-radius:6px;border:none;background:none;color:#ef4444;font-size:12px;cursor:pointer;">✕</button>
        </div>
      </div>`).join('');
  }

  function _bulkQty(idx, d) { if (BULK.items[idx]) { BULK.items[idx].quantity = Math.max(1, BULK.items[idx].quantity + d); _bulkRenderList(); } }
  function _bulkDel(idx) { BULK.items.splice(idx, 1); _bulkRenderList(); }
  function clearBulkList() { BULK.items = []; _bulkRenderList(); }
  function bulkManualEntry() { const c = prompt('Enter barcode:'); if (c?.trim()) _bulkHandleScan(c.trim()); }

  function _bulkPromptQty(barcode) {
    const modal = document.getElementById('bulkQtyModal'); if (!modal) return Promise.resolve(1);
    const ti = document.getElementById('bulkQtyTitle'), ni = document.getElementById('bulkQtyProductName'), qi = document.getElementById('bulkQtyInput');
    if (ti) ti.textContent = 'New Product'; if (ni) ni.textContent = `Barcode: ${barcode}`; if (qi) qi.value = '1';
    modal.style.display = ''; modal.classList.add('active');
    return new Promise(r => { BULK.pendingQtyResolve = qty => { closeModal('bulkQtyModal'); r(qty); }; });
  }

  function bulkQtyConfirm() {
    const qty = parseInt(document.getElementById('bulkQtyInput')?.value) || 1;
    if (BULK.pendingQtyResolve) { BULK.pendingQtyResolve(qty); BULK.pendingQtyResolve = null; }
  }

  async function confirmBulkReceive() {
    const btn = document.getElementById('bulkConfirmBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating…'; }
    let ok = 0, fail = 0;
    for (const item of BULK.items) {
      if (!item.id) continue;
      try {
        const curr = await window.API.get(`/items/${item.id}`);
        await window.API.put(`/items/${item.id}`, { stock_quantity: (curr?.stock_quantity || 0) + item.quantity });
        ok++;
      } catch (e) { console.warn('[Bulk]', item.name, e?.message); fail++; }
    }
    showToast(`✅ Updated ${ok} items${fail ? ` · ${fail} failed` : ''}`, ok ? 'success' : 'error');
    if (ok) { clearBulkList(); closeBulkScanner(); }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Confirm Receive Stock'; }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  CATEGORY TEMPLATES + UTILS
   * ══════════════════════════════════════════════════════════════════════════ */

  function openCategoryTemplateModal() {
    const el = document.getElementById('categoryTemplateModal');
    if (!el) return; el.style.display = ''; el.classList.add('active');
  }

  async function applyTemplate(templateName) {
    const btn = document.getElementById(`tplBtn_${templateName}`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    try {
      // Only pass branch_id if a specific branch is selected (not "All Branches" mode)
      const payload = {};
      if (window.AppState?.branch?.id) {
        payload.branch_id = window.AppState.branch.id;
      }
      const r = await window.API.post(`/vision/category/template/${templateName}`, payload);
      if (btn) { btn.disabled = false; btn.innerHTML = '✓ Applied'; btn.style.background = '#10b981'; }
      showToast(r.created ? `✅ Created ${r.created} categories` : 'Categories already exist', r.created ? 'success' : 'info');
      _catCache = null;
      if (typeof loadCategoriesForSelect === 'function') await loadCategoriesForSelect().catch(() => {});
      setTimeout(() => closeModal('categoryTemplateModal'), 1400);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = 'Apply'; }
      showToast(e?.message || 'Failed', 'error');
    }
  }

  async function resetAIUsage() {
    try {
      await window.API.post('/vision/usage/reset', {});
      _usageCache = null; _usageFetchedAt = 0;
      const u = await _getUsage(true);
      _renderUsagePill('ocrUsagePill', u);
      showToast('✅ Scan count reset', 'success');
    } catch (e) { showToast(e?.message || 'Reset failed', 'error'); }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  PUBLIC SURFACE
   * ══════════════════════════════════════════════════════════════════════════ */
  return {
    openCameraOCRModal, closeCameraOCRModal,
    ocrCapture, ocrNextStep, ocrRetake, ocrRetryFromStart, ocrFillForm, ocrGoToReview,
    _proceedToExpiry, _rescanBarcode,
    openBulkScannerModal, closeBulkScanner, startBulkScanner, pauseBulkScanner,
    clearBulkList, bulkManualEntry, bulkQtyConfirm, confirmBulkReceive,
    _bulkQty, _bulkDel,
    openCategoryTemplateModal, applyTemplate, resetAIUsage,
  };
})();

Object.keys(SmartScan).filter(k => !k.startsWith('_')).forEach(fn => window[fn] = SmartScan[fn]);
window.SmartScan = SmartScan;

console.log('[SmartScan] v11.0 — Barcode → Expiry photo → Parallel Gemini+User fill → Review');
