import { api } from '../core/api.js';
import { t, getLang } from '../core/i18n.js';
import { esc, field, spinner, errorState } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';
import { searchSelect } from '../core/searchSelect.js';
import { navigate } from '../app.js';

/** Create (#/users/new) and edit (#/users/:id) a user. */
export default {
  title: (params) => t(params.id ? 'users.edit' : 'users.new'),
  render(main, params) {
    const isEdit = !!params.id;
    let nav = null;
    main.innerHTML = spinner();

    Promise.all([api.get('roles'), isEdit ? api.get(`users/${params.id}`) : Promise.resolve(null)])
      .then(([roles, user]) => {
        const ur = getLang() === 'ur';
        main.innerHTML = `
          <form class="card form form-grid" autocomplete="off">
            ${field({ label: t('user.full_name'), required: true, control: '<input name="full_name" required maxlength="100">' })}
            ${field({ label: t('user.username'), required: true, hint: t('validation.username'),
              control: '<input name="username" required pattern="[A-Za-z0-9._\\-]{3,50}" maxlength="50" autocapitalize="none" spellcheck="false">' })}
            ${field({ label: t('user.role'), required: true, control: '<div data-role></div>' })}
            ${field({ label: t('user.lang'), required: true, control: `<select name="lang" required>
                <option value="en">English</option><option value="ur">اردو</option></select>` })}
            ${field({ label: `${t('user.phone')} (${t('common.optional')})`, control: '<input name="phone" type="tel" maxlength="30" pattern="[0-9+\\-\\s\\(\\)]{7,30}" dir="ltr">' })}
            ${field({ label: `${t('user.email')} (${t('common.optional')})`, control: '<input name="email" type="email" maxlength="150" dir="ltr">' })}
            ${isEdit ? '' : field({ label: t('user.password'), required: true, hint: t('validation.password'),
              control: '<input name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">' })}
            <div class="field field-checks">
              <label class="check"><input type="checkbox" name="is_active" checked> <span>${esc(t('user.is_active'))}</span></label>
              ${isEdit ? '' : `<label class="check"><input type="checkbox" name="must_change_password" checked> <span>${esc(t('user.must_change'))}</span></label>`}
            </div>
            <div class="form-actions span-all">
              <a class="btn btn-ghost" href="#/users">${esc(t('common.cancel'))}</a>
              <button type="submit" class="btn btn-primary">${icon('check', { size: 20 })}<span>${esc(t('common.save'))}</span></button>
            </div>
            <p class="kb-hint span-all">${icon('keyboard', { size: 16 })}${esc(t('kb.hint'))}</p>
          </form>`;

        const form = main.querySelector('form');
        const role = searchSelect({
          name: 'role_id',
          required: true,
          options: roles.map((r) => ({ value: r.id, label: ur ? r.name_ur || r.name : r.name, sub: r.code })),
        });
        form.querySelector('[data-role]').replaceWith(role.el);

        if (user) {
          form.elements.full_name.value = user.full_name;
          form.elements.username.value = user.username;
          form.elements.lang.value = user.lang;
          form.elements.phone.value = user.phone || '';
          form.elements.email.value = user.email || '';
          form.elements.is_active.checked = !!user.is_active;
          role.setValue(user.role_id);
          role.setInitial(user.role_id);
          // Make the loaded values the form's reset state.
          [...form.elements].forEach((e) => {
            if (e.type === 'checkbox') e.defaultChecked = e.checked;
            else if (e.tagName === 'SELECT') [...e.options].forEach((o) => { o.defaultSelected = o.selected; });
            else if (e.type !== 'hidden') e.defaultValue = e.value;
          });
        } else {
          form.elements.lang.value = getLang();
          form.elements.lang.querySelector(`option[value="${getLang()}"]`).defaultSelected = true;
        }

        nav = EnterNav.attach(form, {
          // New users: stay on the form for fast entry of the next one. Edit: back to the list.
          resetAfterSave: !isEdit,
          validate: (f) => {
            const pw = f.elements.password?.value || '';
            return pw && (!/\p{L}/u.test(pw) || !/\d/.test(pw)) ? { password: t('validation.password') } : null;
          },
          onSave: (data) => {
            const body = { ...data, role_id: Number(data.role_id) || null };
            return isEdit ? api.put(`users/${params.id}`, body) : api.post('users', body);
          },
          onSaved: () => { if (isEdit) navigate('/users'); },
        });
      })
      .catch((err) => { main.innerHTML = errorState(err.message); });

    return () => nav?.destroy();
  },
};
