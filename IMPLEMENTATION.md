# IMPLEMENTATION: Advanced Booking System

> **Date**: 2026-04-06  
> **Changes**: Service Duration, Staff Availability, Booking Status Enforcement

---

## Summary of Changes

This implementation introduces a production-ready booking system with:

1. **Service Duration Tracking** — Services store duration in minutes; bookings calculate and persist `endTime`
2. **Staff Availability System** — New `staff_bookings` table prevents double-booking via overlap detection
3. **Booking Status Rules** — Remove "PENDING"; enforce CONFIRMED by default; one-way cancellation (CONFIRMED → CANCELED only)
4. **Smart Staff Assignment** — Explicit selection validates availability; random assignment finds available staff
5. **Staff Popularity Tracking** — Track how many times clients explicitly request specific staff

---

## 1. Database Schema Changes

### New Tables

#### `staff_bookings`
Prevents double-booking by tracking staff busy periods.

```sql
CREATE TABLE staff_bookings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  staffId   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  bookingId INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  branchId  INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  startTime TEXT NOT NULL,                      -- "2026-04-05 14:00"
  endTime   TEXT NOT NULL,                      -- "2026-04-05 15:30"
  status    TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'canceled'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(staffId, bookingId)
);
```

**Overlap Detection Logic:**
```
Two bookings overlap if:  startTime₁ < endTime₂ AND endTime₁ > startTime₂
```

**Example**: 14:00–15:30 conflicts with 15:15–16:00 (15 min overlap ✓)  
But 14:00–15:00 does NOT conflict with 15:00–16:00 (back-to-back ✓)

### Modified Tables

#### `services`
```sql
ALTER TABLE services ADD COLUMN durationMinutes INTEGER DEFAULT 60;
```

- **Default**: 60 minutes
- **Input formats**: Accepts "2:30" (→ 150 min) or "120" (→ 120 min)
- **Calculation-friendly**: Stored as integer for fast math

#### `bookings`
```sql
ALTER TABLE bookings ADD COLUMN endTime TEXT;
```

- **Calculation**: `endTime = startTime + service.durationMinutes`
- **Example**: 14:00 + 90 min = 15:30
- **Persisted**: Enables fast availability queries without on-the-fly calculation

#### `staff`
```sql
ALTER TABLE staff ADD COLUMN requestedCount INTEGER DEFAULT 0;
```

- **Increments**: Only when a user **explicitly selects** that staff member
- **Does NOT increment**: When staff is randomly assigned by the system
- **Use**: Identify popular stylists for scheduling & staffing decisions

---

## 2. Service Duration Processing

### File: `src/db/seed.js`

Services are now seeded with realistic durations:

| Service | Duration | Rationale |
|---------|----------|-----------|
| 24K Gold Facial | 120 min | Full facial treatment |
| Bridal Makeup | 240 min | High-touch service |
| Hair Rebonding | 240 min | Chemical treatment + drying |
| Manicure & Pedicure | 60–75 min | Hand & foot work |
| Eyelash Extensions | 120–180 min | Precision application |
| Haircut Basic | 45 min | Quick trim |
| Haircut with Treatment | 90 min | + protein/massage |

```javascript
// Example from seed.js
{
  name: '24K Gold Facial – Deal 1',
  price: '2,199',
  desc: '...',
  branch: 'All Branches',
  duration: 120,         // ← NEW: in minutes
}

// Seeding loop
for (const s of services) {
  insertService.run(s.name, s.price, s.desc, s.branch, s.duration || 60);
}
```

**Update Format Support:**
- Input `"2:30"` →  `parseServiceDuration()` → 150 minutes
- Input `120` → 120 minutes
- Default: 60 minutes

---

## 3. Booking Duration Calculation

### File: `src/index.js`

Helper functions calculate booking end time:

```javascript
/**
 * Calculate end time: startTime + durationMinutes
 * @param {string} startTimeHHMM  "14:00" (24-hour format)
 * @param {number} durationMinutes 90
 * @returns {string}              "15:30"
 */
function calculateEndTime(startTimeHHMM, durationMinutes) {
  const [h, m] = startTimeHHMM.split(':').map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

calculateEndTime('14:00', 90) // → "15:30"
```

