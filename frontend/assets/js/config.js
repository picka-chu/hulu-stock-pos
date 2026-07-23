/**
 * Hulu Stock Configuration
 * Clean Production Version
 */

window.AppConfig = {

    // API Configuration — auto-detect environment
    API_BASE_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:8000/api'
        : (window._env_?.API_BASE_URL || 'https://hulustocks.onrender.com/api'),

    // ── Supabase Realtime (for push notifications) ──────────────────────────
    // Configure via server-side settings or env vars to avoid committing keys.
    // These are placeholder values — replace with your actual project values at deploy time.
    SUPABASE_URL: '',   // ← MUST be set via environment or deploy pipeline
    SUPABASE_KEY: '',   // ← MUST be set via environment or deploy pipeline
    // ⚠️  DO NOT hardcode Supabase keys in this file. Set via ENV or build-time injection.
    // ────────────────────────────────────────────────────────────────────────

    // App Info
    APP_NAME: 'Hulu Stock',
    APP_VERSION: '1.0.0',

    DEFAULT_CURRENCY: 'ETB',
    DEFAULT_CURRENCY_SYMBOL: 'Br',

    STORAGE_KEYS: {
        AUTH_TOKEN: 'rf_auth_token',
        USER_DATA: 'rf_user_data',
        ORGANIZATION: 'rf_organization',
        BRANCH: 'rf_branch',
        THEME: 'rf_theme',
        SIDEBAR_COLLAPSED: 'rf_sidebar_collapsed'
    },

    DEMO_MODE: false,

    enableDemoMode: function () {
        localStorage.setItem('rf_demo_mode', 'true');
        this.DEMO_MODE = true;
    },

    disableDemoMode: function () {
        localStorage.setItem('rf_demo_mode', 'false');
        this.DEMO_MODE = false;
    }
};

// Config loaded
