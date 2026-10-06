/**
 * Hulu Stock POS - Main Application
 * Complete application with role-based access control
 */

// Global application state
const AppState = {
    currentUser: null,
    organization: null,
    branch: null,
    currentPage: 'dashboard',
    cart: [],
    items: [],
    categories: [],
    suppliers: [],
    sales: [],
    expenses: [],
    bankAccounts: [],
    mobileAccounts: [],   // mobile money providers
    units: [],
    tiersCache: {},       // itemId -> { priceByUnit: { unitId -> {price, multiplier, level} } }
    users: [],
    branches: [],
    salesChart: null,
    bankTab: 'bank'       // 'bank' | 'mobile_money' — current active tab on bank page
};
window.AppState = AppState;  // export so other scripts can access it

// ── XSS escape helper — ALWAYS use for user-supplied data in innerHTML ────────
function esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}



// Role-based access control


// ── Camera availability ───────────────────────────────────────────────────────
let _cameraAvailable = null;   // null=unknown, true/false after first check

async function checkCameraAvailable() {
    if (_cameraAvailable !== null) return _cameraAvailable;
    // Synchronous best-effort answer so first-call consumers (scan buttons)
    // don't lock into "no camera": mediaDevices existing means a camera MAY
    // exist; the async enumeration then corrects the cached value.
    const _maybe = !!(navigator.mediaDevices?.enumerateDevices);
    if (!_maybe) {
        _cameraAvailable = false;
        return false;
    }
    // Fire-and-forget the async check — don't block POS render.
    navigator.mediaDevices.enumerateDevices().then(devices => {
        _cameraAvailable = devices.some(d => d.kind === 'videoinput');
    }).catch(() => { _cameraAvailable = false; });
    _cameraAvailable = true; // optimistic until enumeration resolves
    return true;
}

// ── Branch context helper ──────────────────────────────────────────────────────
// Returns { branch_id: 'uuid' } or {} depending on what's selected.
// Used by all list API calls to scope data to the current branch.
// Admin with "All Branches" selected → {} → sees everything.
// Any user with a branch selected/assigned → { branch_id: 'uuid' } → sees only that branch.
function _branchParam() {
    const branchId = AppState.branch?.id || null;
    return branchId ? { branch_id: branchId } : {};
}

// ── "All Branches" mode guard ─────────────────────────────────────────────────
// Returns true when no specific branch is selected (admin "all branches" view).
// Cashiers always have a branch so this is always false for them.
function _isAllBranches() {
    return !AppState.branch?.id;
}

// Pages where write actions (Add/Edit/Delete) should be disabled in "all branches" mode.
// POS is fully blocked — you can't sell without knowing which branch's stock to deduct.
const _BRANCH_REQUIRED_WRITE = ['pos', 'items', 'categories', 'suppliers', 'expenses'];

/**
 * Call on every page load. Handles two cases:
 *  1. POS page → inject a full-page "select a branch" overlay that blocks interaction.
 *  2. Other write pages → disable Add buttons and show a banner.
 * When a branch IS selected, removes all guards.
 */
function _applyBranchGuards(page) {
    const noBranch = _isAllBranches();
    const role = AppState.currentUser?.role || 'cashier';

    // Only admins/managers can be in "all branches" mode — cashiers are always locked to a branch.
    // If user is a cashier somehow with no branch, that's a config error, not our guard.
    if (role === 'cashier') return;

    // ── POS: full overlay block ───────────────────────────────────────────────
    const posPage = document.getElementById('posPage');
    let posOverlay = document.getElementById('posBranchOverlay');

    if (page === 'pos') {
        const branchInactive = AppState.branch?.is_active === false;
        const showOverlay    = noBranch || branchInactive;

        if (showOverlay) {
            if (!posOverlay) {
                posOverlay = document.createElement('div');
                posOverlay.id = 'posBranchOverlay';
                posOverlay.style.cssText = [
                    'position:absolute', 'inset:0', 'z-index:500',
                    'background:rgba(var(--bg-rgb,248,250,252),0.96)',
                    'backdrop-filter:blur(4px)',
                    'display:flex', 'flex-direction:column',
                    'align-items:center', 'justify-content:center',
                    'gap:16px', 'border-radius:var(--radius-lg)',
                    'text-align:center', 'padding:2rem'
                ].join(';');
                if (posPage) {
                    posPage.style.position = 'relative';
                    posPage.appendChild(posOverlay);
                }
            }
            if (branchInactive) {
                posOverlay.innerHTML = `
                    <div style="width:72px;height:72px;border-radius:50%;
                                background:#fef2f2;display:flex;align-items:center;
                                justify-content:center;font-size:2rem;border:2px solid #ef4444;">
                        🚫
                    </div>
                    <div>
                        <div style="font-size:1.1rem;font-weight:700;color:#ef4444;margin-bottom:6px;">
                            Branch Deactivated
                        </div>
                        <div style="font-size:.875rem;color:var(--text-2);max-width:320px;line-height:1.6;">
                            <strong>${esc(AppState.branch?.name || 'This branch')}</strong> has been deactivated.
                            Sales and stock changes are blocked. Contact your administrator.
                        </div>
                    </div>`;
            } else {
                posOverlay.innerHTML = `
                    <div style="width:72px;height:72px;border-radius:50%;
                                background:var(--warning-ultra,#fffbeb);
                                display:flex;align-items:center;justify-content:center;
                                font-size:2rem;border:2px solid var(--warning,#f59e0b);">
                        🏪
                    </div>
                    <div>
                        <div style="font-size:1.1rem;font-weight:700;color:var(--text-1);margin-bottom:6px;">
                            Select a Branch to Start Selling
                        </div>
                        <div style="font-size:.875rem;color:var(--text-2);max-width:320px;line-height:1.6;">
                            POS requires a specific branch so stock is deducted from the right location.
                            Choose a branch from the selector above.
                        </div>
                    </div>
                    <button onclick="document.getElementById('branchSelector').focus()"
                            class="btn btn-primary" style="margin-top:4px;">
                        <i class="fas fa-code-branch"></i> Choose Branch
                    </button>`;
            }
            posOverlay.style.display = 'flex';
        } else {
            if (posOverlay) posOverlay.style.display = 'none';
        }
        return; // POS handled — done
    }

    // ── Other pages: disable Add button + show banner ─────────────────────────
    if (!_BRANCH_REQUIRED_WRITE.includes(page)) return;

    const pageEl = document.getElementById(`${page}Page`);
    if (!pageEl) return;

    // Remove stale banner if exists
    const oldBanner = pageEl.querySelector('.all-branches-banner');
    if (oldBanner) oldBanner.remove();

    // Buttons to disable when no branch selected
    const addBtnIds = {
        items:      ['addItemBtn'],
        categories: ['addCategoryBtn'],
        suppliers:  ['addSupplierBtn'],
        expenses:   ['addExpenseBtn'],
    };

    const branchDeactivated = !noBranch && AppState.branch?.is_active === false;
    const shouldBlock = noBranch || branchDeactivated;

    if (shouldBlock) {
        // Inject banner at top of page
        const banner = document.createElement('div');
        banner.className = 'all-branches-banner';
        if (branchDeactivated) {
            // Red "deactivated" banner
            banner.style.cssText = [
                'display:flex', 'align-items:center', 'gap:10px',
                'background:#fef2f2',
                'border:1.5px solid #ef4444',
                'border-radius:var(--radius)', 'padding:10px 16px',
                'margin-bottom:14px', 'font-size:.8125rem',
                'color:var(--text-1)'
            ].join(';');
            banner.innerHTML = `
                <i class="fas fa-ban" style="color:#ef4444;font-size:1rem;flex-shrink:0;"></i>
                <span>
                    <strong style="color:#ef4444;">${esc(AppState.branch?.name || 'This branch')} is deactivated.</strong>
                    Adding and editing records is blocked. Contact your administrator to reactivate.
                </span>`;
        } else {
            // Yellow "all branches" banner
            banner.style.cssText = [
                'display:flex', 'align-items:center', 'gap:10px',
                'background:var(--warning-ultra,#fffbeb)',
                'border:1.5px solid var(--warning,#f59e0b)',
                'border-radius:var(--radius)', 'padding:10px 16px',
                'margin-bottom:14px', 'font-size:.8125rem',
                'color:var(--text-1)'
            ].join(';');
            banner.innerHTML = `
                <i class="fas fa-code-branch" style="color:#f59e0b;font-size:1rem;flex-shrink:0;"></i>
                <span>
                    <strong>Viewing all branches.</strong>
                    Select a specific branch from the top selector to add or edit records.
                </span>`;
        }
        pageEl.insertBefore(banner, pageEl.firstChild);

        // Disable add buttons
        const disabledTitle = branchDeactivated ? 'Branch is deactivated' : 'Select a branch first';
        (addBtnIds[page] || []).forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.disabled = true;
                btn.title = disabledTitle;
                btn.style.opacity = '0.45';
                btn.style.cursor = 'not-allowed';
                btn.dataset.branchGuarded = '1';
            }
        });
        // Disable fast-scan / smart-add buttons on items page
        if (page === 'items') {
            pageEl.querySelectorAll('[onclick*="FastScan"],[onclick*="SmartScan"],[onclick*="openBulk"]').forEach(btn => {
                btn.disabled = true;
                btn.title = disabledTitle;
                btn.style.opacity = '0.45';
                btn.style.cursor = 'not-allowed';
                btn.dataset.branchGuarded = '1';
            });
        }
    } else {
        // Branch is selected and active — re-enable all guarded buttons
        (addBtnIds[page] || []).forEach(id => {
            const btn = document.getElementById(id);
            if (btn && btn.dataset.branchGuarded) {
                btn.disabled = false;
                btn.title = '';
                btn.style.opacity = '';
                btn.style.cursor = '';
                delete btn.dataset.branchGuarded;
            }
        });
        if (page === 'items') {
            pageEl.querySelectorAll('[data-branch-guarded="1"]').forEach(btn => {
                btn.disabled = false;
                btn.title = '';
                btn.style.opacity = '';
                btn.style.cursor = '';
                delete btn.dataset.branchGuarded;
            });
        }
    }
}

const Permissions = {
    admin: {
        pages: ['dashboard', 'pos', 'items', 'categories', 'branches', 'suppliers', 'sales', 'expenses', 'bank', 'reports', 'users', 'notifications', 'settings'],
        canManageUsers: true,
        canViewReports: true,
        canManageExpenses: true,
        canManageBank: true,
        canManageSettings: true
    },
    manager: {
        pages: ['dashboard', 'pos', 'items', 'categories', 'branches', 'suppliers', 'sales', 'expenses', 'bank', 'reports', 'notifications', 'settings'],
        canManageUsers: false,
        canViewReports: true,
        canManageExpenses: true,
        canManageBank: true,
        canManageSettings: false
    },
    cashier: {
        pages: ['dashboard', 'pos', 'items', 'sales', 'notifications', 'settings'],
        canManageUsers: false,
        canViewReports: false,
        canManageExpenses: false,
        canManageBank: false,
        canManageSettings: false
    }
};

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Hulu Stock initializing...');

    // ── PWA: Register service worker ──────────────────────────────────────────
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
            .then(reg => {
                console.log('[SW] Registered:', reg.scope);

                // Listen for messages from SW
                navigator.serviceWorker.addEventListener('message', e => {
                    // Navigation from push notification click
                    if (e.data?.type === 'NAVIGATE' && e.data.url) {
                        const page = new URL(e.data.url, location.origin).searchParams.get('page');
                        if (page) navigateTo(page);
                    }
                    if (e.data?.type === 'PUSH_SUBSCRIPTION_CHANGED') resubscribePush?.();

                    // ── AUTO-UPDATE: New SW activated → show update banner ──────
                    if (e.data?.type === 'SW_UPDATED') {
                        _showUpdateBanner();
                    }
                });

                // Also detect when a new SW is waiting (installed but not yet active)
                // This catches cases where skipWaiting doesn't fire immediately
                reg.addEventListener('updatefound', () => {
                    const newWorker = reg.installing;
                    if (!newWorker) return;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            // New SW is waiting — tell it to activate now
                            newWorker.postMessage({ type: 'SKIP_WAITING' });
                        }
                    });
                });
            })
            .catch(err => console.warn('[SW] Registration failed:', err));

        // When SW controller changes (new SW took over) → reload to get fresh code
        let _swRefreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (_swRefreshing) return;
            _swRefreshing = true;
            console.log('[SW] Controller changed — reloading for fresh code');
            window.location.reload();
        });
    }

    // ── Auto-refresh when a new SW version activates ─────────────────────────
    function _showUpdateBanner() {
        if (_swRefreshing) return;
        _swRefreshing = true;
        // Don't reload if there's an active POS sale in progress
        if (typeof AppState !== 'undefined' && AppState?.cart?.length > 0) {
            _swRefreshing = false;
            // Defer: check again in 30s
            setTimeout(_showUpdateBanner, 30000);
            return;
        }
        console.log('[SW] New version ready — auto-refreshing');
        window.location.reload();
    }

    // ── PWA: Capture install prompt (Add to Home Screen) ─────────────────────
    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        window._pwaInstallPrompt = e;
        // Show install banner if not already installed
        _showInstallBanner();
    });
    window.addEventListener('appinstalled', () => {
        window._pwaInstallPrompt = null;
        const banner = document.getElementById('pwaInstallBanner');
        if (banner) banner.remove();
        console.log('[PWA] App installed to home screen');
    });

    // Check authentication - but allow cached data to work
    const token = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
    const cachedUserData = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.USER_DATA || 'rf_user_data');
    
    // Allow app to load if there's cached user data, even without token
    // The app will work in limited mode (using cached data) until API is available
    if (!token && !cachedUserData) {
        window.location.href = 'login.html';
        return;
    }
    
    // Load user data - try API first, fall back to cached data
    try {
        await loadUserData();
    } catch (error) {
        console.warn('Failed to load user data from API, using cached data:', error);
        // Check if we have cached data - if so, continue without redirecting
        if (!cachedUserData) {
            console.error('No cached user data available');
            localStorage.removeItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
            window.location.href = 'login.html';
            return;
        }
        // We have cached data, continue loading the app
    }
    
    // Apply role-based access control
    applyRBAC();
    
    // Initialize UI
    initializeUI();
    
    // Load branch selector with the currently selected branch pre-selected
    await loadBranchesForSelect('branchSelector', AppState.branch?.id, 'All Branches');

    // After selector is populated: if AppState.branch is null but the selector
    // has a value (e.g. pre-selected from previous session), sync AppState.branch.
    // This ensures branch_id is never null when the user opens Fast Scan.
    const _bsSel = document.getElementById('branchSelector');
    if (_bsSel?.value && !AppState.branch) {
        try {
            const _b = await window.BranchesAPI.get(_bsSel.value);
            if (_b?.id) {
                AppState.branch = _b;
                localStorage.setItem(window.AppConfig?.STORAGE_KEYS?.BRANCH || 'rf_branch', JSON.stringify(_b));
                console.log('[Init] AppState.branch synced from selector:', _b.name);
            }
        } catch (_) {}
    }
    
    // Setup event listeners
    setupEventListeners();
    
    // Initialize sidebar state (open on desktop, closed on mobile)
    initSidebar();
    
    // Re-check sidebar on resize (mobile ↔ desktop)
    let _resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(initSidebar, 200);
    });
    
    // Load initial data — then restore last page if any
    await loadDashboardData();
    const _savedPage = (() => { try { return localStorage.getItem('rf_last_page'); } catch(_) { return null; } })();
    if (_savedPage && _savedPage !== 'dashboard' && AppState.currentUser) {
        // Restore last page after dashboard data loads
        setTimeout(() => {
            try {
                navigateTo(_savedPage);
                // Ensure branch selector reflects current AppState.branch after restore
                const bsSel = document.getElementById('branchSelector');
                if (bsSel && AppState.branch?.id) {
                    bsSel.value = AppState.branch.id;
                }
            } catch(_) {}
        }, 100);
    }
    
    // Initialize real-time notifications
    initializeRealtimeNotifications();

    // Initialize HID scanner (USB/Bluetooth keyboard-wedge)
    HIDScanner.init();

    // PWA offline/online detection
    window.addEventListener('offline', () => {
        showToast('⚠️ You are offline — changes may not save until connection is restored', 'warning');
        const badge = document.createElement('div');
        badge.id = '_offlineBadge';
        badge.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#f59e0b;color:#fff;text-align:center;font-size:12px;font-weight:600;padding:4px;z-index:9999;';
        badge.textContent = '⚠️  No internet connection';
        if (!document.getElementById('_offlineBadge')) document.body.prepend(badge);
    });
    window.addEventListener('online', () => {
        showToast('✅ Back online', 'success');
        document.getElementById('_offlineBadge')?.remove();
    });
    
    // Set initial branch selector visibility based on current page
    _updateBranchSelectorVisibility(AppState.currentPage || 'dashboard');
    
    console.log('Hulu Stock initialized successfully');
});

// Apply role-based access control to navigation
function applyRBAC() {
    const role = AppState.currentUser?.role || 'cashier';
    const permissions = Permissions[role] || Permissions.cashier;
    
    // Hide admin-only elements based on role
    document.querySelectorAll('.admin-only').forEach(el => {
        el.classList.remove('hidden');
    });
    
    // If not admin/manager, hide certain menu items
    if (!permissions.canManageUsers) {
        document.querySelectorAll('[data-page="users"]').forEach(el => el.classList.add('hidden'));
    }
    if (!permissions.canViewReports) {
        document.querySelectorAll('[data-page="reports"]').forEach(el => el.classList.add('hidden'));
    }
    if (!permissions.canManageExpenses) {
        document.querySelectorAll('[data-page="expenses"]').forEach(el => el.classList.add('hidden'));
    }
    if (!permissions.canManageBank) {
        document.querySelectorAll('[data-page="bank"]').forEach(el => el.classList.add('hidden'));
    }
    if (!permissions.canManageSettings) {
        // Keep settings but hide organization part
    }
    
    // Hide branches for non-admin users
    if (role !== 'admin') {
        document.querySelectorAll('[data-page="branches"]').forEach(el => el.classList.add('hidden'));
    }

    // Cashiers are locked to their assigned branch — hide the branch selector entirely
    if (role === 'cashier') {
        const bsSel = document.getElementById('branchSelector');
        const bsWrap = bsSel?.closest('.branch-selector-wrap') || bsSel?.parentElement;
        if (bsWrap) bsWrap.style.display = 'none';
        else if (bsSel) bsSel.style.display = 'none';
        // Force AppState.branch to their JWT branch so all queries are scoped
        if (AppState.currentUser?.branch_id && !AppState.branch) {
            AppState.branch = { id: AppState.currentUser.branch_id };
        }
        // Hide item management buttons — cashier is read-only on items
        const addItemBtn = document.getElementById('addItemBtn');
        if (addItemBtn) addItemBtn.style.display = 'none';
        // Hide Fast Scan and bulk adjust buttons (manager+ only)
        document.querySelectorAll('[onclick*="FastScan"], [onclick*="openBulkStock"]')
            .forEach(el => el.style.display = 'none');
    }
    
    // If not admin, hide organization settings
    if (role !== 'admin') {
        const settingsCards = document.querySelectorAll('#settingsPage .grid > .card');
        if (settingsCards.length > 1) {
            settingsCards[1].classList.add('hidden');
        }
    }
}

// Load user data
async function loadUserData() {
    const userData = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.USER_DATA || 'rf_user_data');
    const orgData = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.ORGANIZATION || 'rf_organization');
    const branchData = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.BRANCH || 'rf_branch');
    
    if (userData) {
        AppState.currentUser = JSON.parse(userData);
    }
    
    if (orgData) {
        AppState.organization = JSON.parse(orgData);
        applyOrganizationSettings();
        updateItemPagePharmacyModeControl();
    }
    
    if (branchData) {
        AppState.branch = JSON.parse(branchData);
    }
    
    // Always refresh the session from the API when a token is available.
    // Cached organization data can be stale after a super admin changes tenant mode,
    // so relying only on localStorage can hide pharmacy/supermarket/retail UI changes.
    const token = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
    if (token) {
        try {
            const response = await window.AuthAPI.me();
            AppState.currentUser = response.user;
            AppState.organization = response.organization;
            AppState.branch = response.branch;

            localStorage.setItem(window.AppConfig?.STORAGE_KEYS?.USER_DATA || 'rf_user_data', JSON.stringify(response.user));
            localStorage.setItem(window.AppConfig?.STORAGE_KEYS?.ORGANIZATION || 'rf_organization', JSON.stringify(response.organization));

            const branchKey = window.AppConfig?.STORAGE_KEYS?.BRANCH || 'rf_branch';
            if (response.branch) {
                localStorage.setItem(branchKey, JSON.stringify(response.branch));
            } else {
                localStorage.removeItem(branchKey);
            }

            applyOrganizationSettings();
            updateItemPagePharmacyModeControl();
        } catch (error) {
            console.error('Failed to fetch user data:', error);

            // No cached data available - redirect to login
            if (!AppState.currentUser) {
                localStorage.removeItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
                localStorage.removeItem(window.AppConfig?.STORAGE_KEYS?.USER_DATA || 'rf_user_data');
                window.location.href = 'login.html';
                return;
            }
        }
    }
}

// Apply organization branding
// ─── Color Palette Engine ────────────────────────────────────────────────────
// Converts a hex brand color into a full HSL-based palette:
//   primary     = the exact color saved by the user
//   primary-dark = primary darkened 12% (hover states, active nav)
//   primary-light= primary lightened 45% (tinted backgrounds, badges)
//   primary-ultra= primary at 8% opacity (subtle row highlights, inputs)
//   secondary   = hue shifted +150° (complementary accent, success badges)
//   tertiary    = hue shifted +210° (info chips, secondary CTAs)
//   sidebar     = very dark version of primary hue (sidebar gradient)
//   on-primary  = white or black depending on primary luminance (button text)

function hexToHSL(hex) {
    let r = parseInt(hex.slice(1, 3), 16) / 255;
    let g = parseInt(hex.slice(3, 5), 16) / 255;
    let b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

function luminance(hex) {
    const r = parseInt(hex.slice(1,3),16)/255;
    const g = parseInt(hex.slice(3,5),16)/255;
    const b = parseInt(hex.slice(5,7),16)/255;
    const toLinear = c => c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
    return 0.2126*toLinear(r) + 0.7152*toLinear(g) + 0.0722*toLinear(b);
}

function generatePalette(hex) {
    if (!hex || hex.length < 7) hex = '#2563EB';
    const { h, s, l } = hexToHSL(hex);

    // Clamp saturation so very grey colors still produce visible variants
    const vs = Math.max(s, 40);

    const primary       = hex;
    const primaryDark   = hslToHex(h, Math.min(vs + 10, 100), Math.max(l - 12, 10));
    const primaryDarker = hslToHex(h, Math.min(vs + 15, 100), Math.max(l - 22, 8));
    const primaryLight  = hslToHex(h, Math.min(vs, 80),       Math.min(l + 38, 90));
    const primaryUltra  = hslToHex(h, Math.min(vs, 60),       Math.min(l + 50, 96));

    // Complementary (+150°) → secondary (teal/green family for most blues)
    const secH          = (h + 150) % 360;
    const secondary     = hslToHex(secH, Math.min(vs, 80), Math.min(l + 5, 55));
    const secondaryLight= hslToHex(secH, Math.min(vs, 60), Math.min(l + 45, 92));

    // Analogous (+210°) → tertiary (purple/indigo family for most blues)
    const terH          = (h + 210) % 360;
    const tertiary      = hslToHex(terH, Math.min(vs, 80), Math.min(l + 5, 60));
    const tertiaryLight = hslToHex(terH, Math.min(vs, 60), Math.min(l + 45, 92));

    // Sidebar: very dark, slightly desaturated version of primary hue
    const sidebarTop    = hslToHex(h, Math.min(vs - 10, 60), Math.max(l - 42, 10));
    const sidebarBot    = hslToHex(h, Math.min(vs - 15, 50), Math.max(l - 50, 6));

    // Text on primary: pick white or near-black based on contrast
    const onPrimary     = luminance(primary) > 0.35 ? '#1a1a2e' : '#ffffff';
    const onPrimaryDark = luminance(primaryDark) > 0.35 ? '#1a1a2e' : '#ffffff';

    // Active nav shadow color at 40% opacity
    const shadowRgb = [
        parseInt(hex.slice(1,3),16),
        parseInt(hex.slice(3,5),16),
        parseInt(hex.slice(5,7),16)
    ].join(',');

    return {
        primary, primaryDark, primaryDarker, primaryLight, primaryUltra,
        secondary, secondaryLight,
        tertiary, tertiaryLight,
        sidebarTop, sidebarBot,
        onPrimary, onPrimaryDark, shadowRgb,
        raw: { h, s, l }
    };
}

function applyPalette(palette) {
    const r = document.documentElement;
    r.style.setProperty('--primary',          palette.primary);
    r.style.setProperty('--primary-dark',     palette.primaryDark);
    r.style.setProperty('--primary-darker',   palette.primaryDarker);
    r.style.setProperty('--primary-light',    palette.primaryLight);
    r.style.setProperty('--primary-ultra',    palette.primaryUltra);
    r.style.setProperty('--secondary',        palette.secondary);
    r.style.setProperty('--secondary-light',  palette.secondaryLight);
    r.style.setProperty('--tertiary',         palette.tertiary);
    r.style.setProperty('--tertiary-light',   palette.tertiaryLight);
    r.style.setProperty('--sidebar-top',      palette.sidebarTop);
    r.style.setProperty('--sidebar-bot',      palette.sidebarBot);
    r.style.setProperty('--on-primary',       palette.onPrimary);
    r.style.setProperty('--on-primary-dark',  palette.onPrimaryDark);
    r.style.setProperty('--primary-shadow',   palette.shadowRgb);
    // Keep legacy alias working
    r.style.setProperty('--primary-color',    palette.primary);

    // Inject dynamic rules that can't be set via CSS variables alone
    _injectDynamicCSS(palette);
}

function _injectDynamicCSS(p) {
    const id = 'xpos-dynamic-theme';
    let el = document.getElementById(id);
    if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }

    el.textContent = `
        /* ── Sidebar ──────────────────────────────────── */
        .sidebar {
            background: linear-gradient(180deg, ${p.sidebarTop} 0%, ${p.sidebarBot} 100%) !important;
        }
        .sidebar-brand-icon {
            background: ${p.primary} !important;
            color: ${p.onPrimary} !important;
        }
        .nav-item.active {
            background: linear-gradient(135deg, ${p.primary} 0%, ${p.primaryDark} 100%) !important;
            color: ${p.onPrimary} !important;
            box-shadow: 0 4px 14px rgba(${p.shadowRgb}, 0.45) !important;
        }
        .nav-item:hover:not(.active) {
            background: rgba(255,255,255,0.1) !important;
            color: white !important;
        }

        /* ── Buttons ──────────────────────────────────── */
        .btn-primary {
            background: linear-gradient(135deg, ${p.primary}, ${p.primaryDark}) !important;
            color: ${p.onPrimary} !important;
            border: none !important;
            box-shadow: 0 2px 8px rgba(${p.shadowRgb}, 0.3);
        }
        .btn-primary:hover {
            background: linear-gradient(135deg, ${p.primaryDark}, ${p.primaryDarker}) !important;
            box-shadow: 0 4px 16px rgba(${p.shadowRgb}, 0.45) !important;
            transform: translateY(-1px);
        }
        .btn-secondary-accent {
            background: ${p.secondary} !important;
            color: #fff !important;
        }
        .btn-tertiary {
            background: ${p.tertiary} !important;
            color: #fff !important;
        }

        /* ── Inputs & Focus ───────────────────────────── */
        input:focus, select:focus, textarea:focus {
            border-color: ${p.primary} !important;
            box-shadow: 0 0 0 3px rgba(${p.shadowRgb}, 0.15) !important;
            outline: none !important;
        }

        /* ── Badges / Chips ───────────────────────────── */
        .badge-primary {
            background: ${p.primaryUltra} !important;
            color: ${p.primaryDark} !important;
            border: 1px solid ${p.primaryLight} !important;
        }
        .badge-secondary {
            background: ${p.secondaryLight} !important;
            color: ${p.secondary} !important;
        }
        .badge-tertiary {
            background: ${p.tertiaryLight} !important;
            color: ${p.tertiary} !important;
        }

        /* ── Tables: hover row ────────────────────────── */
        tbody tr:hover {
            background: ${p.primaryUltra} !important;
        }

        /* ── Active tab / underline ───────────────────── */
        .tab-active, .tab.active {
            color: ${p.primary} !important;
            border-bottom-color: ${p.primary} !important;
        }

        /* ── Stat icon backgrounds ────────────────────── */
        .stat-icon.blue, .stat-icon.primary {
            background: rgba(${p.shadowRgb}, 0.12) !important;
            color: ${p.primary} !important;
        }
        .stat-icon.secondary {
            background: ${p.secondaryLight} !important;
            color: ${p.secondary} !important;
        }
        .stat-icon.tertiary {
            background: ${p.tertiaryLight} !important;
            color: ${p.tertiary} !important;
        }

        /* ── Checkboxes & radio ───────────────────────── */
        input[type=checkbox]:checked, input[type=radio]:checked {
            accent-color: ${p.primary};
        }

        /* ── Scrollbar accent ─────────────────────────── */
        ::-webkit-scrollbar-thumb {
            background: ${p.primaryLight};
        }
        ::-webkit-scrollbar-thumb:hover {
            background: ${p.primary};
        }

        /* ── Report/card selected border ─────────────── */
        .report-card-selected, .card-selected {
            border-color: ${p.primary} !important;
            box-shadow: 0 0 0 3px rgba(${p.shadowRgb}, 0.2) !important;
        }

        /* ── POS item selected ────────────────────────── */
        .pos-item-selected, .item-card.selected {
            border-color: ${p.primary} !important;
            background: ${p.primaryUltra} !important;
        }

        /* ── Progress bars ────────────────────────────── */
        .progress-bar, [role=progressbar] > div {
            background: linear-gradient(90deg, ${p.primary}, ${p.secondary}) !important;
        }

        /* ── Links ────────────────────────────────────── */
        a.primary-link, .text-primary-brand {
            color: ${p.primary} !important;
        }
        a.primary-link:hover {
            color: ${p.primaryDark} !important;
        }

        /* ── Notification bell badge ──────────────────── */
        #notificationBadge {
            background: ${p.primary} !important;
        }

        /* ── Settings color preview swatches ─────────── */
        .color-swatch-primary   { background: ${p.primary} !important; }
        .color-swatch-secondary { background: ${p.secondary} !important; }
        .color-swatch-tertiary  { background: ${p.tertiary} !important; }
        .color-swatch-light     { background: ${p.primaryLight} !important; }
        .color-swatch-sidebar   { background: ${p.sidebarTop} !important; }
    `;
}

// ─── Main org settings application (replaces old version) ─────────────────
function applyOrganizationSettings() {
    if (!AppState.organization) return;

    const brandColor = AppState.organization.brand_color || '#2563EB';
    const orgName    = AppState.organization.name || 'Hulu Stock';

    // Generate & apply full palette
    const palette = generatePalette(brandColor);
    applyPalette(palette);

    // Store palette on AppState so other code can read derived colors
    AppState.palette = palette;

    // Update page title
    document.title = `${orgName} - POS`;

    // Update sidebar brand name
    document.querySelectorAll('.sidebar-brand-text').forEach(el => {
        el.textContent = orgName;
    });

    // Persist to localStorage
    localStorage.setItem(
        window.AppConfig?.STORAGE_KEYS?.ORGANIZATION || 'rf_organization',
        JSON.stringify(AppState.organization)
    );

    // Update settings page swatches if visible
    _updateSettingsSwatches(palette);
}

// Update live preview swatches on the settings page
function _updateSettingsSwatches(palette) {
    const wrap = document.getElementById('colorPalettePreview');
    if (!wrap) return;

    const swatches = [
        { label: 'Primary',   color: palette.primary,      cls: 'color-swatch-primary' },
        { label: 'Dark',      color: palette.primaryDark,  cls: '' },
        { label: 'Secondary', color: palette.secondary,    cls: 'color-swatch-secondary' },
        { label: 'Tertiary',  color: palette.tertiary,     cls: 'color-swatch-tertiary' },
        { label: 'Light',     color: palette.primaryLight, cls: 'color-swatch-light' },
        { label: 'Sidebar',   color: palette.sidebarTop,   cls: 'color-swatch-sidebar' },
    ];

    wrap.innerHTML = swatches.map(s => `
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
            <div style="width:44px;height:44px;border-radius:10px;background:${s.color};
                        box-shadow:0 2px 8px rgba(0,0,0,.2);border:1px solid rgba(0,0,0,.08);"
                 title="${s.color}"></div>
            <span style="font-size:10px;color:var(--text-secondary);font-weight:500;">${s.label}</span>
            <span style="font-size:9px;color:var(--text-secondary);font-family:monospace;">${s.color}</span>
        </div>
    `).join('');
}

// Handle organization settings form submit
// Live preview when user moves color picker
function onBrandColorInput(hex) {
    const palette = generatePalette(hex);
    applyPalette(palette);
    _updateSettingsSwatches(palette);
}

async function handleChangePassword(e) {
    e.preventDefault();
    const cur  = document.getElementById('currentPassword')?.value?.trim() || '';
    const nw   = document.getElementById('newPassword')?.value?.trim() || '';
    const conf = document.getElementById('confirmPassword')?.value?.trim() || '';
    if (!cur || !nw || !conf) { showToast('Please fill in all password fields', 'error'); return; }
    if (nw.length < 8) { showToast('New password must be at least 8 characters', 'error'); return; }
    if (nw !== conf) { showToast('New passwords do not match', 'error'); return; }
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating…'; }
    try {
        await window.API.post('/auth/change-password', { old_password: cur, new_password: nw });
        showToast('✅ Password changed successfully', 'success');
        document.getElementById('changePasswordForm')?.reset();
    } catch (err) {
        showToast(err.message || 'Failed to change password', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Update Password'; }
    }
}

async function handleSettingsSubmit(e) {
    e.preventDefault();
    
    const name          = document.getElementById('orgName').value;
    const brand_color   = document.getElementById('orgColor').value;
    const currency      = document.getElementById('orgCurrency').value;
    const tax_percentage= parseFloat(document.getElementById('orgTax').value) || 0;
    const timezone      = document.getElementById('orgTimezone')?.value || 'Africa/Addis_Ababa';
    
    try {
        const logo_url = document.getElementById('orgLogoUrl')?.value || undefined;
        const updated = await window.OrganizationsAPI.update({
            name, brand_color, currency, tax_percentage, timezone,
            ...(logo_url !== undefined ? { logo_url } : {})
        });
        
        AppState.organization = updated;
        applyOrganizationSettings();
        showToast('Settings saved successfully', 'success');
    } catch (error) {
        console.error('Failed to save settings:', error);
        showToast('Failed to save settings', 'error');
    }
}

// Initialize UI
function initializeUI() {
    // Initialize dark mode
    initializeDarkMode();
    
    if (AppState.currentUser) {
        document.getElementById('userName').textContent = AppState.currentUser.full_name;
        const sidebarRoleEl = document.getElementById('sidebarUserRole'); if (sidebarRoleEl) sidebarRoleEl.textContent = AppState.currentUser.role.charAt(0).toUpperCase() + AppState.currentUser.role.slice(1);
        
        // Set profile form
        document.getElementById('profileName').value = AppState.currentUser.full_name || '';
        document.getElementById('profileEmail').value = AppState.currentUser.email || '';
        document.getElementById('profilePhone').value = AppState.currentUser.phone || '';
    }
    
    if (AppState.organization) {
        document.getElementById('orgName').value = AppState.organization.name || '';
        document.getElementById('orgColor').value = AppState.organization.brand_color || '#2563EB';
        document.getElementById('orgCurrency').value = AppState.organization.currency || 'USD';
        document.getElementById('orgTax').value = AppState.organization.tax_percentage || 0;
        if (document.getElementById('orgTimezone')) {
            document.getElementById('orgTimezone').value = AppState.organization.timezone || 'Africa/Addis_Ababa';
        }
        if (document.getElementById('orgLogoUrl')) {
            document.getElementById('orgLogoUrl').value = AppState.organization.logo_url || '';
        }

        // Populate palette preview
        const palette = generatePalette(AppState.organization.brand_color || '#2563EB');
        _updateSettingsSwatches(palette);
    }
    
    // Setup navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const page = item.dataset.page;
            if (page) navigateTo(page);
        });
    });
}

// Toggle sidebar
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('mobileOverlay');
    const isOpen  = sidebar.classList.toggle('active');
    // Only show overlay and lock scroll on mobile/tablet
    if (window.innerWidth <= 1024) {
        overlay.classList.toggle('visible', isOpen);
        document.body.style.overflow = isOpen ? 'hidden' : '';
    }
    _saveSidebarState(isOpen);
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar?.classList.remove('active');
    const overlay = document.getElementById('mobileOverlay');
    overlay?.classList.remove('visible');
    document.body.style.overflow = '';
    _saveSidebarState(false);
}

function _saveSidebarState(open) {
    try { localStorage.setItem('sidebar_open', open ? '1' : '0'); } catch (_) {}
}
function _loadSidebarState() {
    try { return localStorage.getItem('sidebar_open'); } catch (_) { return null; }
}
function initSidebar() {
    const isDesktop = window.innerWidth > 1024;
    if (isDesktop) {
        // Desktop: default open, restore saved state
        const saved = _loadSidebarState();
        const open = saved !== null ? saved === '1' : true;
        document.getElementById('sidebar')?.classList.toggle('active', open);
    } else {
        // Mobile: default closed, close on resize from desktop
        document.getElementById('sidebar')?.classList.remove('active');
        document.getElementById('mobileOverlay')?.classList.remove('visible');
        document.body.style.overflow = '';
    }
}

// Setup event listeners
function setupEventListeners() {
    // Theme toggle (dark mode)
    // Theme toggle moved to Settings → Appearance (setTheme / initializeDarkMode)
    
    // POS search
    document.getElementById('posSearch')?.addEventListener('input', debounce(handlePOSSearch, 300));
    document.getElementById('posSearch')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleBarcodeSearch(e.target.value);
    });
    
    document.getElementById('posCategoryFilter')?.addEventListener('change', loadPOSItems);
    document.getElementById('clearCart')?.addEventListener('click', clearCart);
    document.getElementById('checkoutBtn')?.addEventListener('click', openPaymentModal);
    
    // Split payment inputs
    document.getElementById('cashAmount')?.addEventListener('input', updatePaymentSummary);
    document.getElementById('bankAmount')?.addEventListener('input', updatePaymentSummary);
    document.getElementById('mobileMoneyAmount')?.addEventListener('input', updatePaymentSummary);
    
    document.getElementById('addItemBtn')?.addEventListener('click', () => openItemModal());
    document.getElementById('itemForm')?.addEventListener('submit', handleItemSubmit);
    document.getElementById('itemImage')?.addEventListener('change', handleImageUpload);
    document.getElementById('cameraBtn')?.addEventListener('click', openCamera);
    
    // Category and Supplier management
    document.getElementById('addCategoryBtn')?.addEventListener('click', () => openCategoryModal());
    document.getElementById('categoryForm')?.addEventListener('submit', handleCategorySubmit);
    document.getElementById('addSupplierBtn')?.addEventListener('click', () => openSupplierModal());
    document.getElementById('supplierForm')?.addEventListener('submit', handleSupplierSubmit);
    
    // Branch management
    document.getElementById('addBranchBtn')?.addEventListener('click', () => openBranchModal());
    document.getElementById('branchForm')?.addEventListener('submit', handleBranchSubmit);
    document.getElementById('branchSelector')?.addEventListener('change', handleBranchChange);
    
    // User management
    document.getElementById('addUserBtn')?.addEventListener('click', () => openUserModal());
    document.getElementById('userForm')?.addEventListener('submit', handleUserSubmit);
    
    // Expense management
    document.getElementById('addExpenseBtn')?.addEventListener('click', () => openExpenseModal());
    document.getElementById('expenseForm')?.addEventListener('submit', handleExpenseSubmit);
    
    // Bank account management
    document.getElementById('addBankBtn')?.addEventListener('click', () => openBankModal());
    document.getElementById('bankForm')?.addEventListener('submit', handleBankSubmit);
    
    // Notification button
    document.querySelectorAll('.fa-bell').forEach(btn => {
        btn.closest('button')?.addEventListener('click', toggleNotifications);
    });
    
    // Items search and category filter
    document.getElementById('itemsSearch')?.addEventListener('input', debounce(loadItems, 300));
    document.getElementById('itemsCategoryFilter')?.addEventListener('change', loadItems);
    
    // Close modal on outside click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });
    });
    
    // Organization settings form
    document.getElementById('orgForm')?.addEventListener('submit', handleSettingsSubmit);

    // Change password form
    document.getElementById('changePasswordForm')?.addEventListener('submit', handleChangePassword);
}

// Navigation
function navigateTo(page) {
    // Check permission
    const role = AppState.currentUser?.role || 'cashier';
    const permissions = Permissions[role] || Permissions.cashier;
    
    if (!permissions.pages.includes(page)) {
        showToast('You do not have permission to access this page', 'error');
        return;
    }
    
    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === page) item.classList.add('active');
    });
    
    // Hide all pages
    document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
    
    // Show selected page
    const pageElement = document.getElementById(`${page}Page`);
    if (pageElement) pageElement.classList.add('active');
    
    // Update title
    const titles = {
        dashboard: 'Dashboard',
        pos: 'Point of Sale',
        items: 'Items',
        categories: 'Categories',
        branches: 'Branches',
        suppliers: 'Suppliers',
        sales: 'Sales',
        expenses: 'Expenses',
        bank: 'Bank Accounts',
        reports: 'Reports',
        users: 'Users',
        settings: 'Settings'
    };
    document.getElementById('pageTitle').textContent = titles[page] || page;
    
    // Update branch selector visibility based on page
    _updateBranchSelectorVisibility(page);
    
    // Close mobile sidebar (only on small screens — desktop stays open)
    if (window.innerWidth <= 1024) closeSidebar();
    
    // Load page data
    loadPageData(page);
    AppState.currentPage = page;
    // Persist last page so refresh restores it
    try { localStorage.setItem('rf_last_page', page); } catch(_) {}
}

// Pages where the branch selector should be visible for admins
// Pages where branch selector is HIDDEN (selector not relevant or confusing there)
const _BRANCH_SELECTOR_HIDDEN_PAGES = ['settings', 'notifications'];

// Replaced _BRANCH_SELECTOR_PAGES — now we show selector on ALL pages except the hidden list
// This dummy const exists so old references don't break (unused now)
const _BRANCH_SELECTOR_PAGES = null;

function _updateBranchSelectorVisibility(page) {
    const branchSelector = document.getElementById('branchSelector');
    if (!branchSelector) return;

    const role = AppState.currentUser?.role || 'cashier';

    // Cashiers are locked to their branch — hide selector entirely
    if (role === 'cashier') {
        branchSelector.closest('.branch-selector-wrap')?.classList.add('hidden');
        return;
    }

    // For admins/managers: hide only on settings and notifications pages
    // Show on ALL other pages so they can always switch branch context
    if (_BRANCH_SELECTOR_HIDDEN_PAGES.includes(page)) {
        branchSelector.closest('.branch-selector-wrap')?.classList.add('hidden');
    } else {
        branchSelector.closest('.branch-selector-wrap')?.classList.remove('hidden');
    }
}

// Load page-specific data
async function loadPageData(page) {
    // Apply branch guards BEFORE loading — blocks POS overlay, disables add buttons
    _applyBranchGuards(page);
    switch (page) {
        case 'dashboard': await loadDashboardData(); break;
        case 'pos':
            await loadPOSData();
            HIDScanner.setActive(true);
            break;
        case 'items': await loadItems(); break;
        case 'categories': await loadCategories(); break;
        case 'branches': await loadBranches(); break;
        case 'suppliers': await loadSuppliers(); break;
        case 'sales': await loadSales(); await populateSalesPaymentFilterOptions(); break;
        case 'expenses': await loadExpenses(); break;
        case 'bank': await loadBankAccounts(); break;
        case 'reports': await loadReports(); break;
        case 'users': if (Permissions[AppState.currentUser?.role]?.canManageUsers) await loadUsers(); break;
        case 'notifications': await loadNotifications(); break;
        case 'settings':
            HIDScanner.setActive(false);
            HardwareSettings.initSettingsPage();
            HardwareSettings.autoDetectHardware(); // auto-detect and configure
            PhoneCamera.init();   // generate QR code + subscribe to phone channel
            // Refresh theme button highlights and push status
            setTimeout(() => {
                _updateThemeButtons(localStorage.getItem('rf_theme') || 'light');
                _checkPushStatus();
            }, 200);
            break;
    }
}

// Dashboard
async function loadDashboardData() {
    // Show skeleton placeholders while loading
    ['todaySales','todayTransactions','lowStockCount','expiringCount'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = '<span class="skeleton skeleton-cell" style="width:60px;height:20px;display:inline-block;"></span>'; }
    });
    try {
        // Use AppState.branch (persisted across reloads) — NOT branchSelector.value
        // which may not be populated yet on initial load
        const branchId = AppState.branch?.id || undefined;

        // Fire all 5 dashboard calls simultaneously — ~3x faster than serial
        const [stats, recentSales, lowStockItems, expiringItems] = await Promise.all([
            window.DashboardAPI.stats(branchId).catch(() => ({})),
            window.DashboardAPI.recentSales(5, branchId).catch(() => []),
            window.DashboardAPI.lowStockItems(5, branchId).catch(() => []),
            window.DashboardAPI.expiringItems(7, 5, branchId).catch(() => []),
        ]);

        document.getElementById('todaySales').textContent        = formatCurrency(stats.today_sales || 0);
        document.getElementById('todayTransactions').textContent = stats.today_transactions || 0;
        document.getElementById('lowStockCount').textContent     = stats.low_stock_count || 0;
        document.getElementById('expiringCount').textContent     = stats.expiring_soon_count || 0;

        renderRecentSales(recentSales);
        renderLowStockList(lowStockItems);
        renderExpiringList(expiringItems);
        loadSalesChart(branchId).catch(() => {}); // non-blocking
    } catch (error) {
        console.error('Failed to load dashboard:', error);
        showToast('Failed to load dashboard', 'error');
    }
}

function renderRecentSales(sales) {
    const tbody = document.getElementById('recentSalesTable');
    if (!sales?.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center text-gray-500">No recent sales</td></tr>';
        return;
    }
    tbody.innerHTML = sales.map(s => `
        <tr>
            <td class="font-medium">${esc(s.invoice_number)}</td>
            <td>${formatCurrency(s.net_amount)}</td>
            <td class="text-gray-500">${formatTime(s.created_at)}</td>
        </tr>
    `).join('');
}

function renderLowStockList(items) {
    const container = document.getElementById('lowStockList');
    if (!items?.length) {
        container.innerHTML = '<p class="text-gray-500">No low stock items</p>';
        return;
    }
    container.innerHTML = items.map(item => `
        <div class="flex items-center justify-between py-2 border-b">
            <div>
                <p class="font-medium">${esc(item.name)}</p>
                <p class="text-sm text-gray-500">${esc(item.category_name) || 'Uncategorized'}</p>
            </div>
            <span class="badge badge-danger">${item.stock_quantity} left</span>
        </div>
    `).join('');
}

function renderExpiringList(items) {
    const container = document.getElementById('expiringList');
    if (!items?.length) {
        container.innerHTML = '<p class="text-gray-500">No items expiring soon</p>';
        return;
    }
    container.innerHTML = items.map(item => {
        const daysLeft = Math.ceil((new Date(item.expiry_date) - new Date()) / (1000 * 60 * 60 * 24));
        return `
            <div class="flex items-center justify-between py-2 border-b">
                <div>
                    <p class="font-medium">${esc(item.name)}</p>
                    <p class="text-sm text-gray-500">${item.category_name || ''}</p>
                </div>
                <span class="badge ${daysLeft <= 3 ? 'badge-danger' : 'badge-warning'}">${daysLeft} days</span>
            </div>
        `;
    }).join('');
}

async function loadSalesChart() {
    const branchId = AppState.branch?.id || undefined;

    const ctx = document.getElementById('salesChart');
    if (!ctx) return;

    // Show skeleton while loading
    ctx.style.opacity = '0.4';

    let chartData = [];
    try {
        chartData = await window.DashboardAPI.salesChart(30, branchId);
    } catch (e) {
        ctx.style.opacity = '1';
        return;
    }

    ctx.style.opacity = '1';
    if (AppState.salesChart) AppState.salesChart.destroy();

    // ── Detect mobile ─────────────────────────────────────────────────────────
    const isMobile = window.innerWidth <= 768;

    // ── Thin out labels on mobile (show every 5th date, show day only) ────────
    const labels = chartData.map((d, i) => {
        const date = new Date(d.date);
        if (isMobile) {
            // Show only day number, and only every 5th label
            return i % 5 === 0 ? date.getDate().toString() : '';
        }
        // Desktop: short date like "Mar 5"
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    });

    const values = chartData.map(d => d.total || 0);
    const maxVal = Math.max(...values, 0);

    // ── Get computed CSS vars for theme-aware colours ─────────────────────────
    const style   = getComputedStyle(document.documentElement);
    const primary = style.getPropertyValue('--primary').trim() || '#2563eb';
    const isDark  = document.documentElement.classList.contains('dark');
    const gridCol = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const textCol = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)';

    // Gradient fill
    const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, ctx.offsetHeight || 200);
    gradient.addColorStop(0, isDark ? 'rgba(99,102,241,0.35)' : 'rgba(37,99,235,0.18)');
    gradient.addColorStop(1, 'rgba(37,99,235,0)');

    AppState.salesChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Sales',
                data: values,
                borderColor: primary,
                backgroundColor: gradient,
                borderWidth: isMobile ? 2 : 2.5,
                fill: true,
                tension: 0.42,
                pointRadius: isMobile ? 0 : 3,           // hide dots on mobile — too crowded
                pointHoverRadius: isMobile ? 5 : 5,
                pointBackgroundColor: primary,
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: {
                mode: 'index',
                intersect: false,                         // tooltip on hover anywhere on vertical
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    backgroundColor: isDark ? '#1e293b' : '#fff',
                    titleColor:      isDark ? '#e2e8f0' : '#1e293b',
                    bodyColor:       isDark ? '#94a3b8' : '#475569',
                    borderColor:     isDark ? '#334155' : '#e2e8f0',
                    borderWidth: 1,
                    padding: isMobile ? 10 : 12,
                    cornerRadius: 10,
                    titleFont: { size: isMobile ? 11 : 12, weight: '600' },
                    bodyFont:  { size: isMobile ? 12 : 13, weight: '700' },
                    callbacks: {
                        title: (items) => {
                            // Show full date in tooltip even on mobile
                            const idx = items[0]?.dataIndex;
                            if (idx === undefined) return '';
                            return new Date(chartData[idx]?.date).toLocaleDateString(
                                undefined, { weekday:'short', month:'short', day:'numeric' }
                            );
                        },
                        label: (item) => ' ' + formatCurrency(item.raw),
                    }
                },
            },
            scales: {
                x: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: {
                        color: textCol,
                        font: { size: isMobile ? 9 : 11 },
                        maxRotation: 0,                   // never rotate labels
                        autoSkip: false,                  // we handle skipping ourselves
                        padding: isMobile ? 4 : 6,
                    },
                },
                y: {
                    beginAtZero: true,
                    grid: { color: gridCol, drawBorder: false },
                    border: { display: false, dash: [4, 4] },
                    ticks: {
                        color: textCol,
                        font: { size: isMobile ? 9 : 11 },
                        maxTicksLimit: isMobile ? 4 : 6,
                        padding: isMobile ? 4 : 8,
                        callback: (val) => {
                            // Compact currency: 1500 → 1.5k
                            if (val === 0) return '0';
                            if (val >= 1000000) return (val/1000000).toFixed(1).replace(/\.0$/,'') + 'M';
                            if (val >= 1000)    return (val/1000).toFixed(1).replace(/\.0$/,'') + 'k';
                            return val;
                        }
                    },
                }
            },
            // Smooth resize on orientation change
            onResize: (chart) => {
                const mob = window.innerWidth <= 768;
                chart.data.datasets[0].pointRadius = mob ? 0 : 3;
                chart.options.scales.x.ticks.font.size = mob ? 9 : 11;
                chart.options.scales.y.ticks.font.size = mob ? 9 : 11;
                chart.options.scales.y.ticks.maxTicksLimit = mob ? 4 : 6;
            }
        }
    });
}

// POS Functions
// ── Chart period selector ─────────────────────────────────────────────────────
let _chartPeriodDays = 30;  // default

async function changeSalesChartPeriod(days, btn) {
    _chartPeriodDays = days;

    // Update button styles
    document.querySelectorAll('.chart-period-btn').forEach(b => {
        b.style.background   = 'var(--bg)';
        b.style.color        = 'var(--text-2)';
        b.style.borderColor  = 'var(--border)';
    });
    if (btn) {
        btn.style.background  = 'var(--primary)';
        btn.style.color       = '#fff';
        btn.style.borderColor = 'var(--primary)';
    }

    // Swap the DashboardAPI call period then reload
    const origFn = window.DashboardAPI.salesChart;
    const tmpFn  = (_, branchId) => origFn(days, branchId);
    window.DashboardAPI.salesChart = tmpFn;
    await loadSalesChart();
    window.DashboardAPI.salesChart = origFn;
}

async function loadPOSData() {
    // Block POS if the selected branch is inactive
    if (AppState.branch?.id && AppState.branch?.is_active === false) {
        const grid = document.getElementById('productsGrid');
        if (grid) {
            grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 16px;color:var(--text-2);">
                <div style="font-size:2.5rem;margin-bottom:12px;">🚫</div>
                <div style="font-size:1rem;font-weight:700;color:#ef4444;margin-bottom:8px;">Branch Deactivated</div>
                <div style="font-size:.875rem;">This branch has been deactivated. Sales are not allowed.</div>
            </div>`;
        }
        const checkoutBtn = document.getElementById('checkoutBtn');
        if (checkoutBtn) checkoutBtn.disabled = true;
        return;
    }
    await loadCategoriesForSelect();
    await loadPOSItems();
    await loadBankAccountsForPayment();
    // Adjust scan button visibility based on camera availability
    _updatePOSScanButtons();
}

async function _updatePOSScanButtons() {
    const hasCamera = await checkCameraAvailable();
    const scanBtn  = document.getElementById('posScanBtn');    // camera scan button
    const hidBar   = document.getElementById('hidStatusBar');  // HID scanner status bar
    const hidHint  = document.getElementById('posHidHint');    // hint we'll inject

    if (scanBtn) {
        if (!hasCamera) {
            // Dim the camera scan button and add a tooltip
            scanBtn.style.opacity = '0.4';
            scanBtn.style.cursor  = 'not-allowed';
            scanBtn.title = 'No camera detected — use a USB/Bluetooth barcode scanner';
            scanBtn.onclick = (e) => {
                e.preventDefault();
                showToast('No camera detected. Use a USB or Bluetooth barcode scanner.', 'warning');
            };
        } else {
            scanBtn.style.opacity = '';
            scanBtn.style.cursor  = '';
        }
    }

    // Show HID scanner hint if no camera
    if (!hasCamera && hidBar && !hidHint) {
        const hint = document.createElement('div');
        hint.id = 'posHidHint';
        hint.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:4px;text-align:center;';
        hint.innerHTML = '<i class="fas fa-barcode" style="margin-right:4px;"></i>No camera — scan with USB/Bluetooth scanner or type barcode manually';
        hidBar.parentNode.insertBefore(hint, hidBar.nextSibling);
    }

    // Auto-switch scanner mode to HID if no camera and camera mode is selected
    if (!hasCamera) {
        const cfg = HardwareSettings.getScannerConfig();
        if (!cfg || cfg.type === 'camera') {
            HardwareSettings.selectScannerType('hid');
            if (!cfg) {
                showToast('No camera detected — scanner set to USB/Bluetooth mode', 'info');
            }
        }
    }
}

async function loadPOSItems() {
    try {
        const categoryId = document.getElementById('posCategoryFilter')?.value;
        await ensurePharmacyUnits();
        const items = await window.ItemsAPI.list({ page_size: 100, category_id: categoryId || undefined, ..._branchParam() });
        AppState.items = items;
        renderProductsGrid(items);
    } catch (error) {
        console.error('Failed to load items:', error);
    }
}

function renderProductsGrid(items) {
    const grid = document.getElementById('productsGrid');
    if (!items?.length) {
        grid.innerHTML = '<p class="col-span-full text-center text-gray-500 py-8">No items found</p>';
        return;
    }
    grid.innerHTML = items.map(item => {
        const outOfStock = item.stock_quantity <= 0;
        const lowStock   = item.stock_quantity <= item.min_stock_level && item.stock_quantity > 0;
        return `
        <div class="product-card${outOfStock ? ' out-of-stock' : ''}"
             onclick="${outOfStock ? '' : `addToCart('${item.id}')`}"
             title="${esc(item.name)}">
            <!-- Product image / icon -->
            <div style="aspect-ratio:1;background:var(--bg);border-radius:var(--radius);
                        overflow:hidden;display:flex;align-items:center;justify-content:center;
                        margin-bottom:.25rem;flex-shrink:0;">
                ${item.image_url
                    ? `<img src="${esc(item.image_url)}" alt="${esc(item.name)}"
                           style="width:100%;height:100%;object-fit:cover"
                           onerror="this.parentElement.innerHTML='<i class=\\'fas fa-box\\' style=\\'color:var(--text-3);font-size:1.25rem\\'></i>'">`
                    : `<i class="fas fa-box" style="color:var(--text-3);font-size:1.25rem"></i>`
                }
            </div>
            <!-- Name -->
            <p style="font-size:.6875rem;font-weight:600;color:var(--text-1);
                       line-height:1.3;overflow:hidden;display:-webkit-box;
                       -webkit-line-clamp:2;-webkit-box-orient:vertical;
                       margin:0 0 .125rem;word-break:break-word;">${esc(item.name)}</p>
            <!-- Price -->
            <p style="font-size:.8125rem;font-weight:700;color:var(--primary);margin:0 0 .125rem">
                ${formatCurrency(item.sell_price)}
            </p>
            <!-- Stock badge -->
            <p style="font-size:.5625rem;font-weight:600;margin:0;
                       color:${outOfStock ? 'var(--danger)' : lowStock ? '#f59e0b' : 'var(--text-3)'}">
                ${outOfStock ? 'Out of stock' : `Stock: ${item.stock_quantity}`}
            </p>
        </div>`;
    }).join('');
}

function handlePOSSearch(e) {
    const search = e.target.value.toLowerCase();
    const filtered = AppState.items.filter(i => i.name.toLowerCase().includes(search) || (i.barcode && i.barcode.toLowerCase().includes(search)));
    renderProductsGrid(filtered);
}

async function handleBarcodeSearch(barcode) {
    if (!barcode) return;
    try {
        const item = await window.ItemsAPI.getByBarcode(barcode);
        await addToCart(item.id, resolveTierUnitId(item, item.matched_tier));
        document.getElementById('posSearch').value = '';
    } catch (error) {
        showToast(error.message || 'Item not found', 'error');
    }
}

// ── Dosage-form → default unit/packaging map ───────────────────────────────
// Each form defines: baseUnit (abbreviation), baseUnitName, and an array of
// tiers. A tier with multiplier=0 means it's hidden (not shown by default).
// When multiplier is given, it's treated as "units per that tier" for the
// nearest lower tier (e.g. {level:'strip', per:10} = 10 base units per strip).
const _DOSAGE_FORM_CONFIG = {
    tablet: {
        baseUnit: 'tab', baseUnitName: 'Tablet',
        tiers: [
            { level: 'strip', label: 'Strip',  per: 10 },
            { level: 'box',   label: 'Box',    per: 10 },
            { level: 'carton',label: 'Carton', per: 20 },
        ],
    },
    capsule: {
        baseUnit: 'cap', baseUnitName: 'Capsule',
        tiers: [
            { level: 'strip', label: 'Strip',  per: 10 },
            { level: 'box',   label: 'Box',    per: 10 },
            { level: 'carton',label: 'Carton', per: 20 },
        ],
    },
    syrup: {
        baseUnit: 'bottle', baseUnitName: 'Bottle',
        tiers: [
            { level: 'box', label: 'Box', per: 12 },
        ],
    },
    injection: {
        baseUnit: 'vial', baseUnitName: 'Vial',
        tiers: [
            { level: 'box', label: 'Box', per: 10 },
        ],
    },
    cream: {
        baseUnit: 'tube', baseUnitName: 'Tube',
        tiers: [
            { level: 'box', label: 'Box', per: 12 },
        ],
    },
    ointment: {
        baseUnit: 'tube', baseUnitName: 'Tube',
        tiers: [
            { level: 'box', label: 'Box', per: 12 },
        ],
    },
    sachet: {
        baseUnit: 'sachet', baseUnitName: 'Sachet',
        tiers: [
            { level: 'box', label: 'Box', per: 50 },
        ],
    },
    drops: {
        baseUnit: 'bottle', baseUnitName: 'Bottle',
        tiers: [
            { level: 'box', label: 'Box', per: 12 },
        ],
    },
    inhaler: {
        baseUnit: 'inhaler', baseUnitName: 'Inhaler',
        tiers: [],
    },
    suspension: {
        baseUnit: 'bottle', baseUnitName: 'Bottle',
        tiers: [
            { level: 'box', label: 'Box', per: 12 },
        ],
    },
    solution: {
        baseUnit: 'bottle', baseUnitName: 'Bottle',
        tiers: [
            { level: 'box', label: 'Box', per: 12 },
        ],
    },
    powder: {
        baseUnit: 'sachet', baseUnitName: 'Sachet',
        tiers: [
            { level: 'box', label: 'Box', per: 50 },
        ],
    },
    suppository: {
        baseUnit: 'supp', baseUnitName: 'Suppository',
        tiers: [
            { level: 'strip', label: 'Strip', per: 5 },
            { level: 'box', label: 'Box', per: 2 },
        ],
    },
    ampoule: {
        baseUnit: 'amp', baseUnitName: 'Ampoule',
        tiers: [
            { level: 'box', label: 'Box', per: 10 },
        ],
    },
};
const _DEFAULT_DOSAGE_FORM = 'tablet';

function _getDosageFormConfig(dosageForm) {
    const key = String(dosageForm || '').toLowerCase().trim();
    return _DOSAGE_FORM_CONFIG[key] || null;
}


function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function _setGroupVisible(id, visible) {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
}

function _updatePackagingConversionControls(config) {
    const baseLabel = unitLabel(document.getElementById('itemBaseUnit')?.value) || config?.baseUnitName || 'Base unit';
    const tiers = Array.isArray(config?.tiers) ? config.tiers : [];
    const byLevel = new Map(tiers.map(t => [String(t.level || '').toLowerCase(), t]));
    const hasStrip = byLevel.has('strip');
    const hasBox = byLevel.has('box');
    const hasCarton = byLevel.has('carton');
    const stripLabel = byLevel.get('strip')?.label || 'Strip';
    const boxLabel = byLevel.get('box')?.label || 'Box';
    const cartonLabel = byLevel.get('carton')?.label || 'Carton';

    _setText('pharmaUnitsTitleHelp', tiers.length
        ? `Build units for this medicine type: ${[baseLabel, ...tiers.map(t => t.label)].join(' → ')}.`
        : `This medicine is sold as single ${baseLabel} units.`);
    _setText('itemBaseUnitHelp', `Smallest stock unit, e.g. ${baseLabel}.`);

    _setGroupVisible('packUnitsPerStripGroup', hasStrip);
    _setText('packUnitsPerStripLabel', `+ ${stripLabel} Conversion`);
    _setText('packUnitsPerStripHelp', `${baseLabel}s in 1 ${stripLabel.toLowerCase()}.`);

    _setGroupVisible('packStripsPerBoxGroup', hasBox);
    _setText('packStripsPerBoxLabel', `+ ${boxLabel} Conversion`);
    _setText('packStripsPerBoxHelp', `${hasStrip ? `${stripLabel}s` : `${baseLabel}s`} in 1 ${boxLabel.toLowerCase()}.`);

    _setGroupVisible('packBoxesPerCartonGroup', hasCarton);
    _setText('packBoxesPerCartonLabel', `+ ${cartonLabel} Conversion`);
    _setText('packBoxesPerCartonHelp', `${hasBox ? `${boxLabel}s` : (hasStrip ? `${stripLabel}s` : `${baseLabel}s`)} in 1 ${cartonLabel.toLowerCase()}.`);
}

function _applyDosageFormDefaults(form) {
    const config = _getDosageFormConfig(form);
    if (!config) return;

    // Ensure base unit exists
    const baseUnitAbbr = config.baseUnit;
    const existing = (AppState.units || []).find(u =>
        String(u.abbreviation || '').toLowerCase() === baseUnitAbbr.toLowerCase()
    );
    if (existing) {
        const baseSelect = document.getElementById('itemBaseUnit');
        if (baseSelect) baseSelect.value = String(existing.id);
    }
    _updatePackagingConversionControls(config);

    // Determine which tier group the form uses. Default to
    // "tablet-style" (strip/box/carton) unless the config has <2 tiers.
    const hasFullChain = config.tiers.length >= 2;
    const isTabletStyle = hasFullChain && config.tiers.some(t => t.level === 'strip');

    if (isTabletStyle) {
        // Tablet/Capsule: show all 3 tier inputs
        document.getElementById('packUnitsPerStrip').value = 1;
        document.getElementById('packStripsPerBox').value = 1;
        document.getElementById('packBoxesPerCarton').value = 1;
        for (const t of config.tiers) {
            if (t.level === 'strip') document.getElementById('packUnitsPerStrip').value = t.per || 10;
            if (t.level === 'box') document.getElementById('packStripsPerBox').value = t.per || 10;
            if (t.level === 'carton') document.getElementById('packBoxesPerCarton').value = t.per || 20;
        }
        // Show all three tier rows
        document.querySelectorAll('.selling-unit-row').forEach(r => r.classList.remove('is-hidden'));
    } else {
        // Simple packaging (bottle/box, tube/box, or single tier): hide
        // irrelevant inputs and set defaults from the config.
        const hasCarton = config.tiers.some(t => t.level === 'carton');
        const hasBox = config.tiers.some(t => t.level === 'box');
        const hasStrip = config.tiers.some(t => t.level === 'strip');
        const boxTier = config.tiers.find(t => t.level === 'box');
        const cartonTier = config.tiers.find(t => t.level === 'carton');

        if (hasStrip) {
            document.getElementById('packUnitsPerStrip').value = config.tiers.find(t => t.level === 'strip')?.per || 10;
        } else {
            document.getElementById('packUnitsPerStrip').value = 1;
        }
        if (hasBox) {
            document.getElementById('packStripsPerBox').value = boxTier.per || 12;
        } else {
            document.getElementById('packStripsPerBox').value = 1;
        }
        if (hasCarton) {
            document.getElementById('packBoxesPerCarton').value = cartonTier.per || 10;
        } else {
            document.getElementById('packBoxesPerCarton').value = 1;
        }

        // Show/hide tier rows
        document.querySelectorAll('.selling-unit-row').forEach(r => {
            const key = r.dataset.tierKey;
            const tierCfg = config.tiers.find(t => t.level === key);
            r.classList.toggle('is-hidden', !tierCfg);
        });
    }

    // Update purchase unit and min-stock unit selects to show only active tiers
    const activeLevels = config.tiers.map(t => t.level);
    ['pharmaStockInputUnit', 'pharmaMinStockUnit'].forEach(selectId => {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const currentVal = sel.value;
        // Build options: base unit always first, then tiers in order
        let opts = '<option value="base">Base Unit</option>';
        for (const t of config.tiers) {
            opts += `<option value="${t.level}">${t.label}</option>`;
        }
        sel.innerHTML = opts;
        // Restore previous selection if still valid, else pick sensible default
        if (activeLevels.includes(currentVal)) {
            sel.value = currentVal;
        } else if (selectId === 'pharmaStockInputUnit') {
            sel.value = isTabletStyle ? 'box' : (config.tiers.length > 0 ? config.tiers[config.tiers.length - 1].level : 'base');
        } else {
            sel.value = 'base';
        }
    });

    updatePackagingEngine();
}

function isPharmaTenant() {
    return (AppState.organization?.tenant_type || '').toLowerCase() === 'pharma';
}


function isItemPharmacyModeEnabled() {
    return isPharmaTenant() && !!document.getElementById('itemsPagePharmacyModeEnabled')?.checked;
}

function updateItemPagePharmacyModeControl() {
    const wrap = document.getElementById('itemsPagePharmacyModeWrap');
    const toggle = document.getElementById('itemsPagePharmacyModeEnabled');
    if (!wrap || !toggle) return;
    const show = isPharmaTenant();
    wrap.style.display = show ? 'flex' : 'none';
    if (show) {
        toggle.checked = localStorage.getItem('xpos_item_page_pharmacy_mode') === '1';
    } else {
        toggle.checked = false;
    }
}

function isCurrentItemFormPharmacyMode() {
    return isPharmaTenant() && (
        document.getElementById('pharmacyItemFields')?.classList.contains('is-open') ||
        document.getElementById('itemsPagePharmacyModeEnabled')?.checked
    );
}

function setItemPagePharmacyMode(enabled) {
    const toggle = document.getElementById('itemsPagePharmacyModeEnabled');
    if (toggle) toggle.checked = !!enabled;
    localStorage.setItem('xpos_item_page_pharmacy_mode', enabled ? '1' : '0');
}

function toggleItemPharmacyMode(enabled) {
    const panel = document.getElementById('pharmacyItemFields');
    if (!panel) return;
    panel.style.display = enabled ? 'block' : 'none';
    requestAnimationFrame(() => panel.classList.toggle('is-open', !!enabled));

    // The pharmacy toggle lives on the Items page, not inside this dialog.
    // In pharmacy mode, hide retail-only inputs and leave the purpose-built
    // pharmacy workspace. In retail mode, hide the pharmacy workspace.
    // Barcode/category/supplier/description stay available in pharmacy mode:
    // the item-level barcode is used for fast POS scanning and pharmacists need
    // to categorise and link a supplier (pricing/stock/expiry are owned by the
    // pharmacy workspace instead).
    const retailOnlyIds = [
        'itemBrand',
        'itemBuyPrice', 'itemSellPrice', 'itemStock', 'itemMinStock', 'itemExpiryDate',
        'itemBatchNumber'
    ];
    retailOnlyIds.forEach(id => {
        const field = document.getElementById(id);
        const group = field?.closest('.form-group');
        if (group) group.style.display = enabled ? 'none' : '';
        if (field) field.disabled = !!enabled;
    });

    if (enabled) {
        ensurePharmacyUnits().then(() => {
            populateUnitSelect('itemBaseUnit', document.getElementById('itemBaseUnit')?.value || '');
            syncPharmacyBatchFields();
            updatePackagingEngine();
        });
    }
}

function _num(id, fallback = 0) {
    const value = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(value) ? value : fallback;
}

function getPackagingMultipliers() {
    const boxes = Math.max(1, Math.round(_num('packBoxesPerCarton', 1)));
    const strips = Math.max(1, Math.round(_num('packStripsPerBox', 1)));
    const units = Math.max(1, Math.round(_num('packUnitsPerStrip', 1)));
    return { boxes, strips, units, cartonBaseUnits: boxes * strips * units, boxBaseUnits: strips * units, stripBaseUnits: units };
}

function syncPharmacyBatchFields() {
    const batch = document.getElementById('pharmaBatchNumber');
    const expiry = document.getElementById('pharmaExpiryDate');
    const min = document.getElementById('pharmaMinStockLevel');
    const standardBatch = document.getElementById('itemBatchNumber');
    const standardExpiry = document.getElementById('itemExpiryDate');
    const standardMin = document.getElementById('itemMinStock');
    if (document.getElementById('pharmaAutoBatch')?.checked) {
        if (batch) batch.value = generateAutoBatchNumber();
    }
    if (document.getElementById('itemAutoBatch')?.checked && standardBatch) {
        standardBatch.value = generateAutoBatchNumber();
    }
    if (batch && standardBatch) standardBatch.value = batch.value;
    if (expiry && standardExpiry) standardExpiry.value = expiry.value;
    if (min && standardMin) standardMin.value = min.value;
    const rxHidden = document.getElementById('itemControlledSubstance');
    const rxYes = document.getElementById('itemControlledSubstanceYes');
    if (rxHidden && rxYes) rxHidden.checked = !!rxYes.checked;
}

function packagingTierDefinitions() {
    const baseLabel = unitLabel(document.getElementById('itemBaseUnit')?.value) || 'Unit';
    const m = getPackagingMultipliers();
    const dosageForm = document.getElementById('itemDosageForm')?.value || '';
    const config = _getDosageFormConfig(dosageForm);
    const tiers = [
        { key: 'carton', label: 'Carton', multiplier: m.cartonBaseUnits },
        { key: 'box', label: 'Box', multiplier: m.boxBaseUnits },
        { key: 'strip', label: 'Strip', multiplier: m.stripBaseUnits },
        { key: 'base', label: baseLabel.charAt(0).toUpperCase() + baseLabel.slice(1), multiplier: 1 }
    ];
    if (config && config.tiers.length) {
        const activeLevels = new Set(config.tiers.map(t => t.level));
        return tiers.filter(t => t.key === 'base' || activeLevels.has(t.key));
    }
    return tiers;
}

function updatePackagingEngine() {
    if (!document.getElementById('pharmacyItemFields')) return;
    _updatePackagingConversionControls(_getDosageFormConfig(document.getElementById('itemDosageForm')?.value || ''));
    const m = getPackagingMultipliers();
    const baseLabel = unitLabel(document.getElementById('itemBaseUnit')?.value) || 'Capsules';
    const pharmaCostField = document.getElementById('pharmaPurchaseCost');
    if (pharmaCostField && document.getElementById('itemBuyPrice')) document.getElementById('itemBuyPrice').value = pharmaCostField.value || document.getElementById('itemBuyPrice').value || 0;
    const buyPrice = _num('itemBuyPrice', 0);
    const stockUnit = document.getElementById('pharmaStockInputUnit')?.value || 'carton';
    const baseCostFromStockUnit = buyPrice / Math.max(1, getUnitMultiplier(stockUnit));
    const chain = document.getElementById('packagingChain');
    if (chain) {
        const dosageForm = document.getElementById('itemDosageForm')?.value || '';
        const config = _getDosageFormConfig(dosageForm);
        const hasFullChain = config && config.tiers.length >= 2 && config.tiers.some(t => t.level === 'strip');
        if (hasFullChain) {
            chain.innerHTML = `<span class="pack-chip">${esc(baseLabel)}</span> <span class="pack-arrow">↑</span> <strong>${m.units}</strong> <span class="pack-chip">Strip</span> <span class="pack-arrow">↑</span> <strong>${m.strips}</strong> <span class="pack-chip">Box</span> <span class="pack-arrow">↑</span> <strong>${m.boxes}</strong> <span class="pack-chip">Carton</span>`;
        } else if (config && config.tiers.length) {
            // Simple chain: Base → highest tier (e.g. Bottle → Box)
            const parts = [`<span class="pack-chip">${esc(baseLabel)}</span>`];
            for (const t of config.tiers) {
                const mult = t.level === 'box' ? m.strips : (t.level === 'carton' ? (m.boxes * m.strips) : m.units);
                parts.push(`<span class="pack-arrow">↑</span> <strong>${mult}</strong> <span class="pack-chip">${esc(t.label)}</span>`);
            }
            chain.innerHTML = parts.join(' ');
        } else {
            chain.innerHTML = `<span class="pack-chip">${esc(baseLabel)}</span> <span class="pharma-help" style="margin-left:8px;">Single unit — no packaging tiers</span>`;
        }
    }
    const rows = document.getElementById('packagingTierRows');
    if (!rows) return;
    const visibleRows = new Set(Array.from(document.querySelectorAll('.selling-unit-row:not(.is-hidden)')).map(row => row.dataset.tierKey));
    rows.innerHTML = packagingTierDefinitions().map((tier, index) => {
        const cost = baseCostFromStockUnit * tier.multiplier;
        const priceId = `tierSellPrice_${tier.key}`;
        const barcodeId = `tierBarcode_${tier.key}`;
        const currentPrice = document.getElementById(priceId)?.value || '';
        const suggested = cost > 0 ? (cost * 1.25).toFixed(2) : '';
        const sell = parseFloat(currentPrice);
        const margin = Number.isFinite(sell) && sell > 0 ? (((sell - cost) / sell) * 100) : 0;
        const shouldShow = index < 3 || currentPrice || visibleRows.has(tier.key);
        return `<tr class="selling-unit-row ${shouldShow ? '' : 'is-hidden'}" data-tier-key="${esc(tier.key)}">
            <td><strong>${esc(tier.label)}</strong><small class="pharma-help">${tier.multiplier} base unit${tier.multiplier === 1 ? '' : 's'} · cost ${formatCurrency(cost || 0)}</small></td>
            <td><input type="number" id="${priceId}" class="form-input" inputmode="decimal" min="0" step="0.01" value="${esc(currentPrice)}" placeholder="${suggested}" oninput="updateTierMargin('${tier.key}')"></td>
            <td><span class="margin-badge" id="tierMargin_${tier.key}">${margin.toFixed(1)}%</span></td>
            <td style="display:flex;gap:8px;align-items:center;"><input type="text" id="${barcodeId}" class="form-input" placeholder="Optional barcode"><button type="button" class="scan-tier-btn" onclick="scanPackagingTierBarcode('${barcodeId}')" title="Scan ${esc(tier.label)} barcode"><i class="fas fa-barcode"></i></button></td>
        </tr>`;
    }).join('');
    const addButton = document.querySelector('.add-selling-unit');
    if (addButton) addButton.style.display = document.querySelector('.selling-unit-row.is-hidden') ? '' : 'none';
    const stockLabel = document.getElementById('pharmaStockInputUnit')?.selectedOptions?.[0]?.textContent || 'selected purchase unit';
    const buyingHelp = document.getElementById('buyingPriceHelp');
    if (buyingHelp) buyingHelp.textContent = `Buying price per ${stockLabel}.`;
    document.getElementById('itemPurchaseMultiplier').value = String(m.cartonBaseUnits);
    document.getElementById('itemSaleMultiplier').value = String(m.stripBaseUnits);
    const baseCost = baseCostFromStockUnit;
    const summaryBaseCost = document.getElementById('pharmaSummaryBaseCost');
    const summaryBaseStock = document.getElementById('pharmaSummaryBaseStock');
    const summaryThreshold = document.getElementById('pharmaSummaryThreshold');
    if (summaryBaseCost) summaryBaseCost.textContent = formatCurrency(baseCost || 0);
    if (summaryBaseStock) summaryBaseStock.textContent = String(getPharmacyStockQuantity());
    if (summaryThreshold) summaryThreshold.textContent = `${getPharmacyMinStockQuantity()} base units`;
}

async function scanPackagingTierBarcode(fieldId) {
    const field = document.getElementById(fieldId);
    if (!field) return;
    const hasCamera = await checkCameraAvailable();
    if (!hasCamera) {
        field.focus();
        showToast('No camera on this device. Type or scan this tier barcode manually.', 'warning');
        return;
    }
    window.XScanner?.open({
        onResult: (code) => { field.value = code; window.XScanner?.close(); },
        onError: (msg) => showToast(msg, 'error'),
        target: fieldId,
    });
}

function showNextSellingUnitRow() {
    const next = document.querySelector('.selling-unit-row.is-hidden');
    if (next) next.classList.remove('is-hidden');
    const addButton = document.querySelector('.add-selling-unit');
    if (addButton) addButton.style.display = document.querySelector('.selling-unit-row.is-hidden') ? '' : 'none';
}

function getPharmacyStockQuantity() {
    const qty = _num('itemReceivedQty', 0);
    const unit = document.getElementById('pharmaStockInputUnit')?.value || 'base';
    return Math.round(qty * Math.max(1, getUnitMultiplier(unit)));
}

function collectPackagingTiers() {
    if (!isCurrentItemFormPharmacyMode()) return [];
    // Pharmacy buy price is in pharmaPurchaseCost; itemBuyPrice is the generic
    // field that stays empty (0) for new pharmacy items.
    const buyPrice = _num('pharmaPurchaseCost', _num('itemBuyPrice', 0));
    const stockUnit = document.getElementById('pharmaStockInputUnit')?.value || 'carton';
    const baseCost = buyPrice / Math.max(1, getUnitMultiplier(stockUnit));
    return packagingTierDefinitions().map(tier => ({
        unit_level: tier.key,
        unit_label: tier.label,
        base_unit_multiplier: tier.multiplier,
        purchase_cost: baseCost * tier.multiplier,
        selling_price: _num(`tierSellPrice_${tier.key}`, 0),
        barcode: document.getElementById(`tierBarcode_${tier.key}`)?.value || null,
    }))
    // Only persist tiers the pharmacist actually configured. A blank sell price
    // would otherwise save as 0 and surface as a "free" (₀-price) unit option at
    // POS, risking accidental zero-price sales. Leaving a tier blank therefore
    // removes that packaging level instead of saving an unusable 0-price row.
    .filter(tier => tier.selling_price > 0 || tier.barcode);
}


async function hydratePackagingTiers(itemId) {
    if (!itemId || !window.ItemsAPI?.listPackagingTiers) return;
    try {
        // If tiers were already enriched by the backend, skip the extra API call
        const tiers = await window.ItemsAPI.listPackagingTiers(itemId);
        if (!Array.isArray(tiers) || !tiers.length) return;
        const byLevel = new Map(tiers.map(t => [String(t.unit_level || '').toLowerCase(), t]));
        const carton = parseFloat(byLevel.get('carton')?.base_unit_multiplier || 0);
        const box = parseFloat(byLevel.get('box')?.base_unit_multiplier || 0);
        const strip = parseFloat(byLevel.get('strip')?.base_unit_multiplier || 0);
        if (carton > 0 && box > 0) document.getElementById('packBoxesPerCarton').value = Math.max(1, Math.round(carton / box));
        if (box > 0) document.getElementById('packStripsPerBox').value = Math.max(1, Math.round(box / Math.max(1, strip || 1)));
        if (strip > 0) document.getElementById('packUnitsPerStrip').value = Math.max(1, Math.round(strip));
        for (const tier of tiers) {
            const level = String(tier.unit_level || '').toLowerCase();
            const price = document.getElementById(`tierSellPrice_${level}`);
            const barcode = document.getElementById(`tierBarcode_${level}`);
            if (price) price.value = tier.selling_price ?? '';
            if (barcode) barcode.value = tier.barcode || '';
        }
        updatePackagingEngine();
    } catch (error) {
        console.warn('Failed to load packaging tiers:', error);
    }
}

function unitLabel(unitId) {
    const unit = (AppState.units || []).find(u => String(u.id) === String(unitId));
    return unit ? (unit.abbreviation || unit.name) : '';
}

// Resolve a packaging level ('carton'/'box'/'strip'/'base') to a real units-table
// id by matching the level against a unit's abbreviation/name (same coupling as
// buildTierPriceMap). Returns fallbackId (the base unit) when the level is 'base'
// or no matching unit exists, so item-level purchase/sale units can differ from
// the base unit (e.g. purchase in cartons, dispense in strips) instead of all
// being forced equal to the base unit.
function resolvePackagingUnitId(level, fallbackId) {
    const lvl = String(level || '').toLowerCase();
    if (!lvl || lvl === 'base') return fallbackId;
    const unit = (AppState.units || []).find(u =>
        String(u.abbreviation || '').toLowerCase() === lvl ||
        String(u.name || '').toLowerCase() === lvl
    );
    return unit ? String(unit.id) : fallbackId;
}

function itemUnitChoices(item) {
    const itemId = item?.item_id || item?.id;
    const tierMap = AppState.tiersCache?.[itemId]?.priceByUnit || {};
    const ids = [item?.sale_unit_id, item?.base_unit_id, item?.purchase_unit_id]
        .filter(Boolean)
        .map(String);
    // Only expose units that are actually configured/priced for this item.
    // Showing every org unit made POS unit changes look selectable even when no
    // packaging tier/conversion existed, so price and stock math could not
    // reliably update for pharmacy items.
    for (const unitId of Object.keys(tierMap)) ids.push(String(unitId));
    return [...new Set(ids)].map(id => {
        const unit = (AppState.units || []).find(u => String(u.id) === id);
        return unit ? { id, label: unit.abbreviation || unit.name } : null;
    }).filter(Boolean);
}

// Build a unitId -> {price, multiplier, level} map from an item's packaging
// tiers, resolving each tier's abstract unit_level ("carton"/"box"/"strip")
// to the org's actual units table, and the "base" tier to the item's own
// base_unit_id (there is no separate "Base" unit row to look up).
function buildTierPriceMap(item, tiers) {
    const map = {};
    const baseUnitId = item?.base_unit_id ? String(item.base_unit_id) : '';
    const list = Array.isArray(tiers) ? tiers : [];
    for (const tier of list) {
        const level = String(tier.unit_level || '').toLowerCase();
        const multiplier = parseFloat(tier.base_unit_multiplier) || 1;
        const price = parseFloat(tier.selling_price) || 0;
        let unitId = '';
        if (level === 'base') {
            unitId = baseUnitId;
        } else {
            const unit = (AppState.units || []).find(u =>
                String(u.abbreviation || '').toLowerCase() === level ||
                String(u.name || '').toLowerCase() === level
            );
            unitId = unit ? String(unit.id) : '';
        }
        if (unitId) map[unitId] = { price, multiplier, level };
    }
    // Make sure the base unit always resolves to *some* sensible price, even
    // if the pharmacist only priced a higher tier (e.g. only set a carton
    // price) — derive it by dividing that tier's price by its multiplier,
    // rather than leaving it to default to the raw, unconverted tier price.
    if (baseUnitId && (!map[baseUnitId] || !map[baseUnitId].price)) {
        const priced = list.filter(t => parseFloat(t.selling_price) > 0);
        if (priced.length) {
            const t = priced.reduce((a, b) =>
                (parseFloat(a.base_unit_multiplier) || 1) <= (parseFloat(b.base_unit_multiplier) || 1) ? a : b
            );
            const mult = parseFloat(t.base_unit_multiplier) || 1;
            map[baseUnitId] = { price: (parseFloat(t.selling_price) || 0) / mult, multiplier: 1, level: 'base' };
        }
    }
    return map;
}

async function loadTierPriceMap(itemId, item) {
    try {
        // Use enriched tiers from backend response if available
        const tiers = item?.packaging_tiers || await window.ItemsAPI.listPackagingTiers(itemId);
        AppState.tiersCache[itemId] = { priceByUnit: buildTierPriceMap(item, tiers) };
    } catch (error) {
        AppState.tiersCache[itemId] = { priceByUnit: {} };
    }
    return AppState.tiersCache[itemId];
}

// Resolve the correct selling price for a given unit selection. Prefers an
// explicit per-tier price; falls back to the item's base-unit price scaled
// by that unit's multiplier when no tier price was set; falls back to the
// plain base price when nothing else is known.
function resolveUnitPrice(itemId, basePrice, baseUnitId, unitId) {
    const tierMap = AppState.tiersCache?.[itemId]?.priceByUnit || {};
    if (unitId && tierMap[unitId] && tierMap[unitId].price > 0) return tierMap[unitId].price;
    if (!unitId || String(unitId) === String(baseUnitId || '')) return basePrice;
    const meta = tierMap[unitId];
    if (meta && meta.multiplier) return basePrice * meta.multiplier;
    return basePrice;
}

function resolveUnitMultiplier(itemId, baseUnitId, unitId) {
    if (!unitId || String(unitId) === String(baseUnitId || '')) return 1;
    const meta = AppState.tiersCache?.[itemId]?.priceByUnit?.[unitId];
    return Math.max(1, parseFloat(meta?.multiplier) || 1);
}

async function ensureItemUnitPricingReady(itemId, item) {
    if (!item?.base_unit_id) return;
    await ensurePharmacyUnits();
    if (!AppState.tiersCache[itemId]) {
        await loadTierPriceMap(itemId, item);
    }
}

async function ensurePharmacyUnits() {
    try {
        let units = await window.ItemsAPI.listUnits();
        if (isPharmaTenant()) {
            const defaults = [
                { name: 'Box', abbreviation: 'box' },
                { name: 'Carton', abbreviation: 'carton' },
                { name: 'Strip', abbreviation: 'strip' },
                { name: 'Tablet', abbreviation: 'tab', is_base: true },
                { name: 'Capsule', abbreviation: 'cap', is_base: true },
                { name: 'Sachet', abbreviation: 'sachet', is_base: true },
                { name: 'Bottle', abbreviation: 'bottle' },
                { name: 'Vial', abbreviation: 'vial', is_base: true },
                { name: 'Tube', abbreviation: 'tube', is_base: true },
                { name: 'Inhaler', abbreviation: 'inhaler', is_base: true },
                { name: 'Suppository', abbreviation: 'supp', is_base: true },
                { name: 'Ampoule', abbreviation: 'amp', is_base: true },
            ];
            const byAbbr = new Map((units || []).map(u => [String(u.abbreviation || '').toLowerCase(), u]));
            for (const unit of defaults) {
                if (!byAbbr.has(unit.abbreviation.toLowerCase())) {
                    await window.ItemsAPI.createUnit(unit).catch(() => null);
                }
            }
            units = await window.ItemsAPI.listUnits();
        }
        AppState.units = units || [];
        return AppState.units;
    } catch (error) {
        console.warn('Failed to load pharmacy units:', error);
        AppState.units = AppState.units || [];
        return AppState.units;
    }
}

function populateUnitSelect(selectId, selectedId = '') {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.innerHTML = '<option value="">Select unit</option>' + (AppState.units || []).map(unit => (
        `<option value="${esc(unit.id)}">${esc(unit.name)} (${esc(unit.abbreviation)})</option>`
    )).join('');
    if (selectedId) select.value = String(selectedId);
}

// Resolve a packaging tier (as returned by the barcode lookup's
// matched_tier field) to an actual unit_id, so scanning e.g. a carton
// barcode can add the item to the cart already set to "Carton" with the
// correct carton price, instead of defaulting to the base unit.
function resolveTierUnitId(item, tier) {
    if (!tier) return '';
    const level = String(tier.unit_level || '').toLowerCase();
    if (level === 'base') return item?.base_unit_id ? String(item.base_unit_id) : '';
    const unit = (AppState.units || []).find(u =>
        String(u.abbreviation || '').toLowerCase() === level ||
        String(u.name || '').toLowerCase() === level
    );
    return unit ? String(unit.id) : '';
}

async function addToCart(itemId, unitHint) {
    const item = AppState.items.find(i => i.id === itemId);
    if (!item) return;
    if (item.stock_quantity <= 0) { showToast('Item out of stock', 'error'); return; }

    await ensureItemUnitPricingReady(itemId, item);

    const defaultUnitId = unitHint || item.sale_unit_id || item.base_unit_id || '';
    const unitMultiplier = resolveUnitMultiplier(itemId, item.base_unit_id, defaultUnitId);
    if (unitMultiplier > item.stock_quantity) {
        showToast(`Not enough stock for 1 ${unitLabel(defaultUnitId) || 'selected unit'}`, 'error');
        return;
    }
    const existing = AppState.cart.find(c => c.item_id === itemId && String(c.unit_id || '') === String(defaultUnitId || ''));
    if (existing) {
        if (((existing.quantity + 1) * (existing.unit_multiplier || 1)) > existing.stock_quantity) { showToast('Not enough stock', 'error'); return; }
        existing.quantity++;
    } else {
        AppState.cart.push({
            item_id: itemId,
            name: item.name,
            base_sell_price: item.sell_price,
            sell_price: resolveUnitPrice(itemId, item.sell_price, item.base_unit_id, defaultUnitId),
            unit_multiplier: unitMultiplier,
            quantity: 1,
            stock_quantity: item.stock_quantity,
            unit_id: defaultUnitId,
            base_unit_id: item.base_unit_id || '',
            sale_unit_id: item.sale_unit_id || '',
            purchase_unit_id: item.purchase_unit_id || ''
        });
    }
    renderCart();
    showToast(`${item.name} added to cart`, 'success');
}

function removeCartLine(index) {
    AppState.cart.splice(index, 1);
    renderCart();
}

function removeFromCart(itemId) {
    const index = AppState.cart.findIndex(c => c.item_id === itemId);
    if (index >= 0) removeCartLine(index);
}

function updateCartLineQuantity(index, quantity) {
    const item = AppState.cart[index];
    if (!item) return;
    if (quantity <= 0) { removeCartLine(index); return; }
    const multiplier = item.unit_multiplier || resolveUnitMultiplier(item.item_id, item.base_unit_id, item.unit_id);
    if ((quantity * multiplier) > item.stock_quantity) {
        showToast(`Not enough stock. Available: ${item.stock_quantity} base units`, 'error');
        return;
    }
    item.quantity = quantity;
    renderCart();
}

function updateCartQuantity(itemId, quantity) {
    const index = AppState.cart.findIndex(c => c.item_id === itemId);
    if (index >= 0) updateCartLineQuantity(index, quantity);
}

async function updateCartLineUnit(index, unitId) {
    const item = AppState.cart[index];
    if (!item) return;
    const source = (AppState.items || []).find(i => String(i.id) === String(item.item_id)) || item;
    await ensureItemUnitPricingReady(item.item_id, source);
    const multiplier = resolveUnitMultiplier(item.item_id, item.base_unit_id, unitId);
    if ((item.quantity * multiplier) > item.stock_quantity) {
        showToast(`Not enough stock for ${unitLabel(unitId) || 'selected unit'}`, 'error');
        renderCart();
        return;
    }
    item.unit_id = unitId || '';
    item.unit_multiplier = multiplier;
    item.sell_price = resolveUnitPrice(item.item_id, item.base_sell_price ?? item.sell_price, item.base_unit_id, item.unit_id);
    renderCart();
}

async function updateCartUnit(itemId, unitId) {
    const index = AppState.cart.findIndex(c => c.item_id === itemId);
    if (index >= 0) await updateCartLineUnit(index, unitId);
}

function clearCart() { AppState.cart = []; renderCart(); }

function renderCart() {
    const container = document.getElementById('cartItems');
    const checkoutBtn = document.getElementById('checkoutBtn');
    
    if (AppState.cart.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-center py-8">Cart is empty</p>';
        document.getElementById('cartSubtotal').textContent = formatCurrency(0);
        document.getElementById('cartTax').textContent = formatCurrency(0);
        document.getElementById('cartTotal').textContent = formatCurrency(0);
        checkoutBtn.disabled = true;
        return;
    }
    
    container.innerHTML = AppState.cart.map((item, index) => {
        const choices = itemUnitChoices(item);
        const unitSelect = choices.length ? `
            <select onchange="updateCartLineUnit(${index}, this.value)"
                    style="margin-top:4px;width:100%;font-size:11px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);padding:3px 5px;">
                ${choices.map(u => `<option value="${esc(u.id)}" ${String(item.unit_id || '') === String(u.id) ? 'selected' : ''}>${esc(u.label)}</option>`).join('')}
            </select>` : '';
        const baseQty = item.quantity * (item.unit_multiplier || resolveUnitMultiplier(item.item_id, item.base_unit_id, item.unit_id));
        return `
        <div class="cart-item" style="display:flex;align-items:center;gap:8px;
             padding:8px 4px;border-bottom:1px solid var(--border);">
            <!-- Name + price -->
            <div style="flex:1;min-width:0;">
                <p style="font-size:12px;font-weight:600;color:var(--text-1);
                           white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                           margin:0 0 1px">${esc(item.name)}</p>
                <p style="font-size:11px;color:var(--text-3);margin:0">${formatCurrency(item.sell_price)}</p>
                ${item.base_unit_id ? `<p style="font-size:10px;color:var(--text-3);margin:1px 0 0">Stock use: ${baseQty} base unit${baseQty === 1 ? '' : 's'}</p>` : ''}
                ${unitSelect}
            </div>
            <!-- Qty controls -->
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
                <button onclick="updateCartLineQuantity(${index}, ${item.quantity - 1})"
                        style="width:26px;height:26px;border-radius:6px;border:1px solid var(--border);
                               background:var(--bg);color:var(--text-2);cursor:pointer;
                               display:flex;align-items:center;justify-content:center;
                               font-size:12px;transition:var(--transition);"
                        onmouseover="this.style.background='var(--primary)';this.style.color='#fff';this.style.borderColor='var(--primary)'"
                        onmouseout="this.style.background='var(--bg)';this.style.color='var(--text-2)';this.style.borderColor='var(--border)'">
                    <i class="fas fa-minus" style="font-size:10px"></i>
                </button>
                <input
                    type="number"
                    inputmode="numeric"
                    pattern="[0-9]*"
                    min="1"
                    max="${Math.max(1, Math.floor(item.stock_quantity / (item.unit_multiplier || 1)))}"
                    value="${item.quantity}"
                    onchange="updateCartLineQuantity(${index}, parseInt(this.value)||1)"
                    onkeydown="if(event.key==='Enter')this.blur();if(['-','.','+','e','E'].includes(event.key))event.preventDefault();"
                    onfocus="this.select()"
                    style="width:38px;height:26px;border-radius:6px;
                           border:1.5px solid var(--primary);
                           background:var(--surface);color:var(--text-1);
                           font-size:13px;font-weight:700;text-align:center;
                           outline:none;padding:0;
                           -moz-appearance:textfield;appearance:textfield;"
                >
                <button onclick="updateCartLineQuantity(${index}, ${item.quantity + 1})"
                        style="width:26px;height:26px;border-radius:6px;border:1px solid var(--border);
                               background:var(--bg);color:var(--text-2);cursor:pointer;
                               display:flex;align-items:center;justify-content:center;
                               font-size:12px;transition:var(--transition);"
                        onmouseover="this.style.background='var(--primary)';this.style.color='#fff';this.style.borderColor='var(--primary)'"
                        onmouseout="this.style.background='var(--bg)';this.style.color='var(--text-2)';this.style.borderColor='var(--border)'">
                    <i class="fas fa-plus" style="font-size:10px"></i>
                </button>
            </div>
            <!-- Line total + remove -->
            <div style="text-align:right;flex-shrink:0;min-width:52px;">
                <p style="font-size:12px;font-weight:700;color:var(--text-1);margin:0 0 2px">${formatCurrency(item.sell_price * item.quantity)}</p>
                <button onclick="removeCartLine(${index})"
                        style="background:none;border:none;cursor:pointer;
                               color:var(--danger);font-size:11px;padding:0;
                               transition:opacity .15s;"
                        onmouseover="this.style.opacity='.7'"
                        onmouseout="this.style.opacity='1'">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </div>
        </div>
    `;}).join('');
    
    const subtotal = AppState.cart.reduce((sum, i) => sum + (i.sell_price * i.quantity), 0);
    const taxRate = AppState.organization?.tax_percentage || 10;
    const tax = subtotal * (taxRate / 100);
    const total = subtotal + tax;
    
    document.getElementById('cartSubtotal').textContent = formatCurrency(subtotal);
    document.getElementById('cartTax').textContent = formatCurrency(tax);
    document.getElementById('cartTaxRate').textContent = taxRate;
    document.getElementById('cartTotal').textContent = formatCurrency(total);
    checkoutBtn.disabled = false;
}

function openPaymentModal() {
    if (AppState.cart.length === 0) return;
    
    const subtotalRaw = AppState.cart.reduce((s, i) => s + (i.sell_price * i.quantity), 0);
    const tax = subtotalRaw * ((AppState.organization?.tax_percentage || 0) / 100);
    const grandTotal = subtotalRaw + tax;
    
    document.getElementById('paymentTotal').textContent = formatCurrency(grandTotal);
    document.getElementById('totalDue').textContent = formatCurrency(grandTotal);
    AppState.grandTotal = grandTotal;
    AppState.subtotalBeforeDiscount = grandTotal;
    
    // Reset payment fields
    document.getElementById('cashAmount').value = '0';
    document.getElementById('bankAmount').value = '0';
    document.getElementById('mobileMoneyAmount').value = '0';
    document.getElementById('posDiscountAmount').value = '0';
    document.getElementById('posDiscountType').value = 'amount';
    document.getElementById('paymentBank').value = '';
    document.getElementById('bankSelectDiv').classList.add('hidden');
    document.getElementById('paymentValidation').classList.add('hidden');
    
    // Update payment summary
    updatePaymentSummary();
    
    // Load bank accounts
    loadBankAccountsForPayment();
    
    document.getElementById('paymentModal').classList.add('active');
}

// Discount can be entered as a flat amount or a percentage of the
// pre-discount total (subtotal + tax). Returns the money value, clamped
// to [0, baseTotal]; the backend applies the same clamp again.
function _posDiscountValue(baseTotal) {
    const raw = parseFloat(document.getElementById('posDiscountAmount')?.value) || 0;
    const type = document.getElementById('posDiscountType')?.value || 'amount';
    const d = type === 'percent' ? baseTotal * Math.min(raw, 100) / 100 : raw;
    return Math.min(Math.max(0, d), baseTotal);
}

function updatePaymentSummary() {
    const cashAmount = parseFloat(document.getElementById('cashAmount').value) || 0;
    const bankAmount = parseFloat(document.getElementById('bankAmount').value) || 0;
    const mobileMoneyAmount = parseFloat(document.getElementById('mobileMoneyAmount').value) || 0;
    const baseTotal = AppState.subtotalBeforeDiscount || AppState.grandTotal || 0;
    const discountAmount = _posDiscountValue(baseTotal);
    const grandTotal = Math.max(0, baseTotal - discountAmount);
    AppState.grandTotal = grandTotal;
    // Update displayed total
    const totalEl = document.getElementById('totalDue');
    if (totalEl) totalEl.textContent = formatCurrency(grandTotal);
    
    const totalPaid = cashAmount + bankAmount + mobileMoneyAmount;
    const changeDue = totalPaid - grandTotal;
    
    document.getElementById('totalPaid').textContent = formatCurrency(totalPaid);
    document.getElementById('changeDue').textContent = formatCurrency(Math.abs(changeDue));
    
    const changeLabel = document.getElementById('changeLabel');
    const changeDueEl = document.getElementById('changeDue');
    
    if (changeDue >= 0) {
        changeLabel.textContent = 'Change Due:';
        changeDueEl.className = 'font-bold text-2xl text-green-600';
    } else {
        changeLabel.textContent = 'Remaining Due:';
        changeDueEl.className = 'font-bold text-2xl text-red-600';
    }
    
    // Show/hide bank selection based on bank amount
    const bankSelectDiv = document.getElementById('bankSelectDiv');
    if (bankAmount > 0) {
        bankSelectDiv.classList.remove('hidden');
    } else {
        bankSelectDiv.classList.add('hidden');
        document.getElementById('paymentBank').value = '';
    }

    // Show/hide mobile money provider selection
    const mobileSelectDiv = document.getElementById('mobileSelectDiv');
    if (mobileSelectDiv) {
        if (mobileMoneyAmount > 0) {
            mobileSelectDiv.classList.remove('hidden');
        } else {
            mobileSelectDiv.classList.add('hidden');
            const mobileSel = document.getElementById('paymentMobile');
            if (mobileSel) mobileSel.value = '';
        }
    }
    
    // Update complete sale button state
    const completeBtn = document.getElementById('completeSaleBtn');
    completeBtn.disabled = totalPaid < grandTotal;
}

async function completeSale() {
    if (AppState.cart.length === 0) return;
    if (window._saleInFlight) return; // double-click / double-tap guard
    
    const branchId = AppState.branch?.id;
    if (!branchId) { showToast('Please select a branch', 'error'); return; }
    
    const cashAmount = parseFloat(document.getElementById('cashAmount').value) || 0;
    const bankAmount = parseFloat(document.getElementById('bankAmount').value) || 0;
    const mobileMoneyAmount = parseFloat(document.getElementById('mobileMoneyAmount').value) || 0;
    const bankAccountId       = document.getElementById('paymentBank').value;
    const mobileMoneyAccountId = document.getElementById('paymentMobile')?.value || null;
    const grandTotal = AppState.grandTotal || 0;
    
    const totalPaid = cashAmount + bankAmount + mobileMoneyAmount;
    
    // Validation
    const validationDiv = document.getElementById('paymentValidation');
    const validationMsg = document.getElementById('paymentValidationMsg');
    
    if (totalPaid < grandTotal) {
        validationDiv.classList.remove('hidden');
        validationMsg.textContent = 'Total payment is less than the total amount due.';
        return;
    }
    
    if (bankAmount > 0 && !bankAccountId) {
        validationDiv.classList.remove('hidden');
        validationMsg.textContent = 'Please select a bank account for bank transfer.';
        return;
    }

    if (mobileMoneyAmount > 0 && !mobileMoneyAccountId) {
        // Soft warning only if there ARE mobile money providers configured
        const mobileSel = document.getElementById('paymentMobile');
        if (mobileSel && mobileSel.options.length > 1) {
            validationDiv.classList.remove('hidden');
            validationMsg.textContent = 'Please select a mobile money provider.';
            return;
        }
    }
    
    validationDiv.classList.add('hidden');

    // In-flight guard engages only once validation passes, so failed
    // validation never leaves the button stuck disabled.
    window._saleInFlight = true;
    const completeBtn = document.getElementById('completeSaleBtn');
    if (completeBtn) completeBtn.disabled = true;

    const items = AppState.cart.map(i => ({
        item_id: i.item_id,
        quantity: i.quantity,
        unit_id: i.unit_id || null,
        unit_price: i.sell_price
    }));
    const subtotal = AppState.cart.reduce((s, i) => s + (i.sell_price * i.quantity), 0);
    const tax = subtotal * ((AppState.organization?.tax_percentage || 10) / 100);
    
    try {
        const discountAmount = _posDiscountValue(AppState.subtotalBeforeDiscount || (subtotal + tax));
        // Idempotency key: stable for this exact cart so a retry after a
        // timeout does not create a duplicate sale; rotates when the cart,
        // branch, or discount changes, and after each completed sale.
        const _keySrc = JSON.stringify({ b: branchId, d: discountAmount, i: items });
        let _h = 0;
        for (let _i = 0; _i < _keySrc.length; _i++) _h = ((_h << 5) - _h + _keySrc.charCodeAt(_i)) | 0;
        if (!window._saleKeyCounter) window._saleKeyCounter = 0;
        const _idemKey = `pos-${branchId}-${(_h >>> 0).toString(36)}-${window._saleKeyCounter}`;
        const sale = await window.SalesAPI.create({
            branch_id: branchId,
            items,
            discount_amount: discountAmount,
            subtotal,
            tax_amount: tax,
            total_amount: grandTotal,
            cash_paid: cashAmount,
            bank_paid: bankAmount,
            mobile_money_paid: mobileMoneyAmount,
            bank_account_id: bankAccountId || null,
            mobile_money_account_id: mobileMoneyAccountId || null,
            idempotency_key: _idemKey
        });
        window._saleKeyCounter++;

        // Build sale object for receipt
        const saleData = {
            ...(sale || {}),
            items: AppState.cart.map(i => ({
                item_name: i.name,
                quantity:  i.quantity,
                unit_name: unitLabel(i.unit_id),
                unit_price: i.sell_price,
            })),
            subtotal, tax_amount: tax, discount_amount: discountAmount,
            total_amount: grandTotal,
            cash_paid: cashAmount, bank_paid: bankAmount, mobile_paid: mobileMoneyAmount,
        };

        // Store for receipt system
        ReceiptSystem.setSale(saleData);

        // Close payment modal, clear cart
        clearCart();
        closeModal('paymentModal');
        loadDashboardData();

        // Auto-print if enabled
        if (HardwareSettings.isAutoPrint()) {
            ReceiptSystem.print('auto');
            showToast('Sale complete — printing receipt…', 'success');
        } else {
            // Show success modal with print option
            // Prefer the server-computed change (handles split tender correctly);
            // fall back to the client estimate for older backends.
            const change = (sale && Number.isFinite(Number(sale.change_amount)))
                ? Number(sale.change_amount)
                : Math.max(0, cashAmount - grandTotal);
            document.getElementById('ssInvoiceNum').textContent  = saleData.invoice_number || '';
            document.getElementById('ssTotalAmt').textContent    = formatCurrency(grandTotal);
            const payParts = [];
            if (cashAmount   > 0) payParts.push('Cash');
            if (bankAmount   > 0) payParts.push('Bank');
            if (mobileMoneyAmount > 0) payParts.push('Mobile');
            document.getElementById('ssPayMethod').textContent   = payParts.join(' + ') || 'Cash';
            const changeRow = document.getElementById('ssChangeRow');
            if (change > 0) {
                document.getElementById('ssChange').textContent  = formatCurrency(change);
                changeRow.style.display = 'flex';
            } else {
                changeRow.style.display = 'none';
            }
            document.getElementById('saleSuccessModal').style.display = 'flex';
        }
    } catch (error) {
        showToast(error.message || 'Payment failed', 'error');
    } finally {
        window._saleInFlight = false;
        if (completeBtn) completeBtn.disabled = false;
    }
}

async function loadBankAccountsForPayment() {
    try {
        const [bankAccts, mobileAccts] = await Promise.all([
            window.BankAPI.list({ ..._branchParam(), account_type: 'bank' }),
            window.BankAPI.list({ ..._branchParam(), account_type: 'mobile_money' }),
        ]);
        // Bank select
        const bankSel = document.getElementById('paymentBank');
        if (bankSel) {
            bankSel.innerHTML = '<option value="">Select Bank Account</option>' +
                bankAccts.map(a => `<option value="${esc(a.id)}">${esc(a.account_name)}${a.bank_name ? ' — ' + esc(a.bank_name) : ''}</option>`).join('');
        }
        // Mobile money select
        const mobileSel = document.getElementById('paymentMobile');
        if (mobileSel) {
            mobileSel.innerHTML = '<option value="">Select Provider</option>' +
                mobileAccts.map(a => `<option value="${esc(a.id)}">${esc(a.account_name)}${a.bank_name ? ' — ' + esc(a.bank_name) : ''}</option>`).join('');
        }
    } catch (error) { console.error('Failed to load payment accounts:', error); }
}

async function loadCategoriesForSelect() {
    try {
        const categories = await window.CategoriesAPI.list(_branchParam());
        const options = '<option value="">Select Category</option>' + categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        ['itemCategory', 'posCategoryFilter', 'itemsCategoryFilter'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = id.includes('Filter') ? '<option value="">All Categories</option>' + options : options;
        });
        AppState.categories = categories;
    } catch (error) { console.error('Failed to load categories:', error); }
    
    // Also load suppliers for item form
    try {
        const suppliers = await window.SuppliersAPI.list();
        const supplierOptions = '<option value="">Select Supplier</option>' + suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        const supplierEl = document.getElementById('itemSupplier');
        if (supplierEl) supplierEl.innerHTML = supplierOptions;
        AppState.suppliers = suppliers;
    } catch (error) { console.error('Failed to load suppliers:', error); }
}

// Items
function _showItemsSkeleton() {
    const tbody = document.getElementById('itemsTable');
    if (!tbody) return;
    tbody.innerHTML = Array(6).fill(0).map(() => `
        <tr class="skeleton-row">
            <td class="hide-mobile"><div class="skeleton skeleton-cell" style="width:36px;height:36px;border-radius:8px;"></div></td>
            <td><div class="skeleton skeleton-cell" style="width:${60+Math.random()*80|0}%;"></div></td>
            <td class="hide-mobile"><div class="skeleton skeleton-cell" style="width:80px;"></div></td>
            <td class="hide-mobile"><div class="skeleton skeleton-cell" style="width:70px;"></div></td>
            <td class="hide-mobile"><div class="skeleton skeleton-cell" style="width:55px;"></div></td>
            <td class="hide-mobile"><div class="skeleton skeleton-cell" style="width:55px;"></div></td>
            <td><div class="skeleton skeleton-cell" style="width:36px;"></div></td>
            <td><div class="skeleton skeleton-cell" style="width:48px;"></div></td>
        </tr>`).join('');
}

async function loadItems() {
    _showItemsSkeleton();
    try {
        const search = document.getElementById('itemsSearch')?.value;
        const categoryId = document.getElementById('itemsCategoryFilter')?.value;
        
        // Build query parameters
        const params = { ..._branchParam() };
        if (search && search.trim()) {
            params.search = search.trim();
        }
        if (categoryId && categoryId.trim()) {
            params.category_id = categoryId.trim();
        }
        const lowStockOnly = document.getElementById('lowStockFilter')?.checked;
        if (lowStockOnly) {
            params.low_stock = true;
        }
        
        const items = await window.ItemsAPI.list(params);
        AppState.items = items;
        renderItemsTable(items);
    } catch (error) { 
        console.error('Failed to load items:', error);
        const tbody = document.getElementById('itemsTable');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-red-500 py-8">Failed to load items. Please refresh the page.</td></tr>';
        }
    }
}

function renderItemsTable(items) {
    const tbody = document.getElementById('itemsTable');
    if (!items || items.length === 0) { 
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-gray-500 py-8">No items added yet. Add your first item to get started.</td></tr>'; 
        return; 
    }
    tbody.innerHTML = items.map(item => {
        const isPending = item.ai_status === 'pending_ai';
        const nameDisplay = isPending
            ? `<span style="color:var(--text-3);font-style:italic;">${esc(item.name)}</span>
               <span style="font-size:10px;background:#fffbeb;color:#f59e0b;padding:1px 7px;
                            border-radius:99px;border:1px solid #fde68a;margin-left:5px;font-weight:700;
                            white-space:nowrap;">⏳ AI</span>`
            : `<button type="button" onclick="openItemBatchesModal('${esc(item.id)}')" style="display:block;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;border:0;padding:0;color:inherit;font:inherit;font-weight:600;text-align:left;cursor:pointer;"
                     title="View batches/lots for ${esc(item.name)}">${esc(item.name)}</button>`;
        return `
        <tr style="${isPending ? 'opacity:0.75;' : ''}">
            <td class="hide-mobile">
              <div class="w-10 h-10 bg-gray-100 rounded overflow-hidden flex items-center justify-center">
                ${item.image_url ? `<img src="${esc(item.image_url)}" class="w-full h-full object-cover">` : '<i class="fas fa-box text-gray-400"></i>'}
              </div>
            </td>
            <td class="font-medium" style="max-width:200px;">${nameDisplay}</td>
            <td class="hide-mobile">${esc(item.barcode) || '-'}</td>
            <td class="hide-mobile">${esc(item.category_name) || '-'}</td>
            <td class="hide-mobile">${formatCurrency(item.buy_price)}</td>
            <td class="hide-mobile">${formatCurrency(item.sell_price)}</td>
            <td><span class="badge ${item.stock_quantity <= item.min_stock_level ? 'badge-danger' : 'badge-success'}">${item.stock_quantity}</span></td>
            <td style="white-space:nowrap;">
                ${AppState.currentUser?.role !== 'cashier' ? `
                <button class="text-emerald-500 hover:text-emerald-700 mr-2" onclick="openItemBatchesModal('${esc(item.id)}')" title="View batches / lots"><i class="fas fa-layer-group"></i></button>
                <button class="text-blue-500 hover:text-blue-700 mr-2" onclick="editItem('${esc(item.id)}')"><i class="fas fa-edit"></i></button>
                <button class="text-red-500 hover:text-red-700" onclick="deleteItem('${esc(item.id)}')"><i class="fas fa-trash"></i></button>
                ` : `<button class="text-emerald-500 hover:text-emerald-700 mr-2" onclick="openItemBatchesModal('${esc(item.id)}')" title="View batches / lots"><i class="fas fa-layer-group"></i></button><button class="text-gray-400" title="View only" onclick="editItem('${esc(item.id)}')"><i class="fas fa-eye"></i></button>`}
            </td>
        </tr>`;
    }).join('');
}

function formatBatchDate(dateStr) {
    if (!dateStr) return '—';
    const raw = String(dateStr);
    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const date = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(raw);
    if (Number.isNaN(date.getTime())) return esc(dateStr);
    return date.toLocaleDateString();
}

function batchExpiryState(batch) {
    if (!batch?.expiry_date) return { label: 'No expiry', color: '#64748b', bg: '#f1f5f9' };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const raw = String(batch.expiry_date);
    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const expiry = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(raw);
    expiry.setHours(0, 0, 0, 0);
    const days = Math.ceil((expiry - today) / 86400000);
    if (days < 0) return { label: `Expired ${Math.abs(days)}d`, color: '#b91c1c', bg: '#fee2e2' };
    if (days <= 30) return { label: `Expires in ${days}d`, color: '#b45309', bg: '#fef3c7' };
    return { label: 'Good', color: '#047857', bg: '#d1fae5' };
}

function renderItemBatchSummary(batches) {
    const summary = document.getElementById('itemBatchesSummary');
    if (!summary) return;
    const totalOnHand = batches.reduce((sum, b) => sum + (parseFloat(b.quantity_on_hand) || 0), 0);
    const activeLots = batches.filter(b => b.is_active && (parseFloat(b.quantity_on_hand) || 0) > 0).length;
    const expiringSoon = batches.filter(b => {
        const state = batchExpiryState(b);
        return state.label.startsWith('Expires in') || state.label.startsWith('Expired');
    }).length;
    const cards = [
        { label: 'Total on hand', value: totalOnHand, tone: '#eff6ff', color: '#1d4ed8' },
        { label: 'Active lots', value: activeLots, tone: '#f0fdf4', color: '#047857' },
        { label: 'Expired / soon', value: expiringSoon, tone: '#fffbeb', color: '#b45309' },
    ];
    summary.innerHTML = cards.map(card => `
        <div style="border:1px solid #e2e8f0;border-radius:14px;background:${card.tone};padding:12px;">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:800;">${card.label}</div>
            <div style="font-size:22px;color:${card.color};font-weight:950;margin-top:4px;">${card.value}</div>
        </div>
    `).join('');
}

async function openItemBatchesModal(itemId) {
    const item = (AppState.items || []).find(i => String(i.id) === String(itemId));
    const title = document.getElementById('itemBatchesTitle');
    const subtitle = document.getElementById('itemBatchesSubtitle');
    const tbody = document.getElementById('itemBatchesTable');
    if (title) title.textContent = item ? `${item.name} — Batches / Lots` : 'Item Batches';
    if (subtitle) subtitle.textContent = 'Active lots are shown in FEFO order (first expiry, first out).';
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500 py-8"><i class="fas fa-spinner fa-spin"></i> Loading batches…</td></tr>';
    renderItemBatchSummary([]);
    document.getElementById('itemBatchesModal')?.classList.add('active');

    try {
        const batches = await window.ItemsAPI.listBatches(itemId);
        renderItemBatchSummary(Array.isArray(batches) ? batches : []);
        if (!tbody) return;
        if (!Array.isArray(batches) || !batches.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500 py-8">No batch or lot records found for this item yet.</td></tr>';
            return;
        }
        tbody.innerHTML = batches.map(batch => {
            const state = batchExpiryState(batch);
            const onHand = parseFloat(batch.quantity_on_hand) || 0;
            const received = parseFloat(batch.received_quantity) || 0;
            const active = batch.is_active && onHand > 0;
            return `<tr>
                <td><strong>${esc(batch.batch_number || 'Unnumbered lot')}</strong><small style="display:block;color:var(--text-secondary);font-size:11px;">${esc(String(batch.id || '').slice(0, 8))}</small></td>
                <td><span style="display:inline-flex;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:800;background:${state.bg};color:${state.color};">${esc(state.label)}</span><small style="display:block;color:var(--text-secondary);font-size:11px;margin-top:4px;">${formatBatchDate(batch.expiry_date)}</small></td>
                <td style="text-align:right;font-weight:800;">${onHand}</td>
                <td style="text-align:right;">${received}</td>
                <td style="text-align:right;">${formatCurrency(parseFloat(batch.unit_cost) || 0)}</td>
                <td>${formatBatchDate(batch.received_at)}</td>
                <td><span class="badge ${active ? 'badge-success' : 'badge-secondary'}">${active ? 'Active' : 'Inactive'}</span></td>
            </tr>`;
        }).join('');
    } catch (error) {
        console.error('Failed to load item batches:', error);
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center text-red-500 py-8">${esc(error.message || 'Failed to load batches')}</td></tr>`;
    }
}

function openItemModal(item = null) {
    document.getElementById('itemModalTitle').textContent = item ? 'Edit Item' : 'Add Item';
    const tenantSupportsPharma = isPharmaTenant();
    const pharmaFields = document.getElementById('pharmacyItemFields');
    updateItemPagePharmacyModeControl();
    const pagePharmacyMode = isItemPharmacyModeEnabled();
    const itemLooksPharmacy = !!(item?.generic_name || item?.dosage_form || item?.strength || item?.base_unit_id);
    const pharmaMode = tenantSupportsPharma && (item ? itemLooksPharmacy : pagePharmacyMode);
    if (pharmaFields) {
        pharmaFields.style.display = pharmaMode ? 'block' : 'none';
        pharmaFields.classList.toggle('is-open', pharmaMode);
    }
    toggleItemPharmacyMode(pharmaMode);

    // Safety: ensure cost & retail price fields are always editable outside pharma mode
    if (!pharmaMode) {
        ['itemBuyPrice', 'itemSellPrice', 'itemStock', 'itemMinStock', 'itemExpiryDate', 'itemBatchNumber'].forEach(id => {
            const f = document.getElementById(id);
            if (f) { f.disabled = false; }
            const g = f?.closest('.form-group');
            if (g) { g.style.display = ''; }
        });
    }

    // ── Explicitly clear every field first, then set values ──────────────────
    // This defeats browser autofill that fires after the modal opens
    const clearIds = ['itemId','itemName','itemBarcode','itemBuyPrice','itemSellPrice',
                      'itemStock','itemMinStock','itemExpiryDate','itemBatchNumber','itemDescription',
                      'itemBrand','itemGenericName','itemBrandName','itemStrength','itemPurchaseMultiplier',
                      'itemSaleMultiplier','itemReceivedQty','pharmaPurchaseCost','pharmaBatchNumber','pharmaExpiryDate',
                      'pharmaMinStockLevel','packBoxesPerCarton','packStripsPerBox','packUnitsPerStrip',
                      'tierSellPrice_carton','tierSellPrice_box','tierSellPrice_strip','tierSellPrice_base',
                      'tierBarcode_carton','tierBarcode_box','tierBarcode_strip','tierBarcode_base',
                      'itemBaseUnit','itemPurchaseUnit','itemSaleUnit'];
    clearIds.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

    // Small delay then set real values — autofill fires synchronously, our set fires after
    const _set = () => {
        document.getElementById('itemId').value          = item?.id || '';
        document.getElementById('itemName').value        = item?.name || '';
        document.getElementById('itemBarcode').value     = item?.barcode || '';
        document.getElementById('itemBrand').value       = item?.brand || item?.brand_name || '';
        document.getElementById('itemCategory').value    = item?.category_id || '';
        document.getElementById('itemSupplier').value    = item?.supplier_id || '';
        document.getElementById('itemBuyPrice').value    = item?.buy_price ?? 0;
        document.getElementById('itemSellPrice').value   = item?.sell_price ?? 0;
        document.getElementById('itemStock').value       = item?.stock_quantity ?? 0;
        document.getElementById('itemMinStock').value    = item?.min_stock_level ?? 10;
        document.getElementById('itemExpiryDate').value  = item?.expiry_date || '';
        document.getElementById('itemBatchNumber').value = item?.batch_number || '';
        document.getElementById('itemDescription').value = item?.description || '';
        if (tenantSupportsPharma) {
            document.getElementById('itemGenericName').value = item?.generic_name || '';
            document.getElementById('itemBrandName').value = item?.brand_name || item?.brand || '';
            document.getElementById('itemStrength').value = item?.strength || '';
            document.getElementById('itemDosageForm').value = item?.dosage_form || '';
            document.getElementById('itemControlledSubstance').checked = !!item?.controlled_substance;
            const rxYes = document.getElementById('itemControlledSubstanceYes');
            const rxNo = document.getElementById('itemControlledSubstanceNo');
            if (rxYes) rxYes.checked = !!item?.controlled_substance;
            if (rxNo) rxNo.checked = !item?.controlled_substance;
            document.getElementById('itemPurchaseMultiplier').value = 1;
            document.getElementById('itemSaleMultiplier').value = 1;
            document.getElementById('itemReceivedQty').value = item ? 0 : (item?.stock_quantity ?? 0);
            // Convert per-base-unit buy_price back to per-purchase-unit for display
            const pc = document.getElementById('pharmaPurchaseCost');
            if (pc) {
                const _mu = document.getElementById('pharmaStockInputUnit')?.value || 'carton';
                pc.value = _mu !== 'base' && getUnitMultiplier(_mu) > 1
                    ? ((item?.buy_price ?? 0) * getUnitMultiplier(_mu)).toFixed(2)
                    : (item?.buy_price ?? '');
            }
            document.getElementById('pharmaBatchNumber').value = item?.batch_number || '';
            document.getElementById('pharmaExpiryDate').value = item?.expiry_date || '';
            document.getElementById('pharmaMinStockLevel').value = item?.min_stock_level ?? 10;

            // Hydrate packaging tiers from enriched backend data (skip extra API call)
            const tiers = item?.packaging_tiers;
            if (Array.isArray(tiers) && tiers.length) {
                const byLevel = {};
                tiers.forEach(t => { byLevel[String(t.unit_level || '').toLowerCase()] = t; });
                const carton = parseFloat(byLevel['carton']?.base_unit_multiplier || 0);
                const box = parseFloat(byLevel['box']?.base_unit_multiplier || 0);
                const strip = parseFloat(byLevel['strip']?.base_unit_multiplier || 0);
                if (carton > 0 && box > 0) document.getElementById('packBoxesPerCarton').value = Math.max(1, Math.round(carton / box));
                if (box > 0) document.getElementById('packStripsPerBox').value = Math.max(1, Math.round(box / Math.max(1, strip || 1)));
                if (strip > 0) document.getElementById('packUnitsPerStrip').value = Math.max(1, Math.round(strip));
                for (const tier of tiers) {
                    const level = String(tier.unit_level || '').toLowerCase();
                    const priceEl = document.getElementById(`tierSellPrice_${level}`);
                    const barcodeEl = document.getElementById(`tierBarcode_${level}`);
                    if (priceEl) priceEl.value = tier.selling_price ?? '';
                    if (barcodeEl) barcodeEl.value = tier.barcode || '';
                }
            } else {
                document.getElementById('packBoxesPerCarton').value = 20;
                document.getElementById('packStripsPerBox').value = 10;
                document.getElementById('packUnitsPerStrip').value = 10;
            }
        }
    };

    _set();                          // set immediately
    setTimeout(_set, 50);            // set again after 50 ms (beats Chrome autofill)
    setTimeout(_set, 200);           // set again after 200 ms (beats slow autofill)

    const preview = document.getElementById('imagePreview');
    preview.innerHTML = item?.image_url
        ? `<img src="${item.image_url}" class="w-full h-full object-cover">`
        : '<i class="fas fa-image text-gray-400 text-2xl"></i>';
    delete preview.dataset.externalImageUrl;
    window.currentItemImage = null;

    const selectedCategoryId = item?.category_id || '';
    const selectedSupplierId = item?.supplier_id || '';

    loadCategoriesForSelect().then(() => {
        if (selectedCategoryId) document.getElementById('itemCategory').value = selectedCategoryId;
        if (selectedSupplierId) document.getElementById('itemSupplier').value = selectedSupplierId;
    });

    if (tenantSupportsPharma) {
        ensurePharmacyUnits().then(() => {
            populateUnitSelect('itemBaseUnit', item?.base_unit_id || '');
            // Apply packaging defaults from dosage form (only for new items, or when
            // no tiers exist yet — existing tiers take priority and are hydrated below)
            const df = document.getElementById('itemDosageForm')?.value || '';
            if (!item?.id || !item?.packaging_tiers?.length) {
                _applyDosageFormDefaults(df);
            }
            updatePackagingEngine();
            if (item?.id) hydratePackagingTiers(item.id);
        });
        ['itemBuyPrice','pharmaPurchaseCost','itemReceivedQty','itemBaseUnit','packBoxesPerCarton','packStripsPerBox','packUnitsPerStrip','pharmaBatchNumber','pharmaExpiryDate','pharmaMinStockLevel','pharmaMinStockUnit','pharmaStockInputUnit','itemAutoBatch','pharmaAutoBatch','itemControlledSubstanceYes','itemControlledSubstanceNo'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.dataset.pharmaListenerAttached) {
                el.addEventListener('input', () => { syncPharmacyBatchFields(); updatePackagingEngine(); });
                el.addEventListener('change', () => { syncPharmacyBatchFields(); updatePackagingEngine(); });
                el.dataset.pharmaListenerAttached = 'true';
            }
        });
        // Dosage form change → reconfigure default units and packaging
        const dfEl = document.getElementById('itemDosageForm');
        if (dfEl && !dfEl.dataset.dosageListenerAttached) {
            dfEl.addEventListener('change', function () {
                _applyDosageFormDefaults(this.value);
            });
            dfEl.dataset.dosageListenerAttached = 'true';
        }
    }

    document.getElementById('itemModal').classList.add('active');
}

async function handleItemSubmit(e) {
    e.preventDefault();
    const itemId = document.getElementById('itemId').value;

    // ── Frontend validation ────────────────────────────────────────────────
    const _fail = (msg, id) => {
        showToast(msg, 'error');
        const el = id && document.getElementById(id);
        if (el) el.focus();
    };
    const _nameRaw = document.getElementById('itemName').value.trim();
    if (!_nameRaw) { _fail('Item name is required', 'itemName'); return; }
    const _buyPrice = parseFloat(document.getElementById('itemBuyPrice').value);
    const _sellPrice = parseFloat(document.getElementById('itemSellPrice').value);
    const _qty = document.getElementById('itemStock').value.trim();
    if (!Number.isFinite(_buyPrice) || _buyPrice < 0) { _fail('Buy price must be a number, 0 or more', 'itemBuyPrice'); return; }
    if (!Number.isFinite(_sellPrice) || _sellPrice < 0) { _fail('Sell price must be a number, 0 or more', 'itemSellPrice'); return; }
    if (_qty !== '' && !/^\d+$/.test(_qty)) { _fail('Stock quantity must be a whole number, 0 or more', 'itemStock'); return; }

    const _pharmaMode = isCurrentItemFormPharmacyMode();
    if (_pharmaMode) {
        const _pcost = parseFloat(document.getElementById('pharmaPurchaseCost')?.value);
        if (!Number.isFinite(_pcost) || _pcost < 0) { _fail('Purchase cost must be a number, 0 or more', 'pharmaPurchaseCost'); return; }
        if (!itemId) {
            const _rq = document.getElementById('itemReceivedQty')?.value.trim() || '';
            if (_rq !== '' && !/^\d+$/.test(_rq)) { _fail('Received quantity must be a whole number, 0 or more', 'itemReceivedQty'); return; }
        }
        if (!document.getElementById('itemBaseUnit')?.value) { _fail('Base unit is required in pharmacy mode', 'itemBaseUnit'); return; }
        // Expiry is mandatory for pharmacy items and must be a real, non-past date.
        const _expRaw = document.getElementById('pharmaExpiryDate')?.value.trim() || '';
        const _expIso = parseFlexibleDateInput(_expRaw);
        const _expOk = _expIso && /^\d{4}-\d{2}-\d{2}$/.test(_expIso) && !isNaN(new Date(_expIso + 'T00:00:00').getTime());
        if (!_expRaw || !_expOk) { _fail('Expiry date is required (DD-MM-YYYY) in pharmacy mode', 'pharmaExpiryDate'); return; }
        const _todayIso = new Date().toISOString().slice(0, 10);
        if (_expIso < _todayIso) { _fail('Expiry date cannot be in the past', 'pharmaExpiryDate'); return; }
        // At least one packaging tier needs a sell price, and a tier barcode
        // without its price would be silently dropped — block it explicitly.
        let _tierPriced = 0;
        for (const _lvl of ['base', 'strip', 'box', 'carton']) {
            const _p = parseFloat(document.getElementById(`tierSellPrice_${_lvl}`)?.value);
            const _bc = document.getElementById(`tierBarcode_${_lvl}`)?.value.trim() || '';
            if (Number.isFinite(_p) && _p > 0) _tierPriced++;
            else if (_bc) { _fail(`Add a sell price for the ${_lvl} tier (it has a barcode)`, `tierSellPrice_${_lvl}`); return; }
            if (Number.isFinite(_p) && _p < 0) { _fail(`Sell price for ${_lvl} cannot be negative`, `tierSellPrice_${_lvl}`); return; }
        }
        if (!_tierPriced) { _fail('Add at least one tier sell price', 'tierSellPrice_base'); return; }
        const _ms = document.getElementById('pharmaMinStockLevel')?.value.trim() || '';
        if (_ms !== '' && !/^\d+$/.test(_ms)) { _fail('Min stock level must be a whole number, 0 or more', 'pharmaMinStockLevel'); return; }
    }

    // Check if an external image URL was set by barcode lookup
    const preview = document.getElementById('imagePreview');
    const externalImageUrl = preview?.dataset?.externalImageUrl || null;

    const data = {
        name: _nameRaw,
        barcode: document.getElementById('itemBarcode').value.trim() || null,
        brand: document.getElementById('itemBrandName')?.value || document.getElementById('itemBrand')?.value || null,
        category_id: document.getElementById('itemCategory').value || null,
        supplier_id: document.getElementById('itemSupplier').value || null,
        buy_price: _buyPrice,
        sell_price: _sellPrice,
        stock_quantity: _qty === '' ? 0 : parseInt(_qty, 10),
        min_stock_level: (() => { const _m = parseInt(document.getElementById('itemMinStock').value, 10); return Number.isFinite(_m) && _m >= 0 ? _m : 0; })(),
        expiry_date: parseFlexibleDateInput(document.getElementById('itemExpiryDate').value) || null,
        batch_number: (document.getElementById('itemAutoBatch')?.checked ? generateAutoBatchNumber() : document.getElementById('itemBatchNumber').value) || null,
        description: document.getElementById('itemDescription').value || null,
        // Use external image URL from barcode lookup if no local image selected
        image_url: externalImageUrl || undefined,
        branch_id: AppState.branch?.id
    };

    if (isCurrentItemFormPharmacyMode()) {
        // Convert per-purchase-unit buy price (e.g. 600/carton) to per-base-unit
        // (e.g. 3/tablet) so items.buy_price always stores a per-base cost.
        const _pharmStockUnit = document.getElementById('pharmaStockInputUnit')?.value || 'carton';
        data.buy_price = _num('pharmaPurchaseCost', 0) / Math.max(1, getUnitMultiplier(_pharmStockUnit));
        const pharmacySellPrice = _num('tierSellPrice_base', 0) || _num('tierSellPrice_strip', 0) || _num('tierSellPrice_box', 0) || _num('tierSellPrice_carton', 0) || data.sell_price || 0;
        data.sell_price = pharmacySellPrice;
        // Keep user-entered barcode/category/supplier/description for pharmacy
        // items. The item-level barcode is used for fast POS scanning; packaging
        // tiers carry their own per-tier barcodes separately.
        syncPharmacyBatchFields();
        data.generic_name = document.getElementById('itemGenericName')?.value || null;
        data.brand_name = document.getElementById('itemBrandName')?.value || document.getElementById('itemBrand')?.value || null;
        data.strength = document.getElementById('itemStrength')?.value || null;
        data.dosage_form = document.getElementById('itemDosageForm')?.value || null;
        data.controlled_substance = !!document.getElementById('itemControlledSubstance')?.checked;
        data.base_unit_id = document.getElementById('itemBaseUnit')?.value || null;
        // Keep item-level units aligned with the user's form choices. Purchase
        // follows "Purchase Unit" exactly (box/strip/carton/base), while sale
        // defaults to the smallest priced non-base tier for fast POS selling.
        const configuredTiers = collectPackagingTiers();
        const nonBaseTiers = configuredTiers.filter(t => String(t.unit_level).toLowerCase() !== 'base');
        const saleTier = nonBaseTiers.reduce((a, b) =>
            (a && Number(a.base_unit_multiplier) <= Number(b.base_unit_multiplier)) ? a : b, null);
        const selectedPurchaseLevel = document.getElementById('pharmaStockInputUnit')?.value || 'base';
        data.purchase_unit_id = resolvePackagingUnitId(selectedPurchaseLevel, data.base_unit_id);
        data.sale_unit_id = resolvePackagingUnitId(saleTier?.unit_level, data.base_unit_id);
        data.batch_number = (document.getElementById('pharmaAutoBatch')?.checked ? generateAutoBatchNumber() : document.getElementById('pharmaBatchNumber')?.value) || data.batch_number;
        data.expiry_date = parseFlexibleDateInput(document.getElementById('pharmaExpiryDate')?.value) || data.expiry_date;
        data.min_stock_level = getPharmacyMinStockQuantity();
        if (!itemId) {
            data.stock_quantity = getPharmacyStockQuantity();
        }
    } else {
        data.generic_name = null;
        data.brand_name = null;
        data.strength = null;
        data.dosage_form = null;
        data.controlled_substance = false;
        data.base_unit_id = null;
        data.purchase_unit_id = null;
        data.sale_unit_id = null;
    }

    // ── Duplicate barcode check (only on create, not edit) ────────────────────
    if (!itemId && data.barcode) {
        try {
            const existing = await window.ItemsAPI.getByBarcode(data.barcode).catch(() => null);
            if (existing && existing.id) {
                // Highlight the barcode field
                const bcField = document.getElementById('itemBarcode');
                if (bcField) {
                    bcField.style.borderColor = 'var(--danger, #ef4444)';
                    bcField.style.boxShadow = '0 0 0 3px rgba(239,68,68,.15)';
                    setTimeout(() => { bcField.style.borderColor = ''; bcField.style.boxShadow = ''; }, 4000);
                }
                // Show actionable dialog instead of just a toast
                const goEdit = await xposConfirm(
                    `Barcode "${esc(data.barcode)}" already belongs to "${esc(existing.name)}".\n\nOpen that item for editing instead?`,
                    'Duplicate Barcode',
                    false
                );
                if (goEdit) {
                    closeModal('itemModal');
                    editItem(existing.id);
                }
                return;
            }
        } catch (_) { /* barcode lookup failed — proceed normally */ }
    }

    const _saveBtn = document.querySelector('#itemForm button[type="submit"]');
    if (_saveBtn) _saveBtn.disabled = true;
    try {
        let savedItem;
        if (itemId) { 
            savedItem = await window.ItemsAPI.update(itemId, data); 
            showToast('Item updated', 'success'); 
        } else { 
            savedItem = await window.ItemsAPI.create(data); 
            showToast('Item created', 'success'); 
        }

        if (isCurrentItemFormPharmacyMode() && savedItem?.id && data.base_unit_id) {
            const tiers = collectPackagingTiers();
            await window.ItemsAPI.savePackagingTiers(savedItem.id, { tiers }).catch(error => {
                console.warn('Failed to save packaging tiers:', error);
                showToast('Item saved, but packaging tiers could not be saved', 'warning');
            });
        }
        
        // Upload image if selected
        if (window.currentItemImage && savedItem?.id) {
            try {
                await window.ItemsAPI.uploadImage(savedItem.id, window.currentItemImage);
                showToast('Image uploaded', 'success');
            } catch (imgError) {
                console.warn('Image upload failed:', imgError);
            }
            window.currentItemImage = null;
        }
        
        // Close modal and reset form
        closeModal('itemModal');
        document.getElementById('itemForm').reset();
        document.getElementById('itemId').value = '';
        loadItems();
    } catch (error) {
        console.error('Failed to save item:', error);
        let errorMessage = error.message || 'Failed to save item';
        // 409 = duplicate barcode — show actionable message
        if (errorMessage.includes('already exists') || errorMessage.includes('already used')) {
            showToast('⚠️ ' + errorMessage, 'error');
        } else {
            showToast(errorMessage, 'error');
        }
    } finally {
        if (_saveBtn) _saveBtn.disabled = false;
    }
}

async function editItem(itemId) {
    try { const item = await window.ItemsAPI.get(itemId); openItemModal(item); }
    catch (error) { showToast('Failed to load item', 'error'); }
}

async function deleteItem(itemId) {
    if (!await xposConfirm('Delete this item?', 'Delete Item', true)) return;
    try { await window.ItemsAPI.delete(itemId); showToast('Item deleted', 'success'); loadItems(); }
    catch (error) { showToast(error.message || 'Failed to delete', 'error'); }
}

function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { 
        document.getElementById('imagePreview').innerHTML = `<img src="${e.target.result}" class="w-full h-full object-cover">`; 
        window.currentItemImage = file;
    };
    reader.readAsDataURL(file);
}

function openCamera() { document.getElementById('itemImage').click(); }

// ─────────────────────────────────────────────────────────────────────────────
// PROFESSIONAL BARCODE / QR SCANNER
// Uses ZXing-js: supports EAN-13, EAN-8, UPC-A, UPC-E, Code128, Code39,
// QR Code, DataMatrix, ITF, PDF417 — everything pharmacies & cosmetics use.
// ─────────────────────────────────────────────────────────────────────────────

// ── Scanner integration (delegates to window.XScanner in scanner.js) ─────────

// Handle barcode from camera scanner OR hardware keyboard-wedge
document.addEventListener('xpos:barcode', async (e) => {
    // Auto-detect context: if the item modal is open, route to 'item' context
    const itemModalOpen = document.getElementById('itemModal')?.classList.contains('active');
    const context = itemModalOpen ? 'item' : 'pos';
    await _handleScannedCode(e.detail.code, context);
});

async function _handleScannedCode(code, context) {

    if (context === 'item') {
        // ── Item modal: fill barcode, then lookup and auto-fill all fields ──────
        const barcodeField = document.getElementById('itemBarcode');
        if (barcodeField) barcodeField.value = code;
        window.XScanner?.close();

        // Show a loading indicator on the barcode field
        _setBarcodeFieldState('loading', 'Looking up product…');

        try {
            const item = await window.ItemsAPI.getByBarcode(code);

            // ── Auto-fill every field ────────────────────────────────────────
            const set = (id, val) => {
                const el = document.getElementById(id);
                if (el && val !== undefined && val !== null) el.value = val;
            };

            set('itemName',        item.name);
            set('itemDescription', item.description || '');
            set('itemBuyPrice',    item.buy_price   || 0);
            set('itemSellPrice',   item.sell_price  || 0);
            set('itemStock',       item.stock_quantity !== undefined ? item.stock_quantity : 0);
            set('itemMinStock',    item.min_stock_level !== undefined ? item.min_stock_level : 10);
            set('itemExpiryDate',  item.expiry_date || '');
            set('itemBatchNumber', item.batch_number || '');

            // Category select
            if (item.category_id) {
                const catEl = document.getElementById('itemCategory');
                if (catEl) catEl.value = item.category_id;
            }
            // Supplier select
            if (item.supplier_id) {
                const supEl = document.getElementById('itemSupplier');
                if (supEl) supEl.value = item.supplier_id;
            }
            // Image preview
            if (item.image_url) {
                const preview = document.getElementById('imagePreview');
                if (preview) {
                    preview.innerHTML = `<img src="${item.image_url}" 
                        style="width:100%;height:100%;object-fit:cover;border-radius:8px"
                        onerror="this.parentElement.innerHTML='<i class=\'fas fa-image text-gray-400 text-2xl\'></i>'"
                    >`;
                }
            }

            _setBarcodeFieldState('success', '');
            showToast(`✅ "${item.name}" found — fields filled automatically`, 'success');

        } catch (err) {
            const notFound = err?.status === 404 || err?.message?.includes('not found');
            if (notFound) {
                // ── Not in our system → parallel lookup across all product databases ──
                _setBarcodeFieldState('loading', 'Searching global databases…');
                showToast('Not in inventory — searching global databases…', 'info');
                const ext = await (window.SmartScan?.lookupBarcode?.(code) || _lookupExternalBarcode(code));
                if (ext) {
                    const set = (id, val) => {
                        const el = document.getElementById(id);
                        if (el && val !== undefined && val !== null && val !== '') el.value = val;
                    };
                    set('itemName',        ext.name);
                    set('itemDescription', ext.description);
                    // Fill brand into description prefix if it's a separate field or append
                    if (ext.brand) {
                        const descEl = document.getElementById('itemDescription');
                        if (descEl && !descEl.value.includes(ext.brand)) {
                            descEl.value = ext.brand + (descEl.value ? ' — ' + descEl.value : '');
                        }
                    }

                    if (ext.image_url) {
                        const preview = document.getElementById('imagePreview');
                        if (preview) {
                            preview.dataset.externalImageUrl = ext.image_url;
                            preview.innerHTML = `
                                <img src="${ext.image_url}"
                                    style="width:100%;height:100%;object-fit:cover;border-radius:8px"
                                    onerror="this.parentElement.innerHTML='<i class=\'fas fa-image text-gray-400 text-2xl\'></i>'"
                                >
                                <div style="position:absolute;bottom:4px;left:0;right:0;text-align:center">
                                    <span style="background:rgba(0,0,0,.55);color:#fff;font-size:9px;
                                                 padding:2px 8px;border-radius:4px">${ext.source||'External DB'}</span>
                                </div>`;
                            preview.style.position = 'relative';
                        }
                    }

                    _setBarcodeFieldState('success', '');
                    showToast(`✅ "${ext.name}" found via ${ext.source||'global database'} — review and save`, 'success');
                } else {
                    _setBarcodeFieldState('idle', '');
                    showToast(`Barcode ${code} not found anywhere — fill in details manually`, 'warning');
                    // 🔕 Silently save barcode stub so next scan is instant
                    _silentlySaveBarcodeStub(code);
                }
            } else {
                _setBarcodeFieldState('idle', '');
                showToast('Product lookup failed — fill in details manually', 'warning');
            }
        }
        return;
    }

    // ── POS context: find item and add to cart — scanner stays open ─────────
    try {
        const item = await window.ItemsAPI.getByBarcode(code);
        if (!item.is_active || item.stock_quantity <= 0) {
            showToast(`⚠️ ${item.name} is out of stock`, 'warning');
            return; // scanner stays open — scan next product
        }
        await addToCart(item.id, resolveTierUnitId(item, item.matched_tier));
        showToast(`✅ ${item.name} added to cart`, 'success');
        // Scanner intentionally stays open for continuous scanning
    } catch (err) {
        if (err?.status === 404 || err?.message?.includes('not found')) {
            showToast(`❌ Barcode "${code}" not found in system`, 'error');
        } else {
            showToast(err?.message || 'Barcode lookup failed. Try again.', 'error');
        }
        // Scanner stays open — user can try again or tap Done
    }
}

// ── External barcode lookup via Open Food Facts ────────────────────────────
// ── Multi-source barcode lookup ───────────────────────────────────────────────
// Sources tried in order:
//   1. Open Beauty Facts  — cosmetics, skincare, makeup (EAN/UPC)
//   2. Open Food Facts    — food, beverages, pharmacy consumables
//   3. Open Products Facts — general household/cleaning products
//   4. UPC Item DB        — broad fallback for any retail product
// Returns { name, description, image_url, source } or null
async function _lookupExternalBarcode(code) {

    // ── Helper: parse an Open*Facts response ────────────────────────────────
    function _parseOpenFactsProduct(data, sourceName) {
        if (!data || data.status !== 1 || !data.product) return null;
        const p = data.product;
        const name = (p.product_name_en || p.product_name || p.generic_name || '').trim();
        if (!name) return null;

        const parts = [];
        if (p.brands)   parts.push(p.brands);
        if (p.quantity) parts.push(p.quantity);

        // Beauty-specific fields
        if (p.skin_type)         parts.push('Skin: ' + p.skin_type);
        if (p.hair_type)         parts.push('Hair: ' + p.hair_type);
        if (p.scent)             parts.push('Scent: ' + p.scent);
        if (p.color)             parts.push('Color: ' + p.color);

        // Food/pharma description
        if (p.generic_name && p.generic_name !== name) parts.push(p.generic_name);
        if (p.ingredients_text)  parts.push(p.ingredients_text.slice(0, 180));

        const description = parts.filter(Boolean).join(' · ').trim();
        const image_url   = p.image_front_url || p.image_url || '';

        return { name, description, image_url, source: sourceName };
    }

    // ── 1. Open Beauty Facts (cosmetics, skincare, makeup) ───────────────────
    try {
        const beautyFields = 'product_name,product_name_en,generic_name,brands,image_url,image_front_url,quantity,scent,color,skin_type,hair_type,ingredients_text';
        const r1 = await fetch(
            `https://world.openbeautyfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${beautyFields}`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (r1.ok) {
            const d1 = await r1.json();
            const result = _parseOpenFactsProduct(d1, 'Open Beauty Facts');
            if (result) return result;
        }
    } catch (_) {}

    // ── 2. Open Food Facts (food, beverages, OTC pharmacy) ───────────────────
    try {
        const foodFields = 'product_name,product_name_en,generic_name,brands,image_url,image_front_url,quantity,ingredients_text';
        const r2 = await fetch(
            `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${foodFields}`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (r2.ok) {
            const d2 = await r2.json();
            const result = _parseOpenFactsProduct(d2, 'Open Food Facts');
            if (result) return result;
        }
    } catch (_) {}

    // ── 3. Open Products Facts (household, cleaning, general) ────────────────
    try {
        const r3 = await fetch(
            `https://world.openproductsfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_en,brands,image_url,image_front_url,quantity`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (r3.ok) {
            const d3 = await r3.json();
            const result = _parseOpenFactsProduct(d3, 'Open Products Facts');
            if (result) return result;
        }
    } catch (_) {}

    // ── 4. UPC Item DB (broad retail fallback) ────────────────────────────────
    try {
        const r4 = await fetch(
            `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (r4.ok) {
            const d4 = await r4.json();
            const item = d4.items?.[0];
            if (item?.title) {
                return {
                    name:        item.title,
                    description: [item.brand, item.description].filter(Boolean).join(' · ').slice(0, 250),
                    image_url:   item.images?.[0] || '',
                    source:      'UPC Item DB',
                };
            }
        }
    } catch (_) {}

    return null;
}

/**
 * Silently save a minimal item stub when a barcode isn't found anywhere.
 * Next time this barcode is scanned it loads instantly; user fills details then.
 * Runs in background — never blocks UI or shows errors.
 */
async function _silentlySaveBarcodeStub(barcode) {
    try {
        const existing = await window.ItemsAPI.getByBarcode(barcode).catch(() => null);
        if (existing) return;
        await window.ItemsAPI.create({
            name:            `Product ${barcode}`,
            barcode:         barcode,
            description:     '',
            buy_price:       0,
            sell_price:      0,
            stock_quantity:  0,
            min_stock_level: 10,
            is_active:       false,
        });
        console.log('[POS] Saved barcode stub silently:', barcode);
    } catch (e) {
        console.warn('[POS] Barcode stub save skipped:', e?.message);
    }
}

// Visual feedback on barcode field during lookup
function _setBarcodeFieldState(state, hint) {
    const field = document.getElementById('itemBarcode');
    if (!field) return;
    const wrap  = field.parentElement;

    // Remove old indicator
    wrap.querySelectorAll('._barcode-indicator').forEach(el => el.remove());

    if (state === 'loading') {
        field.style.borderColor = 'var(--primary)';
        const ind = document.createElement('span');
        ind.className = '_barcode-indicator';
        ind.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--primary)';
        ind.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
        wrap.appendChild(ind);
    } else if (state === 'success') {
        field.style.borderColor = '#22c55e';
        const ind = document.createElement('span');
        ind.className = '_barcode-indicator';
        ind.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:14px;color:#22c55e';
        ind.innerHTML = '<i class="fas fa-check-circle"></i>';
        if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
        wrap.appendChild(ind);
        setTimeout(() => { field.style.borderColor = ''; ind.remove(); }, 3000);
    } else {
        field.style.borderColor = '';
    }
}

async function openScanner(context = 'pos') {
    const hasCamera = await checkCameraAvailable();
    if (!hasCamera) {
        showToast('No camera on this device. Use a USB or Bluetooth barcode scanner.', 'warning');
        // Focus the barcode input field if it exists (for manual entry)
        const barcodeInput = document.getElementById('itemBarcode') ||
                             document.getElementById('barcodeInput');
        if (barcodeInput) barcodeInput.focus();
        return;
    }
    window.XScanner?.open({
        onResult: (code) => _handleScannedCode(code, context),
        onError:  (msg)  => showToast(msg, 'error'),
        target: context,
    });
}

function openPOSScanner()  { openScanner('pos'); }
function openItemScanner() { openScanner('item'); }
function closeScanner()    { window.XScanner?.close(); }
function switchCamera()    { window.XScanner?.switchCamera(); }
function toggleTorch()     { window.XScanner?.toggleTorch(); }

function manualBarcodeEntry() {
    const code = prompt('Enter barcode manually:');
    if (code && code.trim()) {
        closeScanner();
        handleBarcodeSearch(code.trim());
    }
}

// Close scanner on Escape key
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeScanner();
        closeReceiptPreview();
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RECEIPT SYSTEM
// Generates professional 80mm thermal receipts + browser print fallback
// ═══════════════════════════════════════════════════════════════════════════════
const ReceiptSystem = (() => {
    let _lastSale = null;

    function _sym() {
        const s = { USD:'$', EUR:'€', GBP:'£', KES:'KSh', NGN:'₦', ETB:'Br' };
        return s[AppState.organization?.currency] || 'Br';
    }
    function _fmt(n) { return `${_sym()}${(+n||0).toFixed(2)}`; }

    function _pad(str, len, right=false) {
        str = String(str ?? '');
        if (str.length >= len) return str.substring(0, len);
        const pad = ' '.repeat(len - str.length);
        return right ? pad + str : str + pad;
    }

    // Build HTML receipt (80mm = 302px wide — standard thermal width)
    function _buildHTML(sale) {
        const org   = AppState.organization || {};
        const user  = AppState.currentUser  || {};
        const items = sale.items || [];
        const sym   = _sym();

        const payParts = [];
        if (+sale.cash_paid   > 0) payParts.push(`Cash: ${_fmt(sale.cash_paid)}`);
        if (+sale.bank_paid   > 0) payParts.push(`Bank: ${_fmt(sale.bank_paid)}`);
        if (+sale.mobile_paid > 0) payParts.push(`Mobile: ${_fmt(sale.mobile_paid)}`);
        const payStr = payParts.join(' · ') || 'Cash';

        const change = Math.max(0, (+sale.cash_paid||0) + (+sale.bank_paid||0) + (+sale.mobile_paid||0) - (+sale.total_amount||0));

        const itemRows = items.map(it => {
            const name  = (it.item_name || it.name || 'Item').substring(0, 22);
            const qty   = it.quantity || 1;
            const price = +it.unit_price || 0;
            const total = (qty * price).toFixed(2);
            return `
                <tr>
                    <td style="padding:3px 0;font-size:12px;vertical-align:top;">${name}</td>
                    <td style="padding:3px 0;font-size:12px;text-align:center;white-space:nowrap;">${qty} × ${price.toFixed(2)}</td>
                    <td style="padding:3px 0;font-size:12px;text-align:right;font-weight:600;">${sym}${total}</td>
                </tr>`;
        }).join('');

        const now   = new Date();
        const dateStr = now.toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'});
        const timeStr = now.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});

        return `
        <div style="font-family:'Courier New',Courier,monospace;width:100%;padding:14px 12px;box-sizing:border-box;color:#111;">

            <!-- Store header -->
            <div style="text-align:center;margin-bottom:10px;">
                <div style="font-size:17px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;">${org.name || 'Store'}</div>
                ${org.address ? `<div style="font-size:11px;margin-top:2px;">${org.address}</div>` : ''}
                ${org.phone   ? `<div style="font-size:11px;">${org.phone}</div>` : ''}
            </div>

            <div style="border-top:1px dashed #aaa;margin:8px 0;"></div>

            <!-- Invoice info -->
            <div style="font-size:11px;margin-bottom:6px;">
                <div style="display:flex;justify-content:space-between;">
                    <span>Invoice:</span><span style="font-weight:700;">${sale.invoice_number || 'N/A'}</span>
                </div>
                <div style="display:flex;justify-content:space-between;">
                    <span>Date:</span><span>${dateStr} ${timeStr}</span>
                </div>
                <div style="display:flex;justify-content:space-between;">
                    <span>Cashier:</span><span>${user.full_name || 'Staff'}</span>
                </div>
            </div>

            <div style="border-top:1px dashed #aaa;margin:8px 0;"></div>

            <!-- Items -->
            <table style="width:100%;border-collapse:collapse;">
                <thead>
                    <tr style="border-bottom:1px solid #ddd;">
                        <th style="font-size:11px;text-align:left;padding:3px 0;font-weight:700;">ITEM</th>
                        <th style="font-size:11px;text-align:center;padding:3px 0;font-weight:700;">QTY×PRICE</th>
                        <th style="font-size:11px;text-align:right;padding:3px 0;font-weight:700;">TOTAL</th>
                    </tr>
                </thead>
                <tbody>${itemRows}</tbody>
            </table>

            <div style="border-top:1px dashed #aaa;margin:8px 0;"></div>

            <!-- Totals -->
            <div style="font-size:12px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                    <span>Subtotal</span><span>${_fmt(sale.subtotal)}</span>
                </div>
                ${+sale.discount_amount > 0 ? `
                <div style="display:flex;justify-content:space-between;margin-bottom:3px;color:#555;">
                    <span>Discount</span><span>-${_fmt(sale.discount_amount)}</span>
                </div>` : ''}
                <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                    <span>Tax (${org.tax_percentage||0}%)</span><span>${_fmt(sale.tax_amount)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:900;
                            border-top:2px solid #111;padding-top:6px;margin-top:4px;">
                    <span>TOTAL</span><span>${_fmt(sale.total_amount)}</span>
                </div>
            </div>

            <div style="border-top:1px dashed #aaa;margin:8px 0;"></div>

            <!-- Payment -->
            <div style="font-size:11px;margin-bottom:6px;">
                <div style="display:flex;justify-content:space-between;">
                    <span>Payment</span><span>${payStr}</span>
                </div>
                ${change > 0 ? `
                <div style="display:flex;justify-content:space-between;font-weight:700;">
                    <span>Change</span><span>${_fmt(change)}</span>
                </div>` : ''}
            </div>

            <div style="border-top:1px dashed #aaa;margin:8px 0;"></div>

            <!-- Footer -->
            <div style="text-align:center;font-size:11px;line-height:1.7;color:#555;">
                <div style="font-weight:700;font-size:12px;color:#111;">Thank you for your purchase!</div>
                <div>Please keep this receipt</div>
                ${org.return_policy ? `<div style="margin-top:4px;">${org.return_policy}</div>` : '<div>No returns without receipt</div>'}
            </div>

            <div style="border-top:1px solid #111;margin:10px 0 4px;"></div>
            <div style="text-align:center;font-size:10px;color:#888;">Powered by Hulu Stock</div>
        </div>`;
    }

    return {
        setSale(sale) { _lastSale = sale; },

        preview() {
            if (!_lastSale) return;
            const html = _buildHTML(_lastSale);
            document.getElementById('receiptPreviewContent').innerHTML = html;
            document.getElementById('receiptPreviewModal').style.display = 'flex';
        },

        print(method = 'auto') {
            if (!_lastSale) return;
            const html = _buildHTML(_lastSale);

            // 1. Try silent print via local Python service
            if (method === 'thermal' || method === 'auto') {
                const printerCfg = HardwareSettings.getPrinterConfig();
                if (printerCfg?.method === 'network' && printerCfg.ip) {
                    // Send to print service
                    fetch(`http://${printerCfg.ip}:${printerCfg.port||6789}/print`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ html, sale: _lastSale, org: AppState.organization }),
                        signal: AbortSignal.timeout(3000),
                    })
                    .then(r => { if (r.ok) showToast('Receipt sent to printer ✓', 'success'); else throw new Error(); })
                    .catch(() => {
                        showToast('Print service unreachable — using browser print', 'warning');
                        this._browserPrint(html);
                    });
                    return;
                }

                // Web Bluetooth thermal (phone/tablet)
                if (printerCfg?.method === 'bt' && printerCfg.btDevice) {
                    this._bluetoothPrint(printerCfg.btDevice, html);
                    return;
                }
            }

            // 2. Browser print dialog fallback
            this._browserPrint(html);
        },

        _browserPrint(html) {
            const w = window.open('', '_blank', 'width=400,height=600');
            if (!w) { showToast('Pop-up blocked — allow pop-ups and try again', 'error'); return; }
            w.document.write(`<!DOCTYPE html><html><head>
                <title>Receipt</title>
                <style>
                    * { margin:0;padding:0;box-sizing:border-box; }
                    body { background:#fff; }
                    @page { size:80mm auto; margin:4mm; }
                    @media print { body { width:72mm; } }
                </style>
            </head><body>${html}<script>
                window.onload = function() { window.print(); window.onafterprint = function() { window.close(); }; };
            </script></body></html>`);
            w.document.close();
        },

        _bluetoothPrint(device, html) {
            // Bluetooth printing is hardware-specific — fall back to browser
            showToast('Bluetooth printing — opening browser dialog', 'info');
            this._browserPrint(html);
        },
    };
})();

function closeSaleSuccess()    { document.getElementById('saleSuccessModal').style.display  = 'none'; }
function closeReceiptPreview() { document.getElementById('receiptPreviewModal').style.display = 'none'; }

// ═══════════════════════════════════════════════════════════════════════════════
// HARDWARE SETTINGS
// Manages printer + scanner config, persisted in localStorage
// ═══════════════════════════════════════════════════════════════════════════════
const HardwareSettings = (() => {
    const KEY_PRINTER  = 'xpos_printer_cfg';
    const KEY_SCANNER  = 'xpos_scanner_cfg';
    const KEY_AUTOPRINT = 'xpos_autoprint';

    function _load(key) {
        try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
    }
    function _save(key, val) {
        localStorage.setItem(key, JSON.stringify(val));
    }

    // ── Printer ───────────────────────────────────────────────────────────────
    function getPrinterConfig()  { return _load(KEY_PRINTER); }
    function isAutoPrint()       { return localStorage.getItem(KEY_AUTOPRINT) === 'true'; }

    function saveAutoPrint(val) {
        localStorage.setItem(KEY_AUTOPRINT, val ? 'true' : 'false');
        _updateToggleUI(val);
        showToast(val ? 'Auto-print enabled' : 'Auto-print disabled', 'success');
    }

    function _updateToggleUI(on) {
        const slider = document.getElementById('autoPrintSlider');
        const knob   = document.getElementById('autoPrintKnob');
        if (!slider) return;
        slider.style.background   = on ? 'var(--primary)' : '#d1d5db';
        knob.style.transform      = on ? 'translateX(22px)' : 'translateX(0)';
    }

    function selectPrinterMethod(method) {
        _save(KEY_PRINTER, { method });
        // Update button styles
        document.querySelectorAll('#printerMethodBtns .hw-method-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.method === method);
        });
        _renderPrinterConfig(method);
    }

    function _renderPrinterConfig(method) {
        const area = document.getElementById('printerConfigArea');
        if (!area) return;

        if (method === 'usb') {
            area.innerHTML = `
                <div style="padding:14px;background:var(--bg-color);border-radius:10px;font-size:13px;border:1px solid var(--border-color);">
                    <div style="font-weight:600;margin-bottom:8px;"><i class="fas fa-info-circle" style="color:var(--primary);margin-right:6px;"></i>USB Thermal Printer Setup</div>
                    <ol style="padding-left:18px;color:var(--text-secondary);line-height:2;">
                        <li>Connect your thermal printer via USB</li>
                        <li>Install the <strong>Hulu Stock Print Service</strong> on this computer</li>
                        <li>Run <code style="background:var(--border-color);padding:1px 5px;border-radius:3px;">HulustockPrinter.exe</code></li>
                        <li>Click <strong>Test Connection</strong> below</li>
                    </ol>
                    <div style="margin-top:12px;display:flex;gap:8px;">
                        <button onclick="HardwareSettings.checkPrintService()" style="padding:8px 16px;background:var(--primary);color:var(--on-primary);border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
                            <i class="fas fa-plug"></i> Test Connection
                        </button>
                        <a href="#" onclick="HardwareSettings.downloadPrintService()" style="padding:8px 16px;background:var(--bg-color);border:1.5px solid var(--border-color);border-radius:8px;font-size:12px;font-weight:600;color:var(--text-primary);text-decoration:none;display:inline-flex;align-items:center;gap:5px;">
                            <i class="fas fa-download"></i> Download Service
                        </a>
                    </div>
                </div>`;
        } else if (method === 'bt') {
            area.innerHTML = `
                <div style="padding:14px;background:var(--bg-color);border-radius:10px;font-size:13px;border:1px solid var(--border-color);">
                    <div style="font-weight:600;margin-bottom:8px;"><i class="fab fa-bluetooth-b" style="color:#3b82f6;margin-right:6px;"></i>Bluetooth Printer</div>
                    <div style="color:var(--text-secondary);margin-bottom:12px;">Pair your Bluetooth thermal printer before connecting.</div>
                    <button onclick="HardwareSettings.connectBluetooth('printer')" style="padding:8px 16px;background:var(--primary);color:var(--on-primary);border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
                        <i class="fab fa-bluetooth-b"></i> Pair Printer via Bluetooth
                    </button>
                    <div id="btPrinterResult" style="margin-top:10px;font-size:12px;color:var(--text-secondary);"></div>
                </div>`;
        } else if (method === 'network') {
            const cfg = getPrinterConfig() || {};
            area.innerHTML = `
                <div style="padding:14px;background:var(--bg-color);border-radius:10px;font-size:13px;border:1px solid var(--border-color);">
                    <div style="font-weight:600;margin-bottom:10px;"><i class="fas fa-network-wired" style="color:var(--primary);margin-right:6px;"></i>Network / Local Print Service</div>
                    <div class="form-group" style="margin-bottom:10px;">
                        <label class="form-label">Service IP / Hostname</label>
                        <input id="printerIP" type="text" class="form-input" placeholder="localhost or 192.168.1.x" value="${cfg.ip||'localhost'}">
                    </div>
                    <div class="form-group" style="margin-bottom:10px;">
                        <label class="form-label">Port</label>
                        <input id="printerPort" type="number" class="form-input" placeholder="6789" value="${cfg.port||6789}">
                    </div>
                    <button onclick="HardwareSettings.savePrinterNetwork()" style="padding:8px 16px;background:var(--primary);color:var(--on-primary);border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
                        <i class="fas fa-save"></i> Save &amp; Test
                    </button>
                </div>`;
        } else if (method === 'browser') {
            area.innerHTML = `
                <div style="padding:14px;background:var(--primary-ultra);border:1.5px solid var(--primary-light);border-radius:10px;font-size:13px;">
                    <div style="font-weight:600;margin-bottom:4px;color:var(--primary-dark);"><i class="fas fa-globe" style="margin-right:6px;"></i>Browser Print Dialog</div>
                    <div style="color:var(--text-secondary);">Uses your browser's built-in print dialog. Works on all devices with no setup. The cashier clicks Print in the dialog.</div>
                    <button onclick="HardwareSettings.savePrinterMethod('browser');showToast('Browser print selected','success')" style="margin-top:10px;padding:8px 16px;background:var(--primary);color:var(--on-primary);border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
                        ✓ Use Browser Print
                    </button>
                </div>`;
        }
    }

    async function checkPrintService() {
        const dot  = document.getElementById('printServiceDot');
        const text = document.getElementById('printServiceText');
        if (!dot) return;
        dot.style.background  = '#f59e0b';
        text.textContent = 'Checking print service…';
        try {
            const cfg = getPrinterConfig() || {};
            const ip  = cfg.ip   || 'localhost';
            const port= cfg.port || 6789;
            const r   = await fetch(`http://${ip}:${port}/health`, { signal: AbortSignal.timeout(2500) });
            const ok  = r.ok;
            dot.style.background  = ok ? '#22c55e' : '#ef4444';
            text.textContent = ok
                ? `Print service running on ${ip}:${port} ✓`
                : `Print service not responding on ${ip}:${port}`;
            if (ok) {
                const data = await r.json().catch(() => ({}));
                _showConnectedPrinter(data.printer_name || 'USB Thermal Printer', `${ip}:${port}`);
                document.getElementById('printerStatusBadge').textContent = 'Connected';
                document.getElementById('printerStatusBadge').style.cssText = 'font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;background:#dcfce7;color:#16a34a;';
            }
        } catch {
            if (dot) {
                dot.style.background  = '#ef4444';
                text.textContent = 'Print service not found — make sure HulustockPrinter.exe is running';
            }
        }
    }

    function _showConnectedPrinter(name, detail) {
        const card = document.getElementById('connectedPrinterCard');
        if (!card) return;
        document.getElementById('connectedPrinterName').textContent   = name;
        document.getElementById('connectedPrinterDetail').textContent = detail;
        card.style.display = 'block';
    }

    async function connectBluetooth(target) {
        if (!navigator.bluetooth) {
            showToast('Web Bluetooth not supported on this browser. Use Chrome on Android/Windows.', 'error');
            return;
        }
        try {
            showToast('Opening Bluetooth device picker…', 'info');
            const device = await navigator.bluetooth.requestDevice({
                filters: [
                    { services: ['000018f0-0000-1000-8000-00805f9b34fb'] }, // ESC/POS thermal
                    { namePrefix: 'POS' }, { namePrefix: 'Printer' }, { namePrefix: 'RPP' },
                    { namePrefix: 'MTP' }, { namePrefix: 'Star' }, { namePrefix: 'Epson' },
                ],
                optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb'],
                acceptAllDevices: false,
            });
            const cfg = _load(KEY_PRINTER) || {};
            cfg.method = 'bt';
            cfg.btDeviceId   = device.id;
            cfg.btDeviceName = device.name || 'Bluetooth Printer';
            _save(KEY_PRINTER, cfg);
            _showConnectedPrinter(device.name || 'Bluetooth Printer', 'Bluetooth');
            const result = document.getElementById('btPrinterResult');
            if (result) result.innerHTML = `<span style="color:#16a34a;font-weight:600;">✓ ${device.name || 'Printer'} paired</span>`;
            showToast(`${device.name || 'Printer'} paired via Bluetooth`, 'success');
            document.getElementById('printerStatusBadge').textContent = 'Connected';
        } catch (e) {
            if (e.name !== 'NotFoundError') showToast(`Bluetooth error: ${e.message}`, 'error');
        }
    }

    function savePrinterNetwork() {
        const ip   = document.getElementById('printerIP')?.value?.trim();
        const port = parseInt(document.getElementById('printerPort')?.value) || 6789;
        if (!ip) { showToast('Enter IP address', 'error'); return; }
        _save(KEY_PRINTER, { method: 'network', ip, port });
        checkPrintService();
    }

    function savePrinterMethod(method) {
        _save(KEY_PRINTER, { method });
    }

    function testPrint() {
        ReceiptSystem.setSale(_makeTestSale());
        ReceiptSystem.print('thermal');
    }

    function disconnectPrinter() {
        localStorage.removeItem(KEY_PRINTER);
        document.getElementById('connectedPrinterCard').style.display = 'none';
        document.getElementById('printerStatusBadge').textContent = 'Not configured';
        document.getElementById('printerStatusBadge').style.cssText = 'font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;background:#fef3c7;color:#d97706;';
        showToast('Printer disconnected', 'info');
    }

    // ── Scanner ───────────────────────────────────────────────────────────────
    function getScannerConfig()  { return _load(KEY_SCANNER); }

    function selectScannerType(type) {
        const cfg = _load(KEY_SCANNER) || {};
        cfg.type = type;
        _save(KEY_SCANNER, cfg);
        document.querySelectorAll('#scannerTypeBtns .hw-method-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.stype === type);
        });
        _renderScannerConfig(type);
        // Reconfigure HID listener
        HIDScanner.configure(cfg);
    }

    function _renderScannerConfig(type) {
        const area = document.getElementById('scannerConfigArea');
        if (!area) return;
        const hid  = document.getElementById('hidTestArea');

        if (type === 'camera') {
            area.innerHTML = `
                <div style="padding:12px 14px;background:var(--primary-ultra);border:1.5px solid var(--primary-light);border-radius:10px;font-size:13px;color:var(--primary-dark);">
                    <i class="fas fa-camera" style="margin-right:6px;"></i>
                    Camera scanner active. Use the <strong>Scan</strong> button on the POS page.
                </div>`;
            if (hid) hid.style.display = 'none';
            document.getElementById('connectedScannerCard').style.display = 'block';
            document.getElementById('connectedScannerName').textContent = 'Camera Scanner';
            document.getElementById('connectedScannerDetail').textContent = 'Built-in / webcam';
            document.getElementById('scannerStatusBadge').textContent = 'Camera Active';
            document.getElementById('scannerStatusBadge').style.cssText = 'font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;background:var(--primary-ultra);color:var(--primary-dark);';
        } else if (type === 'hid') {
            area.innerHTML = `
                <div style="padding:12px 14px;background:var(--bg-color);border:1px solid var(--border-color);border-radius:10px;font-size:13px;">
                    <div style="font-weight:600;margin-bottom:6px;"><i class="fas fa-plug" style="color:var(--primary);margin-right:6px;"></i>USB / Bluetooth HID Scanner</div>
                    <div style="color:var(--text-secondary);line-height:1.7;">
                        These scanners act as a keyboard — no driver needed.<br>
                        Just plug in USB or pair via Bluetooth and start scanning on the POS page.<br>
                        The system auto-detects fast keystroke bursts as a scan.
                    </div>
                    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
                        <div style="padding:8px 12px;background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;font-size:11px;font-weight:600;">
                            <i class="fas fa-check" style="color:#22c55e;margin-right:4px;"></i>Honeywell
                        </div>
                        <div style="padding:8px 12px;background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;font-size:11px;font-weight:600;">
                            <i class="fas fa-check" style="color:#22c55e;margin-right:4px;"></i>Zebra
                        </div>
                        <div style="padding:8px 12px;background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;font-size:11px;font-weight:600;">
                            <i class="fas fa-check" style="color:#22c55e;margin-right:4px;"></i>Datalogic
                        </div>
                        <div style="padding:8px 12px;background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;font-size:11px;font-weight:600;">
                            <i class="fas fa-check" style="color:#22c55e;margin-right:4px;"></i>Symbol / Motorola
                        </div>
                    </div>
                </div>`;
            if (hid) hid.style.display = 'block';
            document.getElementById('scannerStatusBadge').textContent = 'HID Active';
            document.getElementById('scannerStatusBadge').style.cssText = 'font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;background:#dcfce7;color:#16a34a;';
        } else if (type === 'both') {
            area.innerHTML = `
                <div style="padding:12px 14px;background:var(--primary-ultra);border:1.5px solid var(--primary-light);border-radius:10px;font-size:13px;color:var(--primary-dark);">
                    <i class="fas fa-layer-group" style="margin-right:6px;"></i>
                    Both camera scanner and USB/Bluetooth HID scanner are active simultaneously.
                </div>`;
            if (hid) hid.style.display = 'block';
            document.getElementById('scannerStatusBadge').textContent = 'Camera + HID';
            document.getElementById('scannerStatusBadge').style.cssText = 'font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;background:#dcfce7;color:#16a34a;';
        }
    }

    function onHidTestKey(e) {
        if (e.key === 'Enter') {
            const input = document.getElementById('hidTestInput');
            const code  = input.value.trim();
            const result = document.getElementById('hidTestResult');
            if (code) {
                result.innerHTML = `<span style="color:var(--primary);font-weight:600;">✓ Detected: ${code}</span> — scanner is working correctly`;
                input.value = '';
            }
        }
    }

    // ── Settings page init ────────────────────────────────────────────────────
    function initSettingsPage() {
        // Restore auto-print toggle
        const ap = isAutoPrint();
        const cb = document.getElementById('autoPrintToggle');
        if (cb) cb.checked = ap;
        _updateToggleUI(ap);

        // Restore printer method
        const pcfg = getPrinterConfig();
        if (pcfg?.method) {
            selectPrinterMethod(pcfg.method);
            if (pcfg.method === 'network' || pcfg.method === 'usb') {
                setTimeout(() => checkPrintService(), 500);
            } else if (pcfg.method === 'bt' && pcfg.btDeviceName) {
                _showConnectedPrinter(pcfg.btDeviceName, 'Bluetooth');
            }
        } else {
            document.getElementById('printServiceText').textContent = 'No printer configured yet';
            document.getElementById('printServiceDot').style.background = '#d1d5db';
        }

        // Restore scanner type
        const scfg = getScannerConfig();
        if (scfg?.type) {
            selectScannerType(scfg.type);
        }
    }

    function _makeTestSale() {
        return {
            invoice_number: 'TEST-001',
            items: [
                { item_name:'Paracetamol 500mg', quantity:2, unit_price:25.00 },
                { item_name:'Vitamin C 1000mg', quantity:1, unit_price:85.00 },
            ],
            subtotal: 135.00, tax_amount: 13.50, discount_amount: 0,
            total_amount: 148.50, cash_paid: 200, bank_paid: 0, mobile_paid: 0,
        };
    }

    function downloadPrintService() {
        showToast('Print service download — see DEPLOYMENT.md for setup instructions', 'info');
    }

    async function autoDetectHardware() {
        // Called when Settings page opens — detect camera and pre-select the right scanner mode
        const hasCamera = await checkCameraAvailable();
        const cfg = getScannerConfig();
        if (!hasCamera && (!cfg || cfg.type === 'camera')) {
            selectScannerType('hid');
            showToast('No camera detected — scanner mode set to USB/Bluetooth', 'info');
        } else if (hasCamera && !cfg) {
            selectScannerType('camera');
        }
        // Update the camera scanner button to show availability
        document.querySelectorAll('#scannerTypeBtns .hw-method-btn').forEach(b => {
            if (b.dataset.stype === 'camera') {
                if (!hasCamera) {
                    b.style.opacity = '0.4';
                    b.title = 'No camera detected on this device';
                    const icon = b.querySelector('i');
                    if (icon) icon.classList.replace('fa-camera', 'fa-camera-slash');
                }
            }
        });
    }

    return {
        getPrinterConfig, isAutoPrint, saveAutoPrint,
        selectPrinterMethod, checkPrintService, connectBluetooth,
        savePrinterNetwork, savePrinterMethod, testPrint, disconnectPrinter,
        getScannerConfig, selectScannerType, onHidTestKey,
        initSettingsPage, downloadPrintService, autoDetectHardware,
    };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// HID (USB/Bluetooth) BARCODE SCANNER CAPTURE
// Detects keyboard-wedge scanners by speed: characters arriving < 50ms apart
// are treated as a scan, not human typing. No driver needed.
// ═══════════════════════════════════════════════════════════════════════════════
const HIDScanner = (() => {
    let _buf      = '';
    let _lastTime = 0;
    let _timer    = null;
    let _active   = false;   // only when POS page is open
    let _paused   = false;   // paused while modal/input focused

    // Characters arriving within this many ms of each other = scanner burst
    const SCAN_SPEED_MS  = 60;
    // Minimum length to treat as a barcode (ignore 1-2 char noise)
    const MIN_LEN = 3;
    // Known scanner prefix characters to strip
    const STRIP_PREFIXES = ['\x02', '\x1d', ']C1', ']E0', ']Q0'];

    function _clean(code) {
        let c = code.trim();
        for (const p of STRIP_PREFIXES) if (c.startsWith(p)) c = c.slice(p.length);
        return c.trim();
    }

    function _flush() {
        const code = _clean(_buf);
        _buf = '';
        if (code.length >= MIN_LEN && _active && !_paused) {
            document.dispatchEvent(new CustomEvent('xpos:hid-barcode', { detail: { code } }));
        }
    }

    function _onKeyDown(e) {
        // Pause if user is typing in a real input (not the hidden capture field)
        const tag = document.activeElement?.tagName;
        if (['INPUT','TEXTAREA','SELECT'].includes(tag) &&
            document.activeElement?.id !== 'hidCaptureField') {
            _paused = true;
            return;
        }
        _paused = false;

        if (e.key === 'Enter') {
            if (_timer) { clearTimeout(_timer); _timer = null; }
            if (_buf.length >= MIN_LEN) _flush();
            else _buf = '';
            return;
        }

        // Ignore modifier-only and control keys
        if (e.key.length > 1 && !['Tab'].includes(e.key)) return;

        const now  = Date.now();
        const gap  = now - _lastTime;
        _lastTime  = now;

        if (gap > 500 && _buf.length > 0) {
            // Too slow — this is human typing, discard buffer
            _buf = '';
        }

        if (e.key !== 'Tab') _buf += e.key;

        if (_timer) clearTimeout(_timer);
        // Auto-flush if no more chars arrive within SCAN_SPEED_MS × 3
        _timer = setTimeout(() => {
            if (_buf.length >= MIN_LEN) _flush();
            else _buf = '';
        }, SCAN_SPEED_MS * 3);
    }

    // Listen on HID barcode events and route to scan handler
    document.addEventListener('xpos:hid-barcode', async (e) => {
        const cfg = HardwareSettings.getScannerConfig();
        if (!cfg || !['hid','both'].includes(cfg.type)) return;
        await _handleScannedCode(e.detail.code, 'pos');
        // Visual feedback on POS page
        const bar = document.getElementById('hidStatusBar');
        if (bar) {
            bar.textContent = `Scanner: ${e.detail.code}`;
            bar.style.opacity = '1';
            setTimeout(() => { bar.style.opacity = '0'; }, 2000);
        }
    });

    return {
        configure(cfg) {
            // Remove old listener then re-add if HID mode
            document.removeEventListener('keydown', _onKeyDown, true);
            if (cfg?.type === 'hid' || cfg?.type === 'both') {
                document.addEventListener('keydown', _onKeyDown, true);
            }
        },
        setActive(val) { _active = val; },
        init() {
            const cfg = HardwareSettings.getScannerConfig();
            if (cfg) this.configure(cfg);
        },
    };
})();



// Categories
async function loadCategories() {
    try {
        const categories = await window.CategoriesAPI.list(_branchParam());
        const tbody = document.getElementById('categoriesTable');
        if (!categories || categories.length === 0) { 
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-500 py-8">No categories added yet. Create your first category to organize items.</td></tr>'; 
            return; 
        }
        tbody.innerHTML = categories.map(c => `
            <tr>
                <td class="font-medium">${c.name}</td>
                <td>${c.description || '-'}</td>
                <td><span class="badge badge-info">${c.item_count || 0}</span></td>
                <td>
                    <button class="text-blue-500 mr-2" onclick="editCategory('${c.id}')"><i class="fas fa-edit"></i></button>
                    <button class="text-red-500" onclick="deleteCategory('${c.id}')"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `).join('');
    } catch (error) { console.error('Failed to load categories:', error); }
}

// Category functions
async function editCategory(categoryId) {
    try {
        const category = await window.CategoriesAPI.get(categoryId);
        openCategoryModal(category);
    } catch (error) {
        showToast('Failed to load category', 'error');
    }
}

async function deleteCategory(categoryId) {
    if (!await xposConfirm('Are you sure you want to delete this category?', 'Delete Category', true)) return;
    try {
        await window.CategoriesAPI.delete(categoryId);
        showToast('Category deleted', 'success');
        loadCategories();
    } catch (error) {
        showToast('Failed to delete category', 'error');
    }
}

function openCategoryModal(category = null) {
    document.getElementById('categoryModalTitle').textContent = category ? 'Edit Category' : 'Add Category';
    document.getElementById('categoryId').value = category?.id || '';
    document.getElementById('categoryName').value = category?.name || '';
    const colorField = document.getElementById('categoryColor');
    if (colorField) colorField.value = category?.color || '#6B7280';
    document.getElementById('categoryDescription').value = category?.description || '';
    // FIX: always stamp the current branch so new categories are branch-scoped
    const branchField = document.getElementById('categoryBranchId');
    if (branchField) branchField.value = category?.branch_id || AppState.branch?.id || '';
    document.getElementById('categoryModal').classList.add('active');
}

async function handleCategorySubmit(e) {
    e.preventDefault();
    const categoryId = document.getElementById('categoryId').value;
    // FIX: read from hidden field (set in openCategoryModal) — falls back to AppState
    const branchIdField = document.getElementById('categoryBranchId');
    const resolvedBranchId = branchIdField?.value || AppState.branch?.id || null;
    const data = {
        name: document.getElementById('categoryName').value,
        description: document.getElementById('categoryDescription').value || null,
        color: document.getElementById('categoryColor')?.value || '#6B7280',
        // organization_id is derived from the authenticated user for security
        branch_id: resolvedBranchId
    };
    
    try {
        if (categoryId) {
            await window.CategoriesAPI.update(categoryId, data);
            showToast('Category updated', 'success');
        } else {
            await window.CategoriesAPI.create(data);
            showToast('Category created', 'success');
        }
        closeModal('categoryModal');
        loadCategories();
    } catch (error) {
        showToast(error.message || 'Failed to save category', 'error');
    }
}

// Branches - Admin only
async function loadBranches() {
    // Check if user is admin
    if (AppState.currentUser?.role !== 'admin') {
        const tbody = document.getElementById('branchesTable');
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-red-500">You do not have permission to view branches. Only administrators can manage branches.</td></tr>';
        document.getElementById('addBranchBtn')?.classList.add('hidden');
        return;
    }

    try {
        // active_only=false: admin management page shows ALL branches including inactive
        const branches = await window.BranchesAPI.list({ active_only: false });
        const tbody = document.getElementById('branchesTable');
        if (!branches?.length) { tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-500">No branches</td></tr>'; return; }
        tbody.innerHTML = branches.map(b => `
            <tr>
                <td class="font-medium">${b.name}</td>
                <td>${b.location || '-'}</td>
                <td>${b.phone || '-'}</td>
                <td>${b.email || '-'}</td>
                <td><span class="badge ${b.is_active ? 'badge-success' : 'badge-gray'}">${b.is_active ? 'Active' : 'Inactive'}</span></td>
                <td>
                    <button class="text-blue-500 mr-2" onclick="editBranch('${b.id}')"><i class="fas fa-edit"></i></button>
                    <button class="text-orange-500 mr-2" title="${b.is_active ? 'Deactivate' : 'Reactivate'}" onclick="toggleBranchActive('${b.id}', ${b.is_active !== false})">
                        <i class="fas ${b.is_active !== false ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (error) { 
        console.error('Failed to load branches:', error);
        showToast('Failed to load branches: ' + (error.message || 'Unknown error'), 'error');
    }
}

async function editBranch(branchId) {
    try {
        const branch = await window.BranchesAPI.get(branchId);
        openBranchModal(branch);
    } catch (error) {
        showToast('Failed to load branch', 'error');
    }
}

async function toggleBranchActive(branchId, currentlyActive) {
    const action = currentlyActive ? 'Deactivate' : 'Reactivate';
    if (!await xposConfirm(`${action} this branch?`, 'Branch', true)) return;
    try {
        await window.BranchesAPI.update(branchId, { is_active: !currentlyActive });
        showToast(`Branch ${action.toLowerCase()}d`, 'success');
        loadBranches();
        // Reload branch selector so deactivated branches disappear
        await loadBranchesForSelect('branchSelector', AppState.branch?.id, 'All Branches');
    } catch (error) {
        showToast(error.message || 'Failed to update branch', 'error');
    }
}

function openBranchModal(branch = null) {
    document.getElementById('branchModalTitle').textContent = branch ? 'Edit Branch' : 'Add Branch';
    document.getElementById('branchId').value = branch?.id || '';
    document.getElementById('branchName').value = branch?.name || '';
    document.getElementById('branchLocation').value = branch?.location || '';
    document.getElementById('branchPhone').value = branch?.phone || '';
    document.getElementById('branchEmail').value = branch?.email || '';
    document.getElementById('branchStatus').value = branch?.is_active !== false ? 'true' : 'false';
    document.getElementById('branchModal').classList.add('active');
}

async function handleBranchSubmit(e) {
    e.preventDefault();
    const branchId = document.getElementById('branchId').value;
    const data = {
        name: document.getElementById('branchName').value,
        location: document.getElementById('branchLocation').value || null,
        phone: document.getElementById('branchPhone').value || null,
        email: document.getElementById('branchEmail').value || null,
        is_active: document.getElementById('branchStatus').value === 'true',
        organization_id: AppState.organization?.id
    };
    
    try {
        if (branchId) {
            await window.BranchesAPI.update(branchId, data);
            showToast('Branch updated', 'success');
        } else {
            await window.BranchesAPI.create(data);
            showToast('Branch created', 'success');
        }
        closeModal('branchModal');
        loadBranches();
        loadBranchesForSelect();
    } catch (error) {
        showToast(error.message || 'Failed to save branch', 'error');
    }
}

// Suppliers
async function loadSuppliers() {
    try {
        // Update the branch scope badge in the header
        const badge = document.getElementById('suppliersBranchBadge');
        const badgeName = document.getElementById('suppliersBranchName');
        if (badge && badgeName) {
            if (AppState.branch?.id) {
                badge.style.display = 'inline-flex';
                badgeName.textContent = AppState.branch.name || 'Current Branch';
            } else {
                badge.style.display = 'none';
            }
        }
        const suppliers = await window.SuppliersAPI.list(_branchParam());
        const tbody = document.getElementById('suppliersTable');
        if (!suppliers?.length) { tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-500">No suppliers</td></tr>'; return; }
        tbody.innerHTML = suppliers.map(s => `
            <tr>
                <td class="font-medium">${s.name}</td>
                <td>${s.phone || '-'}</td>
                <td>${s.email || '-'}</td>
                <td>${s.address || '-'}</td>
                <td>
                    <button class="text-blue-500 mr-2" onclick="editSupplier('${s.id}')"><i class="fas fa-edit"></i></button>
                    <button class="text-red-500" onclick="deleteSupplier('${s.id}')"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `).join('');
    } catch (error) { console.error('Failed to load suppliers:', error); }
}

// Supplier functions
async function editSupplier(supplierId) {
    try {
        const supplier = await window.SuppliersAPI.get(supplierId);
        openSupplierModal(supplier);
    } catch (error) {
        showToast('Failed to load supplier', 'error');
    }
}

async function deleteSupplier(supplierId) {
    if (!await xposConfirm('Are you sure you want to delete this supplier?', 'Delete Supplier', true)) return;
    try {
        await window.SuppliersAPI.delete(supplierId);
        showToast('Supplier deleted', 'success');
        loadSuppliers();
    } catch (error) {
        showToast('Failed to delete supplier', 'error');
    }
}

function openSupplierModal(supplier = null) {
    document.getElementById('supplierModalTitle').textContent = supplier ? 'Edit Supplier' : 'Add Supplier';
    document.getElementById('supplierId').value = supplier?.id || '';
    document.getElementById('supplierName').value = supplier?.name || '';
    document.getElementById('supplierPhone').value = supplier?.phone || '';
    document.getElementById('supplierEmail').value = supplier?.email || '';
    document.getElementById('supplierAddress').value = supplier?.address || '';
    const cpField = document.getElementById('supplierContactPerson');
    if (cpField) cpField.value = supplier?.contact_person || '';
    document.getElementById('supplierModal').classList.add('active');
}

async function handleSupplierSubmit(e) {
    e.preventDefault();
    const supplierId = document.getElementById('supplierId').value;
    const data = {
        name: document.getElementById('supplierName').value,
        phone: document.getElementById('supplierPhone').value || null,
        email: document.getElementById('supplierEmail').value || null,
        address: document.getElementById('supplierAddress').value || null,
        contact_person: document.getElementById('supplierContactPerson')?.value || null,
        branch_id: AppState.branch?.id || null,  // scope to current branch; null = org-wide
        // organization_id is derived from the authenticated user for security
    };
    
    try {
        if (supplierId) {
            await window.SuppliersAPI.update(supplierId, data);
            showToast('Supplier updated', 'success');
        } else {
            await window.SuppliersAPI.create(data);
            showToast('Supplier created', 'success');
        }
        closeModal('supplierModal');
        document.getElementById('supplierForm').reset();
        document.getElementById('supplierId').value = '';
        loadSuppliers();
    } catch (error) {
        showToast(error.message || 'Failed to save supplier', 'error');
    }
}

// ==================== USER FUNCTIONS ====================
function openUserModal(user = null) {
    document.getElementById('userModalTitle').textContent = user ? 'Edit User' : 'Add User';
    // Show/hide is_active toggle only on edit
    const activeRow = document.getElementById('userActiveRow');
    if (activeRow) activeRow.style.display = user ? 'block' : 'none';
    if (user && document.getElementById('userIsActive')) {
        document.getElementById('userIsActive').checked = user.is_active !== false;
    }
    document.getElementById('userId').value = user?.id || '';
    document.getElementById('userFullName').value = user?.full_name || '';
    document.getElementById('userEmail').value = user?.email || '';
    document.getElementById('userPhone').value = user?.phone || '';
    document.getElementById('userRole').value = user?.role || '';
    document.getElementById('userPassword').value = '';
    
    // Show/hide password field
    document.getElementById('passwordGroup').style.display = user ? 'none' : 'block';
    document.getElementById('userPassword').required = !user;
    
    // Load branches
    loadBranchesForSelect('userBranch', user?.branch_id);
    
    document.getElementById('userModal').classList.add('active');
}

async function handleUserSubmit(e) {
    e.preventDefault();
    const userId = document.getElementById('userId').value;
    const data = {
        full_name: document.getElementById('userFullName').value,
        email: document.getElementById('userEmail').value,
        phone: document.getElementById('userPhone').value || null,
        role: document.getElementById('userRole').value,
        branch_id: document.getElementById('userBranch').value || null
        // organization_id is derived from the authenticated user for security
    };
    // Include is_active toggle on edit
    if (userId) {
        const activeToggle = document.getElementById('userIsActive');
        if (activeToggle) data.is_active = activeToggle.checked;
    }
    
    const password = document.getElementById('userPassword').value;
    if (password) {
        data.password = password;
    }
    
    try {
        if (userId) {
            await window.UsersAPI.update(userId, data);
            showToast('User updated', 'success');
        } else {
            await window.UsersAPI.create(data);
            showToast('User created', 'success');
        }
        closeModal('userModal');
        document.getElementById('userForm').reset();
        document.getElementById('userId').value = '';
        loadUsers();
    } catch (error) {
        console.error('User creation error:', error);
        // Display error message properly
        let errorMessage = 'Failed to save user';
        
        // Try to parse error response
        if (error.message && typeof error.message === 'string') {
            // Check if it's a validation error
            if (error.message.includes('422') || error.message.includes('validation')) {
                errorMessage = 'Invalid data. Please check all fields and try again.';
            } else if (error.message.includes('400') || error.message.includes('exists') || error.message.includes('already')) {
                errorMessage = 'A user with this email already exists.';
            } else {
                errorMessage = error.message;
            }
        } else if (error.response && error.response.data) {
            // Try to get error from response data
            const data = error.response.data;
            if (data.detail) {
                if (typeof data.detail === 'string') {
                    errorMessage = data.detail;
                } else if (Array.isArray(data.detail)) {
                    errorMessage = data.detail.map(d => d.msg || JSON.stringify(d)).join(', ');
                } else if (data.detail.msg) {
                    errorMessage = data.detail.msg;
                }
            } else if (data.message) {
                errorMessage = data.message;
            }
        }
        
        showToast(errorMessage, 'error');
    }
}

// ==================== BANK TRANSFER FUNCTIONS ====================
async function submitTransfer() {
    const type    = document.getElementById('transferType')?.value;
    const acctId  = document.getElementById('transferBankAccount')?.value;
    const amount  = parseFloat(document.getElementById('transferAmount')?.value);
    const notes   = document.getElementById('transferNotes')?.value || '';
    if (!acctId) { showToast('Please select a bank account', 'error'); return; }
    if (!amount || amount <= 0) { showToast('Please enter a valid amount', 'error'); return; }
    try {
        await window.BankAPI.transfer({
            type, bank_account_id: acctId, amount, notes,
            branch_id: AppState.branch?.id
        });
        showToast('Transfer completed successfully', 'success');
        document.getElementById('transferAmount').value = '';
        document.getElementById('transferNotes').value = '';
        loadBankAccounts();
    } catch (err) { showToast(err.message || 'Transfer failed', 'error'); }
}


// ══ Populate bank accounts dropdown in transfer form ══
function _populateTransferAccounts(accounts) {
    const sel = document.getElementById('transferBankAccount');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select account…</option>' +
        accounts.map(a => `<option value="${esc(a.id)}">${esc(a.account_name)} — ${formatCurrency(a.balance)}</option>`).join('');
}

// ==================== EXPENSE FUNCTIONS ====================
function openExpenseModal(expense = null) {
    document.getElementById('expenseModalTitle').textContent = expense ? 'Edit Expense' : 'Add Expense';
    document.getElementById('expenseId').value = expense?.id || '';
    document.getElementById('expenseTitle').value = expense?.title || '';
    document.getElementById('expenseAmount').value = expense?.amount || '';
    document.getElementById('expenseType').value = expense?.expense_type || '';
    document.getElementById('expenseDescription').value = expense?.description || '';
    // Set date — default to today for new expenses
    const dateField = document.getElementById('expenseDate');
    if (dateField) {
        dateField.value = expense?.expense_date || new Date().toISOString().slice(0, 10);
    }
    document.getElementById('expenseModal').classList.add('active');
}

async function handleExpenseSubmit(e) {
    e.preventDefault();
    const expenseId = document.getElementById('expenseId').value;
    const expDateVal = document.getElementById('expenseDate')?.value;
    const data = {
        title: document.getElementById('expenseTitle').value,
        amount: parseFloat(document.getElementById('expenseAmount').value),
        expense_type: document.getElementById('expenseType').value,
        description: document.getElementById('expenseDescription').value || null,
        expense_date: expDateVal || new Date().toISOString().slice(0, 10),
        organization_id: AppState.organization?.id,
        branch_id: AppState.branch?.id,
        created_by: AppState.currentUser?.id
    };
    
    try {
        if (expenseId) {
            await window.ExpensesAPI.update(expenseId, data);
            showToast('Expense updated', 'success');
        } else {
            await window.ExpensesAPI.create(data);
            showToast('Expense created', 'success');
        }
        closeModal('expenseModal');
        document.getElementById('expenseForm').reset();
        document.getElementById('expenseId').value = '';
        loadExpenses();
    } catch (error) {
        showToast(error.message || 'Failed to save expense', 'error');
    }
}

// ==================== BANK ACCOUNT FUNCTIONS ====================
function openBankModal(account = null) {
    // Determine type from existing account OR current active tab
    const acctType = account?.account_type || AppState.bankTab || 'bank';
    const isMobile = (acctType === 'mobile_money');
    const typeLabel = isMobile ? 'Mobile Money Provider' : 'Bank Account';

    document.getElementById('bankModalTitle').textContent  = account ? `Edit ${typeLabel}` : `Add ${typeLabel}`;
    document.getElementById('bankId').value                = account?.id || '';
    document.getElementById('bankAccountType').value       = acctType;
    document.getElementById('bankAccountName').value       = account?.account_name || '';
    document.getElementById('bankAccountNumber').value     = account?.account_number || '';
    document.getElementById('bankName').value              = account?.bank_name || '';
    document.getElementById('bankBalance').value           = account?.balance ?? 0;

    // Adjust labels based on type
    const nameLabel   = document.getElementById('bankAccountNameLabel');
    const numLabel    = document.getElementById('bankAccountNumberLabel');
    const bankLabel   = document.getElementById('bankNameLabel');
    if (nameLabel)  nameLabel.textContent  = isMobile ? 'Provider Account Name *' : 'Account Name *';
    if (numLabel)   numLabel.textContent   = isMobile ? 'Phone / Wallet Number'   : 'Account Number';
    if (bankLabel)  bankLabel.textContent  = isMobile ? 'Mobile Money Provider'   : 'Bank Name';

    document.getElementById('bankModal').classList.add('active');
}

async function handleBankSubmit(e) {
    e.preventDefault();
    const bankId    = document.getElementById('bankId').value;
    const acctType  = document.getElementById('bankAccountType').value || 'bank';
    const isMobile  = (acctType === 'mobile_money');
    const data = {
        account_name:   document.getElementById('bankAccountName').value,
        account_number: document.getElementById('bankAccountNumber').value || null,
        bank_name:      document.getElementById('bankName').value || null,
        balance:        parseFloat(document.getElementById('bankBalance').value) || 0,
        account_type:   acctType,
        branch_id:      AppState.branch?.id
    };

    try {
        if (bankId) {
            await window.BankAPI.update(bankId, data);
            showToast(`${isMobile ? 'Mobile money provider' : 'Bank account'} updated`, 'success');
        } else {
            await window.BankAPI.create(data);
            showToast(`${isMobile ? 'Mobile money provider' : 'Bank account'} created`, 'success');
        }
        closeModal('bankModal');
        document.getElementById('bankForm').reset();
        document.getElementById('bankId').value = '';
        loadBankAccounts();
    } catch (error) {
        showToast(error.message || 'Failed to save', 'error');
    }
}

// ==================== NOTIFICATION FUNCTIONS ====================
// Helper: render a single notification row in the header dropdown
function _renderDropdownNotif(n) {
    const typeIcons  = { new_sale:'fa-shopping-cart', low_stock:'fa-box-open', expiring_items:'fa-clock', system_alert:'fa-bell' };
    const typeColors = { new_sale:'#22c55e', low_stock:'#f59e0b', expiring_items:'#ef4444', system_alert:'var(--primary)' };
    const icon  = typeIcons[n.notification_type]  || 'fa-bell';
    const color = typeColors[n.notification_type] || 'var(--primary)';

    // Extract [Branch] prefix from title
    let title = n.title || '';
    let branchHtml = '';
    const bm = title.match(/^\[(.*?)\]\s*/);
    if (bm) {
        title = title.replace(bm[0], '').trim();
        branchHtml = '<span style="display:inline-flex;align-items:center;gap:3px;background:#e0f2fe;color:#0369a1;font-size:9px;font-weight:700;padding:1px 5px;border-radius:99px;margin-left:4px;vertical-align:middle;border:1px solid #bae6fd;">'
            + '<i class="fas fa-code-branch" style="font-size:8px"></i>' + bm[1] + '</span>';
    }

    const bg      = n.is_read ? 'var(--surface)' : 'var(--primary-ultra)';
    const hoverBg = 'var(--bg)';
    const link    = (n.link || '').replace(/'/g, '');
    const itemId  = n.id;

    return '<div onclick="handleNotificationClick(\'' + itemId + '\',\'' + link + '\')"'
        + ' style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);'
        + 'background:' + bg + ';cursor:pointer;transition:background .15s;"'
        + ' onmouseover="this.style.background=\'' + hoverBg + '\'"'
        + ' onmouseout="this.style.background=\'' + bg + '\'">'
        + '<div style="width:30px;height:30px;border-radius:8px;flex-shrink:0;background:' + (n.is_read ? 'var(--bg)' : 'white') + ';'
        + 'display:flex;align-items:center;justify-content:center;border:1px solid var(--border);">'
        + '<i class="fas ' + icon + '" style="color:' + color + ';font-size:12px"></i>'
        + '</div>'
        + '<div style="flex:1;min-width:0;">'
        + '<div style="font-size:12px;font-weight:600;color:var(--text-1);display:flex;align-items:center;flex-wrap:wrap;gap:2px;margin-bottom:2px;">'
        + title + branchHtml
        + '</div>'
        + '<div style="font-size:11px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (n.message || '') + '</div>'
        + '<div style="font-size:10px;color:var(--text-3);margin-top:2px">' + formatTimeAgo(n.created_at) + '</div>'
        + '</div>'
        + (!n.is_read ? '<div style="width:7px;height:7px;border-radius:50%;background:var(--primary);flex-shrink:0;margin-top:4px"></div>' : '')
        + '</div>';
}

async function toggleNotifications() {
    // Navigate to notifications page
    navigateTo('notifications');
}

function displayNotificationPanel(notifications) {
    // Create or get notification panel
    let panel = document.getElementById('notificationPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'notificationPanel';
        panel.className = 'notification-panel';
        document.body.appendChild(panel);
    }
    
    if (!notifications || notifications.length === 0) {
        panel.innerHTML = `
            <div class="p-4 text-center text-gray-500">
                <i class="fas fa-bell-slash text-4xl mb-2"></i>
                <p>No notifications</p>
            </div>
        `;
    } else {
        panel.innerHTML = `
            <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--bg);border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
                <span style="font-weight:700;font-size:14px;color:var(--text-1)">Notifications</span>
                <button onclick="markAllNotificationsAsRead()" style="font-size:11px;font-weight:600;color:var(--primary);background:none;border:none;cursor:pointer;padding:0;">Mark all read</button>
            </div>
            <div style="max-height:380px;overflow-y:auto;">
                ${notifications.slice(0,10).map(n => _renderDropdownNotif(n)).join('')}
            </div>
            <div style="padding:10px 14px;border-top:1px solid var(--border);text-align:center;">
                <button onclick="navigateTo('notifications');document.getElementById('notificationPanel').classList.add('hidden')" style="font-size:12px;font-weight:600;color:var(--primary);background:none;border:none;cursor:pointer">View all notifications →</button>
            </div>
                `;
    }
    
    // Show panel (toggle)
    panel.classList.toggle('hidden');
}

function getNotificationIcon(type) {
    const icons = {
        'low_stock': 'fa-exclamation-triangle text-yellow-500',
        'expiring_items': 'fa-clock text-orange-500',
        'new_sale': 'fa-shopping-cart text-green-500',
        'system_alert': 'fa-info-circle text-blue-500'
    };
    return icons[type] || 'fa-bell text-gray-500';
}

function getNotificationColor(type) {
    const colors = {
        'low_stock': 'text-yellow-500',
        'expiring_items': 'text-orange-500',
        'new_sale': 'text-green-500',
        'system_alert': 'text-blue-500'
    };
    return colors[type] || 'text-gray-500';
}

const _readPending = new Set(); // guard against duplicate markAsRead calls
async function handleNotificationClick(notificationId, link) {
    // Prevent firing multiple times for the same notification
    if (_readPending.has(notificationId)) return;
    _readPending.add(notificationId);
    try {
        const n = _allNotifications.find(x => x.id === notificationId);
        if (n && !n.is_read) {
            await window.NotificationsAPI.markAsRead(notificationId);
            n.is_read = true;
            const unreadCount = _allNotifications.filter(x => !x.is_read).length;
            const subtitle = document.getElementById('notifSubtitle');
            if (subtitle) subtitle.textContent = unreadCount > 0
                ? `${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}`
                : 'All caught up';
            updateNotificationBadgeFromAPI();
        }
        if (link) navigateTo(link.replace('/', ''));
    } catch (error) {
        console.error('Failed to mark notification as read:', error);
    } finally {
        _readPending.delete(notificationId);
    }
}

async function markAllNotificationsAsRead() {
    try {
        await window.NotificationsAPI.markAllAsRead();
        updateNotificationBadgeFromAPI();
        showToast('All notifications marked as read', 'success');
        // Refresh the full-page notification list if visible
        _allNotifications = [];
        await _renderNotifications('all');
        // Reset filter tabs to "All"
        filterNotifications('all', null);
    } catch (error) {
        console.error('Failed to mark all as read:', error);
        showToast('Failed to mark as read', 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROFESSIONAL NOTIFICATION SYSTEM
// Architecture:
//   1. Supabase Realtime → instant in-app updates (websocket)
//   2. Web Push (VAPID)  → real device notifications when app is background/closed
//   3. Polling fallback  → if Realtime fails, poll every 30s
// UX: Non-intrusive toast banners, no repeated alerts, deduped by tag
// ═══════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
let _notifChannel     = null;  // Supabase Realtime — notifications
let _salesChannel     = null;  // Supabase Realtime — sales (stock + dashboard)
let _itemsChannel     = null;  // Supabase Realtime — items/stock
let _categoriesChannel= null;  // Supabase Realtime — categories
let _suppliersChannel = null;  // Supabase Realtime — suppliers
let _expensesChannel  = null;  // Supabase Realtime — expenses
let _bankChannel      = null;  // Supabase Realtime — bank_accounts
let _branchesChannel  = null;  // Supabase Realtime — branches
let _usersChannel     = null;  // Supabase Realtime — users
let _supabaseCli      = null;  // Supabase JS client (shared)
let _pollInterval     = null;  // Fallback poll timer
let _lastNotifTime    = null;  // Skip old notifications on page load
let _shownTags        = new Set(); // Dedup: don't show same tag twice in session
let _realtimeBadge    = null;  // Connection status indicator element
let _swRegistration   = null;  // ServiceWorker registration
let _pushSubscription = null;  // Current push subscription

const POLL_INTERVAL_MS   = 30000;  // 30s fallback
const TOAST_DURATION_MS  = 5000;   // auto-dismiss in-app toast

// ── Service Worker + Web Push setup ──────────────────────────────────────────
async function initPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log('[Push] Not supported on this browser');
        return;
    }
    try {
        // Register service worker
        // Derive SW path from current origin so it works on any hosting subdirectory
        const _swPath = new URL('/sw.js', window.location.origin).pathname;
        _swRegistration = await navigator.serviceWorker.register(_swPath, { scope: '/' });
        await navigator.serviceWorker.ready;
        console.log('[Push] SW registered at', _swPath, '— ready');

        // Listen for subscription rotation messages from SW
        navigator.serviceWorker.addEventListener('message', e => {
            if (e.data?.type === 'PUSH_SUBSCRIPTION_CHANGED') resubscribePush();
        });

        // Only request permission if not already decided
        const perm = Notification.permission;
        if (perm === 'denied') {
            console.log('[Push] Permission denied by user');
            return;
        }
        if (perm !== 'granted') {
            const result = await Notification.requestPermission();
            if (result !== 'granted') {
                console.log('[Push] Permission not granted');
                return;
            }
        }

        await _subscribeToPush();
    } catch (e) {
        console.warn('[Push] SW setup failed:', e);
    }
}

async function _subscribeToPush() {
    try {
        // Use the correct token key (AUTH_TOKEN, not TOKEN)
        const _getToken = () =>
            localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');

        // Fetch VAPID public key from backend
        const resp = await fetch(`${window.AppConfig?.API_BASE_URL || '/api'}/push/vapid-public-key`, {
            headers: { 'Authorization': `Bearer ${_getToken()}` }
        });
        if (!resp.ok) {
            console.warn('[Push] VAPID key fetch failed:', resp.status, '— push disabled');
            return;
        }
        const { publicKey } = await resp.json();
        if (!publicKey) { console.warn('[Push] No VAPID public key returned'); return; }

        // Always unsubscribe first then resubscribe with current VAPID key
        // This ensures a new VAPID key is always applied correctly
        const existing = await _swRegistration.pushManager.getSubscription();
        if (existing) {
            // Check if key matches — if not, unsubscribe and resubscribe
            try {
                const existingKey = existing.options?.applicationServerKey;
                const newKey = _urlBase64ToUint8Array(publicKey);
                const existingB64 = existingKey
                    ? btoa(String.fromCharCode(...new Uint8Array(existingKey)))
                    : '';
                const newB64 = btoa(String.fromCharCode(...newKey));
                if (existingB64 !== newB64) {
                    console.log('[Push] VAPID key changed — resubscribing');
                    await existing.unsubscribe();
                    _pushSubscription = await _swRegistration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: newKey,
                    });
                } else {
                    _pushSubscription = existing;
                }
            } catch (_) {
                _pushSubscription = existing;
            }
        } else {
            _pushSubscription = await _swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: _urlBase64ToUint8Array(publicKey),
            });
        }

        // Save / refresh subscription on backend
        const saveResp = await fetch(`${window.AppConfig?.API_BASE_URL || '/api'}/push/subscribe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${_getToken()}`,
            },
            body: JSON.stringify({
                subscription: _pushSubscription.toJSON(),
                user_agent: navigator.userAgent,
            }),
        });
        if (saveResp.ok) {
            console.log('[Push] ✅ Web Push subscription saved');
        } else {
            console.warn('[Push] Subscription save failed:', saveResp.status);
        }
    } catch (e) {
        console.warn('[Push] Subscribe failed:', e);
    }
}

async function resubscribePush() {
    _pushSubscription = null;
    await _subscribeToPush();
}

// VAPID key conversion helper
function _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// ── Supabase Realtime ──────────────────────────────────────────────────────────
function _initRealtime() {
    try {
        if (typeof supabase === 'undefined') {
            console.warn('[Realtime] Supabase SDK missing — using polling');
            return false;
        }
        const url = window.AppConfig?.SUPABASE_URL;
        const key = window.AppConfig?.SUPABASE_KEY;
        if (!url || url.includes('your-project') || !key || key.includes('your-supabase')) {
            console.warn('[Realtime] Supabase not configured — using polling');
            return false;
        }

        _supabaseCli = supabase.createClient(url, key);

        const userData = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.USER_DATA || 'rf_user_data');
        let orgId = null, userId = null;
        if (userData) {
            try { const u = JSON.parse(userData); orgId = u.organization_id; userId = u.id; } catch {}
        }
        if (!orgId) return false;

        _lastNotifTime = new Date().toISOString();

        // ── Channel 1: Notifications ────────────────────────────────────
        _notifChannel = _supabaseCli
            .channel(`notif:${orgId}`)
            .on('postgres_changes', {
                event: 'INSERT', schema: 'public', table: 'notifications',
                filter: `organization_id=eq.${orgId}`,
            }, payload => _onNewNotification(payload.new, userId))
            .on('postgres_changes', {
                event: 'UPDATE', schema: 'public', table: 'notifications',
                filter: `organization_id=eq.${orgId}`,
            }, () => updateNotificationBadgeFromAPI())
            .subscribe(status => {
                if (status === 'SUBSCRIBED') {
                    console.log('[Realtime] ✅ Notifications channel connected');
                    if (_pollInterval)     { clearInterval(_pollInterval);     _pollInterval     = null; }
    if (_pollPageInterval) { clearInterval(_pollPageInterval); _pollPageInterval = null; }
                    _showRealtimeBadge(true);
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    console.warn(`[Realtime] Notifications ${status} — enabling poll fallback`);
                    _showRealtimeBadge(false);
                    _startPollFallback();
                }
            });

        // ── Channel 2: Sales — triggers dashboard + stock refresh ───────────
        _salesChannel = _supabaseCli
            .channel(`sales:${orgId}`)
            .on('postgres_changes', {
                event: 'INSERT', schema: 'public', table: 'sales',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] New sale:', payload.new?.invoice_number);
                _onRealtimeSale(payload.new);
            })
            .on('postgres_changes', {
                event: 'UPDATE', schema: 'public', table: 'sales',
                filter: `organization_id=eq.${orgId}`,
            }, () => {
                // Return/refund updated — refresh sales page if open
                if (AppState.currentPage === 'sales') loadSales();
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED')
                    console.log('[Realtime] ✅ Sales channel connected');
            });

        // ── Channel 3: Items/Stock — triggers items + POS refresh ───────────
        _itemsChannel = _supabaseCli
            .channel(`items:${orgId}`)
            .on('postgres_changes', {
                event: 'UPDATE', schema: 'public', table: 'items',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] Item updated:', payload.new?.name);
                _onRealtimeItemUpdate(payload.new);
            })
            .on('postgres_changes', {
                event: 'INSERT', schema: 'public', table: 'items',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] Item added:', payload.new?.name);
                if (AppState.currentPage === 'items') loadItems();
                if (AppState.currentPage === 'pos')   loadPOSItems();
            })
            .on('postgres_changes', {
                event: 'DELETE', schema: 'public', table: 'items',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] Item deleted:', payload.old?.id);
                // Remove from AppState in-memory
                if (AppState.items) {
                    AppState.items = AppState.items.filter(i => i.id !== payload.old?.id);
                }
                if (AppState.currentPage === 'items') renderItemsTable(AppState.items || []);
                if (AppState.currentPage === 'pos')   loadPOSItems();
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED')
                    console.log('[Realtime] ✅ Items channel connected');
            });

        // ── Channel 4: Categories ─────────────────────────────────────────
        _categoriesChannel = _supabaseCli
            .channel(`categories:${orgId}`)
            .on('postgres_changes', {
                event: '*', schema: 'public', table: 'categories',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] Category changed:', payload.eventType);
                _onRealtimeTableChange('categories', payload);
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED')
                    console.log('[Realtime] ✅ Categories channel connected');
            });

        // ── Channel 5: Suppliers ──────────────────────────────────────────
        _suppliersChannel = _supabaseCli
            .channel(`suppliers:${orgId}`)
            .on('postgres_changes', {
                event: '*', schema: 'public', table: 'suppliers',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] Supplier changed:', payload.eventType);
                _onRealtimeTableChange('suppliers', payload);
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED')
                    console.log('[Realtime] ✅ Suppliers channel connected');
            });

        // ── Channel 6: Expenses ───────────────────────────────────────────
        _expensesChannel = _supabaseCli
            .channel(`expenses:${orgId}`)
            .on('postgres_changes', {
                event: '*', schema: 'public', table: 'expenses',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] Expense changed:', payload.eventType);
                _onRealtimeTableChange('expenses', payload);
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED')
                    console.log('[Realtime] ✅ Expenses channel connected');
            });

        // ── Channel 7: Bank accounts ──────────────────────────────────────
        _bankChannel = _supabaseCli
            .channel(`bank:${orgId}`)
            .on('postgres_changes', {
                event: '*', schema: 'public', table: 'bank_accounts',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] Bank account changed:', payload.eventType);
                _onRealtimeTableChange('bank', payload);
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED')
                    console.log('[Realtime] ✅ Bank channel connected');
            });

        // ── Channel 8: Branches ───────────────────────────────────────────
        _branchesChannel = _supabaseCli
            .channel(`branches:${orgId}`)
            .on('postgres_changes', {
                event: '*', schema: 'public', table: 'branches',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] Branch changed:', payload.eventType);
                _onRealtimeTableChange('branches', payload);
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED')
                    console.log('[Realtime] ✅ Branches channel connected');
            });

        // ── Channel 9: Users ──────────────────────────────────────────────
        _usersChannel = _supabaseCli
            .channel(`users:${orgId}`)
            .on('postgres_changes', {
                event: '*', schema: 'public', table: 'users',
                filter: `organization_id=eq.${orgId}`,
            }, payload => {
                console.log('[Realtime] User changed:', payload.eventType);
                _onRealtimeTableChange('users', payload);
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED')
                    console.log('[Realtime] ✅ Users channel connected');
            });

        return true;
    } catch (e) {
        console.error('[Realtime] Init error:', e);
        return false;
    }
}

// _startPollFallback moved above cleanupRealtimeNotifications

// ── New notification handler ──────────────────────────────────────────────────
function _onNewNotification(notif, currentUserId) {
    // Skip old notifications (page reload case)
    if (_lastNotifTime && notif.created_at && new Date(notif.created_at) <= new Date(_lastNotifTime)) return;

    // Skip if targeted to a different user
    if (notif.user_id && notif.user_id !== currentUserId) return;

    // Update bell badge
    updateNotificationBadgeFromAPI();

    // Show in-app banner
    _showNotifBanner(notif);

    // Reload notifications page if open
    if (AppState.currentPage === 'notifications') loadNotifications();
}

// ── Professional in-app notification banner ───────────────────────────────────
function _showNotifBanner(notif) {
    const type = notif.notification_type || 'info';
    const tag  = notif.id || type;

    if (_shownTags.has(tag)) return;
    _shownTags.add(tag);
    setTimeout(() => _shownTags.delete(tag), 10000);

    const config = {
        new_sale:       { icon:'💰', color:'#22c55e', label:'Sale'   },
        low_stock:      { icon:'📦', color:'#f59e0b', label:'Stock'  },
        expiring_soon:  { icon:'⏰', color:'#ef4444', label:'Expiry' },
        expiring_items: { icon:'⏰', color:'#ef4444', label:'Expiry' },
        info:           { icon:'ℹ️',  color:'var(--primary)', label:'Info' },
        warning:        { icon:'⚠️',  color:'#f59e0b', label:'Warning' },
        error:          { icon:'🚨', color:'#ef4444', label:'Alert'  },
        system_alert:   { icon:'🔔', color:'var(--primary)', label:'System' },
    };
    const c = config[type] || config.info;

    // Extract [BranchName] prefix from title if present
    let displayTitle = notif.title || c.label;
    let branchBadgeHtml = '';
    const branchMatch = displayTitle.match(/^\[(.*?)\]\s*/);
    if (branchMatch) {
        const branchLabel = branchMatch[1];
        displayTitle = displayTitle.replace(branchMatch[0], '').trim();
        branchBadgeHtml = `<span style="
            display:inline-flex;align-items:center;gap:3px;
            background:#e0f2fe;color:#0369a1;
            font-size:10px;font-weight:700;
            padding:1px 7px;border-radius:99px;
            border:1px solid #bae6fd;margin-left:6px;flex-shrink:0;
            vertical-align:middle;">
            <i class="fas fa-code-branch" style="font-size:8px"></i>${branchLabel}
        </span>`;
    }

    const banner = document.createElement('div');
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'polite');
    banner.style.cssText = `
        position:fixed; bottom:80px; right:20px; z-index:9999;
        max-width:340px; min-width:280px;
        background:var(--surface); border:1px solid var(--border);
        border-left:4px solid ${c.color};
        border-radius:12px; padding:14px 16px;
        box-shadow:0 8px 30px rgba(0,0,0,.18);
        display:flex; align-items:flex-start; gap:12px;
        animation:_notifIn .3s cubic-bezier(.34,1.56,.64,1);
        cursor:pointer; transition:opacity .2s, transform .2s;
        font-family:inherit; overflow:hidden;
    `;
    banner.innerHTML = `
        <style>
            @keyframes _notifIn{from{transform:translateX(110%);opacity:0}to{transform:none;opacity:1}}
            @keyframes _notifOut{to{transform:translateX(110%);opacity:0}}
        </style>
        <span style="font-size:22px;line-height:1;flex-shrink:0;margin-top:2px">${c.icon}</span>
        <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:var(--text-1);margin-bottom:3px;
                        display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px">${displayTitle}</span>
                ${branchBadgeHtml}
            </div>
            <div style="font-size:12px;color:var(--text-2);line-height:1.4">
                ${notif.message || ''}
            </div>
        </div>
        <button aria-label="Dismiss" style="
            background:none;border:none;cursor:pointer;
            color:var(--text-3);font-size:16px;padding:0;
            line-height:1;flex-shrink:0;margin-top:1px;
            transition:color .15s;">✕</button>
    `;

    // Dismiss button
    const dismissBtn = banner.querySelector('button');
    const dismiss = () => {
        banner.style.animation = '_notifOut .25s ease forwards';
        setTimeout(() => banner.remove(), 260);
    };
    dismissBtn.addEventListener('click', e => { e.stopPropagation(); dismiss(); });

    // Click to navigate
    if (notif.link) {
        banner.addEventListener('click', () => {
            dismiss();
            const page = notif.link.replace('/', '').split('?')[0];
            if (page) navigateTo(page);
        });
    }

    document.body.appendChild(banner);

    // Progress bar auto-dismiss
    const pb = document.createElement('div');
    pb.style.cssText = `
        position:absolute;bottom:0;left:0;height:3px;border-radius:0 0 12px 12px;
        background:${c.color};width:100%;
        transition:width ${TOAST_DURATION_MS}ms linear;
    `;
    banner.style.position = 'fixed';  // ensure relative works
    banner.style.overflow = 'hidden';
    banner.appendChild(pb);
    // Trigger animation
    requestAnimationFrame(() => { pb.style.width = '0%'; });

    const autoTimer = setTimeout(dismiss, TOAST_DURATION_MS);
    dismissBtn.addEventListener('click', () => clearTimeout(autoTimer));
}

// ── Main init ─────────────────────────────────────────────────────────────────
function initializeRealtimeNotifications() {
    // 1. Setup Web Push (device notifications)
    initPushNotifications();

    // 2. Setup Supabase Realtime (instant in-app)
    const realtimeOk = _initRealtime();

    // 3. Poll fallback if Realtime not available
    if (!realtimeOk) _startPollFallback();

    // 4. Initial badge count after short delay
    setTimeout(updateNotificationBadgeFromAPI, 2000);
}

// ── Badge update ──────────────────────────────────────────────────────────────
async function updateNotificationBadgeFromAPI() {
    try {
        const result = await window.NotificationsAPI.unreadCount();
        if (result?.unread_count !== undefined) updateNotificationBadge(result.unread_count);
    } catch {}
}

// ── Cleanup on logout ─────────────────────────────────────────────────────────

// ── Real-time: new sale handler ───────────────────────────────────────────────
function _onRealtimeSale(sale) {
    if (!sale) return;
    const currentPage = AppState.currentPage;

    // 1. Refresh dashboard stats (today's sales, transaction count)
    if (currentPage === 'dashboard') {
        loadDashboardData();
    } else {
        // Silently refresh dashboard data in background so it's ready when user switches
        loadDashboardData().catch(() => {});
    }

    // 2. Refresh sales page if open
    if (currentPage === 'sales') {
        loadSales();
    }

    // 3. Update low-stock badges on dashboard if another user's sale just depleted stock
    if (currentPage === 'dashboard') {
        // Dashboard reload above covers this
    }

    // 4. Flash the realtime indicator briefly
    _flashRealtimeBadge();
}

// ── Real-time: item/stock update handler ──────────────────────────────────────
function _onRealtimeItemUpdate(item) {
    if (!item) return;
    const currentPage = AppState.currentPage;

    // 1. Update AppState.items in memory (instant — no API call needed)
    if (AppState.items && Array.isArray(AppState.items)) {
        const idx = AppState.items.findIndex(i => i.id === item.id);
        if (idx !== -1) {
            AppState.items[idx] = { ...AppState.items[idx], ...item };
        }
    }

    // 2. If items page is open — re-render the table (already in memory, instant)
    if (currentPage === 'items') {
        // Re-render with updated in-memory data to avoid full reload
        if (AppState.items) renderItemsTable(AppState.items);
        // Full reload after 1s to pick up any enriched data
        setTimeout(() => { if (AppState.currentPage === 'items') loadItems(); }, 1000);
    }

    // 3. If POS is open — update the product grid stock badge in-place
    if (currentPage === 'pos') {
        _updatePOSStockBadge(item.id, item.stock_quantity, item.min_stock_level);
    }

    // 4. If dashboard open, refresh low-stock widget
    if (currentPage === 'dashboard') {
        window.DashboardAPI.lowStockItems(5, AppState.branch?.id).then(items => {
            renderLowStockList(items);
            document.getElementById('lowStockCount').textContent = items.length;
        }).catch(() => {});
    }

    _flashRealtimeBadge();
}

// ── Update a single POS product card's stock badge without full re-render ─────
function _updatePOSStockBadge(itemId, stockQty, minStock) {
    // POS cards are rendered as divs with onclick=addToCart('id')
    // Find the card and update its stock indicator
    const grid = document.getElementById('productsGrid');
    if (!grid) return;
    const cards = grid.querySelectorAll('[onclick]');
    cards.forEach(card => {
        const onclick = card.getAttribute('onclick') || '';
        if (onclick.includes(itemId)) {
            const stockEl = card.querySelector('[data-stock]');
            if (stockEl) {
                stockEl.textContent = stockQty <= 0
                    ? 'Out of stock'
                    : `Stock: ${stockQty}`;
                stockEl.style.color = stockQty <= 0
                    ? 'var(--danger)'
                    : (stockQty <= (minStock || 0) ? '#f59e0b' : 'var(--text-3)');
            }
            // Dim the card if now out of stock
            if (stockQty <= 0) {
                card.classList.add('out-of-stock');
                card.style.opacity = '0.4';
                card.setAttribute('onclick', '');
            } else if (card.style.opacity === '0.4') {
                card.classList.remove('out-of-stock');
                card.style.opacity = '1';
                card.setAttribute('onclick', `addToCart('${itemId}')`);
            }
        }
    });
}

// ── Realtime connection badge ─────────────────────────────────────────────────
function _showRealtimeBadge(connected) {
    let badge = document.getElementById('_realtimeDot');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = '_realtimeDot';
        badge.title = connected ? 'Real-time sync active' : 'Using polling fallback';
        badge.style.cssText = `
            position:fixed; bottom:12px; right:12px; z-index:9999;
            width:10px; height:10px; border-radius:50%;
            transition:background .4s;
            box-shadow:0 0 0 3px rgba(255,255,255,.3);
        `;
        document.body.appendChild(badge);
    }
    badge.style.background = connected ? '#22c55e' : '#f59e0b';
    badge.title = connected ? 'Real-time sync active' : 'Polling fallback (30s)';
}

function _flashRealtimeBadge() {
    const dot = document.getElementById('_realtimeDot');
    if (!dot) return;
    dot.style.transform = 'scale(1.6)';
    dot.style.background = '#60a5fa';
    setTimeout(() => {
        dot.style.transform = 'scale(1)';
        dot.style.background = '#22c55e';
    }, 400);
}

// ── Universal table-change handler ──────────────────────────────────────────
// Called for INSERT/UPDATE/DELETE on categories, suppliers, expenses, bank_accounts,
// branches, users. Refreshes the relevant page if it is currently open, and also
// updates any cross-page data that depends on the changed table.
function _onRealtimeTableChange(tablePage, payload) {
    const event   = payload.eventType; // 'INSERT' | 'UPDATE' | 'DELETE'
    const current = AppState.currentPage;

    // Map table name → page key (some differ)
    const pageMap = {
        categories:   'categories',
        suppliers:    'suppliers',
        expenses:     'expenses',
        bank:         'bank',
        branches:     'branches',
        users:        'users',
    };
    const page = pageMap[tablePage] || tablePage;

    // 1. If the affected page is open, reload it
    if (current === page) {
        switch (page) {
            case 'categories':  loadCategories();   break;
            case 'suppliers':   loadSuppliers();    break;
            case 'expenses':    loadExpenses();     break;
            case 'bank':        loadBankAccounts(); break;
            case 'branches':    loadBranches();     break;
            case 'users':
                if (Permissions[AppState.currentUser?.role]?.canManageUsers) loadUsers();
                break;
        }
    }

    // 2. Cross-page side effects
    if (page === 'categories') {
        // Category list is used in POS filter, items form, and items filter
        loadCategoriesForSelect().catch(() => {});
    }
    if (page === 'suppliers') {
        // Supplier list is used in item form
        loadCategoriesForSelect().catch(() => {}); // also refreshes suppliers dropdown
    }
    if (page === 'branches') {
        // Branch list used in selectors everywhere — reload selectors silently
        loadBranchesForSelect('branchSelector', AppState.branch?.id, 'All Branches').catch(() => {});
        // If a branch was deactivated/reactivated, re-apply guards on current page
        _applyBranchGuards(current);
    }
    if (page === 'bank') {
        // Bank list used in payment modal and transfer form — pre-load silently
        loadBankAccountsForPayment().catch(() => {});
        // Also refresh transfer account dropdown if bank page is open
        if (current === 'bank') {
            loadBankAccounts();
        }
    }
    if (page === 'expenses' && current === 'dashboard') {
        // Expenses affect dashboard totals
        loadDashboardData().catch(() => {});
    }

    _flashRealtimeBadge();
}

// ── Upgraded polling fallback — refreshes current page data, not just badge ──
let _pollPageInterval = null;
function _startPollFallback() {
    if (_pollInterval) return;
    // Badge poll every 30s
    _pollInterval = setInterval(updateNotificationBadgeFromAPI, POLL_INTERVAL_MS);
    // Page data poll every 30s — refreshes whatever page is currently open
    _pollPageInterval = setInterval(() => {
        const page = AppState.currentPage;
        if (!page || page === 'settings') return;
        console.log('[Poll] Refreshing page data for:', page);
        switch (page) {
            case 'dashboard':   loadDashboardData();   break;
            case 'pos':         loadPOSItems();        break;
            case 'items':       loadItems();           break;
            case 'categories':  loadCategories();      break;
            case 'suppliers':   loadSuppliers();       break;
            case 'sales':       loadSales();           break;
            case 'expenses':    loadExpenses();        break;
            case 'bank':        loadBankAccounts();    break;
            case 'users':
                if (Permissions[AppState.currentUser?.role]?.canManageUsers) loadUsers();
                break;
            case 'notifications': updateNotificationBadgeFromAPI(); break;
            // reports + branches: skip auto-poll (expensive / admin-only)
        }
    }, POLL_INTERVAL_MS);
}

function cleanupRealtimeNotifications() {
    // Remove all channels
    if (_supabaseCli) {
        if (_notifChannel)      { _supabaseCli.removeChannel(_notifChannel);      _notifChannel      = null; }
        if (_salesChannel)      { _supabaseCli.removeChannel(_salesChannel);      _salesChannel      = null; }
        if (_itemsChannel)      { _supabaseCli.removeChannel(_itemsChannel);      _itemsChannel      = null; }
        if (_categoriesChannel) { _supabaseCli.removeChannel(_categoriesChannel); _categoriesChannel = null; }
        if (_suppliersChannel)  { _supabaseCli.removeChannel(_suppliersChannel);  _suppliersChannel  = null; }
        if (_expensesChannel)   { _supabaseCli.removeChannel(_expensesChannel);   _expensesChannel   = null; }
        if (_bankChannel)       { _supabaseCli.removeChannel(_bankChannel);       _bankChannel       = null; }
        if (_branchesChannel)   { _supabaseCli.removeChannel(_branchesChannel);   _branchesChannel   = null; }
        if (_usersChannel)      { _supabaseCli.removeChannel(_usersChannel);      _usersChannel      = null; }
    }
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }

    // Unsubscribe push from backend
    if (_pushSubscription) {
        const endpoint = _pushSubscription.endpoint;
        const token = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.TOKEN || 'rf_token');
        fetch(`${window.AppConfig?.API_BASE_URL || '/api'}/push/unsubscribe`, {
            method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ endpoint }),
        }).catch(() => {});
        _pushSubscription = null;
    }
}

// ── Legacy alias so existing code still works ─────────────────────────────────
async function checkStockAndExpiryAlerts() {
    await updateNotificationBadgeFromAPI();
}



function updateNotificationBadge(count) {
    const badge = document.getElementById('notificationBadge');
    if (badge) {
        if (count > 0) {
            badge.textContent = count > 9 ? '9+' : count;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }
}

// Export functions for global access
window.initializeRealtimeNotifications = initializeRealtimeNotifications;
window.updateNotificationBadge = updateNotificationBadge;

// ── Push Notification Settings UI ─────────────────────────────────────────────
async function refreshPushStatus() {
    const dot       = document.getElementById('pushStatusDot');
    const title     = document.getElementById('pushStatusTitle');
    const detail    = document.getElementById('pushStatusDetail');
    const card      = document.getElementById('pushStatusCard');
    const enBtn     = document.getElementById('pushEnableBtn');
    const disBtn    = document.getElementById('pushDisableBtn');
    const tstBtn    = document.getElementById('pushTestBtn');
    const rstBtn    = document.getElementById('pushResetBtn');
    const note      = document.getElementById('pushNote');
    const vapidGuide = document.getElementById('vapidSetupGuide');
    if (!dot) return;

    // Helper: hide all action buttons
    const hideAll = () => [enBtn, disBtn, tstBtn, rstBtn, note, vapidGuide].forEach(el => { if (el) el.style.display = 'none'; });
    hideAll();

    // Reset card style to default
    if (card) { card.style.borderColor = 'var(--border)'; card.style.background = 'var(--bg)'; }

    const isIOS        = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true;

    // Browser support check
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        dot.style.background = '#ef4444';
        title.textContent  = 'Not supported on this browser';
        detail.textContent = 'Use Chrome or Edge on Android, or iOS 16.4+ added to Home Screen';
        return;
    }

    // iOS requires Add to Home Screen
    if (isIOS && !isStandalone) {
        dot.style.background = '#f59e0b';
        title.textContent  = 'iPhone / iPad detected';
        detail.textContent = 'Tap Share → "Add to Home Screen", then open from there';
        if (note) note.style.display = 'block';
        return;
    }

    // Notification permission check
    const perm = Notification.permission;
    if (perm === 'denied') {
        dot.style.background = '#ef4444';
        if (card) card.style.borderColor = '#fca5a5';
        title.textContent  = 'Notifications blocked in browser';
        detail.textContent = 'Go to browser Settings → Site Settings → Notifications → Allow';
        return;
    }

    // Check subscription + backend
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        const token = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');

        // Check backend config first
        let backendStatus = { configured: false, subscribed: false };
        try {
            const r = await fetch(`${window.AppConfig?.API_BASE_URL || '/api'}/push/status`,
                { headers: { 'Authorization': `Bearer ${token}` } });
            backendStatus = await r.json();
        } catch (_) {}

        // VAPID not configured on server
        if (!backendStatus.configured) {
            dot.style.background = '#f59e0b';
            title.textContent  = 'Server not configured for push';
            detail.textContent = 'VAPID keys need to be added to your Render environment';
            if (vapidGuide) vapidGuide.style.display = 'block';
            return;
        }

        if (sub && perm === 'granted' && backendStatus.subscribed) {
            dot.style.background = '#22c55e';
            if (card) { card.style.borderColor = '#86efac'; card.style.background = '#f0fdf4'; }
            title.textContent  = '✅ Push notifications active';
            detail.textContent = 'You will receive alerts even when the app is closed';
            if (disBtn) disBtn.style.display = 'inline-flex';
            if (tstBtn) tstBtn.style.display = 'inline-flex';
            if (rstBtn) rstBtn.style.display = 'inline-flex';
        } else if (sub && perm === 'granted' && !backendStatus.subscribed) {
            // Browser subscribed but backend lost it — re-sync
            dot.style.background = '#f59e0b';
            title.textContent  = 'Re-syncing subscription…';
            detail.textContent = '';
            await _subscribeToPush();
            setTimeout(refreshPushStatus, 1500);
        } else {
            dot.style.background = '#94a3b8';
            title.textContent  = 'Push notifications not enabled';
            detail.textContent = 'Tap Enable to get alerts on this device';
            if (enBtn) enBtn.style.display = 'inline-flex';
        }
    } catch (e) {
        dot.style.background = '#ef4444';
        title.textContent  = 'Error checking push status';
        detail.textContent = e.message;
        if (rstBtn) rstBtn.style.display = 'inline-flex';
    }
}

async function enablePushNotifications() {
    const btn = document.getElementById('pushEnableBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enabling…'; }

    try {
        await initPushNotifications();
        await new Promise(r => setTimeout(r, 1000));
        await refreshPushStatus();
    } catch (e) {
        showToast('Failed to enable push: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bell"></i> Enable on This Device'; }
    }
}

async function disablePushNotifications() {
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            const endpoint = sub.endpoint;
            await sub.unsubscribe();
            // Tell backend
            const token = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
            await fetch(`${window.AppConfig?.API_BASE_URL || '/api'}/push/unsubscribe`, {
                method: 'POST', keepalive: true,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ endpoint }),
            });
        }
        _pushSubscription = null;
        showToast('Push notifications disabled on this device', 'info');
        await refreshPushStatus();
    } catch (e) {
        showToast('Error disabling push: ' + e.message, 'error');
    }
}

// Push notification functions consolidated in settings section above



// Helper function to load branches for select
async function loadBranchesForSelect(selectId, selectedId, defaultOption = 'Select Branch') {
    const select = document.getElementById(selectId);
    if (!select) return;

    try {
        // active_only=true: only show active branches in all selectors
        const branches = await window.BranchesAPI.list({ active_only: true });
        select.innerHTML = `<option value="">${defaultOption}</option>`;
        branches.forEach(branch => {
            const option = document.createElement('option');
            option.value = branch.id;
            option.textContent = branch.name;
            if (branch.id === selectedId) option.selected = true;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Failed to load branches:', error);
    }
}

async function handleBranchChange(e) {
    const branchId = e.target.value;
    if (branchId) {
        try {
            const branch = await window.BranchesAPI.get(branchId);
            AppState.branch = branch;
            localStorage.setItem(window.AppConfig?.STORAGE_KEYS?.BRANCH || 'rf_branch', JSON.stringify(branch));
            if (branch.is_active === false) {
                showToast(`⚠️ ${branch.name} is deactivated — POS and item creation are blocked`, 'warning');
            } else {
                showToast(`Switched to ${branch.name}`, 'success');
            }
        } catch (error) {
            showToast('Failed to select branch', 'error');
        }
    } else {
        AppState.branch = null;
        localStorage.removeItem(window.AppConfig?.STORAGE_KEYS?.BRANCH || 'rf_branch');
        showToast('Showing all branches', 'info');
    }
    // Re-apply branch guards for the current page before reloading data
    const currentPage = document.querySelector('.page-content.active')?.id?.replace('Page', '');
    if (currentPage) {
        _applyBranchGuards(currentPage);
        await loadPageData(currentPage);
    }
}

// Sales
async function loadSales() {
    try {
        // Get date filters from the input fields
        const startDateInput = document.getElementById('salesStartDate')?.value;
        const endDateInput = document.getElementById('salesEndDate')?.value;
        
        // Build query parameters
        const params = { page_size: 50, ..._branchParam() };
        
        // Add date filters if provided
        if (startDateInput) { params.start_date = startDateInput; }
        if (endDateInput)   { params.end_date   = endDateInput; }
        
        const statusFilter = document.getElementById('salesStatusFilter')?.value;
        if (statusFilter) { params.payment_status = statusFilter; }

        // Payment method filter — can be "cash", "bank", "mobile_money",
        // "bank:UUID" (specific bank account) or "mobile_money:UUID" (specific provider)
        const paymentFilter = document.getElementById('salesPaymentFilter')?.value;
        if (paymentFilter) { params.payment_method = paymentFilter; }

        const sales = await window.SalesAPI.list(params);
        const tbody = document.getElementById('salesTable');
        if (!sales || sales.length === 0) { 
            tbody.innerHTML = '<tr><td colspan="9" class="text-center text-gray-500 py-8">No sales yet. Complete a sale to see it here.</td></tr>'; 
            return; 
        }
        
        tbody.innerHTML = sales.map(s => {
            // Format items list - use item_name field from the JOIN
            let itemsList = '-';
            if (s.items && s.items.length > 0) {
                itemsList = s.items.slice(0, 3).map(item => {
                    // Use item_name from JOIN, fallback to name, then to 'Deleted Item'
                    const itemName = item.item_name || item.name || 'Deleted Item';
                    return itemName;
                }).join(', ');
                if (s.items.length > 3) {
                    itemsList += ` +${s.items.length - 3} more`;
                }
            }
            
            // Format payment method display - handle split payments
            let paymentDisplay = '-';
            if (s.payments && s.payments.length > 0) {
                // Multiple payment methods exist
                const paymentIcons = {
                    'cash': '<i class="fas fa-money-bill-wave text-green-600" title="Cash"></i>',
                    'bank': '<i class="fas fa-university text-blue-600" title="Bank"></i>',
                    'mobile_money': '<i class="fas fa-mobile-alt text-purple-600" title="Mobile Money"></i>'
                };
                paymentDisplay = s.payments.map(p => {
                    const icon = paymentIcons[p.payment_method] || '';
                    return `${icon} ${formatCurrency(p.amount)}`;
                }).join(' + ');
            } else {
                // Fallback to single payment method field
                const paymentMethod = s.payment_method || 'cash';
                const paymentMethodLabels = {
                    'cash': '<i class="fas fa-money-bill-wave text-green-600"></i> Cash',
                    'bank': '<i class="fas fa-university text-blue-600"></i> Bank',
                    'mobile_money': '<i class="fas fa-mobile-alt text-purple-600"></i> Mobile Money'
                };
                paymentDisplay = paymentMethodLabels[paymentMethod] || paymentMethod;
            }
            
            // Format date with time
            const saleDate = s.created_at ? new Date(s.created_at) : null;
            const dateStr = saleDate ? saleDate.toLocaleDateString() + ' ' + saleDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
            
            return `
                <tr>
                    <td class="font-medium text-sm">
                        <div class="truncate max-w-xs" title="${itemsList}">${itemsList}</div>
                    </td>
                    <td class="text-sm">${dateStr}</td>
                    <td>${s.branch_name || '-'}</td>
                    <td>${s.sold_by || s.cashier_name || '-'}</td>
                    <td>${paymentDisplay}</td>
                    <td class="font-medium">${formatCurrency(s.net_amount || 0)}</td>
                    <td><span class="text-xs bg-gray-100 px-2 py-1 rounded">${s.invoice_number || 'N/A'}</span></td>
                    <td>
                        <span class="badge ${s.payment_status === 'returned' ? 'badge-danger' : s.payment_status === 'partial_return' ? 'badge-warning' : s.payment_status === 'refunded' ? 'badge-danger' : 'badge-success'}">
                            ${s.payment_status === 'partial_return' ? 'partial return' : (s.payment_status || 'paid')}
                        </span>
                    </td>
                    <td style="white-space:nowrap;">
                        <button class="text-blue-500 hover:text-blue-700 mr-2" title="View Receipt" onclick="viewReceipt('${s.id}')">
                            <i class="fas fa-receipt"></i>
                        </button>
                        ${['paid', 'partial_return'].includes(s.payment_status) ? `<button class="text-orange-500 hover:text-orange-700" title="Process Return" onclick="openReturnModal('${s.id}')"><i class="fas fa-undo-alt"></i></button>` : ''}
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) { 
        console.error('Failed to load sales:', error);
        const tbody = document.getElementById('salesTable');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="9" class="text-center text-red-500 py-8">Failed to load sales. Please try again.</td></tr>';
        }
    }
}

// View Receipt - Show sale details in a modal
async function viewReceipt(saleId) {
    try {
        const sale = await window.SalesAPI.get(saleId);
        
        if (!sale) {
            showToast('Sale not found', 'error');
            return;
        }
        
        // Build receipt HTML
        const itemsHtml = sale.items && sale.items.length > 0 
            ? sale.items.map(item => `
                <tr>
                    <td>${item.quantity}x</td>
                    <td>${item.item_name || item.name || 'Item'}</td>
                    <td class="text-right">${formatCurrency(item.unit_price || 0)}</td>
                    <td class="text-right">${formatCurrency(item.total || (item.unit_price * item.quantity) || 0)}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="4" class="text-center text-gray-500">No items</td></tr>';
        
        const receiptHtml = `
            <div class="receipt-modal">
                <div class="text-center border-b pb-4 mb-4">
                    <h3 class="text-xl font-bold">${AppState.organization?.name || 'POS Sale'}</h3>
                    <p class="text-sm text-gray-500">${sale.branch_name || 'Branch'}</p>
                    <p class="text-sm">Invoice: ${sale.invoice_number}</p>
                    <p class="text-sm">Date: ${sale.created_at ? new Date(sale.created_at).toLocaleString() : '-'}</p>
                </div>
                
                <table class="w-full text-sm">
                    <thead>
                        <tr class="border-b">
                            <th class="text-left py-2">Qty</th>
                            <th class="text-left py-2">Item</th>
                            <th class="text-right py-2">Price</th>
                            <th class="text-right py-2">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsHtml}
                    </tbody>
                </table>
                
                <div class="mt-4 border-t pt-4">
                    <div class="flex justify-between mb-1">
                        <span>Subtotal:</span>
                        <span>${formatCurrency(sale.total_amount || 0)}</span>
                    </div>
                    <div class="flex justify-between mb-1">
                        <span>Tax:</span>
                        <span>${formatCurrency(sale.tax_amount || 0)}</span>
                    </div>
                    <div class="flex justify-between mb-1">
                        <span>Discount:</span>
                        <span>-${formatCurrency(sale.discount_amount || 0)}</span>
                    </div>
                    <div class="flex justify-between font-bold text-lg mt-2">
                        <span>Total:</span>
                        <span>${formatCurrency(sale.net_amount || 0)}</span>
                    </div>
                </div>
                
                <div class="mt-4 text-center text-sm text-gray-500">
                    <p>Paid by: ${sale.payment_method || 'Cash'}</p>
                    <p>Sold by: ${sale.sold_by || 'Unknown'}</p>
                    <p class="mt-2">Thank you for your business!</p>
                </div>
            </div>
        `;
        
        // Show receipt in an inline modal (popup windows are blocked by browsers)
        let rModal = document.getElementById('_receiptViewModal');
        if (!rModal) {
            rModal = document.createElement('div');
            rModal.id = '_receiptViewModal';
            rModal.className = 'modal active';
            rModal.innerHTML = `<div class="modal-content" style="max-width:420px;">
                <div class="modal-header">
                    <h3 class="modal-title">Receipt</h3>
                    <button class="modal-close" onclick="document.getElementById('_receiptViewModal').classList.remove('active')">
                        <i class="fas fa-times"></i></button>
                </div>
                <div class="modal-body" id="_receiptViewBody" style="font-family:monospace;font-size:13px;"></div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="document.getElementById('_receiptViewModal').classList.remove('active')">Close</button>
                    <button class="btn btn-primary" onclick="window.print()"><i class="fas fa-print"></i> Print</button>
                </div>
            </div>`;
            document.body.appendChild(rModal);
        }
        document.getElementById('_receiptViewBody').innerHTML = receiptHtml;
        document.getElementById('_receiptViewModal').classList.add('active');
        
    } catch (error) {
        console.error('Failed to load receipt:', error);
        showToast('Failed to load receipt details', 'error');
    }
}

// Export viewReceipt
window.viewReceipt = viewReceipt;

// Expenses
async function loadExpenses() {
    try {
        const expenses = await window.ExpensesAPI.list({ page_size: 50, ..._branchParam() });
        const tbody = document.getElementById('expensesTable');
        if (!expenses?.length) { tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-500">No expenses</td></tr>'; return; }
        tbody.innerHTML = expenses.map(e => `
            <tr>
                <td>${formatDate(e.expense_date)}</td>
                <td class="font-medium">${esc(e.title)}</td>
                <td><span class="badge badge-gray">${e.expense_type}</span></td>
                <td>${formatCurrency(e.amount)}</td>
                <td style="white-space:nowrap;">
                    <button class="text-blue-500 mr-2" onclick="editExpense('${e.id}')"><i class="fas fa-edit"></i></button>
                    <button class="text-red-500" onclick="deleteExpense('${e.id}')"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `).join('');
    } catch (error) { console.error('Failed to load expenses:', error); }
}

async function editExpense(expenseId) {
    try {
        const expense = await window.ExpensesAPI.get(expenseId);
        openExpenseModal(expense);
    } catch (error) {
        showToast(error.message || 'Failed to load expense', 'error');
    }
}

async function deleteExpense(expenseId) {
    if (!await xposConfirm('Are you sure you want to delete this expense?', 'Delete Expense', true)) return;
    try {
        await window.ExpensesAPI.delete(expenseId);
        showToast('Expense deleted', 'success');
        loadExpenses();
    } catch (error) {
        showToast(error.message || 'Failed to delete expense', 'error');
    }
}

// Bank Accounts
async function loadBankAccounts() {
    try {
        const tab = AppState.bankTab || 'bank';
        const isMobile = (tab === 'mobile_money');

        // Fetch both types in parallel to update both stat cards
        const [bankAccts, mobileAccts] = await Promise.all([
            window.BankAPI.list({ ..._branchParam(), account_type: 'bank' }),
            window.BankAPI.list({ ..._branchParam(), account_type: 'mobile_money' }),
        ]);
        AppState.bankAccounts = bankAccts;
        AppState.mobileAccounts = mobileAccts;

        // Update stat cards
        const bankTotal = bankAccts.reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);
        const mobileTotal = mobileAccts.reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);
        const totalBankEl = document.getElementById('totalBankBalance');
        const totalMobileEl = document.getElementById('totalMobileBalance');
        if (totalBankEl) totalBankEl.textContent = formatCurrency(bankTotal);
        if (totalMobileEl) totalMobileEl.textContent = formatCurrency(mobileTotal);

        // Populate transfer dropdown with bank accounts only
        _populateTransferAccounts(bankAccts);

        // Update table column headers
        const colName   = document.getElementById('bankColName');
        const colNumber = document.getElementById('bankColNumber');
        const colBank   = document.getElementById('bankColBank');
        const titleEl   = document.getElementById('bankTableTitle');
        const btnLabel  = document.getElementById('addBankBtnLabel');
        const transferCard = document.getElementById('bankTransferCard');
        if (colName)   colName.textContent   = isMobile ? 'Provider Name'   : 'Account Name';
        if (colNumber) colNumber.textContent  = isMobile ? 'Phone / Number'  : 'Account Number';
        if (colBank)   colBank.textContent    = isMobile ? 'Provider'        : 'Bank';
        if (titleEl)   titleEl.textContent    = isMobile ? 'Mobile Money Providers' : 'Bank Accounts';
        if (btnLabel)  btnLabel.textContent   = isMobile ? 'Add Provider'    : 'Add Account';
        if (transferCard) transferCard.style.display = isMobile ? 'none' : '';

        const accounts = isMobile ? mobileAccts : bankAccts;
        const tbody = document.getElementById('bankTable');
        if (!accounts?.length) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-gray-500">
                No ${isMobile ? 'mobile money providers' : 'bank accounts'} yet. Click "Add ${isMobile ? 'Provider' : 'Account'}" to get started.
            </td></tr>`;
            return;
        }
        tbody.innerHTML = accounts.map(a => `
            <tr style="${a.is_active === false ? 'opacity:0.5;' : ''}">
                <td class="font-medium">${esc(a.account_name)}${a.is_active === false ? ' <span style="font-size:10px;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:99px;">Inactive</span>' : ''}</td>
                <td>${esc(a.account_number || '-')}</td>
                <td>${esc(a.bank_name || '-')}</td>
                <td class="font-bold ${a.is_active === false ? '' : (isMobile ? 'text-purple-600' : 'text-green-600')}">${formatCurrency(a.balance)}</td>
                <td style="white-space:nowrap;">
                    <button class="text-blue-500 mr-2" onclick="editBankAccount('${esc(a.id)}')"><i class="fas fa-edit"></i></button>
                    <button class="text-orange-500 mr-2" title="${a.is_active === false ? 'Reactivate' : 'Deactivate'}" onclick="toggleBankActive('${esc(a.id)}', ${a.is_active !== false})">
                        <i class="fas ${a.is_active === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (error) { console.error('Failed to load bank accounts:', error); }
}

// ── Switch between Bank / Mobile Money tabs on the bank page ─────────────────
function switchBankTab(tab) {
    AppState.bankTab = tab;
    const isMobile = (tab === 'mobile_money');

    // Update tab button styles
    const bankBtn   = document.getElementById('bankTabBtn');
    const mobileBtn = document.getElementById('mobileTabBtn');
    if (bankBtn) {
        bankBtn.style.borderBottomColor   = isMobile ? 'transparent' : 'var(--primary)';
        bankBtn.style.color               = isMobile ? 'var(--text-2)' : 'var(--primary)';
    }
    if (mobileBtn) {
        mobileBtn.style.borderBottomColor = isMobile ? 'var(--primary)' : 'transparent';
        mobileBtn.style.color             = isMobile ? 'var(--primary)' : 'var(--text-2)';
    }
    loadBankAccounts();
}

async function deleteBankAccount(accountId) {
    const account = AppState.bankAccounts?.find(a => a.id === accountId);
    const name = account?.account_name || account?.bank_name || 'this account';
    if (!await xposConfirm(`Delete "${name}"? This cannot be undone.`, 'Delete Bank Account', true)) return;
    try {
        await window.BankAPI.delete(accountId);
        showToast('Bank account deleted', 'success');
        loadBankAccounts();
    } catch (error) {
        showToast(error?.message || 'Failed to delete bank account', 'error');
    }
}

async function editBankAccount(accountId) {
    const account = AppState.bankAccounts.find(a => a.id === accountId);
    if (account) {
        openBankModal(account);
    }
}

async function toggleBankActive(accountId, currentlyActive) {
    const action = currentlyActive ? 'deactivate' : 'reactivate';
    if (!await xposConfirm(`${currentlyActive ? 'Deactivate' : 'Reactivate'} this bank account?`, 'Bank Account', true)) return;
    try {
        await window.BankAPI.update(accountId, { is_active: !currentlyActive });
        showToast(`Account ${action}d successfully`, 'success');
        loadBankAccounts();
    } catch (error) {
        showToast(error.message || `Failed to ${action} account`, 'error');
    }
}

// Notifications
async function loadNotifications() {
    await _renderNotifications('all');
}

// All cached notifications for filter switching
let _allNotifications = [];
let _branchMap        = {};

async function _renderNotifications(filter) {
    const container = document.getElementById('notificationsList');
    const subtitle  = document.getElementById('notifSubtitle');
    if (!container) return;

    // Show loading on first load
    if (!_allNotifications.length) {
        container.innerHTML = `<div style="text-align:center;padding:48px 0;color:var(--text-3);">
            <i class="fas fa-spinner fa-spin" style="font-size:2rem;margin-bottom:12px;display:block"></i>
            Loading…</div>`;
    }

    try {
        _allNotifications = await window.NotificationsAPI.list({ page_size: 100 });

        // Build branch map
        _branchMap = {};
        try {
            const branches = await window.BranchesAPI.list();
            (branches || []).forEach(b => { _branchMap[b.id] = b.name; });
        } catch (_) {}

    } catch (e) {
        container.innerHTML = `<div style="text-align:center;padding:48px 0;color:var(--danger);">
            <i class="fas fa-exclamation-triangle" style="font-size:2rem;margin-bottom:12px;display:block"></i>
            Failed to load notifications</div>`;
        return;
    }

    _applyNotificationFilter(filter);
}

function _applyNotificationFilter(filter) {
    const container = document.getElementById('notificationsList');
    const subtitle  = document.getElementById('notifSubtitle');
    if (!container) return;

    let items = _allNotifications;

    if (filter === 'unread') items = items.filter(n => !n.is_read);
    if (filter === 'sale')   items = items.filter(n => n.notification_type === 'new_sale');
    if (filter === 'stock')  items = items.filter(n => n.notification_type === 'low_stock' || n.notification_type === 'expiring_items');

    const unreadCount = _allNotifications.filter(n => !n.is_read).length;
    if (subtitle) {
        subtitle.textContent = unreadCount > 0
            ? `${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}`
            : 'All caught up';
    }

    if (!items.length) {
        container.innerHTML = `
            <div style="text-align:center;padding:60px 20px;color:var(--text-3);">
                <div style="width:64px;height:64px;border-radius:50%;
                            background:var(--bg);border:2px solid var(--border);
                            display:flex;align-items:center;justify-content:center;
                            margin:0 auto 16px;">
                    <i class="fas fa-bell-slash" style="font-size:1.5rem"></i>
                </div>
                <p style="font-size:14px;font-weight:600;color:var(--text-2);margin:0 0 4px">No notifications</p>
                <p style="font-size:12px;margin:0">${filter === 'all' ? 'Nothing here yet' : 'None in this category'}</p>
            </div>`;
        return;
    }

    // Per-type config: icon, solid icon color, unread bg, unread border, icon bg
    const isDark = document.documentElement.classList.contains('dark');
    const TYPE = {
        new_sale:       { icon:'fa-shopping-cart', color:'#10b981', unreadBg: isDark?'#052e16':'#f0fdf4', unreadBorder:'#6ee7b7', iconBg: isDark?'#064e3b':'#dcfce7' },
        low_stock:      { icon:'fa-box-open',      color:'#f59e0b', unreadBg: isDark?'#1c1207':'#fffbeb', unreadBorder:'#fcd34d', iconBg: isDark?'#2d1f06':'#fef3c7' },
        expiring_items: { icon:'fa-clock',         color:'#ef4444', unreadBg: isDark?'#1f0909':'#fef2f2', unreadBorder:'#fca5a5', iconBg: isDark?'#2d0f0f':'#fee2e2' },
        system_alert:   { icon:'fa-bell',          color:'#3b82f6', unreadBg: isDark?'#0c1629':'#eff6ff', unreadBorder:'#93c5fd', iconBg: isDark?'#0f2040':'#dbeafe' },
    };

    container.innerHTML = items.map(n => {
        const cfg    = TYPE[n.notification_type] || TYPE.system_alert;
        const unread = !n.is_read;

        // Extract [BranchName] from title
        let displayTitle = n.title || '';
        let branchBadge  = '';
        const bm = displayTitle.match(/^\[(.*?)\]\s*/);
        if (bm) {
            displayTitle = displayTitle.replace(bm[0], '').trim();
            const _bbg = isDark ? '#0c2a3d' : '#e0f2fe';
            const _bc  = isDark ? '#7dd3fc' : '#0369a1';
            const _bbd = isDark ? '#1e4060' : '#bae6fd';
            branchBadge = `<span style="display:inline-flex;align-items:center;gap:3px;
                background:${_bbg};color:${_bc};font-size:10px;font-weight:700;
                padding:2px 8px;border-radius:99px;border:1px solid ${_bbd};flex-shrink:0;">
                <i class="fas fa-code-branch" style="font-size:8px"></i>${bm[1]}</span>`;
        } else if (n.branch_id && _branchMap[n.branch_id]) {
            const _bbg = isDark ? '#0c2a3d' : '#e0f2fe';
            const _bc  = isDark ? '#7dd3fc' : '#0369a1';
            const _bbd = isDark ? '#1e4060' : '#bae6fd';
            branchBadge = `<span style="display:inline-flex;align-items:center;gap:3px;
                background:${_bbg};color:${_bc};font-size:10px;font-weight:700;
                padding:2px 8px;border-radius:99px;border:1px solid ${_bbd};flex-shrink:0;">
                <i class="fas fa-code-branch" style="font-size:8px"></i>${_branchMap[n.branch_id]}</span>`;
        }

        const cardBg     = unread ? cfg.unreadBg     : 'var(--surface)';
        const cardBorder = unread ? cfg.unreadBorder  : 'var(--border)';

        return `<div onclick="handleNotificationClick('${n.id}','${(n.link||'').replace(/'/g,"")}')"
            style="display:flex;align-items:flex-start;gap:12px;padding:13px 14px;
                   margin-bottom:8px;border-radius:12px;
                   border:1.5px solid ${cardBorder};
                   background:${cardBg};
                   cursor:pointer;position:relative;
                   transition:box-shadow .15s,border-color .15s;"
            onmouseover="this.style.boxShadow='0 4px 16px rgba(0,0,0,.08)'"
            onmouseout="this.style.boxShadow='none'">
            ${unread ? `<span style="position:absolute;top:13px;right:13px;
                width:8px;height:8px;border-radius:50%;background:${cfg.color};
                box-shadow:0 0 0 2px ${cardBg};flex-shrink:0;"></span>` : ''}
            <!-- Icon -->
            <div style="width:38px;height:38px;border-radius:10px;flex-shrink:0;
                        display:flex;align-items:center;justify-content:center;
                        background:${cfg.iconBg};border:1px solid ${cfg.unreadBorder};">
                <i class="fas ${cfg.icon}" style="color:${cfg.color};font-size:14px"></i>
            </div>
            <!-- Content -->
            <div style="flex:1;min-width:0;padding-right:${unread?'18px':'4px'};">
                <!-- Title row -->
                <div style="display:flex;align-items:flex-start;gap:6px;
                            flex-wrap:wrap;margin-bottom:3px;">
                    <span style="font-size:13px;font-weight:${unread?'700':'600'};
                                 color:var(--text-1);flex:1;min-width:0;
                                 word-break:break-word;line-height:1.35;">${displayTitle}</span>
                    ${branchBadge}
                </div>
                <!-- Message -->
                <p style="font-size:12px;color:var(--text-2);
                           margin:0 0 5px;line-height:1.5;word-break:break-word;">${n.message||''}</p>
                <!-- Time -->
                <span style="font-size:11px;color:var(--text-3);
                             display:inline-flex;align-items:center;gap:3px;">
                    <i class="fas fa-clock" style="font-size:9px"></i>
                    ${formatTimeAgo(n.created_at)}
                </span>
            </div>
        </div>`;
    }).join('');
}

function filterNotifications(filter, btn) {
    // Highlight active tab
    ['all','unread','sale','stock'].forEach(f => {
        const b = document.getElementById('notifFilter' + f.charAt(0).toUpperCase() + f.slice(1));
        if (!b) return;
        if (f === filter) {
            b.style.background   = 'var(--primary)';
            b.style.color        = '#fff';
            b.style.borderColor  = 'var(--primary)';
        } else {
            b.style.background   = 'var(--surface)';
            b.style.color        = 'var(--text-2)';
            b.style.borderColor  = 'var(--border)';
        }
    });
    _applyNotificationFilter(filter);
}
function formatTimeAgo(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
}

// Reports
async function loadReports() {
    // Set default date range: first day of this month → today
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    document.getElementById('reportEndDate').value   = today.toISOString().slice(0,10);
    document.getElementById('reportStartDate').value = firstDay.toISOString().slice(0,10);
}

// ── State for current report ──────────────────────────────────────────────────
const ReportState = {
    type:    null,
    data:    null,   // raw API response
    rows:    [],     // flat rows for export (sales detail)
    summary: {},
};

function _getDateParams() {
    const branchId = AppState.branch?.id || undefined;
    return {
        start_date: document.getElementById('reportStartDate').value || undefined,
        end_date:   document.getElementById('reportEndDate').value   || undefined,
        ...(branchId ? { branch_id: branchId } : {}),
    };
}

function reloadReport() {
    if (ReportState.type) showReport(ReportState.type);
}


function aggregateSalesReportRows(rows) {
    const groups = new Map();
    for (const r of (rows || [])) {
        const key = [r['Receipt #'], r['Item Name'], r['Unit Price']].join('||');
        if (!groups.has(key)) {
            groups.set(key, { ...r, Qty: 0, Subtotal: 0, _batches: [], _firstIndex: groups.size });
        }
        const g = groups.get(key);
        g.Qty = (Number(g.Qty) || 0) + (Number(r.Qty) || 0);
        g.Subtotal = (Number(g.Subtotal) || 0) + (Number(r.Subtotal) || 0);
        const batchNo = r['Batch #'] || r['Batch ID'] || '';
        if (batchNo || r['Batch Expiry']) {
            g._batches.push({ batch: batchNo || 'Unnumbered batch', expiry: r['Batch Expiry'] || 'No expiry', qty: r.Qty || 0 });
        }
    }
    return [...groups.values()].map(g => {
        const batches = g._batches || [];
        return {
            ...g,
            'Batch Details': batches.length > 1
                ? `<details><summary>${batches.length} batches</summary><div style="font-size:11px;color:var(--text-secondary);line-height:1.5;margin-top:4px;">${batches.map(b => `${esc(b.batch)} · exp ${esc(b.expiry)} · qty ${esc(b.qty)}`).join('<br>')}</div></details>`
                : (batches[0] ? `${esc(batches[0].batch)} · exp ${esc(batches[0].expiry)}` : '—')
        };
    });
}

function generateAutoBatchNumber() {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `LOTX${Date.now().toString().slice(-5)}-${day}-${month}-${d.getFullYear()}`;
}

function parseFlexibleDateInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
    const m = raw.match(/^(\d{1,2})[-\/. ](\d{1,2})[-\/. ](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    return raw;
}

function getUnitMultiplier(unit) {
    const m = getPackagingMultipliers();
    return unit === 'carton' ? m.cartonBaseUnits : unit === 'box' ? m.boxBaseUnits : unit === 'strip' ? m.stripBaseUnits : 1;
}

function getPharmacyMinStockQuantity() {
    const qty = _num('pharmaMinStockLevel', 0);
    const unit = document.getElementById('pharmaMinStockUnit')?.value || 'base';
    return Math.round(qty * getUnitMultiplier(unit));
}

function updateTierMargin(tierKey) {
    const m = getPackagingMultipliers();
    const costBasis = _num('pharmaPurchaseCost', _num('itemBuyPrice', 0));
    const stockUnit = document.getElementById('pharmaStockInputUnit')?.value || 'carton';
    const costPerBase = costBasis / Math.max(1, getUnitMultiplier(stockUnit));
    const multiplier = tierKey === 'carton' ? m.cartonBaseUnits : tierKey === 'box' ? m.boxBaseUnits : tierKey === 'strip' ? m.stripBaseUnits : 1;
    const cost = costPerBase * multiplier;
    const sell = _num(`tierSellPrice_${tierKey}`, 0);
    const badge = document.getElementById(`tierMargin_${tierKey}`);
    if (badge) badge.textContent = (sell > 0 ? (((sell - cost) / sell) * 100) : 0).toFixed(1) + '%';
}

async function showReport(type) {
    ReportState.type = type;

    // Highlight active card
    document.querySelectorAll('.report-type-btn').forEach(b => {
        b.style.borderColor = b.dataset.type === type ? 'var(--primary)' : 'transparent';
        b.style.boxShadow   = b.dataset.type === type ? '0 0 0 3px rgba(var(--primary-shadow),.15)' : '';
    });

    const titles = {
        sales:   'Sales Detail Report',
        daily:   'Daily Sales Summary',
        monthly: 'Monthly Sales Summary',
        profit:  'Profit Report',
        stock:   'Stock Valuation',
        byitem:     'Sales by Item',
        topselling: 'Top Selling Items',
    };
    document.getElementById('reportTitle').textContent = titles[type] || 'Report';

    const content    = document.getElementById('reportContent');
    const actionsBar = document.getElementById('reportActions');
    const summaryBar = document.getElementById('reportSummaryBar');

    content.innerHTML    = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading…</p></div>';
    actionsBar.style.display = 'none';
    summaryBar.style.display = 'none';

    try {
        const params = _getDateParams();

        // ── Sales Detail ─────────────────────────────────────────────────
        if (type === 'sales') {
            const result = await window.ReportsAPI.salesExport(params);
            ReportState.rows    = result.rows    || [];
            ReportState.summary = result.summary || {};
            ReportState.data    = result;

            if (!ReportState.rows.length) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No sales found for this period</p></div>';
                return;
            }

            // Summary bar
            const s = ReportState.summary;
            const cur = (v) => formatCurrency(v || 0);
            summaryBar.innerHTML = `
                <div style="display:flex;gap:24px;flex-wrap:wrap;font-size:13px;">
                    <span><strong>${s.total_sales || 0}</strong> <span style="color:var(--text-secondary)">Transactions</span></span>
                    <span><strong>${cur(s.total_revenue)}</strong> <span style="color:var(--text-secondary)">Revenue</span></span>
                    <span><strong>${cur(s.total_discount)}</strong> <span style="color:var(--text-secondary)">Discounts</span></span>
                    <span><strong>${cur(s.total_tax)}</strong> <span style="color:var(--text-secondary)">Tax</span></span>
                    <span style="color:var(--text-secondary)">Period: ${s.period_start} → ${s.period_end}</span>
                </div>`;
            summaryBar.style.display = 'flex';

            // Table: aggregate split FEFO batch rows into one visible item row.
            const displayRows = aggregateSalesReportRows(ReportState.rows);
            const cols = ['Date','Time','Receipt #','Item Name','Batch Details','Barcode','Category',
                          'Qty','Unit Price','Subtotal','Discount','Tax','Total',
                          'Payment Method','Customer','Sold By','Branch'];
            content.innerHTML = `
                <div class="table-container" id="reportTableWrap">
                    <table class="data-table" id="reportTable" style="font-size:13px;min-width:900px;">
                        <thead><tr>${cols.map(c => `<th style="white-space:nowrap;">${c}</th>`).join('')}</tr></thead>
                        <tbody>
                        ${displayRows.map((r, idx) => {
                            const isFirst = idx === 0 || r['Receipt #'] !== displayRows[idx-1]['Receipt #'];
                            return `<tr style="${isFirst && idx > 0 ? 'border-top:2px solid var(--border-color);' : ''}">
                                ${cols.map(c => {
                                    const v = r[c];
                                    if (v === '' || v === undefined || v === null) return '<td></td>';
                                    if (c === 'Unit Price' || c === 'Subtotal' || c === 'Discount' || c === 'Tax' || c === 'Total')
                                        return `<td style="text-align:right;">${typeof v === 'number' ? formatCurrency(v) : v}</td>`;
                                    if (c === 'Qty') return `<td style="text-align:center;">${v}</td>`;
                                    if (c === 'Batch Details') return `<td>${v}</td>`;
                                    return `<td>${v}</td>`;
                                }).join('')}
                            </tr>`;
                        }).join('')}
                        </tbody>
                    </table>
                </div>`;

            actionsBar.style.display = 'flex';
            return;
        }

        // ── Daily ─────────────────────────────────────────────────────────
        if (type === 'daily') {
            const data = await window.ReportsAPI.daily(params);
            ReportState.data = data;
            if (!data?.length) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No data for this period</p></div>';
                return;
            }
            content.innerHTML = `<div class="table-container" id="reportTableWrap">
                <table class="data-table" id="reportTable">
                    <thead><tr><th>Date</th><th>Transactions</th><th style="text-align:right">Revenue</th><th style="text-align:right">Tax</th><th style="text-align:right">Discount</th><th style="text-align:right">Gross Sales</th></tr></thead>
                    <tbody>${data.map(r => `<tr>
                        <td>${r.sale_date||'-'}</td>
                        <td style="text-align:center">${r.total_transactions||0}</td>
                        <td style="text-align:right">${formatCurrency(r.total_revenue||0)}</td>
                        <td style="text-align:right">${formatCurrency(r.total_tax||0)}</td>
                        <td style="text-align:right">${formatCurrency(r.total_discount||0)}</td>
                        <td style="text-align:right">${formatCurrency(r.gross_sales||0)}</td>
                    </tr>`).join('')}</tbody>
                </table></div>`;
            actionsBar.style.display = 'flex';
            return;
        }

        // ── Monthly ───────────────────────────────────────────────────────
        if (type === 'monthly') {
            const data = await window.ReportsAPI.monthly(params);
            ReportState.data = data;
            if (!data?.length) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No data for this period</p></div>';
                return;
            }
            content.innerHTML = `<div class="table-container" id="reportTableWrap">
                <table class="data-table" id="reportTable">
                    <thead><tr><th>Month</th><th>Transactions</th><th style="text-align:right">Revenue</th><th style="text-align:right">Tax</th><th style="text-align:right">Discount</th><th style="text-align:right">Gross Sales</th></tr></thead>
                    <tbody>${data.map(r => `<tr>
                        <td>${r.month||'-'}</td>
                        <td style="text-align:center">${r.total_transactions||0}</td>
                        <td style="text-align:right">${formatCurrency(r.total_revenue||0)}</td>
                        <td style="text-align:right">${formatCurrency(r.total_tax||0)}</td>
                        <td style="text-align:right">${formatCurrency(r.total_discount||0)}</td>
                        <td style="text-align:right">${formatCurrency(r.gross_sales||0)}</td>
                    </tr>`).join('')}</tbody>
                </table></div>`;
            actionsBar.style.display = 'flex';
            return;
        }

        // ── Profit ────────────────────────────────────────────────────────
        if (type === 'profit') {
            const data = await window.ReportsAPI.profit(params) || {};
            ReportState.data = data;
            const breakdown = Array.isArray(data.breakdown) ? data.breakdown : [];
            const cards = `<div class="stats-grid mb-4">
                <div class="stat-card"><div class="stat-icon green"><i class="fas fa-dollar-sign"></i></div><div class="stat-content"><div class="stat-label">Total Revenue</div><div class="stat-value">${formatCurrency(data.total_revenue||0)}</div></div></div>
                <div class="stat-card"><div class="stat-icon" style="background:rgba(239,68,68,.12);color:#ef4444"><i class="fas fa-minus"></i></div><div class="stat-content"><div class="stat-label">Total Cost</div><div class="stat-value">${formatCurrency(data.total_cost||0)}</div></div></div>
                <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-chart-line"></i></div><div class="stat-content"><div class="stat-label">Gross Profit</div><div class="stat-value">${formatCurrency(data.gross_profit||0)}</div></div></div>
                <div class="stat-card"><div class="stat-icon" style="background:rgba(139,92,246,.12);color:#8b5cf6"><i class="fas fa-percent"></i></div><div class="stat-content"><div class="stat-label">Profit Margin</div><div class="stat-value">${data.profit_margin||0}%</div></div></div>
            </div>`;
            const tableHtml = breakdown.length ? `<div class="table-container" id="reportTableWrap">
                <table class="data-table" id="reportTable">
                    <thead><tr>
                        <th>#</th><th>Item</th><th>Barcode</th>
                        <th style="text-align:right">Revenue</th>
                        <th style="text-align:right">Cost</th>
                        <th style="text-align:right">Profit</th>
                        <th style="text-align:right">Margin</th>
                    </tr></thead>
                    <tbody>${breakdown.map((r, i) => `<tr>
                        <td style="text-align:center">${i + 1}</td>
                        <td>${esc(r.item_name || 'Unknown')}</td>
                        <td>${esc(r.barcode || '')}</td>
                        <td style="text-align:right">${formatCurrency(r.revenue||0)}</td>
                        <td style="text-align:right">${formatCurrency(r.cost||0)}</td>
                        <td style="text-align:right;color:${(r.profit||0) < 0 ? '#ef4444' : 'inherit'}">${formatCurrency(r.profit||0)}</td>
                        <td style="text-align:right">${(r.profit_margin||0)}%</td>
                    </tr>`).join('')}</tbody>
                </table></div>`
                : '<div class="empty-state"><i class="fas fa-inbox"></i><p>No item-level data for this period</p></div>';
            content.innerHTML = cards + tableHtml;
            if (breakdown.length) actionsBar.style.display = 'flex';
            return;
        }

        // ── By Item / Top Selling ──────────────────────────────────────────
        if (type === 'byitem' || type === 'topselling') {
            const data = (type === 'byitem'
                ? await window.ReportsAPI.byItem(params)
                : await window.ReportsAPI.topSelling(params)) || [];
            ReportState.data = data;
            if (!data.length) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No sales found for this period</p></div>';
                return;
            }
            content.innerHTML = `<div class="table-container" id="reportTableWrap">
                <table class="data-table" id="reportTable">
                    <thead><tr>
                        <th>#</th><th>Item</th><th>Barcode</th>
                        <th style="text-align:right">Quantity Sold</th>
                        <th style="text-align:right">Revenue</th>
                        <th style="text-align:right">Cost</th>
                        <th style="text-align:right">Profit</th>
                    </tr></thead>
                    <tbody>${data.map((r, i) => {
                        const revenue = r.total_revenue || 0;
                        const cost = r.total_cost || 0;
                        const qty = r.quantity_display || (r.total_quantity != null ? String(r.total_quantity) : '-');
                        return `<tr>
                            <td style="text-align:center">${i + 1}</td>
                            <td>${esc(r.item_name || 'Unknown')}</td>
                            <td>${esc(r.barcode || '')}</td>
                            <td style="text-align:right">${esc(qty)}</td>
                            <td style="text-align:right">${formatCurrency(revenue)}</td>
                            <td style="text-align:right">${formatCurrency(cost)}</td>
                            <td style="text-align:right">${formatCurrency(revenue - cost)}</td>
                        </tr>`;
                    }).join('')}</tbody>
                </table></div>`;
            actionsBar.style.display = 'flex';
            return;
        }

        // ── Stock ─────────────────────────────────────────────────────────
        if (type === 'stock') {
            const data = await window.ReportsAPI.stockValuation(_getDateParams()) || {};
            ReportState.data = data;
            const items = data.items || [];
            content.innerHTML = `
                <div class="stats-grid mb-4">
                    <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-dollar-sign"></i></div><div class="stat-content"><div class="stat-label">Cost Value</div><div class="stat-value">${formatCurrency(data.total_cost_value||0)}</div></div></div>
                    <div class="stat-card"><div class="stat-icon green"><i class="fas fa-tag"></i></div><div class="stat-content"><div class="stat-label">Sell Value</div><div class="stat-value">${formatCurrency(data.total_sell_value||0)}</div></div></div>
                    <div class="stat-card"><div class="stat-icon" style="background:rgba(139,92,246,.12);color:#8b5cf6"><i class="fas fa-chart-line"></i></div><div class="stat-content"><div class="stat-label">Potential Profit</div><div class="stat-value">${formatCurrency(data.potential_profit||0)}</div></div></div>
                </div>
                <div class="table-container" id="reportTableWrap">
                    <table class="data-table" id="reportTable">
                        <thead><tr><th>Item</th><th style="text-align:center">Stock</th><th style="text-align:center">Batches</th><th style="text-align:right">Cost Value</th><th style="text-align:right">Sell Value</th><th style="text-align:right">Potential Profit</th></tr></thead>
                        <tbody>${items.length ? items.map(i => `<tr>
                            <td>${i.name||'Unknown'}</td>
                            <td style="text-align:center">${i.stock_quantity||0}</td>
                            <td style="text-align:center"><span class="badge badge-info">${i.batch_count||0}</span></td>
                            <td style="text-align:right">${formatCurrency(i.total_cost_value||0)}</td>
                            <td style="text-align:right">${formatCurrency(i.total_sell_value||0)}</td>
                            <td style="text-align:right">${formatCurrency((i.total_sell_value||0)-(i.total_cost_value||0))}</td>
                        </tr>`).join('') : '<tr><td colspan="6" class="text-center" style="color:var(--text-secondary)">No stock items</td></tr>'}</tbody>
                    </table>
                </div>`;
            actionsBar.style.display = 'flex';
            return;
        }

    } catch (err) {
        console.error('[Report]', err);
        content.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Failed to load report: ${err.message}</p></div>`;
    }
}

// ── Excel Export ──────────────────────────────────────────────────────────────
function exportToExcel() {
    if (!window.XLSX) { showToast('Excel library not loaded', 'error'); return; }

    const org   = AppState.organization?.name || 'Store';
    const type  = ReportState.type;
    const start = document.getElementById('reportStartDate').value;
    const end   = document.getElementById('reportEndDate').value;
    const period = `${start} to ${end}`;
    const now   = new Date().toLocaleString();
    const currency = AppState.organization?.currency || 'ETB';

    const wb = XLSX.utils.book_new();

    // ── Helper styles ─────────────────────────────────────────────────────
    const S = {
        title:   { font:{ bold:true, sz:16, color:{rgb:'1F2937'} }, alignment:{horizontal:'left'} },
        sub:     { font:{ sz:11, color:{rgb:'6B7280'} } },
        hdr:     { font:{ bold:true, sz:11, color:{rgb:'FFFFFF'} },
                   fill:{ patternType:'solid', fgColor:{rgb: (AppState.palette?.primary||'#2563EB').replace('#','') } },
                   alignment:{horizontal:'center'}, border:{bottom:{style:'thin'}} },
        num:     { numFmt: '#,##0.00', alignment:{horizontal:'right'} },
        numBold: { numFmt: '#,##0.00', font:{bold:true}, alignment:{horizontal:'right'} },
        total:   { font:{bold:true, sz:11}, fill:{patternType:'solid',fgColor:{rgb:'F3F4F6'}},
                   numFmt:'#,##0.00', alignment:{horizontal:'right'} },
        even:    { fill:{ patternType:'solid', fgColor:{rgb:'F9FAFB'} } },
    };

    if (type === 'sales') {
        // ── Sheet 1: Line items ───────────────────────────────────────────
        const cols = ['Date','Time','Receipt #','Item Name','Barcode','Category',
                      'Qty','Unit Price','Subtotal','Discount','Tax','Total',
                      'Payment Method','Customer','Sold By','Branch'];
        const numCols = new Set(['Qty','Unit Price','Subtotal','Discount','Tax','Total']);

        const wsData = [];
        // Title block
        wsData.push([`${org} — Sales Detail Report`]);
        wsData.push([`Period: ${period}   |   Generated: ${now}   |   Currency: ${currency}`]);
        wsData.push([]);
        // Summary row
        const s = ReportState.summary;
        wsData.push(['Total Transactions', s.total_sales||0, '', 'Total Revenue', s.total_revenue||0, '', 'Discounts', s.total_discount||0, '', 'Tax', s.total_tax||0]);
        wsData.push([]);
        // Headers
        wsData.push(cols);
        // Data rows
        ReportState.rows.forEach(r => {
            wsData.push(cols.map(c => {
                const v = r[c];
                if (v === '' || v === null || v === undefined) return '';
                if (numCols.has(c) && typeof v === 'number') return v;
                return v;
            }));
        });
        // Totals row
        const totalRow = new Array(cols.length).fill('');
        totalRow[cols.indexOf('Item Name')] = 'TOTAL';
        totalRow[cols.indexOf('Subtotal')] = `=SUM(I7:I${wsData.length})`;
        totalRow[cols.indexOf('Discount')] = `=SUM(J7:J${wsData.length})`;
        totalRow[cols.indexOf('Tax')]      = `=SUM(K7:K${wsData.length})`;
        totalRow[cols.indexOf('Total')]    = `=SUM(L7:L${wsData.length})`;
        wsData.push(totalRow);

        const ws = XLSX.utils.aoa_to_sheet(wsData);

        // Column widths
        ws['!cols'] = [
            {wch:12},{wch:10},{wch:14},{wch:28},{wch:14},{wch:16},
            {wch:6},{wch:12},{wch:12},{wch:12},{wch:10},{wch:12},
            {wch:22},{wch:18},{wch:18},{wch:16}
        ];

        // Apply header style (row 6 = index 5)
        const headerRowIdx = 5;
        cols.forEach((_, ci) => {
            const cellRef = XLSX.utils.encode_cell({r: headerRowIdx, c: ci});
            if (ws[cellRef]) ws[cellRef].s = S.hdr;
        });

        // Number format for numeric columns
        const dataStart = 6;
        const dataEnd   = wsData.length - 2;
        numCols.forEach(colName => {
            const ci = cols.indexOf(colName);
            if (ci < 0) return;
            for (let ri = dataStart; ri <= dataEnd; ri++) {
                const ref = XLSX.utils.encode_cell({r: ri, c: ci});
                if (ws[ref] && typeof ws[ref].v === 'number') {
                    ws[ref].s = ri % 2 === 0 ? {...S.num, ...S.even} : S.num;
                }
            }
        });

        XLSX.utils.book_append_sheet(wb, ws, 'Sales Detail');

        // ── Sheet 2: Summary by receipt ───────────────────────────────────
        const seen = new Set();
        const summaryRows = [['Receipt #','Date','Customer','Sold By','Branch','Payment','Total']];
        ReportState.rows.forEach(r => {
            if (r['Receipt #'] && !seen.has(r['Receipt #']) && r['Total'] !== '') {
                seen.add(r['Receipt #']);
                summaryRows.push([r['Receipt #'],r['Date'],r['Customer']||'',r['Sold By']||'',r['Branch']||'',r['Payment Method']||'',r['Total']||0]);
            }
        });
        const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
        wsSummary['!cols'] = [{wch:14},{wch:12},{wch:18},{wch:18},{wch:16},{wch:22},{wch:12}];
        XLSX.utils.book_append_sheet(wb, wsSummary, 'Transaction Summary');

    } else {
        // ── Generic table export for other report types ───────────────────
        const table = document.getElementById('reportTable');
        if (!table) { showToast('No table data to export', 'error'); return; }
        const wsData = [];
        wsData.push([`${org} — ${document.getElementById('reportTitle').textContent}`]);
        wsData.push([`Period: ${period}   |   Generated: ${now}`]);
        wsData.push([]);

        // Extract headers
        const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
        wsData.push(headers);

        // Extract rows
        table.querySelectorAll('tbody tr').forEach(tr => {
            wsData.push([...tr.querySelectorAll('td')].map(td => {
                const t = td.textContent.trim();
                // Try to parse currency values as numbers
                const num = parseFloat(t.replace(/[^\d.-]/g, ''));
                return (!isNaN(num) && t.length > 0) ? num : t;
            }));
        });

        const ws = XLSX.utils.aoa_to_sheet(wsData);
        ws['!cols'] = headers.map(() => ({wch: 18}));
        XLSX.utils.book_append_sheet(wb, ws, 'Report');
    }

    // Filename
    const filename = `${org.replace(/[^a-z0-9]/gi,'_')}_${type}_report_${start}_${end}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast('Excel file downloaded', 'success');
}

// ── Print / PDF ───────────────────────────────────────────────────────────────
function printReport() {
    const org     = AppState.organization?.name || 'Store';
    const type    = ReportState.type;
    const title   = document.getElementById('reportTitle').textContent;
    const start   = document.getElementById('reportStartDate').value;
    const end     = document.getElementById('reportEndDate').value;
    const now     = new Date().toLocaleString();
    const primary = AppState.palette?.primary || '#2563EB';
    const currency = AppState.organization?.currency || 'ETB';

    // Clone the table HTML
    const tableWrap = document.getElementById('reportTableWrap');
    const summaryBar = document.getElementById('reportSummaryBar');
    const tableHTML = tableWrap ? tableWrap.innerHTML : '<p>No table data available</p>';
    const summaryHTML = summaryBar && summaryBar.style.display !== 'none' ? summaryBar.innerHTML : '';

    const printHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${org} — ${title}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; padding: 24px; }

  .print-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; padding-bottom:16px; border-bottom:3px solid ${primary}; }
  .print-org { font-size:22px; font-weight:800; color:${primary}; }
  .print-title { font-size:15px; font-weight:600; color:#374151; margin-top:4px; }
  .print-meta { text-align:right; font-size:11px; color:#6b7280; line-height:1.6; }

  .summary-bar { display:flex; flex-wrap:wrap; gap:24px; background:#f9fafb; border-radius:8px; padding:12px 16px; margin-bottom:20px; font-size:12px; border:1px solid #e5e7eb; }
  .summary-bar strong { font-size:14px; }

  table { width:100%; border-collapse:collapse; font-size:11px; }
  thead th { background:${primary}; color:#fff; padding:8px 10px; text-align:left; font-weight:700; font-size:11px; }
  thead th:nth-child(n+7):nth-child(-n+12) { text-align:right; }
  tbody tr:nth-child(even) { background:#f9fafb; }
  tbody td { padding:6px 10px; border-bottom:1px solid #e5e7eb; vertical-align:middle; }
  tbody td:nth-child(7) { text-align:center; }
  tbody td:nth-child(n+8):nth-child(-n+12) { text-align:right; font-family:monospace; }

  .print-footer { margin-top:20px; padding-top:12px; border-top:1px solid #e5e7eb; font-size:10px; color:#9ca3af; display:flex; justify-content:space-between; }

  @media print {
    @page { margin: 15mm; size: A4 landscape; }
    body { padding: 0; }
  }
</style>
</head>
<body>
  <div class="print-header">
    <div>
      <div class="print-org">${org}</div>
      <div class="print-title">${title}</div>
    </div>
    <div class="print-meta">
      <div>Period: <strong>${start}</strong> to <strong>${end}</strong></div>
      <div>Generated: ${now}</div>
      <div>Currency: ${currency}</div>
    </div>
  </div>
  ${summaryHTML ? `<div class="summary-bar">${summaryHTML}</div>` : ''}
  ${tableHTML}
  <div class="print-footer">
    <span>${org} — Confidential</span>
    <span>Printed ${now}</span>
  </div>
  <script>window.onload = function(){ window.print(); };<\/script>
</body>
</html>`;

    const frame = document.getElementById('printFrame');
    frame.style.display = 'block';
    frame.innerHTML = '';

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:none;';
    frame.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(printHTML);
    iframe.contentDocument.close();

    // Hide print frame after browser print dialog closes
    iframe.contentWindow.onafterprint = () => {
        frame.style.display = 'none';
        frame.innerHTML = '';
    };
}


// Users
async function loadUsers() {
    try {
        const users = await window.UsersAPI.list({ page_size: 50, ..._branchParam() });
        const tbody = document.getElementById('usersTable');
        if (!users?.length) { tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500">No users</td></tr>'; return; }
        
        // Check if current user is admin
        const isAdmin = AppState.currentUser?.role === 'admin';
        
        tbody.innerHTML = users.map(u => `
            <tr>
                <td class="font-medium">${u.full_name}</td>
                <td>${u.email}</td>
                <td>${u.phone || '-'}</td>
                <td><span class="badge ${u.role === 'admin' ? 'badge-danger' : u.role === 'manager' ? 'badge-warning' : 'badge-info'}">${u.role}</span></td>
                <td>${u.branch_name || '-'}</td>
                <td><span class="badge ${u.is_active ? 'badge-success' : 'badge-danger'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
                <td>
                    ${isAdmin ? `
                    <button class="text-blue-500 mr-2" onclick="editUser('${u.id}')"><i class="fas fa-edit"></i></button>
                    <button class="text-${u.is_active ? 'orange' : 'green'}-500 mr-2" title="${u.is_active ? 'Disable account' : 'Enable account'}" onclick="toggleUserActive('${u.id}', ${u.is_active !== false})">
                        <i class="fas ${u.is_active !== false ? 'fa-user-slash' : 'fa-user-check'}"></i>
                    </button>
                    ${u.id !== '${AppState.currentUser?.id}' ? `<button class="text-red-400" onclick="deleteUser('${u.id}')"><i class="fas fa-trash"></i></button>` : ''}
                    ` : '-'}
                </td>
            </tr>
        `).join('');
    } catch (error) { 
        console.error('Failed to load users:', error);
        showToast('Failed to load users: ' + (error.message || 'Unknown error'), 'error');
    }
}

// User functions
async function editUser(userId) {
    try {
        const user = await window.UsersAPI.get(userId);
        openUserModal(user);
    } catch (error) {
        showToast('Failed to load user: ' + (error.message || 'Unknown error'), 'error');
    }
}

async function toggleUserActive(userId, currentlyActive) {
    try {
        await window.UsersAPI.update(userId, { is_active: !currentlyActive });
        showToast(`User ${currentlyActive ? 'disabled' : 'enabled'} successfully`, 'success');
        loadUsers();
    } catch (error) {
        showToast(error.message || 'Failed to update user', 'error');
    }
}

async function deleteUser(userId) {
    if (userId === AppState.currentUser?.id) {
        showToast('You cannot delete your own account', 'error');
        return;
    }
    if (!await xposConfirm('Permanently delete this user? This cannot be undone.', 'Delete User', true)) return;
    try {
        await window.UsersAPI.delete(userId);
        showToast('User deleted successfully', 'success');
        loadUsers();
    } catch (error) {
        showToast(error.message || 'Failed to delete user', 'error');
    }
}

// Modal helpers
function closeModal(modalId) {
    const _m = document.getElementById(modalId);
    if (!_m) return;
    _m.classList.remove('active');
    // Restore inline display:none for modals that use it as initial state
    // This prevents CSS .modal{display:none} conflicting with cleared inline style
    const _inlineHiddenModals = ['quickUpdateModal', 'categoryTemplateModal', 'saleSuccessModal'];
    if (_inlineHiddenModals.includes(modalId)) _m.style.display = 'none';
}

// Logout
function logout() {
    // Clean up realtime subscriptions
    if (typeof cleanupRealtimeNotifications === 'function') {
        cleanupRealtimeNotifications();
    }
    
    // Clear auth token and user data
    localStorage.removeItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
    localStorage.removeItem(window.AppConfig?.STORAGE_KEYS?.USER_DATA || 'rf_user_data');
    
    window.AuthAPI.logout();
    window.location.href = 'login.html';
}

// Utility functions
function formatCurrency(amount) {
    const currency = AppState.organization?.currency || 'ETB';
    const symbols = { USD: '$', EUR: '€', GBP: '£', KES: 'KSh', NGN: '₦', ETB: 'Br' };
    return `${symbols[currency] || 'Br'}${(amount || 0).toFixed(2)}`;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTime(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}


// ── Custom confirm dialog — replaces browser confirm() for better UX ─────────
function xposConfirm(message, title = 'Confirm', danger = false) {
    return new Promise(resolve => {
        let modal = document.getElementById('_xposConfirmModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = '_xposConfirmModal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content" style="max-width:380px;">
                    <div class="modal-header" style="border-bottom:none;padding-bottom:8px;">
                        <h3 class="modal-title" id="_xposCT" style="font-size:16px;"></h3>
                    </div>
                    <div class="modal-body" style="padding-top:4px;">
                        <p id="_xposCM" style="font-size:14px;color:var(--text-2);margin:0;line-height:1.5;"></p>
                    </div>
                    <div class="modal-footer" style="gap:8px;">
                        <button id="_xposCCancel" class="btn btn-secondary" style="flex:1;">Cancel</button>
                        <button id="_xposCOk" class="btn" style="flex:1;">Confirm</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        document.getElementById('_xposCT').textContent = title;
        document.getElementById('_xposCM').textContent = message;
        const okBtn = document.getElementById('_xposCOk');
        okBtn.style.background = danger ? 'var(--danger, #ef4444)' : 'var(--primary)';
        okBtn.style.color = '#fff';
        okBtn.style.border = 'none';
        okBtn.textContent = danger ? 'Delete' : 'Confirm';
        modal.classList.add('active'); modal.style.display = '';
        const close = (result) => {
            modal.classList.remove('active');
            resolve(result);
        };
        const newOk = okBtn.cloneNode(true);
        okBtn.replaceWith(newOk);
        const newCancel = document.getElementById('_xposCCancel').cloneNode(true);
        document.getElementById('_xposCCancel').replaceWith(newCancel);
        newOk.addEventListener('click', () => close(true));
        newCancel.addEventListener('click', () => close(false));
        modal.addEventListener('click', e => { if (e.target === modal) close(false); }, {once:true});
    });
}

function sanitizeUserMessage(message) {
    const raw = String(message || '');
    if (!raw) return '';
    return raw
        .replace(/https?:\/\/[^\s)]+/gi, 'the server')
        .replace(/(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s)]*)?/gi, 'the server')
        .replace(/localhost(?::\d+)?(?:\/[^\s)]*)?/gi, 'the server')
        .replace(/Cannot connect to server at the server[^\n]*/gi, 'We could not reach the server.')
        .replace(/Request timed out connecting to the server[^\n]*/gi, 'The request took too long.')
        .trim();
}

function showToast(message, type = 'info', duration = 3500) {
    message = sanitizeUserMessage(message) || 'Something went wrong. Please try again.';
    const container = document.getElementById('toastContainer');
    if (!container) { console.warn('Toast container not found'); return; }

    // Deduplicate: don't stack identical toasts
    const existing = [...container.children].find(t => t.dataset.msg === message);
    if (existing) {
        existing.classList.add('toast-bump');
        setTimeout(() => existing.classList.remove('toast-bump'), 200);
        return;
    }

    const icons = { success: 'check-circle', error: 'exclamation-circle',
                    warning: 'exclamation-triangle', info: 'info-circle' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.dataset.msg = message;
    // Use textContent for message to prevent XSS
    const icon = document.createElement('i');
    icon.className = `fas fa-${icons[type] || 'info-circle'}`;
    const text = document.createTextNode(' ' + message);
    toast.appendChild(icon);
    toast.appendChild(text);

    // Click to dismiss early
    toast.style.cursor = 'pointer';
    toast.addEventListener('click', () => toast.remove());

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(110%)';
        toast.style.transition = 'all .3s ease';
        setTimeout(() => toast.remove(), 320);
    }, duration);
}

// ── Theme system ──────────────────────────────────────────────────────────────
function setTheme(mode) {
    // mode: 'light' | 'dark' | 'system'
    const html = document.documentElement;
    localStorage.setItem('rf_theme', mode);

    if (mode === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        prefersDark ? html.classList.add('dark') : html.classList.remove('dark');
    } else if (mode === 'dark') {
        html.classList.add('dark');
    } else {
        html.classList.remove('dark');
    }

    _updateThemeButtons(mode);
    // Re-render chart with new theme colours
    if (AppState.salesChart) {
        setTimeout(() => loadSalesChart(), 50);
    }
}

function _updateThemeButtons(mode) {
    const active = 'var(--primary)';
    const inactive = 'var(--border)';
    ['light','dark','system'].forEach(m => {
        const btn = document.getElementById('themeBtn' + m.charAt(0).toUpperCase() + m.slice(1));
        if (!btn) return;
        btn.style.borderColor = m === mode ? active : inactive;
        btn.style.background  = m === mode ? 'var(--primary-ultra)' : 'var(--surface)';
    });
}

function toggleDarkMode() {
    // Legacy — called by old header button if it still exists
    const isDark = document.documentElement.classList.contains('dark');
    setTheme(isDark ? 'light' : 'dark');
}

function initializeDarkMode() {
    const saved = localStorage.getItem('rf_theme') || 'light';
    setTheme(saved);

    // Listen for system preference changes (only active in 'system' mode)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (localStorage.getItem('rf_theme') === 'system') {
            e.matches
                ? document.documentElement.classList.add('dark')
                : document.documentElement.classList.remove('dark');
        }
    });
}

// Global functions
window.addToCart = addToCart;
window.removeFromCart = removeFromCart;
window.updateCartQuantity = updateCartQuantity;
window.updateCartUnit = updateCartUnit;
window.editItem = editItem;
window.deleteItem = deleteItem;
window.openItemModal = openItemModal;
window.setItemPagePharmacyMode = setItemPagePharmacyMode;
window.navigateTo = navigateTo;
window._applyBranchGuards = _applyBranchGuards;
window._isAllBranches = _isAllBranches;
window.switchBankTab = switchBankTab;

// ── Sales payment filter helpers ───────────────────────────────────────────────
async function onSalesPaymentFilterChange() {
    loadSales();
}

// Pre-populate specific bank/mobile provider options in the sales payment filter dropdown
async function populateSalesPaymentFilterOptions() {
    try {
        const [bankAccts, mobileAccts] = await Promise.all([
            window.BankAPI.list({ ..._branchParam(), account_type: 'bank' }),
            window.BankAPI.list({ ..._branchParam(), account_type: 'mobile_money' }),
        ]);
        const bankGrp   = document.getElementById('bankAccountOptions');
        const mobileGrp = document.getElementById('mobileAccountOptions');
        if (bankGrp) {
            bankGrp.innerHTML = bankAccts.map(a =>
                `<option value="bank:${esc(a.id)}">🏦 ${esc(a.account_name)}${a.bank_name ? ' (' + esc(a.bank_name) + ')' : ''}</option>`
            ).join('');
        }
        if (mobileGrp) {
            mobileGrp.innerHTML = mobileAccts.map(a =>
                `<option value="mobile_money:${esc(a.id)}">📱 ${esc(a.account_name)}${a.bank_name ? ' (' + esc(a.bank_name) + ')' : ''}</option>`
            ).join('');
        }
    } catch (e) { console.error('Failed to load payment filter options:', e); }
}

window.onSalesPaymentFilterChange = onSalesPaymentFilterChange;
window.populateSalesPaymentFilterOptions = populateSalesPaymentFilterOptions;
window._onRealtimeTableChange = _onRealtimeTableChange;
// ── Push notification management (called from Settings page) ──────────────────

async function _checkPushStatus() {
    const box   = document.getElementById('pushStatusBox');
    const text  = document.getElementById('pushStatusText');
    const testBtn = document.getElementById('testPushBtn');
    const enableBtn = document.getElementById('enablePushBtn');
    if (!box) return;

    // Browser support check
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        box.style.background = '#fef2f2';
        box.style.borderColor = '#fca5a5';
        box.querySelector('i').className = 'fas fa-times-circle';
        box.querySelector('i').style.color = 'var(--danger)';
        text.textContent = 'Push not supported on this browser. Use Chrome on Android.';
        text.style.color = 'var(--danger)';
        return;
    }

    const perm = Notification.permission;

    if (perm === 'denied') {
        box.style.background = '#fef2f2'; box.style.borderColor = '#fca5a5';
        box.querySelector('i').className = 'fas fa-ban';
        box.querySelector('i').style.color = 'var(--danger)';
        text.innerHTML = '<b>Blocked.</b> Go to browser Settings → Site Settings → Notifications → allow this site.';
        text.style.color = 'var(--danger)';
        if (enableBtn) enableBtn.disabled = true;
        return;
    }

    if (perm !== 'granted') {
        box.style.background = '#fffbeb'; box.style.borderColor = '#fcd34d';
        box.querySelector('i').className = 'fas fa-exclamation-triangle';
        box.querySelector('i').style.color = '#f59e0b';
        text.textContent = 'Permission not yet granted. Tap Enable below.';
        text.style.color = '#92400e';
        return;
    }

    // Check backend subscription
    try {
        const token = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
        const resp = await fetch(`${window.AppConfig?.API_BASE_URL || '/api'}/push/status`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await resp.json();

        if (!data.configured) {
            box.style.background = '#fef2f2'; box.style.borderColor = '#fca5a5';
            box.querySelector('i').className = 'fas fa-cog';
            box.querySelector('i').style.color = 'var(--danger)';
            text.innerHTML = '<b>VAPID keys not configured on server.</b> Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to Render env vars.';
            text.style.color = 'var(--danger)';
        } else if (data.subscribed) {
            box.style.background = '#f0fdf4'; box.style.borderColor = '#86efac';
            box.querySelector('i').className = 'fas fa-check-circle';
            box.querySelector('i').style.color = '#22c55e';
            text.innerHTML = `<b>Active</b> — ${data.devices} device${data.devices !== 1 ? 's' : ''} subscribed. You will receive push notifications.`;
            text.style.color = '#166534';
            if (testBtn) testBtn.disabled = false;
            if (enableBtn) enableBtn.textContent = '✓ Enabled on this device';
        } else {
            box.style.background = '#fffbeb'; box.style.borderColor = '#fcd34d';
            box.querySelector('i').className = 'fas fa-exclamation-triangle';
            box.querySelector('i').style.color = '#f59e0b';
            text.textContent = 'Permission granted but not subscribed yet. Tap Enable below.';
            text.style.color = '#92400e';
        }
    } catch (e) {
        box.querySelector('i').className = 'fas fa-question-circle';
        text.textContent = 'Could not check push status.';
    }
}

async function enablePushNotifications() {
    const btn = document.getElementById('enablePushBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Setting up…'; }
    try {
        await initPushNotifications();
        showToast('Push notifications enabled on this device!', 'success');
    } catch (e) {
        showToast('Failed to enable push: ' + e.message, 'error');
    }
    setTimeout(_checkPushStatus, 1500);
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bell"></i> Enable Notifications on This Device'; }
}

async function resetPushSubscription() {
    const btn = document.getElementById('resetPushBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Resetting…'; }
    try {
        // Unsubscribe from browser
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            // Tell backend to remove it
            const token = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
            await fetch(`${window.AppConfig?.API_BASE_URL || '/api'}/push/unsubscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ endpoint: sub.endpoint })
            });
            await sub.unsubscribe();
        }
        // Re-register service worker fresh
        const existingReg = await navigator.serviceWorker.getRegistration('/sw.js');
        if (existingReg) await existingReg.unregister();

        showToast('Reset done — re-subscribing now…', 'info');
        await new Promise(r => setTimeout(r, 1000));
        await initPushNotifications();
        showToast('Done! Push notifications reset successfully.', 'success');
    } catch (e) {
        showToast('Reset failed: ' + e.message, 'error');
    }
    setTimeout(_checkPushStatus, 2000);
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-redo"></i> Reset & Re-subscribe (fixes broken push)'; }
}

async function sendTestPush() {
    const btn = document.getElementById('testPushBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…'; }
    try {
        const token = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
        const resp = await fetch(`${window.AppConfig?.API_BASE_URL || '/api'}/push/test`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await resp.json();
        if (data.sent > 0) {
            showToast(`✅ Test push sent to ${data.sent} device(s)! Close this tab and wait a few seconds.`, 'success');
        } else {
            const detail = data.results?.[0]?.detail || 'Unknown error';
            showToast(`Push send failed: ${detail}`, 'error');
            console.error('[Push] Test results:', data.results);
        }
    } catch (e) {
        showToast('Test push failed: ' + e.message, 'error');
    }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Test Push'; }
}

window.setTheme                  = setTheme;
// ── PWA Install Banner ────────────────────────────────────────────────────────
function _showInstallBanner() {
    if (document.getElementById('pwaInstallBanner')) return;
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (window.navigator.standalone === true) return; // iOS already installed

    const banner = document.createElement('div');
    banner.id = 'pwaInstallBanner';
    banner.style.cssText = `
        position:fixed;bottom:0;left:0;right:0;z-index:9999;
        background:var(--surface);border-top:1px solid var(--border);
        padding:12px 16px;display:flex;align-items:center;gap:12px;
        box-shadow:0 -4px 24px rgba(0,0,0,.12);
        animation:slideUp .3s ease;
    `;
    banner.innerHTML = `
        <style>@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}</style>
        <div style="width:40px;height:40px;background:#2563eb;border-radius:10px;
                    display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <span style="color:#fff;font-size:1.2rem;font-weight:700">X</span>
        </div>
        <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:700;color:var(--text-1)">Install Hulu Stock</div>
            <div style="font-size:11px;color:var(--text-3)">Add to home screen for the best experience</div>
        </div>
        <button onclick="installPWA()"
            style="background:var(--primary);color:#fff;border:none;border-radius:8px;
                   padding:8px 16px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;">
            Install
        </button>
        <button onclick="document.getElementById('pwaInstallBanner').remove()"
            style="background:none;border:none;color:var(--text-3);cursor:pointer;
                   font-size:18px;padding:4px;flex-shrink:0;line-height:1;">×</button>
    `;
    document.body.appendChild(banner);
}

async function installPWA() {
    const prompt = window._pwaInstallPrompt;
    if (!prompt) {
        showToast('To install: tap Share → Add to Home Screen (iOS) or use browser menu', 'info');
        return;
    }
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') {
        showToast('Hulu Stock installed! Open it from your home screen', 'success');
    }
    window._pwaInstallPrompt = null;
    const banner = document.getElementById('pwaInstallBanner');
    if (banner) banner.remove();
}

window.filterNotifications       = filterNotifications;
window.installPWA                = installPWA;
window.changeSalesChartPeriod    = changeSalesChartPeriod;
window.enablePushNotifications = enablePushNotifications;
window.resetPushSubscription   = resetPushSubscription;
window.sendTestPush            = sendTestPush;

window.toggleSidebar = toggleSidebar;
window.closeSidebar  = closeSidebar;
window.closeModal = closeModal;
window.logout = logout;
window.showReport    = showReport;
window.reloadReport  = reloadReport;
window.exportToExcel = exportToExcel;
window.printReport   = printReport;
window.openCamera    = openCamera;
window.openScanner   = openScanner;
window.closeScanner  = closeScanner;
window.switchCamera  = switchCamera;
window.toggleTorch   = toggleTorch;
window.manualBarcodeEntry = manualBarcodeEntry;
window.toggleDarkMode = toggleDarkMode;
window.handleSettingsSubmit  = handleSettingsSubmit;
window.onBrandColorInput     = onBrandColorInput;
window.ReceiptSystem         = ReceiptSystem;
window.HardwareSettings      = HardwareSettings;
window.HIDScanner            = HIDScanner;
window.closeSaleSuccess      = closeSaleSuccess;
window.closeReceiptPreview   = closeReceiptPreview;
window.editCategory = editCategory;
window.deleteCategory = deleteCategory;
window.handleCategorySubmit = handleCategorySubmit;
window.editSupplier = editSupplier;
window.deleteSupplier = deleteSupplier;
window.handleSupplierSubmit = handleSupplierSubmit;
window.loadCategories = loadCategories;
window.loadSuppliers = loadSuppliers;
window.openUserModal = openUserModal;
window.handleUserSubmit = handleUserSubmit;
window.openExpenseModal = openExpenseModal;
window.handleExpenseSubmit = handleExpenseSubmit;
window.deleteExpense = deleteExpense;
window.editExpense = editExpense;
window.openBankModal = openBankModal;
window.handleBankSubmit = handleBankSubmit;
window.deleteBankAccount = deleteBankAccount;
window.editBankAccount = editBankAccount;
window.editBranch = editBranch;
window.toggleBranchActive = toggleBranchActive;
window.toggleBankActive = toggleBankActive;
window.toggleUserActive = toggleUserActive;
window.submitTransfer = submitTransfer;
window.loadBranches = loadBranches;
window.editUser = editUser;
window.deleteUser = deleteUser;
window.toggleNotifications = toggleNotifications;
window.loadNotifications = loadNotifications;
window.markAllNotificationsAsRead = markAllNotificationsAsRead;
window.handleNotificationClick = handleNotificationClick;
window.formatTimeAgo = formatTimeAgo;
window.cleanupRealtimeNotifications = cleanupRealtimeNotifications;


// ══════════════════════════════════════════════════════════════════════════════
// PHONE CAMERA MODULE
// ══════════════════════════════════════════════════════════════════════════════
// Option C: Phone opens Hulu Stock in its browser and uses its own camera.
// The result (barcode code or expiry photo b64) is sent back to the PC
// via a Supabase Realtime broadcast channel.
//
// Flow:
//   PC                              Phone
//   ────                            ─────
//   Shows QR code with session URL  User scans QR
//   Waits on Realtime channel       Opens Hulu Stock, logs in
//   _waitingForPhone = true         Taps "Scan for PC" button
//   Receives result                 Camera opens, scans/photos
//   Handles result (barcode/photo)  Result sent via Supabase broadcast
//   _waitingForPhone = false        Phone shows "Done ✓"
// ══════════════════════════════════════════════════════════════════════════════

const PhoneCamera = (() => {
    const SESSION_KEY = 'xpos_phone_cam_session';

    let _channel         = null;   // Supabase broadcast channel
    let _sessionId       = null;   // Unique per-PC session
    let _waiting         = false;  // PC is waiting for a result
    let _waitingType     = null;   // 'barcode' | 'photo'
    let _resolveWait     = null;   // Promise resolver
    let _rejectWait      = null;   // Promise rejecter
    let _waitTimeout     = null;

    // ── Public: init (called from settings page open) ─────────────────────────
    async function init() {
        if (!_supabaseCli) {
            document.getElementById('phoneCamQR').innerHTML =
                '<div style="text-align:center;font-size:12px;color:var(--text-3);padding:8px;">' +
                '<i class="fas fa-exclamation-triangle" style="display:block;font-size:1.5rem;margin-bottom:6px;color:#f59e0b;"></i>' +
                'Supabase not configured.<br>Add SUPABASE_URL and SUPABASE_KEY to config.js</div>';
            return;
        }

        // Session id: keep a stored one only if it's the new 32-hex format;
        // rotate legacy (short, Math.random) ids on first use.
        _sessionId = localStorage.getItem(SESSION_KEY) || '';
        if (!/^[0-9a-f]{32}$/.test(_sessionId)) {
            _sessionId = _genId();
            localStorage.setItem(SESSION_KEY, _sessionId);
        }

        // Build the phone URL — same origin with ?phone_cam=<sessionId> flag
        const url = `${location.origin}${location.pathname}?phone_cam=${_sessionId}`;

        // Render QR code
        _renderQR(url);

        // Show the URL text
        const urlEl = document.getElementById('phoneCamUrl');
        if (urlEl) urlEl.textContent = url;

        // Subscribe to the broadcast channel for this session
        _subscribeChannel();
    }

    function _genId() {
        // Cryptographically random: Math.random() session ids could in
        // principle be predicted, letting a stranger broadcast frames into
        // this POS session's phone-camera channel.
        try {
            const a = new Uint8Array(16);
            (window.crypto || crypto).getRandomValues(a);
            return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            return Math.random().toString(36).slice(2, 10) +
                   Math.random().toString(36).slice(2, 10);
        }
    }

    function _renderQR(url) {
        const el = document.getElementById('phoneCamQR');
        if (!el) return;
        try {
            // Use qrcode-svg library if loaded
            if (typeof QRCode !== 'undefined') {
                const qr = new QRCode({
                    content: url,
                    width: 144,
                    height: 144,
                    padding: 0,
                    color: '#000000',
                    background: '#ffffff',
                    ecl: 'M',
                });
                el.innerHTML = qr.svg();
                el.style.padding = '8px';
                return;
            }
        } catch {}
        // Fallback: just show the URL prominently
        el.innerHTML = `<div style="text-align:center;font-size:10px;font-family:monospace;
            word-break:break-all;padding:8px;color:#1a1a1a;">${url}<br><br>
            <span style="font-size:11px;font-style:normal;opacity:.6;">
            (Open this URL on your phone)</span></div>`;
    }

    function copyLink() {
        const url = document.getElementById('phoneCamUrl')?.textContent;
        if (!url) return;
        navigator.clipboard.writeText(url)
            .then(() => showToast('Link copied — paste it in your phone browser', 'success'))
            .catch(() => showToast('Copy failed — select and copy the URL manually', 'error'));
    }

    // ── Subscribe to Supabase Realtime broadcast channel ─────────────────────
    function _subscribeChannel() {
        if (!_supabaseCli || !_sessionId) return;
        // Remove old channel if exists
        if (_channel) { _supabaseCli.removeChannel(_channel); _channel = null; }

        _channel = _supabaseCli
            .channel(`phone_cam:${_sessionId}`)
            .on('broadcast', { event: 'result' }, (payload) => {
                _onPhoneResult(payload.payload);
            })
            .on('broadcast', { event: 'connected' }, (payload) => {
                _onPhoneConnected(payload.payload?.device || 'Phone');
            })
            .on('broadcast', { event: 'disconnected' }, () => {
                _onPhoneDisconnected();
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('[PhoneCamera] PC channel subscribed, session:', _sessionId);
                }
            });
    }

    function _onPhoneConnected(deviceName) {
        const statusBadge = document.getElementById('phoneCamStatus');
        const connectedDiv = document.getElementById('phoneCamConnected');
        const connectedName = document.getElementById('phoneCamConnectedName');
        if (statusBadge) {
            statusBadge.textContent = 'Connected ✓';
            statusBadge.style.cssText = 'font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;background:#dcfce7;color:#16a34a;';
        }
        if (connectedDiv) connectedDiv.style.display = 'block';
        if (connectedName) connectedName.textContent = deviceName;
        showToast(`📱 ${deviceName} connected as camera`, 'success');
    }

    function _onPhoneDisconnected() {
        const statusBadge = document.getElementById('phoneCamStatus');
        const connectedDiv = document.getElementById('phoneCamConnected');
        if (statusBadge) {
            statusBadge.textContent = 'Disconnected';
            statusBadge.style.cssText = 'font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;background:#fef3c7;color:#d97706;';
        }
        if (connectedDiv) connectedDiv.style.display = 'none';
    }

    function _onPhoneResult(data) {
        console.log('[PhoneCamera] Result received:', data?.type, data?.value?.substring?.(0,20));

        // If PC is explicitly waiting (via request()) — resolve the promise
        if (_waiting && _resolveWait) {
            clearTimeout(_waitTimeout);
            _waiting = false;
            _resolveWait(data);
            _resolveWait = null;
            _rejectWait  = null;
            _dismissWaitModal();
            return;
        }

        // Otherwise auto-route based on current page and result type
        _dismissWaitModal();
        if (data?.type === 'barcode' && data?.value) {
            const code = data.value;
            showToast(`📱 Barcode from phone: ${code}`, 'success');
            // Route to current context
            if (AppState.currentPage === 'pos') {
                _handleScannedCode(code, 'pos');
            } else if (AppState.currentPage === 'items') {
                _handleScannedCode(code, 'item');
            } else {
                // Try to use it as a barcode lookup in whatever page is open
                _handleScannedCode(code, AppState.currentPage === 'pos' ? 'pos' : 'item');
            }
        } else if (data?.type === 'photo' && data?.value) {
            showToast('📱 Photo received from phone', 'success');
            // If Fast Scan is open and waiting for an expiry photo, use it
            if (typeof FastScan !== 'undefined' && window.FastScan?._setPhonePhoto) {
                window.FastScan._setPhonePhoto(data.value);
            }
        }
    }

    // ── PC: request a scan from the phone ────────────────────────────────────
    // Returns a Promise that resolves with { type: 'barcode'|'photo', value: string }
    // or rejects on timeout/cancel
    async function request(type = 'barcode', timeoutMs = 60000) {
        if (!_supabaseCli) {
            showToast('Supabase not configured — cannot use phone camera', 'error');
            return null;
        }
        if (!_channel) _subscribeChannel();

        // Broadcast a request to the phone
        _channel.send({
            type: 'broadcast',
            event: 'request',
            payload: { type, sessionId: _sessionId, timestamp: Date.now() },
        });

        _waiting     = true;
        _waitingType = type;
        _showWaitModal(type);

        return new Promise((resolve, reject) => {
            _resolveWait = resolve;
            _rejectWait  = reject;
            _waitTimeout = setTimeout(() => {
                if (_waiting) {
                    _waiting = false;
                    _resolveWait = null;
                    _dismissWaitModal();
                    showToast('Phone camera timed out — no response', 'warning');
                    resolve(null);
                }
            }, timeoutMs);
        });
    }

    function cancelRequest() {
        if (_waitTimeout) clearTimeout(_waitTimeout);
        _waiting = false;
        if (_rejectWait) _rejectWait(new Error('cancelled'));
        _resolveWait = null; _rejectWait = null;
        _dismissWaitModal();
    }

    function _showWaitModal(type) {
        let modal = document.getElementById('_phoneCamWaitModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = '_phoneCamWaitModal';
            modal.className = 'modal';
            document.body.appendChild(modal);
        }
        const label = type === 'barcode' ? 'Scan the barcode' : 'Take the expiry photo';
        const icon  = type === 'barcode' ? 'fa-barcode' : 'fa-camera';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:360px;text-align:center;">
                <div class="modal-body" style="padding:32px 24px;">
                    <div style="width:64px;height:64px;border-radius:50%;background:var(--primary-ultra);
                                margin:0 auto 20px;display:flex;align-items:center;justify-content:center;">
                        <i class="fas fa-mobile-alt" style="font-size:1.8rem;color:var(--primary);"></i>
                    </div>
                    <h3 style="font-size:17px;font-weight:700;margin:0 0 8px;">Waiting for phone…</h3>
                    <p style="font-size:13px;color:var(--text-3);margin:0 0 20px;">
                        Pick up your phone and tap <strong>${label}</strong>
                    </p>
                    <div style="width:100%;height:4px;background:var(--border);border-radius:4px;overflow:hidden;margin-bottom:20px;">
                        <div style="height:100%;background:var(--primary);border-radius:4px;
                                    animation:phone-wait-bar 2s ease-in-out infinite alternate;width:30%;"></div>
                    </div>
                    <button onclick="PhoneCamera.cancelRequest()" class="btn btn-secondary" style="width:100%;">
                        Cancel
                    </button>
                </div>
            </div>`;
        modal.classList.add('active'); modal.style.display = '';
    }

    function _dismissWaitModal() {
        const modal = document.getElementById('_phoneCamWaitModal');
        if (modal) { modal.classList.remove('active'); }
    }

    // ── Check if phone camera is available and connected ──────────────────────
    function isConnected() {
        return !!_channel;
    }

    // ── Detect if THIS page is being opened by a phone via QR code ───────────
    function isPhoneMode() {
        return new URLSearchParams(location.search).has('phone_cam');
    }

    function getPhoneSessionId() {
        return new URLSearchParams(location.search).get('phone_cam');
    }

    return {
        init, copyLink, request, cancelRequest, isConnected,
        isPhoneMode, getPhoneSessionId,
        get sessionId() { return _sessionId; }
    };
})();

window.PhoneCamera = PhoneCamera;

// ── Sale Return Modal ─────────────────────────────────────────────────────────
let _returnSaleId   = null;
let _returnSaleData = null;

async function openReturnModal(saleId) {
    _returnSaleId = saleId;
    try {
        _returnSaleData = await window.SalesAPI.get(saleId);
    } catch {
        showToast('Failed to load sale details', 'error');
        return;
    }

    let modal = document.getElementById('returnModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'returnModal';
        modal.className = 'modal';
        document.body.appendChild(modal);
    }

    const items = _returnSaleData.items || [];
    const _retByItem = _returnSaleData.returned_by_item || {};
    const rows = items.map(it => {
        const _sold = Number(it.quantity) || 0;
        const _ret = Number(_retByItem[it.item_id] || _retByItem[String(it.item_id)] || 0);
        const _left = Math.max(0, Math.round((_sold - _ret) * 1000000) / 1000000);
        return `
        <tr>
            <td style="padding:8px 6px;font-size:13px;">${esc(it.item_name || it.name || 'Item')}${_ret > 0 ? ` <span style="color:var(--text-3);font-size:11px;">(returned ${_ret})</span>` : ''}</td>
            <td style="padding:8px 6px;font-size:13px;text-align:center;">${_left}</td>
            <td style="padding:8px 6px;text-align:center;">
                <input type="number" id="ret_${esc(it.item_id)}" min="0" max="${_left}" value="${_left}"
                    style="width:64px;padding:5px;border:1.5px solid var(--border);border-radius:7px;
                           font-size:13px;text-align:center;background:var(--surface);color:var(--text-1);" ${_left <= 0 ? 'disabled' : ''}>
            </td>
        </tr>`;
    }).join('');

    modal.innerHTML = `
        <div class="modal-content" style="max-width:480px;">
            <div class="modal-header">
                <h3 class="modal-title"><i class="fas fa-undo-alt mr-2" style="color:#f59e0b;"></i>Process Return</h3>
                <button class="modal-close" onclick="closeModal('returnModal')"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <p style="font-size:13px;color:var(--text-2);margin:0 0 14px;">
                    Invoice: <strong>${esc(_returnSaleData.invoice_number)}</strong> —
                    Set return quantities for each item (0 = not returned).
                </p>
                <table style="width:100%;border-collapse:collapse;">
                    <thead>
                        <tr style="border-bottom:1.5px solid var(--border);">
                            <th style="padding:6px;text-align:left;font-size:11px;color:var(--text-3);">ITEM</th>
                            <th style="padding:6px;text-align:center;font-size:11px;color:var(--text-3);">SOLD</th>
                            <th style="padding:6px;text-align:center;font-size:11px;color:var(--text-3);">RETURN QTY</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                <div class="form-group" style="margin-top:16px;margin-bottom:0;">
                    <label class="form-label">Reason for Return</label>
                    <input type="text" id="returnReason" class="form-input" placeholder="e.g. Damaged, Wrong item, Customer changed mind" autocomplete="off">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('returnModal')">Cancel</button>
                <button class="btn" onclick="confirmReturn()"
                    style="background:#f59e0b;color:#fff;border:none;">
                    <i class="fas fa-undo-alt"></i> Confirm Return
                </button>
            </div>
        </div>`;

    modal.classList.add('active');
    modal.style.display = '';
}

async function confirmReturn() {
    if (!_returnSaleId || !_returnSaleData) return;
    const items  = _returnSaleData.items || [];
    const reason = document.getElementById('returnReason')?.value?.trim() || 'Customer return';
    const returnItems = items
        .map(it => ({ item_id: it.item_id, quantity: parseFloat(document.getElementById(`ret_${it.item_id}`)?.value || 0) }))
        .filter(r => r.quantity > 0);

    if (!returnItems.length) { showToast('No items selected for return', 'error'); return; }

    const btn = document.querySelector('#returnModal .btn[onclick="confirmReturn()"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing…'; }

    try {
        const result = await window.API.post(`/sales/${_returnSaleId}/return`, { items: returnItems, reason });
        showToast(`✅ Return processed — Credit ${result.credit_invoice} · Refund ${formatCurrency(result.refund_amount)}`, 'success');
        closeModal('returnModal');
        if (typeof loadSales === 'function') loadSales();
    } catch (err) {
        showToast(err.message || 'Return failed', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-undo-alt"></i> Confirm Return'; }
    }
}


// ── Inventory CSV export ──────────────────────────────────────────────────────
async function exportInventoryCSV() {
    const btn = event?.target?.closest('button');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Exporting…'; }
    try {
        const token = window.API?.getToken?.() || localStorage.getItem('rf_auth_token') || '';
        const base  = window.AppConfig?.API_BASE_URL || 'http://localhost:8000/api';
        const branchId = AppState.branch?.id;
        const exportUrl = branchId
            ? `${base}/reports/inventory-export?branch_id=${branchId}`
            : `${base}/reports/inventory-export`;
        const resp  = await fetch(exportUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!resp.ok) throw new Error('Export failed');
        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `inventory_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('✅ Inventory exported', 'success');
    } catch (e) {
        showToast(e.message || 'Export failed', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-file-csv"></i> Export CSV'; }
    }
}

// ── Bulk stock adjust modal ───────────────────────────────────────────────────
async function openBulkStockAdjustModal() {
    let modal = document.getElementById('_bulkAdjModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = '_bulkAdjModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:540px;">
                <div class="modal-header">
                    <h3 class="modal-title"><i class="fas fa-layer-group mr-2" style="color:#f59e0b;"></i>Bulk Stock Adjustment</h3>
                    <button class="modal-close" onclick="closeModal('_bulkAdjModal')"><i class="fas fa-times"></i></button>
                </div>
                <div class="modal-body">
                    <p style="font-size:13px;color:var(--text-3);margin:0 0 14px;">
                        Paste or type adjustments — one per line in format:<br>
                        <code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-size:12px;">BARCODE, qty, add|subtract|set</code>
                    </p>
                    <textarea id="_bulkAdjText" class="form-input" rows="8" placeholder="8714100772523, 10, add&#10;6291103660654, 5, subtract&#10;8901030895245, 20, set"
                        style="font-family:monospace;font-size:13px;resize:vertical;"></textarea>
                    <div id="_bulkAdjResult" style="margin-top:12px;font-size:13px;color:var(--text-2);min-height:20px;"></div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('_bulkAdjModal')">Cancel</button>
                    <button class="btn btn-primary" id="_bulkAdjBtn" onclick="processBulkStockAdj()">
                        <i class="fas fa-check"></i> Apply Adjustments
                    </button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }
    document.getElementById('_bulkAdjText').value = '';
    document.getElementById('_bulkAdjResult').textContent = '';
    modal.classList.add('active'); modal.style.display = '';
}

async function processBulkStockAdj() {
    const text = document.getElementById('_bulkAdjText')?.value?.trim() || '';
    if (!text) { showToast('Nothing to process', 'error'); return; }

    // Parse lines: BARCODE, qty, type
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const adjustments = [];
    const errors = [];

    // First resolve barcodes to item IDs
    for (const line of lines) {
        const parts = line.split(',').map(p => p.trim());
        if (parts.length < 3) { errors.push(`Bad format: ${line}`); continue; }
        const [barcode, qtyStr, type] = parts;
        const qty = parseInt(qtyStr);
        if (isNaN(qty) || qty < 0) { errors.push(`Invalid qty: ${line}`); continue; }
        if (!['add','subtract','set'].includes(type)) { errors.push(`Invalid type (use add/subtract/set): ${line}`); continue; }
        try {
            const item = await window.ItemsAPI.getByBarcode(barcode);
            adjustments.push({ item_id: item.id, quantity: qty, type, reason: 'Bulk adjustment' });
        } catch { errors.push(`Barcode not found: ${barcode}`); }
    }

    if (errors.length) {
        document.getElementById('_bulkAdjResult').innerHTML =
            `<span style="color:var(--danger);">⚠️ Errors:<br>${errors.map(e=>`• ${esc(e)}`).join('<br>')}</span>`;
        if (!adjustments.length) return;
    }

    const btn = document.getElementById('_bulkAdjBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing…'; }

    try {
        const result = await window.API.post('/items/bulk-stock-adjust', { adjustments });
        showToast(`✅ Adjusted ${result.adjusted} items${result.failed ? ` · ${result.failed} failed` : ''}`, 'success');
        document.getElementById('_bulkAdjResult').innerHTML =
            `<span style="color:#10b981;">✅ ${result.adjusted} items adjusted${result.failed ? `, ${result.failed} failed` : ''}</span>`;
        loadItems();
        if (result.failed === 0) setTimeout(() => closeModal('_bulkAdjModal'), 1500);
    } catch (e) {
        showToast(e.message || 'Bulk adjust failed', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Apply Adjustments'; }
    }
}

window.exportInventoryCSV     = exportInventoryCSV;
window.openBulkStockAdjustModal = openBulkStockAdjustModal;
window.processBulkStockAdj    = processBulkStockAdj;

window.openReturnModal = openReturnModal;
window.confirmReturn   = confirmReturn;