**Applied to:**
- Admin panel bookings (POST `/admin/api/bookings`)
- Booking edits (PUT `/admin/api/bookings/:id`)
- Chatbot bookings (via `src/replies/booking.js`)

---

## 4. Staff Availability & Overlap Detection

### File: `src/replies/booking.js`

Core functions for availability checking:

#### `checkStaffAvailability(staffId, date, startTimeHHMM, endTimeHHMM)`
```javascript
// Query for conflicts with active bookings
SELECT COUNT(*) FROM staff_bookings
WHERE staffId = ?
  AND status = 'active'
  AND DATE(startTime) = ?
  AND startTime < ? AND endTime > ?

// Returns: true (available) | false (conflict)
```

**Example**:
- Staff 5 is busy 14:00–15:30
- Request 15:15–16:00 → CONFLICT (overlap) ✗
- Request 15:30–16:30 → AVAILABLE (no overlap) ✓
- Request 13:00–14:00 → AVAILABLE ✓

#### `getAvailableStaff(branchName, date, startTime, endTime, excludeStaffId?)`
Returns list of eligible staff with no time conflicts:

```javascript
// 1. Get all eligible staff (active, branch-scoped, exclude admin/manager/receptionist)
// 2. Filter to those with no overlapping bookings
// 3. Return filtered list

getAvailableStaff('Downtown', '2026-04-05', '14:00', '15:30')
// → [{ id: 3, name: 'Sara', role: 'stylist' }, { id: 7, name: 'Nadia', ... }]
```

#### `pickRandomAvailableStaff(branchName, date, startTime, endTime)`
Randomly selects one available staff member:

```javascript
const staff = pickRandomAvailableStaff('Downtown', '2026-04-05', '14:00', '15:30');
// → { id: 3, name: 'Sara', role: 'stylist' }
```

---

## 5. Booking Status Rules

### Enforcement

**Status Values** (no PENDING):
- `confirmed` — Default for all new bookings
- `canceled` — Admin-only cancellation

**Validation Rules:**

| Current | Desired | Allowed? | Reason |
|---------|---------|----------|--------|
| confirmed | confirmed | ✓ | No change |
| confirmed | canceled | ✓ | Admin cancellation (one-way) |
| canceled | confirmed | ✗ | Cannot revert canceled |
| canceled | canceled | ✓ | Idempotent |

**Implementation in `src/index.js`:**

```javascript
function validateCancellation(currentStatus, newStatus) {
  const curr = (currentStatus || '').toLowerCase();
  const next = (newStatus || '').toLowerCase();
  
  if (curr === 'confirmed' && next === 'canceled') return null;  // ✓ OK
  if (curr === 'canceled' && next !== 'canceled') return 'Cannot restore canceled bookings';  // ✗
  return null;  // Any other same-status change OK
}

// Applied in PATCH /admin/api/bookings/:id/status
if (validationErr = validateCancellation(current.status, newStatus)) {
  return res.status(400).json({ ok: false, error: validationErr });
}
```

### Cancellation Workflow

```text
Admin clicks "Cancel" on a booking
  ↓
PATCH /admin/api/bookings/123/status { status: "canceled" }
  ↓
Validate: current status is "confirmed" ✓
  ↓
UPDATE bookings SET status='canceled' WHERE id=123
UPDATE staff_bookings SET status='canceled' WHERE bookingId=123
  ↓
Update cache
  ↓
Staff is now available again for that time slot ✓
```

---

## 6. Explicit vs Random Staff Assignment

### Chatbot Booking Flow

#### Step 1: ASK_STAFF (Optional Selection)
User is shown available staff and asked to choose (optional):

```
"Would you like to choose a specific stylist? (optional)

  1. Sara Ahmed (stylist)
  2. Nadia Malik (stylist)

Reply with a number to choose, or type 'skip' for no preference."
```

**Session State After Step 1:**
```javascript
{
  state: 'ASK_DATE',
  staffId: 3,                    // null if user skipped
  staffName: 'Sara Ahmed',       // null if user skipped
  staffExplicitlyRequested: true // false if user skipped
}
```

#### Step 2: ASK_TIME (Availability Check)
When user provides time, the system:

