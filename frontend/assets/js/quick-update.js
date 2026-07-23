/**
 * Quick Update Module - Fast Item Editing
 * ═══════════════════════════════════════════════════════════════════════════════
 * FLOW:
 *   1. Click "Quick Update" or press F5
 *   2. Type/scan barcode OR type item name → live results appear
 *   3. Click result OR press Enter to load item
 *   4. Edit stock, prices, expiry
 *   5. "Update & Next" → ready for next scan
 */
window.QuickUpdate = (() => {

    const MODAL_ID = 'quickUpdateModal';

    const SESSION = {
        currentItem:  null,
        hasChanges:   false,
        searchTimer:  null,   // debounce timer for live search
    };

    function _generateAutoBatchNumber() {
        const d = new Date();
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        return `LOTX${Date.now().toString().slice(-5)}-${day}-${month}-${d.getFullYear()}`;
    }

    function _parseFlexibleDateInput(value) {
        const raw = String(value || '').trim();
        if (!raw) return null;
        const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
        const m = raw.match(/^(\d{1,2})[-\/. ](\d{1,2})[-\/. ](\d{4})$/);
        if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
        return raw;
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  OPEN / CLOSE
     * ════════════════════════════════════════════════════════════════════════ */

    function open() {
        const modal = document.getElementById(MODAL_ID);
        if (!modal) { console.error('[QuickUpdate] Modal not found'); return; }

        _resetSession();

        // Show modal — set display directly to avoid inline-style vs CSS-class conflict
        modal.style.display    = 'flex';
        modal.style.alignItems = 'flex-start';
        modal.style.paddingTop = 'max(1rem, 5vh)';
        modal.classList.add('active');

        // Hide item panel, clear search
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
        SESSION.hasChanges  = false;
        clearTimeout(SESSION.searchTimer);
        // Clear search results content
        const sr = document.getElementById('quSearchResults');
        if (sr) { sr.innerHTML = ''; }
        // Clear search input value
        const si = document.getElementById('quSearchInput');
        if (si) { si.value = ''; }
        // Let _showPanel handle all visibility — don't hide individual elements here
        _showPanel('search');
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  PANEL SWITCHING
     * ════════════════════════════════════════════════════════════════════════ */

    function _showPanel(panel) {
        const searchPanel = document.getElementById('quSearchPanel');
        const itemPanel   = document.getElementById('quItemPanel');
        const loading     = document.getElementById('quLoading');
        const notFound    = document.getElementById('quNotFound');

        if (searchPanel) searchPanel.style.display = panel === 'search' ? '' : 'none';
        if (itemPanel)   itemPanel.style.display   = panel === 'item'   ? '' : 'none';
        if (loading)     loading.style.display     = panel === 'loading'? '' : 'none';
        if (notFound)    notFound.style.display    = panel === 'notfound'? '' : 'none';
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  LIVE SEARCH  (debounced, 300ms)
     * ════════════════════════════════════════════════════════════════════════ */

    function onSearchInput(val) {
        clearTimeout(SESSION.searchTimer);
        const query = (val || '').trim();

        const resultsEl = document.getElementById('quSearchResults');
        if (!query) {
            if (resultsEl) resultsEl.innerHTML = '';
            return;
        }

        // Debounce 300ms
        SESSION.searchTimer = setTimeout(() => _runSearch(query), 300);
    }

    async function _runSearch(query) {
        const resultsEl = document.getElementById('quSearchResults');
        if (!resultsEl) return;

        resultsEl.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-3);font-size:12px;"><i class="fas fa-spinner fa-spin"></i> Searching…</div>';

        try {
            const branchId = window.AppState?.branch?.id || window.AppState?.currentUser?.branch_id || undefined;
            const params   = { search: query, page_size: 10 };
            if (branchId) params.branch_id = branchId;

            const items = await window.API.get('/items', params);
            const list  = Array.isArray(items) ? items : (items?.items || []);

            if (!list.length) {
                resultsEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:12px;">
                    <i class="fas fa-search" style="margin-right:6px;"></i>No items found for "<strong>${_esc(query)}</strong>"
                </div>`;
                return;
            }

            resultsEl.innerHTML = list.map(it => `
                <div class="qu-result-row" onclick="QuickUpdate._selectItem('${it.id}')"
                     style="display:flex;align-items:center;gap:10px;padding:10px 12px;
                            cursor:pointer;border-bottom:1px solid var(--border);
                            transition:background .15s;"
                     onmouseover="this.style.background='var(--surface-2,#f8fafc)'"
                     onmouseout="this.style.background=''">
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:600;color:var(--text-1);
                                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            ${_esc(it.name || 'Unnamed')}
                        </div>
                        <div style="font-size:11px;color:var(--text-3);margin-top:2px;">
                            ${it.barcode ? `<span style="font-family:monospace;">${_esc(it.barcode)}</span> · ` : ''}
                            Stock: <strong>${it.stock_quantity ?? 0}</strong>
                        </div>
                    </div>
                    <div style="font-size:12px;font-weight:700;color:var(--primary);white-space:nowrap;">
                        ${it.sell_price != null ? (window.AppState?.organization?.currency || '') + ' ' + Number(it.sell_price).toFixed(2) : ''}
                    </div>
                </div>
            `).join('');

        } catch (err) {
            resultsEl.innerHTML = `<div style="padding:12px;text-align:center;color:#ef4444;font-size:12px;">
                Search failed: ${_esc(err?.message || 'Unknown error')}
            </div>`;
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  BARCODE SUBMIT (Enter key or Scan button)
     * ════════════════════════════════════════════════════════════════════════ */

    function handleBarcodeInput(val) {
        const query = (val || '').trim();
        if (!query) return;
        // If it looks like a barcode (no spaces, reasonable length), try exact barcode lookup first
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
            // Barcode not found — fall back to search
            _showPanel('search');
            const resultsEl = document.getElementById('quSearchResults');
            if (resultsEl) {
                resultsEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:12px;">
                    <i class="fas fa-barcode" style="margin-right:6px;"></i>
                    Barcode <strong>${_esc(barcode)}</strong> not found — showing search results:
                </div>`;
            }
            // Run a search so user can find by name
            await _runSearch(barcode);
            showToast(`Barcode "${barcode}" not found — try searching by name`, 'warning');
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  SELECT ITEM (by ID, from search results)
     * ════════════════════════════════════════════════════════════════════════ */

    async function _selectItem(itemId) {
        _showPanel('loading');
        try {
            const item = await window.ItemsAPI.get(itemId);
            if (!item || !item.id) throw new Error('Item not found');
            _loadItem(item);
        } catch (err) {
            _showPanel('notfound');
            showToast(err?.message || 'Failed to load item', 'error');
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  LOAD ITEM INTO FORM
     * ════════════════════════════════════════════════════════════════════════ */

    function _loadItem(item) {
        SESSION.currentItem = item;
        SESSION.hasChanges  = false;

        // Safely set each field
        _setText('quItemName',      item.name || 'Unknown Item');
        _setText('quBarcodeDisplay', item.barcode || 'No barcode');
        _setText('quCurrentStock',  item.stock_quantity ?? 0);
        _setText('quCategory',      item.category_name || '-');
        _setText('quSupplier',      item.supplier_name || '-');
        _setText('quBranch',        item.branch_name   || 'All Branches');

        _setVal('quBuyPrice',   item.buy_price   ?? 0);
        _setVal('quSellPrice',  item.sell_price  ?? 0);
        _setVal('quMinStock',   item.min_stock_level ?? 10);
        _setVal('quStockAdjust', 0);
        _setVal('quExpiryDate', item.expiry_date || '');
        _setVal('quBatchNumber', item.batch_number || '');

        _showPanel('item');

        // Focus stock adjust
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
        _refreshStockPreview();
    }

    function _refreshStockPreview() {
        const base     = SESSION.currentItem?.stock_quantity ?? 0;
        const adj      = parseInt(document.getElementById('quStockAdjust')?.value) || 0;
        const newStock = base + adj;
        // Show preview in currentStock label (we repurpose it as "new stock")
        const el = document.getElementById('quCurrentStock');
        if (el) {
            el.textContent = newStock;
            el.style.color = newStock <= 0 ? '#ef4444' :
                             newStock <= (SESSION.currentItem?.min_stock_level || 10) ? '#f59e0b' : '#10b981';
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  SAVE
     * ════════════════════════════════════════════════════════════════════════ */

    async function saveAndNext() {
        if (!SESSION.currentItem) { showToast('No item loaded', 'error'); return; }

        const saveBtn = document.getElementById('quSaveBtn');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

        try {
            const stockAdj   = parseInt(document.getElementById('quStockAdjust')?.value) || 0;
            const buyPrice   = parseFloat(document.getElementById('quBuyPrice')?.value);
            const sellPrice  = parseFloat(document.getElementById('quSellPrice')?.value);
            const expiry     = _parseFlexibleDateInput(document.getElementById('quExpiryDate')?.value) || null;
            const batchNo    = document.getElementById('quAutoBatch')?.checked ? _generateAutoBatchNumber() : (document.getElementById('quBatchNumber')?.value || null);
            const minStock   = parseInt(document.getElementById('quMinStock')?.value) || 10;
            const batchNumber = document.getElementById('quBatchNumber')?.value?.trim() || null;

            if (stockAdj !== 0) {
                await window.ItemsAPI.updateStock(
                    SESSION.currentItem.id,
                    Math.abs(stockAdj),
                    stockAdj > 0 ? 'add' : 'subtract',
                    stockAdj > 0 ? { batch_number: batchNo, expiry_date: expiry, unit_cost: isNaN(buyPrice) ? undefined : buyPrice } : {}
                );
            }

            await window.ItemsAPI.update(SESSION.currentItem.id, {
                buy_price:       isNaN(buyPrice)  ? undefined : buyPrice,
                sell_price:      isNaN(sellPrice) ? undefined : sellPrice,
                expiry_date:     expiry,
                batch_number:    batchNo,
                min_stock_level: minStock,
            });

            _playSound('success');
            showToast(`✅ ${SESSION.currentItem.name} updated`, 'success');

            // Go back to search for next item
            SESSION.currentItem = null;
            SESSION.hasChanges  = false;
            _showPanel('search');
            const inp = document.getElementById('quSearchInput');
            if (inp) { inp.value = ''; inp.focus(); }
            const sr = document.getElementById('quSearchResults');
            if (sr) sr.innerHTML = '';

        } catch (err) {
            console.error('[QuickUpdate] Save error:', err);
            showToast(err?.message || 'Failed to update item', 'error');
            _playSound('error');
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i class="fas fa-save"></i> Update & Next';
            }
        }
    }

    async function saveAndClose() {
        await saveAndNext();
        close();
        if (typeof loadItems === 'function') loadItems();
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  HELPERS
     * ════════════════════════════════════════════════════════════════════════ */

    function _setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }
    function _setVal(id, val) {
        const el = document.getElementById(id);
        if (el) el.value = val;
    }
    function _esc(str) {
        return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  KEYBOARD SHORTCUTS
     * ════════════════════════════════════════════════════════════════════════ */

    function _handleKeydown(e) {
        const modal = document.getElementById(MODAL_ID);
        if (!modal?.classList.contains('active')) return;

        if (e.key === 'Escape') { e.preventDefault(); close(); return; }

        if (SESSION.currentItem) {
            if (e.key === 'ArrowUp')   { e.preventDefault(); adjustStock(1);  return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); adjustStock(-1); return; }
            if (e.key === 'n' || e.key === 'N') {
                const active = document.activeElement?.tagName;
                if (!['INPUT','TEXTAREA'].includes(active)) { e.preventDefault(); saveAndNext(); }
            }
        }

        // Enter on search input → submit
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
        if (!window.XScanner) { showToast('Scanner not available', 'error'); return; }
        window.XScanner.open({
            target: 'quick-update',
            onResult: (code) => { window.XScanner.close(); if (code) handleBarcodeInput(code); },
            onError:  (msg)  => showToast('Scanner error: ' + msg, 'error'),
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  AUDIO
     * ════════════════════════════════════════════════════════════════════════ */

    function _playSound(type) {
        try {
            const ctx  = new (window.AudioContext || window.webkitAudioContext)();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.value = type === 'success' ? 800 : 300;
            gain.gain.value = 0.08;
            osc.start(); osc.stop(ctx.currentTime + (type === 'success' ? 0.1 : 0.2));
        } catch (_) {}
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  PUBLIC API
     * ════════════════════════════════════════════════════════════════════════ */

    return {
        open, close,
        handleBarcodeInput,
        onSearchInput,
        _selectItem,
        _showPanel,
        _refreshStockPreview,
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
