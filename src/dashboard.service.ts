import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

const NUM = (alias: string, col: string) =>
  `coalesce(nullif(regexp_replace(trim(${alias}.${col}), '[^0-9.\\-]', '', 'g'), ''), '0')::numeric`;

const PIPELINE_COLORS = ['#0d8a7c', '#111827', '#6b7280', '#0b7a6e'] as const;
const ACTIVITY_COLORS = ['#0d8a7c', '#111827', '#0b7a6e', '#6b7280', '#c2410c', '#1c3e72'] as const;

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function pctChange(curr: number, prev: number) {
  if (!Number.isFinite(curr)) curr = 0;
  if (!Number.isFinite(prev) || prev === 0) {
    if (curr === 0) return 0;
    return curr > 0 ? 100 : -100;
  }
  return round1(((curr - prev) / Math.abs(prev)) * 100);
}

function formatCompactRs(n: number) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `Rs ${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `Rs ${(v / 1_000).toFixed(0)}K`;
  return `Rs ${Math.round(v).toLocaleString('en-PK')}`;
}

function formatPct(n: number) {
  const v = round1(Number(n) || 0);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v}%`;
}

function monthLabel(ym: string) {
  const m = String(ym || '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) return m || '—';
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1);
  return d.toLocaleDateString('en-GB', { month: 'short' });
}

function monthLabelFull(ym: string) {
  const m = String(ym || '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) return m || '—';
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1);
  return d.toLocaleDateString('en-GB', { month: 'long' });
}

function initialsOf(name: string) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

