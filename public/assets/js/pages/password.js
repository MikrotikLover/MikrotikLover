// Change own password (forced on first login).
import { post } from '../core/api.js';
import { h, toast } from '../core/dom.js';
import { Form } from '../core/form.js';
import { setKeys } from '../core/keys.js';
import { go } from '../core/router.js';
import { session } from '../core/store.js';
import { markPasswordChanged } from '../app.js';

export default {
  mount(root) {
    const form = new Form([
      { name: 'current_password', label: 'Current password', type: 'password', required: true, span: 12 },
      { name: 'new_password', label: 'New password', type: 'password', required: true, span: 12, help: 'At least 8 characters with letters and numbers.' },
      { name: 'confirm_password', label: 'Confirm new password', type: 'password', required: true, span: 12 },
    ]);
    const save = async () => {
      try {
        await post('auth/password', form.values);
        markPasswordChanged();
        toast('Password changed.');
        go('/');
      } catch (e) {
        form.showErrors(e.errors, e.message);
      }
    };
    setKeys({ save });
    root.append(h('div', { class: 'panel', style: 'max-width:440px' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Change Password')),
      h('div', { class: 'panel-body' },
        session.user?.must_change_password ? h('div', { class: 'form-error' }, 'You must change your password before continuing.') : null,
        form.el,
        h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn primary', onclick: save }, 'Save ', h('kbd', null, 'F10'))))));
    form.focus();
  },
};
