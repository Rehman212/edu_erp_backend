import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from './database.service';

export type AuditCategory = 'activity' | 'auth';

export type WriteAuditInput = {
  category?: AuditCategory;
  username: string;
  role?: string;
  activity: string;
  description?: string;
  module?: string;
  campus?: string;
  campusCode?: string;
  status?: 'Success' | 'Failed';
  ipAddress?: string;
  meta?: Record<string, unknown>;
};

@Injectable()
export class ActivityLogService implements OnModuleInit {
  private ready = false;

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit() {
    await this.ensureTable();
  }

  async ensureTable() {
    if (this.ready) return;
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS erp_audit_log (
        id              bigserial PRIMARY KEY,
        category        text NOT NULL DEFAULT 'activity',
        username        text NOT NULL DEFAULT '',
        role            text NOT NULL DEFAULT '',
        activity        text NOT NULL DEFAULT '',
        description     text NOT NULL DEFAULT '',
        module          text NOT NULL DEFAULT '',
        campus          text NOT NULL DEFAULT '',
        campus_code     text NOT NULL DEFAULT '',
        status          text NOT NULL DEFAULT 'Success',
        ip_address      text NOT NULL DEFAULT '',
        meta            jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.database.query(`
      CREATE INDEX IF NOT EXISTS idx_erp_audit_log_created
        ON erp_audit_log (created_at DESC)
    `);
    await this.database.query(`
      CREATE INDEX IF NOT EXISTS idx_erp_audit_log_category_created
        ON erp_audit_log (category, created_at DESC)
    `);
    this.ready = true;
  }

  async write(input: WriteAuditInput) {
    await this.ensureTable();
    const category = input.category === 'auth' ? 'auth' : 'activity';
    const status = input.status === 'Failed' ? 'Failed' : 'Success';
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO erp_audit_log (
         category, username, role, activity, description, module,
         campus, campus_code, status, ip_address, meta
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING id::text`,
      [
        category,
        String(input.username ?? '').trim() || 'Unknown',
        String(input.role ?? '').trim(),
        String(input.activity ?? '').trim() || 'Event',
        String(input.description ?? '').trim(),
        String(input.module ?? '').trim(),
        String(input.campus ?? '').trim(),
        String(input.campusCode ?? '').trim(),
        status,
        String(input.ipAddress ?? '').trim(),
        JSON.stringify(input.meta ?? {}),
      ],
    );
    return { ok: true, id: result.rows[0]?.id };
  }

  async list(opts: {
    category: AuditCategory;
    q?: string;
    user?: string;
    activity?: string;
    module?: string;
    status?: string;
    fromDate?: string;
    toDate?: string;
    page?: number;
    pageSize?: number;
  }) {
    await this.ensureTable();
    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.min(Math.max(Number(opts.pageSize) || 50, 1), 5000);
    const offset = (page - 1) * pageSize;
    const q = String(opts.q ?? '').trim();
    const user = String(opts.user ?? '').trim();
    const activity = String(opts.activity ?? '').trim();
    const module = String(opts.module ?? '').trim();
    const status = String(opts.status ?? '').trim();
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.fromDate ?? '').trim())
      ? String(opts.fromDate).trim()
      : '';
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.toDate ?? '').trim())
      ? String(opts.toDate).trim()
      : '';

    const params: unknown[] = [opts.category];
    const where: string[] = [`category = $1`];

    if (user) {
      params.push(user);
      where.push(`trim(username) = $${params.length}`);
    }
    if (activity) {
      params.push(activity);
      where.push(`trim(activity) = $${params.length}`);
    }
    if (module) {
      params.push(module);
      where.push(`trim(module) = $${params.length}`);
    }
    if (status === 'Success' || status === 'Failed' || status === 'ok' || status === 'failed') {
      params.push(status === 'ok' ? 'Success' : status === 'failed' ? 'Failed' : status);
      where.push(`status = $${params.length}`);
    }
    if (fromDate) {
      params.push(fromDate);
      where.push(`created_at::date >= $${params.length}::date`);
    }
    if (toDate) {
      params.push(toDate);
      where.push(`created_at::date <= $${params.length}::date`);
    }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(
        `(username ILIKE $${i} OR activity ILIKE $${i} OR description ILIKE $${i} OR module ILIKE $${i} OR campus ILIKE $${i} OR campus_code ILIKE $${i})`,
      );
    }

    const whereSql = where.join(' AND ');
    const stats = await this.database.query<{
      total: string;
      logins: string;
      logouts: string;
      failed: string;
      ok: string;
      users: string;
      modules: string;
      today: string;
    }>(
      `SELECT
         count(*)::text AS total,
         count(*) FILTER (
           WHERE lower(trim(activity)) = 'login' AND status = 'Success'
         )::text AS logins,
         count(*) FILTER (
           WHERE lower(trim(activity)) = 'logout' AND status = 'Success'
         )::text AS logouts,
         count(*) FILTER (WHERE status = 'Failed')::text AS failed,
         count(*) FILTER (WHERE status = 'Success')::text AS ok,
         count(DISTINCT NULLIF(trim(username), ''))::text AS users,
         count(DISTINCT NULLIF(trim(module), ''))::text AS modules,
         count(*) FILTER (
           WHERE (created_at AT TIME ZONE 'Asia/Karachi')::date
             = (now() AT TIME ZONE 'Asia/Karachi')::date
         )::text AS today
       FROM erp_audit_log
       WHERE ${whereSql}`,
      params,
    );

    params.push(pageSize, offset);
    const rows = await this.database.query<{
      id: string;
      username: string;
      role: string;
      activity: string;
      description: string;
      module: string;
      campus: string;
      campusCode: string;
      status: string;
      ipAddress: string;
      createdAt: string;
    }>(
      `SELECT id::text AS id,
              username,
              role,
              activity,
              description,
              module,
              campus,
              campus_code AS "campusCode",
              status,
              ip_address AS "ipAddress",
              to_char(created_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt"
       FROM erp_audit_log
       WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: rows.rows.map((row) => ({
        id: Number(row.id),
        user: row.username,
        role: row.role || '—',
        initials: initialsOf(row.username),
        activity: row.activity,
        description: row.description,
        module: row.module || '—',
        campus: row.campus || '—',
        campusCode: row.campusCode || '',
        status: row.status === 'Failed' ? 'Failed' : 'Success',
        ipAddress: row.ipAddress || '',
        createdAt: row.createdAt,
        time: formatTime(row.createdAt),
        date: formatDate(row.createdAt),
        dateKey: String(row.createdAt || '').slice(0, 10),
        today: isTodayPk(row.createdAt),
      })),
      total: Number(stats.rows[0]?.total ?? 0),
      page,
      pageSize,
      stats: {
        total: Number(stats.rows[0]?.total ?? 0),
        logins: Number(stats.rows[0]?.logins ?? 0),
        logouts: Number(stats.rows[0]?.logouts ?? 0),
        failed: Number(stats.rows[0]?.failed ?? 0),
        ok: Number(stats.rows[0]?.ok ?? 0),
        users: Number(stats.rows[0]?.users ?? 0),
        modules: Number(stats.rows[0]?.modules ?? 0),
        today: Number(stats.rows[0]?.today ?? 0),
      },
    };
  }

  async filterOptions(category: AuditCategory) {
    await this.ensureTable();
    const users = await this.database.query<{ name: string }>(
      `SELECT DISTINCT trim(username) AS name
       FROM erp_audit_log
       WHERE category = $1 AND trim(username) <> ''
       ORDER BY 1`,
      [category],
    );
    const activities = await this.database.query<{ name: string }>(
      `SELECT DISTINCT trim(activity) AS name
       FROM erp_audit_log
       WHERE category = $1 AND trim(activity) <> ''
       ORDER BY 1`,
      [category],
    );
    const modules = await this.database.query<{ name: string }>(
      `SELECT DISTINCT trim(module) AS name
       FROM erp_audit_log
       WHERE category = $1 AND trim(module) <> ''
       ORDER BY 1`,
      [category],
    );
    return {
      users: users.rows.map((r) => r.name),
      activities: activities.rows.map((r) => r.name),
      modules: modules.rows.map((r) => r.name),
    };
  }
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

function formatTime(isoLocal: string) {
  const m = isoLocal.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return isoLocal;
  let h = Number(m[1]);
  const min = m[2];
  const sec = m[3];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${min}:${sec} ${ampm}`;
}

function formatDate(isoLocal: string) {
  const day = isoLocal.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return isoLocal;
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function isTodayPk(isoLocal: string) {
  const day = isoLocal.slice(0, 10);
  const now = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
  return day === now;
}