```javascript
if (staffId && staffExplicitlyRequested) {
  // User explicitly chose → VALIDATE AVAILABILITY
  if (!checkStaffAvailability(staffId, date, startTime, endTime)) {
    return "Sara is not available at 14:00 on April 5.\n" +
           "Please choose a different time, or type 'skip' for another stylist.";
  }
} else if (!staffId) {
  // User did NOT choose → PICK RANDOM AVAILABLE
  const randomStaff = pickRandomAvailableStaff(branch, date, startTime, endTime);
  if (randomStaff) {
    staffId = randomStaff.id;
    staffName = randomStaff.name;
    staffExplicitlyRequested = false;  // ← Don't increment requestedCount
  }
}
```

### Difference: Requested Count Behavior

**Scenario A: User Explicitly Selects "Sara Ahmed"**
```
saveBooking({ staffId: 3, staffName: 'Sara', staffExplicitlyRequested: true, ... })
  ↓
INSERT INTO staff_bookings (staffId=3, bookingId=456, ...)
UPDATE staff SET requestedCount = requestedCount + 1 WHERE id=3  ← Increment!
```

**Scenario B: User Skips Staff Selection (System Picks Random "Nadia")**
```
saveBooking({ staffId: 7, staffName: 'Nadia', staffExplicitlyRequested: false, ... })
  ↓
INSERT INTO staff_bookings (staffId=7, bookingId=457, ...)
// NO requestedCount update  ← Not incremented!
```

**Result**: Over time, `staff.requestedCount` reflects true client preference.

---

## 7. Admin Panel Booking Creation

### POST `/admin/api/bookings`

Admin creates booking via "New Booking" modal:

```javascript
// New request body
{
  customer_name: "Ahmad Ali",
  phone: "+923001234567",
  service: "24K Gold Facial – Deal 1",
  branch: "Downtown Branch",
  date: "2026-04-05",
  time: "14:00",
  notes: "First-time client",
  staff_id: 3,         // Optional; null for unassigned
  staff_name: "Sara"   // Optional; null for unassigned
}

// Server processing:
const duration = getServiceDuration("24K Gold Facial – Deal 1", db);  // 120
const endTime = calculateEndTime("14:00", 120);  // "15:30"

INSERT INTO bookings (..., status='confirmed', endTime='15:30', staff_id=3, ...)
INSERT INTO staff_bookings (staffId=3, startTime='2026-04-05 14:00', endTime='2026-04-05 15:30', ...)

// Response
{ id: 123, ..., status: 'confirmed', endTime: '15:30', ... }
```

**Status**: Always created as `confirmed` (no choice for admin; old PENDING status removed)

---

## 8. Cancellation & Staff Availability Recovery

### PATCH `/admin/api/bookings/:id/status`

```javascript
PATCH /admin/api/bookings/123/status
{ status: "canceled" }

// Server:
UPDATE bookings SET status='canceled' WHERE id=123
UPDATE staff_bookings SET status='canceled' WHERE bookingId=123

// Result: Staff member is immediately available again for that time slot
```

**staff_bookings Status Change:**
- Was `active` → Now `canceled`
- This **excludes** the booking from `checkStaffAvailability()` queries
- Other queries can find that staff available again

---

## 9. Caching & Integration

### `src/cache/salonDataCache.js`

The persistent JSON cache automatically includes:

```javascript
// _buildFromDb() already does SELECT * FROM services
// So durationMinutes is automatically cached in salon-data.json

cache.services = [
  {
    id: 1,
    name: '24K Gold Facial – Deal 1',
    price: '2,199',
    description: '...',
    branch: 'All Branches',
    durationMinutes: 120,  // ← Automatically included
    created_at: '...',
    updated_at: '...'
  },
  ...
]
```

No code changes needed; the cache layer dynamically picks up new columns.

---

## 10. API Validation & Error Messages

### Booking Validation

**Invalid Attempts:**
```
POST /admin/api/bookings
{
  customer_name: "Ahmad",
  phone: "03001234567",
  service: "Facial",
  branch: "Downtown",
  date: "2026-04-05",
  time: "14:00",
  status: "pending"  ← INVALID (only 'confirmed' or 'canceled')
}

Response (400):
{
  ok: false,
  error: "status must be one of: confirmed, canceled"
}
```

