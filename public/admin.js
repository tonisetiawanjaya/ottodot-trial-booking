/* Admin / teacher view: confirmed roster per trial class, plus who is mid-checkout. Updates live over SSE.
   Shared helpers ($, api, when, esc, friendly, toast, requireRole, renderUserNav, connectLive) come from shared.js. */

const POLL_MS = 15000;

async function refresh() {
  const rosters = await api('/api/admin/roster');
  $('#rosters').innerHTML = rosters
    .map((r) => {
      const c = r.trial_class;
      const full = c.seats_available === 0;
      const rows = r.confirmed.length
        ? r.confirmed
            .map(
              (e, i) => `<tr>
                <td>${i + 1}</td>
                <td>${esc(e.student_name)}</td>
                <td>${esc(e.grade)}</td>
                <td>${esc(e.parent_name)}</td>
                <td>${esc(e.parent_email)}</td>
                <td>${esc(when(e.confirmed_at))}</td>
                <td><button class="small ghost" data-cancel="${e.booking_id}" data-name="${esc(e.student_name)}">Cancel</button></td>
              </tr>`,
            )
            .join('')
        : '<tr><td colspan="7" class="muted">No confirmed students yet.</td></tr>';
      const pending = r.pending.length
        ? `<p class="muted small">Mid-checkout, <em>not</em> on the roster: ${r.pending
            .map((e) => `${esc(e.student_name)} (until ${esc(when(e.expires_at))})`)
            .join(', ')}</p>`
        : '';
      return `<section class="card">
        <div class="roster-head">
          <div>
            <h2>${esc(c.title)}</h2>
            <p class="muted small">${esc(c.teacher)} · ${esc(when(c.starts_at))}</p>
          </div>
          <div class="count ${full ? 'bad' : 'ok'}">${c.confirmed_count} / ${c.capacity} confirmed${c.pending_count ? ` · ${c.pending_count} pending` : ''}</div>
        </div>
        <table>
          <thead><tr><th>#</th><th>Student</th><th>Grade</th><th>Parent</th><th>Email</th><th>Confirmed at</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${pending}
      </section>`;
    })
    .join('');
  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore' })} SGT`;
}

async function safeRefresh() {
  try {
    await refresh();
  } catch (err) {
    if (err.status === 401) location.replace('/login?next=%2Fadmin');
    else toast(friendly(err));
  }
}

$('#rosters').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  if (!confirm(`Cancel ${btn.dataset.name}'s confirmed seat? The seat is released and the payment refunded.`)) return;
  try {
    await api(`/api/bookings/${btn.dataset.cancel}/cancel`, {});
    toast('Booking cancelled and seat released.', 'ok');
  } catch (err) {
    toast(friendly(err));
  }
  await safeRefresh();
});

$('#expire-btn').addEventListener('click', async () => {
  try {
    const { expired } = await api('/api/admin/jobs/expire-pending', {});
    toast(`Expiry job ran: ${expired} pending booking(s) released.`, 'ok');
  } catch (err) {
    toast(friendly(err));
  }
  await safeRefresh();
});

$('#refunds-btn').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/jobs/retry-refunds', {});
    toast(`Refund job ran: ${r.refunded} completed, ${r.still_pending} still pending.`, 'ok');
  } catch (err) {
    toast(friendly(err));
  }
  await safeRefresh();
});

(async () => {
  const me = await requireRole('admin');
  if (!me) return;
  renderUserNav(me);
  await safeRefresh();
  $('#app').hidden = false;
  connectLive(() => safeRefresh());
  setInterval(safeRefresh, POLL_MS);
})().catch((err) => toast(friendly(err)));
