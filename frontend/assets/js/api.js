/**
 * Hulu Stock POS - API Service
 * Central API communication layer
 * Production mode - all data fetched from real API
 */

class APIService {
    constructor() {
        this.baseURL = window.AppConfig?.API_BASE_URL || 'http://localhost:8000/api';
        this.token = localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
    }

    // Get auth token
    getToken() {
        return this.token || localStorage.getItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
    }

    // Set auth token
    setToken(token) {
        this.token = token;
        localStorage.setItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token', token);
    }

    // Clear auth token
    clearToken() {
        this.token = null;
        localStorage.removeItem(window.AppConfig?.STORAGE_KEYS?.AUTH_TOKEN || 'rf_auth_token');
    }

    userSafeErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
        const raw = String(error?.message || error || '');
        if (!raw) return fallback;
        if (error?.name === 'AbortError' || /timeout|timed out|aborted/i.test(raw)) {
            return 'The request took too long. Please check your connection and try again.';
        }
        if (/failed to fetch|networkerror|load failed|connection refused|err_network|err_internet|cors/i.test(raw)) {
            return 'We could not reach the server. Please check your internet connection and try again.';
        }
        // Never expose backend hostnames/URLs in user-facing errors.
        return raw
            .replace(/https?:\/\/[^\s)]+/gi, 'the server')
            .replace(/(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s)]*)?/gi, 'the server')
            .replace(/localhost(?::\d+)?(?:\/[^\s)]*)?/gi, 'the server')
            .trim() || fallback;
    }

    // Make API request - production mode, no mock data
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };

        const token = this.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            // Add timeout controller
            const controller = new AbortController();
            // Timeout strategy:
            //  /fast-scan/batch-process — up to 120s (Gemini parallel calls for many items)
            //  /vision/ single scan     — up to 60s
            //  everything else          — 15s
            const isBatch  = endpoint.includes('/fast-scan/batch') || endpoint.includes('/fast-scan/retry');
            const isVision = endpoint.includes('/vision/') || endpoint.includes('/fast-scan/');
            const timeoutMs = isBatch ? 120000 : isVision ? 60000 : 15000;
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(url, {
                ...options,
                headers,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Handle 401 Unauthorized
            if (response.status === 401) {
                // For login endpoint — read the actual error message from body
                if (endpoint.includes('/auth/login')) {
                    const errData = await response.json().catch(() => ({}));
                    const rawDetail = errData.detail;
                    const msg = typeof rawDetail === 'object' && rawDetail !== null
                        ? (rawDetail.message || 'Invalid credentials')
                        : (rawDetail || errData.message || 'Invalid email or password');
                    throw new Error(msg);
                }
                // For other endpoints — try token refresh once before redirecting
                if (!endpoint.includes('/auth/refresh')) {
                    try {
                        const refreshResp = await fetch(`${this.baseURL}/auth/refresh`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${this.getToken()}`, 'Content-Type': 'application/json' }
                        });
                        if (refreshResp.ok) {
                            const refreshData = await refreshResp.json();
                            if (refreshData.access_token) {
                                this.setToken(refreshData.access_token);
                                const retryHeaders = { ...headers, 'Authorization': `Bearer ${refreshData.access_token}` };
                                const retryResp = await fetch(url, { ...options, headers: retryHeaders });
                                if (retryResp.ok) return retryResp.json();
                            }
                        }
                    } catch (_) { /* refresh failed, fall through to logout */ }
                }
                this.clearToken();
                window.location.href = '/login.html';
                throw new Error('Session expired — please log in again');
            }

            // Handle 403 Forbidden
            if (response.status === 403) {
                throw new Error('Access denied - You do not have permission to perform this action');
            }

            // Handle 404 Not Found — read body for actual message
            if (response.status === 404) {
                const errData = await response.json().catch(() => ({}));
                const rawDetail = errData.detail;
                const msg = typeof rawDetail === 'object' && rawDetail !== null
                    ? (rawDetail.message || 'Resource not found')
                    : (rawDetail || errData.message || 'Resource not found');
                throw new Error(msg);
            }

            // Handle 500+ Server Errors
            if (response.status >= 500) {
                throw new Error('Server error - Please try again later');
            }

            const data = await response.json();

            if (!response.ok) {
                // detail may be a string or a dict like {message: ..., existing_id: ...}
                const rawDetail = data.detail;
                const detailMsg = typeof rawDetail === 'object' && rawDetail !== null
                    ? (rawDetail.message || JSON.stringify(rawDetail))
                    : (rawDetail || data.message || 'An error occurred');
                const error = new Error(detailMsg);
                error.response = { data, status: response.status }; // Attach full response
                throw error;
            }

            return data;
        } catch (error) {
            // Handle fetch abort (timeout)
            const safeMessage = this.userSafeErrorMessage(error);
            if (error.name === 'AbortError') {
                console.error('API request timed out:', { endpoint, error });
                throw new Error(safeMessage);
            }

            // Handle network errors without exposing backend URLs to cashiers/admins.
            if (error.message && /Failed to fetch|NetworkError|Load failed|ERR_NETWORK|ERR_INTERNET|CORS/i.test(error.message)) {
                console.error('API network error:', { endpoint, error });
                throw new Error(safeMessage);
            }

            console.error('API Error:', { endpoint, error });
            throw new Error(safeMessage);
        }
    }

    // GET request — strips undefined/null values so they don't appear as "undefined" strings
    async get(endpoint, params = {}) {
        const clean = Object.fromEntries(
            Object.entries(params || {}).filter(([_, v]) => v !== undefined && v !== null && v !== '')
        );
        const queryString = new URLSearchParams(clean).toString();
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        return this.request(url, { method: 'GET' });
    }

    // POST request
    async post(endpoint, data) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    // PUT request
    async put(endpoint, data) {
        return this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    // DELETE request
    async delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    }

    // Upload file (for image uploads)
    async uploadFile(endpoint, file, fieldName = 'image') {
        const formData = new FormData();
        formData.append(fieldName, file);

        const token = this.getToken();
        const headers = {};
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            const response = await fetch(`${this.baseURL}${endpoint}`, {
                method: 'POST',
                headers,
                body: formData
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.detail || data.message || 'Upload failed');
            }

            return data;
        } catch (error) {
            console.error('API upload error:', { endpoint, error });
            throw new Error(this.userSafeErrorMessage(error, 'Upload failed. Please try again.'));
        }
    }

    // Disable demo mode (delegate to AppConfig)
    disableDemoMode() {
        if (window.AppConfig && window.AppConfig.disableDemoMode) {
            window.AppConfig.disableDemoMode();
        } else {
            // Fallback if AppConfig is not available
            localStorage.setItem('rf_demo_mode', 'false');
            console.log('Demo mode disabled - using production API');
        }
    }

    // Enable demo mode (delegate to AppConfig)
    enableDemoMode() {
        if (window.AppConfig && window.AppConfig.enableDemoMode) {
            window.AppConfig.enableDemoMode();
        } else {
            // Fallback if AppConfig is not available
            localStorage.setItem('rf_demo_mode', 'true');
            console.warn('WARNING: Demo mode is being enabled - this should only be used for testing!');
        }
    }
}

// Create global API instance
window.API = new APIService();

// Auth API
window.AuthAPI = {
    login: (email, password) => window.API.post('/auth/login', { email, password }),
    logout: () => {
        window.API.clearToken();
        localStorage.removeItem('rf_user');
        localStorage.removeItem('rf_organization');
        localStorage.removeItem('rf_branch');
        window.location.href = '/login.html';
    },
    me: () => window.API.get('/auth/me')
};

// Organizations API
window.OrganizationsAPI = {
    get: () => window.API.get('/organizations/current'),
    update: (data) => window.API.put('/organizations/current', data)
};

// Branches API
window.BranchesAPI = {
    list: (params) => window.API.get('/branches', params),
    get: (id) => window.API.get(`/branches/${id}`),
    create: (data) => window.API.post('/branches', data),
    update: (id, data) => window.API.put(`/branches/${id}`, data),
    delete: (id) => window.API.delete(`/branches/${id}`)
};

// Items API
window.ItemsAPI = {
    list: (params) => window.API.get('/items', params),
    get: (id) => window.API.get(`/items/${id}`),
    getByBarcode: (barcode) => window.API.get(`/items/barcode/${barcode}`),
    create: (data) => window.API.post('/items', data),
    update: (id, data) => window.API.put(`/items/${id}`, data),
    delete: (id) => window.API.delete(`/items/${id}`),
    updateStock: (id, quantity, type, batch = {}) => window.API.put(`/items/${id}/stock`, { quantity, type, ...batch }),
    uploadImage: (id, file) => window.API.uploadFile(`/items/upload-image/${id}`, file),
    listUnits: () => window.API.get('/items/units'),
    createUnit: (data) => window.API.post('/items/units', data),
    listUnitConversions: (params) => window.API.get('/items/unit-conversions', params),
    createUnitConversion: (data) => window.API.post('/items/unit-conversions', data),
    listBatches: (itemId) => window.API.get(`/items/${itemId}/batches`),
    listPackagingTiers: (itemId) => window.API.get(`/items/${itemId}/packaging-tiers`),
    savePackagingTiers: (itemId, data) => window.API.put(`/items/${itemId}/packaging-tiers`, data)
};

// Categories API
window.CategoriesAPI = {
    list: (params) => window.API.get('/categories', params),
    get: (id) => window.API.get(`/categories/${id}`),
    create: (data) => window.API.post('/categories', data),
    update: (id, data) => window.API.put(`/categories/${id}`, data),
    delete: (id) => window.API.delete(`/categories/${id}`)
};

// Suppliers API
window.SuppliersAPI = {
    list: (params) => window.API.get('/suppliers', params),
    get: (id) => window.API.get(`/suppliers/${id}`),
    create: (data) => window.API.post('/suppliers', data),
    update: (id, data) => window.API.put(`/suppliers/${id}`, data),
    delete: (id) => window.API.delete(`/suppliers/${id}`)
};

// Users API
window.UsersAPI = {
    list: (params) => window.API.get('/users', params),
    get: (id) => window.API.get(`/users/${id}`),
    create: (data) => window.API.post('/users', data),
    update: (id, data) => window.API.put(`/users/${id}`, data),
    delete: (id) => window.API.delete(`/users/${id}`)
};

// Sales API
window.SalesAPI = {
    list: (params) => window.API.get('/sales', params),
    get: (id) => window.API.get(`/sales/${id}`),
    create: (data) => window.API.post('/sales', data),
    dailySummary: (date) => window.API.get('/sales/daily-summary', { date }),
    return: (saleId, data) => window.API.post(`/sales/${saleId}/return`, data)
};

// Expenses API
window.ExpensesAPI = {
    list: (params) => window.API.get('/expenses', params),
    get: (id) => window.API.get(`/expenses/${id}`),
    create: (data) => window.API.post('/expenses', data),
    update: (id, data) => window.API.put(`/expenses/${id}`, data),
    delete: (id) => window.API.delete(`/expenses/${id}`)
};

// Bank Accounts API
window.BankAPI = {
    list: (params) => window.API.get('/bank-accounts', params),
    get: (id) => window.API.get(`/bank-accounts/${id}`),
    create: (data) => window.API.post('/bank-accounts', data),
    update: (id, data) => window.API.put(`/bank-accounts/${id}`, data),
    delete: (id) => window.API.delete(`/bank-accounts/${id}`),
    transfer: (data) => window.API.post('/bank-accounts/transfer', data),
    transfers: (params) => window.API.get('/bank-accounts/transfers', params)
};

// Dashboard API
window.DashboardAPI = {
    stats: (branchId) => window.API.get('/dashboard/stats', { branch_id: branchId }),
    salesChart: (days, branchId) => window.API.get('/dashboard/sales-chart', { days, branch_id: branchId }),
    topItems: (limit, branchId) => window.API.get('/dashboard/top-items', { limit, branch_id: branchId }),
    lowStockItems: (limit, branchId) => window.API.get('/dashboard/low-stock-items', { limit, branch_id: branchId }),
    expiringItems: (days, limit, branchId) => window.API.get('/dashboard/expiring-items', { days, limit, branch_id: branchId }),
    recentSales: (limit, branchId) => window.API.get('/dashboard/recent-sales', { limit, branch_id: branchId })
};

// Reports API
window.ReportsAPI = {
    inventory: (params) => window.API.get('/reports/inventory', params),
    profit: (params) => window.API.get('/reports/profit', params),
    sales: (params) => window.API.get('/reports/sales', params),
    daily: (params) => window.API.get('/reports/daily', params),
    monthly: (params) => window.API.get('/reports/monthly', params),
    byItem: (params) => window.API.get('/reports/by-item', params),
    topSelling: (params) => window.API.get('/reports/top-selling', params),
    expenses: (params) => window.API.get('/reports/expenses', params),
    stockValuation: (params) => window.API.get('/reports/stock-valuation', params),
    salesExport: (params) => window.API.get('/reports/sales-export', params),
};

// Notifications API
window.NotificationsAPI = {
    list: (params) => window.API.get('/notifications', params),
    unreadCount: () => window.API.get('/notifications/unread-count'),
    markAsRead: (id) => window.API.put(`/notifications/${id}/read`),
    markAllAsRead: () => window.API.put('/notifications/read-all'),
    delete: (id) => window.API.delete(`/notifications/${id}`),
    deleteAll: () => window.API.delete('/notifications')
};

console.log('API Service initialized - Production mode');

// Vision / AI API
window.VisionAPI = {
    ocr:          (data) => window.API.post('/vision/ocr',      data),
    identify:     (data) => window.API.post('/vision/identify', data),
    usage:        ()     => window.API.get('/vision/usage'),
    createCategory:(data)=> window.API.post('/vision/category', data),
};
