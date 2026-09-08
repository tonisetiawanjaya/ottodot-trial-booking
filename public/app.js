/* Parent-facing flow: pick a child -> pick a class -> pay -> see the status. */

const $ = (sel) => document.querySelector(sel);
const state = { parents: [], parentId: null, studentId: null, classes: [], cards: [], booking: null };

const money = (cents) => `S$${(cents / 100).toFixed(2)}`;
const when = (iso) =>
  iso ? new Date(iso).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, body) {
  const res = await fetch(
    path,
    body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || res.statusText);
    err.code = data.error?.code;
    err.details = data.error?.details;
    throw err;
  }
  return data;
}

const STATUS = {
  pending_payment: { label: 'Pending payment', tone: 'warn' },
  confirmed: { label: 'Confirmed', tone: 'ok' },
  payment_failed: { label: 'Payment failed', tone: 'bad' },
  refunded: { label: 'Refunded', tone: 'bad' },
  expired: { label: 'Expired', tone: 'muted' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};
const badge = (status) => {
  const s = STATUS[status] || { label: status, tone: 'muted' };
  return `<span class="badge ${s.tone}">${esc(s.label)}</span>`;
};

function toast(msg, tone = 'bad') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${tone} show`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 5000);
}

const studentById = (id) => state.parents.flatMap((p) => p.students).find((s) => s.id === id);
const classById = (id) => state.classes.find((c) => c.id === id);

// ----- rendering -------------------------------------------------------------

async function load() {
  [state.parents, state.classes, state.cards] = await Promise.all([
    api('/api/parents'),
    api('/api/trial-classes'),
    api('/api/test-cards'),
  ]);
  $('#parent').innerHTML = state.parents.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  state.parentId = state.parents[0]?.id ?? null;
  $('#card').innerHTML = state.cards.map((c) => `<option value="${c.number}">${esc(c.label)}</option>`).join('');
  renderChildren();
  await renderBookings();
}

function renderChildren() {
  const parent = state.parents.find((p) => p.id === state.parentId);
  const kids = parent?.students ?? [];
  if (!kids.some((k) => k.id === state.studentId)) state.studentId = kids[0]?.id ?? null;
  $('#children').innerHTML =
    kids
      .map(
        (k) => `<label class="chip ${k.id === state.studentId ? 'selected' : ''}">
          <input type="radio" name="student" value="${k.id}" ${k.id === state.studentId ? 'checked' : ''} />
          ${esc(k.name)} <small>${esc(k.grade)}</small></label>`,
      )
      .join('') || '<p class="muted">No children on this account.</p>';
  renderClasses();
}

function renderClasses() {
  $('#classes').innerHTML = state.classes
    .map((c) => {
      const full = c.seats_available === 0;
      const tone = full ? 'bad' : c.seats_available === 1 ? 'warn' : 'ok';
      const seatText = full ? 'Full' : `${c.seats_available} of ${c.capacity} seat${c.seats_available === 1 ? '' : 's'} left`;
      return `<article class="class ${full ? 'full' : ''}">
        <div class="class-main">
          <h3>${esc(c.title)}</h3>
          <p class="muted small">${esc(c.teacher)} · ${esc(when(c.starts_at))}</p>
        </div>
        <div class="class-side">
          <span class="seats ${tone}">${seatText}</span>
          <span class="price">${money(c.price_cents)}</span>
          <button class="primary" data-book="${c.id}" ${full || !state.studentId ? 'disabled' : ''}>
            ${full ? 'Class full' : 'Book trial'}
          </button>
        </div>
      </article>`;
    })
    .join('');
}

async function refreshClasses() {
  state.classes = await api('/api/trial-classes');
  renderClasses();
}

async function renderBookings() {
  if (!state.parentId) return;
  const rows = await api(`/api/parents/${state.parentId}/bookings`);
  $('#bookings').innerHTML = rows.length
    ? rows
        .map(
          (b) => `<tr>
            <td>${esc(b.student_name)}</td>
            <td>${esc(b.class_title)}</td>
            <td>${badge(b.status)}${b.status_reason ? `<div class="muted small">${esc(b.status_reason)}</div>` : ''}</td>
            <td>${b.status === 'pending_payment' ? `<button class="small" data-resume="${b.id}">Continue to payment</button>` : ''}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No bookings yet.</td></tr>';
}

