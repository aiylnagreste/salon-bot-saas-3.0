const { setSession, clearSession } = require('../core/session');
const { getDb } = require('../db/database');
const { getBranches } = require('./branches');

const { patchCache } = require('../cache/salonDataCache');

// ── Helpers ─────────────────────────────────────────────────────────────────



function getServiceNames(tenantId) {
  try {
    const db = getDb();
    return db.prepare(`SELECT name FROM ${tenantId}_services ORDER BY name`).all().map(s => s.name);
  } catch {
    return [];
  }
}

function getActiveStaff(branchName, tenantId) {
  try {
    const db = getDb();
    const branch = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branchName);
    if (branch) {
      return db.prepare(`
        SELECT s.id, s.name, s.role FROM ${tenantId}_staff s
        WHERE s.status = 'active'
          AND (s.branch_id = ? OR s.branch_id IS NULL)
          AND s.role NOT IN ('admin', 'manager', 'receptionist')
        ORDER BY s.name
      `).all(branch.id);
    }
    return db.prepare(`
      SELECT id, name, role FROM ${tenantId}_staff
      WHERE status = 'active'
        AND role NOT IN ('admin', 'manager', 'receptionist')
      ORDER BY name
    `).all();
  } catch {
    return [];
  }
}

function saveBooking(data, platform, tenantId) {
  const db = getDb();
  db.prepare(`
    INSERT INTO ${tenantId}_bookings (customer_name, phone, service, branch, date, time, endTime, status, source, staff_id, staff_name, staffRequested)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)
  `).run(
    data.name,
    data.phone,
    data.service,
    data.branch,
    data.date,
    data.time,
    data.endTime || null,
    platform || 'chat',
    data.staffId || null,
    data.staffName || null,
    data.staffExplicitlyRequested ? 1 : 0  // ← THIS IS THE KEY FIX
  );

  // Create staff_bookings record if staff was assigned
  if (data.staffId) {
    const branch = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(data.branch);
    const branchId = branch ? branch.id : null;
    try {
      const fullDate = data.date + ' ' + data.time;
      const endTime = data.date + ' ' + (data.endTime || data.time);
      db.prepare(`
        INSERT INTO ${tenantId}_staff_bookings (staffId, bookingId, branchId, startTime, endTime, status)
        VALUES (?, (SELECT id FROM ${tenantId}_bookings WHERE customer_name = ? AND phone = ? AND date = ?), ?, ?, ?, 'active')
      `).run(data.staffId, data.name, data.phone, data.date, branchId, fullDate, endTime);
    } catch (e) {
      console.error('[BOOKING] staff_bookings insert error:', e.message);
    }

    // Increment requestedCount only if staff was explicitly requested (not random)
    if (data.staffExplicitlyRequested) {
      try {
        db.prepare(`UPDATE ${tenantId}_staff SET requestedCount = requestedCount + 1 WHERE id = ?`).run(data.staffId);
      } catch (e) {
        console.error('[BOOKING] requestedCount increment error:', e.message);
      }
    }
  }
}

// ── Service Duration Helpers ──────────────────────────────────────────────────

/**
 * Parse duration string (e.g. "2:30" or "120") → minutes
 */
function parseServiceDuration(durationStr) {
  if (!durationStr) return 60; // default
  const s = String(durationStr).trim();
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + (m || 0);
  }
  const num = Number(s);
  return isNaN(num) ? 60 : num;
}

/**
 * Get service duration in minutes from DB
 */
function getServiceDuration(serviceName, tenantId) {
  try {
    const db = getDb();
    const service = db.prepare(`SELECT durationMinutes FROM ${tenantId}_services WHERE name = ?`).get(serviceName);
    return service ? service.durationMinutes : 60;
  } catch {
    return 60;
  }
}

/**
 * Calculate end time given start time (HH:MM) and duration in minutes
 */
function calculateEndTime(startTimeHHMM, durationMinutes) {
  if (!startTimeHHMM || !durationMinutes) return startTimeHHMM;
  const [h, m] = startTimeHHMM.split(':').map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  const newH = Math.floor(totalMinutes / 60) % 24; // wrap at 24h
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

/**
 * Check if staff is available (no overlapping active bookings)
 * Overlap: newStart < existingEnd && newEnd > existingStart
 */
function checkStaffAvailability(staffId, date, startTimeHHMM, endTimeHHMM, tenantId) {
  try {
    const db = getDb();
    const startFull = date + ' ' + startTimeHHMM;
    const endFull = date + ' ' + endTimeHHMM;
    const conflicts = db.prepare(`
      SELECT COUNT(*) as cnt FROM ${tenantId}_staff_bookings
      WHERE staffId = ?
        AND status = 'active'
        AND DATE(startTime) = ?
        AND startTime < ?
        AND endTime > ?
    `).get(staffId, date, endFull, startFull);
    return (conflicts.cnt || 0) === 0;
  } catch (e) {
    console.error('[BOOKING] checkStaffAvailability error:', e.message);
    return true;
  }
}

/**
 * Get list of available staff for a given time slot (excluding specific staff if needed)
 */
function getAvailableStaff(branchName, date, startTimeHHMM, endTimeHHMM, tenantId, excludeStaffId = null) {
  try {
    const db = getDb();
    const branch = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branchName);
    if (!branch) return [];

    const startFull = date + ' ' + startTimeHHMM;
    const endFull = date + ' ' + endTimeHHMM;

    let allStaff = db.prepare(`
      SELECT s.id, s.name, s.role FROM ${tenantId}_staff s
      WHERE s.status = 'active'
        AND (s.branch_id = ? OR s.branch_id IS NULL)
        AND s.role NOT IN ('admin', 'manager', 'receptionist')
      ORDER BY s.name
    `).all(branch.id);

    return allStaff.filter(staff => {
      if (excludeStaffId && staff.id === excludeStaffId) return false;
      return checkStaffAvailability(staff.id, date, startTimeHHMM, endTimeHHMM, tenantId);
    });
  } catch (e) {
    console.error('[BOOKING] getAvailableStaff error:', e.message);
    return [];
  }
}

