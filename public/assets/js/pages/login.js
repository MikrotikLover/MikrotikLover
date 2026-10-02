// Login screen (public).
import { post } from '../core/api.js';
import { h } from '../core/dom.js';
import { session } from '../core/store.js';
import { afterLogin } from '../app.js';

export default {
  mount(root) {
    const user = h('input', { name: 'username', autocomplete: 'username', required: true, class: 'input' });
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, class: 'input' });
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Log in');
    const form = h('form', { novalidate: true },
      err,
      h('div', { class: 'fld' }, h('label', null, 'Username'), user),
      h('div', { class: 'fld' }, h('label', null, 'Password'), pass),
      btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = 'Logging in…';
      try {
        const data = await post('auth/login', { username: user.value, password: pass.value });
        await afterLogin(data);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        pass.value = '';
        pass.focus();
      } finally {
        btn.disabled = false;
        btn.textContent = 'Log in';
      }
    });
    root.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login' },
      h('h1', null, session.company?.name || window.APP.name),
      session.company?.name_ur ? h('div', { class: 'company-ur' }, session.company.name_ur) : null,
      h('div', { class: 'muted' }, window.APP.name + ' — sign in to continue'),
      form)));
    user.focus();
  },
};
