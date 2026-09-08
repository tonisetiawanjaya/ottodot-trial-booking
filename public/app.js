/* Parent-facing flow: log in -> pick a child -> pick a class -> pay -> see the status.
   One screen at a time. Seat counts and booking statuses update live over SSE, with a slow poll as a fallback.
   Shared helpers ($, api, when, esc, badge, reasonText, friendly, toast, requireRole, connectLive) come from shared.js. */

const POLL_MS = 15000;

const state = {
  me: null,
  students: [],
  studentId: null,
  classes: [],
  classesJson: '',
  bookingsJson: '',
  cards: [],
  booking: null,
  view: 'choose',
};

const money = (cents) => `S$${(cents / 100).toFixed(2)}`;
const studentById = (id) => state.students.find((s) => s.id === id);
const classById = (id) => state.classes.find((c) => c.id === id);

// ----- views -------------------------------------------------------------------

/** choose (child + class) -> pay -> result. Only one is visible; the family's booking list stays below. */
function showView(view) {
  state.view = view;
  $('#step-who').hidden = view !== 'choose';
  $('#step-class').hidden = view !== 'choose';
  $('#step-pay').hidden = view !== 'pay';
  $('#step-result').hidden = view !== 'result';
  const active = { choose: 2, pay: 3, result: 4 }[view];
  document.querySelectorAll('#steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', view === 'choose' ? n <= 2 : n === active);
    li.classList.toggle('done', view !== 'choose' && n < active);
  });
  renderPayNotice();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ----- loading & live updates ---------------------------------------------------

async function load() {
  const me = await requireRole('parent');
  if (!me) return;
  state.me = me;
  state.students = me.students;
  renderUserNav(me);

  [state.classes, state.cards] = await Promise.all([api('/api/trial-classes'), api('/api/test-cards')]);
  state.classesJson = JSON.stringify(state.classes);
  $('#card').innerHTML = state.cards.map((c) => `<option value="${c.number}">${esc(c.label)}</option>`).join('');
  renderChildren();
  await refreshBookings();
  $('#app').hidden = false;
  showView('choose');

  // Push first, poll as a safety net (also covers a dropped SSE connection).
  connectLive(() => poll());
  setInterval(poll, POLL_MS);
}

async function poll() {
  if (document.hidden) return;
  try {
    await Promise.all([refreshClasses(), refreshBookings()]);
  } catch (err) {
    if (err.status === 401) location.replace('/login?next=%2F');
  }
}

async function refreshClasses() {
  const classes = await api('/api/trial-classes');
  const json = JSON.stringify(classes);
  if (json === state.classesJson) return;
  state.classes = classes;
  state.classesJson = json;
  renderClasses();
  renderPayNotice();
}

async function refreshBookings() {
  const rows = await api('/api/me/bookings');
  const json = JSON.stringify(rows);
  if (json === state.bookingsJson) return;
  state.bookingsJson = json;
  renderBookings(rows);
}

// ----- rendering ---------------------------------------------------------------

