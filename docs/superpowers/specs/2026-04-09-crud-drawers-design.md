# CRUD Drawers Design — Salon Admin Frontend
**Date:** 2026-04-09  
**Status:** Approved

---

## Problem

All "Add" and "Edit" buttons in the Next.js admin frontend are inert — no `onClick` handlers, no modal/form components exist. Users cannot create or edit bookings, deals, services, branches, staff, or roles from the frontend.

---

## Decision

**Side drawer (slide-in from right)** with a shared `DrawerShell` wrapper and entity-specific form components inside it. Same component handles both Add and Edit mode (pre-filled for edit).

---

## Architecture

### New Components

| File | Purpose |
|---|---|
| `components/ui/DrawerShell.tsx` | Shared slide-in shell: backdrop, header, close ×, Escape key, 300ms ease-out |
| `components/bookings/BookingDrawer.tsx` | Full booking form + real-time slot availability |
| `components/deals/DealDrawer.tsx` | Title, description, active toggle |
| `components/packages/ServiceDrawer.tsx` | Name, price, description, branch, duration |
| `components/settings/BranchDrawer.tsx` | Number, name, address, map link, phone |
| `components/settings/StaffDrawer.tsx` | Name, phone, role, branch, status |
| `components/settings/RoleDrawer.tsx` | Name only |

### Modified Pages

| Page | Change |
|---|---|
| `app/(dashboard)/dashboard/page.tsx` | Embed `BookingDrawer`; wire `+ New Appointment` button |
| `app/(dashboard)/bookings/page.tsx` | Embed `BookingDrawer`; wire `+ New Appointment` button |
| `app/(dashboard)/bookings/[branchId]/page.tsx` | Embed `BookingDrawer` with branch pre-filled |
| `app/(dashboard)/deals/page.tsx` | Embed `DealDrawer`; wire `+ Add Deal` and `Edit` buttons |
| `app/(dashboard)/packages/page.tsx` | Embed `ServiceDrawer`; wire `+ Add Service` and `Edit` buttons |
| `app/(dashboard)/settings/page.tsx` | Embed `BranchDrawer`, `StaffDrawer`, `RoleDrawer`; wire all buttons |

---

## DrawerShell

```tsx
<DrawerShell
  open={boolean}
  onClose={() => void}
  title="New Appointment"   // changes to "Edit Appointment" in edit mode
  width={520}               // default, overridable per entity
>
  {/* entity form here */}
</DrawerShell>
```

**Behavior:**
- Slides in from right: `transform: translateX(100%)` → `translateX(0)`, 300ms ease-out
- Semi-transparent backdrop (`rgba(0,0,0,0.4)`) fades in simultaneously
- Click backdrop or press `Escape` → calls `onClose`
- Fixed position, full height, scrollable content area
- z-index: 200 (above sidebar z-40 and topbar z-30)

**Per-page state pattern:**
```tsx
const [drawerOpen, setDrawerOpen] = useState(false);
const [editing, setEditing] = useState<Entity | null>(null);

function openAdd() { setEditing(null); setDrawerOpen(true); }
function openEdit(item: Entity) { setEditing(item); setDrawerOpen(true); }
function closeDrawer() { setDrawerOpen(false); setEditing(null); }
```

---

## Booking Drawer (most complex)

### Fields

| Field | Type | Notes |
|---|---|---|
| Client Name | text input | required |
| Phone | text input | required |
| Service | select | from `fetchServices()` |
| Branch | select | from `fetchBranches()` |
| Date | date input | min = today |
| Time | select (slots) | fetched after branch+date+service filled |
| Staff | select | optional; filtered to selected branch |
| Status | select | default `confirmed` |
| Notes | textarea | optional |

### Slot Availability (cascade)

When branch + date + service are all selected:
- Fetch `GET /api/availability/slots?branch=&date=&service=&tenantId=`
- Time field shows: loading spinner → slot dropdown OR "No available slots" empty state
- Changing branch/date/service resets time selection and re-fetches

### Mutations

- **Add:** `POST /salon-admin/api/bookings` with full booking body
- **Edit:** `PUT /salon-admin/api/bookings/:id` with full booking body
- On success: `invalidateQueries(QK.bookings())`, close drawer, sonner toast

---

## Deal Drawer

**Fields:** Title (required), Description (textarea), Active (toggle: 1 = yes, 0 = no)

**API:** Both add and edit use `POST /salon-admin/deals` with `{ deals: [item] }` (bulk upsert endpoint — handles insert and update by id presence)

On success: `invalidateQueries(QK.deals())`

---

## Service Drawer

**Fields:** Name (required), Price (text, e.g. "Rs. 1500"), Description, Branch (select), Duration in minutes (number)

**API:** Both add and edit use `POST /salon-admin/services` with `{ services: [item] }` (bulk upsert)

On success: `invalidateQueries(QK.services())`

---

## Branch Drawer

**Fields:** Number (number), Name (required), Address, Map Link (optional), Phone

**API:**
- Add: `POST /salon-admin/api/settings/branches`
- Edit: `PUT /salon-admin/api/settings/branches/:id`

On success: `invalidateQueries(QK.branches())`

---

## Staff Drawer

**Fields:** Name (required), Phone, Role (select from `fetchRoles()`), Branch (select from `fetchBranches()`, optional — null = all branches), Status (active/inactive toggle)

**API:**
- Add: `POST /salon-admin/api/settings/staff`
- Edit: `PUT /salon-admin/api/settings/staff/:id`

On success: `invalidateQueries(QK.staff())`

---

## Role Drawer

**Fields:** Name only (required)

**API:** Add only — `POST /salon-admin/api/settings/roles`  
(No edit endpoint exists; roles are deleted and recreated)

On success: `invalidateQueries(QK.roles())`

---

## Shared UX Rules

- Submit button: spinner + `disabled` during mutation
- Validation: inline error below each required field on submit attempt
- Toast: success ("Saved") or error (server message) via `sonner`
- Edit mode: drawer title = "Edit [Entity]", all fields pre-filled from `editing` object
- Add mode: drawer title = "New [Entity]", all fields empty/default
- All drawers use existing CSS variables (`--color-rose`, `--color-border`, `--color-ink`, etc.)
- No new CSS files — inline styles matching existing page patterns

---

## Out of Scope

- Bookings: status transition actions (Done / No-Show / Archive) — already implemented in `TodayAppointmentsTable`
- Clients: no add flow (clients are created implicitly via bookings)
- Webhook config: separate settings section, not a drawer
