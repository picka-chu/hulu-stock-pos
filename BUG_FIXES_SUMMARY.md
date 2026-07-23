# Bug Fixes Summary - Hulu Stock POS

## Overview
This document summarizes the fixes applied to address the reported bugs and improvements for the Hulu Stock POS system.

---

## Fix 1: Branch Selector Persistence on Page Refresh

### Problem
When admin users refresh the page, the branch selector resets to "All Branches" instead of remembering the previously selected branch.

### Root Cause
In `app.js`, the `loadBranchesForSelect()` function was called with `null` as the second parameter, which prevented the previously selected branch from being pre-selected after a page refresh.

### Solution
Modified `frontend/assets/js/app.js` line 364:
```javascript
// Before:
await loadBranchesForSelect('branchSelector', null, 'All Branches');

// After:
await loadBranchesForSelect('branchSelector', AppState.branch?.id, 'All Branches');
```

### Files Modified
- `frontend/assets/js/app.js`

---

## Fix 2: Sales Report Branch Column Showing "-"

### Problem
When viewing sales reports, the branch column shows "-" instead of the actual branch name where the sale was made.

### Root Cause
The `SaleResponse` model did not include a `branch_name` field, and the backend was not joining the branch data when fetching sales.

### Solution
1. Added `branch_name` field to `SaleResponse` model in `backend/models.py`
2. Updated `_build_sale_response()` function to accept and include `branch_name`
3. Modified `get_sales()` to bulk fetch branch names and include them in the response
4. Modified `get_sale()` to fetch and include the branch name for single sale lookups
5. Modified `create_sale()` to pass the branch name in the response

### Files Modified
- `backend/models.py`
- `backend/routes/sales.py`

### Key Changes

**models.py** - Added branch_name to SaleResponse:
```python
class SaleResponse(BaseModel):
    # ... existing fields ...
    branch_name: Optional[str] = None  # Branch name for display
```

**sales.py** - Bulk fetch branch names in get_sales():
```python
# Bulk fetch branch names for all sales
branch_ids = list(set(s.get("branch_id") for s in sales if s.get("branch_id")))
branch_names = {}
if branch_ids:
    branch_resp = await asyncio.to_thread(
        lambda: client.table("branches").select("id,name").in_("id", branch_ids).execute()
    )
    for b in (branch_resp.data or []):
        branch_names[b["id"]] = b["name"]
```

---

## Fix 3: "All Branch" Selector Visibility Restriction

### Problem
The "All Branch" selector was visible on all pages, including pages where branch selection is not relevant (like Settings, Users, Notifications).

### Solution
1. Added a wrapper element with class `branch-selector-wrap` around the branch selector in `index.html`
2. Created a new function `_updateBranchSelectorVisibility()` that shows/hides the selector based on the current page
3. Added a constant `_BRANCH_SELECTOR_PAGES` that defines which pages should show the branch selector
4. Called the visibility function during navigation and initialization

### Files Modified
- `frontend/index.html`
- `frontend/assets/js/app.js`

### Pages Where Branch Selector is Visible
- Dashboard
- POS (Point of Sale)
- Items
- Categories
- Suppliers
- Sales
- Expenses
- Bank Accounts
- Reports
- Branches

### Pages Where Branch Selector is Hidden
- Settings
- Users
- Notifications

---

## Fix 4: Fast Scan Expiry Date Missing - Debug Logging Added

### Problem
Items created via fast scan were missing their expiry date when edited. It was unclear whether:
- Gemini AI extracted the expiry date but it wasn't saved
- Gemini AI failed to extract the expiry date from the image

### Solution
Added comprehensive debug logging to track the expiry date through the entire processing pipeline:

1. In `_call_expiry_vision()` - Log the raw AI response before parsing
2. In `batch_process()` - Log the expiry date resolution showing:
   - AI extracted expiry date
   - Manual (user-typed) expiry date
   - Final resolved expiry date
   - What was actually saved to the database

### Files Modified
- `backend/routes/fast_scan.py`

