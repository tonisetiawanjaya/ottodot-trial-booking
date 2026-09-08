/* Login page. Shared helpers ($, api, friendly, currentUser) come from shared.js. */

const nextParam = new URLSearchParams(location.search).get('next');
/** Only ever redirect within this site. */
const safeNext = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : null;
const homeFor = (me) => (me.role === 'admin' ? '/admin' : '/');

// Already signed in? Go straight to the right page.
currentUser()
  .then((me) => {
    if (me) location.replace(safeNext || homeFor(me));
  })
  .catch(() => {});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const error = $('#login-error');
  btn.disabled = true;
  error.hidden = true;
  try {
    const { principal } = await api('/api/auth/login', {
      username: $('#username').value.trim(),
      password: $('#password').value,
    });
    location.replace(safeNext || homeFor(principal));
  } catch (err) {
    error.textContent = friendly(err);
    error.hidden = false;
    btn.disabled = false;
    $('#password').focus();
    $('#password').select();
  }
});
