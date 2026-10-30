import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ActivityLogService } from './activity-log.service';
import { DatabaseService } from './database.service';

type UserRow = {
  tname: string;
  cata: string | null;
  desi: string | null;
  passwd: string | null;
  stat: string | null;
  acct: string | null;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async login(username: string, password: string, ipAddress = '') {
    const name = username.trim();
    const secret = password.trim();
    if (!name || !secret) {
      throw new UnauthorizedException('Username and password are required');
    }

    await this.database.query(
      `ALTER TABLE puser ADD COLUMN IF NOT EXISTS stat text`,
    );
    await this.database.query(
      `ALTER TABLE puser ADD COLUMN IF NOT EXISTS acct text`,
    );
    await this.database.query(`ALTER TABLE puser ADD COLUMN IF NOT EXISTS fname text`);
    await this.database.query(`ALTER TABLE puser ADD COLUMN IF NOT EXISTS lname text`);
    await this.database.query(
      `UPDATE puser
       SET acct = 'Admin'
       WHERE coalesce(trim(acct), '') = ''
         AND (
           upper(trim(tname)) IN ('ESS_ADMN', 'ESS')
           OR upper(trim(tname)) LIKE '%HAMZA%'
           OR upper(trim(tname)) LIKE '%HUMZA%'
           OR upper(coalesce(fname, '')) LIKE '%HAMZA%'
           OR upper(coalesce(fname, '')) LIKE '%HUMZA%'
           OR upper(coalesce(lname, '')) LIKE '%HAMZA%'
           OR upper(coalesce(lname, '')) LIKE '%HUMZA%'
         )`,
    );
    await this.database.query(
      `UPDATE puser SET acct = 'User' WHERE coalesce(trim(acct), '') = ''`,
    );

    const user = await this.database.query<UserRow>(
      `SELECT tname, cata, desi, passwd,
              coalesce(nullif(trim(stat), ''), 'Active') AS stat,
              coalesce(nullif(trim(acct), ''), 'User') AS acct
       FROM puser
       WHERE upper(trim(tname)) = upper($1)
       LIMIT 1`,
      [name],
    );
    const row = user.rows[0];
    const stored = row?.passwd?.trim() ?? '';
    if (!row || !stored || stored !== secret) {
      await this.activityLog.write({
        category: 'auth',
        username: name || 'Unknown',
        activity: 'Login',
        description: 'Failed sign-in attempt',
        module: 'Auth',
        status: 'Failed',
        ipAddress,
      });
      throw new UnauthorizedException('Wrong username or password');
    }
    if (String(row.stat || '').trim().toLowerCase() === 'blocked') {
      await this.activityLog.write({
        category: 'auth',
        username: name || 'Unknown',
        activity: 'Login',
        description: 'Blocked account sign-in attempt',
        module: 'Auth',
        status: 'Failed',
        ipAddress,
      });
      throw new UnauthorizedException('Account is blocked. Contact administrator.');
    }

    await this.database.query(
      `CREATE TABLE IF NOT EXISTS erp_role (
         id text PRIMARY KEY,
         name text NOT NULL,
         rights jsonb NOT NULL DEFAULT '{}'::jsonb,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS erp_user_role (
         username text PRIMARY KEY,
         role_id text NOT NULL
       )`,
    );
    const assigned = await this.database.query<{ name: string; rights: Record<string, { view?: boolean }> }>(
      `SELECT r.name, r.rights
       FROM erp_user_role u
       JOIN erp_role r ON r.id = u.role_id
       WHERE upper(trim(u.username)) = upper($1)
       LIMIT 1`,
      [row.tname],
    );
    const assignedRole = assigned.rows[0]?.name?.trim() || '';
    const roleRights = assigned.rows[0]?.rights ?? null;

    const rights = await this.database.query<{ mncode: string }>(
      `SELECT mncode FROM cruser WHERE upper(trim(crname)) = upper($1)`,
      [row.tname],
    );
    const menus = [
      ...new Set(
        rights.rows
          .map((item) => item.mncode?.trim())
          .filter((code): code is string => Boolean(code)),
      ),
    ];
    const loginName = row.tname.trim();
    const desi = row.desi?.trim() ?? '';
    const role = String(row.acct || '').trim().toLowerCase() === 'admin' ? 'Admin' : 'User';
    const canEdit = role === 'Admin';
    const zone = zoneName(desi);

    await this.activityLog.write({
      category: 'auth',
      username: loginName,
      role,
      activity: 'Login',
      description: `Signed in to The Educators ERP (${zone})`,
      module: 'Auth',
      campus: zone,
      campusCode: desi,
      status: 'Success',
      ipAddress,
    });

    return {
      username: loginName,
      cata: row.cata?.trim() ?? null,
      desi,
      zone,
      role,
      canEdit,
      menus,
      assignedRole,
      roleRights,
    };
  }

  async logout(
    username: string,
    role = '',
    campus = '',
    campusCode = '',
    ipAddress = '',
  ) {
    const name = username.trim();
    if (!name) return { ok: false, message: 'Username required' };
    await this.activityLog.write({
      category: 'auth',
      username: name,
      role,
      activity: 'Logout',
      description: 'Signed out of The Educators ERP',
      module: 'Auth',
      campus,
      campusCode,
      status: 'Success',
      ipAddress,
    });
    return { ok: true };
  }
}

function zoneName(desi: string) {
  if (desi.startsWith('1403')) return 'Tariq Shabbir';
  if (desi.startsWith('1402')) return 'Mumtazabad';
  if (desi.startsWith('1401')) return 'Shah Rukn-e-Alam';
  return 'All zones';
}
