/** Logged-in user, permissions and app info shared by all views. */
export const session = {
  user: null,
  permissions: [],
  app: { name: '', whatsapp: '', currency: 'PKR' },
  needsSetup: false,
  setupKeyRequired: false,
};

export function setUser(user, permissions = []) {
  session.user = user || null;
  session.permissions = Array.isArray(permissions) ? permissions : [];
}

export function clearUser() {
  session.user = null;
  session.permissions = [];
}

/** True if the user has ANY of the given permission codes (Admin has all). */
export function can(perms) {
  if (!session.user) return false;
  if (session.user.role_code === 'admin') return true;
  return [].concat(perms).some((p) => session.permissions.includes(p));
}
