/* Helpers shared by the login, parent and admin pages. Loaded as a classic script before each page's own script. */

const $ = (sel) => document.querySelector(sel);

// ----- time --------------------------------------------------------------------

/** Classes run on Singapore time. Always render in SGT and say so, whatever the browser's zone. */
const SG_TIME = { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
const when = (iso) => (iso ? `${new Date(iso).toLocaleString('en-SG', SG_TIME)} SGT` : '');

// ----- text --------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS = {
  pending_payment: { label: 'Pending payment', tone: 'warn' },
  confirmed: { label: 'Confirmed', tone: 'ok' },
  payment_failed: { label: 'Payment failed', tone: 'bad' },
  refunded: { label: 'Refunded', tone: 'bad' },
  refund_pending: { label: 'Refund pending', tone: 'warn' },
  expired: { label: 'Expired', tone: 'muted' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};
const statusLabel = (status) => (STATUS[status] || { label: status }).label;
const badge = (status) => {
  const s = STATUS[status] || { label: status, tone: 'muted' };
  return `<span class="badge ${s.tone}">${esc(s.label)}</span>`;
};

/** `status_reason` values written by the backend, in words a parent can read. */
const REASON_COPY = {
  seat_taken: 'Last seat was taken while paying; refunded',
  card_declined: 'Card declined',
  insufficient_funds: 'Insufficient funds',
  class_full_before_payment: 'Class filled up before payment; not charged',
  checkout_window_elapsed: 'Checkout window expired',
  cancelled_by_parent: 'Cancelled by you',
  cancelled_by_admin: 'Cancelled by Ottodot',
  cancelled_by_user: 'Cancelled',
  booking_cancelled: 'Cancelled during payment; refunded',
  booking_expired: 'Expired during payment; refunded',
  duplicate_booking: 'Duplicate booking; refunded',
};
const reasonText = (reason) =>
  reason ? REASON_COPY[reason] || reason.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '';

// ----- api ---------------------------------------------------------------------

class ApiError extends Error {
  constructor(code, message, details, status) {
    super(message);
    this.code = code;
    this.details = details || {};
    this.status = status;
  }
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(
      path,
      body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined,
    );
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the server', {}, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error?.code || 'INTERNAL', data.error?.message || res.statusText, data.error?.details, res.status);
  }
  return data;
}

/** Copy per error code. Raw backend/validation strings never reach the parent. */
const ERROR_COPY = {
  NETWORK: () => 'Cannot reach the server. Check your connection and try again.',
  VALIDATION: () => 'Please fill in all the fields.',
  NOT_FOUND: () => 'We could not find that booking or class. Refresh the page and try again.',
  INVALID_CREDENTIALS: () => 'Wrong username or password.',
  UNAUTHENTICATED: () => 'Your session has ended. Please log in again.',
  FORBIDDEN: () => 'You do not have access to that.',
  DUPLICATE_BOOKING: (d, ctx) =>
    ctx.kid ? `${ctx.kid.name} already has a seat in ${ctx.cls?.title ?? 'this class'}.` : 'This child already has a seat in this class.',
  CLASS_FULL: (d, ctx) => `${ctx.cls?.title ?? 'This class'} is now full. Please pick another class.`,
  BOOKING_NOT_PAYABLE: (d) =>
    d.status === 'expired'
      ? 'This booking expired before payment was completed. Please book the class again.'
      : `This booking is ${statusLabel(d.status).toLowerCase()} and can no longer be paid.`,
  PAYMENT_IN_PROGRESS: () => 'Your payment is still being processed. Please wait a moment.',
  BOOKING_NOT_CANCELLABLE: (d) => `This booking is already ${statusLabel(d.status).toLowerCase()} and cannot be cancelled.`,
  INTERNAL: () => 'Something went wrong on our side. Please try again.',
};
const friendly = (err, ctx = {}) => {
  const fn = ERROR_COPY[err && err.code];
  return fn ? fn(err.details || {}, ctx) : ERROR_COPY.INTERNAL();
};

// ----- session -----------------------------------------------------------------

/** The signed-in principal, or null when the session cookie is missing or expired. */
async function currentUser() {
  try {
    return await api('/api/auth/me');
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

/** Gate a page: bounce to /login when signed out, or to the right home when the role does not fit. */
async function requireRole(role) {
  const me = await currentUser();
  if (!me) {
    location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
    return null;
  }
  if (me.role !== role) {
    location.replace(me.role === 'admin' ? '/admin' : '/');
    return null;
  }
  return me;
}

function renderUserNav(me) {
  const name = me.parent ? me.parent.name : me.username;
  $('#user-nav').innerHTML = `
    <span id="live" class="live" title="Live updates">Live</span>
    <span class="muted small">Signed in as <strong>${esc(name)}</strong></span>
    <button id="logout-btn" class="small ghost">Log out</button>`;
  $('#logout-btn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', {});
    } finally {
      location.replace('/login');
    }
  });
}

// ----- live updates ------------------------------------------------------------

/** Subscribe to server-sent booking changes; the dot in the header shows connection state. */
function connectLive(onChange) {
  const es = new EventSource('/api/events');
  es.addEventListener('change', (e) => {
    let change = {};
    try {
      change = JSON.parse(e.data);
    } catch {
      /* ignore malformed */
    }
    onChange(change);
  });
  es.onopen = () => $('#live')?.classList.add('on');
  es.onerror = () => $('#live')?.classList.remove('on');
  return es;
}

// ----- toast -------------------------------------------------------------------

function toast(msg, tone = 'bad') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${tone} show`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 5000);
}