/**
 * Pick a random available staff member
 */
function pickRandomAvailableStaff(branchName, date, startTimeHHMM, endTimeHHMM, tenantId) {
  const available = getAvailableStaff(branchName, date, startTimeHHMM, endTimeHHMM, tenantId);
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function branchList(tenantId) {
  const branches = getBranches(tenantId);
  return branches.map(b => `  *${b.number}* — ${b.name}`).join('\n');
}

// Extract the actual name from conversational speech like "mera naam Ahmad hai" → "Ahmad"
function extractName(text) {
  const t = text.trim();
  // Strip common Urdu/English lead-in phrases
  const cleaned = t
    .replace(/^(mera naam|my name is|i am|main|میرا نام|naam hai|naam)\s+/i, '')
    .replace(/\s+(hai|hoon|hun|he|is|bolraha hoon|bol raha hoon|hain)$/i, '')
    .trim();
  return cleaned || t;
}

// Validates name: accepts Latin, Urdu/Arabic Unicode, spaces — 2–60 chars
function isValidName(text) {
  const t = extractName(text.trim());
  if (t.length < 2 || t.length > 60) return false;
  // Allow Latin letters, Urdu/Arabic script (U+0600–U+06FF, U+0750–U+077F, U+FB50–U+FDFF, U+FE70–U+FEFF), spaces
  return /^[a-zA-Z؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿\s]+$/.test(t);
}

// Extract digits from conversational speech like "mera number 03001234567 hai"
function extractPhone(text) {
  const t = text.trim();
  // Strip lead-in phrases
  const cleaned = t
    .replace(/^(mera number|my number|number hai|number|phone|contact|میرا نمبر|نمبر)\s*/i, '')
    .replace(/\s*(hai|hoon|he|is|hain)$/i, '')
    .trim();
  // Extract only digits and leading +
  const digits = cleaned.replace(/[^\d+]/g, '');
  return digits || cleaned;
}

// Validates phone: 7–15 digits, optional leading +
function isValidPhone(text) {
  const t = extractPhone(text.trim());
  return /^\+?[0-9]{7,15}$/.test(t);
}

// Extracts date keyword or date string from conversational speech
// "kal ana chahta hoon" → "kal", "30 March ko aana hai" → "30 March"
function extractDate(text) {
  const t = text.trim().toLowerCase();
  const relWords = ['aaj', 'kal', 'parson', 'today', 'tomorrow', 'day after tomorrow'];
  for (const w of relWords) {
    if (t.includes(w)) return w;
  }
  const cleaned = text.trim()
    .replace(/^(date|tarikh|date hai|mujhe|main|I want|i want|aana chahta hoon|aana chahti hoon|ko aana|ko jana|ko chahiye)\s*/i, '')
    .replace(/\s*(ko|par|ko aana|ana chahta hoon|ana chahti hoon|jana chahta hoon|theek hai|hai|hoon|he)$/i, '')
    .trim();
  return cleaned || text.trim();
}

// Extracts time value from conversational speech
// "2 baje theek hai" → "2 baje", "3 pm par aaonga" → "3 pm"
function extractTime(text) {
  const t = text.trim();
  const patterns = [
    /\b([01]?\d|2[0-3]):[0-5]\d(\s?(am|pm))?/i,
    /\b([01]?\d|2[0-3])\s?(am|pm)\b/i,
    /\b([01]?\d|2[0-3])\s(baje|o'clock|oclock)\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[0].trim();
  }
  return t;
}

// Validates date: accepts "30 March", "April 5", "2026-04-05", "tomorrow", "kal", "parson", "aaj"
function isValidDate(text) {
  const t = text.trim().toLowerCase();
  // Urdu/conversational words
  if (['today', 'aaj', 'kal', 'tomorrow', 'parson', 'day after tomorrow'].includes(t)) return true;
  const formatOk = /^(\d{1,2}\s+\w+|\w+\s+\d{1,2})(\s+\d{4})?$/.test(t) ||
    /^\d{4}-\d{2}-\d{2}$/.test(t);
  if (!formatOk) return false;
  let d = new Date(text);
  if (isNaN(d.getTime())) {
    d = new Date(text + ' ' + new Date().getFullYear());
  }
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d >= today;
}

// Validates time: "2pm", "2:30 PM", "14:00", "11am", "2 pm", "2 baje" (voice-friendly)
function isValidTime(text) {
  const t = text.trim();
  return /^([01]?\d|2[0-3]):[0-5]\d(\s?(am|pm))?$/i.test(t) ||
    /^([01]?\d|2[0-3])\s?(am|pm)$/i.test(t) ||
    /^([01]?\d|2[0-3])\s(baje|o'clock|oclock)$/i.test(t);
}

// Parse user time input → "HH:MM" 24-hour string
function parseTimeTo24h(text) {
  const t = text.trim();
  // Handle "X baje" — assume PM for 1-7, AM otherwise (salon context)
  const bajeMatch = t.match(/^(\d{1,2})\s+baje$/i);
  if (bajeMatch) {
    let h = parseInt(bajeMatch[1], 10);
    if (h >= 1 && h <= 7) h += 12; // 2 baje = 14:00
    return `${String(h).padStart(2, '0')}:00`;
  }
  const match12 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const m = parseInt(match12[2] || '0', 10);
    const period = match12[3].toLowerCase();
    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const match24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    return `${String(parseInt(match24[1], 10)).padStart(2, '0')}:${match24[2]}`;
  }
  return null;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function formatTime12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function isWeekendDate(dateStr) {
  const t = dateStr.trim().toLowerCase();
  let d;
  if (t === 'today' || t === 'aaj') {
    d = new Date();
  } else if (t === 'tomorrow' || t === 'kal') {
    d = new Date();
    d.setDate(d.getDate() + 1);
  } else if (t === 'parson' || t === 'day after tomorrow') {
    d = new Date();
    d.setDate(d.getDate() + 2);
  } else {
    d = new Date(dateStr);
    if (isNaN(d.getTime())) {
      d = new Date(dateStr + ' ' + new Date().getFullYear());
    }
  }
  if (isNaN(d.getTime())) return false;
  const day = d.getDay();
  return day === 0 || day === 6;
}

function normalizeDateToISO(dateStr) {
  const t = (dateStr || '').trim().toLowerCase();
  let d;
  if (t === 'today' || t === 'aaj') {
    d = new Date();
  } else if (t === 'tomorrow' || t === 'kal') {
    d = new Date();
    d.setDate(d.getDate() + 1);
  } else if (t === 'parson' || t === 'day after tomorrow') {
    d = new Date();
    d.setDate(d.getDate() + 2);
  } else {
    d = new Date(dateStr);
    if (isNaN(d.getTime())) d = new Date(dateStr + ' ' + new Date().getFullYear());
  }
  if (isNaN(d.getTime())) return dateStr;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getSalonTiming(dateStr, tenantId) {
  try {
    const db = getDb();
    const dayType = isWeekendDate(dateStr) ? 'weekend' : 'workday';
    return db.prepare(`SELECT * FROM ${tenantId}_salon_timings WHERE day_type = ?`).get(dayType);
  } catch {
    return null;
  }
}


// ──────────────────────────────────────────────────────────────
//  CANCELLATION FLOW (CORRECTED)
// ──────────────────────────────────────────────────────────────

function handleCancellationFlow(userId, text, session, platform, tenantId) {
  if (!session || !session.state) {
    setSession(userId, tenantId, { state: 'CANCEL_ASK_PHONE', platform });
    return "To cancel an appointment, please enter your *phone number* (the one you used to book).";
  }

  if (session.state === 'CANCEL_ASK_PHONE') {
    if (!isValidPhone(text)) {
      return "Please enter a valid phone number (digits only, 7-15 characters).";
    }
    const phone = extractPhone(text.trim());

    const db = getDb();
    const bookings = db.prepare(`
      SELECT id, customer_name, service, date, time, status 
      FROM ${tenantId}_bookings 
      WHERE phone = ? AND status = 'confirmed' AND date >= date('now')
      ORDER BY date, time
    `).all(phone);

    if (bookings.length === 0) {
      clearSession(userId, tenantId);
      return "No upcoming bookings found for this phone number. Type *book* to make a new appointment.";
    }

    setSession(userId, tenantId, {
      ...session,
      state: 'CANCEL_SELECT_BOOKING',
      phone,
      bookings
    });

    let reply = `Found ${bookings.length} upcoming booking(s):\n\n`;
    bookings.forEach((b, i) => {
      reply += `${i + 1}. ${b.date} at ${b.time} — ${b.service}\n`;
    });
    reply += "\nReply with the *number* of the booking you want to cancel, or type *back* to go back.";

    return reply;
  }

  if (session.state === 'CANCEL_SELECT_BOOKING') {
    const num = parseInt(text, 10);
    if (isNaN(num) || num < 1 || num > session.bookings.length) {
      return `Please enter a number between 1 and ${session.bookings.length}.`;
    }

    const selected = session.bookings[num - 1];

    // Check if cancellation is allowed
    const bookingDateTime = new Date(`${selected.date}T${selected.time}`);
    const now = new Date();
    const hoursUntil = (bookingDateTime - now) / (1000 * 60 * 60);

    const db = getDb();
    const settings = db.prepare(`SELECT value FROM ${tenantId}_business_settings WHERE key = 'cancellation_hours'`).get();
    const cancellationHours = settings ? parseInt(settings.value) : 24;

    if (hoursUntil < cancellationHours) {
      return `⚠️ Cannot cancel within ${cancellationHours} hours of your appointment.\n\nPlease call the salon directly to cancel or reschedule.`;
    }

    setSession(userId, tenantId, {
      ...session,
      state: 'CANCEL_CONFIRM',
      cancelBookingId: selected.id,
      cancelBookingInfo: selected
    });

    return `Please confirm cancellation of:\n\n📅 ${selected.date} at ${selected.time}\n💇 ${selected.service}\n\nType *CONFIRM* to cancel, or *back* to cancel another booking.`;
  }

  if (session.state === 'CANCEL_CONFIRM') {
    if (text.toLowerCase() === 'confirm') {
      const db = getDb();

      // Update booking - FIXED: added tenantId prefix
      db.prepare(`
        UPDATE ${tenantId}_bookings 
        SET status = 'canceled', 
            cancellation_reason = 'Customer canceled via chat',
            updated_at = datetime('now')
        WHERE id = ?
      `).run(session.cancelBookingId);

      // Update staff_bookings - FIXED: added tenantId prefix
      db.prepare(`UPDATE ${tenantId}_staff_bookings SET status = 'canceled' WHERE bookingId = ?`).run(session.cancelBookingId);

      // Update customer metrics - FIXED: added tenantId prefix
      db.prepare(`
        INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, cancellations)
        VALUES (?, 1, 1)
        ON CONFLICT(phone) DO UPDATE SET
            cancellations = cancellations + 1,
            updated_at = datetime('now')
      `).run(session.phone);

      // Log audit - FIXED: added tenantId prefix
      db.prepare(`
        INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
        VALUES (?, 'confirmed', 'canceled', 'customer', 'Cancelled via chat')
      `).run(session.cancelBookingId);

      // Update cache - FIXED: added tenantId prefix
      const updatedBooking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(session.cancelBookingId);
      patchCache('bookings', 'upsert', updatedBooking).catch(e => console.error('[cache] cancel:', e.message));

      clearSession(userId, tenantId);

      const plt = session.platform || 'whatsapp';
      if (plt === 'instagram' || plt === 'facebook') {
        return `Your appointment on ${session.cancelBookingInfo.date} at ${session.cancelBookingInfo.time} has been cancelled. We hope to see you another time!`;
      }
      return `✅ *Booking Cancelled!*\n\nYour appointment on *${session.cancelBookingInfo.date}* at *${session.cancelBookingInfo.time}* has been cancelled.\n\nWe hope to see you another time!`;
    }

    if (text.toLowerCase() === 'back') {
      let reply = `Choose the booking to cancel:\n\n`;
      session.bookings.forEach((b, i) => {
        reply += `${i + 1}. ${b.date} at ${b.time} — ${b.service}\n`;
      });
      setSession(userId, tenantId, { ...session, state: 'CANCEL_SELECT_BOOKING' });
      return reply;
    }

    return `Type *CONFIRM* to cancel this booking, or *back* to choose another.`;
  }

  clearSession(userId, tenantId);
  return "Let's start over. Type *cancel* to cancel a booking.";
}

// ──────────────────────────────────────────────────────────────
//  RESCHEDULE FLOW (CORRECTED - fixed function name)
// ──────────────────────────────────────────────────────────────

function handleRescheduleFlow(userId, text, session, platform, tenantId) {
  if (!session || !session.state) {
    setSession(userId, tenantId, { state: 'RESCHEDULE_ASK_PHONE', platform });
    return "To reschedule an appointment, please enter your *phone number* (the one you used to book).";
  }

  if (session.state === 'RESCHEDULE_ASK_PHONE') {
    if (!isValidPhone(text)) {
      return "Please enter a valid phone number (digits only, 7-15 characters).";
    }
    const phone = extractPhone(text.trim());

    const db = getDb();
    const bookings = db.prepare(`
      SELECT id, customer_name, service, branch, date, time, status, staff_name
      FROM ${tenantId}_bookings 
      WHERE phone = ? AND status = 'confirmed' AND date >= date('now')
      ORDER BY date, time
    `).all(phone);

    if (bookings.length === 0) {
      clearSession(userId, tenantId);
      return "No upcoming bookings found for this phone number. Type *book* to make a new appointment.";
    }

    setSession(userId, tenantId, {
      ...session,
      state: 'RESCHEDULE_SELECT_BOOKING',
      phone,
      bookings
    });

    let reply = `Found ${bookings.length} upcoming booking(s):\n\n`;
    bookings.forEach((b, i) => {
      reply += `${i + 1}. ${b.date} at ${b.time} — ${b.service}\n`;
    });
    reply += "\nReply with the *number* of the booking you want to reschedule, or type *back* to go back.";

    return reply;
  }

  if (session.state === 'RESCHEDULE_SELECT_BOOKING') {
    const num = parseInt(text, 10);
    if (isNaN(num) || num < 1 || num > session.bookings.length) {
      return `Please enter a number between 1 and ${session.bookings.length}.`;
    }

    const selected = session.bookings[num - 1];

    // Check reschedule limit - FIXED: added tenantId prefix
    const db = getDb();
    const rescheduleCount = db.prepare(`
      SELECT COUNT(*) as count FROM ${tenantId}_booking_reschedules 
      WHERE original_booking_id = ? OR new_booking_id = ?
    `).get(selected.id, selected.id);

    const settings = db.prepare(`SELECT value FROM ${tenantId}_business_settings WHERE key = 'max_reschedules'`).get();
    const maxReschedules = settings ? parseInt(settings.value) : 2;

    if (rescheduleCount.count >= maxReschedules) {
      clearSession(userId, tenantId);
      return `⚠️ This booking has already been rescheduled ${maxReschedules} times. Please call the salon directly to make changes.`;
    }

    setSession(userId, tenantId, {
      ...session,
      state: 'RESCHEDULE_ASK_DATE',
      rescheduleBookingId: selected.id,
      rescheduleBooking: selected
    });

    return `Let's reschedule your ${selected.service}.\n\nWhat *date* would you prefer?\n\n_e.g. 30 March, April 5, tomorrow_`;
  }

  if (session.state === 'RESCHEDULE_ASK_DATE') {
    const dateText = extractDate(text);
    if (!isValidDate(dateText)) {
      return "Please enter a valid date (e.g., 30 March, April 5, tomorrow).";
    }

    const normalizedDate = normalizeDateToISO(dateText);

    const today = new Date().toISOString().slice(0, 10);
    if (normalizedDate < today) {
      return "Please choose a future date (today or later).";
    }

    setSession(userId, tenantId, { ...session, state: 'RESCHEDULE_ASK_TIME', newDate: normalizedDate });

    const timing = getSalonTiming(normalizedDate, tenantId);
    let timeHint = "_e.g. 2:00 PM, 11am, 3:30 PM_";
    if (timing) {
      timeHint = `Available: ${formatTime12h(timing.open_time)} – ${formatTime12h(timing.close_time)}\n\n${timeHint}`;
    }

    return `Great! What *time* works for you on ${normalizedDate}?\n\n${timeHint}`;
  }

  if (session.state === 'RESCHEDULE_ASK_TIME') {
    const timeText = extractTime(text);
    if (!isValidTime(timeText)) {
      return "Please enter a valid time (e.g., 2:00 PM, 11am, 14:00).";
    }

    const time24 = parseTimeTo24h(timeText);
    if (!time24) {
      return "Couldn't understand that time. Please try again (e.g., 2:00 PM, 11am).";
    }

    const db = getDb();
    const service = session.rescheduleBooking.service;
    // FIXED: added tenantId prefix
    const serviceRow = db.prepare(`SELECT durationMinutes FROM ${tenantId}_services WHERE name = ?`).get(service);
    const duration = serviceRow ? serviceRow.durationMinutes : 60;
    const endTime24 = calculateEndTime(time24, duration);

    const timing = getSalonTiming(session.newDate, tenantId);
    if (timing) {
      const requested = toMinutes(time24);
      const open = toMinutes(timing.open_time);
      const close = toMinutes(timing.close_time);
      if (requested < open || requested > close) {
        return `That time is outside our hours. Please choose a time between ${formatTime12h(timing.open_time)} and ${formatTime12h(timing.close_time)}.`;
      }
    }

    let availableStaff = getAvailableStaff(session.rescheduleBooking.branch, session.newDate, time24, endTime24, tenantId);

    if (availableStaff.length === 0) {
      return `Sorry, no staff available at ${time24} on ${session.newDate}. Please choose a different time.`;
    }

    let selectedStaff = availableStaff.find(s => s.id === session.rescheduleBooking.staff_id);
    if (!selectedStaff) {
      selectedStaff = availableStaff[0];
    }

    setSession(userId, tenantId, {
      ...session,
      state: 'RESCHEDULE_CONFIRM',
      newTime: time24,
      newEndTime: endTime24,
      newStaffId: selectedStaff.id,
      newStaffName: selectedStaff.name
    });

    return `Confirm reschedule:\n\n📅 Old: ${session.rescheduleBooking.date} at ${session.rescheduleBooking.time}\n📅 New: ${session.newDate} at ${time24}\n👤 Staff: ${selectedStaff.name}\n\nType *CONFIRM* to reschedule, or *cancel* to start over.`;
  }

  if (session.state === 'RESCHEDULE_CONFIRM') {
    if (text.toLowerCase() === 'confirm') {
      const db = getDb();
      const oldBooking = session.rescheduleBooking;

      // FIXED: added tenantId prefix for service duration
      const serviceRow = db.prepare(`SELECT durationMinutes FROM ${tenantId}_services WHERE name = ?`).get(oldBooking.service);
      const duration = serviceRow ? serviceRow.durationMinutes : 60;

      // FIXED: added tenantId prefix for INSERT
      const insertResult = db.prepare(`
        INSERT INTO ${tenantId}_bookings (
          customer_name, phone, service, branch, date, time, endTime,
          status, source, notes, staff_id, staff_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'reschedule', ?, ?, ?)
      `).run(
        oldBooking.customer_name, session.phone, oldBooking.service, oldBooking.branch,
        session.newDate, session.newTime, session.newEndTime,
        oldBooking.notes || null, session.newStaffId, session.newStaffName
      );

      const newBookingId = insertResult.lastInsertRowid;

      // FIXED: added tenantId prefix for UPDATE
      db.prepare(`UPDATE ${tenantId}_bookings SET status = 'rescheduled' WHERE id = ?`).run(oldBooking.id);

      if (oldBooking.staff_id) {
        db.prepare(`UPDATE ${tenantId}_staff_bookings SET status = 'canceled' WHERE bookingId = ?`).run(oldBooking.id);
      }

      const branchRow = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(oldBooking.branch);
      db.prepare(`
        INSERT INTO ${tenantId}_staff_bookings (staffId, bookingId, branchId, startTime, endTime, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(session.newStaffId, newBookingId, branchRow?.id || null,
        `${session.newDate} ${session.newTime}`, `${session.newDate} ${session.newEndTime}`);

      // FIXED: added tenantId prefix for reschedule record
      db.prepare(`
        INSERT INTO ${tenantId}_booking_reschedules (
          original_booking_id, new_booking_id, old_date, old_time, new_date, new_time, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(oldBooking.id, newBookingId, oldBooking.date, oldBooking.time,
        session.newDate, session.newTime, 'Rescheduled via chat');

      // FIXED: added tenantId prefix for customer metrics
      db.prepare(`
        INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, reschedules)
        VALUES (?, 1, 1)
        ON CONFLICT(phone) DO UPDATE SET
          reschedules = reschedules + 1,
          updated_at = datetime('now')
      `).run(session.phone);

      const newBooking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(newBookingId);
      patchCache('bookings', 'upsert', newBooking).catch(e => console.error('[cache] reschedule:', e.message));

      clearSession(userId, tenantId);

      const plt = session.platform || 'whatsapp';
      if (plt === 'instagram' || plt === 'facebook') {
        return `Your appointment has been rescheduled to ${session.newDate} at ${session.newTime}. We look forward to seeing you!`;
      }
      return `✅ *Booking Rescheduled!*\n\nYour appointment has been moved to:\n📅 *${session.newDate}*\n🕐 *${session.newTime}*\n👤 *${session.newStaffName}*\n\nWe look forward to seeing you!`;
    }

    clearSession(userId, tenantId);
    return "Reschedule cancelled. Type *reschedule* to try again.";
  }

  clearSession(userId, tenantId);
  return "Let's start over. Type *reschedule* to reschedule a booking.";
}

// ── Main booking step handler ─────────────────────────────────────────────────

function handleBookingStep(userId, text, session, platform, tenantId) {
  // STEP 1: No session yet → start booking
  if (!session) {
    const services = getServiceNames(tenantId);
    if (!services.length) {
      return 'Sorry, no services are available right now. Please contact us directly to book.';
    }
    setSession(userId, tenantId, { state: 'ASK_NAME', platform });
    return (
      '📅 *Let\'s book your appointment!*\n\n' +
      'First, what\'s your *name*?'
    );
  }

  // STEP 2: Got name → ask phone
  if (session.state === 'ASK_NAME') {
    if (!isValidName(text)) {
      return '⚠️ Please enter your *full name* (letters only).';
    }
    const cleanName = extractName(text.trim());
    setSession(userId, tenantId, { ...session, state: 'ASK_PHONE', name: cleanName });
    return `👋 Hi *${cleanName}*!\n\nWhat's your *phone number*?`;
  }

  // STEP 3: Got phone → ask service
  if (session.state === 'ASK_PHONE') {
    if (!isValidPhone(text)) {
      return '⚠️ Please enter a valid *phone number* (digits only, 7–15 characters).';
    }
    const services = getServiceNames(tenantId);
    if (!services.length) {
      clearSession(userId, tenantId);
      return 'Sorry, no services are available right now. Please contact us directly.';
    }
    setSession(userId, tenantId, { ...session, state: 'ASK_SERVICE', phone: extractPhone(text.trim()) });
    return (
      '✅ Got it!\n\nWhich *service* would you like?\n\n' +
      services.map((s, i) => `  *${i + 1}.* ${s}`).join('\n') +
      '\n\n_Reply with a number or service name._'
    );
  }

  // STEP 4: Got service → ask branch
  if (session.state === 'ASK_SERVICE') {
    const services = getServiceNames(tenantId);
    let chosenService = null;

    const num = parseInt(text, 10);
    if (!isNaN(num) && num >= 1 && num <= services.length) {
      chosenService = services[num - 1];
    } else {
      const lower = text.toLowerCase();
      chosenService = services.find(s => s.toLowerCase().includes(lower));
    }

    if (!chosenService) {
      return (
        '⚠️ Please choose a valid service by *number* or *name*.\n\n' +
        services.map((s, i) => `  *${i + 1}.* ${s}`).join('\n')
      );
    }

    setSession(userId, tenantId, { ...session, state: 'ASK_BRANCH', service: chosenService });
    return (
      `✨ *${chosenService}* — great choice!\n\n` +
      'Which *branch* would you like to visit?\n\n' +
      branchList(tenantId)
    );
  }

  // STEP 5: Got branch → ask staff
  if (session.state === 'ASK_BRANCH') {
    const branches = getBranches(tenantId);
    const branchNum = parseInt(text, 10);
    const lower = text.trim().toLowerCase();
    let branch = branches.find(b => b.number === branchNum);
    if (!branch) branch = branches.find(b => b.name.toLowerCase().includes(lower));
    if (!branch) {
      return (
        '⚠️ Please reply with a valid branch *number* or *name*:\n\n' +
        branchList(tenantId)
      );
    }
    const staffList = getActiveStaff(branch.name, tenantId);
    if (!staffList.length) {
      setSession(userId, tenantId, { ...session, state: 'ASK_DATE', branch: branch.name, staffId: null, staffName: null });
      return (
        `📍 *${branch.name}* — perfect!\n\n` +
        'What *date* would you like to come in?\n\n' +
        '_e.g. 30 March · April 5 · tomorrow_'
      );
    }
    setSession(userId, tenantId, { ...session, state: 'ASK_STAFF', branch: branch.name, staffOptions: staffList });
    let reply = `📍 *${branch.name}* — perfect!\n\n`;
    reply += 'Would you like to choose a specific *stylist/staff member*? (optional)\n\n';
    reply += staffList.map((s, i) => `  *${i + 1}.* ${s.name} _(${s.role})_`).join('\n');
    reply += '\n\n_Reply with a number to choose, or type *any* / *skip* for no preference._';
    return reply;
  }

  // ── STEP 5b: Got staff → ask date ─────────────────────────────────────────
  if (session.state === 'ASK_STAFF') {
    const staffList = session.staffOptions || [];
    let staffId = null;
    let staffName = null;
    let staffExplicitlyRequested = false;

    const lower = text.toLowerCase();
    if (lower === 'any' || lower === 'skip' || lower === 'no preference' || lower === 'none') {
      // No preference — will pick random staff at ASK_TIME
      staffExplicitlyRequested = false;
    } else {
      const num = parseInt(text, 10);
      if (!isNaN(num) && num >= 1 && num <= staffList.length) {
        staffId = staffList[num - 1].id;
        staffName = staffList[num - 1].name;
        staffExplicitlyRequested = true;
      } else {
        const match = staffList.find(s => s.name.toLowerCase().includes(lower));
        if (match) {
          staffId = match.id;
          staffName = match.name;
          staffExplicitlyRequested = true;
        } else {
          let reply = '⚠️ Please choose by *number*, type a *name*, or type *skip* for no preference.\n\n';
          reply += staffList.map((s, i) => `  *${i + 1}.* ${s.name} _(${s.role})_`).join('\n');
          return reply;
        }
      }
    }

    console.log('[BOOKING FIELDS] staff:', staffId, staffName, '(explicit:', staffExplicitlyRequested, ')');
    setSession(userId, tenantId, { ...session, state: 'ASK_DATE', staffId, staffName, staffExplicitlyRequested });
    const staffMsg = staffName ? `👤 *${staffName}* — great choice!\n\n` : '';
    return (
      staffMsg +
      'What *date* would you like to come in?\n\n' +
      '_e.g. 30 March · April 5 · tomorrow_'
    );
  }

  // ── STEP 6: Got date → ask time ───────────────────────────────────────────
  if (session.state === 'ASK_DATE') {
    const dateText = extractDate(text);
    console.log('[BOOKING FIELDS] ASK_DATE raw:', JSON.stringify(text), '→ extracted:', JSON.stringify(dateText));
    if (!isValidDate(dateText)) {
      return (
        '⚠️ Please enter a valid *date*.\n\n' +
        '_e.g. 30 March · April 5 · tomorrow · 2026-04-05_'
      );
    }
    const normalizedDate = normalizeDateToISO(dateText);
    setSession(userId, tenantId, { ...session, state: 'ASK_TIME', date: normalizedDate });

    const timing = getSalonTiming(normalizedDate,tenantId);
    let timeHint = '_e.g. 2:00 PM · 11am · 3:30 PM · 14:00_';
    if (timing) {
      timeHint = `🕐 Available: *${formatTime12h(timing.open_time)} – ${formatTime12h(timing.close_time)}*\n\n${timeHint}`;
    }

    return (
      `📆 *${dateText}* — noted!\n\n` +
      `What *time* works for you?\n\n${timeHint}`
    );
  }

  // ── STEP 7: Got time → validate staff availability & save ──────────────────
  if (session.state === 'ASK_TIME') {
    const timeText = extractTime(text);
    console.log('[BOOKING FIELDS] ASK_TIME raw:', JSON.stringify(text), '→ extracted:', JSON.stringify(timeText));
    if (!isValidTime(timeText)) {
      return (
        '⚠️ Please enter a valid *time*.\n\n' +
        '_e.g. 2:00 PM · 11am · 3:30 PM · 14:00_'
      );
    }

    const time24 = parseTimeTo24h(timeText);
    if (time24) {
      const timing = getSalonTiming(session.date,tenantId);
      if (timing) {
        const requested = toMinutes(time24);
        const open = toMinutes(timing.open_time);
        const close = toMinutes(timing.close_time);
        if (requested < open || requested > close) {
          const label = timing.day_type === 'weekend' ? 'weekend' : 'weekday';
          const openFmt = formatTime12h(timing.open_time);
          const closeFmt = formatTime12h(timing.close_time);
          const plt = session.platform || 'whatsapp';

          if (plt === 'instagram' || plt === 'facebook') {
            return (
              `Unavailable time selected.\n\n` +
              `Our ${label} hours are ${openFmt} to ${closeFmt}.\n` +
              `Please reply with a time within that range.`
            );
          }
          if (plt === 'webchat' || plt === 'voice') {
            return (
              `Selected time is not available. ` +
              `Please choose a slot between ${openFmt} and ${closeFmt}.`
            );
          }
          return (
            `⚠️ That time is outside our ${label} hours.\n\n` +
            `🕐 Available: *${openFmt} – ${closeFmt}*\n\n` +
            'Please choose a time within that range.'
          );
        }
      }
    }

    // Calculate end time based on service duration
    const serviceDuration = getServiceDuration(session.service, tenantId);
    const endTime24 = calculateEndTime(time24, serviceDuration);

    // Check staff availability and handle random assignment
    let staffId = session.staffId || null;
    let staffName = session.staffName || null;
    let staffExplicitlyRequested = session.staffExplicitlyRequested || false;

    if (staffId && session.staffExplicitlyRequested) {
      // User explicitly chose a staff — validate availability
      if (!checkStaffAvailability(staffId, session.date, time24, endTime24, tenantId)) {
        return (
          `⚠️ *${staffName}* is not available at *${formatTime12h(time24)}* on *${session.date}*.\n\n` +
          'Please choose a different *time*, or type *any* / *skip* to choose another stylist.'
        );
      }
    } else if (!staffId) {
      // User did not choose staff — pick random available
      const randomStaff = pickRandomAvailableStaff(session.branch, session.date, time24, endTime24,tenantId);
      if (randomStaff) {
        staffId = randomStaff.id;
        staffName = randomStaff.name;
        staffExplicitlyRequested = false; // don't increment requestedCount for random
      }
      // If no available staff, continue anyway (show warning in confirmation)
    }

    const bookingData = {
      name: session.name,
      phone: session.phone,
      service: session.service,
      branch: session.branch,
      date: session.date,
      time: time24,
      endTime: endTime24,
      staffId,
      staffName,
      staffExplicitlyRequested,
    };
    console.log('[BOOKING FIELDS] SAVING BOOKING:', JSON.stringify(bookingData));

    try {
      saveBooking(bookingData, session.platform, tenantId);
    } catch (err) {
      clearSession(userId, tenantId);;
      return 'Sorry, there was an error saving your booking. Please try again by typing *book*.';
    }

    clearSession(userId, tenantId);;

    return (
      '✅ *Booking Received!*\n\n' +
      `👤 *Name:* ${bookingData.name}\n` +
      `📞 *Phone:* ${bookingData.phone}\n` +
      `✨ *Service:* ${bookingData.service}\n` +
      `📍 *Branch:* ${bookingData.branch}\n` +
      (bookingData.staffName ? `💅 *Stylist:* ${bookingData.staffName}\n` : '') +
      `📆 *Date:* ${bookingData.date}\n` +
      `🕐 *Time:* ${bookingData.time} – ${bookingData.endTime}\n\n` +
      '⏳ Our team will *confirm your appointment* shortly.\n' +
      'See you soon! 💅'
    );
  }

  // Unexpected state — reset
  clearSession(userId, tenantId);;
  return 'Let\'s start fresh! Type *book* to make an appointment.';
}

module.exports = { handleBookingStep, handleRescheduleFlow, handleCancellationFlow };