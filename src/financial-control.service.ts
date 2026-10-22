import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ActivityLogService } from './activity-log.service';
import { DatabaseService } from './database.service';

export type TbNode = {
  code: string;
  name: string;
  debit: number;
  credit: number;
  balance: number;
  flag: string;
  children: TbNode[];
};

/** Avoid trim() on join/filter columns — it disables btree indexes (was ~3s → ~0.4s). */
const NUM = (alias: string, col: string) =>
  `CASE WHEN coalesce(${alias}.${col}, '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${alias}.${col}::numeric ELSE 0 END`;

/** Header filter columns over the fee voucher `base` CTE (Fee Collection / Fee Register). */
const FEE_VOUCHER_COLS = {
  date: { expr: 'b.invdate', type: 'date' },
  invno: { expr: 'b.invno', type: 'like' },
  mont: { expr: 'trim(b.mont)', type: 'exact' },
  sdno: { expr: 'b.sdno', type: 'like' },
  studentName: { expr: 'b."studentName"', type: 'like' },
  siteName: { expr: 'b."siteName"', type: 'exact' },
  narration: { expr: 'b.narr', type: 'like' },
  amount: { expr: 'b.amount', type: 'num' },
} as const;

const FEE_REGISTER_COLS = {
  ...FEE_VOUCHER_COLS,
  paid: { expr: `CASE WHEN b.paid THEN 'PAID' ELSE 'UNPAID' END`, type: 'exact' },
} as const;

/** A fee bill (…G) is paid when a receipt (…F) with the same number exists. */
const G_PAID_SQL = (alias: string) =>
  `EXISTS (SELECT 1 FROM accmast fx WHERE fx.invno = left(trim(${alias}.invno), length(trim(${alias}.invno)) - 1) || 'F')`;

type DefaulterOut = {
  sdno: string;
  name: string;
  status: string;
  classCode?: string;
  className?: string;
  sectionName?: string;
  campus: string;
  fromDate: string;
  toDate: string;
  fromMont: string;
  toMont: string;
  outstanding: number;
  bankCode?: string;
  bankName?: string;
};

const DEFAULTER_COLS = {
  sdno: { get: (r: DefaulterOut) => r.sdno, type: 'like' },
  name: { get: (r: DefaulterOut) => r.name, type: 'like' },
  status: { get: (r: DefaulterOut) => r.status, type: 'exact' },
  fromDate: { get: (r: DefaulterOut) => r.fromDate, type: 'date' },
  toDate: { get: (r: DefaulterOut) => r.toDate, type: 'date' },
  fromMont: {
    get: (r: DefaulterOut) => [r.fromMont, r.toMont].filter(Boolean).join(' — '),
    type: 'like',
  },
  campus: { get: (r: DefaulterOut) => r.campus, type: 'exact' },
  className: { get: (r: DefaulterOut) => r.className, type: 'exact' },
  sectionName: { get: (r: DefaulterOut) => r.sectionName, type: 'exact' },
  outstanding: { get: (r: DefaulterOut) => r.outstanding, type: 'num' },
  bankCode: { get: (r: DefaulterOut) => r.bankCode, type: 'like' },
  bankName: { get: (r: DefaulterOut) => r.bankName, type: 'exact' },
} as const;

function defaulterOptions(rows: DefaulterOut[]) {
  const classes = new Map<string, string>();
  for (const r of rows) if (r.className && !classes.has(r.className)) classes.set(r.className, r.classCode || '');
  return {
    campus: distinctSorted(rows.map((r) => r.campus)),
    className: [...classes.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([name]) => name),
    sectionName: distinctSorted(rows.map((r) => r.sectionName)),
    status: distinctSorted(rows.map((r) => r.status)),
    bankName: distinctSorted(rows.map((r) => r.bankName)),
  };
}

@Injectable()
export class FinancialControlService {
  constructor(
    private readonly database: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private readonly debitSql = NUM('d', 'dr');
  private readonly creditSql = NUM('d', 'cr');

  /** Lexicographic range on text invdate ('YYYY-MM-DD …'). toExclusive = day after toDate. */
  /** Replace class codes with class names and add section names from the student record. */
  private async withClassSection<
    T extends { sdno: string; className?: string; sectionName?: string; classCode?: string },
  >(rows: T[]) {
    const sdnos = [...new Set(rows.map((r) => r.sdno).filter(Boolean))];
    if (!sdnos.length) return rows;
    const info = await this.database.query<{
      sdno: string;
      classCode: string;
      className: string;
      sectionName: string;
    }>(
      `SELECT trim(st.sdno) AS sdno,
              coalesce(trim(st.class), '') AS "classCode",
              coalesce(nullif(trim(cl.ahead), ''), trim(st.class), '') AS "className",
              coalesce(nullif(trim(se.ahead), ''), '') AS "sectionName"
       FROM student st
       LEFT JOIN acc cl ON cl.acode = st.class
       LEFT JOIN acc se ON se.acode = coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), ''))
       WHERE st.sdno = ANY($1::text[])`,
      [sdnos],
    );
    const bySdno = new Map(info.rows.map((r) => [r.sdno, r]));
    for (const row of rows) {
      const hit = bySdno.get(row.sdno);
      row.classCode = hit?.classCode || row.className || '';
      row.className = hit?.className || row.className || '';
      row.sectionName = hit?.sectionName || '';
    }
    return rows;
  }

  /** "class": class (school order) → section → highest outstanding; default: highest outstanding. */
  private sortDefaulters<T extends { classCode?: string; sectionName?: string; outstanding: number }>(
    rows: T[],
    sort: string,
  ) {
    if (sort !== 'class') return rows;
    return [...rows].sort(
      (a, b) =>
        (a.classCode || '~').localeCompare(b.classCode || '~') ||
        (a.sectionName || '~').localeCompare(b.sectionName || '~', undefined, { sensitivity: 'base' }) ||
        b.outstanding - a.outstanding,
    );
  }

  private periodBounds(fromDate: string, toDate: string) {
    const from = this.normDate(fromDate) || this.monthStart();
    const to = this.normDate(toDate) || this.today();
    return { from, to, toExclusive: this.nextDay(to) };
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

  async accounts(q = '', limit = 500, scope = '') {
    const search = q.trim().replace(/%/g, '');
    const size = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const feeScope = scope.trim().toLowerCase() === 'fee';
    const rows = await this.database.query<{
      code: string;
      name: string;
      flag: string;
    }>(
      `SELECT trim(a.acode) AS code,
              coalesce(nullif(trim(a.ahead), ''), trim(a.acode)) AS name,
              coalesce(trim(a.flag), '') AS flag
       FROM acc a
       WHERE coalesce(trim(a.acode), '') <> ''
         AND (
           NOT $3::boolean
           OR a.acode LIKE '150201%'
           OR a.acode LIKE '1506%'
         )
         AND (
           $1 = ''
           OR a.acode ILIKE '%' || $1 || '%'
           OR a.ahead ILIKE '%' || $1 || '%'
         )
       ORDER BY
         CASE WHEN $3::boolean THEN a.acode ELSE upper(trim(a.ahead)) END,
         a.acode
       LIMIT $2`,
      [search, size, feeScope],
    );
    return rows.rows;
  }

  async trialBalance(
    username: string,
    site: string,
    fromDate: string,
    toDate: string,
    q = '',
  ) {
    const scope = await this.siteScope(username, site);
    const { from, to, toExclusive } = this.periodBounds(fromDate, toDate);
    const search = q.trim().replace(/%/g, '');

    const leaf = await this.database.query<{
      acode: string;
      debit: string;
      credit: string;
    }>(
      `SELECT d.acode AS acode,
              coalesce(sum(${this.debitSql}), 0)::text AS debit,
              coalesce(sum(${this.creditSql}), 0)::text AS credit
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       WHERE m.invdate >= $1 AND m.invdate < $2
         AND ($3 = '' OR m.ccode LIKE $3 || '%')
         AND coalesce(d.acode, '') <> ''
       GROUP BY d.acode`,
      [from, toExclusive, scope],
    );

    const balMap = new Map<string, { debit: number; credit: number }>();
    for (const row of leaf.rows) {
      const code = row.acode.trim();
      if (!code) continue;
      const debit = Number(row.debit) || 0;
      const credit = Number(row.credit) || 0;
      if (!debit && !credit) continue;
      balMap.set(code, { debit, credit });
      // roll up to every parent prefix used in COA (1, 11, 1101, …)
      for (const parent of this.parentCodes(code)) {
        const cur = balMap.get(parent) || { debit: 0, credit: 0 };
        cur.debit += debit;
        cur.credit += credit;
        balMap.set(parent, cur);
      }
    }

    const codes = [...balMap.keys()];
    if (!codes.length) {
      return {
        roots: [] as TbNode[],
        totals: { debit: 0, credit: 0, balance: 0 },
        meta: { site: scope, fromDate: from, toDate: to, accountCount: 0 },
      };
    }

    const heads = await this.database.query<{
      code: string;
      name: string;
      flag: string;
    }>(
      `SELECT trim(acode) AS code,
              coalesce(nullif(trim(ahead), ''), trim(acode)) AS name,
              coalesce(trim(flag), '') AS flag
       FROM acc
       WHERE trim(acode) = ANY($1::text[])`,
      [codes],
    );
    const nameMap = new Map(
      heads.rows.map((h) => [h.code, { name: h.name, flag: h.flag }]),
    );

    const nodeMap = new Map<string, TbNode>();
    for (const [code, bal] of balMap) {
      const meta = nameMap.get(code);
      if (search) {
        const hay = `${code} ${meta?.name || ''}`.toLowerCase();
        if (!hay.includes(search.toLowerCase()) && !this.hasMatchingDescendant(code, balMap, nameMap, search)) {
          // keep ancestors of matches — filter after tree build
        }
      }
      nodeMap.set(code, {
        code,
        name: meta?.name || code,
        debit: round2(bal.debit),
        credit: round2(bal.credit),
        balance: round2(bal.debit - bal.credit),
        flag: meta?.flag || '',
        children: [],
      });
    }

    const roots: TbNode[] = [];
    const sorted = [...nodeMap.values()].sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true }),
    );
    for (const node of sorted) {
      const parent = this.nearestParent(node.code, nodeMap);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    const filtered = search
      ? this.filterTree(roots, search)
      : roots.filter((n) => n.code.length === 1 || ['1', '2', '3', '4'].includes(n.code));

    // Prefer top-level 1/2/3/4 when no search
    const displayRoots = search
      ? filtered
      : ['1', '2', '3', '4']
          .map((c) => nodeMap.get(c))
          .filter((n): n is TbNode => Boolean(n));

    const totals = displayRoots.reduce(
      (acc, n) => {
        acc.debit += n.debit;
        acc.credit += n.credit;
        acc.balance += n.balance;
        return acc;
      },
      { debit: 0, credit: 0, balance: 0 },
    );

    return {
      roots: displayRoots,
      totals: {
        debit: round2(totals.debit),
        credit: round2(totals.credit),
        balance: round2(totals.balance),
      },
      meta: {
        site: scope,
        fromDate: from,
        toDate: to,
        accountCount: balMap.size,
      },
    };
  }

