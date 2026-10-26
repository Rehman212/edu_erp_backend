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
  'absentDays',
  'absentCut',
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
      /** Employment active flag — ESS `sta`: A=Active, anything else = Inactive. */
      sta: this.pick(cols, ['sta']),
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

  /** ESS persona.sta — empty / A = active for salary posting. */
  private isStaActive(raw: string): boolean {
    const c = String(raw || '').trim().toUpperCase();
    return !c || c === 'A';
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
      /** A = Active, I = Inactive, empty = all */
      empActive?: string;
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
    const empFlag = String(filters.empActive || '').trim().toUpperCase();
    if (pc.sta && (empFlag === 'A' || empFlag === 'I')) {
      const staExpr = `upper(coalesce(nullif(trim(p.${pc.sta}), ''), 'A'))`;
      where.push(empFlag === 'A' ? `${staExpr} = 'A'` : `${staExpr} <> 'A'`);
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
              ${pc.sta ? `coalesce(nullif(trim(p.${pc.sta}), ''), 'A')` : `'A'`} AS sta,
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
        sta: String(r.sta || 'A'),
        empActive: this.isStaActive(String(r.sta || 'A')),
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
    const code = String(employee || '').trim();
    const from = String(fromDate || '').trim();
    const to = String(toDate || '').trim();
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), PAGE_MAX);
    const current = Math.max(Number(page) || 1, 1);
    const meta = { site, employee: code, fromDate: from, toDate: to, needEmployee: !code };
    if (
      !code ||
      !(await this.tableExists('salarym')) ||
      !(await this.tableExists('salaryd'))
    ) {
      return { rows: [], total: 0, page: current, pageSize: size, totalAmount: 0, meta };
    }
    const scope = await this.siteScope(username, site);
    const pc = (await this.tableExists('persona'))
      ? this.personaCols(await this.columns('persona'))
      : null;
    const hasP = !!(pc?.code && pc?.name);

    const params: unknown[] = [code];
    const where: string[] = [`upper(trim(m.ecode)) = upper($1)`];
    if (from) {
      params.push(from);
      where.push(
        `(nullif(trim(d.tdate::text), '') IS NULL
          OR left(trim(d.tdate::text), 10)::date >= $${params.length}::date)`,
      );
    }
    if (to) {
      params.push(to);
      where.push(
        `(nullif(trim(d.fdate::text), '') IS NULL
          OR left(trim(d.fdate::text), 10)::date <= $${params.length}::date)`,
      );
    }
    if (scope) {
      params.push(scope);
      where.push(
        `(coalesce(trim(m.zcode), '') = '' OR trim(m.zcode) LIKE $${params.length} || '%'
          OR $${params.length} LIKE trim(m.zcode) || '%')`,
      );
    }

    const res = await this.database.query<Record<string, string>>(
      `SELECT trim(m.ecode) AS code,
              ${hasP ? `coalesce(nullif(trim(p.${pc!.name}), ''), trim(m.ecode))` : `trim(m.ecode)`} AS name,
              ${hasP && pc!.design ? `coalesce(trim(p.${pc!.design}), '')` : `''`} AS designation,
              coalesce(nullif(trim(m.zcode), ''), coalesce(trim(d.stcode), '')) AS "siteCode",
              trim(m.mont) AS month,
              left(coalesce(d.fdate::text, ''), 10) AS "fromDate",
              left(coalesce(d.tdate::text, ''), 10) AS "toDate",
              trim(m.svno) AS svno,
              coalesce(trim(d.jvno), '') AS jvno,
              coalesce(nullif(trim(d.salary), ''), nullif(trim(m.mbsal), ''), '0') AS earned,
              coalesce(nullif(trim(m.mbsal), ''), '0') AS full_basic,
              (coalesce(nullif(trim(m.mhrant), ''), '0')::numeric
               + coalesce(nullif(trim(m.mconv), ''), '0')::numeric
               + coalesce(nullif(trim(m.mutil), ''), '0')::numeric
               + coalesce(nullif(trim(m.motall), ''), '0')::numeric
               + coalesce(nullif(trim(m.mmess), ''), '0')::numeric)::text AS full_allow,
              coalesce(nullif(trim(d.spall), ''), '0') AS spall,
              coalesce(nullif(trim(d.mess), ''), '0') AS mess,
              coalesce(nullif(trim(d.mna), ''), '0') AS mna,
              coalesce(nullif(trim(d.loan), ''), '0') AS loan,
              coalesce(nullif(trim(d.adva), ''), '0') AS adva,
              coalesce(nullif(trim(d.itax), ''), '0') AS itax,
              coalesce(nullif(trim(d.abs), ''), '0') AS absent
       FROM salarym m
       JOIN salaryd d ON trim(m.svno) = trim(d.svno)
       ${hasP ? `LEFT JOIN persona p ON trim(p.${pc!.code}) = trim(m.ecode)` : ''}
       WHERE ${where.join(' AND ')}
       ORDER BY left(coalesce(d.fdate::text, ''), 10), m.row_id
       LIMIT 2000`,
      params,
    );

    let running = 0;
    const all = res.rows.map((r) => {
      const earned = moneyNum(r.earned);
      const extras = moneyNum(r.spall) + moneyNum(r.mess) + moneyNum(r.mna);
      const basic = round2(moneyNum(r.full_basic) || earned);
      const fullAllow = moneyNum(r.full_allow);
      const security = Math.abs(moneyNum(r.loan));
      const advance = Math.abs(moneyNum(r.adva));
      const transport = Math.abs(moneyNum(r.itax));
      const deductions = round2(security + advance + transport);
      const net = round2(earned + extras - deductions);
      running = round2(running + net);
      return {
        code: r.code,
        name: r.name,
        designation: r.designation,
        siteCode: r.siteCode,
        campus: r.siteCode,
        month: r.month,
        date: r.toDate || r.fromDate,
        fromDate: r.fromDate,
        toDate: r.toDate,
        voucherNo: r.svno,
        jvno: r.jvno,
        narration: `Salary for ${r.month}`,
        basic,
        allowances: round2(fullAllow + extras),
        absentDays: round2(moneyNum(r.absent)),
        absentCut: round2(Math.max(0, basic + fullAllow - earned)),
        security: round2(security),
        advance: round2(advance),
        transport: round2(transport),
        deductions,
        gross: round2(earned + extras),
        net,
        credit: net,
        debit: 0,
        balance: running,
      };
    });
    const offset = (current - 1) * size;
    return {
      rows: all.slice(offset, offset + size),
      total: all.length,
      page: current,
      pageSize: size,
      totalAmount: running,
      meta,
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
    empActive = '',
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
        // Employment: A = Active (empty/A), I = Inactive (anything else on persona.sta)
        const empFlag = String(empActive || '').trim().toUpperCase();
        if (pc.sta && (empFlag === 'A' || empFlag === 'I')) {
          const staExpr = `upper(coalesce(nullif(trim(p.${pc.sta}), ''), 'A'))`;
          if (empFlag === 'A') {
            vWhere.push(`${staExpr} = 'A'`);
            pWhere.push(`${staExpr} = 'A'`);
          } else {
            vWhere.push(`${staExpr} <> 'A'`);
            pWhere.push(`${staExpr} <> 'A'`);
          }
        }

        const voucherSelect = `
          SELECT trim(m.ecode) AS code,
                 coalesce(nullif(trim(p.${pc.name}), ''), trim(m.ecode)) AS name,
                 ${pc.design ? `coalesce(trim(p.${pc.design}), '')` : `''`} AS designation,
                 ${pc.regu ? `coalesce(trim(p.${pc.regu}), '')` : `''`} AS "empType",
                 ${pc.pay ? `coalesce(trim(p.${pc.pay}), '')` : `''`} AS "paymentMode",
                 ${pc.sta ? `coalesce(nullif(trim(p.${pc.sta}), ''), 'A')` : `'A'`} AS sta,
                 coalesce(nullif(trim(m.zcode), ''), coalesce(trim(d.stcode), '')) AS "siteCode",
                 trim(m.mont) AS month,
                 left(coalesce(d.fdate::text, ${pc.join ? `p.${pc.join}::text` : `''`}, ''), 10) AS "rowDate",
                 left(coalesce(${pc.join ? `p.${pc.join}::text` : `''`}, ''), 10) AS "joinDate",
                 coalesce(nullif(trim(d.salary), ''), nullif(trim(m.mbsal), ''), '0') AS basic,
                 coalesce(nullif(trim(d.spall), ''), '0') AS spall,
                 coalesce(nullif(trim(d.mess), ''), '0') AS mess,
                 coalesce(nullif(trim(d.mna), ''), '0') AS mna,
                 coalesce(nullif(trim(d.loan), ''), '0') AS loan,
                 coalesce(nullif(trim(d.adva), ''), '0') AS adva,
                 coalesce(nullif(trim(d.itax), ''), '0') AS itax,
                 coalesce(nullif(trim(m.totmon), ''), '0') AS totmon,
                 coalesce(nullif(trim(m.mbsal), ''), '0') AS full_basic,
                 (coalesce(nullif(trim(m.mhrant), ''), '0')::numeric
                  + coalesce(nullif(trim(m.mconv), ''), '0')::numeric
                  + coalesce(nullif(trim(m.mutil), ''), '0')::numeric
                  + coalesce(nullif(trim(m.motall), ''), '0')::numeric
                  + coalesce(nullif(trim(m.mmess), ''), '0')::numeric)::text AS full_allow,
                 coalesce(nullif(trim(d.abs), ''), '0') AS absent,
                 trim(m.svno) AS svno,
                 m.row_id AS vrow,
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
                 ${pc.sta ? `coalesce(nullif(trim(p.${pc.sta}), ''), 'A')` : `'A'`} AS sta,
                 ${pc.site ? `coalesce(trim(p.${pc.site}), '')` : `''`} AS "siteCode",
                 $1::text AS month,
                 left(coalesce(${pc.join ? `p.${pc.join}::text` : `''`}, ''), 10) AS "rowDate",
                 left(coalesce(${pc.join ? `p.${pc.join}::text` : `''`}, ''), 10) AS "joinDate",
                 ${pc.salary ? `coalesce(p.${pc.salary}::text, '0')` : `'0'`} AS basic,
                 '0' AS spall,
                 '0' AS mess,
                 '0' AS mna,
                 '0' AS loan,
                 '0' AS adva,
                 '0' AS itax,
                 '0' AS totmon,
                 ${pc.salary ? `coalesce(p.${pc.salary}::text, '0')` : `'0'`} AS full_basic,
                 '0' AS full_allow,
                 '0' AS absent,
                 '' AS svno,
                 0::bigint AS vrow,
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
          sta: string;
          siteCode: string;
          month: string;
          rowDate: string;
          joinDate: string;
          basic: string;
          spall: string;
          mess: string;
          mna: string;
          loan: string;
          adva: string;
          itax: string;
          totmon: string;
          full_basic: string;
          full_allow: string;
          absent: string;
          svno: string;
          has_voucher: string;
        }>(
          `SELECT * FROM (${combined}) sheet
           ORDER BY has_voucher DESC,
                    vrow DESC,
                    length(regexp_replace(trim(code), '\\D', '', 'g')) DESC,
                    regexp_replace(trim(code), '\\D', '', 'g') DESC NULLS LAST,
                    name, code
           LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          [...params, size, offset],
        );

        const mapped = rows.rows.map((r) => {
          const posted = Number(r.has_voucher) === 1;
          // salaryd.salary is already pro-rated for absents; mbsal + allowances is the full month.
          const earned = round2(moneyNum(r.basic));
          const extras = moneyNum(r.spall) + moneyNum(r.mess) + moneyNum(r.mna);
          const basic = round2(moneyNum(r.full_basic) || earned);
          const fullAllow = moneyNum(r.full_allow);
          const allowances = round2(fullAllow + extras);
          const absentCut = posted ? round2(Math.max(0, basic + fullAllow - earned)) : 0;
          const deductions = round2(
            Math.abs(moneyNum(r.loan)) +
              Math.abs(moneyNum(r.adva)) +
              Math.abs(moneyNum(r.itax)),
          );
          const net = round2(earned + extras - deductions);
          return {
            absentDays: posted ? round2(moneyNum(r.absent)) : 0,
            absentCut,
            gross: round2(earned + extras),
            security: round2(Math.abs(moneyNum(r.loan))),
            transport: round2(Math.abs(moneyNum(r.itax))),
            code: r.code || '',
            name: r.name || r.code || '',
            designation: r.designation || '',
            empType: this.reguLabel(r.empType || ''),
            paymentMode: this.paymodLabel(r.paymentMode || ''),
            siteCode: r.siteCode || '',
            campus: r.siteCode || '',
            month: r.month || period,
            date: r.rowDate || '',
            joinDate: r.joinDate || '',
            basic,
            allowances,
            deductions,
            net,
            salary: basic,
            status: Number(r.has_voucher) ? 'Posted' : 'Not posted',
            voucherNo: r.svno || '',
            sta: String(r.sta || 'A'),
            empActive: this.isStaActive(String(r.sta || 'A')),
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
      empActive,
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
      '',
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
    // Soft-deactivate instead of hard delete (payroll Active/Inactive).
    return this.setEmployeeActive(username, codeRaw, false);
  }

  /**
   * Toggle employment flag on persona.sta (A = Active, I = Inactive).
   * Salary generate only posts employees with sta = A.
   */
  async setEmployeeActive(username: string, codeRaw: string, active: boolean) {
    if (!(await this.tableExists('persona'))) {
      return { ok: false, message: 'Employee table (persona) not found.' };
    }
    const cols = await this.columns('persona');
    const pc = this.personaCols(cols);
    if (!pc.code) return { ok: false, message: 'Employee code column missing.' };
    if (!pc.sta) return { ok: false, message: 'Employee active flag (sta) column missing.' };
    const code = String(codeRaw || '').trim();
    if (!code) return { ok: false, message: 'Employee code required.' };
    const next = active ? 'A' : 'I';
    const result = await this.database.query(
      `UPDATE persona SET ${pc.sta} = $1 WHERE trim(${pc.code}) = $2`,
      [next, code],
    );
    if (!result.rowCount) return { ok: false, message: 'Employee not found.' };
    void username;
    return {
      ok: true,
      message: active
        ? `Employee ${code} set to Active.`
        : `Employee ${code} set to Inactive.`,
      code,
      active,
      sta: next,
    };
  }

  private monthInfo(mont: string) {
    const raw = String(mont || '').replace(/\D/g, '');
    if (raw.length !== 6) return null;
    const mm = Number(raw.slice(0, 2));
    const yyyy = Number(raw.slice(2));
    if (!mm || mm > 12 || yyyy < 2000) return null;
    const days = new Date(yyyy, mm, 0).getDate();
    const m2 = String(mm).padStart(2, '0');
    return {
      mont: `${m2}${yyyy}`,
      days,
      from: `${yyyy}-${m2}-01 00:00:00`,
      to: `${yyyy}-${m2}-${String(days).padStart(2, '0')} 00:00:00`,
    };
  }

  /** ESS posts support staff to 410104, everyone else to 410101, unless history says otherwise. */
  private salaryExpenseCode(designation: string, lastCode: string) {
    if (lastCode) return lastCode;
    const support =
      /guard|driver|aya|ayya|sweeper|gard[e]?n|electric|helper|office boy|peon|imam|shop|transport|welder|cook|mali|chowkidar|watchman|cleaner/i;
    return support.test(designation) ? '410104' : '410101';
  }

  private salaryFigures(
    p: SalaryBase,
    days: number,
    input: { absent?: unknown; leave?: unknown; security?: unknown; transport?: unknown },
  ) {
    const absent = Math.max(0, Math.round(moneyNum(input.absent)));
    const leave = Math.max(0, Math.round(moneyNum(input.leave)));
    const security = Math.max(0, Math.round(moneyNum(input.security)));
    const transport = Math.max(0, Math.round(moneyNum(input.transport)));
    const fixed =
      p.basic + p.houseRent + p.conveyance + p.utility + p.mess + p.otherAllowance;
    const worked = Math.min(Math.max(days - absent, 0), days);
    const gross = Math.round((fixed * worked) / days);
    const net = gross - security - transport;
    return { absent, leave, security, transport, fixed, gross, net };
  }

  private async salaryBases(
    scope: string,
    mont: string,
    codes: string[] | null,
    run: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, string>[] }>,
  ): Promise<SalaryBase[]> {
    if (!(await this.tableExists('persona'))) return [];
    const cols = await this.columns('persona');
    const pc = this.personaCols(cols);
    if (!pc.code || !pc.name) return [];

    const siteCol = pc.site || '';
    const basicCol = this.pick(cols, ['bsalary', 'salary', 'basic', 'pay', 'gross']);
    const hrentCol = this.pick(cols, ['hrent', 'houserent', 'hr']);
    const convCol = this.pick(cols, ['convan', 'conveyance', 'conv']);
    const utilCol = this.pick(cols, ['utility', 'util']);
    const messCol = this.pick(cols, ['mess']);
    const oallCol = this.pick(cols, ['oall', 'otherall', 'oallow']);
    const lrateCol = this.pick(cols, ['lrate', 'loanrate', 'security']);
    const payCodeCol = this.pick(cols, ['adcode', 'paycode', 'acode']);
    const secCodeCol = this.pick(cols, ['lcode', 'seccode']);
    const trnCodeCol = this.pick(cols, ['mscode', 'trnscode', 'tcode']);

    const hasSalarym = await this.tableExists('salarym');
    const hasSalaryd = hasSalarym && (await this.tableExists('salaryd'));
    const smCols = hasSalarym ? await this.columns('salarym') : new Set<string>();
    const sdCols = hasSalaryd ? await this.columns('salaryd') : new Set<string>();
    const smOrder = smCols.has('row_id') ? 'm.row_id DESC' : 'm.ctid DESC';

    const params: unknown[] = [mont, scope];
    let codeFilter = '';
    if (codes) {
      params.push(codes);
      codeFilter = `AND trim(p.${pc.code}) = ANY($${params.length}::text[])`;
    }

    const staFilter = pc.sta
      ? `AND upper(coalesce(nullif(trim(p.${pc.sta}), ''), 'A')) = 'A'`
      : '';
    const leftFilter = pc.left
      ? `AND (
           p.${pc.left} IS NULL
           OR nullif(btrim(p.${pc.left}::text), '') IS NULL
           OR left(btrim(p.${pc.left}::text), 10) IN ('0001-01-01', '1900-01-01')
         )`
      : '';
    const siteFilter = siteCol
      ? `AND (
           $2 = ''
           OR coalesce(trim(p.${siteCol}), '') = ''
           OR trim(p.${siteCol}) LIKE $2 || '%'
           OR $2 LIKE trim(p.${siteCol}) || '%'
         )`
      : '';

    // LATERAL last voucher — avoids scanning full salary history for every employee up front.
    const lastJoin =
      hasSalarym && hasSalaryd && smCols.has('ecode') && smCols.has('mont') && smCols.has('svno')
        ? `LEFT JOIN LATERAL (
             SELECT coalesce(trim(m.excode), '') AS excode,
                    coalesce(nullif(trim(${sdCols.has('loan') ? 'd.loan' : `''`}), ''), '0') AS loan,
                    coalesce(nullif(trim(${sdCols.has('itax') ? 'd.itax' : `''`}), ''), '0') AS itax
             FROM salarym m
             ${sdCols.has('svno') ? 'JOIN salaryd d ON trim(d.svno) = trim(m.svno)' : 'LEFT JOIN salaryd d ON false'}
             WHERE trim(m.ecode) = trim(p.${pc.code})
               AND length(coalesce(trim(m.mont), '')) = 6
             ORDER BY right(trim(m.mont), 4) DESC, left(trim(m.mont), 2) DESC, ${smOrder}
             LIMIT 1
           ) l ON true`
        : `LEFT JOIN LATERAL (SELECT ''::text AS excode, '0'::text AS loan, '0'::text AS itax) l ON true`;

    const postedExpr = hasSalarym
      ? `EXISTS (
           SELECT 1 FROM salarym sm
           WHERE trim(sm.ecode) = trim(p.${pc.code}) AND trim(sm.mont) = $1
         )`
      : 'false';

    const res = await run(
      `SELECT trim(p.${pc.code}) AS code,
              coalesce(nullif(trim(p.${pc.name}), ''), trim(p.${pc.code})) AS name,
              ${pc.design ? `coalesce(trim(p.${pc.design}), '')` : `''`} AS designation,
              ${siteCol ? `coalesce(trim(p.${siteCol}), '')` : `''`} AS "siteCode",
              coalesce(
                nullif(trim(a.ahead), ''),
                ${siteCol ? `coalesce(trim(p.${siteCol}), '')` : `''`}
              ) AS campus,
              ${pc.regu ? `coalesce(trim(p.${pc.regu}), '')` : `''`} AS regu,
              ${basicCol ? `coalesce(p.${basicCol}::text, '0')` : `'0'`} AS basic,
              ${hrentCol ? `coalesce(p.${hrentCol}::text, '0')` : `'0'`} AS "houseRent",
              ${convCol ? `coalesce(p.${convCol}::text, '0')` : `'0'`} AS conveyance,
              ${utilCol ? `coalesce(p.${utilCol}::text, '0')` : `'0'`} AS utility,
              ${messCol ? `coalesce(p.${messCol}::text, '0')` : `'0'`} AS mess,
              ${oallCol ? `coalesce(p.${oallCol}::text, '0')` : `'0'`} AS "otherAllowance",
              ${lrateCol ? `coalesce(p.${lrateCol}::text, '0')` : `'0'`} AS lrate,
              ${payCodeCol ? `coalesce(trim(p.${payCodeCol}), '')` : `''`} AS "payableCode",
              ${secCodeCol ? `coalesce(trim(p.${secCodeCol}), '')` : `''`} AS "securityCode",
              ${trnCodeCol ? `coalesce(trim(p.${trnCodeCol}), '')` : `''`} AS "transportCode",
              coalesce(l.excode, '') AS "lastExpense",
              l.loan AS "lastSecurity",
              l.itax AS "lastTransport",
              ${postedExpr} AS posted
       FROM persona p
       LEFT JOIN acc a ON ${siteCol ? `trim(a.acode) = trim(p.${siteCol})` : 'false'}
       ${lastJoin}
       WHERE coalesce(trim(p.${pc.code}), '') <> ''
         ${staFilter}
         ${leftFilter}
         ${siteFilter}
         ${codeFilter}
       ORDER BY campus, name`,
      params,
    );
    return res.rows.map((r) => ({
      code: r.code,
      name: r.name || r.code,
      designation: r.designation,
      siteCode: r.siteCode,
      campus: r.campus,
      regu: r.regu,
      basic: Math.round(moneyNum(r.basic)),
      houseRent: Math.round(moneyNum(r.houseRent)),
      conveyance: Math.round(moneyNum(r.conveyance)),
      utility: Math.round(moneyNum(r.utility)),
      mess: Math.round(moneyNum(r.mess)),
      otherAllowance: Math.round(moneyNum(r.otherAllowance)),
      payableCode: r.payableCode,
      securityCode: r.securityCode,
      transportCode: r.transportCode || '310201',
      expenseCode: this.salaryExpenseCode(r.designation, r.lastExpense),
      security: Math.round(
        r.lastSecurity != null ? moneyNum(r.lastSecurity) : moneyNum(r.lrate),
      ),
      transport: Math.round(moneyNum(r.lastTransport)),
      posted: (() => {
        const v = r.posted as unknown;
        if (v === true || v === 1) return true;
        const s = String(v ?? '').trim().toLowerCase();
        return s === 'true' || s === 't' || s === '1';
      })(),
    }));
  }

  private salaryBlockReason(p: SalaryBase, fig: { security: number; net: number }) {
    if (p.posted) return 'Salary already posted for this month.';
    if (!p.payableCode) return 'Salary payable account missing in employee profile.';
    if (p.basic <= 0) return 'Basic salary is 0 in employee profile.';
    if (fig.security > 0 && !p.securityCode) return 'Security account missing in employee profile.';
    if (fig.net < 0) return 'Deductions are more than salary.';
    return '';
  }

  async salaryGenerateDraft(username: string, site: string, mont: string) {
    const info = this.monthInfo(mont);
    if (!info) return { ok: false, message: 'Select a valid month.', rows: [] };
    try {
      const scope = await this.siteScope(username, site);
      const bases = await this.salaryBases(scope, info.mont, null, (sql, p) =>
        this.database.query<Record<string, string>>(sql, p),
      );
      const pending = bases.filter((b) => !b.posted);
      const rows = pending.map((b) => {
        const fig = this.salaryFigures(b, info.days, b);
        const reason = this.salaryBlockReason(b, fig);
        return {
          code: b.code,
          name: b.name,
          designation: b.designation,
          siteCode: b.siteCode,
          campus: b.campus,
          empType: this.reguLabel(b.regu),
          basic: b.basic,
          allowances: fig.fixed - b.basic,
          fixed: fig.fixed,
          security: fig.security,
          transport: fig.transport,
          gross: fig.gross,
          net: fig.net,
          canPost: !reason,
          reason,
        };
      });
      return {
        ok: true,
        mont: info.mont,
        days: info.days,
        postedCount: bases.length - pending.length,
        rows,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Salary generate failed: ${detail}`.slice(0, 280),
        rows: [],
        postedCount: 0,
      };
    }
  }

  async salaryGeneratePost(
    username: string,
    body: {
      mont?: string;
      site?: string;
      rows?: { code?: string; absent?: unknown; leave?: unknown; security?: unknown; transport?: unknown }[];
    },
  ) {
    const info = this.monthInfo(String(body.mont || ''));
    if (!info) return { ok: false, message: 'Select a valid month.' };
    const input = (Array.isArray(body.rows) ? body.rows : [])
      .map((r) => ({ ...r, code: String(r.code || '').trim() }))
      .filter((r) => r.code);
    if (!input.length) return { ok: false, message: 'Select at least one employee.' };
    if (input.length > 1000) return { ok: false, message: 'Too many employees in one save.' };
    const scope = await this.siteScope(username, String(body.site || ''));
    const user = String(username || '').trim() || 'ERP';

    return this.database.withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('payroll_salary_post'))`);
      const bases = await this.salaryBases(
        scope,
        info.mont,
        input.map((r) => r.code),
        (sql, p) => client.query<Record<string, string>>(sql, p),
      );
      const byCode = new Map(bases.map((b) => [b.code, b]));

      const seq = await client.query<{ n: string }>(
        `SELECT greatest(
           (SELECT coalesce(max(substring(trim(svno) from '^([0-9]+)Y$')::bigint), 0)
              FROM salarym WHERE trim(svno) ~ '^[0-9]+Y$'),
           (SELECT coalesce(max(substring(trim(invno) from '^([0-9]+)Y1$')::bigint), 0)
              FROM accmast WHERE trim(invno) ~ '^[0-9]+Y1$')
         )::text AS n`,
      );
      let next = Number(seq.rows[0]?.n) || 0;
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const edate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      const created: { code: string; name: string; svno: string; jvno: string; net: number }[] = [];
      const skipped: { code: string; reason: string }[] = [];

      for (const row of input) {
        const p = byCode.get(row.code);
        if (!p) {
          skipped.push({ code: row.code, reason: 'Employee not active or outside your zone.' });
          continue;
        }
        const fig = this.salaryFigures(p, info.days, row);
        if (fig.absent > info.days) {
          skipped.push({ code: row.code, reason: `Absent days more than ${info.days}.` });
          continue;
        }
        const reason = this.salaryBlockReason(p, fig);
        if (reason) {
          skipped.push({ code: row.code, reason });
          continue;
        }

        next += 1;
        const svno = `${String(next).padStart(6, '0')}Y`;
        const jvno = `${next}Y1`;

        await client.query(
          `INSERT INTO salarym (
             svno, ecode, mont, mbsal, mhrant, mconv, mutil, motall, mmess, mspal, totmon,
             excode, pacode, locode, est, mscode, pflag, zcode
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'0',$10,$11,$12,$13,$14,$15,'O',$16)`,
          [
            svno,
            p.code,
            info.mont,
            String(p.basic),
            String(p.houseRent),
            String(p.conveyance),
            String(p.utility),
            String(p.otherAllowance),
            String(p.mess),
            String(info.days),
            p.expenseCode,
            p.payableCode,
            p.securityCode || null,
            p.regu || null,
            p.transportCode,
            p.siteCode,
          ],
        );
        await client.query(
          `INSERT INTO salaryd (
             svno, fdate, tdate, totday, abs, leav, salary, spall, loan, adva, itax, stcode, ebo, jvno
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'0',$8,'0',$9,$10,'0',$11)`,
          [
            svno,
            info.from,
            info.to,
            String(info.days),
            String(fig.absent),
            String(fig.leave),
            String(fig.gross),
            String(fig.security),
            String(fig.transport),
            p.siteCode,
            jvno,
          ],
        );
        await client.query(
          `INSERT INTO accmast (invno, invdate, ccode, pflag, edate, uname, tflag)
           VALUES ($1,$2,$3,'P',$4,$5,'1')`,
          [jvno, info.to, p.siteCode, edate, user],
        );
        const lines: [string, string, string, string][] = [
          [String(fig.gross), '0', p.expenseCode, `${p.name}Salary For the ${info.mont}`],
        ];
        if (fig.transport > 0) {
          lines.push(['0', String(fig.transport), p.transportCode, `${p.name} Tranport Revenue For the ${info.mont}`]);
        }
        if (fig.net > 0) {
          lines.push(['0', String(fig.net), p.payableCode, `${p.campus} Net Salary For the ${info.mont}`]);
        }
        if (fig.security > 0) {
          lines.push(['0', String(fig.security), p.securityCode, `${p.name} Loan Deduction  For the ${info.mont}`]);
        }
        for (const [dr, cr, acode, snar] of lines) {
          await client.query(
            `INSERT INTO accdet (invno, dr, cr, acode, snar) VALUES ($1,$2,$3,$4,$5)`,
            [jvno, dr, cr, acode, snar],
          );
        }
        created.push({ code: p.code, name: p.name, svno, jvno, net: fig.net });
      }

      const total = created.reduce((s, r) => s + r.net, 0);
      return {
        ok: created.length > 0,
        message: created.length
          ? `${created.length} salary posted for ${info.mont} · net ${total.toLocaleString('en-PK')}${skipped.length ? ` · ${skipped.length} skipped` : ''}.`
          : skipped[0]?.reason || 'Nothing posted.',
        created,
        skipped,
      };
    });
  }
}

type SalaryBase = {
  code: string;
  name: string;
  designation: string;
  siteCode: string;
  campus: string;
  regu: string;
  basic: number;
  houseRent: number;
  conveyance: number;
  utility: number;
  mess: number;
  otherAllowance: number;
  payableCode: string;
  securityCode: string;
  transportCode: string;
  expenseCode: string;
  security: number;
  transport: number;
  posted: boolean;
};
