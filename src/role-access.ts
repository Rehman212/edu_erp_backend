import { ForbiddenException } from '@nestjs/common';
import { DatabaseService } from './database.service';

export type RoleFlag = 'view' | 'add' | 'edit' | 'delete' | 'voucher';

type Rights = Record<string, Partial<Record<RoleFlag, boolean>>>;

/**
 * Users with no ERP role keep the old full access.
 * A user who has a role may only do flags that role turned on.
 * Any one of the given menus is enough (registration and payroll share employee save).
 */
export async function assertRoleAccess(
  database: DatabaseService,
  username: string,
  nodeIds: string | string[],
  flag: RoleFlag | RoleFlag[],
): Promise<void> {
  const name = String(username ?? '').trim();
  if (!name) throw new ForbiddenException('Not signed in.');

  let rights: Rights | null | undefined;
  try {
    const found = await database.query<{ rights: Rights | null }>(
      `SELECT er.rights
       FROM erp_user_role ur
       JOIN erp_role er ON er.id = ur.role_id
       WHERE upper(trim(ur.username)) = upper(trim($1))
       LIMIT 1`,
      [name],
    );
    if (!found.rows[0]) return;
    rights = found.rows[0].rights;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === '42P01') return;
    throw err;
  }

  const nodes = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
  const flags = Array.isArray(flag) ? flag : [flag];
  const allowed = nodes.some((id) => flags.some((one) => rights?.[id]?.[one] === true));
  if (!allowed) throw new ForbiddenException('You do not have this permission.');
}