  /**
   * Ledger lines with header filters: running balance is computed over the whole period
   * first, so a filtered line still shows its true balance.
   */
  private async filteredLedger(
    account: { code: string; name: string; flag: string },
    acodeSql: string,
    baseParams: unknown[],
    openBal: number,
    colFilters: Record<string, string>,
    current: number,
    size: number,
    meta: { site: string; fromDate: string; toDate: string },
  ) {
    const params: unknown[] = [...baseParams, openBal];
    const baseSql = `SELECT d.invno AS invno,
              left(m.invdate, 10) AS invdate,
              coalesce(nullif(trim(d.snar), ''), nullif(trim(m.nar), ''), '') AS narr,
              (${this.debitSql}) AS debit,
              (${this.creditSql}) AS credit,
              $5::numeric + sum(${this.debitSql} - ${this.creditSql})
                OVER (ORDER BY m.invdate, d.row_id) AS balance,
              coalesce(m.ccode, '') AS "siteCode",
              coalesce(m.mont, '') AS mont,
              m.invdate AS ord_date,
              d.row_id AS ord_id
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       WHERE ${acodeSql}
         AND m.invdate >= $2 AND m.invdate < $3
         AND ($4 = '' OR m.ccode LIKE $4 || '%')`;
    const colWhere = colFilterOutSql(
      colFilters,
      {
        date: { expr: 'b.invdate', type: 'date' },
        invno: { expr: 'b.invno', type: 'like' },
        narration: { expr: 'b.narr', type: 'like' },
        debit: { expr: 'b.debit', type: 'num' },
        credit: { expr: 'b.credit', type: 'num' },
        balance: { expr: 'b.balance', type: 'num' },
      },
      params,
    );
    const agg = await this.database.query<{ total: string; debit: string; credit: string }>(
      `WITH base AS (${baseSql})
       SELECT count(*)::text AS total,
              coalesce(sum(b.debit), 0)::text AS debit,
              coalesce(sum(b.credit), 0)::text AS credit
       FROM base b ${colWhere}`,
      params,
    );
    const lines = await this.database.query<{
      invno: string;
      invdate: string;
      narr: string;
      debit: string;
      credit: string;
      balance: string;
      siteCode: string;
      mont: string;
    }>(
      `WITH base AS (${baseSql})
       SELECT b.invno, b.invdate, b.narr, b.debit::text AS debit, b.credit::text AS credit,
              b.balance::text AS balance, b."siteCode", b.mont
       FROM base b ${colWhere}
       ORDER BY b.ord_date, b.ord_id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (current - 1) * size],
    );
    const pDebit = Number(agg.rows[0]?.debit) || 0;
    const pCredit = Number(agg.rows[0]?.credit) || 0;
    return {
      account,
      rows: lines.rows.map((row) => ({
        invno: row.invno,
        date: row.invdate,
        narration: row.narr,
        debit: round2(Number(row.debit) || 0),
        credit: round2(Number(row.credit) || 0),
        balance: round2(Number(row.balance) || 0),
        siteCode: row.siteCode,
        mont: row.mont,
      })),
      total: Number(agg.rows[0]?.total) || 0,
      page: current,
      pageSize: size,
      opening: round2(openBal),
      totals: {
        debit: round2(pDebit),
        credit: round2(pCredit),
        balance: round2(openBal + pDebit - pCredit),
      },
      meta,
    };
  }

  async ledger(
    username: string,
    acodeRaw: string,
    site: string,
    fromDate: string,
    toDate: string,
    page = 1,
    pageSize = 50,
    colFilters: Record<string, string> = {},
  ) {
    const acode = acodeRaw.trim();
    if (!acode) {
      return {
        account: null,
        rows: [],
        total: 0,
        page: 1,
        pageSize,
        opening: 0,
        totals: { debit: 0, credit: 0, balance: 0 },
      };
    }
    const scope = await this.siteScope(username, site);
    const { from, to, toExclusive } = this.periodBounds(fromDate, toDate);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;

    const head = await this.database.query<{
      code: string;
      name: string;
      flag: string;
    }>(
      `SELECT trim(acode) AS code, trim(ahead) AS name, coalesce(trim(flag),'') AS flag
       FROM acc WHERE acode = $1 LIMIT 1`,
      [acode],
    );

    // Group heads (e.g. 15 Current Assets) include all child postings via prefix.
    const acodeSql = `(d.acode = $1 OR d.acode LIKE $1 || '%')`;

    const opening = await this.database.query<{ bal: string }>(
      `SELECT coalesce(sum(${this.debitSql} - ${this.creditSql}), 0)::text AS bal
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       WHERE ${acodeSql}
         AND m.invdate < $2
         AND ($3 = '' OR m.ccode LIKE $3 || '%')`,
      [acode, from, scope],
    );
    const openBal = Number(opening.rows[0]?.bal) || 0;

    if (Object.values(colFilters).some((v) => String(v ?? '').trim())) {
      return this.filteredLedger(
        head.rows[0] || { code: acode, name: acode, flag: '' },
        acodeSql,
        [acode, from, toExclusive, scope],
        openBal,
        colFilters,
        current,
        size,
        { site: scope, fromDate: from, toDate: to },
      );
    }

    const count = await this.database.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       WHERE ${acodeSql}
         AND m.invdate >= $2 AND m.invdate < $3
         AND ($4 = '' OR m.ccode LIKE $4 || '%')`,
      [acode, from, toExclusive, scope],
    );

    const lines = await this.database.query<{
      invno: string;
      invdate: string;
      narr: string;
      debit: string;
      credit: string;
      siteCode: string;
      mont: string;
    }>(
      `SELECT d.invno AS invno,
              left(m.invdate, 10) AS invdate,
              coalesce(nullif(trim(d.snar), ''), nullif(trim(m.nar), ''), '') AS narr,
              (${this.debitSql})::text AS debit,
              (${this.creditSql})::text AS credit,
              coalesce(m.ccode, '') AS "siteCode",
              coalesce(m.mont, '') AS mont
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       WHERE ${acodeSql}
         AND m.invdate >= $2 AND m.invdate < $3
         AND ($4 = '' OR m.ccode LIKE $4 || '%')
       ORDER BY m.invdate, d.row_id
       LIMIT $5 OFFSET $6`,
      [acode, from, toExclusive, scope, size, offset],
    );

    let running = openBal;
    if (offset > 0) {
      const prior = await this.database.query<{ bal: string }>(
        `SELECT coalesce(sum(x.d - x.c), 0)::text AS bal FROM (
           SELECT ${this.debitSql} AS d, ${this.creditSql} AS c
           FROM accdet d
           JOIN accmast m ON m.invno = d.invno
           WHERE ${acodeSql}
             AND m.invdate >= $2 AND m.invdate < $3
             AND ($4 = '' OR m.ccode LIKE $4 || '%')
           ORDER BY m.invdate, d.row_id
           LIMIT $5
         ) x`,
        [acode, from, toExclusive, scope, offset],
      );
      running = openBal + (Number(prior.rows[0]?.bal) || 0);
    }

    const rows = lines.rows.map((row) => {
      const debit = Number(row.debit) || 0;
      const credit = Number(row.credit) || 0;
      running += debit - credit;
      return {
        invno: row.invno,
        date: row.invdate,
        narration: row.narr,
        debit: round2(debit),
        credit: round2(credit),
        balance: round2(running),
        siteCode: row.siteCode,
        mont: row.mont,
      };
    });

    const period = await this.database.query<{
      debit: string;
      credit: string;
    }>(
      `SELECT coalesce(sum(${this.debitSql}), 0)::text AS debit,
              coalesce(sum(${this.creditSql}), 0)::text AS credit
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       WHERE ${acodeSql}
         AND m.invdate >= $2 AND m.invdate < $3
         AND ($4 = '' OR m.ccode LIKE $4 || '%')`,
      [acode, from, toExclusive, scope],
    );
    const pDebit = Number(period.rows[0]?.debit) || 0;
    const pCredit = Number(period.rows[0]?.credit) || 0;

    return {
      account: head.rows[0] || { code: acode, name: acode, flag: '' },
      rows,
      total: Number(count.rows[0]?.total) || 0,
      page: current,
      pageSize: size,
      opening: round2(openBal),
      totals: {
        debit: round2(pDebit),
        credit: round2(pCredit),
        balance: round2(openBal + pDebit - pCredit),
      },
      meta: { site: scope, fromDate: from, toDate: to },
    };
  }

  async cashBook(
    username: string,
    site: string,
    fromDate: string,
    toDate: string,
    account = '150601',
    page = 1,
    pageSize = 50,
    colFilters: Record<string, string> = {},
  ) {
    const code = account.trim() || '150601';
    return this.ledger(username, code, site, fromDate, toDate, page, pageSize, colFilters);
  }

  async bankSummary(username: string, site: string, fromDate: string, toDate: string) {
    const scope = await this.siteScope(username, site);
    const { from, to, toExclusive } = this.periodBounds(fromDate, toDate);

    const rows = await this.database.query<{
      code: string;
      name: string;
      debit: string;
      credit: string;
    }>(
      `SELECT d.acode AS code,
              coalesce(max(a.ahead), d.acode) AS name,
              coalesce(sum(${this.debitSql}), 0)::text AS debit,
              coalesce(sum(${this.creditSql}), 0)::text AS credit
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       LEFT JOIN acc a ON a.acode = d.acode
       WHERE d.acode LIKE '150602%'
         AND m.invdate >= $1 AND m.invdate < $2
         AND ($3 = '' OR m.ccode LIKE $3 || '%')
       GROUP BY d.acode
       ORDER BY d.acode`,
      [from, toExclusive, scope],
    );

    const list = rows.rows.map((r) => {
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      return {
        code: r.code,
        name: r.name,
        debit: round2(debit),
        credit: round2(credit),
        balance: round2(debit - credit),
      };
    });
    const totals = list.reduce(
      (acc, r) => {
        acc.debit += r.debit;
        acc.credit += r.credit;
        acc.balance += r.balance;
        return acc;
      },
      { debit: 0, credit: 0, balance: 0 },
    );
    return {
      rows: list,
      totals: {
        debit: round2(totals.debit),
        credit: round2(totals.credit),
        balance: round2(totals.balance),
      },
      meta: { site: scope, fromDate: from, toDate: to },
    };
  }

  /**
   * C.E — Ledger Sitewise: selected account head totals broken by campus (ccode).
   */
  async ledgerSitewise(
    username: string,
    acodeRaw: string,
    site: string,
    fromDate: string,
    toDate: string,
  ) {
    const acode = acodeRaw.trim();
    if (!acode) {
      return {
        rows: [],
        totals: { debit: 0, credit: 0, balance: 0 },
        meta: { site: '', fromDate: '', toDate: '', acode: '' },
      };
    }
    const scope = await this.siteScope(username, site);
    const { from, to, toExclusive } = this.periodBounds(fromDate, toDate);
    const acodeSql = `(d.acode = $1 OR d.acode LIKE $1 || '%')`;

    const rows = await this.database.query<{
      code: string;
      name: string;
      debit: string;
      credit: string;
    }>(
      `SELECT coalesce(nullif(trim(m.ccode), ''), '—') AS code,
              coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '—') AS name,
              coalesce(sum(${this.debitSql}), 0)::text AS debit,
              coalesce(sum(${this.creditSql}), 0)::text AS credit
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       LEFT JOIN acc camp ON camp.acode = m.ccode
       WHERE ${acodeSql}
         AND m.invdate >= $2 AND m.invdate < $3
         AND ($4 = '' OR m.ccode LIKE $4 || '%')
       GROUP BY coalesce(nullif(trim(m.ccode), ''), '—'),
                coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '—')
       ORDER BY 1`,
      [acode, from, toExclusive, scope],
    );

    const list = rows.rows.map((r) => {
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      return {
        code: r.code,
        name: r.name,
        debit: round2(debit),
        credit: round2(credit),
        balance: round2(debit - credit),
      };
    });
    const totals = list.reduce(
      (acc, r) => {
        acc.debit += r.debit;
        acc.credit += r.credit;
        acc.balance += r.balance;
        return acc;
      },
      { debit: 0, credit: 0, balance: 0 },
    );
    return {
      rows: list,
      totals: {
        debit: round2(totals.debit),
        credit: round2(totals.credit),
        balance: round2(totals.balance),
      },
      meta: { site: scope, fromDate: from, toDate: to, acode },
    };
  }

  /**
   * C.F — Main Sub Ledger: selected head + child accounts with period movement.
   */
  async mainSubLedger(
    username: string,
    acodeRaw: string,
    site: string,
    fromDate: string,
    toDate: string,
  ) {
    const acode = acodeRaw.trim();
    if (!acode) {
      return {
        rows: [],
        totals: { debit: 0, credit: 0, balance: 0 },
        meta: { site: '', fromDate: '', toDate: '', acode: '' },
      };
    }
    const scope = await this.siteScope(username, site);
    const { from, to, toExclusive } = this.periodBounds(fromDate, toDate);

    const rows = await this.database.query<{
      code: string;
      name: string;
      debit: string;
      credit: string;
    }>(
      `SELECT trim(a.acode) AS code,
              coalesce(nullif(trim(a.ahead), ''), trim(a.acode)) AS name,
              coalesce(x.debit, 0)::text AS debit,
              coalesce(x.credit, 0)::text AS credit
       FROM acc a
       LEFT JOIN (
         SELECT d.acode AS acode,
                coalesce(sum(${this.debitSql}), 0) AS debit,
                coalesce(sum(${this.creditSql}), 0) AS credit
         FROM accdet d
         JOIN accmast m ON m.invno = d.invno
         WHERE m.invdate >= $2 AND m.invdate < $3
           AND ($4 = '' OR m.ccode LIKE $4 || '%')
           AND (d.acode = $1 OR d.acode LIKE $1 || '%')
         GROUP BY d.acode
       ) x ON x.acode = a.acode
       WHERE a.acode = $1
          OR a.acode LIKE $1 || '%'
       ORDER BY a.acode
       LIMIT 2000`,
      [acode, from, toExclusive, scope],
    );

    const list = rows.rows
      .map((r) => {
        const debit = Number(r.debit) || 0;
        const credit = Number(r.credit) || 0;
        const isMain = r.code === acode;
        return {
          code: r.code,
          name: r.name,
          level: isMain ? 'Main' : 'Sub',
          debit: round2(debit),
          credit: round2(credit),
          balance: round2(debit - credit),
        };
      })
      .filter((r) => r.debit !== 0 || r.credit !== 0);

    const hasSubs = list.some((r) => r.level === 'Sub');
    const totals = list.reduce(
      (acc, r) => {
        if (r.level === 'Main' && hasSubs) return acc;
        acc.debit += r.debit;
        acc.credit += r.credit;
        acc.balance += r.balance;
        return acc;
      },
      { debit: 0, credit: 0, balance: 0 },
    );

    return {
      rows: list,
      totals: {
        debit: round2(totals.debit),
        credit: round2(totals.credit),
        balance: round2(totals.balance),
      },
      meta: { site: scope, fromDate: from, toDate: to, acode },
    };
  }

  /**
   * H.A — Site Summary: campus-wise debit / credit / balance for period.
   */
  async siteSummary(username: string, site: string, fromDate: string, toDate: string) {
    const scope = await this.siteScope(username, site);
    const { from, to, toExclusive } = this.periodBounds(fromDate, toDate);

    const rows = await this.database.query<{
      code: string;
      name: string;
      debit: string;
      credit: string;
    }>(
      `SELECT coalesce(nullif(trim(m.ccode), ''), '—') AS code,
              coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '—') AS name,
              coalesce(sum(${this.debitSql}), 0)::text AS debit,
              coalesce(sum(${this.creditSql}), 0)::text AS credit
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       LEFT JOIN acc camp ON camp.acode = m.ccode
       WHERE m.invdate >= $1 AND m.invdate < $2
         AND ($3 = '' OR m.ccode LIKE $3 || '%')
         AND coalesce(nullif(trim(m.ccode), ''), '') <> ''
       GROUP BY coalesce(nullif(trim(m.ccode), ''), '—'),
                coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '—')
       ORDER BY 1`,
      [from, toExclusive, scope],
    );

    const list = rows.rows.map((r) => {
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      return {
        code: r.code,
        name: r.name,
        debit: round2(debit),
        credit: round2(credit),
        balance: round2(debit - credit),
      };
    });
    const totals = list.reduce(
      (acc, r) => {
        acc.debit += r.debit;
        acc.credit += r.credit;
        acc.balance += r.balance;
        return acc;
      },
      { debit: 0, credit: 0, balance: 0 },
    );
    return {
      rows: list,
      totals: {
        debit: round2(totals.debit),
        credit: round2(totals.credit),
        balance: round2(totals.balance),
      },
      meta: { site: scope, fromDate: from, toDate: to },
    };
  }

  /**
   * C.J — Subsidiary List: child accounts under selected group with balances.
   */
  async subsidiaryList(
    username: string,
    acodeRaw: string,
    site: string,
    fromDate: string,
    toDate: string,
  ) {
    const acode = acodeRaw.trim();
    if (!acode) {
      return {
        rows: [],
        totals: { debit: 0, credit: 0, balance: 0 },
        meta: { site: '', fromDate: '', toDate: '', acode: '' },
      };
    }
    const scope = await this.siteScope(username, site);
    const { from, to, toExclusive } = this.periodBounds(fromDate, toDate);

    const rows = await this.database.query<{
      code: string;
      name: string;
      debit: string;
      credit: string;
    }>(
      `SELECT trim(a.acode) AS code,
              coalesce(nullif(trim(a.ahead), ''), trim(a.acode)) AS name,
              coalesce(x.debit, 0)::text AS debit,
              coalesce(x.credit, 0)::text AS credit
       FROM acc a
       LEFT JOIN (
         SELECT d.acode AS acode,
                coalesce(sum(${this.debitSql}), 0) AS debit,
                coalesce(sum(${this.creditSql}), 0) AS credit
         FROM accdet d
         JOIN accmast m ON m.invno = d.invno
         WHERE m.invdate >= $2 AND m.invdate < $3
           AND ($4 = '' OR m.ccode LIKE $4 || '%')
           AND d.acode LIKE $1 || '%'
           AND d.acode <> $1
         GROUP BY d.acode
       ) x ON x.acode = a.acode
       WHERE a.acode LIKE $1 || '%'
         AND a.acode <> $1
       ORDER BY a.acode
       LIMIT 3000`,
      [acode, from, toExclusive, scope],
    );

    const list = rows.rows
      .map((r) => {
        const debit = Number(r.debit) || 0;
        const credit = Number(r.credit) || 0;
        return {
          code: r.code,
          name: r.name,
          debit: round2(debit),
          credit: round2(credit),
          balance: round2(debit - credit),
        };
      })
      .filter((r) => r.debit !== 0 || r.credit !== 0);
    const totals = list.reduce(
      (acc, r) => {
        acc.debit += r.debit;
        acc.credit += r.credit;
        acc.balance += r.balance;
        return acc;
      },
      { debit: 0, credit: 0, balance: 0 },
    );
    return {
      rows: list,
      totals: {
        debit: round2(totals.debit),
        credit: round2(totals.credit),
        balance: round2(totals.balance),
      },
      meta: { site: scope, fromDate: from, toDate: to, acode },
    };
  }

