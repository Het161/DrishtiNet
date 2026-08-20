/**
 * Roles and permissions.
 *
 * Modelled on how a state control room actually splits duties: an Auditor must be able to read the
 * full audit trail without being able to touch a watchlist, and a Control Room Operator must be
 * able to triage alerts without being able to export evidence (which is an Investigator's act and
 * carries chain-of-custody consequences).
 */

export const ROLES = [
  'state_admin',
  'department_admin',
  'control_room_operator',
  'investigator',
  'auditor',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, { en: string; gu: string }> = {
  state_admin: { en: 'State Administrator', gu: 'રાજ્ય પ્રશાસક' },
  department_admin: { en: 'Department Administrator', gu: 'વિભાગ પ્રશાસક' },
  control_room_operator: { en: 'Control Room Operator', gu: 'કંટ્રોલ રૂમ ઓપરેટર' },
  investigator: { en: 'Investigator', gu: 'તપાસ અધિકારી' },
  auditor: { en: 'Auditor', gu: 'ઓડિટર' },
};

export const PERMISSIONS = [
  'camera:read', 'camera:write', 'camera:delete',
  'department:read', 'department:write',
  'stream:view',
  'watchlist:read', 'watchlist:write',
  'alert:read', 'alert:acknowledge', 'alert:escalate', 'alert:resolve',
  'evidence:read', 'evidence:export',
  'user:read', 'user:write',
  'audit:read',
  'integration:query',
  'analytics:control',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  state_admin: PERMISSIONS,

  department_admin: [
    'camera:read', 'camera:write',
    'department:read',
    'stream:view',
    'watchlist:read', 'watchlist:write',
    'alert:read', 'alert:acknowledge', 'alert:escalate', 'alert:resolve',
    'evidence:read',
    'user:read',
    'audit:read',
    'integration:query',
  ],

  control_room_operator: [
    'camera:read',
    'department:read',
    'stream:view',
    'watchlist:read',
    'alert:read', 'alert:acknowledge', 'alert:escalate',
    'evidence:read',
  ],

  // Exports evidence and therefore signs the chain of custody; cannot alter the camera registry.
  investigator: [
    'camera:read',
    'department:read',
    'stream:view',
    'watchlist:read', 'watchlist:write',
    'alert:read', 'alert:acknowledge', 'alert:escalate', 'alert:resolve',
    'evidence:read', 'evidence:export',
    'integration:query',
  ],

  // Read-only by construction. An auditor who can mutate is not an auditor.
  auditor: [
    'camera:read',
    'department:read',
    'watchlist:read',
    'alert:read',
    'evidence:read',
    'user:read',
    'audit:read',
  ],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function canAll(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}

/** Department scoping: a department admin only sees their own department's cameras. */
export function isStateWide(role: Role): boolean {
  return role === 'state_admin' || role === 'auditor';
}
