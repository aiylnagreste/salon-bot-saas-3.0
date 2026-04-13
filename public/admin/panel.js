// ══════════════════════════════════════
//  STATE
// ══════════════════════════════════════
let allServices = [];
let allDeals = [];
let allBookings = [];
let allBranches = [];
let allStaff = [];
let allRoles = [];
let appCurrency = 'Rs.';
let allTimings = {};  // { workday: {open_time, close_time}, weekend: {open_time, close_time} }
let activeBookingBranch = '';  // '' = all branches
let crmTimeframe = 'week';    // day|week|month|year
let crmChartInstances = {};   // track Chart.js instances to destroy before redraw

const titles = {
  dashboard: 'Dashboard',
  bookings: 'Bookings',
  packages: 'Packages & Prices',
  deals: 'Deals & Offers',
  clients: 'Clients',
  staff: 'Staff',
  settings: 'Settings',
};

// ══════════════════════════════════════
//  NAV
// ══════════════════════════════════════
function showTab(tab, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  // Deactivate all top-level nav links (but not sub-items)
  document.querySelectorAll('nav > a, nav .nav-sub-item').forEach(a => a.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('page-title').textContent = titles[tab] || tab;

  if (el && !el.classList.contains('nav-sub-item')) {
    el.classList.add('active');
  } else if (!el) {
    document.querySelectorAll('nav > a').forEach(a => {
      if (a.getAttribute('onclick') && a.getAttribute('onclick').includes("'" + tab + "'")) {
        a.classList.add('active');
      }
    });
  }

  if (tab === 'bookings') {
    // Open the submenu
    const submenu = document.getElementById('bookings-submenu');
    const navBookings = document.getElementById('nav-bookings');
    if (submenu) { submenu.classList.add('open'); navBookings.classList.add('submenu-open', 'active'); }
    loadBookings();
    renderBranchCrm();
  }
  if (tab === 'packages') loadServices();
  if (tab === 'deals') loadDeals();
  if (tab === 'clients') loadClients();
  if (tab === 'staff') loadStaffDashboard();
  if (tab === 'settings') loadSettings();
}

// ── Bookings sidebar submenu ──────────────────────────────────────────────────

function toggleBookingsMenu(el) {
  const submenu = document.getElementById('bookings-submenu');
  const isOpen = submenu.classList.contains('open');
  if (isOpen && document.getElementById('tab-bookings').classList.contains('active')) {
    // Already on bookings — just toggle collapse
    submenu.classList.toggle('open');
    el.classList.toggle('submenu-open');
    return;
  }
  submenu.classList.add('open');
  el.classList.add('submenu-open');
  showTab('bookings', el);
}

function buildBranchSubmenu() {
  const submenu = document.getElementById('bookings-submenu');
  if (!submenu) return;

  // Remove "All Branches" - show only actual branches
  submenu.innerHTML = allBranches.map(b => `
        <a class="nav-sub-item ${activeBookingBranch === b.name ? 'active' : ''}" data-branch="${esc(b.name)}" onclick="selectBookingBranch('${b.name.replace(/'/g, "\\'")}', this)">
            <span class="nav-sub-ico">🏪</span> ${esc(b.name)}
        </a>
    `).join('');

  // If no branches, show a message
  if (allBranches.length === 0) {
    submenu.innerHTML = `<span class="nav-sub-item" style="color:rgba(255,255,255,0.3);">No branches added</span>`;
  }
}

function selectBookingBranch(branchName, el) {
  activeBookingBranch = branchName;

  // Update submenu active state
  document.querySelectorAll('#bookings-submenu .nav-sub-item').forEach(a => a.classList.remove('active'));
  if (el) el.classList.add('active');

  // Update header in content area
  const titleEl = document.getElementById('branch-tab-title');
  const subEl = document.getElementById('branch-tab-sub');
  if (titleEl) titleEl.textContent = branchName || 'All Branches';
  if (subEl) subEl.textContent = branchName ? `Showing bookings for ${branchName}` : 'Showing all branches';

  // Ensure the bookings tab is visible
  if (!document.getElementById('tab-bookings').classList.contains('active')) {
    showTab('bookings', null);
  } else {
    loadBookings();
    renderBranchCrm();  // This will now respect the branch filter
  }
}

// ── CRM timeframe selector ────────────────────────────────────────────────────

function setCrmTimeframe(tf, el) {
  crmTimeframe = tf;
  document.querySelectorAll('.ctab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderBranchCrm();
}

// Replace loadTodayBookingsPieChart function in panel.js:

async function loadTodayBookingsPieChart() {
  const canvas = document.getElementById('dashboard-bookings-pie-chart');
  if (!canvas) return;

  const emptyDiv = document.getElementById('dashboard-bookings-empty');

  try {
    const today = new Date().toISOString().slice(0, 10);
    const bookings = await api('/salon-admin/api/bookings?date=' + today);

    if (!bookings || bookings.length === 0) {
      if (canvas) canvas.style.display = 'none';
      if (emptyDiv) {
        emptyDiv.style.display = 'block';
        emptyDiv.textContent = 'No bookings today';
      }
      return;
    }

    // Show ALL bookings for today, not just confirmed
    // But separate by status in tooltip
    const branchCounts = {};
    const branchStatuses = {};

    bookings.forEach(booking => {
      const branch = booking.branch || 'Unknown';
      branchCounts[branch] = (branchCounts[branch] || 0) + 1;

      if (!branchStatuses[branch]) branchStatuses[branch] = {};
      branchStatuses[branch][booking.status] = (branchStatuses[branch][booking.status] || 0) + 1;
    });

    const labels = Object.keys(branchCounts);
    const data = Object.values(branchCounts);
    const totalBookings = data.reduce((a, b) => a + b, 0);

    const colors = [
      'rgba(102, 126, 234, 0.85)',
      'rgba(251, 147, 147, 0.85)',
      'rgba(182, 71, 86, 0.85)',
      'rgba(255, 159, 64, 0.85)',
      'rgba(75, 192, 192, 0.85)',
      'rgba(255, 205, 86, 0.85)',
    ];

    if (window.dashboardBookingsChart) {
      window.dashboardBookingsChart.destroy();
    }

    // In loadTodayBookingsPieChart function, update the tooltip options:

    window.dashboardBookingsChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: colors.slice(0, labels.length),
          borderColor: '#fff',
          borderWidth: 2,
          hoverOffset: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              font: { size: 10 },
              boxWidth: 10,
              padding: 8
            }
          },
          tooltip: {
            bodyFont: { size: 12 },
            titleFont: { size: 13, weight: 'bold' },
            padding: 10,
            caretSize: 8,
            cornerRadius: 6,
            callbacks: {
              label: (ctx) => {
                const branch = ctx.label;
                const count = ctx.raw;
                const percentage = Math.round((count / totalBookings) * 100);
                let statusText = '';
                if (branchStatuses[branch]) {
                  const statuses = [];
                  if (branchStatuses[branch].confirmed) statuses.push(`✅ Confirmed: ${branchStatuses[branch].confirmed}`);
                  if (branchStatuses[branch].completed) statuses.push(`✓ Completed: ${branchStatuses[branch].completed}`);
                  if (branchStatuses[branch].pending) statuses.push(`⏳ Pending: ${branchStatuses[branch].pending}`);
                  if (branchStatuses[branch].no_show) statuses.push(`❌ No-Show: ${branchStatuses[branch].no_show}`);
                  if (branchStatuses[branch].canceled) statuses.push(`✗ Canceled: ${branchStatuses[branch].canceled}`);
                  if (statuses.length) statusText = '\n' + statuses.join('\n');
                }
                return `${branch}: ${count} booking${count !== 1 ? 's' : ''} (${percentage}%)${statusText}`;
              }
            },
            callbacks: {
              label: (ctx) => {
                const branch = ctx.label;
                const count = ctx.raw;
                const percentage = Math.round((count / totalBookings) * 100);
                let statusText = '';
                if (branchStatuses[branch]) {
                  const statuses = [];
                  if (branchStatuses[branch].confirmed) statuses.push(`✅ Confirmed: ${branchStatuses[branch].confirmed}`);
                  if (branchStatuses[branch].completed) statuses.push(`✓ Completed: ${branchStatuses[branch].completed}`);
                  if (branchStatuses[branch].pending) statuses.push(`⏳ Pending: ${branchStatuses[branch].pending}`);
                  if (branchStatuses[branch].no_show) statuses.push(`❌ No-Show: ${branchStatuses[branch].no_show}`);
                  if (branchStatuses[branch].canceled) statuses.push(`✗ Canceled: ${branchStatuses[branch].canceled}`);
                  if (statuses.length) statusText = '\n' + statuses.join('\n');
                }
                return `${branch}: ${count} booking${count !== 1 ? 's' : ''} (${percentage}%)${statusText}`;
              }
            }
          }
        },
        cutout: '55%',
      }
    });

    console.log('Today\'s bookings by branch:', branchCounts);

  } catch (e) {
    console.error('Error loading bookings pie chart:', e);
    if (emptyDiv) emptyDiv.style.display = 'block';
  }
}

// In your panel.html, add a setting to update salon name
async function updateSalonName() {
  const newName = prompt('Enter new salon name:', currentSalonName);
  if (newName) {
    const response = await fetch('/salon-admin/api/salon-name', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salon_name: newName })
    });
    if (response.ok) {
      alert('Salon name updated! The widget will now show: ' + newName + ' Assistant');
    }
  }
}
// Load Revenue Pie Chart — uses the canonical /analytics endpoint so chart,
// text breakdown, and KPI totals always reflect the same DB query.

async function loadRevenuePieChart() {
  const canvas = document.getElementById('dashboard-revenue-pie-chart');
  if (!canvas) return;

  const emptyDiv = document.getElementById('dashboard-revenue-empty');
  const revenueContainer = document.getElementById('revenue-numbers-container');

  try {
    const data = await api('/salon-admin/api/analytics?status=completed');
    const currency = appCurrency || 'Rs.';
    const { revenueByService, totalRevenue } = data;

    if (!revenueByService || revenueByService.length === 0) {
      if (canvas) canvas.style.display = 'none';
      if (emptyDiv) { emptyDiv.style.display = 'block'; emptyDiv.textContent = 'No completed bookings yet'; }
      if (revenueContainer) revenueContainer.style.display = 'none';
      return;
    }

    if (canvas) canvas.style.display = '';
    if (emptyDiv) emptyDiv.style.display = 'none';
    if (revenueContainer) revenueContainer.style.display = 'block';

    const labels   = revenueByService.map(r => r.name);
    const amounts  = revenueByService.map(r => r.revenue);
    const percents = revenueByService.map(r => r.percent);

    const colors = [
      'rgba(102, 126, 234, 0.85)', 'rgba(251, 147, 147, 0.85)',
      'rgba(182, 71, 86, 0.85)',   'rgba(255, 159, 64, 0.85)',
      'rgba(75, 192, 192, 0.85)',  'rgba(255, 205, 86, 0.85)',
      'rgba(153, 102, 255, 0.85)', 'rgba(255, 99, 132, 0.85)',
    ];

    if (window.dashboardRevenueChart) window.dashboardRevenueChart.destroy();

    window.dashboardRevenueChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: amounts,
          backgroundColor: colors.slice(0, labels.length),
          borderColor: '#fff',
          borderWidth: 2,
          hoverOffset: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 10, padding: 8 } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.label}: ${currency} ${ctx.raw.toLocaleString()} (${percents[ctx.dataIndex]}%)`,
            },
          },
        },
        cutout: '55%',
      },
    });

    // ── Textual breakdown table (same data as chart) ──────────────────────────
    const revenueList = document.getElementById('revenue-list');
    const revenueTotalEl = document.getElementById('revenue-total');

    if (revenueList) {
      revenueList.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border,#eee);text-align:left;">
              <th style="padding:4px 8px;">Service</th>
              <th style="padding:4px 8px;text-align:right;">Revenue</th>
              <th style="padding:4px 8px;text-align:right;">%</th>
            </tr>
          </thead>
          <tbody>
            ${revenueByService.map((r, i) => `
              <tr style="border-bottom:1px solid var(--border,#f3f3f3);">
                <td style="padding:4px 8px;">
                  <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colors[i % colors.length]};margin-right:6px;"></span>
                  ${esc(r.name)}
                </td>
                <td style="padding:4px 8px;text-align:right;">${currency} ${r.revenue.toLocaleString()}</td>
                <td style="padding:4px 8px;text-align:right;">${r.percent}%</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }

    if (revenueTotalEl) {
      revenueTotalEl.innerHTML = `
        <span class="revenue-total-label">Total Revenue</span>
        <span class="revenue-total-amount">${currency} ${totalRevenue.toLocaleString()}</span>`;
    }

  } catch (e) {
    console.error('Error loading revenue pie chart:', e);
    if (emptyDiv) emptyDiv.style.display = 'block';
    if (revenueContainer) revenueContainer.style.display = 'none';
  }
}


// ══════════════════════════════════════
//  FETCH HELPERS
// ══════════════════════════════════════
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return r.json();
}

function toast(msg, type = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = ''), 2800);
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusBadge(s) {

  const map = {
    confirmed: 'badge-confirmed',
    canceled: 'badge-cancelled',
    no_show: 'badge-noshow',
    completed: 'badge-completed'
  };

  return `<span class="badge ${map[s] || ''}">${s || '—'}</span>`;
}