  /** Distinct Campus / Month values for the fee voucher header dropdown filters. */
  private async feeVoucherOptions(baseWhere: string, params: unknown[]) {
    const res = await this.database.query<{ kind: string; value: string }>(
      `SELECT DISTINCT 'siteName' AS kind, coalesce(nullif(trim(s.ahead), ''), m.ccode, '') AS value
       FROM accmast m
       LEFT JOIN acc s ON s.acode = m.ccode
       WHERE ${baseWhere}
       UNION
       SELECT DISTINCT 'mont', trim(coalesce(m.mont, ''))
       FROM accmast m
       WHERE ${baseWhere}`,
      params,
    );
    const pick = (kind: string) => res.rows.filter((r) => r.kind === kind).map((r) => r.value);
    const monthKey = (m: string) => (m.length === 6 ? m.slice(2) + m.slice(0, 2) : m);
    return {
      siteName: distinctSorted(pick('siteName')),
      mont: distinctSorted(pick('mont')).sort((a, b) => monthKey(b).localeCompare(monthKey(a))),
    };
  }

  /** Student ID / name / challan no / narration search across the whole period. */
  private feeSearchSql(q: string, params: unknown[]) {
    const term = String(q || '').trim();
    if (!term) return '';
    params.push(`%${term}%`);
    const p = `$${params.length}`;
    return `AND (m.invno ILIKE ${p}
           OR coalesce(m.sdno, '') ILIKE ${p}
           OR coalesce(m.nar, '') ILIKE ${p}
           OR EXISTS (SELECT 1 FROM student sq WHERE sq.sdno = m.sdno AND sq.name ILIKE ${p}))`;
  }

