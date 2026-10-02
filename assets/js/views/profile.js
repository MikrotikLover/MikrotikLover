import { api } from '../core/api.js';
import { t, getLang, setLang } from '../core/i18n.js';
import { session } from '../core/session.js';
import { esc, field } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';
import { navigate } from '../app.js';

export default {
  title: () => t('profile.title'),
  render(main) {
    const u = session.user;
    const forced = !!u.must_change_password;
    main.innerHTML = `
      <section class="card profile-head">
        <span class="avatar avatar-lg">${esc(u.full_name.charAt(0).toUpperCase())}</span>
        <div><h2>${esc(u.full_name)}</h2><p class="muted">@${esc(u.username)} · ${esc(getLang() === 'ur' ? u.role_name_ur || u.role_name : u.role_name)}</p></div>
      </section>
      ${forced ? `<div class="notice notice-warn">${icon('alert', { size: 20 })}<span>${esc(t('profile.must_change'))}</span></div>` : ''}
      <form class="card form" autocomplete="off" data-pw>
        <h2>${esc(t('profile.change_password'))}</h2>
        ${field({ label: t('user.current_password'), required: true, control: '<input name="current_password" type="password" required maxlength="200" autocomplete="current-password">' })}
        ${field({ label: t('user.new_password'), required: true, hint: t('validation.password'), control: '<input name="new_password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">' })}
        ${field({ label: t('user.confirm_password'), required: true, control: '<input name="confirm_password" type="password" required maxlength="72" autocomplete="new-password">' })}
        <div class="form-actions"><button type="submit" class="btn btn-primary">${icon('key', { size: 20 })}<span>${esc(t('profile.change_password'))}</span></button></div>
      </form>
      ${forced ? '' : `<section class="card form">
        <h2>${esc(t('profile.language'))}</h2>
        <div class="seg" role="group" aria-label="${esc(t('profile.language'))}">
          <button type="button" class="seg-btn ${getLang() === 'en' ? 'is-active' : ''}" data-l="en">English</button>
          <button type="button" class="seg-btn ${getLang() === 'ur' ? 'is-active' : ''}" data-l="ur">اردو</button>
        </div>
      </section>`}`;

    const form = main.querySelector('[data-pw]');
    const nav = EnterNav.attach(form, {
      autofocus: forced,
      validate: (f) => {
        const errors = {};
        const pw = f.elements.new_password.value;
        if (pw && (!/\p{L}/u.test(pw) || !/\d/.test(pw))) errors.new_password = t('validation.password');
        if (f.elements.confirm_password.value && f.elements.confirm_password.value !== pw) errors.confirm_password = t('validation.confirmed');
        return errors;
      },
      successMessage: (res) => res?.message || t('saved'),
      onSave: (data) => api.post('auth/password', data),
      onSaved: () => {
        if (forced) {
          session.user.must_change_password = 0;
          navigate('/', { replace: true });
        }
      },
    });

    main.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.l === getLang()) return;
      setLang(b.dataset.l);
      api.post('auth/lang', { lang: b.dataset.l }).catch(() => {});
    }));
    return () => nav.destroy();
  },
};