function setSelect(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  [...el.options].forEach(o => (o.selected = o.value === String(val)));
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// ══════════════════════════════════════
//  STATS + DASHBOARD
// ══════════════════════════════════════
async function loadStats() {
  try {
    const d = await api('/salon-admin/api/stats');
    document.getElementById('s-total').textContent = d.total_bookings ?? 0;
    document.getElementById('s-today').textContent = d.today_bookings ?? 0;
    document.getElementById('s-services').textContent = d.active_services ?? 0;
    document.getElementById('s-clients').textContent = d.total_clients ?? 0;
  } catch (e) {
    ['s-total', 's-today', 's-services', 's-clients'].forEach(
      id => (document.getElementById(id).textContent = '0')
    );
  }
}

function initDashboardHeader() {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const el = document.getElementById('dash-greeting');
  const dateEl = document.getElementById('dash-date');
  if (el) el.textContent = greeting;
  if (dateEl) dateEl.textContent = dateStr;
}



// Replace the loadTodayBookings function in panel.js:

async function loadTodayBookings() {
  const tbody = document.getElementById('today-tbody');
  if (!tbody) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const rows = await api('/salon-admin/api/bookings?date=' + today);
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-state-icon">📅</div><p>No appointments scheduled for today.</p></div></tr>`;
      return;
    }

    // Group bookings by branch
    const groupedByBranch = {};
    rows.forEach(r => {
      const branch = r.branch || 'Unknown';
      if (!groupedByBranch[branch]) groupedByBranch[branch] = [];
      groupedByBranch[branch].push(r);
    });

    // Build HTML with branch separators
    let html = '';
    const branchOrder = allBranches.map(b => b.name).filter(b => groupedByBranch[b]);
    const otherBranches = Object.keys(groupedByBranch).filter(b => !branchOrder.includes(b));
    const orderedBranches = [...branchOrder, ...otherBranches];

    for (const branch of orderedBranches) {
      const branchRows = groupedByBranch[branch];
      html += `<tr class="branch-separator"><td colspan="6"><div class="branch-dashboard-header">🏪 ${esc(branch)} <span class="branch-count">${branchRows.length} booking${branchRows.length !== 1 ? 's' : ''}</span></div><tr>`;

      branchRows.forEach(r => {
        // Determine row class based on status
        let rowClass = '';
        if (r.status === 'no_show') rowClass = 'status-no_show';
        else if (r.status === 'completed') rowClass = 'status-completed';
        else if (r.status === 'canceled') rowClass = 'status-canceled';
        else if (r.status === 'pending') rowClass = 'status-pending';

        // Check if booking is completed - disable edit
        const isCompleted = r.status === 'completed';
        const isCanceled = r.status === 'canceled';

        let actionButtons = '';

        if (isCompleted) {
          actionButtons = `
            <span class="btn btn-sm disabled" style="opacity:0.5; background:#e5e7eb; cursor:not-allowed;">✓ Completed</span>
            <button class="btn btn-sm btn-danger" onclick="deleteBooking(${r.id})">Delete</button>
          `;
        } else if (isCanceled) {
          actionButtons = `
            <span class="btn btn-sm disabled" style="opacity:0.5; background:#e5e7eb; cursor:not-allowed;">✗ Canceled</span>
            <button class="btn btn-sm btn-danger" onclick="deleteBooking(${r.id})">Delete</button>
          `;
        } else {
          actionButtons = `
            <button class="btn btn-sm btn-outline" onclick="editBooking(${r.id})">✏️ Edit</button>
            ${r.status === 'confirmed' ? `<button class="btn btn-sm btn-warning" onclick="markAsNoShow(${r.id})">🚫 No-Show</button>` : ''}
            <button class="btn btn-sm btn-danger" onclick="deleteBooking(${r.id})">Delete</button>
          `;
        }

        html += `
          <tr class="${rowClass}">
            <td><strong>${esc(r.customer_name)}</strong></td>
            <td>${esc(r.service || '—')}</td>
            <td>${esc(r.branch || '—')}</td>
            <td><strong>${esc(r.time || '—')}</strong></td>
            <td>${statusBadge(r.status)}</td>
            <td>${actionButtons}</td>
          </tr>
        `;
      });
    }

    tbody.innerHTML = html;
  } catch (e) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Could not load today's bookings.`;
  }
}