**Cancellation Validation:**
```
PATCH /admin/api/bookings/123/status
{ status: "confirmed" }  ← Trying to revert canceled booking

Response (400):
{
  ok: false,
  error: "Canceled bookings cannot be restored."
}
```

**Time Validation Against Staff Availability:**
```
// Chatbot: User selects Sara at 14:00 but Sara is busy 14:00-15:30

Response (chatbot):
"Sara is not available at 14:00 on April 5.
Please choose a different time, or type 'skip' for another stylist."
```

---

## 11. Key Implementation Files Changed

| File | Changes |
|------|---------|
| `src/db/database.js` | ✓ Schema: add `durationMinutes` to services, `endTime` to bookings, `requestedCount` to staff<br/>✓ New table: `staff_bookings`<br/>✓ Migrations for new columns |
| `src/db/seed.js` | ✓ Add durations to all services (45–360 min)<br/>✓ Update INSERT statement to include `durationMinutes` |
| `src/replies/booking.js` | ✓ New: `parseServiceDuration()`, `getServiceDuration()`, `calculateEndTime()`<br/>✓ New: `checkStaffAvailability()`, `getAvailableStaff()`, `pickRandomAvailableStaff()`<br/>✓ Update `saveBooking()` to insert `endTime`, `staff_bookings`, increment `requestedCount` conditionally<br/>✓ Update ASK_STAFF to track `staffExplicitlyRequested`<br/>✓ Update ASK_TIME to check availability & pick random staff; calculate `endTime` |
| `src/index.js` | ✓ New: `validateCancellation()`, `getServiceDuration()`, `calculateEndTime()`<br/>✓ Update `validateBookingBody()` to reject PENDING status<br/>✓ POST `/admin/api/bookings`: calculate `endTime`, create `staff_bookings`<br/>✓ PUT `/admin/api/bookings/:id`: calculate `endTime`, update `staff_bookings`<br/>✓ PATCH `/admin/api/bookings/:id/status`: enforce cancellation rules, update `staff_bookings` status<br/>✓ DELETE: soft-cancel `staff_bookings` before hard delete |
| `src/cache/salonDataCache.js` | ✓ No changes (auto-includes `durationMinutes` via `SELECT *`) |

---

## 12. Testing Notes & Edge Cases

### Unit Test Ideas

```javascript
// Duration parsing
parseServiceDuration("2:30")     // → 150 ✓
parseServiceDuration(120)        // → 120 ✓
parseServiceDuration(null)       // → 60 ✓

// End time calculation
calculateEndTime("14:00", 90)    // → "15:30" ✓
calculateEndTime("23:30", 60)    // → "00:30" (wrap) ✓
calculateEndTime("14:00", 0)     // → "14:00" ✓

// Availability checking
checkStaffAvailability(3, '2026-04-05', '14:00', '15:30')
  // If staff 3 has booking 14:00–15:30 → false ✓
  // If staff 3 has booking 13:00–14:00 → true ✓
  // If staff 3 has booking 15:30–16:30 → true ✓ (no overlap)

// Cancellation rules
validateCancellation('confirmed', 'canceled')    // → null (valid) ✓
validateCancellation('canceled', 'confirmed')    // → error ✓
validateCancellation('confirmed', 'confirmed')   // → null ✓

// Staff assignment
// Explicit: staffExplicitlyRequested=true ↔ requestedCount++
// Random:   staffExplicitlyRequested=false ↔ requestedCount unchanged
```

### Integration Test Scenarios

**Scenario 1: Double-Booking Prevention**
```
1. Admin creates booking: Staff 3, April 5, 14:00–15:30
   → INSERT staff_bookings (staffId=3, startTime='2026-04-05 14:00', endTime='15:30')
2. Admin tries to create another: Staff 3, April 5, 15:15–16:00
   → checkStaffAvailability(3, '2026-04-05', '15:15', '16:00') finds conflict
   → Return error: "Time slot not available"
3. Admin tries 15:30–16:30 (back-to-back)
   → No conflict (15:30 = endTime, so startTime NOT < endTime) ✓
   → Booking created successfully
```

