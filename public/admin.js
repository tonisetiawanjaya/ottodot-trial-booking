/* Admin / teacher view: confirmed roster per trial class, plus who is mid-checkout. */

const $ = (sel) => document.querySelector(sel);
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
  if (!res.ok) throw new Error(data.error?.message || res.statusText);
  return data;
}

function toast(msg, tone = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${tone} show`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 4000);
}

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
  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

$('#rosters').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  if (!confirm(`Cancel ${btn.dataset.name}'s confirmed seat? The seat is released and the payment refunded.`)) return;
  try {
    await api(`/api/bookings/${btn.dataset.cancel}/cancel`, { reason: 'cancelled_by_admin' });
    toast('Booking cancelled and seat released.');
  } catch (err) {
    toast(err.message, 'bad');
  }
  await refresh();
});

$('#expire-btn').addEventListener('click', async () => {
  try {
    const { expired } = await api('/api/admin/jobs/expire-pending', {});
    toast(`Expiry job ran: ${expired} pending booking(s) released.`);
  } catch (err) {
    toast(err.message, 'bad');
  }
  await refresh();
});

refresh().catch((err) => toast(err.message, 'bad'));
setInterval(() => refresh().catch(() => {}), 3000);
