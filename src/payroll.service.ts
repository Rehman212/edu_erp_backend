import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function moneyNum(raw: unknown) {
  const n = Number(String(raw ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Upper bound for one report fetch; column-filtered reports load everything once. */
const PAGE_MAX = 10000;

type PayrollPage = {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  totalAmount?: number;
};

const PAYROLL_NUM_COLS = new Set([
  'credit',
  'amount',
  'sick',
  'casu',
  'leaveDays',
  'balance',
  'basic',
  'allowances',
  'deductions',
  'net',
  'employees',
  'present',
  'absent',
  'leave',
  'shortLeave',
]);
const PAYROLL_EXACT_COLS = new Set(['zone', 'designation', 'type', 'status']);

function payrollCell(row: Record<string, unknown>, key: string) {
  if (key === 'zone') return row.siteCode ?? row.campus;
  if (key === 'type') return row.empType;
  if (key === 'balance') return row.leaveBalance ?? row.balance;
  if (key === 'remark') return row.remark ?? row.remarks;
  return row[key];
}

function matchPayrollCell(row: Record<string, unknown>, key: string, filter: string) {
  const raw = payrollCell(row, key);
  const text = String(raw ?? '').trim();
  const needle = filter.trim().toLowerCase();
  if (PAYROLL_NUM_COLS.has(key)) {
    const want = Number(needle.replace(/,/g, ''));
    if (Number.isFinite(want)) return Math.abs(moneyNum(raw) - want) < 0.005;
    return text.toLowerCase().includes(needle);
  }
  if (PAYROLL_EXACT_COLS.has(key)) return text.toLowerCase() === needle;
  if (key === 'month') {
    const digits = needle.replace(/\D/g, '');
    return digits ? text.replace(/\D/g, '').includes(digits) : true;
  }
  if (key === 'date' || key === 'joinDate' || key === 'leftDate') {
    const d = text.slice(0, 10);
    const dmy = d.length === 10 ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '';
    return d.toLowerCase().includes(needle) || dmy.includes(needle);
  }
  return text.toLowerCase().includes(needle);
}

@Injectable()
export class PayrollService {
  private colCache = new Map<string, Set<string>>();
  private tableCache = new Map<string, boolean>();

  constructor(private readonly database: DatabaseService) {}

  /**
   * Column header filters for any payroll report: without filters the report pages itself;
   * with filters the full report is loaded once, filtered, then paged here.
   */
  async withColumnFilters<T extends PayrollPage>(
    colFilters: Record<string, string>,
    page: number,
    pageSize: number,
    fetch: (page: number, pageSize: number) => Promise<T>,
    amountOf: (rows: Record<string, unknown>[]) => number,
  ): Promise<T> {
    const active = Object.entries(colFilters).filter(([, v]) => String(v ?? '').trim());
    if (!active.length) return fetch(page, pageSize);
    const full = await fetch(1, PAGE_MAX);
    const filtered = full.rows.filter((r) =>
      active.every(([k, v]) => matchPayrollCell(r, k, String(v))),
    );
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    return {
      ...full,
      rows: filtered.slice(offset, offset + size),
      total: filtered.length,
      page: current,
      pageSize: size,
      totalAmount: round2(amountOf(filtered)),
    };
  }

  private async tableExists(name: string) {
    const key = name.toLowerCase();
    if (this.tableCache.has(key)) return this.tableCache.get(key)!;
    const res = await this.database.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND lower(table_name) = lower($1)
       ) AS exists`,
      [name],
    );
    const ok = Boolean(res.rows[0]?.exists);
    this.tableCache.set(key, ok);
    return ok;
  }

  private async columns(table: string) {
    const key = table.toLowerCase();
    if (this.colCache.has(key)) return this.colCache.get(key)!;
    const res = await this.database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND lower(table_name) = lower($1)`,
      [table],
    );
    const set = new Set(res.rows.map((r) => r.column_name.toLowerCase()));
    this.colCache.set(key, set);
    return set;
  }

  private pick(cols: Set<string>, candidates: string[]) {
    for (const c of candidates) {
      if (cols.has(c.toLowerCase())) return c;
    }
    return '';
  }

  /** Map API fields → real `persona` column names (schema varies by DB). */
  private personaCols(cols: Set<string>) {
    return {
      code: this.pick(cols, ['ecode', 'empno', 'code', 'id']),
      name: this.pick(cols, ['ename', 'name', 'empname']),
      father: this.pick(cols, ['fname', 'father', 'fathername']),
      design: this.pick(cols, ['design', 'desig', 'designation']),
      // live schema uses zcode for campus/zone
      site: this.pick(cols, ['zcode', 'ccode', 'site', 'wcode', 'campus']),
      gender: this.pick(cols, ['sex', 'gender']),
      // ESS “Emp Type”: Regular / Non Regular / Temporary → persona.regu (Y/N/T)
      regu: this.pick(cols, ['regu', 'regular', 'etype', 'emptype']),
      // marital / other flag — NOT employment category
      status: this.pick(cols, ['statu', 'status', 'estate']),
      // paymod before bank (bank is account name, not mode)
      pay: this.pick(cols, ['paymod', 'pmode', 'paymode', 'payment']),
      bank: this.pick(cols, ['bank', 'bankname', 'bname']),
      phone: this.pick(cols, ['phone', 'cell', 'cellno', 'mobile']),
      salary: this.pick(cols, ['bsalary', 'salary', 'basic', 'pay', 'gross']),
      join: this.pick(cols, ['jdate', 'joindate', 'doj', 'sdate', 'adate']),
      left: this.pick(cols, ['ldate', 'leftdate', 'dol', 'edate']),
      address: this.pick(cols, ['addres', 'address', 'addr']),
      nid: this.pick(cols, ['nid', 'cnic', 'nic']),
      qual: this.pick(cols, ['qualification', 'qual', 'edu']),
      dob: this.pick(cols, ['dob', 'birth', 'bdate']),
      photo: this.pick(cols, ['photo', 'pict', 'image']),
      ntn: this.pick(cols, ['ntn']),
    };
  }

  /** ESS Emp Type label from persona.regu code. */
  private reguLabel(raw: string): string {
    const c = String(raw || '').trim().toUpperCase();
    if (!c) return '';
    if (c === 'Y' || c === 'R' || c === 'REGULAR') return 'Regular';
    if (
      c === 'N' ||
      c === 'NR' ||
      c === 'NON REGULAR' ||
      c === 'NONREGULAR' ||
      c === 'NON-REGULAR'
    ) {
      return 'Non Regular';
    }
    if (c === 'T' || c === 'TEMP' || c === 'TEMPORARY') return 'Temporary';
    return String(raw || '').trim();
  }

  /** Filter / save value → persona.regu code (Y/N/T). Empty = All Category. */
  private reguCode(raw: string): string {
    const l = String(raw || '').trim().toUpperCase();
    if (
      !l ||
      l === 'ALL' ||
      l === 'ALL TYPES' ||
      l === 'ALL CATAGORY' ||
      l === 'ALL CATEGORY'
    ) {
      return '';
    }
    if (l === 'Y' || l === 'R' || l === 'REGULAR') return 'Y';
    if (
      l === 'N' ||
      l === 'NR' ||
      l === 'NON REGULAR' ||
      l === 'NONREGULAR' ||
      l === 'NON-REGULAR'
    ) {
      return 'N';
    }
    if (l === 'T' || l === 'TEMP' || l === 'TEMPORARY') return 'T';
    return String(raw || '').trim();
  }

  /** ESS Payment Mode label from persona.paymod (C / Bank / Q). */
  private paymodLabel(raw: string): string {
    const c = String(raw || '').trim().toUpperCase();
    if (!c) return '';
    if (c === 'C' || c === 'CASH') return 'Cash';
    if (c === 'B' || c === 'BANK') return 'Bank';
    if (
      c === 'Q' ||
      c === 'CB' ||
      c === 'CASH AND BANK' ||
      c === 'CASH & BANK' ||
      c === 'CHEQUE' ||
      c === 'CHECK'
    ) {
      return 'Cash and Bank';
    }
    return String(raw || '').trim();
  }

  /** Filter / save value → persona.paymod code. */
  private paymodCode(raw: string): string {
    const l = String(raw || '').trim().toUpperCase();
    if (!l || l === 'ALL' || l === 'ALL MODES' || l === 'ALL MODE') return '';
    if (l === 'C' || l === 'CASH') return 'C';
    if (l === 'B' || l === 'BANK') return 'Bank';
    if (
      l === 'Q' ||
      l === 'CB' ||
      l === 'CASH AND BANK' ||
      l === 'CASH & BANK' ||
      l === 'CHEQUE' ||
      l === 'CHECK'
    ) {
      return 'Q';
    }
    return String(raw || '').trim();
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

  private async siteScope(username: string, site: string) {
    const zone = await this.zonePrefix(username);
    let code = String(site || '').trim();
    if (!code) code = zone || '';
    if (zone && code && !(code === zone || code.startsWith(zone))) return zone;
    return code;
  }

  async sites(username: string) {
    const zone = await this.zonePrefix(username);
    const rows = await this.database.query<{ code: string; name: string }>(
      `SELECT trim(a.acode) AS code, trim(a.ahead) AS name
       FROM acc a
       WHERE a.acode LIKE '14%'
         AND ($1 = '' OR a.acode = $1 OR a.acode LIKE $1 || '%')
       ORDER BY a.acode`,
      [zone],
    );
    return rows.rows;
  }

  /** Best default salary month (MMYYYY): last closed month if posted, else densest recent month. */
  private async latestSalaryMont(): Promise<string> {
    if (!(await this.tableExists('salarym'))) return '';
    const now = new Date();
    now.setDate(1);
    now.setMonth(now.getMonth() - 1);
    const prev = `${String(now.getMonth() + 1).padStart(2, '0')}${now.getFullYear()}`;
    const prevHit = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM salarym WHERE trim(mont) = $1`,
      [prev],
    );
    if (Number(prevHit.rows[0]?.n) || 0) return prev;

    const row = await this.database.query<{ m: string }>(
      `SELECT trim(mont) AS m
       FROM salarym
       WHERE coalesce(trim(mont), '') <> ''
         AND length(regexp_replace(trim(mont), '\\D', '', 'g')) = 6
       GROUP BY trim(mont)
       ORDER BY count(*) DESC,
                right(regexp_replace(trim(mont), '\\D', '', 'g'), 4) DESC,
                left(regexp_replace(trim(mont), '\\D', '', 'g'), 2) DESC
       LIMIT 1`,
    );
    return String(row.rows[0]?.m || '').trim();
  }

  async lookups(username: string, site = '') {
    const scope = await this.siteScope(username, site);
    const latestMont = await this.latestSalaryMont();
    if (!(await this.tableExists('persona'))) {
      return { designations: [], empTypes: [], paymentModes: [], latestMont };
    }
    const cols = await this.columns('persona');
    const pc = this.personaCols(cols);
    const designCol = pc.design;
    const siteCol = pc.site;
    const payCol = pc.pay;

    const siteFilter =
      siteCol && scope
        ? `AND (coalesce(trim(p.${siteCol}), '') = '' OR trim(p.${siteCol}) LIKE $1 || '%')`
        : '';

    const designations = designCol
      ? (
          await this.database.query<{ value: string }>(
            `SELECT DISTINCT trim(p.${designCol}) AS value
             FROM persona p
             WHERE coalesce(trim(p.${designCol}), '') <> ''
               ${siteFilter}
             ORDER BY 1
             LIMIT 500`,
            siteFilter ? [scope] : [],
          )
        ).rows.map((r) => r.value)
      : [];

    // Match ESS Emp Type list from persona.regu (Y/N/T) — never invent values.
    let empTypes: string[] = [];
    if (pc.regu) {
      const codes = (
        await this.database.query<{ value: string }>(
          `SELECT DISTINCT upper(trim(p.${pc.regu})) AS value
           FROM persona p
           WHERE coalesce(trim(p.${pc.regu}), '') <> ''
             ${siteFilter}
           ORDER BY 1
           LIMIT 50`,
          siteFilter ? [scope] : [],
        )
      ).rows.map((r) => r.value);
      const order = ['Regular', 'Non Regular', 'Temporary'];
      const labels = new Set(codes.map((c) => this.reguLabel(c)).filter(Boolean));
      empTypes = order.filter((x) => labels.has(x));
      for (const x of labels) {
        if (!empTypes.includes(x)) empTypes.push(x);
      }
    }

    // Match ESS Payment Mode from persona.paymod (C / Bank / Q).
    let paymentModes: string[] = [];
    if (payCol) {
      const codes = (
        await this.database.query<{ value: string }>(
          `SELECT DISTINCT trim(p.${payCol}) AS value
           FROM persona p
           WHERE coalesce(trim(p.${payCol}), '') <> ''
             ${siteFilter}
           ORDER BY 1
           LIMIT 50`,
          siteFilter ? [scope] : [],
        )
      ).rows.map((r) => r.value);
      const order = ['Cash', 'Bank', 'Cash and Bank'];
      const labels = new Set(codes.map((c) => this.paymodLabel(c)).filter(Boolean));
      paymentModes = order.filter((x) => labels.has(x));
      for (const x of labels) {
        if (!paymentModes.includes(x)) paymentModes.push(x);
      }
    }

    return { designations, empTypes, paymentModes, latestMont };
  }

  async employees(username: string, site = '', q = '', limit = 5000) {
    if (!(await this.tableExists('persona'))) return [];
    // Picker should list the full zone (ESS Find %), not only the selected campus.
    // Pass site when caller wants a campus-narrowed list; empty site → zone prefix.
    const scope = await this.siteScope(username, site);
    const cols = await this.columns('persona');
    const pc = this.personaCols(cols);
    if (!pc.code || !pc.name) return [];
    const search = String(q || '').trim().replace(/%/g, '');
    const size = Math.min(Math.max(Number(limit) || 5000, 1), 8000);

    const params: unknown[] = [];
    const where: string[] = [`coalesce(trim(p.${pc.code}), '') <> ''`];
    if (pc.site && scope) {
      params.push(scope);
      where.push(
        `(coalesce(trim(p.${pc.site}), '') = '' OR trim(p.${pc.site}) LIKE $${params.length} || '%')`,
      );
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(
        `(p.${pc.code} ILIKE $${params.length} OR p.${pc.name} ILIKE $${params.length}
          ${pc.design ? `OR p.${pc.design} ILIKE $${params.length}` : ''})`,
      );
    }
    params.push(size);

    const rows = await this.database.query<{
      code: string;
      name: string;
      designation: string;
      siteCode: string;
      empType: string;
    }>(
      `SELECT trim(p.${pc.code}) AS code,
              coalesce(nullif(trim(p.${pc.name}), ''), trim(p.${pc.code})) AS name,
              ${pc.design ? `coalesce(trim(p.${pc.design}), '')` : `''`} AS designation,
              ${pc.site ? `coalesce(trim(p.${pc.site}), '')` : `''`} AS "siteCode",
              ${pc.regu ? `coalesce(trim(p.${pc.regu}), '')` : `''`} AS "empType"
       FROM persona p
       WHERE ${where.join(' AND ')}
       ORDER BY length(regexp_replace(trim(p.${pc.code}), '\\D', '', 'g')) DESC,
                regexp_replace(trim(p.${pc.code}), '\\D', '', 'g') DESC NULLS LAST,
                p.${pc.name}, p.${pc.code}
       LIMIT $${params.length}`,
      params,
    );
    return rows.rows.map((r) => ({
      ...r,
      empType: this.reguLabel(r.empType),
    }));
  }

  private async personaRows(
    username: string,
    filters: {
      site?: string;
      employee?: string;
      empType?: string;
      designation?: string;
      paymentMode?: string;
      q?: string;
      page?: number;
      pageSize?: number;
      includePhoto?: boolean;
      /** Earn Leave: staff with sick/casu/anu first. */
      orderByLeave?: boolean;
    },
  ) {
    if (!(await this.tableExists('persona'))) {
      return { rows: [] as Record<string, unknown>[], total: 0, cols: new Set<string>() };
    }
    const scope = await this.siteScope(username, filters.site || '');
    const cols = await this.columns('persona');
    const pc = this.personaCols(cols);
    if (!pc.code || !pc.name) {
      return { rows: [], total: 0, cols };
    }
    const withPhoto = Boolean(filters.includePhoto && pc.photo);

    const page = Math.max(Number(filters.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(filters.pageSize) || 50, 1), PAGE_MAX);
    const offset = (page - 1) * pageSize;
    const params: unknown[] = [];
    const where: string[] = [`coalesce(trim(p.${pc.code}), '') <> ''`];

    if (pc.site && scope) {
      params.push(scope);
      where.push(
        `(coalesce(trim(p.${pc.site}), '') = '' OR trim(p.${pc.site}) LIKE $${params.length} || '%')`,
      );
    }
    if (filters.employee?.trim()) {
      params.push(filters.employee.trim());
      where.push(`upper(trim(p.${pc.code})) = upper($${params.length})`);
    }
    const reguFilter = this.reguCode(filters.empType || '');
    if (pc.regu && reguFilter) {
      params.push(reguFilter);
      where.push(`upper(trim(p.${pc.regu})) = upper($${params.length})`);
    }
    if (pc.design && filters.designation?.trim()) {
      params.push(filters.designation.trim());
      where.push(`trim(p.${pc.design}) = $${params.length}`);
    }
    const payFilter = this.paymodCode(filters.paymentMode || '');
    if (pc.pay && payFilter) {
      params.push(payFilter.toUpperCase());
      where.push(`upper(trim(p.${pc.pay})) = $${params.length}`);
    }
    if (filters.q?.trim()) {
      params.push(`%${filters.q.trim()}%`);
      where.push(
        `(p.${pc.code} ILIKE $${params.length} OR p.${pc.name} ILIKE $${params.length})`,
      );
    }

    const count = await this.database.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM persona p WHERE ${where.join(' AND ')}`,
      params,
    );

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const rowParams = [...params, pageSize, offset];

    const rows = await this.database.query<Record<string, string>>(
      `SELECT trim(p.${pc.code}) AS code,
              coalesce(nullif(trim(p.${pc.name}), ''), trim(p.${pc.code})) AS name,
              ${pc.father ? `coalesce(trim(p.${pc.father}), '')` : `''`} AS "fatherName",
              ${pc.design ? `coalesce(trim(p.${pc.design}), '')` : `''`} AS designation,
              ${pc.site ? `coalesce(trim(p.${pc.site}), '')` : `''`} AS "siteCode",
              ${pc.regu ? `coalesce(trim(p.${pc.regu}), '')` : `''`} AS "empType",
              ${pc.gender ? `coalesce(trim(p.${pc.gender}), '')` : `''`} AS gender,
              ${pc.pay ? `coalesce(trim(p.${pc.pay}), '')` : `''`} AS "paymentMode",
              ${pc.bank ? `coalesce(trim(p.${pc.bank}), '')` : `''`} AS bank,
              ${pc.join ? `left(coalesce(p.${pc.join}::text, ''), 10)` : `''`} AS "joinDate",
              ${pc.left ? `left(coalesce(p.${pc.left}::text, ''), 10)` : `''`} AS "leftDate",
              ${pc.dob ? `left(coalesce(p.${pc.dob}::text, ''), 10)` : `''`} AS dob,
              ${pc.phone ? `coalesce(trim(p.${pc.phone}), '')` : `''`} AS phone,
              ${pc.address ? `coalesce(trim(p.${pc.address}), '')` : `''`} AS address,
              ${pc.nid ? `coalesce(trim(p.${pc.nid}), '')` : `''`} AS cnic,
              ${pc.qual ? `coalesce(trim(p.${pc.qual}), '')` : `''`} AS qualification,
              ${pc.ntn ? `coalesce(trim(p.${pc.ntn}), '')` : `''`} AS ntn,
              ${pc.salary ? `coalesce(p.${pc.salary}::text, '0')` : `'0'`} AS salary,
              ${cols.has('sick') ? `coalesce(nullif(trim(p.sick), ''), '0')` : `'0'`} AS sick,
              ${cols.has('casu') ? `coalesce(nullif(trim(p.casu), ''), '0')` : `'0'`} AS casu,
              ${cols.has('anu') ? `coalesce(nullif(trim(p.anu), ''), '0')` : `'0'`} AS anu,
              ${withPhoto ? `coalesce(p.${pc.photo}, '')` : `''`} AS photo
       FROM persona p
       WHERE ${where.join(' AND ')}
       ORDER BY ${
         filters.orderByLeave
           ? `(abs(coalesce(nullif(trim(p.sick), ''), '0')::numeric)
              + abs(coalesce(nullif(trim(p.casu), ''), '0')::numeric)
              + abs(coalesce(nullif(trim(p.anu), ''), '0')::numeric)) DESC NULLS LAST,
              `
           : ''
       }length(regexp_replace(trim(p.${pc.code}), '\\D', '', 'g')) DESC,
                regexp_replace(trim(p.${pc.code}), '\\D', '', 'g') DESC NULLS LAST,
                p.${pc.name}, p.${pc.code}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      rowParams,
    );

    return {
      rows: rows.rows.map((r) => ({
        code: r.code || '',
        name: r.name || '',
        fatherName: r.fatherName || '',
        designation: r.designation || '',
        siteCode: r.siteCode || '',
        empType: this.reguLabel(String(r.empType || '')),
        gender: r.gender || '',
        paymentMode: this.paymodLabel(String(r.paymentMode || '')),
        bank: r.bank || '',
        joinDate: r.joinDate || '',
        leftDate: r.leftDate || '',
        dob: r.dob || '',
        phone: r.phone || '',
        address: r.address || '',
        cnic: r.cnic || '',
        qualification: r.qualification || '',
        ntn: r.ntn || '',
        salary: round2(moneyNum(r.salary)),
        sick: r.sick || '0',
        casu: r.casu || '0',
        anu: r.anu || '0',
        photo: withPhoto ? String(r.photo || '') : '',
      })),
      total: Number(count.rows[0]?.total) || 0,
      cols,
    };
  }

  async employeeLedger(
    username: string,
    site: string,
    employee: string,
    fromDate: string,
    toDate: string,
    page = 1,
    pageSize = 50,
  ) {
    const base = await this.personaRows(username, {
      site,
      employee,
      page,
      pageSize,
    });
    const rows = base.rows.map((r) => ({
      ...r,
      fromDate: fromDate || '',
      toDate: toDate || '',
      debit: 0,
      credit: round2(Number(r.salary) || 0),
      balance: round2(-(Number(r.salary) || 0)),
      narration: '',
    }));
    return {
      rows,
      total: base.total,
      page,
      pageSize,
      totalAmount: round2(rows.reduce((s, r) => s + r.credit, 0)),
      meta: { site, employee, fromDate, toDate },
    };
  }

  async employeeBonus(
    username: string,
    site: string,
    employee: string,
    empType: string,
    designation: string,
    page = 1,
    pageSize = 50,
  ) {
    const base = await this.personaRows(username, {
      site,
      employee,
      empType,
      designation,
      page,
      pageSize,
    });
    const rows = base.rows.map((r) => ({
      ...r,
      bonus: 0,
      amount: 0,
      month: '',
      remark: '',
    }));
    return {
      rows,
      total: base.total,
      page,
      pageSize,
      totalAmount: 0,
      meta: { site, employee, empType, designation },
    };
  }

  async earnLeave(
    username: string,
    site: string,
    employee: string,
    empType: string,
    designation: string,
    page = 1,
    pageSize = 50,
    q = '',
  ) {
    const base = await this.personaRows(username, {
      site,
      employee,
      empType,
      designation,
      q,
      page,
      pageSize,
      orderByLeave: true,
    });
    // ESS Earn Leave Voucher: persona.sick + casu = used leave days; anu = annual balance.
    // No invented remarks / amounts — only what is stored in DB.
    const mapped = base.rows.map((r) => {
      const sick = Math.abs(moneyNum(String(r.sick ?? '0')));
      const casu = Math.abs(moneyNum(String(r.casu ?? '0')));
      const anu = Math.abs(moneyNum(String(r.anu ?? '0')));
      const leaveDays = round2(sick + casu);
      const leaveBalance = round2(anu);
      return {
        ...r,
        sick: round2(sick),
        casu: round2(casu),
        anu: leaveBalance,
        leaveDays,
        leaveBalance,
        balance: leaveBalance,
        amount: 0,
        remark: '',
      };
    });
    return {
      rows: mapped,
      total: base.total,
      page,
      pageSize,
      totalAmount: round2(
        mapped.reduce((s, r) => s + Number(r.leaveDays || 0), 0),
      ),
      meta: { site, employee, q },
    };
  }

  async monthlySalarySheet(
    username: string,
    site: string,
    mont: string,
    empType: string,
    designation: string,
    paymentMode: string,
    page = 1,
    pageSize = 50,
    fromDate = '',
    toDate = '',
    employee = '',
    q = '',
  ) {
    const explicitMont = String(mont || '').trim();
    const from = String(fromDate || '').trim();
    const to = String(toDate || '').trim();
    const empCode = String(employee || '').trim();
    const search = String(q || '').trim();
    let period = this.resolveMont(mont, fromDate);
    const scope = await this.siteScope(username, site);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), PAGE_MAX);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;

    const hasSalarym = await this.tableExists('salarym');
    const hasSalaryd = await this.tableExists('salaryd');

    // Vouchers for the month + persona staff with no voucher yet (so Add shows on top).
    if (hasSalarym && hasSalaryd && (await this.tableExists('persona'))) {
      if (!explicitMont && !from) {
        const probe = await this.database.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM salarym WHERE trim(mont) = $1`,
          [period],
        );
        if (!(Number(probe.rows[0]?.total) || 0)) {
          period = this.shiftMont(period, -1);
        }
      }

      const pc = this.personaCols(await this.columns('persona'));
      if (!pc.code || !pc.name) {
        // fall through to persona-only path below
      } else {
        const params: unknown[] = [period];
        const vWhere: string[] = [`trim(m.mont) = $1`];
        const pWhere: string[] = [
          `coalesce(trim(p.${pc.code}), '') <> ''`,
          `NOT EXISTS (
             SELECT 1 FROM salarym sm
             WHERE trim(sm.ecode) = trim(p.${pc.code}) AND trim(sm.mont) = $1
           )`,
        ];

        if (from) {
          params.push(from);
          vWhere.push(
            `(d.tdate IS NULL OR nullif(trim(d.tdate::text), '') IS NULL
              OR left(trim(d.tdate::text), 10)::date >= $${params.length}::date)`,
          );
        }
        if (to) {
          params.push(to);
          vWhere.push(
            `(d.fdate IS NULL OR nullif(trim(d.fdate::text), '') IS NULL
              OR left(trim(d.fdate::text), 10)::date <= $${params.length}::date)`,
          );
        }
        if (scope) {
          params.push(scope);
          vWhere.push(
            `(coalesce(trim(m.zcode), '') = '' OR trim(m.zcode) LIKE $${params.length} || '%'
              OR $${params.length} LIKE trim(m.zcode) || '%'
              OR coalesce(trim(d.stcode), '') = '' OR trim(d.stcode) LIKE $${params.length} || '%'
              OR $${params.length} LIKE trim(d.stcode) || '%')`,
          );
          if (pc.site) {
            // Match campus OR shorter zone prefix on persona (e.g. zcode "14" under Lahore).
            pWhere.push(
              `(coalesce(trim(p.${pc.site}), '') = ''
                OR trim(p.${pc.site}) LIKE $${params.length} || '%'
                OR $${params.length} LIKE trim(p.${pc.site}) || '%')`,
            );
          }
        }
        if (empCode) {
          params.push(empCode);
          vWhere.push(`upper(trim(m.ecode)) = upper($${params.length})`);
          pWhere.push(`upper(trim(p.${pc.code})) = upper($${params.length})`);
        } else if (search) {
          params.push(`%${search}%`);
          const desigV = pc.design
            ? ` OR coalesce(p.${pc.design}, '') ILIKE $${params.length}`
            : '';
          vWhere.push(
            `(m.ecode ILIKE $${params.length} OR coalesce(m.zcode, '') ILIKE $${params.length}
              OR coalesce(p.${pc.name}, '') ILIKE $${params.length}${desigV})`,
          );
          const desigP = pc.design
            ? ` OR coalesce(p.${pc.design}, '') ILIKE $${params.length}`
            : '';
          pWhere.push(
            `(p.${pc.code} ILIKE $${params.length} OR p.${pc.name} ILIKE $${params.length}${desigP})`,
          );
        }
        if (pc.design && designation?.trim()) {
          params.push(designation.trim());
          vWhere.push(`coalesce(trim(p.${pc.design}), '') = $${params.length}`);
          pWhere.push(`coalesce(trim(p.${pc.design}), '') = $${params.length}`);
        }
        const reguFilter = this.reguCode(empType);
        if (pc.regu && reguFilter) {
          params.push(reguFilter);
          vWhere.push(`upper(trim(p.${pc.regu})) = upper($${params.length})`);
          pWhere.push(`upper(trim(p.${pc.regu})) = upper($${params.length})`);
        }
        const sheetPay = this.paymodCode(paymentMode);
        if (pc.pay && sheetPay) {
          params.push(sheetPay.toUpperCase());
          vWhere.push(`upper(trim(p.${pc.pay})) = $${params.length}`);
          pWhere.push(`upper(trim(p.${pc.pay})) = $${params.length}`);
        }

        const voucherSelect = `
          SELECT trim(m.ecode) AS code,
                 coalesce(nullif(trim(p.${pc.name}), ''), trim(m.ecode)) AS name,
                 ${pc.design ? `coalesce(trim(p.${pc.design}), '')` : `''`} AS designation,
                 ${pc.regu ? `coalesce(trim(p.${pc.regu}), '')` : `''`} AS "empType",
                 ${pc.pay ? `coalesce(trim(p.${pc.pay}), '')` : `''`} AS "paymentMode",
                 coalesce(nullif(trim(m.zcode), ''), coalesce(trim(d.stcode), '')) AS "siteCode",
                 trim(m.mont) AS month,
                 left(coalesce(d.fdate::text, ${pc.join ? `p.${pc.join}::text` : `''`}, ''), 10) AS "rowDate",
                 coalesce(nullif(trim(d.salary), ''), nullif(trim(m.mbsal), ''), '0') AS basic,
                 coalesce(nullif(trim(d.spall), ''), '0') AS spall,
                 coalesce(nullif(trim(d.mess), ''), '0') AS mess,
                 coalesce(nullif(trim(d.mna), ''), '0') AS mna,
                 coalesce(nullif(trim(d.loan), ''), '0') AS loan,
                 coalesce(nullif(trim(d.adva), ''), '0') AS adva,
                 coalesce(nullif(trim(d.itax), ''), '0') AS itax,
                 coalesce(nullif(trim(m.totmon), ''), '0') AS totmon,
                 1 AS has_voucher
          FROM salarym m
          JOIN salaryd d ON trim(m.svno) = trim(d.svno)
          LEFT JOIN persona p ON trim(p.${pc.code}) = trim(m.ecode)
          WHERE ${vWhere.join(' AND ')}`;

        const orphanSelect = `
          SELECT trim(p.${pc.code}) AS code,
                 coalesce(nullif(trim(p.${pc.name}), ''), trim(p.${pc.code})) AS name,
                 ${pc.design ? `coalesce(trim(p.${pc.design}), '')` : `''`} AS designation,
                 ${pc.regu ? `coalesce(trim(p.${pc.regu}), '')` : `''`} AS "empType",
                 ${pc.pay ? `coalesce(trim(p.${pc.pay}), '')` : `''`} AS "paymentMode",
                 ${pc.site ? `coalesce(trim(p.${pc.site}), '')` : `''`} AS "siteCode",
                 $1::text AS month,
                 left(coalesce(${pc.join ? `p.${pc.join}::text` : `''`}, ''), 10) AS "rowDate",
                 ${pc.salary ? `coalesce(p.${pc.salary}::text, '0')` : `'0'`} AS basic,
                 '0' AS spall,
                 '0' AS mess,
                 '0' AS mna,
                 '0' AS loan,
                 '0' AS adva,
                 '0' AS itax,
                 '0' AS totmon,
                 0 AS has_voucher
          FROM persona p
          WHERE ${pWhere.join(' AND ')}`;

        const combined = `(${voucherSelect}) UNION ALL (${orphanSelect})`;

        const count = await this.database.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM (${combined}) sheet`,
          params,
        );

        const limitIdx = params.length + 1;
        const offsetIdx = params.length + 2;
        const rows = await this.database.query<{
          code: string;
          name: string;
          designation: string;
          empType: string;
          paymentMode: string;
          siteCode: string;
          month: string;
          rowDate: string;
          basic: string;
          spall: string;
          mess: string;
          mna: string;
          loan: string;
          adva: string;
          itax: string;
          totmon: string;
          has_voucher: string;
        }>(
          `SELECT * FROM (${combined}) sheet
           ORDER BY has_voucher ASC,
                    length(regexp_replace(trim(code), '\\D', '', 'g')) DESC,
                    regexp_replace(trim(code), '\\D', '', 'g') DESC NULLS LAST,
                    name, code
           LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          [...params, size, offset],
        );

        const mapped = rows.rows.map((r) => {
          const basic = round2(moneyNum(r.basic));
          const allowances = round2(
            moneyNum(r.spall) + moneyNum(r.mess) + moneyNum(r.mna),
          );
          const deductions = round2(
            Math.abs(moneyNum(r.loan)) +
              Math.abs(moneyNum(r.adva)) +
              Math.abs(moneyNum(r.itax)),
          );
          const totmon = moneyNum(r.totmon);
          const net = round2(
            totmon !== 0 ? totmon : basic + allowances - deductions,
          );
          return {
            code: r.code || '',
            name: r.name || r.code || '',
            designation: r.designation || '',
            empType: this.reguLabel(r.empType || ''),
            paymentMode: this.paymodLabel(r.paymentMode || ''),
            siteCode: r.siteCode || '',
            campus: r.siteCode || '',
            month: r.month || period,
            date: r.rowDate || '',
            joinDate: r.rowDate || '',
            basic,
            allowances,
            deductions,
            net,
            salary: basic,
          };
        });

        return {
          rows: mapped,
          total: Number(count.rows[0]?.total) || 0,
          page: current,
          pageSize: size,
          totalAmount: round2(mapped.reduce((s, r) => s + Number(r.net || 0), 0)),
          meta: {
            site,
            mont: period,
            fromDate: from,
            toDate: to,
            empType,
            designation,
            paymentMode,
            source: 'salarym+persona',
          },
        };
      }
    }

    // Fallback: persona master (no posted vouchers table).
    const base = await this.personaRows(username, {
      site,
      employee: empCode,
      empType,
      designation,
      paymentMode,
      q: search,
      page,
      pageSize,
    });
    const rows = base.rows.map((r) => {
      const basic = round2(Number(r.salary) || 0);
      const rowDate = String(r.joinDate || '');
      return {
        ...r,
        campus: String(r.siteCode || ''),
        month: period || '',
        date: rowDate,
        joinDate: rowDate,
        basic,
        allowances: 0,
        deductions: 0,
        net: basic,
      };
    });
    const totalNet = round2(rows.reduce((s, r) => s + r.net, 0));
    return {
      rows,
      total: base.total,
      page: current,
      pageSize: size,
      totalAmount: totalNet,
      meta: {
        site,
        mont: period,
        fromDate: from,
        toDate: to,
        empType,
        designation,
        paymentMode,
        source: 'persona',
      },
    };
  }

  async salarySummary(
    username: string,
    site: string,
    mont: string,
    empType: string,
    designation: string,
    page = 1,
    pageSize = 50,
    fromDate = '',
    toDate = '',
    employee = '',
    q = '',
  ) {
    const sheet = await this.monthlySalarySheet(
      username,
      site,
      mont,
      empType,
      designation,
      '',
      1,
      5000,
      fromDate,
      toDate,
      employee,
      q,
    );
    const byDesign = new Map<
      string,
      { designation: string; employees: number; basic: number; net: number }
    >();
    for (const r of sheet.rows) {
      const key = String(r.designation || '—');
      const cur = byDesign.get(key) || {
        designation: key,
        employees: 0,
        basic: 0,
        net: 0,
      };
      cur.employees += 1;
      cur.basic += Number(r.basic) || 0;
      cur.net += Number(r.net) || 0;
      byDesign.set(key, cur);
    }
    const all = [...byDesign.values()]
      .map((r) => ({
        ...r,
        basic: round2(r.basic),
        net: round2(r.net),
      }))
      .sort((a, b) => a.designation.localeCompare(b.designation));
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), PAGE_MAX);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    return {
      rows: all.slice(offset, offset + size),
      total: all.length,
      page: current,
      pageSize: size,
      totalAmount: round2(all.reduce((s, r) => s + r.net, 0)),
      meta: { site, mont, empType, designation },
    };
  }

  /** Convert filter mont / ISO date → ESS `MMYYYY` (e.g. 102026). */
  private resolveMont(mont: string, fromDate = '') {
    const raw = String(mont || '').trim();
    if (/^\d{6}$/.test(raw)) return raw;
    if (/^\d{2}\/\d{4}$/.test(raw)) return `${raw.slice(0, 2)}${raw.slice(3)}`;
    const iso = String(fromDate || '').trim();
    if (/^\d{4}-\d{2}/.test(iso)) return `${iso.slice(5, 7)}${iso.slice(0, 4)}`;
    const now = new Date();
    return `${String(now.getMonth() + 1).padStart(2, '0')}${now.getFullYear()}`;
  }

  private shiftMont(mont: string, deltaMonths: number): string {
    const raw = String(mont || '').replace(/\D/g, '');
    if (raw.length !== 6) return mont;
    const mm = Number(raw.slice(0, 2));
    const yyyy = Number(raw.slice(2));
    if (!mm || !yyyy) return mont;
    const d = new Date(yyyy, mm - 1 + deltaMonths, 1);
    return `${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
  }

  async attendanceRegister(
    username: string,
    site: string,
    mont: string,
    empType: string,
    designation: string,
    page = 1,
    pageSize = 50,
    fromDate = '',
    toDate = '',
    employee = '',
    q = '',
  ) {
    const explicitMont = String(mont || '').trim();
    const from = String(fromDate || '').trim();
    const to = String(toDate || '').trim();
    const empCode = String(employee || '').trim();
    const search = String(q || '').trim();
    let period = this.resolveMont(mont, fromDate);
    const scope = await this.siteScope(username, site);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), PAGE_MAX);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;

    const hasSalarym = await this.tableExists('salarym');
    const hasSalaryd = await this.tableExists('salaryd');
    if (!hasSalarym || !hasSalaryd) {
      return {
        rows: [],
        total: 0,
        page: current,
        pageSize: size,
        totalAmount: 0,
        meta: { site, mont: period, note: 'salarym/salaryd not found' },
      };
    }

    // Only soft-fallback when neither month nor date range was chosen.
    // Date / mont filters must stay exact — never silently swap months.
    if (!explicitMont && !from) {
      const probe = await this.database.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM salarym WHERE trim(mont) = $1`,
        [period],
      );
      if (!(Number(probe.rows[0]?.total) || 0)) {
        period = this.shiftMont(period, -1);
      }
    }

    const personaOk = await this.tableExists('persona');
    const pc = personaOk ? this.personaCols(await this.columns('persona')) : null;

    const params: unknown[] = [period];
    const where: string[] = [`trim(m.mont) = $1`];

    // Voucher period must overlap the selected date range (salaryd.fdate/tdate).
    if (from) {
      params.push(from);
      where.push(
        `(d.tdate IS NULL OR nullif(trim(d.tdate::text), '') IS NULL
          OR left(trim(d.tdate::text), 10)::date >= $${params.length}::date)`,
      );
    }
    if (to) {
      params.push(to);
      where.push(
        `(d.fdate IS NULL OR nullif(trim(d.fdate::text), '') IS NULL
          OR left(trim(d.fdate::text), 10)::date <= $${params.length}::date)`,
      );
    }

    if (scope) {
      params.push(scope);
      where.push(
        `(coalesce(trim(m.zcode), '') = '' OR trim(m.zcode) LIKE $${params.length} || '%'
          OR coalesce(trim(d.stcode), '') = '' OR trim(d.stcode) LIKE $${params.length} || '%')`,
      );
    }
    if (empCode) {
      params.push(empCode);
      where.push(`upper(trim(m.ecode)) = upper($${params.length})`);
    } else if (search) {
      params.push(`%${search}%`);
      const nameMatch =
        personaOk && pc?.name
          ? ` OR coalesce(p.${pc.name}, '') ILIKE $${params.length}`
          : '';
      const desigMatch =
        personaOk && pc?.design
          ? ` OR coalesce(p.${pc.design}, '') ILIKE $${params.length}`
          : '';
      where.push(
        `(m.ecode ILIKE $${params.length} OR coalesce(m.zcode, '') ILIKE $${params.length}${nameMatch}${desigMatch})`,
      );
    }
    if (pc?.design && designation?.trim()) {
      params.push(designation.trim());
      where.push(
        personaOk && pc.design
          ? `coalesce(trim(p.${pc.design}), '') = $${params.length}`
          : 'TRUE',
      );
    }
    const attRegu = this.reguCode(empType);
    if (pc?.regu && attRegu) {
      params.push(attRegu);
      where.push(
        personaOk && pc.regu
          ? `upper(trim(p.${pc.regu})) = upper($${params.length})`
          : 'TRUE',
      );
    }

    const joinPersona =
      personaOk && pc?.code && pc?.name
        ? `LEFT JOIN persona p ON trim(p.${pc.code}) = trim(m.ecode)`
        : '';

    const count = await this.database.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM salarym m
       JOIN salaryd d ON trim(m.svno) = trim(d.svno)
       ${joinPersona}
       WHERE ${where.join(' AND ')}`,
      params,
    );

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const rows = await this.database.query<{
      code: string;
      name: string;
      designation: string;
      siteCode: string;
      month: string;
      totday: string;
      absent: string;
      leave: string;
      offday: string;
    }>(
      `SELECT trim(m.ecode) AS code,
              ${
                personaOk && pc?.name
                  ? `coalesce(nullif(trim(p.${pc.name}), ''), trim(m.ecode))`
                  : `trim(m.ecode)`
              } AS name,
              ${
                personaOk && pc?.design
                  ? `coalesce(trim(p.${pc.design}), '')`
                  : `''`
              } AS designation,
              coalesce(nullif(trim(m.zcode), ''), coalesce(trim(d.stcode), '')) AS "siteCode",
              trim(m.mont) AS month,
              coalesce(nullif(trim(d.totday), ''), '0') AS totday,
              coalesce(nullif(trim(d.abs), ''), '0') AS absent,
              coalesce(nullif(trim(d.leav), ''), '0') AS leave,
              coalesce(nullif(trim(d.offday), ''), '0') AS offday
       FROM salarym m
       JOIN salaryd d ON trim(m.svno) = trim(d.svno)
       ${joinPersona}
       WHERE ${where.join(' AND ')}
       ORDER BY length(regexp_replace(trim(m.ecode), '\\D', '', 'g')) DESC,
                regexp_replace(trim(m.ecode), '\\D', '', 'g') DESC NULLS LAST,
                name, code
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, size, offset],
    );

    const mapped = rows.rows.map((r) => {
      const totday = moneyNum(r.totday);
      const absent = Math.abs(moneyNum(r.absent));
      const leave = Math.abs(moneyNum(r.leave));
      const offday = Math.abs(moneyNum(r.offday));
      const present = Math.max(0, totday - absent - leave - offday);
      return {
        code: r.code || '',
        name: r.name || r.code || '',
        designation: r.designation || '',
        siteCode: r.siteCode || '',
        month: r.month || period,
        present: round2(present),
        absent: round2(absent),
        leave: round2(leave),
        shortLeave: 0,
        totday: round2(totday),
      };
    });

    const presentSum = round2(mapped.reduce((s, r) => s + Number(r.present || 0), 0));
    return {
      rows: mapped,
      total: Number(count.rows[0]?.total) || 0,
      page: current,
      pageSize: size,
      totalAmount: presentSum,
      meta: { site, mont: period, fromDate: from, toDate: to },
    };
  }

  async missingNewcomers(
    username: string,
    site: string,
    fromDate: string,
    toDate: string,
    empType: string,
    page = 1,
    pageSize = 50,
  ) {
    const base = await this.personaRows(username, {
      site,
      empType,
      page: 1,
      pageSize: 5000,
    });
    const from = String(fromDate || '').trim();
    const to = String(toDate || '').trim();
    const filtered = base.rows.filter((r) => {
      const join = String(r.joinDate || '');
      const left = String(r.leftDate || '');
      const isNew = join && (!from || join >= from) && (!to || join <= to);
      const isLeft = left && (!from || left >= from) && (!to || left <= to);
      return Boolean(isNew || isLeft);
    });
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), PAGE_MAX);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    const rows = filtered.slice(offset, offset + size).map((r) => ({
      ...r,
      status: r.leftDate ? 'Left / Missing' : 'New Comer',
    }));
    return {
      rows,
      total: filtered.length,
      page: current,
      pageSize: size,
      totalAmount: filtered.length,
      meta: { site, fromDate, toDate },
    };
  }

  async monthlySalaryPack(
    username: string,
    site: string,
    mont: string,
    empType: string,
    designation: string,
    paymentMode: string,
    page = 1,
    pageSize = 50,
    fromDate = '',
    toDate = '',
    employee = '',
    q = '',
  ) {
    return this.monthlySalarySheet(
      username,
      site,
      mont,
      empType,
      designation,
      paymentMode,
      page,
      pageSize,
      fromDate,
      toDate,
      employee,
      q,
    );
  }

  async zonalSalarySummary(
    username: string,
    site: string,
    mont: string,
    page = 1,
    pageSize = 50,
    fromDate = '',
    toDate = '',
    employee = '',
    q = '',
  ) {
    const sheet = await this.monthlySalarySheet(
      username,
      site,
      mont,
      '',
      '',
      '',
      1,
      8000,
      fromDate,
      toDate,
      employee,
      q,
    );
    const bySite = new Map<
      string,
      { siteCode: string; employees: number; basic: number; net: number }
    >();
    for (const r of sheet.rows) {
      const key = String(r.siteCode || '—');
      const cur = bySite.get(key) || {
        siteCode: key,
        employees: 0,
        basic: 0,
        net: 0,
      };
      cur.employees += 1;
      cur.basic += Number(r.basic) || 0;
      cur.net += Number(r.net) || 0;
      bySite.set(key, cur);
    }
    const all = [...bySite.values()]
      .map((r) => ({
        ...r,
        basic: round2(r.basic),
        net: round2(r.net),
      }))
      .sort((a, b) => a.siteCode.localeCompare(b.siteCode));
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), PAGE_MAX);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    return {
      rows: all.slice(offset, offset + size),
      total: all.length,
      page: current,
      pageSize: size,
      totalAmount: round2(all.reduce((s, r) => s + r.net, 0)),
      meta: { site, mont },
    };
  }

  async getEmployee(username: string, codeRaw: string) {
    const code = String(codeRaw || '').trim();
    if (!code) return { ok: false, message: 'Employee code required.' };
    const base = await this.personaRows(username, {
      employee: code,
      page: 1,
      pageSize: 1,
      includePhoto: true,
    });
    const row = base.rows[0];
    if (!row) return { ok: false, message: 'Employee not found.' };
    return { ok: true, employee: row };
  }

  private bumpEmployeeCode(last: string) {
    const raw = String(last || '').trim();
    if (!raw) return '1';
    const m = raw.match(/^(.*?)(\d+)(\D*)$/);
    if (!m) return `${raw}1`;
    const prefix = m[1] ?? '';
    const digits = m[2] ?? '0';
    const suffix = m[3] ?? '';
    const next = (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
    return `${prefix}${next}${suffix}`;
  }

  async nextEmployeeCode(username: string, site = '') {
    if (!(await this.tableExists('persona'))) {
      return { ok: true, code: '1', lastCode: '' };
    }
    const cols = await this.columns('persona');
    const codeCol = this.pick(cols, ['ecode', 'empno', 'code', 'id']);
    if (!codeCol) return { ok: false, message: 'Employee code column missing.', code: '' };

    const scope = await this.siteScope(username, site);
    const pc = this.personaCols(cols);
    const siteCol = pc.site;
    const params: unknown[] = [];
    const where: string[] = [`coalesce(trim(p.${codeCol}), '') <> ''`];
    if (siteCol && scope) {
      params.push(scope);
      where.push(
        `(coalesce(trim(p.${siteCol}), '') = '' OR trim(p.${siteCol}) LIKE $${params.length} || '%')`,
      );
    }

    const rows = await this.database.query<{ code: string }>(
      `SELECT trim(p.${codeCol}) AS code
       FROM persona p
       WHERE ${where.join(' AND ')}
       ORDER BY length(regexp_replace(trim(p.${codeCol}), '\\D', '', 'g')) DESC,
                regexp_replace(trim(p.${codeCol}), '\\D', '', 'g') DESC NULLS LAST,
                trim(p.${codeCol}) DESC
       LIMIT 1`,
      params,
    );
    const lastCode = String(rows.rows[0]?.code || '').trim();
    const code = this.bumpEmployeeCode(lastCode);
    return { ok: true, code, lastCode };
  }

  async createEmployee(
    username: string,
    body: {
      code?: string;
      name?: string;
      fatherName?: string;
      designation?: string;
      siteCode?: string;
      empType?: string;
      gender?: string;
      paymentMode?: string;
      bank?: string;
      phone?: string;
      salary?: number | string;
      sick?: number | string;
      casu?: number | string;
      anu?: number | string;
      joinDate?: string;
      dob?: string;
      address?: string;
      cnic?: string;
      qualification?: string;
      photo?: string;
    },
  ) {
    if (!(await this.tableExists('persona'))) {
      return { ok: false, message: 'Employee table (persona) not found.' };
    }
    const cols = await this.columns('persona');
    const pc = this.personaCols(cols);
    if (!pc.code || !pc.name) {
      return { ok: false, message: 'Employee code/name columns missing.' };
    }
    let code = String(body.code || '').trim();
    if (!code) {
      const next = await this.nextEmployeeCode(username, String(body.siteCode || '').trim());
      code = String(next.code || '').trim();
    }
    const name = String(body.name || '').trim();
    if (!code || !name) {
      return { ok: false, message: 'Employee code and name are required.' };
    }
    const exists = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM persona p WHERE trim(p.${pc.code}) = $1`,
      [code],
    );
    if (Number(exists.rows[0]?.n) > 0) {
      return { ok: false, message: `Employee ${code} already exists.` };
    }

    const fields: string[] = [pc.code, pc.name];
    const values: unknown[] = [code, name];
    const add = (col: string, val: unknown) => {
      if (!col) return;
      fields.push(col);
      values.push(val);
    };
    add(pc.father, String(body.fatherName || '').trim());
    add(pc.design, String(body.designation || '').trim());
    add(pc.site, String(body.siteCode || '').trim());
    add(pc.regu, this.reguCode(String(body.empType || '')) || null);
    add(pc.gender, String(body.gender || '').trim());
    add(pc.pay, this.paymodCode(String(body.paymentMode || '')) || null);
    add(pc.bank, String(body.bank || '').trim());
    add(pc.phone, String(body.phone || '').trim());
    add(pc.salary, moneyNum(body.salary));
    if (cols.has('sick') && body.sick !== undefined) {
      add('sick', String(moneyNum(body.sick)));
    }
    if (cols.has('casu') && body.casu !== undefined) {
      add('casu', String(moneyNum(body.casu)));
    }
    if (cols.has('anu') && body.anu !== undefined) {
      add('anu', String(moneyNum(body.anu)));
    }
    add(pc.join, String(body.joinDate || '').trim() || null);
    add(pc.dob, String(body.dob || '').trim() || null);
    add(pc.address, String(body.address || '').trim());
    add(pc.nid, String(body.cnic || '').trim());
    add(pc.qual, String(body.qualification || '').trim());
    if (body.photo !== undefined) add(pc.photo, String(body.photo || ''));

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    await this.database.query(
      `INSERT INTO persona (${fields.join(', ')}) VALUES (${placeholders})`,
      values,
    );
    void username;
    return { ok: true, message: `Employee ${code} created.`, code };
  }

  async updateEmployee(
    username: string,
    codeRaw: string,
    body: {
      name?: string;
      fatherName?: string;
      designation?: string;
      siteCode?: string;
      empType?: string;
      gender?: string;
      paymentMode?: string;
      bank?: string;
      phone?: string;
      salary?: number | string;
      sick?: number | string;
      casu?: number | string;
      anu?: number | string;
      joinDate?: string;
      dob?: string;
      address?: string;
      cnic?: string;
      qualification?: string;
      photo?: string;
    },
  ) {
    if (!(await this.tableExists('persona'))) {
      return { ok: false, message: 'Employee table (persona) not found.' };
    }
    const cols = await this.columns('persona');
    const pc = this.personaCols(cols);
    if (!pc.code || !pc.name) {
      return { ok: false, message: 'Employee code/name columns missing.' };
    }
    const code = String(codeRaw || '').trim();
    if (!code) return { ok: false, message: 'Employee code required.' };

    const sets: string[] = [];
    const values: unknown[] = [];
    const setCol = (col: string, val: unknown) => {
      if (!col) return;
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };
    if (body.name !== undefined) setCol(pc.name, String(body.name || '').trim());
    if (body.fatherName !== undefined) setCol(pc.father, String(body.fatherName || '').trim());
    if (body.designation !== undefined) setCol(pc.design, String(body.designation || '').trim());
    if (body.siteCode !== undefined) setCol(pc.site, String(body.siteCode || '').trim());
    if (body.empType !== undefined) {
      setCol(pc.regu, this.reguCode(String(body.empType || '')) || null);
    }
    if (body.gender !== undefined) setCol(pc.gender, String(body.gender || '').trim());
    if (body.paymentMode !== undefined) {
      setCol(pc.pay, this.paymodCode(String(body.paymentMode || '')) || null);
    }
    if (body.bank !== undefined) setCol(pc.bank, String(body.bank || '').trim());
    if (body.phone !== undefined) setCol(pc.phone, String(body.phone || '').trim());
    if (body.salary !== undefined) setCol(pc.salary, moneyNum(body.salary));
    if (body.sick !== undefined && cols.has('sick')) {
      setCol('sick', String(moneyNum(body.sick)));
    }
    if (body.casu !== undefined && cols.has('casu')) {
      setCol('casu', String(moneyNum(body.casu)));
    }
    if (body.anu !== undefined && cols.has('anu')) {
      setCol('anu', String(moneyNum(body.anu)));
    }
    if (body.joinDate !== undefined) setCol(pc.join, String(body.joinDate || '').trim() || null);
    if (body.dob !== undefined) setCol(pc.dob, String(body.dob || '').trim() || null);
    if (body.address !== undefined) setCol(pc.address, String(body.address || '').trim());
    if (body.cnic !== undefined) setCol(pc.nid, String(body.cnic || '').trim());
    if (body.qualification !== undefined) setCol(pc.qual, String(body.qualification || '').trim());
    if (body.photo !== undefined) setCol(pc.photo, String(body.photo || ''));

    if (!sets.length) return { ok: false, message: 'Nothing to update.' };
    values.push(code);
    const result = await this.database.query(
      `UPDATE persona SET ${sets.join(', ')} WHERE trim(${pc.code}) = $${values.length}`,
      values,
    );
    if (!result.rowCount) return { ok: false, message: 'Employee not found.' };
    void username;
    return { ok: true, message: `Employee ${code} updated.`, code };
  }

  async deleteEmployee(username: string, codeRaw: string) {
    if (!(await this.tableExists('persona'))) {
      return { ok: false, message: 'Employee table (persona) not found.' };
    }
    const cols = await this.columns('persona');
    const codeCol = this.pick(cols, ['ecode', 'empno', 'code', 'id']);
    if (!codeCol) return { ok: false, message: 'Employee code column missing.' };
    const code = String(codeRaw || '').trim();
    if (!code) return { ok: false, message: 'Employee code required.' };
    const result = await this.database.query(
      `DELETE FROM persona WHERE trim(${codeCol}) = $1`,
      [code],
    );
    if (!result.rowCount) return { ok: false, message: 'Employee not found.' };
    void username;
    return { ok: true, message: `Employee ${code} deleted.`, code };
  }
}