function colorFor(key: string) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ACTIVITY_COLORS[h % ACTIVITY_COLORS.length];
}

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

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

  private async siteScope(username: string, site: string) {
    const zone = await this.zonePrefix(username);
    let code = String(site || '').trim();
    if (!code) code = zone || '';
    if (zone && code && !(code === zone || code.startsWith(zone))) return zone;
    return code;
  }

  private async tableExists(name: string) {
    const r = await this.database.query<{ ok: number }>(
      `SELECT 1 AS ok
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
       LIMIT 1`,
      [name],
    );
    return Boolean(r.rows[0]);
  }

  async summary(username: string, site = '') {
    const scope = await this.siteScope(username, site);
    const [students, staff, campuses, classes, feeMonths, admitMonths, pipeline, activity] =
      await Promise.all([
        this.studentKpis(scope),
        this.staffKpis(scope),
        this.campusCount(scope),
        this.classCount(scope),
        this.feeCollectionMonths(scope, 7),
        this.admissionsByMonth(scope, 7),
        this.studentPipeline(scope),
        this.recentActivity(scope, 8),
      ]);

    const feeLast6 = feeMonths.slice(-6);
    const feeYtd = feeLast6.reduce((s, r) => s + r.collectedRaw, 0);
    const feeSeries = feeLast6.map((r) => ({
      name: monthLabel(r.ym),
      ym: r.ym,
      collected: round2(r.collectedRaw / 1_000_000),
      collectedRaw: r.collectedRaw,
    }));

    const monthFee = feeMonths[feeMonths.length - 1]?.collectedRaw || 0;
    const prevFee = feeMonths[feeMonths.length - 2]?.collectedRaw || 0;
    const feeChange = pctChange(monthFee, prevFee);

    const monthAdmits = admitMonths[admitMonths.length - 1]?.count || 0;
    const prevAdmits = admitMonths[admitMonths.length - 2]?.count || 0;
    const admitChange = pctChange(monthAdmits, prevAdmits);

    // Left chart: new admissions by month (no student attendance in DB).
    const admissionsTrend = admitMonths.slice(-6).map((r) => ({
      name: monthLabel(r.ym),
      admits: r.count,
    }));
    const admitsTotal = admissionsTrend.reduce((s, r) => s + r.admits, 0);

    const maxFee = Math.max(...feeMonths.map((r) => r.collectedRaw), 1);
    const maxAdmits = Math.max(...admitMonths.map((r) => r.count), 1);
    const campusTrend = feeMonths.map((r, i) => {
      const admits = admitMonths[i]?.count || 0;
      return {
        name: monthLabelFull(r.ym),
        feeIndex: Math.round((100 * r.collectedRaw) / maxFee),
        admitIndex: Math.round((100 * admits) / maxAdmits),
      };
    });

    return {
      site: scope,
      kpis: {
        students: {
          value: students.current.toLocaleString('en-PK'),
          raw: students.current,
          change: formatPct(students.change),
          trend: students.change >= 0 ? 'up' : 'down',
          hintKey: 'vsLastMonth',
        },
        staff: {
          value: staff.current.toLocaleString('en-PK'),
          raw: staff.current,
          change: formatPct(staff.change),
          trend: staff.change >= 0 ? 'up' : 'down',
          hintKey: 'vsLastMonth',
        },
        monthCollection: {
          value: formatCompactRs(monthFee),
          raw: monthFee,
          change: formatPct(feeChange),
          trend: feeChange >= 0 ? 'up' : 'down',
          hintKey: 'vsLastMonth',
        },
        newAdmissions: {
          value: monthAdmits.toLocaleString('en-PK'),
          raw: monthAdmits,
          change: formatPct(admitChange),
          trend: admitChange >= 0 ? 'up' : 'down',
          hintKey: 'vsLastMonth',
        },
        campuses: {
          value: String(campuses),
          raw: campuses,
          change: '+0%',
          trend: 'up' as const,
          hintKey: 'noChange',
        },
        classes: {
          value: String(classes.current),
          raw: classes.current,
          change: formatPct(classes.change),
          trend: classes.change >= 0 ? 'up' : 'down',
          hintKey: 'vsLastTerm',
        },
      },
      admissionsTrend,
      admitsTotal,
      feeCollection: feeSeries,
      feeYtd: formatCompactRs(feeYtd),
      feeYtdRaw: feeYtd,
      pipeline,
      pipelineTotal: pipeline.reduce((s, p) => s + p.value, 0),
      activity,
      campusTrend,
    };
  }

  private async studentKpis(scope: string) {
    const rows = await this.database.query<{ curr: string; prev: string }>(
      `SELECT
         count(*) FILTER (
           WHERE upper(trim(coalesce(stat, ''))) = 'ACTIVE'
         )::text AS curr,
         count(*) FILTER (
           WHERE upper(trim(coalesce(stat, ''))) = 'ACTIVE'
             AND coalesce(nullif(left(trim(adate::text), 10), ''), '9999-99-99') <
                 to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD')
         )::text AS prev
       FROM student
       WHERE ($1 = '' OR trim(ccode) LIKE $1 || '%')`,
      [scope],
    );
    const current = Number(rows.rows[0]?.curr) || 0;
    const prev = Number(rows.rows[0]?.prev) || 0;
    // prev ≈ active students who were already on roll before this month (proxy MoM).
    return { current, change: pctChange(current, prev || current) };
  }

  private async staffKpis(scope: string) {
    if (!(await this.tableExists('persona'))) return { current: 0, change: 0 };
    const rows = await this.database.query<{ curr: string; prev: string }>(
      `SELECT
         count(*) FILTER (WHERE upper(trim(coalesce(sta, ''))) = 'A')::text AS curr,
         count(*) FILTER (
           WHERE upper(trim(coalesce(sta, ''))) = 'A'
             AND (
               coalesce(nullif(left(trim(jdate::text), 10), ''), '9999-99-99') <
               to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD')
             )
         )::text AS prev
       FROM persona
       WHERE ($1 = '' OR trim(zcode) LIKE $1 || '%' OR trim(zcode) = left($1, 4))`,
      [scope],
    );
    const current = Number(rows.rows[0]?.curr) || 0;
    const prev = Number(rows.rows[0]?.prev) || 0;
    return { current, change: pctChange(current, prev || current) };
  }

  private async campusCount(scope: string) {
    const rows = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM acc
       WHERE trim(acode) ~ '^14(01|02|03)01[0-9]{4}$'
         AND ($1 = '' OR trim(acode) LIKE $1 || '%' OR trim(acode) = $1)`,
      [scope],
    );
    return Number(rows.rows[0]?.n) || 0;
  }

  private async classCount(scope: string) {
    const rows = await this.database.query<{ curr: string; prev: string }>(
      `SELECT
         count(DISTINCT nullif(trim(class), ''))
           FILTER (WHERE upper(trim(coalesce(stat, ''))) = 'ACTIVE')::text AS curr,
         count(DISTINCT nullif(trim(class), ''))
           FILTER (
             WHERE upper(trim(coalesce(stat, ''))) = 'ACTIVE'
               AND coalesce(nullif(left(trim(adate::text), 10), ''), '9999-99-99') <
                   to_char(date_trunc('month', CURRENT_DATE) - interval '3 months', 'YYYY-MM-DD')
           )::text AS prev
       FROM student
       WHERE ($1 = '' OR trim(ccode) LIKE $1 || '%')`,
      [scope],
    );
    const current = Number(rows.rows[0]?.curr) || 0;
    const prev = Number(rows.rows[0]?.prev) || 0;
    return { current, change: pctChange(current, prev || current) };
  }

  private async admissionsByMonth(scope: string, months: number) {
    const back = Math.max(months - 1, 0);
    const rows = await this.database.query<{ ym: string; n: string }>(
      `SELECT to_char(left(trim(adate::text), 10)::date, 'YYYY-MM') AS ym,
              count(*)::text AS n
       FROM student
       WHERE coalesce(nullif(left(trim(adate::text), 10), ''), '') ~ '^\\d{4}-\\d{2}-\\d{2}'
         AND left(trim(adate::text), 10)::date >=
             (date_trunc('month', CURRENT_DATE) - make_interval(months => $2))::date
         AND ($1 = '' OR trim(ccode) LIKE $1 || '%')
       GROUP BY 1
       ORDER BY 1`,
      [scope, back],
    );
    const map = new Map(rows.rows.map((r) => [r.ym, Number(r.n) || 0]));
    const out: Array<{ ym: string; count: number }> = [];
    const start = new Date();
    start.setDate(1);
    start.setMonth(start.getMonth() - (months - 1));
    for (let i = 0; i < months; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      out.push({ ym, count: map.get(ym) || 0 });
    }
    return out;
  }

  private async feeCollectionMonths(scope: string, months: number) {
    const back = Math.max(months - 1, 0);
    const rows = await this.database.query<{ ym: string; amt: string }>(
      `SELECT to_char(m.invdate::date, 'YYYY-MM') AS ym,
              coalesce(sum(${NUM('d', 'dr')}), 0)::text AS amt
       FROM accmast m
       JOIN accdet d ON trim(d.invno) = trim(m.invno)
       WHERE right(trim(m.invno), 1) = 'F'
         AND m.invdate::date >= (date_trunc('month', CURRENT_DATE) - make_interval(months => $2))::date
         AND ($1 = '' OR trim(m.ccode) LIKE $1 || '%')
       GROUP BY 1
       ORDER BY 1`,
      [scope, back],
    );
    const map = new Map(rows.rows.map((r) => [r.ym, Number(r.amt) || 0]));
    const out: Array<{ ym: string; collectedRaw: number }> = [];
    const start = new Date();
    start.setDate(1);
    start.setMonth(start.getMonth() - (months - 1));
    for (let i = 0; i < months; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      out.push({ ym, collectedRaw: map.get(ym) || 0 });
    }
    return out;
  }

  private async studentPipeline(scope: string) {
    // No Inquiry/Test/Offer CRM tables — use live student status breakdown (same donut UI).
    const rows = await this.database.query<{
      active: string;
      left: string;
      passout: string;
      transferred: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE upper(trim(coalesce(stat, ''))) = 'ACTIVE')::text AS active,
         count(*) FILTER (WHERE upper(trim(coalesce(stat, ''))) = 'LEFT')::text AS left,
         count(*) FILTER (WHERE upper(trim(coalesce(stat, ''))) LIKE 'PASSOUT%')::text AS passout,
         count(*) FILTER (WHERE upper(trim(coalesce(stat, ''))) LIKE 'TRANSFER%')::text AS transferred
       FROM student
       WHERE ($1 = '' OR trim(ccode) LIKE $1 || '%')`,
      [scope],
    );
    const r = rows.rows[0];
    const items = [
      { name: 'Active', value: Number(r?.active) || 0 },
      { name: 'Left', value: Number(r?.left) || 0 },
      { name: 'Passout', value: Number(r?.passout) || 0 },
      { name: 'Transfer', value: Number(r?.transferred) || 0 },
    ];
    return items.map((item, i) => ({
      ...item,
      color: PIPELINE_COLORS[i % PIPELINE_COLORS.length],
    }));
  }

  private async recentActivity(scope: string, limit: number) {
    if (!(await this.tableExists('erp_audit_log'))) return [];
    const rows = await this.database.query<{
      username: string;
      role: string;
      activity: string;
      description: string;
      module: string;
      created_at: Date;
    }>(
      `SELECT
         coalesce(nullif(trim(username), ''), 'Unknown') AS username,
         coalesce(trim(role), '') AS role,
         coalesce(trim(activity), '') AS activity,
         coalesce(trim(description), '') AS description,
         coalesce(nullif(trim(module), ''), 'General') AS module,
         created_at
       FROM erp_audit_log
       WHERE category = 'activity'
         AND (
           $1 = ''
           OR coalesce(trim(campus_code), '') LIKE $1 || '%'
           OR coalesce(trim(campus_code), '') = left($1, 4)
         )
       ORDER BY created_at DESC
       LIMIT $2`,
      [scope, limit],
    );

    return rows.rows.map((r) => {
      const when = new Date(r.created_at);
      const hh = String(when.getHours()).padStart(2, '0');
      const mm = String(when.getMinutes()).padStart(2, '0');
      return {
        time: `${hh}:${mm}`,
        type: r.module || 'General',
        user: r.username,
        role: r.role || 'User',
        initials: initialsOf(r.username),
        action: r.activity || 'Activity',
        detail: r.description || r.activity || '',
        color: colorFor(r.module || r.activity),
      };
    });
  }
}
