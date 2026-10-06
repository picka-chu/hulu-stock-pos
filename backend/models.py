"""
Pydantic Models for Request/Response Validation
All data models for the POS system
"""
from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List, Any, Dict
from datetime import datetime, date
from uuid import UUID
from enum import Enum

# ==================== ENUMS ====================
class UserRole(str, Enum):
    ADMIN = "admin"
    MANAGER = "manager"
    CASHIER = "cashier"

class PaymentStatus(str, Enum):
    PENDING = "pending"
    PAID = "paid"
    PARTIAL = "partial"
    REFUNDED = "refunded"
    RETURNED = "returned"
    PARTIAL_RETURN = "partial_return"

class PaymentMethod(str, Enum):
    CASH = "cash"
    BANK = "bank"
    MOBILE_MONEY = "mobile_money"
    CARD = "card"

class StockMovementType(str, Enum):
    SALE = "sale"
    RESTOCK = "restock"
    ADJUSTMENT = "adjustment"
    RETURN = "return"
    TRANSFER = "transfer"
    EXPIRED = "expired"

class ExpenseType(str, Enum):
    OPERATIONAL = "operational"
    SALARY = "salary"
    RENT = "rent"
    UTILITIES = "utilities"
    MAINTENANCE = "maintenance"
    OTHER = "other"

class TransferType(str, Enum):
    CASH_TO_BANK = "cash_to_bank"
    BANK_TO_CASH = "bank_to_cash"
    CASH_DEPOSIT = "cash_deposit"
    CASH_WITHDRAWAL = "cash_withdrawal"

class ShiftStatus(str, Enum):
    OPEN = "open"
    CLOSED = "closed"
    ADJUSTED = "adjusted"

# ==================== ORGANIZATION ====================
class OrganizationBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    tenant_type: str = Field(default="retail", pattern="^(pharma|cosmetics|retail|supermarket)$")
    logo_url: Optional[str] = None
    brand_color: str = Field(default="#2563EB", max_length=20)
    currency: str = Field(default="USD", max_length=10)
    tax_percentage: float = Field(default=0.0, ge=0, le=100)
    timezone: str = Field(default="Africa/Addis_Ababa", max_length=64)

class OrganizationCreate(OrganizationBase):
    pass

class OrganizationUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    logo_url: Optional[str] = None
    brand_color: Optional[str] = Field(None, max_length=20)
    currency: Optional[str] = Field(None, max_length=10)
    tax_percentage: Optional[float] = Field(None, ge=0, le=100)
    is_active: Optional[bool] = None
    timezone: Optional[str] = Field(None, max_length=64)
    tenant_type: Optional[str] = Field(None, pattern="^(pharma|cosmetics|retail|supermarket)$")

class OrganizationResponse(OrganizationBase):
    id: UUID
    subscription_plan: str
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

# ==================== BRANCH ====================
class BranchBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    location: Optional[str] = None
    phone: Optional[str] = Field(None, max_length=50)
    email: Optional[EmailStr] = None

class BranchCreate(BranchBase):
    organization_id: UUID

class BranchUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    location: Optional[str] = None
    phone: Optional[str] = Field(None, max_length=50)
    email: Optional[EmailStr] = None
    is_active: Optional[bool] = None

class BranchResponse(BranchBase):
    id: UUID
    organization_id: UUID
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

