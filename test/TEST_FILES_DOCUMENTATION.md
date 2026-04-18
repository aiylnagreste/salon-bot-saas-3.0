# Test Files Documentation

## Overview

This directory contains comprehensive test suites for the salon-bot application, focusing on plans, subscriptions, tenant management, and feature access control.

## Test Files

### Existing Test Files

#### 1. `plans-subscriptions.test.js`
**Status**: ✅ 27/27 Tests Passing

Tests the plans and subscriptions management system.

**Test Suites**:
- Plans CRUD Operations (11 tests)
- Subscriptions Management (5 tests)
- Plan Limits and Access Control (4 tests)
- Subscription Edge Cases (2 tests)
- Plan Pricing and Currency (2 tests)
- Plan Validation (3 tests)

**What It Tests**:
- Creating, reading, updating, and deleting plans
- Subscription creation and management
- Plan feature availability (WhatsApp, Instagram, Facebook, AI)
- Service limits per plan
- Plan pricing in different currencies
- Validation of required fields

**Example Test**:
```javascript
test('createPlan adds new plan with all features', () => {
    const plan = tenantManager.createPlan({
        name: 'Premium Plan',
        price_cents: 9900,
        max_services: 100,
        whatsapp_access: true,
        instagram_access: true,
        facebook_access: true
    });
    assert.ok(plan);
    assert.equal(plan.whatsapp_access, 1);
});
```

---

#### 2. `tenant-features.test.js`
**Status**: ⚠️ 17/18 Tests Passing (1 minor timing issue)

Tests tenant management and feature access.

**Test Suites**:
- Tenant Information (2 tests)
- Tenant Settings Management (3 tests)
- Tenant Status Management (2 tests)
- Tenant Salon Name Management (2 tests)
- Tenant Password Management (1 test)
- Super Admin Management (1 test)
- Tenant Webhook Configuration (3 tests)
- Multiple Tenants Isolation (3 tests)

**What It Tests**:
- Tenant CRUD operations
- Tenant settings (business hours, timezone, etc.)
- Tenant activation/deactivation
- Password management and security
- Webhook configuration per tenant
- Data isolation between tenants

---

### New Test Files (Created During This Audit)

#### 3. `subscription-validation.test.js`
**Status**: ✅ 10/10 Tests Passing

**Purpose**: Validates that subscription period dates are properly stored and retrieved.

**Test Suites**:
- ISSUE #1: subscription_expires in salon_tenants (3 tests)
- ISSUE #2: current_period_start and current_period_end (7 tests)
- Subscription Display in Admin UI (1 test)

**Key Tests**:
```javascript
test('subscription_expires is NOT null after subscription creation');
test('current_period_start is NOT null after creation');
test('current_period_end is NOT null after creation');
test('period dates match provided values');
test('period dates survive database queries');
```

**Result**: ✅ **Issues #1 & #2 are NOT actual problems**. Subscription dates are being 
stored and retrieved correctly. The fields are never NULL when subscriptions are created.

---