async function loadUpcoming() {
  const el = document.getElementById('upcoming-list');
  if (!el) return;
  try {
    // Fetch next 10 bookings after today
    const today = new Date().toISOString().slice(0, 10);
    const rows = await api('/salon-admin/api/bookings?limit=10');
    const upcoming = rows.filter(r => r.date > today).slice(0, 8);
    if (!upcoming.length) {
      el.innerHTML = `<div class="empty-state" style="padding:28px"><div class="empty-state-icon">🗓</div><p>No upcoming bookings.</p></div>`;
      return;
    }
    el.innerHTML = upcoming.map(r => {
      const initials = (r.customer_name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      return `
        <div class="upcoming-item">
          <div class="upcoming-avatar">${initials}</div>
          <div class="upcoming-info">
            <div class="upcoming-name">${esc(r.customer_name)}</div>
            <div class="upcoming-service">${esc(r.service || '—')} · ${esc(r.date || '')}</div>
          </div>
          <div class="upcoming-time">${esc(r.time || '—')}</div>
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div style="padding:20px;color:var(--sub);font-size:0.8rem;text-align:center">Could not load.</div>`;
  }
}

// ══════════════════════════════════════
//  BOOKINGS
// ══════════════════════════════════════
async function loadBookings() {
  const container = document.getElementById('bookings-container');
  container.innerHTML = '<div class="loading-row" style="text-align:center;padding:30px"><span class="spinner"></span></div>';

  // Build API URL with filters
  let url = '/salon-admin/api/bookings';
  const date = document.getElementById('f-date')?.value || '';
  const status = document.getElementById('f-status')?.value || '';
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (status) params.set('status', status);
  if ([...params].length) url += '?' + params;

  try {
    const rows = await api(url);
    allBookings = rows;

    // Get today's date for comparison
    const today = new Date().toISOString().slice(0, 10);

    // ──────────────────────────────────────────────────────────
    // CASE 1: SPECIFIC BRANCH SELECTED
    // ──────────────────────────────────────────────────────────
    if (activeBookingBranch) {
      // Filter rows for selected branch only
      const branchRows = rows.filter(r => r.branch === activeBookingBranch);

      // Separate by status and date for single branch view
      const pending = branchRows.filter(r => r.status === 'pending');
      const todayConfirmed = branchRows.filter(r => r.date === today && r.status === 'confirmed');
      const todayNoShows = branchRows.filter(r => r.date === today && r.status === 'no_show');
      const todayCompleted = branchRows.filter(r => r.date === today && r.status === 'completed');
      const upcoming = branchRows.filter(r => r.date > today && r.status === 'confirmed');
      const past = branchRows.filter(r => (r.date < today || ['completed', 'no_show', 'canceled', 'rescheduled'].includes(r.status)) && r.date !== today);

      let html = '';

      // PENDING SECTION
      if (pending.length > 0) {
        html += `
                    <div class="booking-section pending-section">
                        <div class="section-header">
                            <h3>⏳ Pending Confirmation <span class="badge warning">${pending.length}</span></h3>
                        </div>
                        ${renderBookingsTable(pending, true)}
                    </div>
                `;
      }

      // TODAY SECTION
      if (todayConfirmed.length > 0 || todayNoShows.length > 0 || todayCompleted.length > 0) {
        html += `
                    <div class="booking-section today-section">
                        <div class="section-header">
                            <h3>📅 Today's Schedule</h3>
                        </div>
                        <div class="today-sub-sections">
                `;

        if (todayConfirmed.length > 0) {
          html += `
                        <div class="sub-section">
                            <div class="sub-section-title upcoming">🟢 Upcoming (${todayConfirmed.length})</div>
                            ${renderBookingsTable(todayConfirmed, true)}
                        </div>
                    `;
        }

        if (todayCompleted.length > 0) {
          html += `
                        <div class="sub-section">
                            <div class="sub-section-title completed">✅ Completed (${todayCompleted.length})</div>
                            ${renderBookingsTable(todayCompleted, true)}
                        </div>
                    `;
        }

        if (todayNoShows.length > 0) {
          html += `
                        <div class="sub-section">
                            <div class="sub-section-title no-show">❌ No-Show (${todayNoShows.length})</div>
                            ${renderBookingsTable(todayNoShows, true)}
                        </div>
                    `;
        }

        html += `</div></div>`;
      }

      // UPCOMING SECTION
      if (upcoming.length > 0) {
        html += `
                    <div class="booking-section upcoming-section">
                        <div class="section-header">
                            <h3>📆 Upcoming (Next 7+ Days) <span class="badge">${upcoming.length}</span></h3>
                        </div>
                        ${renderBookingsTable(upcoming, true)}
                    </div>
                `;
      }

      // PAST SECTION (collapsible)
      if (past.length > 0) {
        html += `
                    <details class="booking-section past-section">
                        <summary>
                            <h3>📜 Past Bookings <span class="badge">${past.length}</span></h3>
                        </summary>
                        ${renderBookingsTable(past, true)}
                    </details>
                `;
      }

      if (branchRows.length === 0) {
        html = `<div class="card-box"><div class="empty-state"><div class="empty-state-icon">🏪</div><p>No bookings found for ${activeBookingBranch}</p></div></div>`;
      }

      container.innerHTML = html;
      return;
    }

    // ──────────────────────────────────────────────────────────
    // CASE 2: ALL BRANCHES - Group by branch with separate sections
    // ──────────────────────────────────────────────────────────
    if (!rows.length) {
      container.innerHTML = '<div class="card-box"><table><tbody><tr class="empty-row"><td colspan="9">No appointments found.</td></tr></tbody></table></div>';
      return;
    }

    // Group by branch
    const grouped = {};
    rows.forEach(r => {
      const key = r.branch || '(No Branch)';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(r);
    });

    // Render branches in the order they appear in allBranches
    const orderedKeys = [
      ...allBranches.map(b => b.name).filter(n => grouped[n]),
      ...Object.keys(grouped).filter(k => !allBranches.find(b => b.name === k)),
    ];

    let html = '';

    for (const branchName of orderedKeys) {
      const branchRows = grouped[branchName];
      const today = new Date().toISOString().slice(0, 10);

      const pending = branchRows.filter(r => r.status === 'pending');
      const todayConfirmed = branchRows.filter(r => r.date === today && r.status === 'confirmed');
      const todayNoShows = branchRows.filter(r => r.date === today && r.status === 'no_show');
      const todayCompleted = branchRows.filter(r => r.date === today && r.status === 'completed');
      const upcoming = branchRows.filter(r => r.date > today && r.status === 'confirmed');
      const past = branchRows.filter(r => (r.date < today || ['completed', 'no_show', 'canceled', 'rescheduled'].includes(r.status)) && r.date !== today);

      html += `
                <div class="branch-bookings-section">
                    <div class="branch-bookings-header">
                        <span class="branch-bookings-title">🏪 ${esc(branchName)}</span>
                        <span class="branch-bookings-count">${branchRows.length} booking${branchRows.length !== 1 ? 's' : ''}</span>
                    </div>
            `;

      // PENDING SECTION per branch
      if (pending.length > 0) {
        html += `
                    <div class="booking-section pending-section">
                        <div class="section-header">
                            <h3>⏳ Pending <span class="badge warning">${pending.length}</span></h3>
                        </div>
                        ${renderBookingsTable(pending, true)}
                    </div>
                `;
      }

      // TODAY SECTION per branch
      if (todayConfirmed.length > 0 || todayNoShows.length > 0 || todayCompleted.length > 0) {
        html += `
                    <div class="booking-section today-section">
                        <div class="section-header">
                            <h3>📅 Today's Schedule</h3>
                        </div>
                        <div class="today-sub-sections">
                `;

        if (todayConfirmed.length > 0) {
          html += `
                        <div class="sub-section">
                            <div class="sub-section-title upcoming">🟢 Upcoming (${todayConfirmed.length})</div>
                            ${renderBookingsTable(todayConfirmed, true)}
                        </div>
                    `;
        }

        if (todayCompleted.length > 0) {
          html += `
                        <div class="sub-section">
                            <div class="sub-section-title completed">✅ Completed (${todayCompleted.length})</div>
                            ${renderBookingsTable(todayCompleted, true)}
                        </div>
                    `;
        }

        if (todayNoShows.length > 0) {
          html += `
                        <div class="sub-section">
                            <div class="sub-section-title no-show">❌ No-Show (${todayNoShows.length})</div>
                            ${renderBookingsTable(todayNoShows, true)}
                        </div>
                    `;
        }

        html += `</div></div>`;
      }

      // UPCOMING SECTION per branch
      if (upcoming.length > 0) {
        html += `
                    <div class="booking-section upcoming-section">
                        <div class="section-header">
                            <h3>📆 Upcoming <span class="badge">${upcoming.length}</span></h3>
                        </div>
                        ${renderBookingsTable(upcoming, true)}
                    </div>
                `;
      }

      // PAST SECTION per branch (collapsible)
      if (past.length > 0) {
        html += `
                    <details class="booking-section past-section">
                        <summary>
                            <h3>📜 Past Bookings <span class="badge">${past.length}</span></h3>
                        </summary>
                        ${renderBookingsTable(past, true)}
                    </details>
                `;
      }

      html += `</div>`;
    }

    container.innerHTML = html;

  } catch (e) {
    console.error('Error loading bookings:', e);
    container.innerHTML = '<div class="card-box"><table><tbody><tr class="empty-row"><td colspan="9">Could not load bookings.</td></tr></tbody></td></div>';
  }
}



function renderBookingsTable(rows, hideBranchCol = false, compactMode = false) {
  if (!rows.length) {
    return `<div class="empty-table">
                    <div class="empty-icon">📋</div>
                    <p>No appointments found</p>
                </div>`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  const tableRows = rows.map(r => {
    // Determine status
    const isToday = r.date === today;
    const isPast = r.date < today;

    let isUpcomingToday = false;
    if (isToday && r.status === 'confirmed') {
      const [hours, minutes] = r.time.split(':').map(Number);
      const bookingTime = hours * 60 + minutes;
      const currentTime = currentHour * 60 + currentMinute;
      isUpcomingToday = bookingTime > currentTime;
    }

    let statusDisplay = '';
    let statusClass = '';

    switch (r.status) {
      case 'no_show':
        statusDisplay = 'No-Show';
        statusClass = 'status-no-show';
        break;
      case 'canceled':
        statusDisplay = 'Canceled';
        statusClass = 'status-canceled';
        break;
      case 'completed':
        statusDisplay = 'Completed';
        statusClass = 'status-completed';
        break;
      case 'pending':
        statusDisplay = 'Pending';
        statusClass = 'status-pending';
        break;
      case 'confirmed':
        if (isPast) {
          statusDisplay = 'Missed';
          statusClass = 'status-missed';
        } else if (isToday && isUpcomingToday) {
          statusDisplay = 'Today';
          statusClass = 'status-today';
        } else {
          statusDisplay = 'Confirmed';
          statusClass = 'status-confirmed';
        }
        break;
      default:
        statusDisplay = 'Booked';
        statusClass = 'status-confirmed';
    }

    // Format date
    const dateObj = new Date(r.date);
    const formattedDate = dateObj.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });

    const timeStr = r.endTime ? `${r.time} – ${r.endTime}` : r.time;

    // Check if booking is completed - disable edit if true
    const isCompleted = r.status === 'completed';
    const isCanceled = r.status === 'canceled';

    // Show different action buttons based on status
    let actionButtons = '';

    if (isCompleted) {
      // Completed bookings - no edit, only view (or delete if needed)
      actionButtons = `
        <div class="action-buttons">
          <span class="action-btn disabled" title="Completed - Cannot edit" style="opacity:0.5; cursor:not-allowed;">✓</span>
          <button class="action-btn delete" onclick="deleteBooking(${r.id})" title="Delete">🗑️</button>
        </div>
      `;
    } else if (isCanceled) {
      // Canceled bookings - can delete
      actionButtons = `
        <div class="action-buttons">
          <span class="action-btn disabled" title="Canceled - Cannot edit" style="opacity:0.5; cursor:not-allowed;">✗</span>
          <button class="action-btn delete" onclick="deleteBooking(${r.id})" title="Delete">🗑️</button>
        </div>
      `;
    } else {
      // Active bookings - full actions
      actionButtons = `
        <div class="action-buttons">
          <button class="action-btn edit" onclick="editBooking(${r.id})" title="Edit">✏️</button>
          ${r.status === 'confirmed' ?
          `<button class="action-btn complete" onclick="markAsCompleted(${r.id})" title="Mark Completed" style="background:var(--success,#22c55e);color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;">✓ Done</button>` : ''}
          ${r.status === 'confirmed' && r.date <= today ?
          `<button class="action-btn noshow" onclick="markAsNoShow(${r.id})" title="No-Show">🚫</button>` : ''}
          <button class="action-btn delete" onclick="deleteBooking(${r.id})" title="Archive">🗑️</button>
        </div>
      `;
    }

    return `
            <tr class="table-row ${statusClass}" data-status="${r.status}">
                <td class="col-time">
                    <span class="time-main">${esc(r.time || '—')}</span>
                    ${r.endTime ? `<span class="time-end">→ ${esc(r.endTime)}</span>` : ''}
                </td>
                <td class="col-client">
                    <div class="client-cell">
                        <span class="client-name">${esc(r.customer_name)}</span>
                        <span class="client-phone">${esc(r.phone || '—')}</span>
                    </div>
                </td>
                <td class="col-service">
                    <div class="service-cell">
                        <span class="service-name" title="${esc(r.service || '—')}">
                            ${truncateText(esc(r.service || '—'), 40)}
                        </span>
                        ${!hideBranchCol ? `<span class="service-branch">${esc(r.branch || '—')}</span>` : ''}
                    </div>
                </td>
                <td class="col-date">${formattedDate}</td>
                <td class="col-status">
                    <span class="status-badge ${statusClass}">${statusDisplay}</span>
                </td>
                <td class="col-actions">
                    ${actionButtons}
                </td>
            </tr>
        `;
  }).join('');

  return `
        <div class="table-wrapper-pro">
            <table class="booking-table-pro">
                <thead>
                    <tr>
                        <th class="col-time">Time</th>
                        <th class="col-client">Client</th>
                        <th class="col-service">Service</th>
                        <th class="col-date">Date</th>
                        <th class="col-status">Status</th>
                        <th class="col-actions">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
        </div>
    `;
}

// Helper functions
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function truncateText(text, maxLen) {
  if (!text) return '—';
  return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
}

// Helper functions
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function truncateText(text, maxLen) {
  if (!text) return '—';
  return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
}

// Helper functions
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function truncateText(text, maxLen) {
  if (!text) return '—';
  return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
}

// Helper functions
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function truncateText(text, maxLen) {
  if (!text) return '—';
  return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
}
async function markAsCompleted(id) {
  if (!confirm('Mark this booking as completed?')) return;
  try {
    const r = await api(`/salon-admin/api/bookings/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' })
    });
    if (r.ok === false) { toast(r.error || 'Error', 'err'); return; }
    toast('Booking marked as completed', 'ok');
    loadBookings();
    loadTodayBookings();
    loadStats();
    renderBranchCrm();
  } catch (e) {
    toast('Error marking as completed', 'err');
  }
}

async function markAsNoShow(id) {
  if (!confirm('Mark this booking as no-show?')) return;

  try {
    const response = await api(`/salon-admin/api/bookings/${id}/no-show`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'no_show' })
    });

    if (response.ok === false) {
      toast(response.error || 'Error marking as no-show', 'err');
      return;
    }

    toast('Booking marked as no-show', 'ok');
    loadBookings();
    loadTodayBookings();
    loadStats();
    renderBranchCrm();

  } catch (e) {
    toast('Error marking as no-show', 'err');
  }
}
function getStatusClass(status) {
  const map = {
    pending: 'pending',
    confirmed: 'confirmed',
    completed: 'completed',
    no_show: 'no_show',
    canceled: 'canceled',
    rescheduled: 'rescheduled'
  };
  return map[status] || 'confirmed';
}

// Legacy wrapper — kept for any internal callers that pass a tbody element
function renderBookings(rows, tbody, recent = false) {
  if (!tbody) return;
  const cols = 9;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">No appointments found.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const timeStr = r.endTime ? `${esc(r.time)} – ${esc(r.endTime)}` : esc(r.time || '—');
    return `<tr>
      <td><span style="color:var(--sub)">#${r.id}</span></td>
      <td><strong>${esc(r.customer_name)}</strong></td>
      <td>${esc(r.phone || '—')}</td>
      <td>${esc(r.service || '—')}</td>
      <td>${esc(r.branch || '—')}</td>
      <td>${esc(r.date || '—')}</td>
      <td>${timeStr}</td>
      <td>${statusBadge(r.status)}</td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="editBooking(${r.id})">✏️ Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteBooking(${r.id})">Cancel</button>
      </td>
    </tr>`;
  }).join('');
}

async function deleteBooking(id) {
  if (!confirm('Archive this booking? It will be hidden but history is preserved.')) return;
  await api(`/salon-admin/api/bookings/${id}`, { method: 'DELETE' });
  toast('Booking archived', 'ok');
  loadBookings();
  loadTodayBookings();
  loadStaffDashboard();
  loadStats();
}

// Update the editBooking function to check if booking is completed:

function editBooking(id) {
  const b = allBookings.find(x => x.id === id);
  if (!b) return;

  // Prevent editing completed or canceled bookings
  if (b.status === 'completed') {
    toast('Completed appointments cannot be edited', 'err');
    return;
  }

  if (b.status === 'canceled') {
    toast('Canceled appointments cannot be edited', 'err');
    return;
  }

  document.getElementById('bm-id').value = b.id;
  document.getElementById('bm-name').value = b.customer_name;
  document.getElementById('bm-phone').value = b.phone || '';
  document.getElementById('bm-date').value = b.date || '';
  document.getElementById('bm-time').value = b.time || '';
  document.getElementById('bm-notes').value = b.notes || '';
  setSelect('bm-branch', b.branch);
  setSelect('bm-status', b.status || 'confirmed');
  populateServiceSelect(b.service);
  populateStaffSelect(b.staff_id, b.branch);
  document.getElementById('bm-date').min = new Date().toISOString().slice(0, 10);
  document.getElementById('bm-time-error').textContent = '';
  updateDurationDisplay();
  updateEndTimeDisplay();
  setPhonePlaceholder(b.branch);
  document.getElementById('bm-title').textContent = 'Edit Appointment';
  document.getElementById('booking-modal').classList.add('open');
}

// Update openBookingModal function:
function openBookingModal() {
  ['bm-id', 'bm-name', 'bm-phone', 'bm-date', 'bm-time', 'bm-notes'].forEach(
    id => (document.getElementById(id).value = '')
  );
  populateServiceSelect();
  populateStaffSelect();
  document.getElementById('bm-date').min = new Date().toISOString().slice(0, 10);
  document.getElementById('bm-time-error').textContent = '';
  document.getElementById('bm-service-duration').textContent = '';
  document.getElementById('bm-duration-display').textContent = '—';
  document.getElementById('bm-end-time').textContent = '—';
  document.getElementById('bm-staff-availability').textContent = '';
  setPhonePlaceholder();
  document.getElementById('bm-title').textContent = 'New Appointment';
  setSelect('bm-status', 'confirmed'); // Set default status to confirmed
  document.getElementById('booking-modal').classList.add('open');
}

// Replace the saveBooking function in panel.js
async function saveBooking() {
  const id = document.getElementById('bm-id').value;
  const staffSel = document.getElementById('bm-staff');
  let staffId = staffSel.value ? parseInt(staffSel.value, 10) : null;
  let staffName = staffId
    ? (staffSel.selectedOptions[0]?.text?.split(' (')[0] || null)
    : null;

  // Get the status from the dropdown (added in modal)
  const status = document.getElementById('bm-status').value;

  const body = {
    customer_name: document.getElementById('bm-name').value.trim(),
    phone: document.getElementById('bm-phone').value.trim(),
    service: document.getElementById('bm-service').value,
    branch: document.getElementById('bm-branch').value,
    date: document.getElementById('bm-date').value,
    time: document.getElementById('bm-time').value,
    notes: document.getElementById('bm-notes').value.trim(),
    status: status,  // Use the selected status
    staff_id: staffId,
    staff_name: staffName,
  };

  // Validate all required fields
  const missing = [];
  if (!body.customer_name) missing.push('Client Name');
  if (!body.phone) missing.push('Phone');
  if (!body.service) missing.push('Service');
  if (!body.branch) missing.push('Branch');
  if (!body.date) missing.push('Date');
  if (!body.time) missing.push('Time');
  if (missing.length) { toast('Required: ' + missing.join(', '), 'err'); return; }

  // Client-side past-date check (only for new bookings, not for completed/canceled)
  const todayStr = new Date().toISOString().slice(0, 10);
  if (body.date < todayStr && status === 'confirmed') {
    toast('Date cannot be in the past for confirmed bookings', 'err');
    return;
  }

  // Only validate time for confirmed bookings
  if (status === 'confirmed') {
    if (!validateTimeInput()) {
      toast('Selected time is outside salon hours', 'err');
      return;
    }
  }

  // Check staff availability only for confirmed bookings
  if (status === 'confirmed') {
    const availabilityCheck = checkBookingStaffAvailability(body.date, body.time, body.branch, staffId);
    if (availabilityCheck.error) {
      toast(availabilityCheck.error, 'err');
      return;
    }

    // If no staff selected, randomly assign from available staff
    if (!staffId && availabilityCheck.freeStaff && availabilityCheck.freeStaff.length > 0) {
      const randomStaff = availabilityCheck.freeStaff[Math.floor(Math.random() * availabilityCheck.freeStaff.length)];
      staffId = randomStaff.id;
      staffName = randomStaff.name;
      body.staff_id = staffId;
      body.staff_name = staffName;
    }
  }

  const url = id ? `/salon-admin/api/bookings/${id}` : '/salon-admin/api/bookings';
  const method = id ? 'PUT' : 'POST';
  const r = await api(url, { method, body: JSON.stringify(body) });
  if (!r || r.ok === false) { toast(r?.error || 'Error saving booking', 'err'); return; }
  toast(id ? 'Appointment updated' : 'Appointment created', 'ok');
  closeModal('booking-modal');
  loadBookings();
  loadTodayBookings();
  loadUpcoming();
  loadStats();
  loadTodayBookingsPieChart();
  loadRevenuePieChart();
  renderBranchCrm();
}

function checkBookingStaffAvailability(date, time, branch, selectedStaffId = null) {
  const serviceEl = document.getElementById('bm-service').selectedOptions[0];
  const duration = serviceEl ? (serviceEl.dataset.duration || 60) : 60;
  const durationNum = parseInt(duration, 10);

  const [tH, tM] = time.split(':').map(Number);
  const timeStart = tH * 60 + tM;
  const timeEnd = timeStart + durationNum;

  // For availability, we only want staff who can provide services
  // So filter out admin, manager, receptionist roles
  let serviceProviderRoles = [];
  if (allRoles && allRoles.length > 0) {
    const excludeRoles = ['admin', 'manager', 'receptionist'];
    serviceProviderRoles = allRoles
      .map(r => r.name.toLowerCase())
      .filter(r => !excludeRoles.includes(r));
  } else {
    // If roles not loaded yet, show all active staff
    console.warn('Roles not loaded, showing all active staff for availability');
  }

  // Get all active staff for this branch
  let availableStaff = allStaff.filter(s => s.status === 'active');

  // If we have role filtering, apply it
  if (serviceProviderRoles.length > 0) {
    availableStaff = availableStaff.filter(s =>
      serviceProviderRoles.includes((s.role || '').toLowerCase())
    );
  }

  // Filter by branch
  availableStaff = availableStaff.filter(s =>
    s.branch_name === branch || s.branch_id === null
  );

  // If no staff found with exact branch match, try getting staff with no branch assignment
  if (availableStaff.length === 0) {
    availableStaff = allStaff.filter(s => s.status === 'active');
    if (serviceProviderRoles.length > 0) {
      availableStaff = availableStaff.filter(s =>
        serviceProviderRoles.includes((s.role || '').toLowerCase())
      );
    }
    availableStaff = availableStaff.filter(s => s.branch_id === null);
  }

  console.log('Available staff for branch', branch, ':', availableStaff.map(s => `${s.name} (${s.role})`));

  // Get all confirmed bookings on this date
  const dateBookings = allBookings.filter(b =>
    b.date === date &&
    b.status === 'confirmed' &&
    b.branch === branch
  );

  // Check which staff are free at this time
  const freeStaff = availableStaff.filter(staff => {
    const staffBookings = dateBookings.filter(b => b.staff_id === staff.id);

    if (staffBookings.length === 0) return true;

    return !staffBookings.some(booking => {
      const [bH, bM] = (booking.time || '').split(':').map(Number);
      let bookingEnd;
      if (booking.endTime) {
        const [eH, eM] = booking.endTime.split(':').map(Number);
        bookingEnd = eH * 60 + eM;
      } else {
        const bookingService = allServices.find(s => s.name === booking.service);
        const bookingDuration = bookingService ? (bookingService.durationMinutes || 60) : 60;
        bookingEnd = (bH * 60 + bM) + bookingDuration;
      }
      const bookingStart = bH * 60 + bM;

      return (timeStart < bookingEnd && timeEnd > bookingStart);
    });
  });

  console.log('Free staff at time', time, ':', freeStaff.map(s => `${s.name} (${s.role})`));

  // Rest of the function remains the same...
  if (selectedStaffId) {
    selectedStaffId = parseInt(selectedStaffId, 10);
    const selectedStaff = availableStaff.find(s => s.id === selectedStaffId);

    if (!selectedStaff) {
      return { error: 'Selected staff not found or not available for this branch' };
    }

    const isFree = freeStaff.some(s => s.id === selectedStaffId);

    if (!isFree) {
      const nextFreeTime = getNextAvailableTimeForStaff(selectedStaff, date, durationNum, branch);
      const timeMsg = nextFreeTime ? ` Next available time: ${nextFreeTime}` : '';
      return { error: `${selectedStaff.name} is not available at ${time}.${timeMsg}` };
    }

    return { error: null, freeStaff: [selectedStaff] };
  }

  if (freeStaff.length === 0) {
    const nextFreeTime = getNextAvailableAnyStaff(availableStaff, date, timeStart, durationNum, branch);
    const timeMsg = nextFreeTime ? ` Next available time: ${nextFreeTime}` : ' No staff available for the rest of the day.';
    return { error: `No staff available at ${time}.${timeMsg}`, freeStaff: [] };
  }

  return { error: null, freeStaff: freeStaff };
}

function getNextAvailableTimeForStaff(staff, date, durationMinutes, branch) {
  const dow = new Date(date).getDay();
  const dayType = (dow === 0 || dow === 6) ? 'weekend' : 'workday';
  const timing = allTimings[dayType];
  
  if (!timing) return null;
  
  const [openH, openM] = timing.open_time.split(':').map(Number);
  const [closeH, closeM] = timing.close_time.split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  
  // Get all bookings for this staff on this date
  const staffBookings = allBookings.filter(b => 
    b.date === date && 
    b.status === 'confirmed' && 
    b.staff_id === staff.id
  ).sort((a, b) => a.time.localeCompare(b.time));
  
  // Check slots in 30-minute increments
  let checkTime = openMinutes;
  
  while (checkTime + durationMinutes <= closeMinutes) {
    const checkTimeStr = `${String(Math.floor(checkTime / 60)).padStart(2, '0')}:${String(checkTime % 60).padStart(2, '0')}`;
    const slotEnd = checkTime + durationMinutes;
    
    // Check if this slot overlaps with any existing booking
    let isFree = true;
    for (const booking of staffBookings) {
      const [bH, bM] = booking.time.split(':').map(Number);
      let bookingEnd;
      if (booking.endTime) {
        const [eH, eM] = booking.endTime.split(':').map(Number);
        bookingEnd = eH * 60 + eM;
      } else {
        const bookingService = allServices.find(s => s.name === booking.service);
        const bookingDuration = bookingService ? (bookingService.durationMinutes || 60) : 60;
        bookingEnd = (bH * 60 + bM) + bookingDuration;
      }
      const bookingStart = bH * 60 + bM;
      
      if (checkTime < bookingEnd && slotEnd > bookingStart) {
        isFree = false;
        // Move checkTime to after this booking ends
        checkTime = bookingEnd;
        break;
      }
    }
    
    if (isFree) {
      return checkTimeStr;
    }
  }
  
  return null;
}

function getNextAvailableAnyStaff(availableStaff, date, startTimeMinutes, durationMinutes, branch) {
  const dow = new Date(date).getDay();
  const dayType = (dow === 0 || dow === 6) ? 'weekend' : 'workday';
  const timing = allTimings[dayType];

  if (!timing || availableStaff.length === 0) return null;

  const [closeH, closeM] = timing.close_time.split(':').map(Number);
  const closeMinutes = closeH * 60 + closeM;

  // Get all bookings for this date
  const dateBookings = allBookings.filter(b =>
    b.date === date &&
    b.status === 'confirmed' &&
    b.branch === branch
  );

  // Check in 30-minute increments from the requested time
  let checkTime = startTimeMinutes + 30; // Start checking 30 minutes after requested time

  while (checkTime + durationMinutes <= closeMinutes) {
    const checkTimeStr = `${String(Math.floor(checkTime / 60)).padStart(2, '0')}:${String(checkTime % 60).padStart(2, '0')}`;
    const slotEnd = checkTime + durationMinutes;

    // Check if any staff is free at this slot
    const anyStaffFree = availableStaff.some(staff => {
      const staffBookings = dateBookings.filter(b => b.staff_id === staff.id);

      if (staffBookings.length === 0) return true;

      return !staffBookings.some(booking => {
        const [bH, bM] = booking.time.split(':').map(Number);
        let bookingEnd;
        if (booking.endTime) {
          const [eH, eM] = booking.endTime.split(':').map(Number);
          bookingEnd = eH * 60 + eM;
        } else {
          const bookingService = allServices.find(s => s.name === booking.service);
          const bookingDuration = bookingService ? (bookingService.durationMinutes || 60) : 60;
          bookingEnd = (bH * 60 + bM) + bookingDuration;
        }
        const bookingStart = bH * 60 + bM;

        return checkTime < bookingEnd && slotEnd > bookingStart;
      });
    });

    if (anyStaffFree) {
      return checkTimeStr;
    }

    checkTime += 30;
  }

  return null;
}

function populateStaffSelect(selectedId = null, branchName = null) {
  const sel = document.getElementById('bm-staff');
  if (!sel) return;
  // Exclude admin, receptionist, and manager roles - only service providers
  const serviceRoles = ['stylist', 'beautician', 'therapist', 'makeup artist', 'hair stylist', 'nail technician', 'spa therapist'];
  let staffList = allStaff.filter(s =>
    s.status === 'active' &&
    serviceRoles.includes((s.role || '').toLowerCase())
  );
  if (branchName) {
    const branch = allBranches.find(b => b.name === branchName);
    if (branch) {
      // Show staff assigned to this branch, or staff with no branch assigned
      staffList = staffList.filter(s => s.branch_id === branch.id || s.branch_id === null);
    }
  }
  sel.innerHTML =
    `<option value="">— No preference —</option>` +
    staffList
      .map(s => `<option value="${s.id}" ${s.id == selectedId ? 'selected' : ''}>${esc(s.name)} (${esc(s.role)})</option>`)
      .join('');
}

function populateServiceSelect(selected = '') {
  const sel = document.getElementById('bm-service');
  sel.innerHTML =
    `<option value="">— Choose service —</option>` +
    allServices
      .map(s => {
        const dur = s.durationMinutes ? ` · ${s.durationMinutes}min` : '';
        return `<option value="${esc(s.name)}" data-duration="${s.durationMinutes || 60}" ${s.name === selected ? 'selected' : ''}>${esc(s.name)} (${esc(s.price)}${dur})</option>`;
      })
      .join('');

  // Update duration display on service select
  sel.onchange = updateDurationDisplay;
  updateDurationDisplay();
}

// ── Phone placeholder helpers ──────────────────────────────────────────────────

const COUNTRY_PHONE_CODES = { PK: '+92', IN: '+91', AE: '+971', SA: '+966', US: '+1', GB: '+44' };

const BRANCH_KEYWORDS = [
  { kw: ['pakistan', 'lahore', 'karachi', 'islamabad', 'rawalpindi', 'faisalabad'], code: 'PK' },
  { kw: ['india', 'delhi', 'mumbai', 'bangalore', 'chennai', 'hyderabad'], code: 'IN' },
  { kw: ['dubai', 'uae', 'abu dhabi', 'sharjah', 'ajman', 'united arab'], code: 'AE' },
  { kw: ['saudi', 'riyadh', 'jeddah', 'ksa'], code: 'SA' },
  { kw: ['uk', 'united kingdom', 'london', 'manchester'], code: 'GB' },
  { kw: ['usa', 'united states', 'new york', 'los angeles'], code: 'US' },
];

const LOCALE_MAP = {
  'ur': 'PK', 'ur-PK': 'PK', 'en-PK': 'PK',
  'hi': 'IN', 'hi-IN': 'IN', 'en-IN': 'IN',
  'ar-AE': 'AE', 'en-AE': 'AE',
  'ar-SA': 'SA',
  'en-GB': 'GB',
  'en-US': 'US',
};

function setPhonePlaceholder(branchName = null) {
  const el = document.getElementById('bm-phone');
  if (!el) return;
  let code = null;
  // 1. Detect from selected branch address
  if (branchName && allBranches.length) {
    const br = allBranches.find(b => b.name === branchName);
    if (br && br.address) {
      const a = br.address.toLowerCase();
      for (const e of BRANCH_KEYWORDS) {
        if (e.kw.some(k => a.includes(k))) { code = e.code; break; }
      }
    }
  }
  // 2. Fallback: browser locale
  if (!code) {
    const lang = navigator.language || '';
    code = LOCALE_MAP[lang] || LOCALE_MAP[lang.split('-')[0]] || null;
  }
  el.placeholder = (code ? COUNTRY_PHONE_CODES[code] : '+__') + ' 300 1234567';
}

// ── Real-time time availability validation ────────────────────────────────────

function validateTimeInput() {
  const dateVal = document.getElementById('bm-date').value;
  const timeVal = document.getElementById('bm-time').value;
  const errEl = document.getElementById('bm-time-error');
  if (errEl) errEl.textContent = '';
  if (!timeVal || !dateVal) return true;  // nothing to validate yet

  const dow = new Date(dateVal).getDay();
  const dayType = (dow === 0 || dow === 6) ? 'weekend' : 'workday';
  const timing = allTimings[dayType];
  if (!timing) return true;  // no timings configured — allow

  const [rh, rm] = timeVal.split(':').map(Number);
  const requested = rh * 60 + rm;
  const [oh, om] = timing.open_time.split(':').map(Number);
  const [ch, cm] = timing.close_time.split(':').map(Number);
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm;

  // Check START time is within salon hours
  if (requested < openMin || requested > closeMin) {
    if (errEl) errEl.textContent =
      `Start time is outside salon hours (${timing.open_time}–${timing.close_time}).`;
    return false;
  }

  // Check END time is within salon hours (if service duration is set)
  const serviceEl = document.getElementById('bm-service').selectedOptions[0];
  if (serviceEl && serviceEl.dataset.duration) {
    const duration = parseInt(serviceEl.dataset.duration, 10);
    const endMin = requested + duration;
    if (endMin > closeMin) {
      const [eH, eM] = [Math.floor(endMin / 60), endMin % 60];
      const endTimeStr = `${String(eH).padStart(2, '0')}:${String(eM).padStart(2, '0')}`;
      if (errEl) {
        const openH = Math.floor(openMin / 60);
        const openM = openMin % 60;
        const maxStartMin = closeMin - duration;
        const [maxH, maxM] = [Math.floor(maxStartMin / 60), maxStartMin % 60];
        const maxStartStr = `${String(maxH).padStart(2, '0')}:${String(maxM).padStart(2, '0')}`;
        errEl.textContent = `Service ends at ${endTimeStr}, after closing (${timing.close_time}). Latest start time: ${maxStartStr}.`;
      }
      return false;
    }
  }
  return true;
}


// ── Duration and End Time Display ──────────────────────────────────────────────

function parseDurationInput(str) {
  if (!str) return 0;
  str = str.trim();
  if (str.includes(':')) {
    const [h, m] = str.split(':').map(x => parseInt(x, 10) || 0);
    return h * 60 + m;
  }
  return parseInt(str, 10) || 0;
}

function formatDurationForInput(minutes) {
  if (!minutes || minutes === 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`;
}

function calculateEndTime(startTimeHHMM, durationMinutes) {
  if (!startTimeHHMM || !durationMinutes) return null;
  const [h, m] = startTimeHHMM.split(':').map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

function updateDurationDisplay() {
  const serviceSelect = document.getElementById('bm-service');
  const durationDisplay = document.getElementById('bm-service-duration');
  if (!durationDisplay) return;

  const selected = serviceSelect.selectedOptions[0];
  if (!selected || !selected.value) {
    durationDisplay.textContent = '';
    document.getElementById('bm-duration-display').textContent = '—';
    document.getElementById('bm-end-time').textContent = '—';
    return;
  }

  const duration = selected.dataset.duration || 60;
  const durationNum = parseInt(duration, 10);
  const hours = Math.floor(durationNum / 60);
  const mins = durationNum % 60;
  const durStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  durationDisplay.textContent = `⏱️  ${durStr}`;
  document.getElementById('bm-duration-display').textContent = durStr;

  // Auto-set date to today and find next available time
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('bm-date').value = today;

  // Find next available time slot
  const nextSlot = getNextAvailableTimeSlot(today, durationNum);
  if (nextSlot) {
    document.getElementById('bm-time').value = nextSlot;
  }

  // Update staff dropdown with available staff
  updateAvailableStaff();
  updateEndTimeDisplay();
}

function getNextAvailableTimeSlot(date, durationMinutes) {
  const branch = document.getElementById('bm-branch').value;
  if (!branch) return null;

  // Get salon hours for this date
  const dow = new Date(date).getDay();
  const dayType = (dow === 0 || dow === 6) ? 'weekend' : 'workday';
  const timing = allTimings[dayType];

  if (!timing) return null;

  const [openH, openM] = timing.open_time.split(':').map(Number);
  const [closeH, closeM] = timing.close_time.split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  // Get all confirmed bookings for this date
  const dateBookings = allBookings.filter(b => b.date === date && b.status === 'confirmed');

  // Find first available 30-min slot
  let currentSlot = openMinutes;
  while (currentSlot + durationMinutes <= closeMinutes) {
    const slotStr = `${String(Math.floor(currentSlot / 60)).padStart(2, '0')}:${String(currentSlot % 60).padStart(2, '0')}`;
    const slotEnd = currentSlot + durationMinutes;

    // Check if any staff is booked at this time
    let isAvailable = false;
    if (dateBookings.length === 0) {
      isAvailable = true;
    } else {
      // Check if at least one staff member is free
      isAvailable = allStaff.some(staff => {
        const staffBookings = dateBookings.filter(b => b.staff_id === staff.id);
        if (staffBookings.length === 0) return true;
        // Check for overlap
        return !staffBookings.some(b => {
          const [bH, bM] = (b.time || '').split(':').map(Number);
          const [endH, endM] = (b.endTime || '').split(':').map(Number);
          const bStart = bH * 60 + bM;
          const bEnd = endH * 60 + endM;
          return currentSlot < bEnd && slotEnd > bStart;
        });
      });
    }

    if (isAvailable) return slotStr;
    currentSlot += 30; // Try next 30-min slot
  }

  return null;
}

function updateAvailableStaff() {
  const sel = document.getElementById('bm-staff');
  if (!sel) return;

  const date = document.getElementById('bm-date').value;
  const timeStr = document.getElementById('bm-time').value;
  const branch = document.getElementById('bm-branch').value;
  const serviceEl = document.getElementById('bm-service').selectedOptions[0];
  const duration = serviceEl ? (serviceEl.dataset.duration || 60) : 60;
  const durationNum = parseInt(duration, 10);

  // Get service provider roles dynamically
  let serviceProviderRoles = [];
  if (allRoles && allRoles.length > 0) {
    const excludeRoles = ['admin', 'manager', 'receptionist'];
    serviceProviderRoles = allRoles
      .map(r => r.name.toLowerCase())
      .filter(r => !excludeRoles.includes(r));
  }

  // Start with all active staff in selected branch
  let staffList = allStaff.filter(s => s.status === 'active');

  if (serviceProviderRoles.length > 0) {
    staffList = staffList.filter(s =>
      serviceProviderRoles.includes((s.role || '').toLowerCase())
    );
  }

  staffList = staffList.filter(s =>
    s.branch_name === branch || s.branch_id === null
  );

  // If date and time are set, filter to available staff only
  if (date && timeStr) {
    const [tH, tM] = timeStr.split(':').map(Number);
    const timeStart = tH * 60 + tM;
    const timeEnd = timeStart + durationNum;

    const dateBookings = allBookings.filter(b => b.date === date && b.status === 'confirmed');

    staffList = staffList.filter(staff => {
      const staffBookings = dateBookings.filter(b => b.staff_id === staff.id);
      if (staffBookings.length === 0) return true;

      return !staffBookings.some(b => {
        const [bH, bM] = (b.time || '').split(':').map(Number);
        const [endH, endM] = (b.endTime || '').split(':').map(Number);
        const bStart = bH * 60 + bM;
        const bEnd = endH * 60 + endM;
        return timeStart < bEnd && timeEnd > bStart;
      });
    });
  }

  sel.innerHTML =
    `<option value="">— No preference —</option>` +
    staffList
      .map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.role)})</option>`)
      .join('');
}

function updateEndTimeDisplay() {
  const timeInput = document.getElementById('bm-time');
  const serviceSelect = document.getElementById('bm-service');
  const endTimeDisplay = document.getElementById('bm-end-time');
  if (!endTimeDisplay) return;

  if (!timeInput.value || !serviceSelect.value) {
    endTimeDisplay.textContent = '—';
    return;
  }

  const selected = serviceSelect.selectedOptions[0];
  const duration = parseInt(selected.dataset.duration || 60, 10);
  const endTime = calculateEndTime(timeInput.value, duration);

  if (endTime) {
    endTimeDisplay.textContent = endTime;
  }
}

// ── Booking modal field event listeners ──────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const timeInput = document.getElementById('bm-time');
  const dateInput = document.getElementById('bm-date');
  const branchSel = document.getElementById('bm-branch');

  if (timeInput) {
    timeInput.addEventListener('change', validateTimeInput);
    timeInput.addEventListener('change', updateEndTimeDisplay);
    timeInput.addEventListener('change', updateAvailableStaff);
  }
  if (dateInput) {
    dateInput.addEventListener('change', validateTimeInput);
    dateInput.addEventListener('change', updateAvailableStaff);
  }
  if (branchSel) branchSel.addEventListener('change', function () {
    updateAvailableStaff();
  });
});

// ══════════════════════════════════════
//  SERVICES
// ══════════════════════════════════════
async function loadServices() {
  try {
    allServices = await api('/salon-admin/api/services');
    // Rebuild branch filter options dynamically
    const filter = document.getElementById('branch-filter');
    if (filter && allBranches.length) {
      const currentVal = filter.value;
      filter.innerHTML =
        `<option value="">All Branches</option><option value="All Branches">General</option>` +
        allBranches.map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('');
      if (currentVal) setSelect('branch-filter', currentVal);
    }
    renderServices();
  } catch (e) {
    document.getElementById('services-grid').innerHTML =
      '<div style="grid-column:1/-1;text-align:center;color:var(--sub);padding:40px">Could not load services.</div>';
  }
}

// Add this function to panel.js
async function forceRefreshData() {
  const refreshBtn = document.getElementById('refresh-data-btn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing...';
  }

  try {
    // Clear browser caches first
    if (crmChartInstances) {
      Object.values(crmChartInstances).forEach(chart => {
        if (chart && chart.destroy) chart.destroy();
      });
      crmChartInstances = {};
    }

    // Force fresh data from server (bypass cache)
    const timestamp = Date.now();

    // Reload all data with cache-busting
    allServices = await api('/salon-admin/api/services?_=' + timestamp);
    allDeals = await api('/salon-admin/api/deals?_=' + timestamp);
    allBranches = await api('/salon-admin/api/settings/branches?_=' + timestamp);
    allStaff = await api('/salon-admin/api/settings/staff?_=' + timestamp);
    allBookings = await api('/salon-admin/api/bookings?_=' + timestamp);
    allRoles = await api('/salon-admin/api/settings/roles?_=' + timestamp);
    allTimings = await api('/salon-admin/api/settings/timings?_=' + timestamp);

    // Refresh UI
    populateBranchSelects();
    buildBranchSubmenu();
    loadBookings();
    loadTodayBookings();
    loadStats();
    loadTodayBookingsPieChart();
    loadRevenuePieChart();
    renderBranchCrm();

    toast('Data refreshed successfully!', 'ok');
  } catch (e) {
    console.error('Refresh error:', e);
    toast('Error refreshing data', 'err');
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh Data';
    }
  }
}

// Add a refresh button to your dashboard
function addRefreshButton() {
  const header = document.querySelector('.dashboard-header');
  if (header && !document.getElementById('refresh-data-btn')) {
    const btn = document.createElement('button');
    btn.id = 'refresh-data-btn';
    btn.className = 'btn btn-primary';
    btn.innerHTML = '🔄 Refresh Data';
    btn.onclick = forceRefreshData;
    btn.style.marginLeft = 'auto';
    header.appendChild(btn);
  }
}



function renderServices() {
  const branch = document.getElementById('branch-filter').value;
  const list = branch ? allServices.filter(s => s.branch === branch) : allServices;
  const grid = document.getElementById('services-grid');

  grid.innerHTML =
    list.map(s => {
      const duration = s.durationMinutes || 0;
      const hours = Math.floor(duration / 60);
      const mins = duration % 60;
      const durationText = hours > 0
        ? `${hours}h ${mins > 0 ? mins + 'm' : ''}`
        : `${mins}m`;
      return `
      <div class="pkg-card">
        <div class="pkg-card-header">
          <div>
            <div class="pkg-card-name">${esc(s.name)}</div>
            <div class="pkg-card-price">${appCurrency} ${esc(s.price)}</div>
          </div>
          <div class="pkg-card-duration">⏱️ ${durationText}</div>
        </div>
        <div class="pkg-card-branch">📍 ${esc(s.branch)}</div>
        ${s.description
          ? `<div class="pkg-card-desc">${esc(s.description).replace(/·/g, '<span class="dot">·</span>')}</div>`
          : ''}
        <div class="pkg-card-actions">
          <button class="btn btn-sm btn-outline" onclick="editService(${s.id})">Edit</button>
          <button class="btn btn-sm btn-danger"  onclick="deleteService(${s.id})">Delete</button>
        </div>
      </div>`;
    }).join('') +
    `<button class="pkg-add-btn" onclick="openServiceModal()">➕ Add Service</button>`;
}

function openServiceModal() {
  document.getElementById('sm-id').value = '';
  document.getElementById('sm-name').value = '';
  document.getElementById('sm-price').value = '';
  document.getElementById('sm-price').placeholder = `e.g. 2500`;
  document.getElementById('sm-desc').value = '';
  document.getElementById('sm-duration').value = '';
  setSelect('sm-branch', 'All Branches');
  document.getElementById('sm-title').textContent = 'Add Service';
  document.getElementById('service-modal').classList.add('open');
}

function editService(id) {
  const s = allServices.find(x => x.id === id);
  if (!s) return;
  document.getElementById('sm-id').value = s.id;
  document.getElementById('sm-name').value = s.name;
  document.getElementById('sm-price').value = s.price;
  document.getElementById('sm-desc').value = s.description || '';
  document.getElementById('sm-duration').value = formatDurationForInput(s.durationMinutes || 0);
  setSelect('sm-branch', s.branch);
  document.getElementById('sm-title').textContent = 'Edit Service';
  document.getElementById('service-modal').classList.add('open');
}

async function saveService() {
  const id = document.getElementById('sm-id').value;
  const durationStr = document.getElementById('sm-duration').value.trim();
  const body = {
    name: document.getElementById('sm-name').value.trim(),
    price: document.getElementById('sm-price').value.trim(),
    description: document.getElementById('sm-desc').value.trim(),
    branch: document.getElementById('sm-branch').value,
    durationMinutes: parseDurationInput(durationStr),
  };
  if (!body.name || !body.price || !body.durationMinutes) { toast('Name, price, and duration are required', 'err'); return; }

  const existing = allServices.map(s => ({ ...s }));
  if (id) {
    const idx = existing.findIndex(s => s.id == id);
    if (idx > -1) existing[idx] = { ...existing[idx], ...body };
  } else {
    existing.push(body);
  }

  const r = await api('/salon-admin/services', {
    method: 'POST',
    body: JSON.stringify({ services: existing }),
  });
  if (r.ok) {
    allServices = r.services;
    renderServices();
    closeModal('service-modal');
    toast(id ? 'Service updated' : 'Service added', 'ok');
    loadStats();
  } else {
    toast(r.error || 'Error', 'err');
  }
}

async function deleteService(id) {
  if (!confirm('Delete this service?')) return;
  const remaining = allServices.filter(s => s.id !== id);
  const r = await api('/salon-admin/services', {
    method: 'POST',
    body: JSON.stringify({ services: remaining }),
  });
  if (r.ok) {
    allServices = r.services;
    renderServices();
    toast('Service deleted', 'ok');
    loadStats();
  }
}

// ══════════════════════════════════════
//  DEALS
// ══════════════════════════════════════
async function loadDeals() {
  try {
    allDeals = await api('/salon-admin/api/deals');
    renderDeals();
  } catch (e) {
    document.getElementById('deals-list').innerHTML =
      '<p style="color:var(--sub);padding:20px">Could not load deals.</p>';
  }
}

function renderDeals() {
  document.getElementById('deals-list').innerHTML =
    allDeals.map(d => `
      <div class="deal-card">
        <div class="deal-card-body">
          <div class="deal-card-title">${esc(d.title)}</div>
          <div class="deal-card-desc">${esc(d.description)}</div>
        </div>
        <div class="deal-card-actions">
          <span class="badge ${d.active ? 'badge-active' : 'badge-inactive'}">${d.active ? 'Active' : 'Inactive'}</span>
          <button class="btn btn-sm btn-outline" onclick="editDeal(${d.id})">Edit</button>
          <button class="btn btn-sm btn-danger"  onclick="deleteDeal(${d.id})">Delete</button>
        </div>
      </div>`).join('') ||
    '<p style="color:var(--sub);padding:20px">No deals yet.</p>';
}

function openDealModal() {
  document.getElementById('dm-id').value = '';
  document.getElementById('dm-title-input').value = '';
  document.getElementById('dm-desc').value = '';
  setSelect('dm-active', '1');
  document.getElementById('dm-title').textContent = 'Add Deal';
  document.getElementById('deal-modal').classList.add('open');
}

function editDeal(id) {
  const d = allDeals.find(x => x.id === id);
  if (!d) return;
  document.getElementById('dm-id').value = d.id;
  document.getElementById('dm-title-input').value = d.title;
  document.getElementById('dm-desc').value = d.description;
  setSelect('dm-active', String(d.active));
  document.getElementById('dm-title').textContent = 'Edit Deal';
  document.getElementById('deal-modal').classList.add('open');
}

async function saveDeal() {
  const id = document.getElementById('dm-id').value;
  const body = {
    id: id ? parseInt(id) : undefined,
    title: document.getElementById('dm-title-input').value.trim(),
    description: document.getElementById('dm-desc').value.trim(),
    active: document.getElementById('dm-active').value === '1',
  };
  if (!body.title) { toast('Title required', 'err'); return; }

  const updated = id
    ? allDeals.map(d => (d.id == id ? { ...d, ...body } : d))
    : [...allDeals, body];

  const r = await api('/salon-admin/deals', {
    method: 'POST',
    body: JSON.stringify({ deals: updated }),
  });
  if (r.ok) {
    allDeals = r.deals;
    renderDeals();
    closeModal('deal-modal');
    toast('Deal saved', 'ok');
  } else {
    toast(r.error || 'Error', 'err');
  }
}

async function deleteDeal(id) {
  if (!confirm('Delete this deal?')) return;
  const remaining = allDeals.filter(d => d.id !== id);
  const r = await api('/salon-admin/deals', {
    method: 'POST',
    body: JSON.stringify({ deals: remaining }),
  });
  if (r.ok) {
    allDeals = r.deals;
    renderDeals();
    toast('Deal deleted', 'ok');
  }
}

// ══════════════════════════════════════
//  CLIENTS
// ══════════════════════════════════════
async function loadClients() {
  try {
    const rows = await api('/salon-admin/api/clients');
    const tbody = document.getElementById('clients-tbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No clients yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(c => `
      <tr>
        <td><strong>${esc(c.customer_name)}</strong></td>
        <td>${esc(c.phone || '—')}</td>
        <td>${c.booking_count}</td>
        <td>${esc(c.last_visit || '—')}</td>
        <td><span class="badge badge-confirmed">Active</span></td>
      </tr>`).join('');
  } catch (e) {
    document.getElementById('clients-tbody').innerHTML =
      `<tr class="empty-row"><td colspan="5">Could not load clients.</td></tr>`;
  }
}

// ══════════════════════════════════════
//  STAFF DASHBOARD
// ══════════════════════════════════════

async function loadStaffDashboard() {
  const container = document.getElementById('staff-dashboard-container');
  container.innerHTML = '<div class="loading-row" style="text-align:center;padding:40px"><span class="spinner"></span></div>';

  // Populate branch filter (preserve current selection)
  const branchFilter = document.getElementById('staff-branch-filter');
  const currentBranch = branchFilter.value;
  branchFilter.innerHTML = '<option value="">All Branches</option>' +
    allBranches.map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('');
  branchFilter.value = currentBranch;
  const selectedBranch = branchFilter.value;

  // Initialize date filter to today if not set
  const dateFilter = document.getElementById('staff-date-filter');
  if (!dateFilter.value) {
    dateFilter.value = new Date().toISOString().slice(0, 10);
  }
  const selectedDate = dateFilter.value;

  try {
    // Load all bookings if not already loaded
    if (!allBookings.length) {
      const rows = await api('/salon-admin/api/bookings');
      allBookings = rows;
    }

    // Fetch all roles dynamically from database
    if (!allRoles || allRoles.length === 0) {
      allRoles = await api('/salon-admin/api/settings/roles');
    }

    // Get ALL roles - no filtering! Staff dashboard should show ALL staff regardless of role
    // But we'll let the branch filter handle what to show
    const allRoleNames = allRoles.map(r => r.name.toLowerCase());

    // Get bookings for the selected date
    const selectedBookings = allBookings.filter(b => b.date === selectedDate && b.status === 'confirmed');

    let html = '';

    // Group staff by branch - show ALL staff, not just service providers
    const staffByBranch = {};
    allBranches.forEach(b => {
      staffByBranch[b.name] = allStaff.filter(s => s.branch_name === b.name);
    });

    // Filter to selected branch if specified
    let branchesToShow = selectedBranch
      ? { [selectedBranch]: staffByBranch[selectedBranch] || [] }
      : staffByBranch;

    // Start branch sections with grid layout
    html += '<div class="staff-branch-grid">';

    // Generate HTML for each branch
    for (const [branchName, staffList] of Object.entries(branchesToShow)) {
      if (!staffList.length) continue;

      const staffBookingCounts = {};
      staffList.forEach(s => {
        const count = selectedBookings.filter(b => b.staff_id === s.id).length;
        if (count > 0) {
          staffBookingCounts[s.name] = count;
        }
      });

      html += `<div class="staff-branch-section">
        <div class="staff-branch-title">🏪 ${esc(branchName)}</div>
        
        <div class="branch-stats-wrapper">
          <div class="pie-chart-wrapper" style="flex:1;min-width:250px">
            <div class="pie-title" style="font-size:0.85rem">Staff Workload on ${new Date(selectedDate).toLocaleDateString()}</div>
            <canvas id="staffChart_${branchName.replace(/\s+/g, '_')}" style="max-width:250px;max-height:250px;margin:0 auto"></canvas>
          </div>
          
          <div class="staff-grid" style="flex:1;min-width:300px">`;

      // Sort by requestedCount (most requested first)
      const sortedStaff = [...staffList].sort((a, b) =>
        (b.requestedCount || 0) - (a.requestedCount || 0)
      );

      sortedStaff.forEach(s => {
        const staffBookings = selectedBookings.filter(b => b.staff_id === s.id);
        const requestedCount = s.requestedCount || 0;
        const status = s.status || 'active';

        // Check if free or booked
        const isFree = staffBookings.length === 0;
        const statusClass = isFree ? 'free' : 'booked';
        const statusText = isFree ? 'Free on selected date' : `${staffBookings.length} Booking(s)`;

        // Format the date for display
        const dateObj = new Date(selectedDate + 'T00:00:00Z');
        const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const dayLabel = selectedDate === new Date().toISOString().slice(0, 10) ? 'Today' : dateStr;

        html += `<div class="staff-card">
          <div class="staff-card-header">
            <div>
              <div class="staff-name">${esc(s.name)}</div>
              <div class="staff-role">${esc(s.role)}</div>
            </div>
            ${requestedCount > 0 ? `<div class="staff-badge requested">⭐ ${requestedCount}</div>` : ''}
          </div>
          
          <div class="staff-info">
            <strong>Phone:</strong> ${esc(s.phone || '—')}
          </div>
          
          ${staffBookings.length > 0 ? `
            <div class="staff-bookings">
              <strong style="display:block;margin-bottom:6px;color:var(--ink)">${dayLabel}'s Bookings:</strong>
              ${staffBookings.map(b => `
                <div class="booking-item">
                  <span class="booking-time">${esc(b.time)} – ${esc(b.endTime || '—')}</span>
                  <br><span style="color:var(--sub)">${esc(b.service)} • ${esc(b.customer_name)}</span>
                </div>
              `).join('')}
            </div>
          ` : `<div class="no-data-text">✓ No bookings on ${dayLabel.toLowerCase()}</div>`}
          
          <div class="staff-status">
            <div class="status-indicator">
              <div class="status-dot ${statusClass}"></div>
              <span>${statusText}</span>
            </div>
            <div class="status-indicator">
              <span style="color: ${status === 'active' ? 'var(--green)' : 'var(--sub)'}">
                ${status === 'active' ? '● Active' : '● Inactive'}
              </span>
            </div>
          </div>
        </div>`;
      });

      html += `</div>
        </div>`;

      // Branch-specific CRM charts - show for ALL staff
      const branchRequestedBookings = allBookings.filter(b =>
        b.status === 'confirmed' &&
        Number(b.staffRequested) === 1 &&
        b.branch === branchName
      );
      const branchStaffRequestCounts = {};
      branchRequestedBookings.forEach(b => {
        if (b.staff_name) {
          branchStaffRequestCounts[b.staff_name] = (branchStaffRequestCounts[b.staff_name] || 0) + 1;
        }
      });

      const sortedBranchRequests = Object.entries(branchStaffRequestCounts)
        .sort((a, b) => b[1] - a[1]);

      const branchAllBookings = allBookings.filter(b =>
        b.status === 'confirmed' &&
        b.branch === branchName
      );
      const branchStaffAllCounts = {};
      branchAllBookings.forEach(b => {
        if (b.staff_name) {
          branchStaffAllCounts[b.staff_name] = (branchStaffAllCounts[b.staff_name] || 0) + 1;
        }
      });

      const sortedBranchAll = Object.entries(branchStaffAllCounts)
        .sort((a, b) => b[1] - a[1]);

      html += `<div class="crm-charts-row">`;

      if (sortedBranchRequests.length > 0) {
        html += `<div class="crm-chart-column">
          <div class="staff-crm-title">⭐ Most Requested Staff</div>
          <canvas id="requestedChart_${branchName.replace(/\s+/g, '_')}" style="max-width:100%;height:200px"></canvas>
        </div>`;
      }

      if (sortedBranchAll.length > 0) {
        html += `<div class="crm-chart-column">
          <div class="staff-crm-title">📊 Top Staff by Total Bookings</div>
          <canvas id="allChart_${branchName.replace(/\s+/g, '_')}" style="max-width:100%;height:200px"></canvas>
        </div>`;
      }

      html += `</div></div>`;
    }

    html += '</div>';

    if (!html || html === '<div class="staff-branch-grid"></div>') {
      html = '<div class="empty-state"><div class="empty-state-icon">👥</div><p>No staff found for selected branch</p></div>';
    }

    container.innerHTML = html;

    // Render charts (same as before)
    setTimeout(() => {
      for (const [branchName, staffList] of Object.entries(branchesToShow)) {
        if (!staffList || !staffList.length) continue;

        const staffBookingCounts = {};
        staffList.forEach(s => {
          const count = selectedBookings.filter(b => b.staff_id === s.id).length;
          if (count > 0) staffBookingCounts[s.name] = count;
        });

        const chartId = `staffChart_${branchName.replace(/\s+/g, '_')}`;
        const ctx = document.getElementById(chartId);
        if (ctx && Object.keys(staffBookingCounts).length > 0) {
          new Chart(ctx, {
            type: 'doughnut',
            data: {
              labels: Object.keys(staffBookingCounts),
              datasets: [{
                data: Object.values(staffBookingCounts),
                backgroundColor: [
                  'rgba(102, 126, 234, 0.8)',
                  'rgba(240, 147, 251, 0.8)',
                  'rgba(245, 87, 108, 0.8)',
                  'rgba(255, 159, 64, 0.8)',
                  'rgba(75, 192, 192, 0.8)',
                ],
                borderColor: ['#fff'],
                borderWidth: 2,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
              },
            },
          });
        }

        // Requested Staff chart
        const branchRequestedBookings = allBookings.filter(b =>
          b.status === 'confirmed' && Number(b.staffRequested) === 1 && b.branch === branchName
        );
        const branchStaffRequestCounts = {};
        branchRequestedBookings.forEach(b => {
          if (b.staff_name) branchStaffRequestCounts[b.staff_name] = (branchStaffRequestCounts[b.staff_name] || 0) + 1;
        });
        const sortedBranchRequests = Object.entries(branchStaffRequestCounts).sort((a, b) => b[1] - a[1]);

        const reqCtx = document.getElementById(`requestedChart_${branchName.replace(/\s+/g, '_')}`);
        if (reqCtx && sortedBranchRequests.length > 0) {
          new Chart(reqCtx, {
            type: 'bar',
            data: {
              labels: sortedBranchRequests.map(([name]) => name),
              datasets: [{ label: 'Requests', data: sortedBranchRequests.map(([, c]) => c), backgroundColor: 'rgba(245, 87, 108, 0.8)', borderColor: '#f55', borderWidth: 1 }],
            },
            options: { responsive: true, maintainAspectRatio: true, indexAxis: 'y', plugins: { legend: { display: false } } },
          });
        }

        // Top Staff by Total Bookings chart
        const branchAllBookings = allBookings.filter(b => b.status === 'confirmed' && b.branch === branchName);
        const branchStaffAllCounts = {};
        branchAllBookings.forEach(b => {
          if (b.staff_name) branchStaffAllCounts[b.staff_name] = (branchStaffAllCounts[b.staff_name] || 0) + 1;
        });
        const sortedBranchAll = Object.entries(branchStaffAllCounts).sort((a, b) => b[1] - a[1]);

        const allCtx = document.getElementById(`allChart_${branchName.replace(/\s+/g, '_')}`);
        if (allCtx && sortedBranchAll.length > 0) {
          new Chart(allCtx, {
            type: 'bar',
            data: {
              labels: sortedBranchAll.map(([name]) => name),
              datasets: [{ label: 'Bookings', data: sortedBranchAll.map(([, c]) => c), backgroundColor: 'rgba(102, 126, 234, 0.8)', borderColor: '#667eea', borderWidth: 1 }],
            },
            options: { responsive: true, maintainAspectRatio: true, indexAxis: 'y', plugins: { legend: { display: false } } },
          });
        }
      }
    }, 50);

  } catch (e) {
    console.error('Error loading staff dashboard:', e);
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>Could not load staff data</p></div>';
  }
}

// ──────────────────────────────────────────────────────────────
//  UPDATED CRM CHART RENDERING WITH SCROLLABLE BARS
// ──────────────────────────────────────────────────────────────

// Replace the renderBranchCrm function in panel.js (around line 800-900):

async function renderBranchCrm() {
  // Ensure we have bookings and services loaded
  if (!allBookings.length) {
    try { allBookings = await api('/salon-admin/api/bookings'); } catch (e) { }
  }
  if (!allServices.length) {
    try { allServices = await api('/salon-admin/api/services'); } catch (e) { }
  }

  // Date range for selected timeframe
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let fromDate = today;

  if (crmTimeframe === 'day') {
    fromDate = today;
  } else if (crmTimeframe === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    fromDate = d.toISOString().slice(0, 10);
  } else if (crmTimeframe === 'month') {
    fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  } else if (crmTimeframe === 'year') {
    fromDate = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  }

  // Filter bookings: ALL statuses for counting, but REVENUE only from COMPLETED
  let filtered = allBookings.filter(b => b.status === 'confirmed' || b.status === 'completed');

  // For revenue, only completed
  let revenueFiltered = allBookings.filter(b => b.status === 'completed');

  // Apply branch filter for CRM analytics
  if (activeBookingBranch) {
    filtered = filtered.filter(b => b.branch === activeBookingBranch);
    revenueFiltered = revenueFiltered.filter(b => b.branch === activeBookingBranch);
  }

  filtered = filtered.filter(b => b.date >= fromDate && b.date <= today);
  revenueFiltered = revenueFiltered.filter(b => b.date >= fromDate && b.date <= today);

  // Build service counts from filtered (confirmed + completed)
  const svcCounts = {};
  filtered.forEach(b => {
    if (!b.service) return;
    svcCounts[b.service] = (svcCounts[b.service] || 0) + 1;
  });

  // Build revenue ONLY from completed bookings
  const svcRevenue = {};
  revenueFiltered.forEach(b => {
    if (!b.service) return;
    const svc = allServices.find(s => s.name === b.service);
    const price = svc ? (parseFloat(String(svc.price).replace(/[^0-9.]/g, '')) || 0) : 0;
    svcRevenue[b.service] = (svcRevenue[b.service] || 0) + price;
  });

  // Get top 15 services by count
  const topSvcs = Object.entries(svcCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const totalRev = Object.values(svcRevenue).reduce((a, b) => a + b, 0);
  const topSvcName = topSvcs[0]?.[0] || '—';
  const topSvcRev = topSvcs[0] ? svcRevenue[topSvcs[0][0]] || 0 : 0;

  // Update stat tiles
  document.getElementById('crm-revenue').textContent = appCurrency + totalRev.toLocaleString('en-PK', { minimumFractionDigits: 0 });
  document.getElementById('crm-count').textContent = filtered.length;
  document.getElementById('crm-top-service').textContent = topSvcName;
  document.getElementById('crm-top-revenue').textContent = appCurrency + topSvcRev.toLocaleString('en-PK', { minimumFractionDigits: 0 });

  console.log('CRM Stats - Period:', crmTimeframe, 'from:', fromDate);
  console.log('Filtered bookings (confirmed+completed):', filtered.length);
  console.log('Revenue bookings (completed):', revenueFiltered.length);
  console.log('Total revenue:', totalRev);
  console.log('Top services:', topSvcs.slice(0, 5));

  // Destroy old charts
  if (crmChartInstances['crm-services-bar']) {
    crmChartInstances['crm-services-bar'].destroy();
    delete crmChartInstances['crm-services-bar'];
  }
  if (crmChartInstances['crm-revenue-pie']) {
    crmChartInstances['crm-revenue-pie'].destroy();
    delete crmChartInstances['crm-revenue-pie'];
  }

  const COLORS = [
    'rgba(102,126,234,0.85)', 'rgba(251, 147, 147, 0.85)', 'rgba(245,87,108,0.85)',
    'rgba(255,159,64,0.85)', 'rgba(75,192,192,0.85)', 'rgba(255,205,86,0.85)',
    'rgba(54,162,235,0.85)', 'rgba(153,102,255,0.85)', 'rgba(255,99,132,0.85)',
    'rgba(54,162,235,0.85)', 'rgba(255,206,86,0.85)', 'rgba(75,192,192,0.85)',
    'rgba(153,102,255,0.85)', 'rgba(255,159,64,0.85)', 'rgba(199,199,199,0.85)',
  ];

  // ──────────────────────────────────────────────────────────
  // BAR CHART - Most Booked Services (Scrollable)
  // ──────────────────────────────────────────────────────────
  const barCanvas = document.getElementById('crm-services-bar');
  const noBar = document.getElementById('crm-no-services');

  if (topSvcs.length === 0) {
    if (barCanvas) barCanvas.style.display = 'none';
    if (noBar) {
      noBar.style.display = '';
      noBar.textContent = activeBookingBranch ? `No data for ${activeBookingBranch} in this period` : 'No data for this period';
    }
  } else {
    if (barCanvas) barCanvas.style.display = '';
    if (noBar) noBar.style.display = 'none';

    // Shorten long service names
    const shortLabels = topSvcs.map(([s]) => {
      if (s.length > 35) return s.substring(0, 32) + '...';
      if (s.length > 25) return s.substring(0, 22) + '...';
      return s;
    });

    crmChartInstances['crm-services-bar'] = new Chart(barCanvas, {
      type: 'bar',
      data: {
        labels: shortLabels,
        datasets: [{
          data: topSvcs.map(([, c]) => c),
          backgroundColor: COLORS.slice(0, topSvcs.length),
          borderRadius: 4,
          borderSkipped: false,
          barPercentage: 0.7,
          categoryPercentage: 0.8,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        indexAxis: 'y',
        devicePixelRatio: 2,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const fullName = topSvcs[ctx.dataIndex][0];
                return `${fullName}: ${ctx.raw} booking${ctx.raw !== 1 ? 's' : ''}`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { stepSize: 1, font: { size: 10 } },
            grid: { color: 'rgba(0,0,0,0.04)' },
            title: { display: true, text: 'Number of Bookings', font: { size: 10 } }
          },
          y: {
            ticks: { font: { size: 10 }, autoSkip: false },
            grid: { display: false },
            title: { display: true, text: 'Services', font: { size: 10 } }
          },
        },
        layout: {
          padding: { left: 5, right: 5, top: 5, bottom: 5 }
        }
      },
    });
  }

  // ──────────────────────────────────────────────────────────
  // PIE CHART - Revenue by Service (from COMPLETED only)
  // ──────────────────────────────────────────────────────────
  const pieCanvas = document.getElementById('crm-revenue-pie');
  const noPie = document.getElementById('crm-no-revenue');

  // Get revenue data for top services only (from svcRevenue, which is completed-only)
  const pieData = [];
  const pieLabels = [];
  const pieColors = [];

  // Sort services by revenue for pie chart
  const sortedByRevenue = Object.entries(svcRevenue).sort((a, b) => b[1] - a[1]).slice(0, 10);

  for (let i = 0; i < sortedByRevenue.length; i++) {
    const revenue = sortedByRevenue[i][1];
    if (revenue > 0) {
      pieData.push(revenue);
      let label = sortedByRevenue[i][0];
      if (label.length > 30) label = label.substring(0, 27) + '...';
      else if (label.length > 20) label = label.substring(0, 17) + '...';
      pieLabels.push(label);
      pieColors.push(COLORS[i % COLORS.length]);
    }
  }

  if (pieLabels.length === 0) {
    if (pieCanvas) pieCanvas.style.display = 'none';
    if (noPie) {
      noPie.style.display = '';
      noPie.textContent = activeBookingBranch ? `No revenue data for ${activeBookingBranch} in this period` : 'No revenue data for this period';
    }
  } else {
    if (pieCanvas) {
      pieCanvas.style.display = '';
      pieCanvas.width = 220;
      pieCanvas.height = 220;
      pieCanvas.style.width = '220px';
      pieCanvas.style.height = '220px';
    }
    if (noPie) noPie.style.display = 'none';

    // In renderBranchCrm function, update the pie chart options:

    crmChartInstances['crm-revenue-pie'] = new Chart(pieCanvas, {
      type: 'doughnut',
      data: {
        labels: pieLabels,
        datasets: [{
          data: pieData,
          backgroundColor: pieColors,
          borderColor: '#fff',
          borderWidth: 2,
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        devicePixelRatio: 2,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              boxWidth: 11,
              font: { size: 10 },
              padding: 8,
              generateLabels: (chart) => {
                const original = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                return original.map(label => {
                  if (label.text && label.text.length > 25) {
                    label.text = label.text.substring(0, 22) + '...';
                  }
                  return label;
                });
              }
            }
          },
          tooltip: {
            bodyFont: { size: 12 },
            titleFont: { size: 13, weight: 'bold' },
            padding: 12,
            caretSize: 8,
            cornerRadius: 6,
            callbacks: {
              label: (ctx) => {
                const percentage = Math.round(ctx.raw / totalRev * 100);
                return ` ${ctx.label}: ${appCurrency}${ctx.raw.toLocaleString('en-PK')} (${percentage}%)`;
              }
            }
          }
        },
        cutout: '60%',
      },
    });
  }
}

// ══════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════

// Populate all branch <select> elements across the admin panel from allBranches
function populateBranchSelects() {
  // Booking modal branch select
  const bmBranch = document.getElementById('bm-branch');
  if (bmBranch) {
    const cur = bmBranch.value;
    bmBranch.innerHTML =
      `<option value="">— Select branch —</option>` +
      allBranches.map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('');
    if (cur) setSelect('bm-branch', cur);
  }

  // Service modal branch select
  const smBranch = document.getElementById('sm-branch');
  if (smBranch) {
    const cur = smBranch.value;
    smBranch.innerHTML =
      `<option value="">— All Branches —</option>` +
      allBranches.map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('');
    if (cur) setSelect('sm-branch', cur);
  }
}

// Show a settings sub-tab
function showSettingsTab(tab, el) {
  document.querySelectorAll('.stab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
  document.getElementById('stab-' + tab).classList.add('active');
  if (el) el.classList.add('active');

  if (tab === 'general') loadGeneral();
  if (tab === 'branches') loadBranches();
  if (tab === 'staff') loadStaff();
  if (tab === 'roles') loadRoles();
  if (tab === 'timings') loadTimings();
}

// Entry point when Settings nav tab is clicked
async function loadSettings() {
  // Reset to General sub-tab
  document.querySelectorAll('.stab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
  document.getElementById('stab-general').classList.add('active');
  document.querySelector('.stab').classList.add('active');
  // Preload all sub-tab data so it's ready when user switches tabs
  await loadGeneral();
  loadBranches();
  loadStaff();
  loadRoles();
  loadTimings();
}

// ── BRANCHES ──────────────────────────────────────────────────────────────────

async function loadBranches() {
  const tbody = document.getElementById('branches-tbody');
  tbody.innerHTML = `<tr class="loading-row"><td colspan="6"><span class="spinner"></span></td></tr>`;
  try {
    allBranches = await api('/salon-admin/api/settings/branches');
    renderBranches();
    populateBranchSelects();
    buildBranchSubmenu();
  } catch (e) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Could not load branches.</td></tr>`;
  }
}

function renderBranches() {
  const tbody = document.getElementById('branches-tbody');
  if (!allBranches.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No branches added yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = allBranches.map(b => `
    <tr>
      <td><strong>#${b.number}</strong></td>
      <td>${esc(b.name)}</td>
      <td>${esc(b.address)}</td>
      <td>${esc(b.phone)}</td>
      <td><a href="${esc(b.map_link)}" target="_blank" class="map-link">View Map ↗</a></td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="editBranch(${b.id})">✏️ Edit</button>
        <button class="btn btn-sm btn-danger"  onclick="deleteBranch(${b.id})">🗑 Delete</button>
      </td>
    </tr>`).join('');
}

let editingBranchId = null;

function openBranchModal(branch) {
  editingBranchId = branch ? branch.id : null;
  document.getElementById('brm-name').value = branch ? branch.name : '';
  document.getElementById('brm-address').value = branch ? branch.address : '';
  document.getElementById('brm-maplink').value = branch ? branch.map_link : '';
  document.getElementById('brm-phone').value = branch ? branch.phone : '';
  document.getElementById('brm-title').textContent = branch ? 'Edit Branch' : 'Add Branch';
  document.getElementById('branch-modal').classList.add('open');
}

function editBranch(id) {
  const b = allBranches.find(x => x.id === id);
  if (b) openBranchModal(b);
}

async function saveBranch() {
  const body = {
    name: document.getElementById('brm-name').value.trim(),
    address: document.getElementById('brm-address').value.trim(),
    map_link: document.getElementById('brm-maplink').value.trim(),
    phone: document.getElementById('brm-phone').value.trim(),
  };

  const errs = [];
  if (!body.name) errs.push('Branch Name');
  if (!body.address) errs.push('Address');
  if (!body.map_link || !body.map_link.startsWith('http')) errs.push('Valid Map Link (must start with http)');
  if (!body.phone) errs.push('Phone');
  if (errs.length) { toast('Required: ' + errs.join(', '), 'err'); return; }

  const url = editingBranchId ? `/salon-admin/api/settings/branches/${editingBranchId}` : '/salon-admin/api/settings/branches';
  const method = editingBranchId ? 'PUT' : 'POST';
  const r = await api(url, { method, body: JSON.stringify(body) });
  if (r.error) { toast(r.error, 'err'); return; }

  toast(editingBranchId ? 'Branch updated' : 'Branch added', 'ok');
  closeModal('branch-modal');
  loadBranches();
}

async function deleteBranch(id) {
  if (!confirm('Delete this branch? This cannot be undone.')) return;
  await api(`/salon-admin/api/settings/branches/${id}`, { method: 'DELETE' });
  toast('Branch deleted', 'ok');
  loadBranches();
}

// ── STAFF ─────────────────────────────────────────────────────────────────────

async function loadStaff() {
  const tbody = document.getElementById('staff-tbody');
  tbody.innerHTML = `<tr class="loading-row"><td colspan="6"><span class="spinner"></span></td></tr>`;
  try {
    allStaff = await api('/salon-admin/api/settings/staff');
    renderStaff();
  } catch (e) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Could not load staff.</td></tr>`;
  }
}

function renderStaff() {
  const tbody = document.getElementById('staff-tbody');
  if (!allStaff.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No staff added yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = allStaff.map(s => `
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td>${esc(s.phone)}</td>
      <td><span class="role-badge">${esc(s.role)}</span></td>
      <td>${esc(s.branch_name || '—')}</td>
      <td><span class="badge ${s.status === 'active' ? 'badge-confirmed' : 'badge-inactive'}">${esc(s.status)}</span></td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="editStaff(${s.id})">✏️ Edit</button>
        <button class="btn btn-sm btn-danger"  onclick="deleteStaff(${s.id})">🗑 Delete</button>
      </td>
    </tr>`).join('');
}

let editingStaffId = null;

// Update the openStaffModal function in panel.js
function openStaffModal(staff) {
  editingStaffId = staff ? staff.id : null;
  document.getElementById('stm-name').value = staff ? staff.name : '';
  document.getElementById('stm-phone').value = staff ? staff.phone : '';
  setSelect('stm-status', staff ? staff.status : 'active');

  // Populate role select dynamically from DB roles
  const roleSel = document.getElementById('stm-role');

  // Make sure allRoles is loaded
  if (!allRoles || allRoles.length === 0) {
    // Fetch roles if not loaded
    fetch('/salon-admin/api/settings/roles')
      .then(r => r.json())
      .then(roles => {
        allRoles = roles;
        roleSel.innerHTML = allRoles.length
          ? allRoles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('')
          : `<option value="">No roles defined</option>`;
        if (staff) setSelect('stm-role', staff.role);
      })
      .catch(err => console.error('Error loading roles:', err));
  } else {
    roleSel.innerHTML = allRoles.length
      ? allRoles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('')
      : `<option value="">No roles defined</option>`;
    if (staff) setSelect('stm-role', staff.role);
  }

  // Populate branch select dynamically
  const branchSel = document.getElementById('stm-branch');
  branchSel.innerHTML =
    `<option value="">— None —</option>` +
    allBranches.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  if (staff && staff.branch_id) setSelect('stm-branch', String(staff.branch_id));

  document.getElementById('stm-title').textContent = staff ? 'Edit Staff' : 'Add Staff';
  document.getElementById('staff-modal').classList.add('open');
}

function editStaff(id) {
  const s = allStaff.find(x => x.id === id);
  if (s) openStaffModal(s);
}

async function saveStaff() {
  const body = {
    name: document.getElementById('stm-name').value.trim(),
    phone: document.getElementById('stm-phone').value.trim(),
    role: document.getElementById('stm-role').value,
    branch_id: document.getElementById('stm-branch').value || null,
    status: document.getElementById('stm-status').value,
  };

  const errs = [];
  if (!body.name) errs.push('Name');
  if (!body.phone) errs.push('Phone');
  if (!body.role) errs.push('Role');
  if (errs.length) { toast('Required: ' + errs.join(', '), 'err'); return; }

  const url = editingStaffId ? `/salon-admin/api/settings/staff/${editingStaffId}` : '/salon-admin/api/settings/staff';
  const method = editingStaffId ? 'PUT' : 'POST';
  const r = await api(url, { method, body: JSON.stringify(body) });
  if (r.error) { toast(r.error, 'err'); return; }

  toast(editingStaffId ? 'Staff updated' : 'Staff added', 'ok');
  closeModal('staff-modal');
  loadStaff();
}

async function deleteStaff(id) {
  if (!confirm('Remove this staff member?')) return;
  await api(`/salon-admin/api/settings/staff/${id}`, { method: 'DELETE' });
  toast('Staff removed', 'ok');
  loadStaff();
}

// ── TIMINGS ───────────────────────────────────────────────────────────────────

async function loadTimings() {
  try {
    const d = await api('/salon-admin/api/settings/timings');
    if (d.workday) {
      document.getElementById('tm-workday-open').value = d.workday.open_time;
      document.getElementById('tm-workday-close').value = d.workday.close_time;
    }
    if (d.weekend) {
      document.getElementById('tm-weekend-open').value = d.weekend.open_time;
      document.getElementById('tm-weekend-close').value = d.weekend.close_time;
    }
  } catch (e) {
    toast('Could not load timings', 'err');
  }
}

async function saveTimings() {
  const body = {
    workday: {
      open_time: document.getElementById('tm-workday-open').value,
      close_time: document.getElementById('tm-workday-close').value,
    },
    weekend: {
      open_time: document.getElementById('tm-weekend-open').value,
      close_time: document.getElementById('tm-weekend-close').value,
    },
  };

  if (!body.workday.open_time || !body.workday.close_time ||
    !body.weekend.open_time || !body.weekend.close_time) {
    toast('Please fill in all time fields', 'err'); return;
  }
  if (body.workday.close_time <= body.workday.open_time) {
    toast('Workday closing time must be after opening time', 'err'); return;
  }
  if (body.weekend.close_time <= body.weekend.open_time) {
    toast('Weekend closing time must be after opening time', 'err'); return;
  }

  const r = await api('/salon-admin/api/settings/timings', { method: 'PUT', body: JSON.stringify(body) });
  if (r.ok) {
    toast('Salon hours saved', 'ok');
  } else {
    toast(r.error || 'Error saving timings', 'err');
  }
}

// ══════════════════════════════════════
//  GENERAL SETTINGS (currency etc.)
// ══════════════════════════════════════

async function loadGeneral() {
  try {
    const d = await api('/salon-admin/api/settings/general');
    const currency = d.currency || 'Rs.';
    const sel = document.getElementById('gen-currency');
    const knownValues = [...sel.options].map(o => o.value).filter(v => v !== 'custom');
    if (knownValues.includes(currency)) {
      setSelect('gen-currency', currency);
      document.getElementById('gen-currency-custom-row').style.display = 'none';
    } else {
      setSelect('gen-currency', 'custom');
      document.getElementById('gen-currency-custom').value = currency;
      document.getElementById('gen-currency-custom-row').style.display = '';
    }
  } catch (e) {
    toast('Could not load settings', 'err');
  }
}

// Show/hide custom currency input when dropdown changes
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('gen-currency');
  if (sel) sel.addEventListener('change', () => {
    document.getElementById('gen-currency-custom-row').style.display =
      sel.value === 'custom' ? '' : 'none';
  });
});

async function saveGeneral() {
  const sel = document.getElementById('gen-currency');
  const currency = sel.value === 'custom'
    ? document.getElementById('gen-currency-custom').value.trim()
    : sel.value;
  if (!currency) { toast('Please enter a currency prefix', 'err'); return; }
  const r = await api('/salon-admin/api/settings/general', {
    method: 'PUT',
    body: JSON.stringify({ currency }),
  });
  if (r.ok) {
    appCurrency = currency;
    const priceInput = document.getElementById('sm-price');
    if (priceInput) priceInput.placeholder = `e.g. 2500`;
    toast('Settings saved', 'ok');
  } else {
    toast(r.error || 'Error saving settings', 'err');
  }
}

// ══════════════════════════════════════
//  ROLES
// ══════════════════════════════════════

async function loadRoles() {
  const tbody = document.getElementById('roles-tbody');
  tbody.innerHTML = `<tr class="loading-row"><td colspan="2"><span class="spinner"></span></td></tr>`;
  try {
    allRoles = await api('/salon-admin/api/settings/roles');
    renderRoles();
  } catch (e) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="2">Could not load roles.</td></tr>`;
  }
}

function renderRoles() {
  const tbody = document.getElementById('roles-tbody');
  if (!allRoles.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="2">No roles defined yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = allRoles.map(r => `
    <tr>
      <td><span class="role-badge">${esc(r.name)}</span></td>
      <td>
        <button class="btn btn-sm btn-danger" onclick="deleteRole(${r.id}, '${esc(r.name)}')">🗑 Delete</button>
      </td>
    </tr>`).join('');
}

function openRoleModal() {
  document.getElementById('role-name-input').value = '';
  document.getElementById('role-modal').classList.add('open');
}

async function saveRole() {
  const name = document.getElementById('role-name-input').value.trim();
  if (!name) { toast('Please enter a role name', 'err'); return; }
  const r = await api('/salon-admin/api/settings/roles', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (r.error) { toast(r.error, 'err'); return; }
  toast('Role added', 'ok');
  closeModal('role-modal');
  await loadRoles();
}

async function deleteRole(id, name) {
  if (!confirm(`Delete role "${name}"? Staff with this role will keep it as a label, but it won't appear in the dropdown anymore.`)) return;
  await api(`/salon-admin/api/settings/roles/${id}`, { method: 'DELETE' });
  toast('Role deleted', 'ok');
  await loadRoles();
}

// ══════════════════════════════════════
//  MODAL CLOSE ON OVERLAY CLICK
// ══════════════════════════════════════
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => {
    if (e.target === o) o.classList.remove('open');
  });
});