function renderChildren() {
  const kids = state.students;
  if (!kids.some((k) => k.id === state.studentId)) state.studentId = kids[0]?.id ?? null;
  $('#children').innerHTML =
    kids
      .map(
        (k) => `<label class="chip ${k.id === state.studentId ? 'selected' : ''}">
          <input type="radio" name="student" value="${k.id}" ${k.id === state.studentId ? 'checked' : ''} />
          ${esc(k.name)} <small>${esc(k.grade)}</small></label>`,
      )
      .join('') || '<p class="muted">No children on this account yet.</p>';
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

function renderBookings(rows) {
  $('#bookings').innerHTML = rows.length
    ? rows
        .map(
          (b) => `<tr>
            <td>${esc(b.student_name)}</td>
            <td>${esc(b.class_title)}<div class="muted small">${esc(when(b.starts_at))}</div></td>
            <td>${badge(b.status)}${b.status_reason ? `<div class="muted small">${esc(reasonText(b.status_reason))}</div>` : ''}${b.payment_status === 'refund_pending' ? '<div class="muted small">Refund in progress</div>' : ''}</td>
            <td>${b.status === 'pending_payment' ? `<button class="small" data-resume="${b.id}">Continue to payment</button>` : ''}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No bookings yet.</td></tr>';
}

/** Shown on the payment step if the class filled up while the parent was deciding. */
function renderPayNotice() {
  const el = $('#pay-notice');
  const cls = state.view === 'pay' && state.booking ? classById(state.booking.trial_class_id) : null;
  const gone = Boolean(cls && cls.seats_available === 0);
  el.hidden = !gone;
  if (gone) {
    el.textContent =
      'The last seat in this class was just taken by another family. You can still press Pay: if the seat is really gone you will not be charged.';
  }
}

function showPay(booking) {
  state.booking = booking;
  const cls = classById(booking.trial_class_id);
  const kid = studentById(booking.student_id);
  $('#pay-summary').innerHTML = `
    <p><strong>${esc(kid?.name ?? booking.student_id)}</strong> → <strong>${esc(cls?.title ?? booking.trial_class_id)}</strong>
      <span class="muted small">· ${esc(when(cls?.starts_at))}</span></p>
    <p class="muted small">Booking ${badge(booking.status)} · <code>${esc(booking.id.slice(0, 8))}</code>
      · complete payment by ${esc(when(booking.expires_at))}. The seat is only yours once payment succeeds.</p>`;
  $('#pay-btn').textContent = `Pay ${money(cls?.price_cents ?? 0)}`;
  showView('pay');
}

function showResult(res) {
  const b = res.booking;
  const cls = classById(b.trial_class_id);
  const kid = studentById(b.student_id);
  const amount = money(res.attempt?.amount_cents ?? cls?.price_cents ?? 0);
  const copy =
    {
      confirmed: `Seat confirmed. ${kid?.name ?? 'Your child'} is on the roster for ${cls?.title ?? 'this class'} on ${when(cls?.starts_at)}.`,
      payment_failed: `Payment was declined (${reasonText(b.status_reason).toLowerCase()}). Nothing was charged and no seat was taken. Book again to retry.`,
      refunded: `Your payment went through, but the last seat was taken by another family while you were paying. ${amount} has been refunded automatically and no seat was assigned.`,
      refund_pending: `Your payment went through, but the last seat was taken by another family while you were paying. No seat was assigned. Your ${amount} refund could not be completed right away; we retry automatically and you do not need to do anything.`,
      class_full: 'The class filled up before we charged your card. You were not charged.',
      already_confirmed: 'This booking was already confirmed; there is nothing more to pay.',
    }[res.outcome] ?? `Booking is now ${statusLabel(b.status).toLowerCase()}.`;
  const attempt = res.attempt
    ? `<p class="muted small">Payment attempt: ${esc(res.attempt.status)}${res.attempt.provider_ref ? ` · ref ${esc(res.attempt.provider_ref)}` : ''}${res.attempt.refund_ref ? ` · refund ${esc(res.attempt.refund_ref)}` : ''}${res.attempt.failure_code ? ` · ${esc(reasonText(res.attempt.failure_code))}` : ''}</p>`
    : '';
  $('#result').innerHTML = `<p class="lead">${badge(b.status)} ${esc(copy)}</p>${attempt}
    <p class="muted small">Booking <code>${esc(b.id)}</code></p>`;
  showView('result');
}

// ----- events ------------------------------------------------------------------

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
  const ctx = { kid: studentById(state.studentId), cls: classById(btn.dataset.book) };
  try {
    const r = await api('/api/bookings', { student_id: state.studentId, trial_class_id: btn.dataset.book });
    if (r.reused) toast('Resuming your unpaid booking for this class.', 'warn');
    showPay(r.booking);
  } catch (err) {
    toast(friendly(err, ctx));
  } finally {
    await poll();
    renderClasses();
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
      delay_ms: $("#slow").checked ? 8000 : 0,
    });
    showResult(r);
  } catch (err) {
    toast(friendly(err));
  } finally {
    btn.disabled = false;
    $('#cancel-btn').disabled = false;
    $('#pay-progress').hidden = true;
    await poll();
  }
});

$('#cancel-btn').addEventListener('click', async () => {
  try {
    await api(`/api/bookings/${state.booking.id}/cancel`, {});
    toast('Booking cancelled. No seat was taken.', 'muted');
    showView('choose');
  } catch (err) {
    toast(friendly(err));
  }
  await poll();
});

$('#again-btn').addEventListener('click', () => showView('choose'));

$('#bookings').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-resume]');
  if (!btn) return;
  try {
    const d = await api(`/api/bookings/${btn.dataset.resume}`);
    showPay(d.booking);
  } catch (err) {
    toast(friendly(err));
  }
});

load().catch((err) => toast(friendly(err)));