# ==================== USER ====================
class UserBase(BaseModel):
    full_name: str = Field(..., min_length=1, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    email: EmailStr

class UserCreate(UserBase):
    organization_id: UUID
    branch_id: Optional[UUID] = None
    password: str = Field(..., min_length=8)
    role: str = "cashier"  # Accept as string, validate in route
    invite_token: Optional[str] = None

class UserUpdate(BaseModel):
    full_name: Optional[str] = Field(None, min_length=1, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    email: Optional[EmailStr] = None
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None
    branch_id: Optional[UUID] = None

class UserResponse(UserBase):
    id: UUID
    organization_id: UUID
    branch_id: Optional[UUID]
    role: str
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
    organization: OrganizationResponse
    branch: Optional[BranchResponse] = None

# ==================== CATEGORY ====================
class CategoryBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    color: str = Field(default="#6B7280", max_length=20)

class CategoryCreate(CategoryBase):
    # organization_id is derived from the authenticated user for security
    branch_id: Optional[UUID] = None

class CategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    color: Optional[str] = Field(None, max_length=20)

class CategoryResponse(CategoryBase):
    id: UUID
    organization_id: UUID
    branch_id: Optional[UUID]
    created_at: datetime

    class Config:
        from_attributes = True

# ==================== SUPPLIER ====================
class SupplierBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    email: Optional[EmailStr] = None
    address: Optional[str] = None
    contact_person: Optional[str] = None
    branch_id: Optional[UUID] = None   # None = org-wide supplier visible to all branches

class SupplierCreate(SupplierBase):
    # organization_id is derived from the authenticated user for security
    pass

class SupplierUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    email: Optional[EmailStr] = None
    address: Optional[str] = None
    contact_person: Optional[str] = None
    branch_id: Optional[UUID] = None
    is_active: Optional[bool] = None

class SupplierResponse(SupplierBase):
    id: UUID
    organization_id: UUID
    branch_id: Optional[UUID] = None
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True

# ==================== ITEM ====================
class ItemBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    barcode: Optional[str] = Field(None, max_length=100)
    brand: Optional[str] = Field(None, max_length=255)
    buy_price: float = Field(default=0.0, ge=0)
    sell_price: float = Field(default=0.0, ge=0)
    stock_quantity: int = Field(default=0, ge=0)
    min_stock_level: int = Field(default=10, ge=0)
    expiry_date: Optional[date] = None
    batch_number: Optional[str] = Field(None, max_length=100)
    image_url: Optional[str] = None
    expiry_image_url: Optional[str] = None
    ai_status: Optional[str] = None
    generic_name: Optional[str] = Field(None, max_length=255)
    brand_name: Optional[str] = Field(None, max_length=255)
    strength: Optional[str] = Field(None, max_length=100)
    dosage_form: Optional[str] = Field(None, max_length=100)
    controlled_substance: bool = False
    base_unit_id: Optional[UUID] = None
    purchase_unit_id: Optional[UUID] = None
    sale_unit_id: Optional[UUID] = None

class ItemCreate(ItemBase):
    # organization_id is derived from the authenticated user for security
    branch_id: Optional[UUID] = None
    category_id: Optional[UUID] = None
    supplier_id: Optional[UUID] = None

class ItemUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    barcode: Optional[str] = Field(None, max_length=100)
    brand: Optional[str] = Field(None, max_length=255)
    buy_price: Optional[float] = Field(None, ge=0)
    sell_price: Optional[float] = Field(None, ge=0)
    stock_quantity: Optional[int] = Field(None, ge=0)
    min_stock_level: Optional[int] = Field(None, ge=0)
    expiry_date: Optional[date] = None
    batch_number: Optional[str] = Field(None, max_length=100)
    image_url: Optional[str] = None
    expiry_image_url: Optional[str] = None
    ai_status: Optional[str] = None
    generic_name: Optional[str] = Field(None, max_length=255)
    brand_name: Optional[str] = Field(None, max_length=255)
    strength: Optional[str] = Field(None, max_length=100)
    dosage_form: Optional[str] = Field(None, max_length=100)
    controlled_substance: Optional[bool] = None
    base_unit_id: Optional[UUID] = None
    purchase_unit_id: Optional[UUID] = None
    sale_unit_id: Optional[UUID] = None
    category_id: Optional[UUID] = None
    supplier_id: Optional[UUID] = None
    is_active: Optional[bool] = None

class ItemResponse(ItemBase):
    id: UUID
    organization_id: UUID
    branch_id: Optional[UUID]
    category_id: Optional[UUID]
    supplier_id: Optional[UUID]
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class ItemWithDetails(ItemResponse):
    category_name: Optional[str] = None
    supplier_name: Optional[str] = None
    matched_tier: Optional[dict] = None

# ==================== BANK ACCOUNT ====================
class BankAccountBase(BaseModel):
    account_name: str = Field(..., min_length=1, max_length=255)
    account_number: Optional[str] = Field(None, max_length=50)
    bank_name: Optional[str] = Field(None, max_length=255)  # bank name or mobile money provider (e.g. M-Pesa)
    balance: float = Field(default=0.0, ge=0)
    account_type: Optional[str] = Field(default="bank")     # "bank" or "mobile_money"

class BankAccountCreate(BankAccountBase):
    # organization_id is derived from the authenticated user for security
    branch_id: Optional[UUID] = None

class BankAccountUpdate(BaseModel):
    account_name: Optional[str] = Field(None, min_length=1, max_length=255)
    account_number: Optional[str] = Field(None, max_length=50)
    bank_name: Optional[str] = Field(None, max_length=255)
    balance: Optional[float] = Field(None, ge=0)
    account_type: Optional[str] = None
    is_active: Optional[bool] = None

class BankAccountResponse(BankAccountBase):
    id: UUID
    organization_id: UUID
    branch_id: Optional[UUID]
    account_type: Optional[str] = "bank"
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True

# ==================== SALE ====================
class SaleItemCreate(BaseModel):
    item_id: UUID
    quantity: int = Field(..., gt=0)
    unit_price: float = Field(..., ge=0)
    unit_id: Optional[UUID] = None

class SaleCreate(BaseModel):
    branch_id: UUID
    # sold_by is automatically set from the authenticated user
    items: List[SaleItemCreate] = Field(..., min_length=1)
    discount_amount: float = Field(default=0.0, ge=0)
    subtotal: Optional[float] = Field(default=0.0, ge=0)
    tax_amount: Optional[float] = Field(default=0.0, ge=0)
    total_amount: Optional[float] = Field(default=0.0, ge=0)
    payment_method: PaymentMethod = PaymentMethod.CASH
    bank_account_id: Optional[UUID] = None
    mobile_money_account_id: Optional[UUID] = None   # which mobile money provider was used
    # Split payment fields
    cash_paid: Optional[float] = Field(default=0.0, ge=0)
    bank_paid: Optional[float] = Field(default=0.0, ge=0)
    mobile_money_paid: Optional[float] = Field(default=0.0, ge=0)
    notes: Optional[str] = None
    idempotency_key: Optional[str] = Field(default=None, max_length=120)  # client retry key; same key returns the original sale

class SaleItemResponse(BaseModel):
    id: UUID
    sale_id: UUID
    item_id: Optional[UUID] = None
    item_name: Optional[str] = None
    quantity: float
    unit_id: Optional[UUID] = None
    base_quantity: Optional[float] = None
    unit_price: float
    cost_price: float
    total: float

    class Config:
        from_attributes = True

class PaymentResponse(BaseModel):
    id: UUID
    sale_id: UUID
    payment_method: str
    amount: float
    bank_account_id: Optional[UUID]
    mobile_money_account_id: Optional[UUID] = None
    created_at: datetime

    class Config:
        from_attributes = True

class SaleResponse(BaseModel):
    id: UUID
    organization_id: UUID
    branch_id: UUID
    branch_name: Optional[str] = None  # Branch name for display
    user_id: UUID
    invoice_number: str
    sold_by: Optional[str] = None
    total_amount: float
    tax_amount: float
    discount_amount: float
    net_amount: float
    payment_status: str
    payment_method: Optional[str]
    notes: Optional[str]
    created_at: datetime
    items: List[SaleItemResponse] = []
    payments: List[PaymentResponse] = []
    change_amount: float = 0  # cash change given to the customer (tendered - net)
    returned_by_item: Dict[str, float] = {}  # item_id -> already-returned sold qty (for return modal remaining)

    class Config:
        from_attributes = True

# ==================== EXPENSE ====================
class ExpenseBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    amount: float = Field(..., gt=0)
    expense_type: ExpenseType
    expense_date: Optional[date] = None  # defaults to today server-side if not provided

class ExpenseCreate(ExpenseBase):
    # organization_id and created_by are derived from the auth token server-side
    organization_id: Optional[UUID] = None
    branch_id: Optional[UUID] = None
    created_by: Optional[UUID] = None
    receipt_url: Optional[str] = None

class ExpenseUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    amount: Optional[float] = Field(None, gt=0)
    expense_type: Optional[ExpenseType] = None
    expense_date: Optional[date] = None
    receipt_url: Optional[str] = None

class ExpenseResponse(ExpenseBase):
    id: UUID
    organization_id: UUID
    branch_id: UUID
    created_by: UUID
    receipt_url: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True

# ==================== STOCK MOVEMENT ====================
class StockMovementResponse(BaseModel):
    id: UUID
    item_id: UUID
    branch_id: UUID
    type: str
    quantity: int
    previous_quantity: int
    new_quantity: int
    reference_id: Optional[UUID]
    notes: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True

# ==================== CASH TRANSFER ====================
class CashTransferBase(BaseModel):
    type: TransferType
    amount: float = Field(..., gt=0)
    bank_account_id: Optional[UUID] = None
    notes: Optional[str] = None

class CashTransferCreate(CashTransferBase):
    # organization_id, branch_id, created_by are filled server-side from auth token
    organization_id: Optional[UUID] = None
    branch_id: Optional[UUID] = None
    created_by: Optional[UUID] = None

class CashTransferUpdate(BaseModel):
    status: Optional[str] = None
    approved_by: Optional[UUID] = None

class CashTransferResponse(CashTransferBase):
    id: UUID
    organization_id: UUID
    branch_id: UUID
    reference_number: Optional[str]
    status: str
    approved_by: Optional[UUID]
    created_by: UUID
    created_at: datetime

    class Config:
        from_attributes = True

# ==================== REPORTS ====================
class DailySalesReport(BaseModel):
    date: date
    total_transactions: int
    total_revenue: float
    total_tax: float
    total_discount: float
    gross_sales: float

class SalesByItem(BaseModel):
    item_id: UUID
    item_name: str
    total_quantity: float  # in the sold/display unit
    total_base_quantity: Optional[float] = None
    sold_unit: Optional[str] = None
    base_unit: Optional[str] = None
    mixed_units: Optional[bool] = None
    quantity_display: Optional[str] = None
    total_revenue: float

class TopSellingItem(BaseModel):
    item_id: UUID
    item_name: str
    total_quantity: float  # in the sold/display unit
    total_base_quantity: Optional[float] = None
    sold_unit: Optional[str] = None
    base_unit: Optional[str] = None
    mixed_units: Optional[bool] = None
    quantity_display: Optional[str] = None
    total_revenue: float

class ExpenseReport(BaseModel):
    expense_type: str
    total_amount: float
    count: int

class ProfitReport(BaseModel):
    total_revenue: float
    total_cost: float
    gross_profit: float
    profit_margin: float

# ==================== DASHBOARD ====================
class DashboardStats(BaseModel):
    today_sales: float
    today_transactions: int
    today_profit: float
    low_stock_count: int
    expiring_soon_count: int
    total_items: int
    total_customers: int

# ==================== PAGINATION ====================
class PaginatedResponse(BaseModel):
    items: List
    total: int
    page: int
    page_size: int
    total_pages: int

# ==================== NOTIFICATIONS ====================
class NotificationType(str, Enum):
    LOW_STOCK = "low_stock"
    EXPIRING_ITEMS = "expiring_items"
    NEW_SALE = "new_sale"
    SYSTEM_ALERT = "system_alert"

class NotificationCreate(BaseModel):
    title: str
    message: str
    notification_type: NotificationType
    target_roles: List[UserRole] = []
    target_user_id: Optional[UUID] = None
    related_id: Optional[UUID] = None
    link: Optional[str] = None
    branch_id: Optional[UUID] = None

class NotificationResponse(BaseModel):
    id: UUID
    organization_id: UUID
    user_id: Optional[UUID]
    branch_id: Optional[UUID] = None
    title: str
    message: str
    notification_type: NotificationType
    is_read: bool = False
    related_id: Optional[UUID]
    link: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True

class NotificationUpdate(BaseModel):
    is_read: Optional[bool] = None

# ==================== API RESPONSE ====================
class APIResponse(BaseModel):
    success: bool = True
    message: str = "Operation successful"
    data: Optional[Any] = None

    class Config:
        from_attributes = True
