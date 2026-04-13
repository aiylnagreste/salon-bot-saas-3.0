const { WebSocketServer } = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');
const { getDb } = require('../db/database');
const { getCache, patchCache } = require('../cache/salonDataCache');

// ── Voice tool implementations ──────────────────────────────────────────────

// Convert relative/natural date words to YYYY-MM-DD
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

function isWeekendForDate(dateStr) {
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
    if (isNaN(d.getTime())) return false;
    return d.getDay() === 0 || d.getDay() === 6;
}

// Helper to get tenant-specific cache
function getTenantCache(tenantId) {
    const cache = getCache(tenantId);
    return cache;
}

async function handleVoiceTool(name, args, tenantId) {
    const db = getDb();
    const { getCache } = require('../cache/salonDataCache');
    const cache = getCache(tenantId); // Now gets tenant-specific cache

    if (name === 'get_services') {
        const rows = (cache && cache.services && cache.services.length)
            ? cache.services
            : db.prepare(`SELECT name, price FROM ${tenantId}_services ORDER BY name`).all();
        if (!rows.length) return 'No services available right now.';
        return rows.map(r => `${r.name}: ${r.price}`).join(', ');
    }

    if (name === 'get_branches') {
        const rows = (cache && cache.branches && cache.branches.length)
            ? cache.branches
            : db.prepare(`SELECT name, address, phone FROM ${tenantId}_branches ORDER BY name`).all();
        if (!rows.length) return 'No branches available right now.';
        return rows.map(r => [r.name, r.address, r.phone].filter(Boolean).join(' — ')).join(' | ');
    }

    if (name === 'get_timings') {
        const dayType = isWeekendForDate(args.date || 'today') ? 'weekend' : 'workday';
        const row = (cache && cache.salonTimings && cache.salonTimings[dayType])
            ? cache.salonTimings[dayType]
            : db.prepare(`SELECT open_time, close_time FROM ${tenantId}_salon_timings WHERE day_type = ?`).get(dayType);
        if (!row) return 'Timing info not configured.';
        return `Salon is open ${row.open_time} to ${row.close_time} on ${dayType}s.`;
    }

    if (name === 'get_staff') {
        const branchName = (args.branch || '').trim();
        let brRow = null;
        if (cache && cache.branches && cache.branches.length) {
            const bn = branchName.toLowerCase();
            brRow = cache.branches.find(b => b.name.toLowerCase() === bn)
                || cache.branches.find(b => b.name.toLowerCase().includes(bn));
        }
        if (!brRow) brRow = db.prepare(`SELECT id, name FROM ${tenantId}_branches WHERE LOWER(name) = LOWER(?)`).get(branchName);
        if (!brRow) brRow = db.prepare(`SELECT id, name FROM ${tenantId}_branches WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'`).get(branchName);
        if (!brRow) return 'Branch not found.';

        const staff = db.prepare(`
            SELECT s.id, s.name, r.name as role
            FROM ${tenantId}_staff s
            LEFT JOIN ${tenantId}_staff_roles r ON s.role_id = r.id
            WHERE s.branch_id = ?
              AND (r.name IS NULL OR LOWER(r.name) NOT IN ('admin', 'receptionist', 'manager'))
            ORDER BY s.name
        `).all(brRow.id);

        if (!staff.length) return 'NO_STAFF';
        return staff.map(s => `${s.name} (${s.role || 'Stylist'})`).join(', ');
    }

    if (name === 'create_booking') {
        const { name: custName, phone, service, branch, date, time, staff_name } = args;

        if (!custName || !phone || !service || !branch || !date || !time) {
            return 'Missing required fields. Need: name, phone, service, branch, date, time.';
        }

        const normalizedDate = normalizeDateToISO(date);

        const bookingDate = new Date(normalizedDate);
        if (!isNaN(bookingDate.getTime())) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            bookingDate.setHours(0, 0, 0, 0);
            if (bookingDate < today) {
                return `Sorry, ${date} has already passed. Please choose today or a future date.`;
            }
        }

        // If booking is for today, reject times that have already passed
        const todayISO = new Date().toISOString().slice(0, 10);
        if (normalizedDate === todayISO && time) {
            const now = new Date();
            const currentMins = now.getHours() * 60 + now.getMinutes();
            const [bh, bm] = time.trim().split(':').map(Number);
            const bookingMins = bh * 60 + bm;
            if (bookingMins <= currentMins) {
                const nowFmt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                return `Sorry, ${time} has already passed today — current time is ${nowFmt}. Please choose a later time.`;
            }
        }

        // Cache-first service lookup with tenant prefix
        let svcRow = null;
        if (cache?.services?.length) {
            const svcLower = service.trim().toLowerCase();
            svcRow = cache.services.find(s => s.name.toLowerCase() === svcLower)
                || cache.services.find(s => s.name.toLowerCase().includes(svcLower));
        }
        if (!svcRow) {
            svcRow = db.prepare(`SELECT name FROM ${tenantId}_services WHERE LOWER(name) = LOWER(?)`).get(service.trim())
                || db.prepare(`SELECT name FROM ${tenantId}_services WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'`).get(service.trim());
        }
        if (!svcRow) return `Service "${service}" not found. Please check the service name.`;

        // Cache-first branch lookup with tenant prefix
        let brRow = null;
        if (cache?.branches?.length) {
            const brLower = branch.trim().toLowerCase();
            brRow = cache.branches.find(b => b.name.toLowerCase() === brLower)
                || cache.branches.find(b => b.name.toLowerCase().includes(brLower));
        }
        if (!brRow) {
            brRow = db.prepare(`SELECT id, name FROM ${tenantId}_branches WHERE LOWER(name) = LOWER(?)`).get(branch.trim())
                || db.prepare(`SELECT id, name FROM ${tenantId}_branches WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'`).get(branch.trim());
        }
        if (!brRow) return `Branch "${branch}" not found. Please check the branch name.`;

        // Validate time against salon hours
        const dayType = isWeekendForDate(normalizedDate) ? 'weekend' : 'workday';
        let timingRow = cache?.salonTimings?.[dayType] || null;
        if (!timingRow) {
            timingRow = db.prepare(`SELECT open_time, close_time FROM ${tenantId}_salon_timings WHERE day_type = ?`).get(dayType);
        }
        if (timingRow && time) {
            const toMins = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
            const requested = toMins(time.trim());
            const open = toMins(timingRow.open_time);
            const close = toMins(timingRow.close_time);
            if (requested < open || requested > close) {
                return `Sorry, we are closed at ${time}. Our ${dayType} hours are ${timingRow.open_time} to ${timingRow.close_time}. Please choose a different time.`;
            }
        }

        // Optional staff lookup with tenant prefix
        let staffId = null;
        let staffNameSaved = null;
        if (staff_name && staff_name.trim()) {
            const staffRow = db.prepare(`
                SELECT s.id, s.name FROM ${tenantId}_staff s
                WHERE s.branch_id = ? AND LOWER(s.name) LIKE '%' || LOWER(?) || '%'
                LIMIT 1
            `).get(brRow.id, staff_name.trim());
            if (staffRow) {
                staffId = staffRow.id;
                staffNameSaved = staffRow.name;
            }
        }

        console.log('[BOOKING FIELDS] SAVING VOICE BOOKING:', JSON.stringify({
            name: custName, phone, service: svcRow.name, branch: brRow.name,
            date: normalizedDate, time, staff: staffNameSaved || null, tenantId
        }));

        // Calculate endTime based on service duration
        let endTime = null;
        const serviceDurationRow = db.prepare(`SELECT durationMinutes FROM ${tenantId}_services WHERE name = ?`).get(svcRow.name);
        if (serviceDurationRow && serviceDurationRow.durationMinutes) {
            const duration = serviceDurationRow.durationMinutes;
            const [h, m] = time.trim().split(':').map(Number);
            const totalMinutes = h * 60 + m + duration;
            const newH = Math.floor(totalMinutes / 60) % 24;
            const newM = totalMinutes % 60;
            endTime = `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
        }

        const insertResult = db.prepare(`
            INSERT INTO ${tenantId}_bookings (customer_name, phone, service, branch, date, time, endTime, status, source, staff_id, staff_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'voice', ?, ?)
        `).run(custName.trim(), phone.trim(), svcRow.name, brRow.name, normalizedDate, time.trim(), endTime, staffId, staffNameSaved);

        const newBooking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(insertResult.lastInsertRowid);
        if (newBooking) patchCache('bookings', 'upsert', newBooking).catch(err => console.error('[cache] voice booking patch:', err.message));

        let confirm = `Booking confirmed for ${custName} — ${svcRow.name} at ${brRow.name} on ${normalizedDate} at ${time}`;
        if (endTime) confirm += ` to ${endTime}`;
        if (staffNameSaved) confirm += ` with ${staffNameSaved}`;
        return confirm + '.';
    }
    
    if (name === 'cancel_booking') {
        const { phone, confirm, booking_index } = args;

        if (!phone) return 'Phone number is required to cancel a booking.';

        const db = getDb();

        // STEP 1: List bookings (when confirm is not provided)
        if (!confirm) {
            const bookings = db.prepare(`
            SELECT id, date, time, service, branch 
            FROM ${tenantId}_bookings 
            WHERE phone = ? AND status = 'confirmed' AND date >= date('now')
            ORDER BY date, time
        `).all(phone);

            if (bookings.length === 0) {
                return 'NO_BOOKINGS';
            }

            // Return list of bookings for Gemini to read to caller
            const bookingList = bookings.map((b, i) =>
                `${i + 1}. ${b.date} at ${b.time} — ${b.service} at ${b.branch}`
            ).join(' | ');

            return `FOUND_BOOKINGS|${bookings.length}|${bookingList}`;
        }

        // STEP 2: Execute cancellation (when caller confirms)
        if (confirm === 'true') {
            const bookings = db.prepare(`
            SELECT id, date, time, service, branch 
            FROM ${tenantId}_bookings 
            WHERE phone = ? AND status = 'confirmed' AND date >= date('now')
            ORDER BY date, time
        `).all(phone);

            if (bookings.length === 0) {
                return 'NO_BOOKINGS';
            }

            // Use booking_index if provided (1-based), otherwise default to first
            const index = booking_index ? parseInt(booking_index, 10) - 1 : 0;
            const booking = bookings[index] || bookings[0];

            // Check cancellation policy
            const settings = db.prepare(`SELECT value FROM ${tenantId}_business_settings WHERE key = 'cancellation_hours'`).get();
            const cancellationHours = settings ? parseInt(settings.value) : 24;

            const bookingDateTime = new Date(`${booking.date}T${booking.time}`);
            const now = new Date();
            const hoursUntil = (bookingDateTime - now) / (1000 * 60 * 60);

            if (hoursUntil < cancellationHours) {
                return `CANNOT_CANCEL|${cancellationHours}`;
            }

            db.prepare(`
            UPDATE ${tenantId}_bookings 
            SET status = 'canceled', 
                cancellation_reason = 'Customer canceled via voice call',
                updated_at = datetime('now')
            WHERE id = ?
        `).run(booking.id);

            db.prepare(`UPDATE ${tenantId}_staff_bookings SET status = 'canceled' WHERE bookingId = ?`).run(booking.id);

            // Update customer metrics
            db.prepare(`
            INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, cancellations)
            VALUES (?, 1, 1)
            ON CONFLICT(phone) DO UPDATE SET
                cancellations = cancellations + 1,
                updated_at = datetime('now')
        `).run(phone);

            // Update cache
            const updatedBooking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(booking.id);
            patchCache(tenantId, 'bookings', 'upsert', updatedBooking).catch(e => console.error('[cache] voice cancel:', e.message));

            return `CANCELLED|${booking.date}|${booking.time}|${booking.service}`;
        }

        return 'Please confirm cancellation by saying YES.';
    }

    if (name === 'reschedule_booking') {
        const { phone, new_date, new_time, confirm, booking_index } = args;

        if (!phone) return 'Phone number is required to reschedule a booking.';

        const db = getDb();

        // STEP 1: List bookings (when new_date is not provided)
        if (!new_date) {
            const bookings = db.prepare(`
            SELECT id, date, time, service, branch, staff_id, staff_name
            FROM ${tenantId}_bookings 
            WHERE phone = ? AND status = 'confirmed' AND date >= date('now')
            ORDER BY date, time
        `).all(phone);

            if (bookings.length === 0) {
                return 'NO_BOOKINGS';
            }

            const bookingList = bookings.map((b, i) =>
                `${i + 1}. ${b.date} at ${b.time} — ${b.service}`
            ).join(' | ');

            return `FOUND_BOOKINGS|${bookings.length}|${bookingList}`;
        }

        // Helper function for end time calculation
        const calculateEndTime = (startTime, durationMin) => {
            const [h, m] = startTime.split(':').map(Number);
            const total = h * 60 + m + durationMin;
            const newH = Math.floor(total / 60) % 24;
            const newM = total % 60;
            return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
        };

        // Helper for staff availability
        const getAvailableStaffForVoice = (branchName, date, startTime, endTime) => {
            try {
                const branch = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branchName);
                if (!branch) return [];

                const staff = db.prepare(`
                SELECT s.id, s.name FROM ${tenantId}_staff s
                WHERE s.status = 'active' 
                AND (s.branch_id = ? OR s.branch_id IS NULL)
                AND s.role NOT IN ('admin', 'manager', 'receptionist')
            `).all(branch.id);

                const startFull = date + ' ' + startTime;
                const endFull = date + ' ' + endTime;

                return staff.filter(s => {
                    const conflicts = db.prepare(`
                    SELECT COUNT(*) as cnt FROM ${tenantId}_staff_bookings
                    WHERE staffId = ? AND status = 'active'
                    AND startTime < ? AND endTime > ?
                `).get(s.id, endFull, startFull);
                    return conflicts.cnt === 0;
                });
            } catch {
                return [];
            }
        };

        // STEP 2: Check availability and show confirmation
        if (!confirm) {
            const bookings = db.prepare(`
            SELECT id, customer_name, service, branch, date, time, staff_id, staff_name, notes
            FROM ${tenantId}_bookings 
            WHERE phone = ? AND status = 'confirmed' AND date >= date('now')
            ORDER BY date, time
        `).all(phone);

            if (bookings.length === 0) {
                return 'NO_BOOKINGS';
            }

            const index = booking_index ? parseInt(booking_index, 10) - 1 : 0;
            const oldBooking = bookings[index] || bookings[0];

            const normalizedDate = normalizeDateToISO(new_date);

            // Validate date is not in past
            const today = new Date().toISOString().slice(0, 10);
            if (normalizedDate < today) {
                return 'DATE_IN_PAST';
            }

            // Get service duration
            const serviceRow = db.prepare(`SELECT durationMinutes FROM ${tenantId}_services WHERE name = ?`).get(oldBooking.service);
            const duration = serviceRow ? serviceRow.durationMinutes : 60;
            const endTime24 = calculateEndTime(new_time, duration);

            // Check salon hours
            const dayType = isWeekendForDate(normalizedDate) ? 'weekend' : 'workday';
            const timing = db.prepare(`SELECT open_time, close_time FROM ${tenantId}_salon_timings WHERE day_type = ?`).get(dayType);

            if (timing) {
                const toMins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
                const reqMins = toMins(new_time);
                const openMins = toMins(timing.open_time);
                const closeMins = toMins(timing.close_time);

                if (reqMins < openMins || reqMins > closeMins) {
                    return `TIME_OUTSIDE_HOURS|${timing.open_time}|${timing.close_time}`;
                }
            }

            // Check if time has passed for today
            const todayISO = new Date().toISOString().slice(0, 10);
            if (normalizedDate === todayISO) {
                const now = new Date();
                const currentMins = now.getHours() * 60 + now.getMinutes();
                const [bh, bm] = new_time.split(':').map(Number);
                const bookingMins = bh * 60 + bm;
                if (bookingMins <= currentMins) {
                    return 'TIME_IN_PAST';
                }
            }

            // Check staff availability
            const availableStaff = getAvailableStaffForVoice(oldBooking.branch, normalizedDate, new_time, endTime24);

            if (availableStaff.length === 0) {
                return 'NO_STAFF_AVAILABLE';
            }

            // Try to keep same staff, otherwise pick first available
            let selectedStaff = availableStaff.find(s => s.id === oldBooking.staff_id);
            if (!selectedStaff) {
                selectedStaff = availableStaff[0];
            }

            return `READY_TO_RESCHEDULE|${oldBooking.id}|${oldBooking.date}|${oldBooking.time}|${oldBooking.service}|${normalizedDate}|${new_time}|${selectedStaff.name}`;
        }

        // STEP 3: Execute reschedule (when confirmed)
        if (confirm === 'true') {
            const { booking_id, new_date: finalDate, new_time: finalTime, staff_name: staffName } = args;

            if (!booking_id || !finalDate || !finalTime || !staffName) {
                return 'Missing required fields for reschedule.';
            }

            const oldBooking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(booking_id);
            if (!oldBooking) return 'BOOKING_NOT_FOUND';

            // Check reschedule limit
            const rescheduleCount = db.prepare(`
            SELECT COUNT(*) as count FROM ${tenantId}_booking_reschedules 
            WHERE original_booking_id = ? OR new_booking_id = ?
        `).get(booking_id, booking_id);

            const settings = db.prepare(`SELECT value FROM ${tenantId}_business_settings WHERE key = 'max_reschedules'`).get();
            const maxReschedules = settings ? parseInt(settings.value) : 2;

            if (rescheduleCount.count >= maxReschedules) {
                return `MAX_RESCHEDULES_EXCEEDED|${maxReschedules}`;
            }

            const normalizedDate = normalizeDateToISO(finalDate);
            const serviceRow = db.prepare(`SELECT durationMinutes FROM ${tenantId}_services WHERE name = ?`).get(oldBooking.service);
            const duration = serviceRow ? serviceRow.durationMinutes : 60;
            const endTime = calculateEndTime(finalTime, duration);

            const staffRow = db.prepare(`SELECT id FROM ${tenantId}_staff WHERE name = ?`).get(staffName);
            const staffId = staffRow ? staffRow.id : null;

            const insertResult = db.prepare(`
            INSERT INTO ${tenantId}_bookings (
                customer_name, phone, service, branch, date, time, endTime,
                status, source, notes, staff_id, staff_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'voice_reschedule', ?, ?, ?)
        `).run(
                oldBooking.customer_name, oldBooking.phone, oldBooking.service, oldBooking.branch,
                normalizedDate, finalTime, endTime, oldBooking.notes || null, staffId, staffName
            );

            const newBookingId = insertResult.lastInsertRowid;

            db.prepare(`UPDATE ${tenantId}_bookings SET status = 'rescheduled' WHERE id = ?`).run(booking_id);

            if (oldBooking.staff_id) {
                db.prepare(`UPDATE ${tenantId}_staff_bookings SET status = 'canceled' WHERE bookingId = ?`).run(booking_id);
            }

            const branchRow = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(oldBooking.branch);
            db.prepare(`
            INSERT INTO ${tenantId}_staff_bookings (staffId, bookingId, branchId, startTime, endTime, status)
            VALUES (?, ?, ?, ?, ?, 'active')
        `).run(staffId, newBookingId, branchRow?.id || null,
                `${normalizedDate} ${finalTime}`, `${normalizedDate} ${endTime}`);

            db.prepare(`
            INSERT INTO ${tenantId}_booking_reschedules (
                original_booking_id, new_booking_id, old_date, old_time, new_date, new_time, reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(booking_id, newBookingId, oldBooking.date, oldBooking.time,
                normalizedDate, finalTime, 'Rescheduled via voice call');

            db.prepare(`
            INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, reschedules)
            VALUES (?, 1, 1)
            ON CONFLICT(phone) DO UPDATE SET
                reschedules = reschedules + 1,
                updated_at = datetime('now')
        `).run(oldBooking.phone);

            const newBooking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(newBookingId);
            patchCache(tenantId, 'bookings', 'upsert', newBooking).catch(e => console.error('[cache] voice reschedule:', e.message));

            return `RESCHEDULED|${normalizedDate}|${finalTime}|${staffName}|${oldBooking.service}`;
        }

        return 'Please confirm reschedule by saying YES.';
    }

    return `Unknown tool: ${name}`;

}

