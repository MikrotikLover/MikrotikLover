import { api } from '../core/api.js';
import { t } from '../core/i18n.js';
import { session } from '../core/session.js';
import { esc, field } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';
import { signedIn } from '../app.js';

export default {
  bare: true,
  title: () => t('login.title'),
  render(main) {
    main.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-brand">
          <span class="brand-mark brand-mark-lg">${icon('printer', { size: 32 })}</span>
          <h1>${esc(session.app.name || t('app.name'))}</h1>
          <p>${esc(t('login.subtitle'))}</p>
        </div>
        <form class="card form auth-card" autocomplete="on">
          <h2>${esc(t('login.title'))}</h2>
          ${field({ label: t('login.username'), required: true, control: '<input name="username" required maxlength="50" autocomplete="username" autocapitalize="none" spellcheck="false">' })}
          ${field({ label: t('login.password'), required: true, control: '<input name="password" type="password" required maxlength="200" autocomplete="current-password">' })}
          <button type="submit" class="btn btn-primary btn-block">${icon('lock', { size: 20 })}<span>${esc(t('login.submit'))}</span></button>
          <p class="kb-hint">${icon('keyboard', { size: 16 })}${esc(t('kb.hint'))}</p>
        </form>
      </div>`;

    const nav = EnterNav.attach(main.querySelector('form'), {
      resetAfterSave: false,
      successMessage: (data) => t('login.welcome', { name: data.user.full_name }),
      onSave: async (data) => {
        try {
          return await api.post('auth/login', data);
        } catch (err) {
          // Wrong credentials / lockout: show the message beside the password and focus it for a retry.
          if (!err.errors && err.status >= 400 && err.status < 500) {
            main.querySelector('[name="password"]').value = '';
            err.errors = { password: err.message };
          }
          throw err;
        }
      },
      onSaved: (data) => signedIn(data),
    });
    return () => nav.destroy();
  },
};
