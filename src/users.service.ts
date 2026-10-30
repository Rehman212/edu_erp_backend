import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { assertRoleAccess } from './role-access';

const ZONE_LABEL: Record<string, string> = {
  '1401': 'Shah Rukn-e-Alam (SRA)',
  '1402': 'Mumtazabad (MTZ)',
  '1403': 'Tariq Shabbir (TSC)',
};

@Injectable()
export class UsersService {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly database: DatabaseService) {}

  private ensureSchema() {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.database.query(
          `ALTER TABLE puser ADD COLUMN IF NOT EXISTS stat text`,
        );
        await this.database.query(
          `ALTER TABLE puser
             ADD COLUMN IF NOT EXISTS fname text,
             ADD COLUMN IF NOT EXISTS lname text,
             ADD COLUMN IF NOT EXISTS email text,
             ADD COLUMN IF NOT EXISTS mobile1 text,
             ADD COLUMN IF NOT EXISTS mobile2 text,
             ADD COLUMN IF NOT EXISTS landline text,
             ADD COLUMN IF NOT EXISTS address text,
             ADD COLUMN IF NOT EXISTS city text,
             ADD COLUMN IF NOT EXISTS gender text,
             ADD COLUMN IF NOT EXISTS about text`,
        );
        await this.database.query(
          `UPDATE puser
           SET stat = 'Active'
           WHERE coalesce(trim(stat), '') = ''`,
        );
        await this.database.query(
          `ALTER TABLE puser ADD COLUMN IF NOT EXISTS acct text`,
        );
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
          `UPDATE puser
           SET acct = 'User'
           WHERE coalesce(trim(acct), '') = ''`,
        );
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
      })().catch((err) => {
        this.schemaReady = null;
        throw err;
      });
    }
    return this.schemaReady;
  }

  private cleanText(raw: unknown, max = 200) {
    return String(raw ?? '')
      .trim()
      .slice(0, max);
  }

  private normalizeGender(raw: unknown) {
    const g = String(raw ?? '')
      .trim()
      .toUpperCase();
    if (!g) return '';
    if (g === 'MALE' || g === 'M') return 'Male';
    if (g === 'FEMALE' || g === 'F') return 'Female';
    return '';
  }

  private async zonePrefix(username: string) {
    const name = String(username || '').trim();
    if (!name) return '';
    const user = await this.database.query<{ desi: string | null }>(
      `SELECT desi FROM puser WHERE upper(trim(tname)) = upper($1) LIMIT 1`,
      [name],
    );
    const desi = user.rows[0]?.desi?.trim() ?? '';
    return desi.length >= 4 ? desi : '';
  }

  private zoneLabel(desi: string) {
    const d = String(desi || '').trim();
    if (!d || d === '14') return 'All zones';
    for (const code of ['1401', '1402', '1403'] as const) {
      if (d === code || d.startsWith(code)) return ZONE_LABEL[code];
    }
    return d;
  }

  private accountOf(username: string, acct: string) {
    const picked = String(acct || '').trim().toLowerCase();
    if (picked === 'admin') return 'Admin';
    if (picked === 'user') return 'User';
    const u = username.trim().toUpperCase();
    if (u === 'ESS_ADMN' || u === 'ESS') return 'Admin';
    return 'User';
  }

  private normalizeStatus(raw: unknown) {
    const s = String(raw ?? '')
      .trim()
      .toLowerCase();
    if (s === 'blocked' || s === 'block' || s === 'inactive') return 'Blocked';
    return 'Active';
  }

  private mapRow(r: {
    id: string;
    username: string;
    category: string;
    desi: string;
    campusName: string;
    status: string;
    menuCount: string;
    hasModify: string;
    acct?: string | null;
    roleId?: string | null;
    roleName?: string | null;
    fname?: string | null;
    lname?: string | null;
    email?: string | null;
    mobile1?: string | null;
    mobile2?: string | null;
    landline?: string | null;
    address?: string | null;
    city?: string | null;
    gender?: string | null;
    about?: string | null;
  }) {
    const menuCount = Number(r.menuCount) || 0;
    const desi = r.desi || '';
    const accountType = this.accountOf(r.username, r.acct || '');
    const status = this.normalizeStatus(r.status);
    const fname = (r.fname || '').trim();
    const lname = (r.lname || '').trim();
    const fullName = `${fname} ${lname}`.trim();
    const roleName = String(r.roleName ?? '').trim();
    const roleId = String(r.roleId ?? '').trim();
    return {
      id: r.id,
      username: r.username,
      fname,
      lname,
      fullName: fullName || r.username,
      email: (r.email || '').trim(),
      mobile1: (r.mobile1 || '').trim(),
      mobile2: (r.mobile2 || '').trim(),
      landline: (r.landline || '').trim(),
      address: (r.address || '').trim(),
      city: (r.city || '').trim(),
      gender: this.normalizeGender(r.gender),
      about: (r.about || '').trim(),
      category: r.category || '—',
      desi,
      zone: this.zoneLabel(desi),
      campus: r.campusName || this.zoneLabel(desi),
      menuCount,
      role: accountType,
      accountType,
      roleId,
      roleName,
      status,
    };
  }

  private profileFromBody(body: Record<string, string | undefined>) {
    return {
      fname: this.cleanText(body.fname ?? body.firstName, 80),
      lname: this.cleanText(body.lname ?? body.lastName, 80),
      email: this.cleanText(body.email, 120),
      mobile1: this.cleanText(body.mobile1, 30),
      mobile2: this.cleanText(body.mobile2, 30),
      landline: this.cleanText(body.landline, 30),
      address: this.cleanText(body.address, 250),
      city: this.cleanText(body.city, 80),
      gender: this.normalizeGender(body.gender),
      about: this.cleanText(body.about ?? body.bio, 1000),
    };
  }

  private listSelectSql() {
    return `SELECT u.row_id::text AS id,
              trim(u.tname) AS username,
              coalesce(trim(u.cata), '') AS category,
              coalesce(trim(u.desi), '') AS desi,
              coalesce(nullif(trim(a.ahead), ''), '') AS "campusName",
              coalesce(nullif(trim(u.stat), ''), 'Active') AS status,
              coalesce(trim(u.fname), '') AS fname,
              coalesce(trim(u.lname), '') AS lname,
              coalesce(trim(u.email), '') AS email,
              coalesce(trim(u.mobile1), '') AS mobile1,
              coalesce(trim(u.mobile2), '') AS mobile2,
              coalesce(trim(u.landline), '') AS landline,
              coalesce(trim(u.address), '') AS address,
              coalesce(trim(u.city), '') AS city,
              coalesce(trim(u.gender), '') AS gender,
              coalesce(trim(u.about), '') AS about,
              (
                CASE
                  WHEN er.id IS NOT NULL THEN (
                    SELECT count(*)::text
                    FROM jsonb_each(coalesce(er.rights, '{}'::jsonb)) AS node(k, v)
                    CROSS JOIN LATERAL jsonb_each(
                      CASE WHEN jsonb_typeof(node.v) = 'object' THEN node.v ELSE '{}'::jsonb END
                    ) AS flag(fk, fv)
                    WHERE flag.fv = 'true'::jsonb
                  )
                  ELSE (
                    SELECT count(*)::text
                    FROM cruser c
                    WHERE upper(trim(c.crname)) = upper(trim(u.tname))
                  )
                END
              ) AS "menuCount",
              (
                SELECT CASE
                  WHEN EXISTS (
                    SELECT 1 FROM cruser c
                    WHERE upper(trim(c.crname)) = upper(trim(u.tname))
                      AND upper(coalesce(c.mncode, '')) LIKE '%MODIFY%'
                  ) THEN '1' ELSE '0'
                END
              ) AS "hasModify",
              coalesce(nullif(trim(u.acct), ''), '') AS acct,
              coalesce(ur.role_id, '') AS "roleId",
              coalesce(er.name, '') AS "roleName"
       FROM puser u
       LEFT JOIN acc a ON trim(a.acode) = coalesce(trim(u.desi), '')
       LEFT JOIN erp_user_role ur ON upper(trim(ur.username)) = upper(trim(u.tname))
       LEFT JOIN erp_role er ON er.id = ur.role_id`;
  }

  private zoneCondSql(value: string, params: unknown[]) {
    const v = value.trim();
    const desi = `coalesce(trim(u.desi), '')`;
    if (v.toLowerCase() === 'all zones') return `(${desi} = '' OR ${desi} = '14')`;
    const code = Object.entries(ZONE_LABEL).find(
      ([, label]) => label.toLowerCase() === v.toLowerCase(),
    )?.[0];
    params.push(code ?? v);
    return code ? `${desi} LIKE $${params.length} || '%'` : `upper(${desi}) = upper($${params.length})`;
  }

  private colFilterSql(colFilters: Record<string, string>, params: unknown[]) {
    const where: string[] = [];
    const like = (expr: string, v: string) => {
      params.push(`%${v.trim()}%`);
      return `${expr} ILIKE $${params.length}`;
    };
    const isAdmin = `upper(coalesce(trim(u.acct), '')) = 'ADMIN'`;
    const isBlocked = `lower(coalesce(trim(u.stat), '')) IN ('blocked', 'block', 'inactive')`;

    for (const [key, raw] of Object.entries(colFilters)) {
      const v = String(raw ?? '').trim();
      if (!v) continue;
      switch (key) {
        case 'username': {
          params.push(`%${v}%`);
          const i = params.length;
          where.push(
            `(u.tname ILIKE $${i} OR coalesce(u.fname, '') ILIKE $${i} OR coalesce(u.lname, '') ILIKE $${i}
              OR (coalesce(trim(u.fname), '') || ' ' || coalesce(trim(u.lname), '')) ILIKE $${i}
              OR coalesce(u.email, '') ILIKE $${i})`,
          );
          break;
        }
        case 'city':
          where.push(like(`coalesce(u.city, '')`, v));
          break;
        case 'desi':
          where.push(like(`coalesce(u.desi, '')`, v));
          break;
        case 'role':
          if (v.toLowerCase() === 'admin') where.push(isAdmin);
          else if (v.toLowerCase() === 'user') where.push(`NOT ${isAdmin}`);
          else where.push(like(`coalesce(er.name, '')`, v));
          break;
        case 'status':
          if (v.toLowerCase() === 'blocked') where.push(isBlocked);
          else if (v.toLowerCase() === 'active') where.push(`NOT ${isBlocked}`);
          break;
        case 'zone':
          where.push(this.zoneCondSql(v, params));
          break;
        case 'campus': {
          params.push(v);
          const i = params.length;
          where.push(
            `(upper(coalesce(trim(a.ahead), '')) = upper($${i})
              OR (coalesce(trim(a.ahead), '') = '' AND ${this.zoneCondSql(v, params)}))`,
          );
          break;
        }
        case 'category':
          params.push(v);
          where.push(`upper(coalesce(trim(u.cata), '')) = upper($${params.length})`);
          break;
        case 'menuCount': {
          const n = Number(v.replace(/,/g, ''));
          if (!Number.isFinite(n)) break;
          params.push(n);
          where.push(
            `(
               CASE
                 WHEN er.id IS NOT NULL THEN (
                   SELECT count(*)
                   FROM jsonb_each(coalesce(er.rights, '{}'::jsonb)) AS node(k, v)
                   CROSS JOIN LATERAL jsonb_each(
                     CASE WHEN jsonb_typeof(node.v) = 'object' THEN node.v ELSE '{}'::jsonb END
                   ) AS flag(fk, fv)
                   WHERE flag.fv = 'true'::jsonb
                 )
                 ELSE (
                   SELECT count(*) FROM cruser c
                   WHERE upper(trim(c.crname)) = upper(trim(u.tname))
                 )
               END
             ) = $${params.length}`,
          );
          break;
        }
      }
    }
    return where;
  }

  async filterOptions(username: string) {
    await this.ensureSchema();
    const scope = await this.zonePrefix(username);
    const params: unknown[] = [];
    const where: string[] = [`coalesce(trim(u.tname), '') <> ''`];
    if (scope && scope.length > 2) {
      params.push(scope);
      where.push(
        `(coalesce(trim(u.desi), '') = '' OR coalesce(trim(u.desi), '') = '14' OR coalesce(trim(u.desi), '') LIKE $${params.length} || '%')`,
      );
    }
    const res = await this.database.query<{ city: string; category: string; desi: string; campus: string }>(
      `SELECT DISTINCT coalesce(trim(u.city), '') AS city,
              coalesce(trim(u.cata), '') AS category,
              coalesce(trim(u.desi), '') AS desi,
              coalesce(trim(a.ahead), '') AS campus
       FROM puser u
       LEFT JOIN acc a ON trim(a.acode) = coalesce(trim(u.desi), '')
       WHERE ${where.join(' AND ')}`,
      params,
    );
    const uniq = (vals: string[]) =>
      [...new Set(vals.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const zones = uniq(res.rows.map((r) => this.zoneLabel(r.desi)));
    return {
      cities: uniq(res.rows.map((r) => r.city)),
      categories: uniq(res.rows.map((r) => r.category)),
      zones,
      campuses: uniq(res.rows.map((r) => r.campus || this.zoneLabel(r.desi))),
    };
  }

  async list(
    username: string,
    q = '',
    page = 1,
    pageSize = 50,
    colFilters: Record<string, string> = {},
  ) {
    await this.ensureSchema();
    const scope = await this.zonePrefix(username);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    const params: unknown[] = [];
    const where: string[] = [`coalesce(trim(u.tname), '') <> ''`];

    if (scope && scope.length > 2) {
      params.push(scope);
      where.push(
        `(coalesce(trim(u.desi), '') = '' OR coalesce(trim(u.desi), '') = '14' OR coalesce(trim(u.desi), '') LIKE $${params.length} || '%')`,
      );
    }

    if (q.trim()) {
      params.push(`%${q.trim()}%`);
      const i = params.length;
      where.push(
        `(u.tname ILIKE $${i}
          OR coalesce(u.fname, '') ILIKE $${i}
          OR coalesce(u.lname, '') ILIKE $${i}
          OR coalesce(u.email, '') ILIKE $${i}
          OR coalesce(u.city, '') ILIKE $${i}
          OR coalesce(u.mobile1, '') ILIKE $${i}
          OR coalesce(u.desi, '') ILIKE $${i}
          OR coalesce(u.cata, '') ILIKE $${i}
          OR coalesce(u.stat, '') ILIKE $${i})`,
      );
    }

    const baseWhere = [...where];
    const baseParams = [...params];
    where.push(...this.colFilterSql(colFilters, params));

    const count = await this.database.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM puser u
       LEFT JOIN acc a ON trim(a.acode) = coalesce(trim(u.desi), '')
       LEFT JOIN erp_user_role ur ON upper(trim(ur.username)) = upper(trim(u.tname))
       LEFT JOIN erp_role er ON er.id = ur.role_id
       WHERE ${where.join(' AND ')}`,
      params,
    );

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const rows = await this.database.query<{
      id: string;
      username: string;
      category: string;
      desi: string;
      campusName: string;
      status: string;
      menuCount: string;
      hasModify: string;
    }>(
      `${this.listSelectSql()}
       WHERE ${where.join(' AND ')}
       ORDER BY upper(trim(u.tname))
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, size, offset],
    );

    const list = rows.rows.map((r) => this.mapRow(r));
    const total = Number(count.rows[0]?.total) || 0;

    const statsRows = await this.database.query<{
      total: string;
      admins: string;
      withMenus: string;
      active: string;
      blocked: string;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (
                WHERE upper(coalesce(trim(u.acct), '')) = 'ADMIN'
              )::text AS admins,
              count(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM cruser c
                  WHERE upper(trim(c.crname)) = upper(trim(u.tname))
                )
              )::text AS "withMenus",
              count(*) FILTER (
                WHERE upper(coalesce(nullif(trim(u.stat), ''), 'Active')) <> 'BLOCKED'
              )::text AS active,
              count(*) FILTER (
                WHERE upper(coalesce(trim(u.stat), '')) = 'BLOCKED'
              )::text AS blocked
       FROM puser u
       WHERE ${baseWhere.join(' AND ')}`,
      baseParams,
    );
    const s = statsRows.rows[0];

    return {
      rows: list,
      total,
      page: current,
      pageSize: size,
      stats: {
        total: Number(s?.total) || total,
        admins: Number(s?.admins) || 0,
        withMenus: Number(s?.withMenus) || 0,
        active: Number(s?.active) || 0,
        blocked: Number(s?.blocked) || 0,
      },
    };
  }

  private async saveUserRole(username: string, roleIdRaw: string | undefined) {
    if (roleIdRaw === undefined) return;
    const roleId = String(roleIdRaw).trim();
    await this.database.query(
      `DELETE FROM erp_user_role WHERE upper(trim(username)) = upper($1)`,
      [username],
    );
    if (!roleId) return;
    const found = await this.database.query<{ id: string }>(
      `SELECT id FROM erp_role WHERE id = $1 LIMIT 1`,
      [roleId],
    );
    if (!found.rows[0]) return;
    await this.database.query(
      `INSERT INTO erp_user_role (username, role_id) VALUES ($1, $2)
       ON CONFLICT (username) DO UPDATE SET role_id = excluded.role_id`,
      [username, found.rows[0].id],
    );
  }

  async create(actor: string, body: Record<string, string | undefined>) {
    await assertRoleAccess(this.database, actor, 'users', 'add');
    await this.ensureSchema();
    const username = String(body.username || body.tname || '').trim();
    const password = String(body.password || body.passwd || '').trim();
    const desi = String(body.desi || body.scope || '14').trim() || '14';
    const category = String(body.category || body.cata || '1').trim() || '1';
    const status = this.normalizeStatus(body.status);
    const accountType = this.accountOf(username, body.accountType || body.acct || '');
    const profile = this.profileFromBody(body);

    if (!username) return { ok: false, message: 'Username is required.' };
    if (!password) return { ok: false, message: 'Password is required.' };
    if (username.length > 40) return { ok: false, message: 'Username is too long.' };

    const exists = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM puser WHERE upper(trim(tname)) = upper($1)`,
      [username],
    );
    if (Number(exists.rows[0]?.n) > 0) {
      return { ok: false, message: 'Username already exists.' };
    }

    await this.database.query(
      `INSERT INTO puser (
         tname, passwd, cata, desi, stat, acct,
         fname, lname, email, mobile1, mobile2, landline,
         address, city, gender, about
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        username,
        password,
        category,
        desi,
        status,
        accountType,
        profile.fname,
        profile.lname,
        profile.email,
        profile.mobile1,
        profile.mobile2,
        profile.landline,
        profile.address,
        profile.city,
        profile.gender,
        profile.about,
      ],
    );
    await this.saveUserRole(username, body.roleId);

    const created = await this.database.query<{
      id: string;
      username: string;
      category: string;
      desi: string;
      campusName: string;
      status: string;
      menuCount: string;
      hasModify: string;
    }>(
      `${this.listSelectSql()}
       WHERE upper(trim(u.tname)) = upper($1)
       LIMIT 1`,
      [username],
    );

    return {
      ok: true,
      message: 'User created.',
      user: created.rows[0] ? this.mapRow(created.rows[0]) : null,
      actor: actor.trim(),
    };
  }

  async update(actor: string, idRaw: string, body: Record<string, string | undefined>) {
    await assertRoleAccess(this.database, actor, 'users', 'edit');
    await this.ensureSchema();
    const id = String(idRaw || '').trim();
    if (!id) return { ok: false, message: 'User id required.' };

    const current = await this.database.query<{
      tname: string;
      passwd: string | null;
    }>(
      `SELECT trim(tname) AS tname, passwd FROM puser WHERE row_id::text = $1 LIMIT 1`,
      [id],
    );
    const row = current.rows[0];
    if (!row?.tname) return { ok: false, message: 'User not found.' };

    const nextName = String(body.username || body.tname || row.tname).trim();
    if (!nextName) return { ok: false, message: 'Username is required.' };

    if (nextName.toUpperCase() !== row.tname.toUpperCase()) {
      const clash = await this.database.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM puser
         WHERE upper(trim(tname)) = upper($1)
           AND row_id::text <> $2`,
        [nextName, id],
      );
      if (Number(clash.rows[0]?.n) > 0) {
        return { ok: false, message: 'Username already exists.' };
      }
    }

    const password = String(body.password || body.passwd || '').trim();
    const desi =
      body.desi !== undefined || body.scope !== undefined
        ? String(body.desi || body.scope || '14').trim() || '14'
        : undefined;
    const category =
      body.category !== undefined || body.cata !== undefined
        ? String(body.category || body.cata || '1').trim() || '1'
        : undefined;
    const status =
      body.status !== undefined ? this.normalizeStatus(body.status) : undefined;
    const accountType =
      body.accountType !== undefined || body.acct !== undefined
        ? this.accountOf(nextName, body.accountType || body.acct || '')
        : undefined;
    const profile = this.profileFromBody(body);

    const self = actor.trim().toUpperCase() === row.tname.toUpperCase();
    if (status === 'Blocked' && self) {
      return { ok: false, message: 'You cannot block your own account.' };
    }
    if (self && (accountType !== undefined || body.roleId !== undefined)) {
      const mine = await this.database.query<{ acct: string; roleId: string }>(
        `SELECT coalesce(trim(u.acct), '') AS acct, coalesce(ur.role_id, '') AS "roleId"
         FROM puser u
         LEFT JOIN erp_user_role ur ON upper(trim(ur.username)) = upper(trim(u.tname))
         WHERE u.row_id::text = $1 LIMIT 1`,
        [id],
      );
      const now = mine.rows[0];
      const acctChanged =
        accountType !== undefined && accountType.toLowerCase() !== String(now?.acct || '').toLowerCase();
      const roleChanged =
        body.roleId !== undefined && String(body.roleId).trim() !== String(now?.roleId || '');
      if (acctChanged || roleChanged) {
        return { ok: false, message: 'You cannot change your own account type or user role.' };
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      params.push(value);
      sets.push(`${sql} = $${params.length}`);
    };

    push('tname', nextName);
    if (password) push('passwd', password);
    if (desi !== undefined) push('desi', desi);
    if (category !== undefined) push('cata', category);
    if (status !== undefined) push('stat', status);
    if (accountType !== undefined) push('acct', accountType);
    push('fname', profile.fname);
    push('lname', profile.lname);
    push('email', profile.email);
    push('mobile1', profile.mobile1);
    push('mobile2', profile.mobile2);
    push('landline', profile.landline);
    push('address', profile.address);
    push('city', profile.city);
    push('gender', profile.gender);
    push('about', profile.about);

    params.push(id);
    await this.database.query(
      `UPDATE puser SET ${sets.join(', ')} WHERE row_id::text = $${params.length}`,
      params,
    );

    if (nextName.toUpperCase() !== row.tname.toUpperCase()) {
      await this.database.query(
        `UPDATE cruser SET crname = $1 WHERE upper(trim(crname)) = upper($2)`,
        [nextName, row.tname],
      );
      await this.database.query(
        `UPDATE erp_user_role SET username = $1 WHERE upper(trim(username)) = upper($2)`,
        [nextName, row.tname],
      );
      await this.database.query(
        `UPDATE erp_session SET username = $1 WHERE upper(trim(username)) = upper($2)`,
        [nextName, row.tname],
      ).catch(() => undefined);
    }
    await this.saveUserRole(nextName, body.roleId);

    const updated = await this.database.query<{
      id: string;
      username: string;
      category: string;
      desi: string;
      campusName: string;
      status: string;
      menuCount: string;
      hasModify: string;
    }>(
      `${this.listSelectSql()}
       WHERE u.row_id::text = $1
       LIMIT 1`,
      [id],
    );

    return {
      ok: true,
      message: 'User updated.',
      user: updated.rows[0] ? this.mapRow(updated.rows[0]) : null,
    };
  }

  async setStatus(actor: string, idRaw: string, statusRaw: string) {
    return this.update(actor, idRaw, { status: statusRaw });
  }

  async getMe(usernameRaw: string) {
    await this.ensureSchema();
    const username = String(usernameRaw || '').trim();
    if (!username) return { ok: false, message: 'Not signed in.', user: null };
    const rows = await this.database.query<{
      id: string;
      username: string;
      category: string;
      desi: string;
      campusName: string;
      status: string;
      menuCount: string;
      hasModify: string;
      fname: string;
      lname: string;
      email: string;
      mobile1: string;
      mobile2: string;
      landline: string;
      address: string;
      city: string;
      gender: string;
      about: string;
    }>(
      `${this.listSelectSql()}
       WHERE upper(trim(u.tname)) = upper($1)
       LIMIT 1`,
      [username],
    );
    const row = rows.rows[0];
    if (!row) return { ok: false, message: 'User not found.', user: null };
    return { ok: true, user: this.mapRow(row) };
  }

  async updateMe(usernameRaw: string, body: Record<string, string | undefined>) {
    await this.ensureSchema();
    const username = String(usernameRaw || '').trim();
    if (!username) return { ok: false, message: 'Not signed in.' };

    const current = await this.database.query<{ id: string }>(
      `SELECT row_id::text AS id FROM puser WHERE upper(trim(tname)) = upper($1) LIMIT 1`,
      [username],
    );
    const id = current.rows[0]?.id;
    if (!id) return { ok: false, message: 'User not found.' };

    const profile = this.profileFromBody(body);
    await this.database.query(
      `UPDATE puser SET
         fname = $1, lname = $2, email = $3,
         mobile1 = $4, mobile2 = $5, landline = $6,
         address = $7, city = $8, gender = $9, about = $10
       WHERE row_id::text = $11`,
      [
        profile.fname,
        profile.lname,
        profile.email,
        profile.mobile1,
        profile.mobile2,
        profile.landline,
        profile.address,
        profile.city,
        profile.gender,
        profile.about,
        id,
      ],
    );

    const me = await this.getMe(username);
    return {
      ok: true,
      message: 'Profile saved.',
      user: me.user,
    };
  }

  async changePassword(
    usernameRaw: string,
    body: { currentPassword?: string; newPassword?: string },
  ) {
    await this.ensureSchema();
    const username = String(usernameRaw || '').trim();
    const currentPassword = String(body?.currentPassword || '').trim();
    const newPassword = String(body?.newPassword || '').trim();
    if (!username) return { ok: false, message: 'Not signed in.' };
    if (!currentPassword) return { ok: false, message: 'Current password is required.' };
    if (!newPassword) return { ok: false, message: 'New password is required.' };
    if (newPassword.length < 4) {
      return { ok: false, message: 'New password must be at least 4 characters.' };
    }

    const row = await this.database.query<{ passwd: string | null }>(
      `SELECT passwd FROM puser WHERE upper(trim(tname)) = upper($1) LIMIT 1`,
      [username],
    );
    if (!row.rows[0]) return { ok: false, message: 'User not found.' };
    const stored = String(row.rows[0].passwd ?? '').trim();
    if (stored !== currentPassword) {
      return { ok: false, message: 'Current password is incorrect.' };
    }

    await this.database.query(
      `UPDATE puser SET passwd = $1 WHERE upper(trim(tname)) = upper($2)`,
      [newPassword, username],
    );
    return { ok: true, message: 'Password changed successfully.' };
  }

  async remove(actor: string, idRaw: string) {
    await assertRoleAccess(this.database, actor, 'users', 'delete');
    await this.ensureSchema();
    const id = String(idRaw || '').trim();
    if (!id) return { ok: false, message: 'User id required.' };

    const current = await this.database.query<{ tname: string }>(
      `SELECT trim(tname) AS tname FROM puser WHERE row_id::text = $1 LIMIT 1`,
      [id],
    );
    const name = current.rows[0]?.tname?.trim() || '';
    if (!name) return { ok: false, message: 'User not found.' };

    if (actor.trim().toUpperCase() === name.toUpperCase()) {
      return { ok: false, message: 'You cannot delete your own account.' };
    }
    if (name.toUpperCase() === 'ESS_ADMN') {
      return { ok: false, message: 'ESS_ADMN cannot be deleted.' };
    }

    await this.database.query(
      `DELETE FROM cruser WHERE upper(trim(crname)) = upper($1)`,
      [name],
    );
    await this.database.query(`DELETE FROM puser WHERE row_id::text = $1`, [id]);

    return { ok: true, message: 'User deleted.' };
  }
}
