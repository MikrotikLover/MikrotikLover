import { api } from '../core/api.js';
import { t, getLang } from '../core/i18n.js';
import { session } from '../core/session.js';
import { esc, field } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';
import { signedIn } from '../app.js';

/** One-time "create first Admin" screen (only while no user exists). */
export default {
  bare: true,
  title: () => t('setup.title'),
  render(main) {
    main.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-brand">
          <span class="brand-mark brand-mark-lg">${icon('shield', { size: 32 })}</span>
          <h1>${esc(t('setup.title'))}</h1>
          <p>${esc(t('setup.intro'))}</p>
        </div>
        <form class="card form auth-card" autocomplete="off">
          ${session.setupKeyRequired ? field({ label: t('setup.key'), required: true, control: '<input name="setup_key" type="password" required autocomplete="off">' }) : ''}
          ${field({ label: t('user.full_name'), required: true, control: '<input name="full_name" required maxlength="100" autocomplete="name">' })}
          ${field({ label: t('user.username'), required: true, hint: t('validation.username'), control: '<input name="username" required pattern="[A-Za-z0-9._\\-]{3,50}" maxlength="50" autocapitalize="none" spellcheck="false" autocomplete="username">' })}
          ${field({ label: t('user.password'), required: true, hint: t('validation.password'), control: '<input name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">' })}
          ${field({ label: t('user.confirm_password'), required: true, control: '<input name="confirm_password" type="password" required maxlength="72" autocomplete="new-password">' })}
          <button type="submit" class="btn btn-primary btn-block">${esc(t('setup.submit'))}</button>
          <p class="kb-hint">${icon('keyboard', { size: 16 })}${esc(t('kb.hint'))}</p>
        </form>
      </div>`;

    const form = main.querySelector('form');
    const nav = EnterNav.attach(form, {
      resetAfterSave: false,
      validate: (f) => {
        const pw = f.elements.password.value;
        const errors = {};
        if (pw && (!/\p{L}/u.test(pw) || !/\d/.test(pw))) errors.password = t('validation.password');
        if (f.elements.confirm_password.value && f.elements.confirm_password.value !== pw) errors.confirm_password = t('validation.confirmed');
        return errors;
      },
      onSave: (data) => api.post('setup/admin', { ...data, lang: getLang() }),
      onSaved: (data) => signedIn(data),
    });
    return () => nav.destroy();
  },
};