// ── WebSocket call server ────────────────────────────────────────────────────

function setupCallServer(server) {
    const wss = new WebSocketServer({ noServer: true });

    // Store tenant ID per WebSocket connection
    const connectionTenants = new Map();

    // Validate Origin so only allowed domains can open voice calls
    server.on('upgrade', (req, socket, head) => {
        // Extract tenantId from URL query parameter
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname !== '/api/call') return;

        const tenantId = url.searchParams.get('tenantId');

        if (!tenantId) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing tenantId');
            socket.destroy();
            return;
        }

        const allowed = (process.env.WIDGET_ALLOWED_ORIGINS || '*')
            .split(',')
            .map(o => o.trim());
        const origin = req.headers.origin || '';

        if (!allowed.includes('*') && !allowed.includes(origin)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }

        // Verify tenant exists and is active
        const { getTenantById } = require('../db/tenantManager');
        const tenant = getTenantById(tenantId);

        if (!tenant || tenant.status !== 'active') {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\nTenant not found or inactive');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            connectionTenants.set(ws, tenantId);
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', async (ws) => {
        const tenantId = connectionTenants.get(ws);
        console.log('[call] Client connected for tenant:', tenantId);

        // Unique session ID per call
        const callSessionId = `__CALL_${tenantId}_${Date.now()}_${Math.random().toString(36).slice(2)}__`;

        const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        let sessionClosed = false;

        // Get tenant info for personalized greeting
        const { getTenantById } = require('../db/tenantManager');
        const tenant = getTenantById(tenantId);
        const salonName = tenant?.salon_name || 'Salon';

        try {
            const session = await client.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-12-2025',

                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
                    },

                    systemInstruction: `
You are a live voice receptionist for ${salonName} beauty salon. You speak ONLY in pure Urdu or English — never Hindi.

LANGUAGE RULES:
- YOUR RESPONSES MUST BE IN URDU OR ENGLISH, based on the caller's language. If the caller speaks in Urdu, respond in Urdu. If they speak in English, respond in English.
- DEFAULT TO ENGLISH if you are unsure about the caller's language, but try to pick up on any Urdu words or phrases they use as a signal to switch to Urdu.
- NEVER use Hindi words. Use "shukriya" not "shukria", "bohat acha" not "bahut accha", "khubsoorat" not "sundar".
- Do not say "aapka din shubh ho" or any Hindi blessings.

GREETING:
- When the caller's first message is "__GREET__", greet warmly without calling any tool.
  English: "Hello! Welcome to ${salonName}. How can I help you today?"
  Urdu: "Assalamu Alaikum! ${salonName} mein khush aamdeed. Main aap ki kya khidmat kar sakti hoon?"

CRITICAL — TOOL DATA ONLY:
- NEVER mention branch names, service names, prices, or locations from your own knowledge.
- ALL branch and service information MUST come exclusively from get_branches and get_services tool results.
- If you have not called the tool yet, you do not know the branches or services — call the tool first.

BOOKING (when caller wants to book an appointment):
1. Immediately call get_services AND get_branches so you know what is available.
2. Collect these required fields — use values the caller already mentioned, ask only for missing ones:
   • name    — caller's name (e.g. "Alyan")
   • phone   — digits only, no spaces (e.g. "03001234567")
   • service — must exactly match a name returned by get_services
   • branch  — must exactly match a name returned by get_branches
   • date    — accept any natural date the caller gives ("kal", "Friday", "30 April") and YOU convert it internally. NEVER ask the caller to type a date in any specific format. Reject past dates — ask them to choose today or a future date.
   • time    — accept any natural time ("2 baje", "3 pm", "half past two") and YOU convert it to HH:MM internally. NEVER ask the caller to type a time in any specific format. Only accept future times — if the date is today and the time has already passed, ask them to choose a later time.
3. Call get_timings to verify the requested time is within salon hours.
4. Once ALL fields are collected, read them back to the caller and ask: "Shall I confirm this booking?"
5. As soon as the caller says yes/confirm/theek hai/okay, call create_booking right away — do not ask again.

CANCELLATION (when caller wants to cancel an appointment):
1. Ask for the caller's phone number they used for booking.
2. Call cancel_booking with the phone number.
3. If the tool returns a successful cancellation message, confirm it to the caller:
   English: "Your appointment has been cancelled. We hope to see you another time!"
   Urdu: "Aap ki appointment cancel kar di gayi hai. Hum umeed karte hain ke aap phir aayenge!"
4. If no bookings are found, tell the caller: "I couldn't find any upcoming bookings for that phone number."

RESCHEDULE (when caller wants to change appointment time/date):
1. Ask for the caller's phone number they used for booking.
2. Ask for the new date and new time they prefer.
3. Call reschedule_booking with the phone number, new date, and new time.
4. If successful, confirm the new details:
   English: "Your appointment has been rescheduled to [date] at [time]."
   Urdu: "Aap ki appointment [date] ko [time] par tabdeel kar di gayi hai."
5. If no bookings found or staff unavailable, explain the issue and offer alternatives


PRICES / SERVICES / BRANCHES / DEALS:
- For any question about prices or services: call get_services.
- For any question about locations or branches: call get_branches — never guess or use your own knowledge.

GENERAL:
- Keep responses short and natural — this is a phone call, not a chat.
- No bullet points, no markdown.
- If unsure about one thing, ask one short question.
`,

                    tools: [
                        {
                            functionDeclarations: [
                                {
                                    name: 'get_services',
                                    description: 'Get all available salon services and their prices.',
                                    parameters: { type: 'object', properties: {} },
                                },
                                {
                                    name: 'get_branches',
                                    description: 'Get all salon branch names and locations.',
                                    parameters: { type: 'object', properties: {} },
                                },
                                {
                                    name: 'get_timings',
                                    description: 'Get salon opening and closing hours for a given date.',
                                    parameters: {
                                        type: 'object',
                                        properties: {
                                            date: {
                                                type: 'string',
                                                description: 'Date string, e.g. "kal", "tomorrow", "today", "30 March", "2026-04-01"',
                                            },
                                        },
                                        required: ['date'],
                                    },
                                },
                                {
                                    name: 'create_booking',
                                    description: 'Save the appointment to the database. Only call this after the caller has confirmed all details.',
                                    parameters: {
                                        type: 'object',
                                        properties: {
                                            name: { type: 'string', description: 'Customer full name' },
                                            phone: { type: 'string', description: 'Phone number, digits only, e.g. "03001234567"' },
                                            service: { type: 'string', description: 'Exact service name from get_services' },
                                            branch: { type: 'string', description: 'Exact branch name from get_branches' },
                                            date: { type: 'string', description: 'Appointment date, e.g. "kal", "30 March", "2026-04-01"' },
                                            time: { type: 'string', description: 'Appointment time in HH:MM 24-hour format, e.g. "14:00"' },
                                        },
                                        required: ['name', 'phone', 'service', 'branch', 'date', 'time'],
                                    },
                                },
                                {
                                    name: 'cancel_booking',
                                    description: 'Cancel an existing booking using phone number',
                                    parameters: {
                                        type: 'object',
                                        properties: {
                                            phone: { type: 'string', description: 'Phone number used for booking' },
                                        },
                                        required: ['phone'],
                                    },
                                },
                                {
                                    name: 'reschedule_booking',
                                    description: 'Reschedule an existing booking',
                                    parameters: {
                                        type: 'object',
                                        properties: {
                                            phone: { type: 'string', description: 'Phone number used for booking' },
                                            new_date: { type: 'string', description: 'New appointment date' },
                                            new_time: { type: 'string', description: 'New appointment time' },
                                        },
                                        required: ['phone', 'new_date', 'new_time'],
                                    },
                                },
                            ],
                        },
                    ],

                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                },

                callbacks: {
                    onopen() {
                        console.log('[call] Gemini session OPEN — tenant:', tenantId, 'sessionId:', callSessionId);
                    },

                    onmessage(message) {
                        if (sessionClosed) return;

                        if (message.serverContent?.modelTurn?.parts) {
                            for (const part of message.serverContent.modelTurn.parts) {
                                if (part.inlineData) {
                                    ws.send(Buffer.from(part.inlineData.data, 'base64'));
                                }
                                if (part.text) {
                                    ws.send(JSON.stringify({ type: 'text', text: part.text }));
                                }
                            }
                        }

                        if (message.serverContent?.interrupted) {
                            console.log('[call] Gemini interrupted (barge-in)');
                            ws.send(JSON.stringify({ type: 'interrupted' }));
                        }

                        if (message.toolCall) {
                            (async () => {
                                const responses = [];
                                for (const call of message.toolCall.functionCalls) {
                                    console.log('[TOOL CALL RAW PAYLOAD]', JSON.stringify({ name: call.name, args: call.args }));
                                    let result;
                                    try {
                                        // Pass tenantId to handleVoiceTool
                                        result = await handleVoiceTool(call.name, call.args || {}, tenantId);
                                    } catch (err) {
                                        console.error('[call] tool error:', err.message);
                                        result = `Error: ${err.message}`;
                                    }
                                    console.log('[TOOL CALL RESULT]', call.name, '→', JSON.stringify(result));
                                    responses.push({ name: call.name, id: call.id, response: { result } });
                                }
                                session.sendToolResponse({ functionResponses: responses });
                            })();
                        }
                    },

                    onerror(err) {
                        console.error('[call] Gemini error:', err);
                    },

                    onclose() {
                        console.log('[call] Gemini session CLOSED');
                        sessionClosed = true;
                    },
                },
            });

            ws.on('message', (data) => {
                if (sessionClosed) return;

                if (typeof data === 'string' || (data instanceof Buffer && data[0] === 0x7b)) {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.type === 'greet') {
                            console.log('[call] Sending greeting trigger to Gemini');
                            session.sendClientContent({
                                turns: [{
                                    role: 'user',
                                    parts: [{ text: '__GREET__' }],
                                }],
                                turnComplete: true,
                            });
                        }
                    } catch (_) { }
                    return;
                }

                try {
                    session.sendRealtimeInput({
                        audio: {
                            data: Buffer.from(data).toString('base64'),
                            mimeType: 'audio/pcm;rate=16000',
                        },
                    });
                } catch (err) {
                    console.error('[call] sendRealtimeInput error:', err.message);
                }
            });

            ws.on('close', () => {
                console.log('[call] Browser disconnected — tenant:', tenantId, 'sessionId:', callSessionId);
                sessionClosed = true;
                connectionTenants.delete(ws);
                try { session.close(); } catch (_) { }
            });

            ws.on('error', (err) => {
                console.error('[call] WebSocket error:', err.message);
                sessionClosed = true;
                connectionTenants.delete(ws);
                try { session.close(); } catch (_) { }
            });

        } catch (err) {
            console.error('[call] Failed to open Gemini session:', err.message);
            ws.close(1011, 'Failed to connect to voice service');
        }
    });
}

module.exports = { setupCallServer };