// ══════════════════════════════════════
//  INIT
// ══════════════════════════════════════
(async function init() {
  initDashboardHeader();
  // Call this in init()
  // setTimeout(addRefreshButton, 1000);
  try {
    allBranches = await api('/salon-admin/api/settings/branches');
    populateBranchSelects();
    buildBranchSubmenu();
  } catch (e) { /* non-fatal */ }

  try {
    allRoles = await api('/salon-admin/api/settings/roles');
    console.log('Roles loaded:', allRoles);
  } catch (e) { /* non-fatal */ }

  try {
    const settings = await api('/salon-admin/api/settings/general');
    if (settings.currency) appCurrency = settings.currency;
  } catch (e) { /* non-fatal */ }

  try {
    allStaff = await api('/salon-admin/api/settings/staff');
  } catch (e) { /* non-fatal */ }

  try {
    allTimings = await api('/salon-admin/api/settings/timings');
  } catch (e) { /* non-fatal */ }

  await Promise.all([
    loadTodayBookings(),
    loadUpcoming(),
    loadServices(),
    loadStats(),
    loadTodayBookingsPieChart(),  // Today's bookings distribution
    loadRevenuePieChart(),         // Revenue distribution
  ]);

  try {
    if (!allBookings.length) allBookings = await api('/salon-admin/api/bookings');
  } catch (e) { }
})();