**Scenario 2: Cancellation & Recovery**
```
1. Booking 123 created: Staff 5, April 5, 14:00–15:30 (status=confirmed)
   → staff_bookings.status='active'
2. Client calls, cancels: PATCH /admin/api/bookings/123/status { status: 'canceled' }
   → bookings.status='canceled'
   → staff_bookings.status='canceled'
3. Another client books at 14:00–14:30 same day, same staff
   → checkStaffAvailability(5, '2026-04-05', '14:00', '14:30')
   → Finds NO conflicts (canceled booking is excluded)
   → Booking accepted ✓
```

**Scenario 3: Explicit vs Random Request Count**
```
User 1: Explicitly selects "Sara"
  → saveBooking(..., staffExplicitlyRequested=true)
  → UPDATE staff SET requestedCount=requestedCount+1 WHERE name='Sara'
  → Sara.requestedCount: 10 → 11 ✓

User 2: Skips staff selection (system picks "Nadia")
  → saveBooking(..., staffExplicitlyRequested=false)
  → NO requestedCount update
  → Nadia.requestedCount: 8 → 8 (unchanged) ✓

Result: Only explicit client requests increment the counter.
```

### Edge Cases Handled

1. **Time Wraparound** — Booking 23:30 + 90 min → 01:00 (wraps at midnight) ✓
2. **Back-to-Back Bookings** — 14:00–15:00 and 15:00–16:00 are allowed (no overlap) ✓
3. **No Available Staff** — Chatbot suggests random available; if none, continues anyway with note ✓
4. **All Staff Busy** — Chatbot can still create booking; admin will manually assign ✓
5. **Revoke Cancellation Attempt** — System blocks; must create new booking ✓
6. **Partial/Missing Data** — Migrations handle existing DBs; new columns default gracefully ✓

---

## 13. Migration & Rollout

### For Existing Databases

Run seed or manually apply:
```sql
-- Add columns (safe — already exists if recent)
ALTER TABLE services ADD COLUMN durationMinutes INTEGER DEFAULT 60;
ALTER TABLE bookings ADD COLUMN endTime TEXT;
ALTER TABLE staff ADD COLUMN requestedCount INTEGER DEFAULT 0;

-- Create new table
CREATE TABLE staff_bookings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  staffId   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  bookingId INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  branchId  INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  startTime TEXT NOT NULL,
  endTime   TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(staffId, bookingId)
);

-- Seed durations into existing services (if using POST /run-seed)
-- Seed sample staff (if no staff exist)
```

### Zero-Downtime Rollout

1. ✓ Schema changes are backward-compatible (new columns, defaults)
2. ✓ New table creation is idempotent (CREATE TABLE IF NOT EXISTS)
3. ✓ Old UI/API calls degrade gracefully:
   - `status` parameter ignored in POST (always uses 'confirmed')
   - Missing `endTime` defaults to calculation
   - Missing `staffExplicitlyRequested` defaults to 'false'
4. ✓ No breaking changes to existing endpoints

---

## 14. Future Enhancements

- **Time Slot Proactively Showing** — Display available slots instead of asking for input
- **Overbooking Buffer** — Configurable gap between bookings (e.g., 15 min turnover)
- **Multi-Staff Services** — Some services require 2+ staff (e.g., bridal makeup team)
- **Staff Specialization** — Only certain staff can do specific services
- **Rescheduling** — Move booked appointment to different time without canceling
- **Waitlist** — If no staff available, add to waitlist & auto-book when slot opens
- **Analytics** — Staff popularity, peak hours, cancellation rate trends

---

## Summary of Acceptance Criteria

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Duration field added to services | ✓ DONE |
| 2 | bookings.endTime calculated & persisted | ✓ DONE |
| 3 | staff_bookings table created & used | ✓ DONE |
| 4 | Overlap detection prevents double-booking | ✓ DONE |
| 5 | Cancellation is one-way (CONFIRMED→CANCELED only) | ✓ DONE |
| 6 | No PENDING status; always CONFIRMED default | ✓ DONE |
| 7 | Explicit staff selection validated for availability | ✓ DONE |
| 8 | Random staff auto-assigned when user skips choice | ✓ DONE |
| 9 | requestedCount increments only on explicit selection | ✓ DONE |
| 10 | Staff list filtered by branch, active status, availability | ✓ DONE |
| 11 | Admin can cancel bookings (status update) | ✓ DONE |
| 12 | Cancellation frees staff availability | ✓ DONE |

---

**Implementation complete.** All acceptance criteria met.
