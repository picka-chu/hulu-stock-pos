/**
 * Quick Update Module - Fast Item Editing
 * ═══════════════════════════════════════════════════════════════════════════════
 * FLOW:
 *   1. Click "Quick Update" or press F5
 *   2. Type/scan barcode OR type item name → live results appear
 *   3. Click result OR press Enter to load item
 *   4. Edit stock, prices, expiry, batch
 *   5. "Update & Next" saves and resets for the next scan
 */
window.QuickUpdate = (() => {

    const MODAL_ID = 'quickUpdateModal';

    const SESSION = {
        currentItem:  null,
        baseStock:    0,
        hasChanges:   false,
        searchTimer:  null,
    };

    /* ════════════════════════════════════════════════════════════════════════
     *  HELPERS
     * ════════════════════════════════════════════════════════════════════════ */

    function _esc(str) {
        return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function _setVal(id, val) {
        const el = document.getElementById(id);
        if (el) { el.value = val; }
    }

    function _getVal(id) {
        const el = document.getElementById(id);
        return el ? el.value : '';
    }

    function _generateAutoBatchNumber() {
        const d = new Date();
        const day = String(d.getDate()).padStart(2, '0');
        const mon = String(d.getMonth() + 1).padStart(2, '0');
        return `LOT${d.getFullYear()}${mon}${day}-${Date.now().toString().slice(-5)}`;
    }

    function _parseFlexibleDateInput(value) {
        const raw = String(value || '').trim();
        if (!raw) return null;
        const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
        const m = raw.match(/^(\d{1,2})[-\/. ](\d{1,2})[-\/. ](\d{4})$/);
        if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        return raw;
    }

    function _playSound(type) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = type === 'success' ? 880 : 260;
            gain.gain.value = 0.06;
            osc.start();
            osc.stop(ctx.currentTime + (type === 'success' ? 0.08 : 0.18));
        } catch (_) {}
    }

    function _showToast(msg, type) {
        if (typeof showToast === 'function') {
            showToast(msg, type);
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  PANEL SWITCHING
     * ════════════════════════════════════════════════════════════════════════ */

    function _showPanel(panel) {
        ['quSearchPanel', 'quItemPanel', 'quLoading', 'quNotFound'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        const map = { search: 'quSearchPanel', item: 'quItemPanel', loading: 'quLoading', notfound: 'quNotFound' };
        const target = document.getElementById(map[panel]);
        if (target) target.style.display = '';
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  OPEN / CLOSE
     * ════════════════════════════════════════════════════════════════════════ */

    function open() {
        const modal = document.getElementById(MODAL_ID);
        if (!modal) { console.error('[QuickUpdate] Modal not found'); return; }

        _resetSession();
        modal.style.display = 'flex';
        modal.style.alignItems = 'flex-start';
        modal.style.paddingTop = 'max(1rem, 5vh)';
        modal.classList.add('active');
        _showPanel('search');

        setTimeout(() => {
            const inp = document.getElementById('quSearchInput');
            if (inp) { inp.value = ''; inp.focus(); }
        }, 150);

        document.addEventListener('keydown', _handleKeydown);
    }

    function close() {
        if (SESSION.hasChanges) {
            if (!confirm('You have unsaved changes. Close anyway?')) return;
        }
        const modal = document.getElementById(MODAL_ID);
        if (modal) { modal.classList.remove('active'); modal.style.display = 'none'; }
        window.XScanner?.close();
        document.removeEventListener('keydown', _handleKeydown);
        _resetSession();
    }

    function _resetSession() {
        SESSION.currentItem = null;
        SESSION.baseStock = 0;
        SESSION.hasChanges = false;
        clearTimeout(SESSION.searchTimer);
        const sr = document.getElementById('quSearchResults');
        if (sr) sr.innerHTML = '';
        const si = document.getElementById('quSearchInput');
        if (si) si.value = '';
        _showPanel('search');
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  LIVE SEARCH
     * ════════════════════════════════════════════════════════════════════════ */

    function onSearchInput(val) {
        clearTimeout(SESSION.searchTimer);
        const query = (val || '').trim();
        const resultsEl = document.getElementById('quSearchResults');
        if (!query) {
            if (resultsEl) resultsEl.innerHTML = '';
            return;
        }
        SESSION.searchTimer = setTimeout(() => _runSearch(query), 250);
    }

    async function _runSearch(query) {
        const resultsEl = document.getElementById('quSearchResults');
        if (!resultsEl) return;

        resultsEl.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-3);font-size:12px;"><i class="fas fa-spinner fa-spin"></i> Searching…</div>';

        try {
            const branchId = window.AppState?.branch?.id || window.AppState?.currentUser?.branch_id || undefined;
            const params = { search: query, page_size: 12 };
            if (branchId) params.branch_id = branchId;

            const items = await window.API.get('/items', params);
            const list = Array.isArray(items) ? items : (items?.items || []);

            if (!list.length) {
                resultsEl.innerHTML = `
                    <div style="padding:20px;text-align:center;">
                        <i class="fas fa-search" style="font-size:20px;color:var(--text-3);opacity:.4;display:block;margin-bottom:8px;"></i>
                        <p style="font-size:13px;color:var(--text-2);">No items found for "<strong>${_esc(query)}</strong>"</p>
                        <p style="font-size:11px;color:var(--text-3);margin-top:4px;">Try a different name or scan the barcode</p>
                    </div>`;
                return;
            }

            resultsEl.innerHTML = list.map(it => {
                const stock = it.stock_quantity ?? 0;
                const stockColor = stock <= 0 ? 'var(--danger)' : stock <= (it.min_stock_level || 10) ? 'var(--warning)' : 'var(--success)';
                return `<div class="qu-result-row" onclick="QuickUpdate._selectItem('${it.id}')"
                     style="display:flex;align-items:center;gap:12px;padding:12px 14px;
                            cursor:pointer;border-bottom:1px solid var(--border);
                            transition:all .12s;"
                     onmouseover="this.style.background='var(--primary-ultra)'"
                     onmouseout="this.style.background=''">
                    <div style="width:36px;height:36px;border-radius:8px;background:var(--bg);
                                display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;">📦</div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:600;color:var(--text-1);
                                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            ${_esc(it.name || 'Unnamed')}
                        </div>
                        <div style="font-size:11px;color:var(--text-3);margin-top:2px;">
                            ${it.barcode ? `<span style="font-family:monospace;background:var(--bg);padding:1px 6px;border-radius:4px;">${_esc(it.barcode)}</span> · ` : ''}
                            ${it.category_name || ''}
                        </div>
                    </div>
                    <div style="text-align:right;flex-shrink:0;">
                        <div style="font-size:11px;color:var(--text-3);">Stock</div>
                        <div style="font-size:18px;font-weight:800;color:${stockColor};line-height:1.2;">${stock}</div>
                    </div>
                    <div style="font-size:13px;font-weight:600;color:var(--primary);white-space:nowrap;padding-left:4px;">
                        ${it.sell_price != null ? _currency() + ' ' + Number(it.sell_price).toFixed(2) : ''}
                    </div>
                </div>`;
            }).join('');

        } catch (err) {
            resultsEl.innerHTML = `<div style="padding:16px;text-align:center;color:var(--danger);font-size:13px;">
                <i class="fas fa-exclamation-triangle"></i> Search failed: ${_esc(err?.message || 'Unknown error')}
            </div>`;
        }
    }

    function _currency() {
        return window.AppState?.organization?.currency || '';
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  BARCODE SUBMIT
     * ════════════════════════════════════════════════════════════════════════ */

    function handleBarcodeInput(val) {
        const query = (val || '').trim();
        if (!query) return;
        const looksLikeBarcode = /^[A-Za-z0-9\-]{3,50}$/.test(query) && !query.includes(' ');
        if (looksLikeBarcode) {
            _loadByBarcode(query);
        } else {
            _runSearch(query);
        }
    }

    async function _loadByBarcode(barcode) {
        _showPanel('loading');
        try {
            const item = await window.ItemsAPI.getByBarcode(barcode);
            if (!item || !item.id) throw new Error('Item not found');
            _loadItem(item);
        } catch (err) {
            _showPanel('search');
            const resultsEl = document.getElementById('quSearchResults');
            if (resultsEl) {
                resultsEl.innerHTML = `
                    <div style="padding:14px;display:flex;gap:10px;align-items:center;
                                background:var(--warning-light,#fef3c7);border-bottom:1px solid var(--border);">
                        <i class="fas fa-barcode" style="color:var(--warning);font-size:14px;"></i>
                        <div style="font-size:12px;color:var(--text-1);">
                            Barcode <strong style="font-family:monospace;">${_esc(barcode)}</strong> not found —
                            showing items matching that code below
                        </div>
                    </div>`;
                resultsEl.innerHTML += '<div style="padding:12px;text-align:center;color:var(--text-3);font-size:12px;"><i class="fas fa-spinner fa-spin"></i> Searching…</div>';
            }
            await _runSearch(barcode);
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  SELECT ITEM BY ID
     * ════════════════════════════════════════════════════════════════════════ */

    async function _selectItem(itemId) {
        _showPanel('loading');
        try {
            const item = await window.ItemsAPI.get(itemId);
            if (!item || !item.id) throw new Error('Item not found');
            _loadItem(item);
        } catch (err) {
            _showPanel('notfound');
            _showToast(err?.message || 'Failed to load item', 'error');
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  LOAD ITEM INTO FORM
     * ════════════════════════════════════════════════════════════════════════ */

    function _loadItem(item) {
        SESSION.currentItem = item;
        SESSION.baseStock = item.stock_quantity ?? 0;
        SESSION.hasChanges = false;

        _setText('quItemName', item.name || 'Unknown Item');
        _setText('quBarcodeDisplay', item.barcode || 'No barcode');
        _setText('quCategory', item.category_name || '-');
        _setText('quSupplier', item.supplier_name || '-');
        _setText('quBranch', item.branch_name || 'All Branches');

        _setText('quCurrentStock', SESSION.baseStock);
        _updateStockColor(SESSION.baseStock);

        _setVal('quBuyPrice', item.buy_price ?? '');
        _setVal('quSellPrice', item.sell_price ?? '');
        _setVal('quMinStock', item.min_stock_level ?? 10);
        _setVal('quStockAdjust', 0);
        _setVal('quExpiryDate', item.expiry_date || '');
        _setVal('quBatchNumber', item.batch_number || '');

        _updateStockPreview();

        _showPanel('item');

        setTimeout(() => document.getElementById('quStockAdjust')?.focus(), 100);
        _playSound('success');
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  STOCK ADJUSTMENT
     * ════════════════════════════════════════════════════════════════════════ */

    function adjustStock(amount) {
        const input = document.getElementById('quStockAdjust');
        if (!input) return;
        input.value = (parseInt(input.value) || 0) + Number(amount);
        SESSION.hasChanges = true;
        _updateStockPreview();
    }

    function _updateStockPreview() {
        const adj = parseInt(document.getElementById('quStockAdjust')?.value) || 0;
        const newStock = SESSION.baseStock + adj;

        const valEl = document.getElementById('quNewStockVal');
        if (valEl) {
            valEl.textContent = newStock;
            valEl.style.color = newStock <= 0 ? 'var(--danger)' :
                newStock <= (SESSION.currentItem?.min_stock_level || 10) ? 'var(--warning)' : 'var(--text-1)';
        }

        _updateStockColor(newStock);
    }

    function _updateStockColor(val) {
        const el = document.getElementById('quCurrentStock');
        if (el) {
            el.style.color = val <= 0 ? 'var(--danger)' :
                val <= (SESSION.currentItem?.min_stock_level || 10) ? 'var(--warning)' : 'var(--success)';
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  SAVE
     * ════════════════════════════════════════════════════════════════════════ */

    async function saveAndNext() {
        if (!SESSION.currentItem) { _showToast('No item loaded', 'error'); return; }

        const saveBtn = document.getElementById('quSaveBtn');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

        try {
            const itemId = SESSION.currentItem.id;
            const stockAdj = parseInt(document.getElementById('quStockAdjust')?.value) || 0;
            const buyPrice = parseFloat(document.getElementById('quBuyPrice')?.value);
            const sellPrice = parseFloat(document.getElementById('quSellPrice')?.value);
            const expiry = _parseFlexibleDateInput(document.getElementById('quExpiryDate')?.value);
            const minStock = parseInt(document.getElementById('quMinStock')?.value) || 10;
            const autoBatch = document.getElementById('quAutoBatch')?.checked;
            const manualBatch = document.getElementById('quBatchNumber')?.value?.trim() || null;
            const batchNo = autoBatch ? _generateAutoBatchNumber() : manualBatch;

            const updates = {};
            let stockPromise = Promise.resolve();

            // Stock adjustment
            if (stockAdj !== 0) {
                const absAdj = Math.abs(stockAdj);
                const isAdd = stockAdj > 0;
                const batchInfo = isAdd ? {
                    ...(batchNo ? { batch_number: batchNo } : {}),
                    ...(expiry ? { expiry_date: expiry } : {}),
                    ...(!isNaN(buyPrice) ? { unit_cost: buyPrice } : {}),
                } : {};
                stockPromise = window.ItemsAPI.updateStock(itemId, absAdj, isAdd ? 'add' : 'subtract', batchInfo);
            }

            // Price / min-stock / expiry updates
            if (!isNaN(buyPrice)) updates.buy_price = buyPrice;
            if (!isNaN(sellPrice)) updates.sell_price = sellPrice;
            if (expiry) updates.expiry_date = expiry;
            updates.min_stock_level = minStock;
            if (batchNo) updates.batch_number = batchNo;

            await stockPromise;

            if (Object.keys(updates).length) {
                await window.ItemsAPI.update(itemId, updates);
            }

            _playSound('success');
            _showToast(`✅ ${SESSION.currentItem.name} updated`, 'success');

            // Reset for next item
            SESSION.currentItem = null;
            SESSION.baseStock = 0;
            SESSION.hasChanges = false;
            _showPanel('search');
            const inp = document.getElementById('quSearchInput');
            if (inp) { inp.value = ''; inp.focus(); }
            const sr = document.getElementById('quSearchResults');
            if (sr) sr.innerHTML = '';

            // Refresh the items table in the background
            if (typeof loadItems === 'function') loadItems();

        } catch (err) {
            console.error('[QuickUpdate] Save error:', err);
            _showToast(err?.message || 'Failed to update item', 'error');
            _playSound('error');
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i class="fas fa-save"></i> Update &amp; Next';
            }
        }
    }

    async function saveAndClose() {
        await saveAndNext();
        close();
        if (typeof loadItems === 'function') loadItems();
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  KEYBOARD SHORTCUTS
     * ════════════════════════════════════════════════════════════════════════ */

    function _handleKeydown(e) {
        const modal = document.getElementById(MODAL_ID);
        if (!modal?.classList.contains('active')) return;

        if (e.key === 'Escape') { e.preventDefault(); close(); return; }

        if (SESSION.currentItem) {
            if (e.key === 'ArrowUp') { e.preventDefault(); adjustStock(1); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); adjustStock(-1); return; }
            if (e.key === 'n' || e.key === 'N') {
                const active = document.activeElement?.tagName;
                if (!['INPUT', 'TEXTAREA'].includes(active)) { e.preventDefault(); saveAndNext(); }
            }
        }

        if (e.key === 'Enter') {
            const focused = document.activeElement;
            if (focused?.id === 'quSearchInput') {
                e.preventDefault();
                handleBarcodeInput(focused.value);
            }
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  SCANNER INTEGRATION
     * ════════════════════════════════════════════════════════════════════════ */

    function openBarcodeScanner() {
        if (!window.XScanner) { _showToast('Scanner not available', 'error'); return; }
        window.XScanner.open({
            target: 'quick-update',
            onResult: (code) => { window.XScanner.close(); if (code) handleBarcodeInput(code); },
            onError: (msg) => _showToast('Scanner error: ' + msg, 'error'),
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  WIRE UP STOCK ADJUST INPUT TO PREVIEW
     * ════════════════════════════════════════════════════════════════════════ */

    // Listen for stock adjust input changes to update preview
    document.addEventListener('input', (e) => {
        if (e.target.id === 'quStockAdjust') {
            SESSION.hasChanges = true;
            _updateStockPreview();
        }
    });

    /* ════════════════════════════════════════════════════════════════════════
     *  PUBLIC API
     * ════════════════════════════════════════════════════════════════════════ */

    return {
        open, close,
        handleBarcodeInput,
        onSearchInput,
        _selectItem,
        _showPanel,
        adjustStock,
        saveAndNext,
        saveAndClose,
        openBarcodeScanner,
    };

})();

// Global F5 shortcut
document.addEventListener('keydown', e => {
    if (e.key === 'F5' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        window.QuickUpdate.open();
    }
});