  async feeCollection(
    username: string,
    site: string,
    fromDate: string,
    toDate: string,
    montFrom = '',
    montTo = '',
    page = 1,
    pageSize = 50,
    status = 'ALL',
    colFilters: Record<string, string> = {},
    q = '',
  ) {
    const scope = await this.siteScope(username, site);
    const fromKey = toYyyymm(montFrom);
    const toKey = toYyyymm(montTo || montFrom);
    // Legacy H.P: Months From/To drive the period. If only dates set, use those.
    let { from, to, toExclusive } = this.periodBounds(fromDate, toDate);
    if (fromKey || toKey) {
      const span = monthKeysToDateSpan(fromKey || toKey, toKey || fromKey);
      from = span.from;
      to = span.to;
      toExclusive = span.toExclusive;
    }
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    // accmast.mont is MMYYYY — compare as YYYYMM for From/To range (legacy Months).
    const montExpr = `(right(trim(m.mont), 4) || left(trim(m.mont), 2))`;
    /** Legacy UI: Active / Left / Migrate / ALL. DB uses Transfered for Migrate. */
    const statusKey = String(status || 'ALL').trim();
    const statusDb =
      !statusKey || statusKey.toUpperCase() === 'ALL'
        ? ''
        : statusKey.toLowerCase() === 'migrate'
          ? 'Transfered'
          : statusKey;
    const statusFilter = statusDb
      ? `AND EXISTS (
           SELECT 1 FROM student st
           WHERE st.sdno = m.sdno AND trim(st.stat) = $6
         )`
      : '';
    const params: unknown[] = [from, toExclusive, scope, fromKey, toKey];
    if (statusDb) params.push(statusDb);
    const searchFilter = this.feeSearchSql(q, params);
    const baseWhere = `right(m.invno, 1) = 'F'
         AND m.invdate >= $1 AND m.invdate < $2
         AND ($3 = '' OR m.ccode LIKE $3 || '%')
         AND ($4 = '' OR (length(trim(coalesce(m.mont,''))) >= 6 AND ${montExpr} >= $4))
         AND ($5 = '' OR (length(trim(coalesce(m.mont,''))) >= 6 AND ${montExpr} <= $5))
         ${statusFilter}
         ${searchFilter}`;
    const baseSql = `SELECT m.invno AS invno,
              left(m.invdate, 10) AS invdate,
              coalesce(m.nar, '') AS narr,
              coalesce(m.ccode, '') AS "siteCode",
              coalesce(nullif(trim(s.ahead), ''), m.ccode, '') AS "siteName",
              coalesce(m.mont, '') AS mont,
              coalesce(nullif(trim(m.sdno), ''), '') AS sdno,
              coalesce(nullif(trim(st.name), ''), '') AS "studentName",
              coalesce(sum(${this.debitSql}), 0) AS amount
       FROM accmast m
       JOIN accdet d ON d.invno = m.invno
       LEFT JOIN acc s ON s.acode = m.ccode
       LEFT JOIN student st ON st.sdno = m.sdno
       WHERE ${baseWhere}
       GROUP BY m.invno, m.invdate, m.nar, m.ccode, s.ahead, m.mont, m.sdno, st.name`;

    const options =
      current === 1 ? await this.feeVoucherOptions(baseWhere, [...params]) : undefined;
    const colWhere = colFilterOutSql(colFilters, FEE_VOUCHER_COLS, params);

    const count = await this.database.query<{ total: string; amount: string }>(
      `WITH base AS (${baseSql})
       SELECT count(*)::text AS total, coalesce(sum(b.amount), 0)::text AS amount
       FROM base b ${colWhere}`,
      params,
    );

    const rows = await this.database.query<{
      invno: string;
      invdate: string;
      narr: string;
      siteCode: string;
      siteName: string;
      mont: string;
      sdno: string;
      studentName: string;
      amount: string;
    }>(
      `WITH base AS (${baseSql})
       SELECT b.invno, b.invdate, b.narr, b."siteCode", b."siteName", b.mont, b.sdno, b."studentName",
              b.amount::text AS amount
       FROM base b ${colWhere}
       ORDER BY b.invdate DESC, b.invno DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, offset],
    );

    return {
      options,
      rows: rows.rows.map((r) => ({
        invno: r.invno,
        date: r.invdate,
        narration: r.narr,
        siteCode: r.siteCode,
        siteName: r.siteName,
        mont: r.mont,
        sdno: r.sdno,
        studentName: r.studentName,
        amount: round2(Number(r.amount) || 0),
      })),
      total: Number(count.rows[0]?.total) || 0,
      totalAmount: round2(Number(count.rows[0]?.amount) || 0),
      page: current,
      pageSize: size,
      meta: {
        site: scope,
        fromDate: from,
        toDate: to,
        montFrom: montFrom.trim(),
        montTo: (montTo || montFrom).trim(),
        status: statusKey || 'ALL',
      },
    };
  }

  /**
   * H.N / H.X — student-wise fee receivable outstanding (not account heads).
   * Net debit on 150201% linked via accmast.sdno → student.
   */
  async defaulters(
    username: string,
    site: string,
    fromDate: string,
    toDate: string,
    page = 1,
    pageSize = 50,
    status = 'ALL',
    montFrom = '',
    montTo = '',
    colFilters: Record<string, string> = {},
    sort = '',
  ) {
    const scope = await this.siteScope(username, site);
    const fromKey = toYyyymm(montFrom);
    const toKey = toYyyymm(montTo || montFrom);
    let { from, to, toExclusive } = this.periodBounds(
      fromDate || '2020-01-01',
      toDate,
    );
    if (fromKey || toKey) {
      const span = monthKeysToDateSpan(fromKey || toKey, toKey || fromKey);
      from = span.from;
      to = span.to;
      toExclusive = span.toExclusive;
    }
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;

    const statusKey = String(status || 'ALL').trim();
    const statusDb =
      !statusKey || statusKey.toUpperCase() === 'ALL'
        ? ''
        : statusKey.toLowerCase() === 'migrate'
          ? 'Transfered'
          : statusKey;

    const params: unknown[] = [from, toExclusive, scope, fromKey, toKey];
    let statusClause = '';
    if (statusDb) {
      params.push(statusDb);
      statusClause = `AND trim(st.stat) = $${params.length}`;
    }

    const montYm = `(right(trim(m.mont), 4) || left(trim(m.mont), 2))`;

    const all = await this.database.query<{
      sdno: string;
      name: string;
      status: string;
      className: string;
      campus: string;
      fromDate: string;
      toDate: string;
      fromYm: string;
      toYm: string;
      debit: string;
      credit: string;
    }>(
      `SELECT coalesce(nullif(trim(m.sdno), ''), '') AS sdno,
              coalesce(nullif(trim(st.name), ''), nullif(trim(m.nar), ''), m.sdno, '—') AS name,
              coalesce(nullif(trim(st.stat), ''), '—') AS status,
              coalesce(nullif(trim(st.class), ''), '') AS "className",
              coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '') AS campus,
              left(min(m.invdate)::text, 10) AS "fromDate",
              left(max(m.invdate)::text, 10) AS "toDate",
              min(CASE WHEN length(trim(coalesce(m.mont,''))) >= 6 THEN ${montYm} END) AS "fromYm",
              max(CASE WHEN length(trim(coalesce(m.mont,''))) >= 6 THEN ${montYm} END) AS "toYm",
              coalesce(sum(${this.debitSql}), 0)::text AS debit,
              coalesce(sum(${this.creditSql}), 0)::text AS credit
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       LEFT JOIN student st ON st.sdno = m.sdno
       LEFT JOIN acc camp ON camp.acode = m.ccode
       WHERE d.acode LIKE '150201%'
         AND coalesce(nullif(trim(m.sdno), ''), '') <> ''
         AND m.invdate >= $1 AND m.invdate < $2
         AND ($3 = '' OR m.ccode LIKE $3 || '%')
         AND ($4 = '' OR (length(trim(coalesce(m.mont,''))) >= 6 AND ${montYm} >= $4))
         AND ($5 = '' OR (length(trim(coalesce(m.mont,''))) >= 6 AND ${montYm} <= $5))
         ${statusClause}
       GROUP BY coalesce(nullif(trim(m.sdno), ''), ''),
                coalesce(nullif(trim(st.name), ''), nullif(trim(m.nar), ''), m.sdno, '—'),
                coalesce(nullif(trim(st.stat), ''), '—'),
                coalesce(nullif(trim(st.class), ''), ''),
                coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '')
       HAVING coalesce(sum(${this.debitSql} - ${this.creditSql}), 0) > 0.005
       ORDER BY coalesce(sum(${this.debitSql} - ${this.creditSql}), 0) DESC`,
      params,
    );

    const ymToLabel = (ym: string) => {
      const v = String(ym || '').replace(/\D/g, '');
      if (v.length !== 6) return '';
      return `${v.slice(4, 6)}/${v.slice(0, 4)}`;
    };

    const mapped = all.rows.map((r) => {
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      const fromMont = ymToLabel(r.fromYm);
      const toMont = ymToLabel(r.toYm);
      return {
        code: r.sdno,
        sdno: r.sdno,
        name: r.name,
        status: r.status,
        className: r.className,
        campus: r.campus,
        fromDate: r.fromDate || '',
        toDate: r.toDate || '',
        fromMont,
        toMont,
        debit: round2(debit),
        credit: round2(credit),
        outstanding: round2(debit - credit),
        sectionName: '',
        classCode: '',
      };
    });
    await this.withClassSection(mapped);
    const filtered = this.sortDefaulters(filterInMemory(mapped, colFilters, DEFAULTER_COLS), sort);
    const slice = filtered.slice(offset, offset + size);
    const totalOutstanding = filtered.reduce((s, r) => s + r.outstanding, 0);

    return {
      options: defaulterOptions(mapped),
      rows: slice,
      total: filtered.length,
      totalOutstanding: round2(totalOutstanding),
      page: current,
      pageSize: size,
      meta: {
        site: scope,
        fromDate: from,
        toDate: to,
        montFrom: montFrom.trim(),
        montTo: (montTo || montFrom).trim(),
        status: statusKey || 'ALL',
      },
    };
  }

  /**
   * F.H — Fee Register B/W Date: fee bill vouchers (…G) in date range.
   * Debits on these match Trade Receivable Fees movement in Trial Balance.
   */
  async feeRegister(
    username: string,
    site: string,
    fromDate: string,
    toDate: string,
    page = 1,
    pageSize = 50,
    status = 'ALL',
    montFrom = '',
    montTo = '',
    colFilters: Record<string, string> = {},
    q = '',
  ) {
    const scope = await this.siteScope(username, site);
    const fromKey = toYyyymm(montFrom);
    const toKey = toYyyymm(montTo || montFrom);
    let { from, to, toExclusive } = this.periodBounds(fromDate, toDate);
    if (fromKey || toKey) {
      const span = monthKeysToDateSpan(fromKey || toKey, toKey || fromKey);
      from = span.from;
      to = span.to;
      toExclusive = span.toExclusive;
    }
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    const montExpr = `(right(trim(m.mont), 4) || left(trim(m.mont), 2))`;

    const statusKey = String(status || 'ALL').trim();
    const statusDb =
      !statusKey || statusKey.toUpperCase() === 'ALL'
        ? ''
        : statusKey.toLowerCase() === 'migrate'
          ? 'Transfered'
          : statusKey;

    const params: unknown[] = [from, toExclusive, scope, fromKey, toKey];
    let statusFilter = '';
    if (statusDb) {
      params.push(statusDb);
      statusFilter = `AND EXISTS (
        SELECT 1 FROM student st
        WHERE st.sdno = m.sdno AND trim(st.stat) = $${params.length}
      )`;
    }
    const searchFilter = this.feeSearchSql(q, params);

    const baseWhere = `right(trim(m.invno), 1) = 'G'
         AND m.invdate >= $1 AND m.invdate < $2
         AND ($3 = '' OR m.ccode LIKE $3 || '%')
         AND ($4 = '' OR (length(trim(coalesce(m.mont,''))) >= 6 AND ${montExpr} >= $4))
         AND ($5 = '' OR (length(trim(coalesce(m.mont,''))) >= 6 AND ${montExpr} <= $5))
         ${statusFilter}
         ${searchFilter}`;
    const baseSql = `SELECT trim(m.invno) AS invno,
              left(m.invdate, 10) AS invdate,
              coalesce(m.nar, '') AS narr,
              coalesce(m.ccode, '') AS "siteCode",
              coalesce(nullif(trim(s.ahead), ''), m.ccode, '') AS "siteName",
              coalesce(m.mont, '') AS mont,
              coalesce(nullif(trim(m.sdno), ''), '') AS sdno,
              coalesce(nullif(trim(st.name), ''), '') AS "studentName",
              ${G_PAID_SQL('m')} AS paid,
              coalesce(sum(${this.debitSql}), 0) AS amount
       FROM accmast m
       JOIN accdet d ON d.invno = m.invno
       LEFT JOIN acc s ON s.acode = m.ccode
       LEFT JOIN student st ON st.sdno = m.sdno
       WHERE ${baseWhere}
       GROUP BY m.invno, m.invdate, m.nar, m.ccode, s.ahead, m.mont, m.sdno, st.name`;

    const options =
      current === 1 ? await this.feeVoucherOptions(baseWhere, [...params]) : undefined;
    const colWhere = colFilterOutSql(colFilters, FEE_REGISTER_COLS, params);

    const count = await this.database.query<{ total: string; amount: string }>(
      `WITH base AS (${baseSql})
       SELECT count(*)::text AS total, coalesce(sum(b.amount), 0)::text AS amount
       FROM base b ${colWhere}`,
      params,
    );

    const rowParams = [...params, size, offset];
    const limitIdx = rowParams.length - 1;
    const offsetIdx = rowParams.length;
    const rows = await this.database.query<{
      invno: string;
      invdate: string;
      narr: string;
      siteCode: string;
      siteName: string;
      mont: string;
      sdno: string;
      studentName: string;
      paid: boolean;
      amount: string;
    }>(
      `WITH base AS (${baseSql})
       SELECT b.invno, b.invdate, b.narr, b."siteCode", b."siteName", b.mont, b.sdno,
              b."studentName", b.paid, b.amount::text AS amount
       FROM base b ${colWhere}
       ORDER BY b.invdate DESC, b.invno DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      rowParams,
    );

    return {
      options,
      rows: rows.rows.map((r) => ({
        invno: r.invno,
        date: r.invdate || '',
        narration: r.narr,
        siteCode: r.siteCode,
        siteName: r.siteName,
        mont: r.mont,
        sdno: r.sdno,
        studentName: r.studentName,
        paid: Boolean(r.paid),
        amount: round2(Number(r.amount) || 0),
      })),
      total: Number(count.rows[0]?.total) || 0,
      totalAmount: round2(Number(count.rows[0]?.amount) || 0),
      page: current,
      pageSize: size,
      meta: {
        site: scope,
        fromDate: from,
        toDate: to,
        montFrom: montFrom.trim(),
        montTo: (montTo || montFrom).trim(),
        status: statusKey || 'ALL',
      },
    };
  }

  /**
   * H.S — Defaulter List To Month W/O:
   * outstanding up to fee month, excluding Bad Debts write-off credits (collectible dues).
   */
  async defaultersWo(
    username: string,
    site: string,
    fromDate: string,
    toDate: string,
    montTo: string,
    page = 1,
    pageSize = 50,
    status = 'ALL',
  ) {
    const scope = await this.siteScope(username, site);
    const toKey = toYyyymm(montTo);
    let { from, to, toExclusive } = this.periodBounds(
      fromDate || '2020-01-01',
      toDate,
    );
    if (toKey) {
      const span = monthKeysToDateSpan(toKey, toKey);
      // Keep wide from-date; cut with mont filter. Dates still bound outer window.
      to = span.to;
      toExclusive = span.toExclusive;
      if (!fromDate) from = '2020-01-01';
    }
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;

    const statusKey = String(status || 'ALL').trim();
    const statusDb =
      !statusKey || statusKey.toUpperCase() === 'ALL'
        ? ''
        : statusKey.toLowerCase() === 'migrate'
          ? 'Transfered'
          : statusKey;

    const montYm = `(right(trim(m.mont), 4) || left(trim(m.mont), 2))`;
    // Bad Debts under cash/bank tree — write-offs must not clear H.S outstanding.
    const notWriteOff = `AND coalesce(nullif(trim(m.bcode), ''), '') NOT IN ('1506020005', '1506020013', '1506020014')
      AND coalesce(nullif(trim(d.acode), ''), '') NOT IN ('1506020005', '1506020013', '1506020014')`;

    const params: unknown[] = [from, toExclusive, scope, toKey];
    let statusClause = '';
    if (statusDb) {
      params.push(statusDb);
      statusClause = `AND trim(st.stat) = $${params.length}`;
    }

    const all = await this.database.query<{
      sdno: string;
      name: string;
      status: string;
      className: string;
      campus: string;
      fromDate: string;
      toDate: string;
      fromYm: string;
      toYm: string;
      debit: string;
      credit: string;
    }>(
      `SELECT coalesce(nullif(trim(m.sdno), ''), '') AS sdno,
              coalesce(nullif(trim(st.name), ''), nullif(trim(m.nar), ''), m.sdno, '—') AS name,
              coalesce(nullif(trim(st.stat), ''), '—') AS status,
              coalesce(nullif(trim(st.class), ''), '') AS "className",
              coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '') AS campus,
              left(min(m.invdate)::text, 10) AS "fromDate",
              left(max(m.invdate)::text, 10) AS "toDate",
              min(CASE WHEN length(trim(coalesce(m.mont,''))) >= 6 THEN ${montYm} END) AS "fromYm",
              max(CASE WHEN length(trim(coalesce(m.mont,''))) >= 6 THEN ${montYm} END) AS "toYm",
              coalesce(sum(${this.debitSql}), 0)::text AS debit,
              coalesce(sum(${this.creditSql}), 0)::text AS credit
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       LEFT JOIN student st ON st.sdno = m.sdno
       LEFT JOIN acc camp ON camp.acode = m.ccode
       WHERE d.acode LIKE '150201%'
         AND coalesce(nullif(trim(m.sdno), ''), '') <> ''
         AND m.invdate >= $1 AND m.invdate < $2
         AND ($3 = '' OR m.ccode LIKE $3 || '%')
         AND ($4 = '' OR (length(trim(coalesce(m.mont,''))) >= 6 AND ${montYm} <= $4))
         ${notWriteOff}
         ${statusClause}
       GROUP BY coalesce(nullif(trim(m.sdno), ''), ''),
                coalesce(nullif(trim(st.name), ''), nullif(trim(m.nar), ''), m.sdno, '—'),
                coalesce(nullif(trim(st.stat), ''), '—'),
                coalesce(nullif(trim(st.class), ''), ''),
                coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '')
       HAVING coalesce(sum(${this.debitSql} - ${this.creditSql}), 0) > 0.005
       ORDER BY coalesce(sum(${this.debitSql} - ${this.creditSql}), 0) DESC`,
      params,
    );

    const ymToLabel = (ym: string) => {
      const v = String(ym || '').replace(/\D/g, '');
      if (v.length !== 6) return '';
      return `${v.slice(4, 6)}/${v.slice(0, 4)}`;
    };

    const mapped = all.rows.map((r) => {
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      return {
        code: r.sdno,
        sdno: r.sdno,
        name: r.name,
        status: r.status,
        className: r.className,
        campus: r.campus,
        fromDate: r.fromDate || '',
        toDate: r.toDate || '',
        fromMont: ymToLabel(r.fromYm),
        toMont: ymToLabel(r.toYm),
        debit: round2(debit),
        credit: round2(credit),
        outstanding: round2(debit - credit),
        sectionName: '',
        classCode: '',
      };
    });
    await this.withClassSection(mapped);
    const slice = mapped.slice(offset, offset + size);
    const totalOutstanding = mapped.reduce((s, r) => s + r.outstanding, 0);

    return {
      rows: slice,
      total: mapped.length,
      totalOutstanding: round2(totalOutstanding),
      page: current,
      pageSize: size,
      meta: {
        site: scope,
        fromDate: from,
        toDate: to,
        montTo: montTo.trim(),
        status: statusKey || 'ALL',
      },
    };
  }

  /**
   * H.O — Defaulter List To Banks: outstanding students with last fee-receipt bank (bcode).
   */
  async defaultersToBanks(
    username: string,
    site: string,
    fromDate: string,
    toDate: string,
    page = 1,
    pageSize = 50,
    status = 'ALL',
    montFrom = '',
    montTo = '',
    colFilters: Record<string, string> = {},
    sort = '',
  ) {
    const scope = await this.siteScope(username, site);
    const fromKey = toYyyymm(montFrom);
    const toKey = toYyyymm(montTo || montFrom);
    let { from, to, toExclusive } = this.periodBounds(
      fromDate || '2020-01-01',
      toDate,
    );
    if (fromKey || toKey) {
      const span = monthKeysToDateSpan(fromKey || toKey, toKey || fromKey);
      from = span.from;
      to = span.to;
      toExclusive = span.toExclusive;
    }
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;

    const statusKey = String(status || 'ALL').trim();
    const statusDb =
      !statusKey || statusKey.toUpperCase() === 'ALL'
        ? ''
        : statusKey.toLowerCase() === 'migrate'
          ? 'Transfered'
          : statusKey;

    const montYm = `(right(trim(m.mont), 4) || left(trim(m.mont), 2))`;
    const params: unknown[] = [from, toExclusive, scope, fromKey, toKey];
    let statusClause = '';
    if (statusDb) {
      params.push(statusDb);
      statusClause = `AND trim(st.stat) = $${params.length}`;
    }

    const all = await this.database.query<{
      sdno: string;
      name: string;
      status: string;
      className: string;
      campus: string;
      fromDate: string;
      toDate: string;
      fromYm: string;
      toYm: string;
      debit: string;
      credit: string;
      bankCode: string;
      bankName: string;
    }>(
      `WITH dues AS (
         SELECT coalesce(nullif(trim(m.sdno), ''), '') AS sdno,
                coalesce(nullif(trim(st.name), ''), nullif(trim(m.nar), ''), m.sdno, '—') AS name,
                coalesce(nullif(trim(st.stat), ''), '—') AS status,
                coalesce(nullif(trim(st.class), ''), '') AS "className",
                coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '') AS campus,
                left(min(m.invdate)::text, 10) AS "fromDate",
                left(max(m.invdate)::text, 10) AS "toDate",
                min(CASE WHEN length(trim(coalesce(m.mont,''))) >= 6 THEN ${montYm} END) AS "fromYm",
                max(CASE WHEN length(trim(coalesce(m.mont,''))) >= 6 THEN ${montYm} END) AS "toYm",
                coalesce(sum(${this.debitSql}), 0) AS debit,
                coalesce(sum(${this.creditSql}), 0) AS credit
         FROM accdet d
         JOIN accmast m ON m.invno = d.invno
         LEFT JOIN student st ON st.sdno = m.sdno
         LEFT JOIN acc camp ON camp.acode = m.ccode
         WHERE d.acode LIKE '150201%'
           AND coalesce(nullif(trim(m.sdno), ''), '') <> ''
           AND m.invdate >= $1 AND m.invdate < $2
           AND ($3 = '' OR m.ccode LIKE $3 || '%')
           AND ($4 = '' OR (length(trim(coalesce(m.mont,''))) >= 6 AND ${montYm} >= $4))
           AND ($5 = '' OR (length(trim(coalesce(m.mont,''))) >= 6 AND ${montYm} <= $5))
           ${statusClause}
         GROUP BY coalesce(nullif(trim(m.sdno), ''), ''),
                  coalesce(nullif(trim(st.name), ''), nullif(trim(m.nar), ''), m.sdno, '—'),
                  coalesce(nullif(trim(st.stat), ''), '—'),
                  coalesce(nullif(trim(st.class), ''), ''),
                  coalesce(nullif(trim(camp.ahead), ''), nullif(trim(m.ccode), ''), '')
         HAVING coalesce(sum(${this.debitSql} - ${this.creditSql}), 0) > 0.005
       ),
       last_bank AS (
         SELECT DISTINCT ON (trim(m.sdno))
                trim(m.sdno) AS sdno,
                coalesce(nullif(trim(m.bcode), ''), '') AS "bankCode"
         FROM accmast m
         WHERE right(trim(m.invno), 1) = 'F'
           AND coalesce(nullif(trim(m.sdno), ''), '') <> ''
           AND ($3 = '' OR m.ccode LIKE $3 || '%')
         ORDER BY trim(m.sdno), m.invdate DESC NULLS LAST, m.row_id DESC
       )
       SELECT d.sdno,
              d.name,
              d.status,
              d."className",
              d.campus,
              d."fromDate",
              d."toDate",
              d."fromYm",
              d."toYm",
              d.debit::text AS debit,
              d.credit::text AS credit,
              coalesce(nullif(b."bankCode", ''), '—') AS "bankCode",
              coalesce(nullif(trim(a.ahead), ''), nullif(b."bankCode", ''), '—') AS "bankName"
       FROM dues d
       LEFT JOIN last_bank b ON b.sdno = d.sdno
       LEFT JOIN acc a ON trim(a.acode) = trim(b."bankCode")
       ORDER BY coalesce(nullif(b."bankCode", ''), '—'),
                (d.debit - d.credit) DESC`,
      params,
    );

    const ymToLabel = (ym: string) => {
      const v = String(ym || '').replace(/\D/g, '');
      if (v.length !== 6) return '';
      return `${v.slice(4, 6)}/${v.slice(0, 4)}`;
    };

    const mapped = all.rows.map((r) => {
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      return {
        code: r.sdno,
        sdno: r.sdno,
        name: r.name,
        status: r.status,
        className: r.className,
        campus: r.campus,
        fromDate: r.fromDate || '',
        toDate: r.toDate || '',
        fromMont: ymToLabel(r.fromYm),
        toMont: ymToLabel(r.toYm),
        bankCode: r.bankCode || '—',
        bankName: r.bankName || '—',
        debit: round2(debit),
        credit: round2(credit),
        outstanding: round2(debit - credit),
        sectionName: '',
        classCode: '',
      };
    });
    await this.withClassSection(mapped);
    const filtered = this.sortDefaulters(filterInMemory(mapped, colFilters, DEFAULTER_COLS), sort);
    const slice = filtered.slice(offset, offset + size);
    const totalOutstanding = filtered.reduce((s, r) => s + r.outstanding, 0);

    return {
      options: defaulterOptions(mapped),
      rows: slice,
      total: filtered.length,
      totalOutstanding: round2(totalOutstanding),
      page: current,
      pageSize: size,
      meta: {
        site: scope,
        fromDate: from,
        toDate: to,
        montFrom: montFrom.trim(),
        montTo: (montTo || montFrom).trim(),
        status: statusKey || 'ALL',
      },
    };
  }

  async searchEntries(
    username: string,
    site: string,
    fromDate: string,
    toDate: string,
    narration = '',
    value = '',
    acode = '',
    page = 1,
    pageSize = 50,
    colFilters: Record<string, string> = {},
  ) {
    const scope = await this.siteScope(username, site);
    const { from, to, toExclusive } = this.periodBounds(fromDate, toDate);
    const narr = narration.trim().replace(/%/g, '');
    const val = value.trim();
    const account = acode.trim();
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;

    const params: unknown[] = [from, toExclusive, scope];
    const filters = [
      `m.invdate >= $1 AND m.invdate < $2`,
      `($3 = '' OR m.ccode LIKE $3 || '%')`,
    ];
    if (narr) {
      params.push(`%${narr}%`);
      filters.push(
        `(coalesce(d.snar,'') ILIKE $${params.length} OR coalesce(m.nar,'') ILIKE $${params.length})`,
      );
    }
    if (val) {
      params.push(val);
      filters.push(
        `(d.dr = $${params.length} OR d.cr = $${params.length} OR d.dr ILIKE $${params.length} || '%' OR d.cr ILIKE $${params.length} || '%')`,
      );
    }
    if (account) {
      params.push(account);
      filters.push(`(d.acode = $${params.length} OR d.acode LIKE $${params.length} || '%')`);
    }
    filters.push(
      ...colFilterConds(
        colFilters,
        {
          date: { expr: 'left(m.invdate, 10)', type: 'date' },
          invno: { expr: 'd.invno', type: 'like' },
          accountCode: { expr: `d.acode || ' ' || coalesce(a.ahead, '')`, type: 'like' },
          narration: {
            expr: `coalesce(nullif(trim(d.snar), ''), nullif(trim(m.nar), ''), '')`,
            type: 'like',
          },
          debit: { expr: this.debitSql, type: 'num' },
          credit: { expr: this.creditSql, type: 'num' },
        },
        params,
      ),
    );
    const where = filters.join(' AND ');
    params.push(size, offset);

    const count = await this.database.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       LEFT JOIN acc a ON a.acode = d.acode
       WHERE ${where}`,
      params.slice(0, params.length - 2),
    );

    const rows = await this.database.query<{
      invno: string;
      invdate: string;
      acode: string;
      ahead: string;
      narr: string;
      debit: string;
      credit: string;
      siteCode: string;
    }>(
      `SELECT d.invno AS invno,
              left(m.invdate, 10) AS invdate,
              d.acode AS acode,
              coalesce(a.ahead, '') AS ahead,
              coalesce(nullif(trim(d.snar), ''), nullif(trim(m.nar), ''), '') AS narr,
              (${this.debitSql})::text AS debit,
              (${this.creditSql})::text AS credit,
              coalesce(m.ccode, '') AS "siteCode"
       FROM accdet d
       JOIN accmast m ON m.invno = d.invno
       LEFT JOIN acc a ON a.acode = d.acode
       WHERE ${where}
       ORDER BY m.invdate DESC, d.row_id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: rows.rows.map((r) => ({
        invno: r.invno,
        date: r.invdate,
        accountCode: r.acode,
        accountName: r.ahead,
        narration: r.narr,
        debit: round2(Number(r.debit) || 0),
        credit: round2(Number(r.credit) || 0),
        siteCode: r.siteCode,
      })),
      total: Number(count.rows[0]?.total) || 0,
      page: current,
      pageSize: size,
      meta: { site: scope, fromDate: from, toDate: to },
    };
  }

  async voucher(username: string, invnoRaw: string) {
    return this.loadFeeVoucher(username, invnoRaw);
  }

  async updateVoucher(
    username: string,
    body: {
      invno?: string;
      invdate?: string;
      mont?: string;
      ccode?: string;
      nar?: string;
      lines?: Array<{
        accountCode?: string;
        debit?: number | string;
        credit?: number | string;
        narration?: string;
      }>;
    },
  ) {
    const invno = String(body.invno || '').trim();
    if (!invno) return { ok: false, message: 'Invoice required', master: null, lines: [] };
    if (!invno.toUpperCase().endsWith('F')) {
      return { ok: false, message: 'Only fee receipts (…F) can be updated here.', master: null, lines: [] };
    }

    const existing = await this.loadFeeVoucher(username, invno);
    if (!existing.ok || !existing.master) {
      return { ok: false, message: existing.message || 'Voucher not found', master: null, lines: [] };
    }

    const invdate = this.normDate(String(body.invdate || existing.master.invdate));
    if (!invdate) {
      return { ok: false, message: 'Valid date (YYYY-MM-DD) is required.', master: null, lines: [] };
    }

    const montRaw = String(body.mont ?? existing.master.mont ?? '').trim().replace(/\D/g, '');
    if (montRaw && (montRaw.length !== 6 || !toYyyymm(montRaw))) {
      return { ok: false, message: 'Month must be MMYYYY (e.g. 102026).', master: null, lines: [] };
    }
    const mont = montRaw || existing.master.mont || '';

    const ccode = String(body.ccode ?? existing.master.ccode ?? '').trim();
    if (!ccode) {
      return { ok: false, message: 'Campus / site is required.', master: null, lines: [] };
    }
    const zone = await this.zonePrefix(username);
    if (zone && !(ccode === zone || ccode.startsWith(zone))) {
      return { ok: false, message: 'Campus outside your zone.', master: null, lines: [] };
    }

    const nar = String(body.nar ?? existing.master.nar ?? '').trim();
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (!rawLines.length) {
      return { ok: false, message: 'At least one voucher line is required.', master: null, lines: [] };
    }

    const lines: Array<{ accountCode: string; debit: number; credit: number; narration: string }> =
      [];
    for (const line of rawLines) {
      const accountCode = String(line.accountCode || '').trim();
      if (!accountCode) {
        return { ok: false, message: 'Every line needs an account code.', master: null, lines: [] };
      }
      const debit = round2(Math.max(0, Number(line.debit) || 0));
      const credit = round2(Math.max(0, Number(line.credit) || 0));
      if (debit <= 0 && credit <= 0) {
        return {
          ok: false,
          message: `Line ${accountCode} needs a debit or credit amount.`,
          master: null,
          lines: [],
        };
      }
      lines.push({
        accountCode,
        debit,
        credit,
        narration: String(line.narration || '').trim(),
      });
    }

    const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
    const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      return {
        ok: false,
        message: `Debit (${totalDebit.toFixed(2)}) must equal Credit (${totalCredit.toFixed(2)}).`,
        master: null,
        lines: [],
      };
    }

    const debitAccount = lines.find((l) => l.debit > 0)?.accountCode || '';
    const creditAccount = lines.find((l) => l.credit > 0)?.accountCode || '';
    const uname = username.trim() || existing.master.uname || '';
    const invdateStore = `${invdate} 00:00:00`;

    try {
      await this.database.withTransaction(async (client) => {
        await client.query(
          `UPDATE accmast
           SET invdate = $2,
               mont = $3,
               ccode = $4,
               nar = $5,
               uname = $6,
               bcode = CASE WHEN $7 = '' THEN bcode ELSE $7 END,
               u4 = CASE WHEN $8 = '' THEN u4 ELSE $8 END,
               edate = $2
           WHERE trim(invno) = $1`,
          [invno, invdateStore, mont, ccode, nar, uname, debitAccount, creditAccount],
        );
        await client.query(`DELETE FROM accdet WHERE trim(invno) = $1`, [invno]);
        for (const line of lines) {
          await client.query(
            `INSERT INTO accdet (invno, acode, dr, cr, snar)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              invno,
              line.accountCode,
              String(line.debit),
              String(line.credit),
              line.narration || null,
            ],
          );
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update voucher.';
      return { ok: false, message, master: null, lines: [] };
    }

    await this.activityLog.write({
      category: 'activity',
      username: username || 'Unknown',
      activity: 'Fee Receipt Updated',
      description: `Updated fee receipt ${invno} (${lines.length} lines, amount ${totalDebit.toFixed(2)})`,
      module: 'Fee Control',
      campus: '',
      campusCode: ccode,
      status: 'Success',
      meta: { invno, totalDebit, totalCredit },
    });

    return this.loadFeeVoucher(username, invno);
  }

  async deleteVoucher(username: string, invnoRaw: string) {
    const invno = String(invnoRaw || '').trim();
    if (!invno) return { ok: false, message: 'Invoice required' };
    if (!invno.toUpperCase().endsWith('F')) {
      return { ok: false, message: 'Only fee receipts (…F) can be deleted here.' };
    }

    const existing = await this.loadFeeVoucher(username, invno);
    if (!existing.ok || !existing.master) {
      return { ok: false, message: existing.message || 'Voucher not found' };
    }

    const bill = await this.database.query(`SELECT 1 FROM accmast WHERE invno = $1 LIMIT 1`, [
      `${invno.slice(0, -1)}G`,
    ]);
    if (bill.rowCount) return this.reversePayment(username, invno);

    try {
      await this.database.withTransaction(async (client) => {
        await client.query(`DELETE FROM accdet WHERE trim(invno) = $1`, [invno]);
        await client.query(`DELETE FROM accmast WHERE trim(invno) = $1`, [invno]);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete voucher.';
      return { ok: false, message };
    }

    await this.activityLog.write({
      category: 'activity',
      username: username || 'Unknown',
      activity: 'Fee Receipt Deleted',
      description: `Deleted fee receipt ${invno}`,
      module: 'Fee Control',
      campus: '',
      campusCode: existing.master.ccode || '',
      status: 'Success',
      meta: { invno },
    });

    return { ok: true, message: `Receipt ${invno} deleted.` };
  }

  private async loadFeeVoucher(username: string, invnoRaw: string) {
    const invno = invnoRaw.trim();
    if (!invno) return { ok: false, message: 'Invoice required', master: null, lines: [] };
    const zone = await this.zonePrefix(username);
    const master = await this.database.query<{
      invno: string;
      invdate: string;
      nar: string;
      ccode: string;
      mont: string;
      uname: string;
    }>(
      `SELECT trim(invno) AS invno,
              left(trim(invdate), 10) AS invdate,
              coalesce(trim(nar), '') AS nar,
              coalesce(trim(ccode), '') AS ccode,
              coalesce(trim(mont), '') AS mont,
              coalesce(trim(uname), '') AS uname
       FROM accmast
       WHERE trim(invno) = $1
       ORDER BY row_id
       LIMIT 1`,
      [invno],
    );
    const row = master.rows[0];
    if (!row) return { ok: false, message: 'Voucher not found', master: null, lines: [] };
    if (zone && row.ccode && !(row.ccode === zone || row.ccode.startsWith(zone))) {
      return { ok: false, message: 'Voucher outside your zone', master: null, lines: [] };
    }
    const lines = await this.database.query<{
      acode: string;
      ahead: string;
      debit: string;
      credit: string;
      snar: string;
    }>(
      `SELECT trim(d.acode) AS acode,
              coalesce(trim(a.ahead), '') AS ahead,
              (${this.debitSql})::text AS debit,
              (${this.creditSql})::text AS credit,
              coalesce(trim(d.snar), '') AS snar
       FROM accdet d
       LEFT JOIN acc a ON trim(a.acode) = trim(d.acode)
       WHERE trim(d.invno) = $1
       ORDER BY d.row_id`,
      [invno],
    );
    return {
      ok: true,
      master: row,
      lines: lines.rows.map((l) => ({
        accountCode: l.acode,
        accountName: l.ahead,
        debit: round2(Number(l.debit) || 0),
        credit: round2(Number(l.credit) || 0),
        narration: l.snar,
      })),
    };
  }

  /**
   * Unpaid fee bills (…G without a matching …F) for one student.
   * `q` is a student ID or any challan number of that student (e.g. 386569G / 386569).
   */
  async studentChallans(username: string, qRaw: string, onlyRaw = '', site = '') {
    const found = await this.findChallanStudent(username, qRaw, site);
    if (!found.info) return { ok: false, message: found.message, student: null, challans: [] };
    const info = found.info;
    const sdno = info.sdno;

    const only = String(onlyRaw || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const params: unknown[] = [sdno];
    let onlyClause = '';
    // When specific invnos are requested (class print), include them even if paid.
    const unpaidClause = only.length ? '' : `AND NOT ${G_PAID_SQL('m')}`;
    if (only.length) {
      params.push(only);
      onlyClause = `AND m.invno = ANY($2::text[])`;
    }
    const rows = await this.database.query<{
      invno: string;
      invdate: string;
      dueDate: string;
      mont: string;
      narration: string;
      siteCode: string;
      amount: string;
    }>(
      `SELECT trim(m.invno) AS invno,
              left(coalesce(m.invdate, ''), 10) AS invdate,
              left(coalesce(m.dudate, ''), 10) AS "dueDate",
              coalesce(trim(m.mont), '') AS mont,
              coalesce(trim(m.nar), '') AS narration,
              coalesce(trim(m.ccode), '') AS "siteCode",
              coalesce(sum(${this.debitSql}), 0)::text AS amount
       FROM accmast m
       JOIN accdet d ON d.invno = m.invno
       WHERE m.sdno = $1
         AND m.invno LIKE '%G'
         ${unpaidClause}
         ${onlyClause}
       GROUP BY m.invno, m.invdate, m.dudate, m.mont, m.nar, m.ccode
       HAVING coalesce(sum(${this.debitSql}), 0) > 0
       ORDER BY right(trim(m.mont), 4) || left(trim(m.mont), 2), m.invno`,
      params,
    );

    return {
      ok: true,
      student: info,
      challans: rows.rows.map((r) => ({
        invno: r.invno,
        invdate: r.invdate,
        dueDate: r.dueDate,
        mont: r.mont,
        narration: r.narration,
        siteCode: r.siteCode,
        amount: round2(Number(r.amount) || 0),
      })),
    };
  }

  /**
   * Class / bulk print: load many students' fee bills in one round-trip (by invno).
   * Order of `items` is preserved; missing invnos are skipped.
   */
  async studentChallansBatch(
    username: string,
    itemsRaw: unknown,
  ): Promise<{
    ok: boolean;
    message?: string;
    rows: Array<{
      sdno: string;
      student: {
        sdno: string;
        name: string;
        fatherName: string;
        status: string;
        siteCode: string;
        campus: string;
        classCode: string;
        className: string;
        sectionName: string;
      };
      challans: Array<{
        invno: string;
        invdate: string;
        dueDate: string;
        mont: string;
        narration: string;
        siteCode: string;
        amount: number;
      }>;
    }>;
  }> {
    const items = (Array.isArray(itemsRaw) ? itemsRaw : [])
      .map((raw) => {
        const r = raw as { sdno?: string; invno?: string };
        return {
          sdno: String(r?.sdno || '')
            .trim()
            .toUpperCase(),
          invno: String(r?.invno || '')
            .trim()
            .toUpperCase(),
        };
      })
      .filter((r) => r.invno.endsWith('G'))
      .slice(0, 2000);
    if (!items.length) return { ok: false, message: 'No vouchers to load.', rows: [] };

    const invnos = [...new Set(items.map((i) => i.invno))];
    const zone = await this.zonePrefix(username);
    const billRows = await this.database.query<{
      invno: string;
      invdate: string;
      dueDate: string;
      mont: string;
      narration: string;
      siteCode: string;
      amount: string;
      sdno: string;
      name: string;
      fatherName: string;
      status: string;
      campus: string;
      classCode: string;
      className: string;
      sectionName: string;
    }>(
      `SELECT trim(m.invno) AS invno,
              left(coalesce(m.invdate, ''), 10) AS invdate,
              left(coalesce(m.dudate, ''), 10) AS "dueDate",
              coalesce(trim(m.mont), '') AS mont,
              coalesce(trim(m.nar), '') AS narration,
              coalesce(trim(m.ccode), '') AS "siteCode",
              coalesce(sum(${this.debitSql}), 0)::text AS amount,
              trim(st.sdno) AS sdno,
              coalesce(trim(st.name), '') AS name,
              coalesce(trim(st.fname), '') AS "fatherName",
              coalesce(trim(st.stat), '') AS status,
              coalesce(nullif(trim(camp.ahead), ''), trim(st.ccode), '') AS campus,
              coalesce(trim(st.class), '') AS "classCode",
              coalesce(nullif(trim(cl.ahead), ''), trim(st.class), '') AS "className",
              coalesce(nullif(trim(se.ahead), ''), trim(st.sec), '') AS "sectionName"
       FROM accmast m
       JOIN accdet d ON d.invno = m.invno
       JOIN student st ON trim(st.sdno) = trim(m.sdno)
       LEFT JOIN acc camp ON camp.acode = st.ccode
       LEFT JOIN acc cl ON cl.acode = st.class
       LEFT JOIN acc se ON se.acode = st.sec
       WHERE m.invno = ANY($1::text[])
         AND ($2 = '' OR coalesce(trim(st.ccode), '') LIKE $2 || '%')
       GROUP BY m.invno, m.invdate, m.dudate, m.mont, m.nar, m.ccode,
                st.sdno, st.name, st.fname, st.stat, st.ccode, st.class, st.sec,
                camp.ahead, cl.ahead, se.ahead
       HAVING coalesce(sum(${this.debitSql}), 0) > 0`,
      [invnos, zone || ''],
    );

    const byInv = new Map(billRows.rows.map((r) => [r.invno.toUpperCase(), r]));
    const out: Array<{
      sdno: string;
      student: {
        sdno: string;
        name: string;
        fatherName: string;
        status: string;
        siteCode: string;
        campus: string;
        classCode: string;
        className: string;
        sectionName: string;
      };
      challans: Array<{
        invno: string;
        invdate: string;
        dueDate: string;
        mont: string;
        narration: string;
        siteCode: string;
        amount: number;
      }>;
    }> = [];

    for (const item of items) {
      const r = byInv.get(item.invno);
      if (!r) continue;
      out.push({
        sdno: r.sdno,
        student: {
          sdno: r.sdno,
          name: r.name,
          fatherName: r.fatherName,
          status: r.status,
          siteCode: r.siteCode,
          campus: r.campus,
          classCode: r.classCode,
          className: r.className,
          sectionName: r.sectionName,
        },
        challans: [
          {
            invno: r.invno,
            invdate: r.invdate,
            dueDate: r.dueDate,
            mont: r.mont,
            narration: r.narration,
            siteCode: r.siteCode,
            amount: round2(Number(r.amount) || 0),
          },
        ],
      });
    }

    return { ok: true, rows: out };
  }

  /** Every fee bill of one student (all months) with its paid status and receipt. */
  async studentLedger(username: string, qRaw: string, site = '') {
    const found = await this.findChallanStudent(username, qRaw, site);
    if (!found.info) return { ok: false, message: found.message, student: null, rows: [] };
    const rows = await this.database.query<{
      invno: string;
      invdate: string;
      dueDate: string;
      mont: string;
      narration: string;
      amount: string;
      receipt: string;
      paidDate: string;
      bankCode: string;
      bankName: string;
    }>(
      `SELECT trim(m.invno) AS invno,
              left(coalesce(m.invdate, ''), 10) AS invdate,
              left(coalesce(m.dudate, ''), 10) AS "dueDate",
              coalesce(trim(m.mont), '') AS mont,
              coalesce(trim(m.nar), '') AS narration,
              coalesce(sum(${this.debitSql}), 0)::text AS amount,
              coalesce(trim(f.invno), '') AS receipt,
              left(coalesce(f.invdate, ''), 10) AS "paidDate",
              coalesce(trim(f.bcode), '') AS "bankCode",
              coalesce(nullif(trim(bk.ahead), ''), '') AS "bankName"
       FROM accmast m
       JOIN accdet d ON d.invno = m.invno
       LEFT JOIN accmast f ON f.invno = left(trim(m.invno), length(trim(m.invno)) - 1) || 'F'
       LEFT JOIN acc bk ON bk.acode = f.bcode
       WHERE m.sdno = $1
         AND m.invno LIKE '%G'
       GROUP BY m.invno, m.invdate, m.dudate, m.mont, m.nar, f.invno, f.invdate, f.bcode, bk.ahead
       ORDER BY right(trim(m.mont), 4) || left(trim(m.mont), 2) DESC, m.invno DESC
       LIMIT 1000`,
      [found.info.sdno],
    );
    return {
      ok: true,
      student: found.info,
      rows: rows.rows.map((r) => ({
        invno: r.invno,
        invdate: r.invdate,
        dueDate: r.dueDate,
        mont: r.mont,
        narration: r.narration,
        amount: round2(Number(r.amount) || 0),
        paid: !!r.receipt,
        receipt: r.receipt,
        paidDate: r.paidDate,
        bankCode: r.bankCode,
        bankName: r.bankName,
      })),
    };
  }

  /** Reverse several payments; newest first so split balances fold back in order. */
  async reversePayments(username: string, invnosRaw: unknown) {
    const invnos = [
      ...new Set(
        (Array.isArray(invnosRaw) ? invnosRaw : [])
          .map((v) => String(v || '').trim().toUpperCase().replace(/[GF]$/, ''))
          .filter((v) => /^\d+$/.test(v)),
      ),
    ].sort((a, b) => Number(b) - Number(a));
    if (!invnos.length) return { ok: false, message: 'Select at least one paid challan.', done: [], failed: [] };

    const done: string[] = [];
    const failed: Array<{ invno: string; message: string }> = [];
    for (const num of invnos) {
      const result = await this.reversePayment(username, `${num}G`);
      if (result.ok) done.push(`${num}G`);
      else failed.push({ invno: `${num}G`, message: result.message });
    }
    return {
      ok: done.length > 0,
      message: failed.length
        ? `${done.length} challan(s) marked unpaid, ${failed.length} failed: ${failed.map((f) => `${f.invno} (${f.message})`).join('; ')}`
        : `${done.length} challan(s) marked unpaid.`,
      done,
      failed,
    };
  }

  /**
   * Permanently removes unpaid fee bills (…G). Paid bills must be marked unpaid first.
   */
  async deleteChallans(username: string, invnosRaw: unknown) {
    const invnos = [
      ...new Set(
        (Array.isArray(invnosRaw) ? invnosRaw : [])
          .map((v) => {
            const raw = String(v || '').trim().toUpperCase();
            if (!/^\d+[G]?$/.test(raw)) return '';
            return raw.endsWith('G') ? raw : `${raw}G`;
          })
          .filter(Boolean),
      ),
    ];
    if (!invnos.length) return { ok: false, message: 'Select at least one unpaid challan.', done: [], failed: [] };

    const zone = await this.zonePrefix(username);
    const done: string[] = [];
    const failed: Array<{ invno: string; message: string }> = [];

    for (const gInv of invnos) {
      try {
        let sdno = '';
        let ccode = '';
        await this.database.withTransaction(async (client) => {
          const bill = await client.query<{
            invno: string;
            ccode: string;
            sdno: string;
            paid: boolean;
          }>(
            `SELECT trim(m.invno) AS invno, coalesce(trim(m.ccode), '') AS ccode,
                    coalesce(trim(m.sdno), '') AS sdno, ${G_PAID_SQL('m')} AS paid
               FROM accmast m
              WHERE m.invno = $1
              LIMIT 1
              FOR UPDATE`,
            [gInv],
          );
          const row = bill.rows[0];
          if (!row) throw new Error(`Challan ${gInv} not found.`);
          if (zone && row.ccode && !row.ccode.startsWith(zone)) {
            throw new Error(`Challan ${gInv} is outside your zone.`);
          }
          if (row.paid) throw new Error(`Challan ${gInv} is paid — mark unpaid first, then delete.`);

          sdno = row.sdno;
          ccode = row.ccode;
          await client.query(`DELETE FROM accdet WHERE invno = $1`, [gInv]);
          await client.query(`DELETE FROM accmast WHERE invno = $1`, [gInv]);
        });
        done.push(gInv);
        await this.activityLog.write({
          category: 'activity',
          username: username || 'Unknown',
          activity: 'Fee Challan Deleted',
          description: `Deleted unpaid challan ${gInv} for ${sdno}`,
          module: 'Fee Control',
          campus: '',
          campusCode: ccode,
          status: 'Success',
          meta: { invno: gInv, sdno },
        });
      } catch (err) {
        failed.push({
          invno: gInv,
          message: err instanceof Error ? err.message : 'Failed to delete challan.',
        });
      }
    }

    return {
      ok: done.length > 0,
      message: failed.length
        ? `${done.length} challan(s) deleted, ${failed.length} failed: ${failed.map((f) => `${f.invno} (${f.message})`).join('; ')}`
        : `${done.length} challan(s) deleted.`,
      done,
      failed,
    };
  }

  /**
   * Short IDs (1–5 digits, optional S) expand to zone + 5-digit serial + S, e.g. "6406" under SRA →
   * 140106406S, the same way Student Registration search finds them.
   */
  private async findShortStudentId(username: string, site: string, serial: string) {
    const zone = await this.zonePrefix(username);
    const picked = String(site || '').trim().slice(0, 4);
    const zones = /^14(01|02|03)$/.test(picked) && (!zone || picked.startsWith(zone.slice(0, 4)))
      ? [picked]
      : zone
        ? [zone.slice(0, 4)]
        : ['1401', '1402', '1403'];
    const ids = zones.map((z) => `${z}${serial.padStart(5, '0')}S`);
    const st = await this.database.query<{ sdno: string }>(
      `SELECT trim(sdno) AS sdno FROM student WHERE sdno = ANY($1::text[])`,
      [ids],
    );
    return st.rows.map((r) => r.sdno);
  }

  private async findChallanStudent(username: string, qRaw: string, site = '') {
    const q = String(qRaw || '').trim().toUpperCase();
    if (!q) return { info: null, message: 'Enter a student ID or challan number.' };

    let sdno = q;
    const short = /^(\d{1,5})S?$/.exec(q);
    if (short) {
      const ids = await this.findShortStudentId(username, site, short[1]);
      if (ids.length > 1) {
        return { info: null, message: `More than one student matches ${q} (${ids.join(', ')}). Select a zone first.` };
      }
      if (ids.length === 1) sdno = ids[0];
    }
    if (sdno === q && /^\d+[GF]?$/.test(q)) {
      const num = q.replace(/[GF]$/, '');
      const found = await this.database.query<{ sdno: string }>(
        `SELECT coalesce(trim(sdno), '') AS sdno FROM accmast WHERE invno IN ($1, $2) LIMIT 1`,
        [`${num}G`, `${num}F`],
      );
      sdno = found.rows[0]?.sdno || '';
      if (!sdno && /^\d+$/.test(q)) {
        const st = await this.database.query<{ sdno: string }>(
          `SELECT trim(sdno) AS sdno FROM student WHERE sdno IN ($1, $2) LIMIT 1`,
          [q, `${q}S`],
        );
        sdno = st.rows[0]?.sdno || '';
      }
      if (!sdno) return { info: null, message: `No challan or student found for ${q}.` };
    }

    const student = await this.database.query<{
      sdno: string;
      name: string;
      fatherName: string;
      status: string;
      siteCode: string;
      campus: string;
      classCode: string;
      className: string;
      sectionName: string;
    }>(
      `SELECT trim(st.sdno) AS sdno,
              coalesce(trim(st.name), '') AS name,
              coalesce(trim(st.fname), '') AS "fatherName",
              coalesce(trim(st.stat), '') AS status,
              coalesce(trim(st.ccode), '') AS "siteCode",
              coalesce(nullif(trim(camp.ahead), ''), trim(st.ccode), '') AS campus,
              coalesce(trim(st.class), '') AS "classCode",
              coalesce(nullif(trim(cl.ahead), ''), trim(st.class), '') AS "className",
              coalesce(nullif(trim(se.ahead), ''), trim(st.sec), '') AS "sectionName"
       FROM student st
       LEFT JOIN acc camp ON camp.acode = st.ccode
       LEFT JOIN acc cl ON cl.acode = st.class
       LEFT JOIN acc se ON se.acode = st.sec
       WHERE st.sdno = $1
       LIMIT 1`,
      [sdno],
    );
    const info = student.rows[0];
    if (!info) return { info: null, message: `Student ${sdno} not found.` };
    const zone = await this.zonePrefix(username);
    if (zone && info.siteCode && !info.siteCode.startsWith(zone)) {
      return { info: null, message: 'Student outside your zone.' };
    }
    return { info, message: '' };
  }

  /**
   * Legacy H.F partial payment: for each bill, the G is reduced to the received amount,
   * a receipt F with the same number is posted, and any remainder becomes a new unpaid G.
   */
  async receivePayment(
    username: string,
    body: {
      payDate?: string;
      bankCode?: string;
      balanceMode?: string;
      lines?: Array<{ invno?: string; received?: number | string }>;
    },
  ) {
    const payDate = this.normDate(String(body.payDate || '')) || this.today();
    const bankCode = String(body.bankCode || '').trim();
    if (!bankCode.startsWith('1506')) {
      return { ok: false, message: 'Select a cash / bank account.' };
    }
    const carry = String(body.balanceMode || '').trim() === 'carry';
    const wanted = (Array.isArray(body.lines) ? body.lines : [])
      .map((l) => ({
        invno: String(l.invno || '').trim().toUpperCase(),
        received: round2(Math.max(0, Number(l.received) || 0)),
      }))
      .filter((l) => l.invno.endsWith('G') && l.received > 0);
    if (!wanted.length) return { ok: false, message: 'Enter a received amount on at least one challan.' };

    const zone = await this.zonePrefix(username);
    const uname = username.trim() || null;
    const receipts: string[] = [];
    const balances: Array<{ invno: string; amount: number }> = [];
    let totalReceived = 0;
    let sdnoOut = '';
    let ccodeOut = '';

    const balanceDue = carry ? this.monthEnd(payDate, 1) : this.addDays(payDate, 10);

    try {
      await this.database.withTransaction(async (client) => {
        let nextNo = await this.lockFeeSequence(client);

        for (const line of wanted) {
          const num = line.invno.slice(0, -1);
          const master = await client.query<{
            invno: string;
            nar: string;
            ccode: string;
            sdno: string;
            mont: string;
            aclas: string;
            u4: string;
            studentName: string;
            className: string;
          }>(
            `SELECT trim(m.invno) AS invno,
                    coalesce(trim(m.nar), '') AS nar,
                    coalesce(trim(m.ccode), '') AS ccode,
                    coalesce(trim(m.sdno), '') AS sdno,
                    coalesce(trim(m.mont), '') AS mont,
                    coalesce(trim(m.aclas), '') AS aclas,
                    coalesce(trim(m.u4), '') AS u4,
                    coalesce(trim(st.name), '') AS "studentName",
                    coalesce(nullif(trim(cl.ahead), ''), '') AS "className"
             FROM accmast m
             LEFT JOIN student st ON st.sdno = m.sdno
             LEFT JOIN acc cl ON cl.acode = m.aclas
             WHERE m.invno = $1
             LIMIT 1
             FOR UPDATE OF m`,
            [line.invno],
          );
          const g = master.rows[0];
          if (!g) throw new Error(`Challan ${line.invno} not found.`);
          if (zone && g.ccode && !g.ccode.startsWith(zone)) {
            throw new Error(`Challan ${line.invno} is outside your zone.`);
          }
          const paid = await client.query(`SELECT 1 FROM accmast WHERE invno = $1 LIMIT 1`, [`${num}F`]);
          if (paid.rowCount) throw new Error(`Challan ${line.invno} is already paid.`);

          const det = await client.query<{ acode: string; dr: string; cr: string }>(
            `SELECT trim(acode) AS acode, (${NUM('d', 'dr')})::text AS dr, (${NUM('d', 'cr')})::text AS cr
             FROM accdet d WHERE d.invno = $1 ORDER BY d.row_id`,
            [line.invno],
          );
          const amount = round2(det.rows.reduce((s, r) => s + (Number(r.dr) || 0), 0));
          const receivable = det.rows.find((r) => Number(r.dr) > 0)?.acode || g.u4;
          const income = det.rows.find((r) => Number(r.cr) > 0)?.acode || '';
          if (!receivable || !income || amount <= 0) {
            throw new Error(`Challan ${line.invno} has no valid amount lines.`);
          }
          if (line.received - amount > 0.005) {
            throw new Error(`Received on ${line.invno} (${line.received}) is more than the bill (${amount}).`);
          }
          const balance = round2(amount - line.received);

          if (balance > 0.005) {
            await client.query(`UPDATE accdet SET dr = $2 WHERE invno = $1 AND (${NUM('accdet', 'dr')}) > 0`, [
              line.invno,
              String(line.received),
            ]);
            await client.query(`UPDATE accdet SET cr = $2 WHERE invno = $1 AND (${NUM('accdet', 'cr')}) > 0`, [
              line.invno,
              String(line.received),
            ]);

            nextNo += 1;
            const balInv = `${String(nextNo).padStart(6, '0')}G`;
            await client.query(
              `INSERT INTO accmast
                 (invno, invdate, nar, ccode, pflag, edate, uname, tflag, u4, sdno, mont, aclas, dudate)
               VALUES ($1, $2, $3, $4, 'P', $2, $5, '1', $6, $7, $8, $9, $10)`,
              [
                balInv,
                `${payDate} 00:00:00`,
                `${g.nar.replace(/\s*\(Balance\)$/i, '')} (Balance)`,
                g.ccode,
                uname,
                receivable,
                g.sdno,
                g.mont || null,
                g.aclas || null,
                `${balanceDue} 00:00:00`,
              ],
            );
            await client.query(
              `INSERT INTO accdet (invno, acode, dr, cr) VALUES ($1, $2, $3, '0'), ($1, $4, '0', $3)`,
              [balInv, receivable, String(balance), income],
            );
            balances.push({ invno: balInv, amount: balance });
          }

          const fInv = `${num}F`;
          const fNar = [g.nar, g.studentName && `Name ${g.studentName}`, g.className && `Class ${g.className}`]
            .filter(Boolean)
            .join(' ');
          await client.query(`UPDATE accmast SET bcode = $2 WHERE invno = $1`, [line.invno, bankCode]);
          await client.query(
            `INSERT INTO accmast
               (invno, invdate, nar, ccode, pflag, edate, uname, tflag, u4, sdno, mont, bcode, aclas)
             VALUES ($1, $2, $3, $4, 'P', $2, $5, '1', $6, $7, $8, $9, $10)`,
            [
              fInv,
              `${payDate} 00:00:00`,
              fNar,
              g.ccode,
              uname,
              receivable,
              g.sdno,
              g.mont || null,
              bankCode,
              g.aclas || null,
            ],
          );
          await client.query(
            `INSERT INTO accdet (invno, acode, dr, cr) VALUES ($1, $2, $3, '0'), ($1, $4, '0', $3)`,
            [fInv, bankCode, String(line.received), receivable],
          );
          receipts.push(fInv);
          totalReceived = round2(totalReceived + line.received);
          sdnoOut = g.sdno;
          ccodeOut = g.ccode;
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to receive payment.';
      return { ok: false, message };
    }

    const balanceTotal = round2(balances.reduce((s, b) => s + b.amount, 0));
    await this.activityLog.write({
      category: 'activity',
      username: username || 'Unknown',
      activity: 'Fee Payment Received',
      description: `Received ${totalReceived.toFixed(2)} for ${sdnoOut} (${receipts.join(', ')})${
        balances.length ? ` · balance ${balanceTotal.toFixed(2)} on ${balances.map((b) => b.invno).join(', ')}` : ''
      }`,
      module: 'Fee Control',
      campus: '',
      campusCode: ccodeOut,
      status: 'Success',
      meta: { sdno: sdnoOut, receipts, balances, carry },
    });

    return {
      ok: true,
      message: balances.length
        ? `Received ${totalReceived.toFixed(2)}. Balance ${balanceTotal.toFixed(2)} moved to ${balances
            .map((b) => b.invno)
            .join(', ')}.`
        : `Received ${totalReceived.toFixed(2)}.`,
      sdno: sdnoOut,
      receipts,
      balances,
      balanceTotal,
      balanceDue,
    };
  }

  /**
   * Undo a fee payment: removes the …F receipt and, if that payment split the bill, folds the
   * unpaid "(Balance)" challan it created back into the original …G.
   */
  async reversePayment(username: string, invnoRaw: string) {
    const raw = String(invnoRaw || '').trim().toUpperCase();
    if (!/^\d+[GF]?$/.test(raw)) return { ok: false, message: 'Enter a valid challan or receipt number.' };
    const num = raw.replace(/[GF]$/, '');
    const gInv = `${num}G`;
    const fInv = `${num}F`;
    const zone = await this.zonePrefix(username);
    let restored = 0;
    let merged = '';
    let sdno = '';
    let ccode = '';

    try {
      await this.database.withTransaction(async (client) => {
        await this.lockFeeSequence(client);
        const f = await client.query<{ invdate: string; ccode: string; sdno: string }>(
          `SELECT left(trim(invdate), 10) AS invdate, coalesce(trim(ccode), '') AS ccode,
                  coalesce(trim(sdno), '') AS sdno
           FROM accmast WHERE invno = $1 LIMIT 1 FOR UPDATE`,
          [fInv],
        );
        const receipt = f.rows[0];
        if (!receipt) throw new Error(`Challan ${gInv} is not paid.`);
        if (zone && receipt.ccode && !receipt.ccode.startsWith(zone)) {
          throw new Error(`Receipt ${fInv} is outside your zone.`);
        }
        sdno = receipt.sdno;
        ccode = receipt.ccode;

        await client.query(`DELETE FROM accdet WHERE invno = $1`, [fInv]);
        await client.query(`DELETE FROM accmast WHERE invno = $1`, [fInv]);

        const g = await client.query<{ nar: string; sdno: string; mont: string; u4: string }>(
          `SELECT coalesce(trim(nar), '') AS nar, coalesce(trim(sdno), '') AS sdno,
                  coalesce(trim(mont), '') AS mont, coalesce(trim(u4), '') AS u4
           FROM accmast WHERE invno = $1 LIMIT 1 FOR UPDATE`,
          [gInv],
        );
        const bill = g.rows[0];
        if (!bill) return;

        const balNar = `${bill.nar.replace(/\s*\(Balance\)$/i, '')} (Balance)`;
        const bal = await client.query<{ invno: string; paid: boolean }>(
          `SELECT trim(b.invno) AS invno, ${G_PAID_SQL('b')} AS paid
           FROM accmast b
           WHERE right(trim(b.invno), 1) = 'G'
             AND b.invno > $1
             AND coalesce(trim(b.sdno), '') = $2
             AND coalesce(trim(b.mont), '') = $3
             AND coalesce(trim(b.u4), '') = $4
             AND trim(b.nar) = $5
             AND left(trim(b.invdate), 10) = $6
           ORDER BY b.invno
           LIMIT 1
           FOR UPDATE OF b`,
          [gInv, bill.sdno, bill.mont, bill.u4, balNar, receipt.invdate],
        );
        const balInv = bal.rows[0]?.invno;
        if (!balInv || bal.rows[0]?.paid) return;

        const amt = await client.query<{ amount: string }>(
          `SELECT coalesce(sum(${NUM('d', 'dr')}), 0)::text AS amount FROM accdet d WHERE d.invno = $1`,
          [balInv],
        );
        const extra = round2(Number(amt.rows[0]?.amount) || 0);
        if (extra > 0) {
          await client.query(
            `UPDATE accdet SET dr = ((${NUM('accdet', 'dr')}) + $2)::text
             WHERE invno = $1 AND (${NUM('accdet', 'dr')}) > 0`,
            [gInv, extra],
          );
          await client.query(
            `UPDATE accdet SET cr = ((${NUM('accdet', 'cr')}) + $2)::text
             WHERE invno = $1 AND (${NUM('accdet', 'cr')}) > 0`,
            [gInv, extra],
          );
        }
        await client.query(`DELETE FROM accdet WHERE invno = $1`, [balInv]);
        await client.query(`DELETE FROM accmast WHERE invno = $1`, [balInv]);
        restored = extra;
        merged = balInv;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reverse payment.';
      return { ok: false, message };
    }

    await this.activityLog.write({
      category: 'activity',
      username: username || 'Unknown',
      activity: 'Fee Payment Reversed',
      description: `Reversed payment ${fInv} for ${sdno}${merged ? ` · merged balance ${merged} (${restored.toFixed(2)}) back into ${gInv}` : ''}`,
      module: 'Fee Control',
      campus: '',
      campusCode: ccode,
      status: 'Success',
      meta: { invno: gInv, receipt: fInv, merged, restored },
    });

    return {
      ok: true,
      message: merged
        ? `Payment reversed. ${gInv} is unpaid again (balance ${merged} merged back).`
        : `Payment reversed. ${gInv} is unpaid again.`,
      sdno,
    };
  }

  /**
   * Serialises fee bill/receipt numbering (G and F share one sequence) for the rest of the
   * transaction and returns the highest number in use.
   */
  private async lockFeeSequence(client: PoolClient) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('accmast_fee_gf_seq'))`);
    const seq = await client.query<{ n: string }>(
      `SELECT coalesce(max(left(invno, length(invno) - 1)::bigint), 0)::text AS n
       FROM accmast WHERE invno ~ '^[0-9]+[GF]$'`,
    );
    return Number(seq.rows[0]?.n || 0);
  }

  /**
   * Legacy R.B "Fee Voucher Print Single": bills (…G) for one student and fee month from the
   * student's fee master. Monthly heads bill once per month, annual heads once per year, and
   * one-time heads (admission, registration, transfer) once ever — re-running never duplicates.
   */
  async generateChallans(
    username: string,
    sdnoRaw: string,
    montRaw = '',
    dueRaw = '',
    headsRaw: unknown = [],
    fineRaw: unknown = 0,
  ) {
    const sdno = String(sdnoRaw || '').trim().toUpperCase();
    if (!sdno) return { ok: false, message: 'Student ID required.', created: [] };
    const rawKey = toYyyymm(montRaw);
    const mont = rawKey ? `${rawKey.slice(4)}${rawKey.slice(0, 4)}` : this.currentMont();
    const montKey = toYyyymm(mont);
    const year = montKey.slice(0, 4);

    const st = await this.database.query<{
      sdno: string;
      stat: string;
      ccode: string;
      cls: string;
      tfee: string;
      transfee: string;
      adfee: string;
      regfee: string;
      migfee: string;
      anualfee: string;
      sumpack: string;
      security: string;
      finefee: string;
      adate: string;
    }>(
      `SELECT trim(sdno) AS sdno, coalesce(trim(stat), '') AS stat, coalesce(trim(ccode), '') AS ccode,
              coalesce(trim(class), '') AS cls, left(coalesce(adate::text, ''), 10) AS adate,
              coalesce(tfee, '') AS tfee, coalesce(transfee, '') AS transfee, coalesce(adfee, '') AS adfee,
              coalesce(regfee, '') AS regfee, coalesce(migfee, '') AS migfee,
              coalesce(anualfee, '') AS anualfee, coalesce(sumpack, '') AS sumpack,
              coalesce(security, '') AS security, coalesce(finefee, '') AS finefee
       FROM student WHERE sdno = $1 LIMIT 1`,
      [sdno],
    );
    const s = st.rows[0];
    if (!s) return { ok: false, message: `Student ${sdno} not found.`, created: [] };
    if (s.stat.toUpperCase() !== 'ACTIVE') {
      return { ok: false, message: 'Challans are generated for Active students only.', created: [] };
    }
    const zone = await this.zonePrefix(username);
    if (zone && s.ccode && !s.ccode.startsWith(zone)) {
      return { ok: false, message: 'Student outside your zone.', created: [] };
    }
    const admissionKey = /^\d{4}-\d{2}-\d{2}$/.test(s.adate) ? s.adate.slice(0, 4) + s.adate.slice(5, 7) : '';
    if (admissionKey && montKey < admissionKey) {
      return { ok: true, message: 'Month is before admission.', mont, created: [], beforeAdmission: true };
    }

    const label = this.montLabel(mont);
    const picked = (Array.isArray(headsRaw) ? headsRaw : [])
      .map((h) => String(h || '').trim().toLowerCase())
      .filter(Boolean);
    const want = (id: string) => !picked.length || picked.includes(id);
    const monthMm = montKey.slice(4);
    const summerBreak = monthMm === '06' || monthMm === '07' || monthMm === '08';
    const overrideFine = round2(Number(fineRaw) || 0);
    const masterFine = round2(Number(String(s.finefee || '').replace(/,/g, '')) || 0);
    const fineAmt = overrideFine > 0 ? overrideFine : masterFine;
    // Yearly heads follow the legacy billing month (Annual Fund in March, Summer Pack in June),
    // or the admission month for a student who joins mid-year. Van is skipped in Jun–Aug.
    const heads: Array<{
      id: string;
      raw: string;
      recv: string;
      income: string;
      nar: string;
      scope: 'month' | 'year' | 'once';
      billMonth?: string;
    }> = [
      { id: 'admission', raw: s.adfee, recv: '1502010005', income: '310105', nar: `Admission Fee ${mont}`, scope: 'once' },
      { id: 'registration', raw: s.regfee, recv: '1502010007', income: '310107', nar: `Registration Fee ${mont}`, scope: 'once' },
      { id: 'transfer', raw: s.migfee, recv: '1502010008', income: '310108', nar: `Migration/Re-addmission Fee ${mont}`, scope: 'once' },
      {
        id: 'freeze',
        raw: s.security,
        recv: '1502010011',
        income: '310111',
        nar: `Freeze Admission ${mont}`,
        scope: 'once',
      },
      { id: 'annual', raw: s.anualfee, recv: '1502010009', income: '310109', nar: `Annual Fund ${year}`, scope: 'year', billMonth: '03' },
      { id: 'summer', raw: s.sumpack, recv: '1502010004', income: '310104', nar: `Summer Pack ${year}`, scope: 'year', billMonth: '06' },
      { id: 'tuition', raw: s.tfee, recv: '1502010001', income: '310101', nar: `Tution Fee ${label}`, scope: 'month' },
      { id: 'van', raw: s.transfee, recv: '1502010003', income: '310103', nar: `Van Fee ${label}`, scope: 'month' },
      { id: 'fine', raw: String(fineAmt), recv: '1502010010', income: '310110', nar: `Fine ${label}`, scope: 'month' },
    ];

    const issue = this.today();
    const soonest = this.addDays(issue, 10);
    const monthDue = `${year}-${montKey.slice(4)}-10`;
    const customDue = this.normDate(String(dueRaw || ''));
    const due = customDue || (monthDue > soonest ? monthDue : soonest);
    const created: Array<{ invno: string; narration: string; amount: number }> = [];

    try {
      await this.database.withTransaction(async (client) => {
        let nextNo = await this.lockFeeSequence(client);
        for (const head of heads) {
          if (!want(head.id)) continue;
          if (head.id === 'van' && summerBreak) continue;
          const amount = round2(Number(String(head.raw).replace(/,/g, '')) || 0);
          if (amount <= 0) continue;
          if (head.scope === 'year' && montKey.slice(4) !== head.billMonth && montKey !== admissionKey) continue;
          // Month bills: match legacy MMYYYY and YYYYMM so we do not skip/duplicate across formats.
          const billed = await client.query(
            `SELECT 1 FROM accmast m
             WHERE m.sdno = $1 AND m.invno LIKE '%G' AND trim(m.u4) = $2
               AND (
                 $3 = 'once'
                 OR ($3 = 'year' AND right(trim(m.mont), 4) = $4)
                 OR ($3 = 'month' AND trim(m.mont) IN ($5, $6))
               )
             LIMIT 1`,
            [sdno, head.recv, head.scope, year, mont, montKey],
          );
          if (billed.rowCount) continue;

          nextNo += 1;
          const invno = `${String(nextNo).padStart(6, '0')}G`;
          await client.query(
            `INSERT INTO accmast
               (invno, invdate, nar, ccode, pflag, edate, uname, tflag, u4, sdno, mont, aclas, dudate)
             VALUES ($1, $2, $3, $4, 'P', $2, $5, '1', $6, $7, $8, $9, $10)`,
            [
              invno,
              `${issue} 00:00:00`,
              head.nar,
              s.ccode || null,
              username.trim() || null,
              head.recv,
              sdno,
              mont,
              s.cls || null,
              `${due} 00:00:00`,
            ],
          );
          await client.query(
            `INSERT INTO accdet (invno, acode, dr, cr) VALUES ($1, $2, $3, '0'), ($1, $4, '0', $3)`,
            [invno, head.recv, String(amount), head.income],
          );
          created.push({ invno, narration: head.nar, amount });
        }
        if (customDue) {
          await client.query(
            `UPDATE accmast m
                SET dudate = $2
              WHERE trim(m.sdno) = $1
                AND m.invno LIKE '%G'
                AND NOT ${G_PAID_SQL('m')}`,
            [sdno, `${customDue} 00:00:00`],
          );
        }
      });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Failed to generate challans.', created: [] };
    }

    if (created.length) {
      await this.activityLog.write({
        category: 'activity',
        username: username || 'Unknown',
        activity: 'Fee Challan Generated',
        description: `Generated ${created.length} challan(s) for ${sdno} ${mont}: ${created
          .map((c) => `${c.invno} ${c.amount}`)
          .join(', ')}`,
        module: 'Fee Control',
        campus: '',
        campusCode: s.ccode,
        status: 'Success',
        meta: { sdno, mont, created },
      });
    }
    return { ok: true, message: `${created.length} challan(s) generated.`, mont, created };
  }

  /** Total of unpaid fee bills per student, for the Students Register "Pending" column. */
  async studentDues(sdnosRaw: string) {
    const sdnos = String(sdnosRaw || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 200);
    const mont = this.currentMont();
    const month = this.montStatusLabel(mont);
    const vouchers: Record<string, { count: number; unpaid: number; month: string }> = {};
    if (!sdnos.length) return { dues: {} as Record<string, { amount: number; count: number }>, mont, month, vouchers };
    const monthRows = await this.database.query<{ sdno: string; mont: string; n: string; unpaid: string }>(
      `WITH billed AS (
         SELECT trim(m.sdno) AS sdno,
                trim(m.mont) AS mont,
                right(trim(m.mont), 4) || left(trim(m.mont), 2) AS yyyymm,
                count(*)::text AS n,
                count(*) FILTER (WHERE NOT ${G_PAID_SQL('m')})::text AS unpaid
           FROM accmast m
          WHERE m.sdno = ANY($1::text[])
            AND m.invno LIKE '%G'
            AND length(trim(m.mont)) >= 6
          GROUP BY trim(m.sdno), trim(m.mont)
       )
       SELECT DISTINCT ON (sdno) sdno, mont, n, unpaid
         FROM billed
        ORDER BY sdno, yyyymm DESC`,
      [sdnos],
    );
    for (const r of monthRows.rows) {
      vouchers[r.sdno] = {
        count: Number(r.n) || 0,
        unpaid: Number(r.unpaid) || 0,
        month: this.montStatusLabel(r.mont),
      };
    }
    const rows = await this.database.query<{ sdno: string; amount: string; n: string }>(
      `SELECT trim(m.sdno) AS sdno, coalesce(sum(${this.debitSql}), 0)::text AS amount,
              count(DISTINCT m.invno)::text AS n
       FROM accmast m
       JOIN accdet d ON d.invno = m.invno
       WHERE m.sdno = ANY($1::text[])
         AND m.invno LIKE '%G'
         AND NOT ${G_PAID_SQL('m')}
       GROUP BY trim(m.sdno)`,
      [sdnos],
    );
    const dues: Record<string, { amount: number; count: number }> = {};
    for (const r of rows.rows) {
      const amount = round2(Number(r.amount) || 0);
      if (amount > 0) dues[r.sdno] = { amount, count: Number(r.n) || 0 };
    }
    return { dues, mont, month, vouchers };
  }

  async logReport(
    username: string,
    report: string,
    description: string,
    campus = '',
    campusCode = '',
  ) {
    await this.activityLog.write({
      category: 'activity',
      username: username || 'Unknown',
      activity: 'Report Generated',
      description: description || report,
      module: 'Financial Control',
      campus,
      campusCode,
      status: 'Success',
      meta: { report },
    });
  }

  private parentCodes(code: string): string[] {
    const parents: string[] = [];
    // COA lengths: 1, 2, 4, 6, 10
    const lens = [1, 2, 4, 6];
    for (const len of lens) {
      if (code.length > len) parents.push(code.slice(0, len));
    }
    return parents;
  }

  private nearestParent(code: string, map: Map<string, TbNode>): TbNode | null {
    const lens = [6, 4, 2, 1];
    for (const len of lens) {
      if (code.length <= len) continue;
      const p = map.get(code.slice(0, len));
      if (p) return p;
    }
    return null;
  }

  private hasMatchingDescendant(
    code: string,
    balMap: Map<string, { debit: number; credit: number }>,
    nameMap: Map<string, { name: string; flag: string }>,
    search: string,
  ) {
    const s = search.toLowerCase();
    for (const c of balMap.keys()) {
      if (!c.startsWith(code) || c === code) continue;
      const hay = `${c} ${nameMap.get(c)?.name || ''}`.toLowerCase();
      if (hay.includes(s)) return true;
    }
    return false;
  }

  private filterTree(nodes: TbNode[], search: string): TbNode[] {
    const s = search.toLowerCase();
    const out: TbNode[] = [];
    for (const n of nodes) {
      const children = this.filterTree(n.children, search);
      const self = `${n.code} ${n.name}`.toLowerCase().includes(s);
      if (self || children.length) {
        out.push({ ...n, children: self ? n.children : children });
      }
    }
    return out;
  }

  private async siteScope(username: string, site: string) {
    const zone = await this.zonePrefix(username);
    let code = site.trim();
    if (!code) code = zone || '';
    if (zone && code && !(code === zone || code.startsWith(zone))) return zone;
    return code;
  }

  private async zonePrefix(username: string) {
    const name = username.trim();
    if (!name) return '';
    const user = await this.database.query<{ desi: string | null }>(
      `SELECT desi FROM puser WHERE upper(trim(tname)) = upper($1) LIMIT 1`,
      [name],
    );
    const desi = user.rows[0]?.desi?.trim() ?? '';
    return desi.length >= 4 ? desi : '';
  }

  /** YYYY-MM-DD, ISO prefix, DD-MM-YYYY / DD/MM/YYYY, or compact DDMMYYYY → YYYY-MM-DD. */
  private normDate(value: string) {
    const s = String(value || '').trim();
    if (!s) return '';
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) {
      const y = Number(iso[1]);
      const m = Number(iso[2]);
      const d = Number(iso[3]);
      if (y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        return `${iso[1]}-${iso[2]}-${iso[3]}`;
      }
    }
    const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
    if (dmy) {
      const dd = dmy[1].padStart(2, '0');
      const mm = dmy[2].padStart(2, '0');
      const yyyy = dmy[3];
      const m = Number(mm);
      const d = Number(dd);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${yyyy}-${mm}-${dd}`;
    }
    const digits = s.replace(/\D/g, '');
    if (digits.length === 8) {
      const dd = digits.slice(0, 2);
      const mm = digits.slice(2, 4);
      const yyyy = digits.slice(4);
      const m = Number(mm);
      const d = Number(dd);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${yyyy}-${mm}-${dd}`;
    }
    return '';
  }

  private today() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private monthStart() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }

  /** Fee month as stored in accmast.mont (MMYYYY). */
  private currentMont() {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
  }

  /** MMYYYY → "oct-2026", the legacy narration style. */
  private montLabel(mont: string) {
    const names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    return `${names[Number(mont.slice(0, 2)) - 1] || mont.slice(0, 2)}-${mont.slice(2)}`;
  }

  /** MMYYYY → "Feb 2027" for the Students Register voucher column. */
  private montStatusLabel(mont: string) {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const key = String(mont || '').replace(/\D/g, '').padStart(6, '0').slice(-6);
    const mm = Number(key.slice(0, 2));
    return `${names[mm - 1] || key.slice(0, 2)} ${key.slice(2)}`;
  }

  private addDays(ymd: string, days: number) {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** Last day of the month `offset` months after `ymd`. */
  private monthEnd(ymd: string, offset = 0) {
    const d = new Date(`${ymd}T00:00:00Z`);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 0)).toISOString().slice(0, 10);
  }

  private nextDay(ymd: string) {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export type ColFilterType = 'like' | 'exact' | 'num' | 'date';

/**
 * WHERE clause over the output columns of a `base` CTE, for `f_<key>` header filters.
 * `num` matches the 2-dp amount as text so "1500" finds 1500.00 and 21500.
 */
function colFilterOutSql(
  colFilters: Record<string, string>,
  spec: Record<string, { expr: string; type: ColFilterType }>,
  params: unknown[],
) {
  const where = colFilterConds(colFilters, spec, params);
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

function colFilterConds(
  colFilters: Record<string, string>,
  spec: Record<string, { expr: string; type: ColFilterType }>,
  params: unknown[],
) {
  const where: string[] = [];
  for (const [key, raw] of Object.entries(colFilters)) {
    const col = spec[key];
    const v = String(raw ?? '').trim();
    if (!col || !v) continue;
    const e = `coalesce((${col.expr})::text, '')`;
    if (col.type === 'exact') {
      params.push(v);
      where.push(`upper(trim(${e})) = upper($${params.length})`);
    } else if (col.type === 'num') {
      params.push(`%${v.replace(/,/g, '')}%`);
      where.push(
        `(CASE WHEN ${e} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN round(${e}::numeric, 2)::text ELSE ${e} END) ILIKE $${params.length}`,
      );
    } else if (col.type === 'date') {
      params.push(`%${v}%`);
      const n = params.length;
      where.push(
        `(left(${e}, 10) ILIKE $${n}
          OR (substr(${e}, 9, 2) || '/' || substr(${e}, 6, 2) || '/' || substr(${e}, 1, 4)) ILIKE $${n})`,
      );
    } else {
      params.push(`%${v}%`);
      where.push(`${e} ILIKE $${params.length}`);
    }
  }
  return where;
}

/** Same matching rules as `colFilterOutSql`, for reports aggregated in memory. */
function filterInMemory<T extends Record<string, unknown>>(
  rows: T[],
  colFilters: Record<string, string>,
  spec: Record<string, { get: (r: T) => unknown; type: ColFilterType }>,
) {
  const active = Object.entries(colFilters)
    .map(([k, v]) => [spec[k], String(v ?? '').trim()] as const)
    .filter(([col, v]) => col && v);
  if (!active.length) return rows;
  return rows.filter((r) =>
    active.every(([col, v]) => {
      const raw = col!.get(r);
      const text = String(raw ?? '').trim();
      const needle = v.toLowerCase();
      if (col!.type === 'exact') return text.toLowerCase() === needle;
      if (col!.type === 'num') {
        const n = Number(raw);
        const shown = Number.isFinite(n) ? n.toFixed(2) : text;
        return shown.includes(needle.replace(/,/g, ''));
      }
      if (col!.type === 'date') {
        const d = text.slice(0, 10);
        const dmy = d.length === 10 ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '';
        return d.toLowerCase().includes(needle) || dmy.includes(needle);
      }
      return text.toLowerCase().includes(needle);
    }),
  );
}

function distinctSorted(values: unknown[]) {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const v = String(raw ?? '').trim();
    if (!v || v === '—') continue;
    if (!seen.has(v.toUpperCase())) seen.set(v.toUpperCase(), v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Accept MMYYYY (legacy mont) or YYYYMM → return YYYYMM for range compare. */
function toYyyymm(raw: string) {
  const v = String(raw || '')
    .trim()
    .replace(/\D/g, '');
  if (v.length !== 6) return '';
  const mmFirst = Number(v.slice(0, 2));
  if (mmFirst >= 1 && mmFirst <= 12) return v.slice(2) + v.slice(0, 2);
  const year = Number(v.slice(0, 4));
  const mmLast = Number(v.slice(4, 6));
  if (year >= 1990 && year <= 2100 && mmLast >= 1 && mmLast <= 12) return v;
  return '';
}

function monthKeysToDateSpan(fromKey: string, toKey: string) {
  const a = fromKey <= toKey ? fromKey : toKey;
  const b = fromKey <= toKey ? toKey : fromKey;
  const from = `${a.slice(0, 4)}-${a.slice(4, 6)}-01`;
  const y = Number(b.slice(0, 4));
  const m = Number(b.slice(4, 6));
  const last = new Date(Date.UTC(y, m, 0));
  const to = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`;
  const next = new Date(Date.UTC(y, m, 1));
  const toExclusive = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  return { from, to, toExclusive };
}