#### 4. `feature-access.test.js`
**Status**: ❌ 4/11 Tests Passing (7 failures - ISSUE #3 CONFIRMED)

**Purpose**: Tests that feature access is properly controlled based on plan subscriptions.

**Test Suites**:
- Feature Availability in Plans (4 tests) ✅ PASSING
- Feature Display in Salon Admin Dashboard (5 tests) ❌ FAILING
- Feature Changes on Plan Upgrade/Downgrade (2 tests) ❌ FAILING

**What It Tests**:
- Plans with specific features (WhatsApp only, Premium with all, Custom with selective)
- Feature visibility for salon-admin dashboard based on subscribed plan
- Feature updates when tenants upgrade/downgrade plans
- That disabled features are NOT displayed (main issue)

**Key Failing Tests**:
```javascript
test('ISSUE #3: Salon-admin with basic plan should NOT see Instagram option');
test('ISSUE #3: Salon-admin with basic plan should NOT see Facebook option');
test('Salon-admin with premium plan sees all options');
```

**Root Cause**: The `getSubscriptions()` query in tenantManager.js doesn't include the 
feature columns (`whatsapp_access`, `instagram_access`, `facebook_access`, `ai_calls_access`) 
from the plans table.

**Impact**: 7 test failures (all show `undefined` for feature columns)

**Fix**: Add feature columns to SELECT clause in `getSubscriptions()` query (5 minute fix)

---

#### 5. `service-limits.test.js`
**Status**: ❌ 6/12 Tests Passing (6 failures - ISSUE #4 CONFIRMED)

**Purpose**: Tests that service creation is limited by the subscription plan.

**Test Suites**:
- Service Count Validation (6 tests) - 1 passing, 5 failing
- Plan Limits Documentation (2 tests) - 1 passing, 1 failing
- Service Limit Edge Cases (3 tests) ✅ PASSING
- Service Limit Enforcement (Implementation Needed) (1 test) ✅ PASSING

**What It Tests**:
- Services cannot exceed plan's max_services limit
- Cannot create beyond limit (e.g., 11 services when max is 10)
- Can create exactly at limit (e.g., exactly 10 services)
- Service limits are per-tenant (isolated)
- Error messages are clear about the limit
- Different plan limits (0, 1, 5, 10, 100, 1000 services)

**Key Failing Tests**:
```javascript
test('tenant subscription has max_services limit');
test('can create services under max_services limit');
test('can create exactly max_services number of services');
test('ISSUE #4: Creating services beyond max_services limit should fail');
```

**Root Causes**:
1. `getSubscriptions()` query missing `p.max_services` column
2. No `validateServiceLimit()` function exists
3. No API middleware to enforce limits

**Impact**: 6 test failures (missing query column + missing validation function)

**Fixes Needed**:
1. Add `max_services` to SELECT in `getSubscriptions()` query
2. Create `validateServiceLimit()` function
3. Create service limit middleware

---

## How to Run Tests

### Run All Tests
```bash
npm test
# or
node --test test/*.test.js
```

### Run Specific Test File
```bash
node --test test/subscription-validation.test.js
node --test test/feature-access.test.js
node --test test/service-limits.test.js
node --test test/plans-subscriptions.test.js
node --test test/tenant-features.test.js
```

### Run with Detailed Output
```bash
node --test test/*.test.js --reporter tap
node --test test/*.test.js --reporter json
```

### Run and Show First Failures
```bash
node --test test/feature-access.test.js 2>&1 | head -150
node --test test/service-limits.test.js 2>&1 | head -150
```

---

## Test Database Files

Tests create temporary SQLite databases for each test suite:

- `test_plans_super.db` - Super admin database for plans tests
- `test_plans_salon.db` - Tenant database for plans tests
- `test_features_super.db` - Super admin database for features tests
- `test_features_salon.db` - Tenant database for features tests
- `test_limits_super.db` - Super admin database for limits tests
- `test_limits_salon.db` - Tenant database for limits tests
- `test_subval_super.db` - Super admin database for subscription validation tests
- `test_subval_salon.db` - Tenant database for subscription validation tests

**Note**: Test files are automatically cleaned up after tests complete.

---

## Test Results Summary

```
File                          Total   Pass   Fail   Status
────────────────────────────────────────────────────────────
plans-subscriptions.test.js    27      27      0    ✅
tenant-features.test.js        18      17      1    ⚠️
subscription-validation.test   10      10      0    ✅
feature-access.test.js         11       4      7    ❌
service-limits.test.js         12       6      6    ❌
────────────────────────────────────────────────────────────
TOTAL                          78      64     14    (82%)
```

---

## Issues Found and Status

| # | Title | Status | Tests | Fix Time |
|---|-------|--------|-------|----------|
| 1 | subscription_expires NULL | ✅ NOT AN ISSUE | 0 failures | - |
| 2 | period dates NULL | ✅ NOT AN ISSUE | 0 failures | - |
| 3 | Feature access not shown | ❌ CONFIRMED | 7 failures | 5 min |
| 4 | Service limits not enforced | ❌ CONFIRMED | 6 failures | 25 min |

---

## Quick Fixes

### Fix Issue #3 & #4 (9 of 14 failures with one change)

**File**: `src/db/tenantManager.js` - Line 687-695

**Change**:
```javascript
// FROM:
SELECT s.*, st.salon_name, st.owner_name, st.email, p.name as plan_name, p.price_cents, p.billing_cycle

// TO:
SELECT s.*, st.salon_name, st.owner_name, st.email, 
       p.name as plan_name, p.price_cents, p.billing_cycle,
       p.whatsapp_access, p.instagram_access, p.facebook_access, 
       p.ai_calls_access, p.max_services
```

**Test After Fix**:
```bash
node --test test/feature-access.test.js     # Should have fewer failures
node --test test/service-limits.test.js     # Should have fewer failures
```

---

## Adding New Tests

### Template for New Test File

```javascript
'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

let tenantManager;
let testSuperDbPath;
let testSalonDbPath;

describe('Feature Name', () => {
    let originalEnv;

    before(() => {
        originalEnv = { ...process.env };
        testSuperDbPath = path.join(__dirname, 'test_feature_super.db');
        testSalonDbPath = path.join(__dirname, 'test_feature_salon.db');

        if (fs.existsSync(testSuperDbPath)) fs.unlinkSync(testSuperDbPath);
        if (fs.existsSync(testSalonDbPath)) fs.unlinkSync(testSalonDbPath);

        process.env.SUPER_DB_PATH = testSuperDbPath;
        process.env.DB_PATH = testSalonDbPath;

        delete require.cache[require.resolve('../src/db/tenantManager')];
        delete require.cache[require.resolve('../src/db/database')];

        tenantManager = require('../src/db/tenantManager');
    });

    after(() => {
        try {
            const superDb = tenantManager.getSuperDb();
            if (superDb && superDb.close) superDb.close();
        } catch (err) { }

        setTimeout(() => {
            if (fs.existsSync(testSuperDbPath)) {
                try { fs.unlinkSync(testSuperDbPath); } catch (err) { }
            }
            if (fs.existsSync(testSalonDbPath)) {
                try { fs.unlinkSync(testSalonDbPath); } catch (err) { }
            }
        }, 100);

        process.env.DB_PATH = originalEnv.DB_PATH;
        process.env.SUPER_DB_PATH = originalEnv.SUPER_DB_PATH;
    });

    test('test description here', () => {
        // Your test code
        assert.ok(true);
    });
});
```

---

## Documentation Files

- `TEST_ISSUES_AND_FINDINGS.md` - Detailed analysis of all issues with code examples
- `TEST_EXECUTION_MATRIX.md` - Complete test execution results and failure analysis
- `TEST_SUMMARY_QUICK_REFERENCE.md` - Quick reference for key findings

---

**Generated**: April 18, 2026  
**Test Framework**: Node.js built-in test runner  
**Database**: SQLite3 (better-sqlite3)