function showPay(booking) {
  state.booking = booking;
  const cls = classById(booking.trial_class_id);
  const kid = studentById(booking.student_id);
  $('#pay-summary').innerHTML = `
    <p><strong>${esc(kid?.name ?? booking.student_id)}</strong> → <strong>${esc(cls?.title ?? booking.trial_class_id)}</strong></p>
    <p class="muted small">Booking ${badge(booking.status)} · <code>${esc(booking.id.slice(0, 8))}</code>
      · complete payment by ${esc(when(booking.expires_at))}. The seat is only yours once payment succeeds.</p>`;
  $('#pay-btn').textContent = `Pay ${money(cls?.price_cents ?? 0)}`;
  $('#step-pay').hidden = false;
  $('#step-result').hidden = true;
  $('#step-pay').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showResult(res) {
  const b = res.booking;
  const cls = classById(b.trial_class_id);
  const kid = studentById(b.student_id);
  const amount = money(res.attempt?.amount_cents ?? cls?.price_cents ?? 0);
  const copy =
    {
      confirmed: `Seat confirmed. ${kid?.name ?? 'Your child'} is on the roster for ${cls?.title ?? 'this class'}.`,
      payment_failed: `Payment was declined (${b.status_reason}). Nothing was charged and no seat was taken. Book again to retry.`,
      refunded: `Your payment went through, but the last seat was taken by another family while you were paying. ${amount} has been refunded automatically and no seat was assigned.`,
      class_full: 'The class filled up before we charged your card. You were not charged.',
      already_confirmed: 'This booking was already confirmed; there is nothing more to pay.',
    }[res.outcome] ?? `Booking is now ${b.status}.`;
  const attempt = res.attempt
    ? `<p class="muted small">Payment attempt: ${esc(res.attempt.status)}${res.attempt.provider_ref ? ` · ref ${esc(res.attempt.provider_ref)}` : ''}${res.attempt.refund_ref ? ` · refund ${esc(res.attempt.refund_ref)}` : ''}${res.attempt.failure_code ? ` · ${esc(res.attempt.failure_code)}` : ''}</p>`
    : '';
  $('#result').innerHTML = `<p class="lead">${badge(b.status)} ${esc(copy)}</p>${attempt}
    <p class="muted small">Booking <code>${esc(b.id)}</code></p>`;
  $('#step-pay').hidden = true;
  $('#step-result').hidden = false;
  $('#step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ----- events ----------------------------------------------------------------

$('#parent').addEventListener('change', (e) => {
  state.parentId = e.target.value;
  state.studentId = null;
  renderChildren();
  renderBookings();
});

$('#children').addEventListener('change', (e) => {
  if (e.target.name === 'student') {
    state.studentId = e.target.value;
    renderChildren();
  }
});

$('#classes').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-book]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const r = await api('/api/bookings', { student_id: state.studentId, trial_class_id: btn.dataset.book });
    if (r.reused) toast('Resuming your unpaid booking for this class.', 'warn');
    showPay(r.booking);
  } catch (err) {
    toast(err.message);
  } finally {
    await refreshClasses();
    await renderBookings();
  }
});

$('#pay-btn').addEventListener('click', async () => {
  const btn = $('#pay-btn');
  btn.disabled = true;
  $('#cancel-btn').disabled = true;
  $('#pay-progress').hidden = false;
  try {
    const r = await api(`/api/bookings/${state.booking.id}/pay`, {
      card: $('#card').value,
      delay_ms: $('#slow').checked ? 4000 : 0,
    });
    showResult(r);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    $('#cancel-btn').disabled = false;
    $('#pay-progress').hidden = true;
    await refreshClasses();
    await renderBookings();
  }
});

$('#cancel-btn').addEventListener('click', async () => {
  try {
    await api(`/api/bookings/${state.booking.id}/cancel`, { reason: 'cancelled_by_parent' });
    $('#step-pay').hidden = true;
    toast('Booking cancelled. No seat was taken.', 'muted');
  } catch (err) {
    toast(err.message);
  }
  await refreshClasses();
  await renderBookings();
});

$('#again-btn').addEventListener('click', () => {
  $('#step-result').hidden = true;
  $('#step-class').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#bookings').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-resume]');
  if (!btn) return;
  try {
    const d = await api(`/api/bookings/${btn.dataset.resume}`);
    showPay(d.booking);
  } catch (err) {
    toast(err.message);
  }
});

load().catch((err) => toast(`Failed to load: ${err.message}`));