### Example Debug Log Output
```
[FastScan] DEBUG Expiry vision raw response (item=xxx): '{"expiry_date": "2025-06-30"}'
[FastScan] DEBUG item=xxx barcode=123456789: ai_expiry='2025-06-30' | manual_expiry=None | resolved_expiry='2025-06-30' | update_data.expiry_date='2025-06-30'
```

### How to Use These Logs
1. Create an item using fast scan
2. Process the item with AI (tap Done)
3. Check the backend logs for entries with `[FastScan] DEBUG`
4. The logs will show exactly what Gemini returned and what was saved

---

## Fix 5: Category Template Creates on Wrong Branch

### Problem
When creating categories using built-in templates while in a specific branch (e.g., Branch 2), the categories were being created on the main branch instead of the selected branch.

### Root Cause
In `smart-scan.js`, the `applyTemplate()` function was passing `branch_id: null` when the user was in "All Branches" mode. The backend then fell back to `current_user.branch_id`, which was the main branch for admins.

### Solution

**Frontend (`smart-scan.js`):**
Only pass `branch_id` when a specific branch is selected:
```javascript
// Before:
const r = await window.API.post(`/vision/category/template/${templateName}`, {
    branch_id: window.AppState?.branch?.id || null
});

// After:
const payload = {};
if (window.AppState?.branch?.id) {
    payload.branch_id = window.AppState.branch.id;
}
const r = await window.API.post(`/vision/category/template/${templateName}`, payload);
```

**Backend (`vision.py`):**
Only use the branch_id from the request body if explicitly provided:
```python
# Before:
branch_id_param = body.branch_id or current_user.get("branch_id") or None

# After:
branch_id_param = body.branch_id if body.branch_id is not None else None
```

### Files Modified
- `frontend/assets/js/smart-scan.js`
- `backend/routes/vision.py`

---

## Summary of All Modified Files

| File | Changes |
|------|---------|
| `frontend/index.html` | Added wrapper div for branch selector |
| `frontend/assets/js/app.js` | Fixed branch persistence, added selector visibility control |
| `frontend/assets/js/smart-scan.js` | Fixed template branch selection |
| `backend/models.py` | Added branch_name to SaleResponse |
| `backend/routes/sales.py` | Added branch name fetching and inclusion |
| `backend/routes/fast_scan.py` | Added debug logging for expiry dates |
| `backend/routes/vision.py` | Fixed template category branch assignment |

---

## Testing Recommendations

### Test Fix 1: Branch Selector Persistence
1. Select a specific branch (e.g., Branch 2)
2. Refresh the page
3. Verify the branch selector still shows Branch 2

### Test Fix 2: Sales Report Branch
1. Create a sale at a specific branch
2. Go to Sales report
3. Verify the branch column shows the correct branch name

### Test Fix 3: Branch Selector Visibility
1. Navigate to Settings page
2. Verify branch selector is hidden
3. Navigate to Dashboard or POS
4. Verify branch selector is visible

### Test Fix 4: Fast Scan Expiry Date
1. Create an item using fast scan with expiry photo
2. Process with AI (tap Done)
3. Check backend logs for DEBUG entries
4. Edit the created item
5. Verify expiry date is displayed correctly

### Test Fix 5: Category Template Branch
1. Select a specific branch (e.g., Branch 2)
2. Go to Categories page
3. Click "Add from Template"
4. Apply a template (e.g., Pharmacy)
5. Verify categories are created under Branch 2, not main branch

---

## Rollback Instructions

If you need to rollback any of these fixes:

1. **Fix 1**: Revert the change in `app.js` line 364 back to `null`
2. **Fix 2**: Remove `branch_name` from `SaleResponse` and revert `_build_sale_response` calls
3. **Fix 3**: Remove the visibility control function and wrapper div
4. **Fix 4**: Remove the debug log statements in `fast_scan.py`
5. **Fix 5**: Revert both frontend and backend changes for template branch handling

---

*Generated: 2026-03-18*
*Hulu Stock POS System*
