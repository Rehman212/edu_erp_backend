import { Injectable } from '@nestjs/common';
import { ActivityLogService } from './activity-log.service';
import { DatabaseService } from './database.service';
import { assertRoleAccess } from './role-access';

export type StockReportMode =
  | 'full'
  | 'nonZero'
  | 'zero'
  | 'valueLedger'
  | 'qtyLedger'
  | 'drillDown'
  | 'assets'
  | 'purchaseCompare'
  | 'lastAudit';

@Injectable()
export class InventoryControlService {
  private narrationWidened = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /** Allow long voucher narration (~500 words) instead of short varchar. */
  private async ensureWideNarration() {
    if (this.narrationWidened) return;
    try {
      await this.database.query(`ALTER TABLE purmast ALTER COLUMN narp TYPE text`);
      await this.database.query(`ALTER TABLE accmast ALTER COLUMN nar TYPE text`);
      await this.database.query(`ALTER TABLE accdet ALTER COLUMN snar TYPE text`);
    } catch {
      /* already text / no rights — still try the insert */
    }
    this.narrationWidened = true;
  }

  /**
   * ESS stock movement sign from invoice suffix:
   * P/N = in (qty as stored), S/R = out (-abs(qty)).
   * Matches legacy Site Bal / Total (e.g. Pencils Lead = -3460.5).
   */
  private readonly signedQtySql = `CASE
    WHEN coalesce(trim(d.qty), '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN
      CASE right(upper(trim(d.invno)), 1)
        WHEN 'S' THEN -abs(trim(d.qty)::numeric)
        WHEN 'R' THEN -abs(trim(d.qty)::numeric)
        ELSE trim(d.qty)::numeric
      END
    ELSE 0
  END`;

  private readonly signedValueSql = `CASE
    WHEN coalesce(trim(d.qty), '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
     AND coalesce(trim(d.rate), '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN
      CASE right(upper(trim(d.invno)), 1)
        WHEN 'S' THEN -abs(trim(d.qty)::numeric) * trim(d.rate)::numeric
        WHEN 'R' THEN -abs(trim(d.qty)::numeric) * trim(d.rate)::numeric
        ELSE trim(d.qty)::numeric * trim(d.rate)::numeric
      END
    ELSE 0
  END`;

  async sites(username: string) {
    const zone = await this.zonePrefix(username);
    // Same hierarchy as Result Analysis: zone codes (1401…) + campuses under them.
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

  /** Full item head / group / leaf list for Find lookup (legacy Ahead + Acode). */
  async categories(q = '') {
    const search = q.trim().replace(/%/g, '');
    const rows = await this.database.query<{ code: string; name: string }>(
      `SELECT DISTINCT ON (upper(trim(i.itemname)), trim(i.itemcode))
              trim(i.itemcode) AS code,
              trim(i.itemname) AS name
       FROM item i
       WHERE coalesce(trim(i.itemcode), '') <> ''
         AND coalesce(trim(i.itemname), '') <> ''
         AND (
           $1 = ''
           OR trim(i.itemcode) ILIKE '%' || $1 || '%'
           OR trim(i.itemname) ILIKE '%' || $1 || '%'
         )
       ORDER BY upper(trim(i.itemname)), trim(i.itemcode)
       LIMIT 5000`,
      [search],
    );
    return rows.rows;
  }

  async items(category = '', q = '') {
    const cat = category.trim();
    const search = q.trim();
    const rows = await this.database.query<{ code: string; name: string; unit: string }>(
      `SELECT DISTINCT ON (trim(i.itemcode))
              trim(i.itemcode) AS code,
              trim(i.itemname) AS name,
              coalesce(nullif(trim(i.uom), ''), '—') AS unit
       FROM item i
       WHERE coalesce(trim(i.itemcode), '') <> ''
         AND coalesce(trim(i.uom), '') <> ''
         AND ($1 = '' OR trim(i.itemcode) LIKE $1 || '%')
         AND (
           $2 = ''
           OR trim(i.itemcode) ILIKE '%' || $2 || '%'
           OR trim(i.itemname) ILIKE '%' || $2 || '%'
         )
       ORDER BY trim(i.itemcode), trim(i.itemname)
       LIMIT 2000`,
      [cat, search],
    );
    return rows.rows;
  }

  async stockReport(
    username: string,
    site: string,
    category: string,
    q: string,
    fromDate: string,
    toDate: string,
    mode: StockReportMode = 'full',
    page = 1,
    pageSize = 50,
    sort = 'desc',
    colFilters: Record<string, string> = {},
    optionsOnly = false,
  ) {
    const scope = await this.siteScope(username, site);
    if (!scope) {
      if (optionsOnly) return { category: [], siteName: [], unit: [] };
      return {
        rows: [],
        total: 0,
        page: 1,
        pageSize,
        summary: { totalQty: 0, totalValue: 0, locationBalance: 0, itemCount: 0 },
        mode,
        title: this.modeTitle(mode),
      };
    }

    const cat = category.trim();
    const search = q.trim();
    const fromScope = /^\d{4}-\d{2}-\d{2}$/.test(fromDate.trim()) ? fromDate.trim() : '';
    const toScope = /^\d{4}-\d{2}-\d{2}$/.test(toDate.trim()) ? toDate.trim() : '';
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    const reportMode = this.normalizeMode(mode);

    const sortKey = this.normalizeSort(sort);

    if (reportMode === 'purchaseCompare') {
      return this.purchaseComparison(scope, cat, search, fromScope, toScope, current, size, sortKey);
    }

    if (reportMode === 'drillDown') {
      return this.drillDown(scope, cat, search, fromScope, toScope, current, size, sortKey);
    }

    if (reportMode === 'lastAudit') {
      return this.lastAudit(scope, cat, search, fromScope, toScope, current, size, sortKey);
    }

    let modeFilter = '';
    if (reportMode === 'valueLedger') {
      // E.A — valued stock (hide zero-value lines)
      modeFilter = `AND st.value <> 0`;
    } else if (reportMode === 'nonZero' || reportMode === 'qtyLedger') {
      // E.B / E.D — quantity position (hide zero qty)
      modeFilter = `AND st.qty <> 0`;
    } else if (reportMode === 'zero') {
      modeFilter = `AND st.qty = 0`;
    } else if (reportMode === 'assets') {
      // G.A / G.C — asset group codes (1…)
      modeFilter = `AND st.item_code LIKE '1%'`;
    }

    const params: unknown[] = [
      `${scope}%`,
      cat,
      search,
      search ? `%${search}%` : '',
      fromScope,
      toScope,
    ];

    const catExpr = `coalesce(cg.name, left(st.item_code, 2))`;
    const siteExpr = `coalesce(nullif(trim(a.ahead), ''), st.site_code)`;
    const colWhere: string[] = [];
    const like = (expr: string, raw: string) => {
      params.push(`%${raw.trim()}%`);
      colWhere.push(`coalesce(${expr}, '') ILIKE $${params.length}`);
    };
    const exact = (expr: string, raw: string) => {
      params.push(raw.trim());
      colWhere.push(`upper(coalesce(${expr}, '')) = upper($${params.length})`);
    };
    const num = (expr: string, raw: string) => {
      params.push(`%${raw.replace(/,/g, '').trim()}%`);
      colWhere.push(`(${expr})::text ILIKE $${params.length}`);
    };
    for (const [key, raw] of Object.entries(colFilters)) {
      const v = String(raw || '').trim();
      if (!v) continue;
      switch (key) {
        case 'itemName':
          params.push(`%${v}%`);
          colWhere.push(
            `(coalesce(i.item_name, '') ILIKE $${params.length} OR st.item_code ILIKE $${params.length})`,
          );
          break;
        case 'category':
          exact(catExpr, v);
          break;
        case 'siteName':
          exact(siteExpr, v);
          break;
        case 'qty':
          num('round(st.qty, 2)', v);
          break;
        case 'unit':
          exact(`coalesce(i.unit, '—')`, v);
          break;
        case 'unitRate':
          num('CASE WHEN st.qty = 0 THEN 0 ELSE round(st.value / nullif(st.qty, 0), 2) END', v);
          break;
        case 'value':
          num('round(st.value, 2)', v);
          break;
        case 'status': {
          const s = v.toLowerCase();
          if (s === 'zero') colWhere.push(`st.qty = 0`);
          else if (s === 'short') colWhere.push(`st.qty < 0`);
          else if (s === 'low') colWhere.push(`st.qty > 0 AND st.qty < 10`);
          else if (s === 'in stock') colWhere.push(`st.qty >= 10`);
          break;
        }
        case 'lastMove':
          params.push(`%${v}%`);
          colWhere.push(
            `(coalesce(to_char(st.last_move, 'YYYY-MM-DD'), '') ILIKE $${params.length}
              OR coalesce(to_char(st.last_move, 'DD Mon YYYY'), '') ILIKE $${params.length})`,
          );
          break;
        default:
          break;
      }
    }
    const colFilterSql = colWhere.length ? `AND ${colWhere.join(' AND ')}` : '';

    const baseCte = `
      WITH purchases AS (
        SELECT trim(d.itemno) AS item_code,
               trim(m.ccode) AS site_code,
               sum(${this.signedQtySql}) AS qty_net,
               sum(${this.signedValueSql}) AS value_net,
               max(
                 CASE
                   WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(m.invdate)::timestamp
                   ELSE NULL
                 END
               ) AS last_move,
               max(d.row_id) AS last_touch
        FROM purdet d
        JOIN purmast m ON trim(m.invno) = trim(d.invno)
        WHERE coalesce(trim(d.itemno), '') <> ''
          AND trim(m.ccode) LIKE $1
          AND (
            ($5 = '' AND $6 = '')
            OR (
              trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
              AND ($5 = '' OR trim(m.invdate)::date >= $5::date)
              AND ($6 = '' OR trim(m.invdate)::date <= $6::date)
            )
          )
        GROUP BY 1, 2
      ),
      sales AS (
        SELECT trim(d.itemno) AS item_code,
               trim(coalesce(nullif(trim(m.wcode), ''), nullif(trim(m.pcode), ''), '')) AS site_code,
               sum(
                 CASE
                   WHEN coalesce(trim(d.qty), '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                   THEN trim(d.qty)::numeric ELSE 0
                 END
               ) AS qty_out,
               sum(
                 CASE
                   WHEN coalesce(trim(d.qty), '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    AND coalesce(trim(d.rate), '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                   THEN trim(d.qty)::numeric * trim(d.rate)::numeric
                   ELSE 0
                 END
               ) AS value_out
        FROM saldet d
        LEFT JOIN salmast m ON trim(m.invno) = trim(d.invno)
        WHERE coalesce(trim(d.itemno), '') <> ''
          AND trim(coalesce(nullif(trim(m.wcode), ''), nullif(trim(m.pcode), ''), '')) LIKE $1
        GROUP BY 1, 2
      ),
      stock AS (
        SELECT coalesce(p.item_code, s.item_code) AS item_code,
               coalesce(p.site_code, s.site_code) AS site_code,
               coalesce(p.qty_net, 0) - coalesce(s.qty_out, 0) AS qty,
               coalesce(p.value_net, 0) - coalesce(s.value_out, 0) AS value,
               p.last_move,
               p.last_touch
        FROM purchases p
        FULL OUTER JOIN sales s
          ON s.item_code = p.item_code AND s.site_code = p.site_code
      )
    `;

    const where = `
      FROM stock st
      LEFT JOIN LATERAL (
        SELECT trim(i.itemname) AS item_name,
               coalesce(nullif(trim(i.uom), ''), '—') AS unit,
               trim(i.itemcode) AS itemcode
        FROM item i
        WHERE trim(i.itemcode) = st.item_code
        ORDER BY i.row_id
        LIMIT 1
      ) i ON true
      LEFT JOIN LATERAL (
        SELECT trim(g.itemname) AS name
        FROM item g
        WHERE coalesce(trim(g.uom), '') = ''
          AND length(trim(g.itemcode)) BETWEEN 1 AND 4
          AND st.item_code LIKE trim(g.itemcode) || '%'
        ORDER BY length(trim(g.itemcode)) DESC
        LIMIT 1
      ) cg ON true
      LEFT JOIN acc a ON a.acode = st.site_code
      WHERE ($2 = '' OR st.item_code LIKE $2 || '%')
        AND (
          $3 = ''
          OR st.item_code ILIKE $4
          OR coalesce(i.item_name, '') ILIKE $4
          OR coalesce(nullif(trim(a.ahead), ''), st.site_code) ILIKE $4
        )
        ${modeFilter}
        ${colFilterSql}
    `;

    if (optionsOnly) {
      const opts = await this.database.query<{ kind: string; value: string }>(
        `${baseCte}
         , base AS (
           SELECT ${catExpr} AS category, ${siteExpr} AS site_name, coalesce(i.unit, '—') AS unit
           ${where}
         )
         SELECT DISTINCT 'category' AS kind, category AS value FROM base WHERE coalesce(category, '') <> ''
         UNION SELECT DISTINCT 'siteName', site_name FROM base WHERE coalesce(site_name, '') <> ''
         UNION SELECT DISTINCT 'unit', unit FROM base WHERE coalesce(unit, '') <> ''`,
        params,
      );
      const out: Record<string, string[]> = { category: [], siteName: [], unit: [] };
      const seen: Record<string, Set<string>> = {};
      for (const r of opts.rows) {
        const list = out[r.kind];
        if (!list) continue;
        const k = r.value.toUpperCase();
        seen[r.kind] ??= new Set();
        if (seen[r.kind].has(k)) continue;
        seen[r.kind].add(k);
        list.push(r.value);
      }
      for (const k of Object.keys(out)) {
        out[k].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      }
      return out;
    }

    const stats = await this.database.query<{
      total: string;
      total_qty: string;
      total_value: string;
    }>(
      `${baseCte}
       SELECT count(*)::text AS total,
              coalesce(sum(st.qty), 0)::text AS total_qty,
              coalesce(sum(st.value), 0)::text AS total_value
       ${where}`,
      params,
    );

    const rows = await this.database.query<{
      id: string;
      itemCode: string;
      itemName: string;
      category: string;
      siteCode: string;
      siteName: string;
      qty: string;
      value: string;
      unit: string;
      lastMove: string | null;
      unitRate: string;
    }>(
      `${baseCte}
       SELECT st.item_code || ':' || st.site_code AS id,
              st.item_code AS "itemCode",
              coalesce(nullif(i.item_name, ''), st.item_code) AS "itemName",
              ${catExpr} AS category,
              st.site_code AS "siteCode",
              coalesce(nullif(trim(a.ahead), ''), st.site_code) AS "siteName",
              st.qty::text AS qty,
              st.value::text AS value,
              coalesce(i.unit, '—') AS unit,
              to_char(st.last_move, 'YYYY-MM-DD') AS "lastMove",
              CASE
                WHEN st.qty = 0 THEN '0'
                ELSE round(st.value / nullif(st.qty, 0), 2)::text
              END AS "unitRate"
       ${where}
       ${this.stockOrderBy(sortKey)}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, offset],
    );

    const total = Number(stats.rows[0]?.total ?? 0);
    const totalQty = Number(stats.rows[0]?.total_qty ?? 0);
    const totalValue = Number(stats.rows[0]?.total_value ?? 0);

    return {
      rows: rows.rows.map((row, index) => ({
        id: row.id || `${offset + index + 1}`,
        itemCode: row.itemCode,
        itemName: row.itemName,
        category: row.category,
        siteCode: row.siteCode,
        siteName: row.siteName,
        qty: Number(row.qty) || 0,
        value: Number(row.value) || 0,
        unit: row.unit || '—',
        unitRate: Number(row.unitRate) || 0,
        lastMove: row.lastMove || '',
        status: this.stockStatus(Number(row.qty) || 0),
      })),
      total,
      page: current,
      pageSize: size,
      summary: {
        totalQty,
        totalValue,
        // Legacy ESS "Site Bal" / "Total" for an item are quantity, not Rs value.
        locationBalance: totalQty,
        itemCount: total,
      },
      mode: reportMode,
      title: this.modeTitle(reportMode),
    };
  }

  private async drillDown(
    scope: string,
    category: string,
    search: string,
    fromDate: string,
    toDate: string,
    page: number,
    pageSize: number,
    sort = 'desc',
  ) {
    const offset = (page - 1) * pageSize;
    const params = [`${scope}%`, category, search, search ? `%${search}%` : '', fromDate, toDate];
    const siteCode = scope.replace(/%/g, '') || '14';

    /** Group heads like ESS tree (prefer 4-char group, else 2-char). */
    const groupCodeSql = `coalesce(
      (
        SELECT trim(g.itemcode)
        FROM item g
        WHERE coalesce(trim(g.uom), '') = ''
          AND length(trim(g.itemcode)) BETWEEN 2 AND 4
          AND trim(p.item_code) LIKE trim(g.itemcode) || '%'
        ORDER BY length(trim(g.itemcode)) DESC, g.row_id
        LIMIT 1
      ),
      left(trim(p.item_code), 2)
    )`;

    const purchasesCte = `WITH purchases AS (
         SELECT trim(d.itemno) AS item_code,
                sum(${this.signedQtySql}) AS qty,
                sum(${this.signedValueSql}) AS value,
                max(
                  CASE WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
                       THEN trim(m.invdate)::timestamp ELSE NULL END
                ) AS last_move
         FROM purdet d
         JOIN purmast m ON trim(m.invno) = trim(d.invno)
         WHERE coalesce(trim(d.itemno), '') <> ''
           AND trim(m.ccode) LIKE $1
           AND ($2 = '' OR trim(d.itemno) LIKE $2 || '%')
           AND (
             ($5 = '' AND $6 = '')
             OR (
               trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
               AND ($5 = '' OR trim(m.invdate)::date >= $5::date)
               AND ($6 = '' OR trim(m.invdate)::date <= $6::date)
             )
           )
         GROUP BY 1
       ),
       grouped AS (
         SELECT ${groupCodeSql} AS cat_code,
                sum(p.qty) AS qty,
                sum(p.value) AS value,
                max(p.last_move) AS last_move
         FROM purchases p
         GROUP BY 1
       )`;

    const orderBy =
      sort === 'az'
        ? `ORDER BY coalesce(nullif(trim(i.itemname), ''), g.cat_code) ASC`
        : sort === 'za'
          ? `ORDER BY coalesce(nullif(trim(i.itemname), ''), g.cat_code) DESC`
          : sort === 'asc'
            ? 'ORDER BY g.value ASC NULLS LAST'
            : 'ORDER BY abs(g.value) DESC NULLS LAST';

    const rows = await this.database.query<{
      id: string;
      itemCode: string;
      itemName: string;
      category: string;
      siteCode: string;
      siteName: string;
      qty: string;
      value: string;
      unit: string;
      lastMove: string | null;
      unitRate: string;
    }>(
      `${purchasesCte}
       SELECT g.cat_code AS id,
              g.cat_code AS "itemCode",
              coalesce(nullif(trim(i.itemname), ''), g.cat_code) AS "itemName",
              'Group' AS category,
              $9::text AS "siteCode",
              coalesce(nullif(trim(a.ahead), ''), $9::text) AS "siteName",
              g.qty::text AS qty,
              g.value::text AS value,
              '—' AS unit,
              to_char(g.last_move, 'YYYY-MM-DD') AS "lastMove",
              CASE
                WHEN g.qty = 0 THEN '0'
                ELSE round(g.value / nullif(g.qty, 0), 2)::text
              END AS "unitRate"
       FROM grouped g
       LEFT JOIN LATERAL (
         SELECT trim(x.itemname) AS itemname
         FROM item x
         WHERE trim(x.itemcode) = g.cat_code
         ORDER BY x.row_id
         LIMIT 1
       ) i ON true
       LEFT JOIN acc a ON trim(a.acode) = $9::text
       WHERE (
         $3::text = ''
         OR g.cat_code ILIKE $4::text
         OR coalesce(trim(i.itemname), '') ILIKE $4::text
       )
       ${orderBy}
       LIMIT $7 OFFSET $8`,
      [...params, pageSize, offset, siteCode],
    );

    const count = await this.database.query<{ total: string; total_qty: string; total_value: string }>(
      `${purchasesCte}
       SELECT count(*)::text AS total,
              coalesce(sum(g.qty), 0)::text AS total_qty,
              coalesce(sum(g.value), 0)::text AS total_value
       FROM grouped g
       LEFT JOIN LATERAL (
         SELECT trim(x.itemname) AS itemname
         FROM item x
         WHERE trim(x.itemcode) = g.cat_code
         ORDER BY x.row_id
         LIMIT 1
       ) i ON true
       WHERE (
         $3::text = ''
         OR g.cat_code ILIKE $4::text
         OR coalesce(trim(i.itemname), '') ILIKE $4::text
       )`,
      params,
    );

    const total = Number(count.rows[0]?.total ?? 0);
    const totalQty = Number(count.rows[0]?.total_qty ?? 0);
    const totalValue = Number(count.rows[0]?.total_value ?? 0);

    return {
      rows: rows.rows.map((row) => ({
        id: row.id,
        itemCode: row.itemCode,
        itemName: row.itemName,
        category: row.category,
        siteCode: row.siteCode,
        siteName: row.siteName,
        qty: Number(row.qty) || 0,
        value: Number(row.value) || 0,
        unit: '—',
        unitRate: Number(row.unitRate) || 0,
        lastMove: row.lastMove || '',
        status: this.stockStatus(Number(row.qty) || 0),
      })),
      total,
      page,
      pageSize,
      summary: {
        totalQty,
        totalValue,
        locationBalance: totalQty,
        itemCount: total,
      },
      mode: 'drillDown' as const,
      title: this.modeTitle('drillDown'),
    };
  }

  private async lastAudit(
    scope: string,
    category: string,
    search: string,
    fromDate: string,
    toDate: string,
    page: number,
    pageSize: number,
    sort = 'desc',
  ) {
    const offset = (page - 1) * pageSize;
    const params = [`${scope}%`, category, search, search ? `%${search}%` : '', fromDate, toDate];

    const stats = await this.database.query<{ total: string; total_qty: string; total_value: string }>(
      `SELECT count(*)::text AS total,
              coalesce(sum(${this.signedQtySql}), 0)::text AS total_qty,
              coalesce(sum(${this.signedValueSql}), 0)::text AS total_value
       FROM purdet d
       JOIN purmast m ON trim(m.invno) = trim(d.invno)
       LEFT JOIN item i ON trim(i.itemcode) = trim(d.itemno)
       WHERE coalesce(trim(d.itemno), '') <> ''
         AND trim(m.ccode) LIKE $1
         AND ($2 = '' OR trim(d.itemno) LIKE $2 || '%')
         AND (
           $3 = ''
           OR trim(d.itemno) ILIKE $4
           OR coalesce(trim(i.itemname), '') ILIKE $4
           OR trim(m.invno) ILIKE $4
         )
         AND (
           ($5 = '' AND $6 = '')
           OR (
             trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
             AND ($5 = '' OR trim(m.invdate)::date >= $5::date)
             AND ($6 = '' OR trim(m.invdate)::date <= $6::date)
           )
         )`,
      params,
    );

    const rows = await this.database.query<{
      id: string;
      itemCode: string;
      itemName: string;
      category: string;
      siteCode: string;
      siteName: string;
      qty: string;
      value: string;
      unit: string;
      lastMove: string | null;
      unitRate: string;
    }>(
      `SELECT d.row_id::text AS id,
              trim(d.itemno) AS "itemCode",
              coalesce(nullif(trim(i.itemname), ''), trim(d.itemno)) AS "itemName",
              coalesce(
                (
                  SELECT trim(g.itemname)
                  FROM item g
                  WHERE coalesce(trim(g.uom), '') = ''
                    AND length(trim(g.itemcode)) BETWEEN 1 AND 4
                    AND trim(d.itemno) LIKE trim(g.itemcode) || '%'
                  ORDER BY length(trim(g.itemcode)) DESC
                  LIMIT 1
                ),
                left(trim(d.itemno), 2)
              ) AS category,
              trim(m.ccode) AS "siteCode",
              coalesce(nullif(trim(a.ahead), ''), trim(m.ccode)) AS "siteName",
              (${this.signedQtySql})::text AS qty,
              (${this.signedValueSql})::text AS value,
              coalesce(nullif(trim(d.unit), ''), nullif(trim(i.uom), ''), '—') AS unit,
              CASE WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
                   THEN to_char(trim(m.invdate)::date, 'YYYY-MM-DD') ELSE null END AS "lastMove",
              coalesce(nullif(trim(d.rate), ''), '0') AS "unitRate"
       FROM purdet d
       JOIN purmast m ON trim(m.invno) = trim(d.invno)
       LEFT JOIN item i ON trim(i.itemcode) = trim(d.itemno)
       LEFT JOIN acc a ON a.acode = m.ccode
       WHERE coalesce(trim(d.itemno), '') <> ''
         AND trim(m.ccode) LIKE $1
         AND ($2 = '' OR trim(d.itemno) LIKE $2 || '%')
         AND (
           $3 = ''
           OR trim(d.itemno) ILIKE $4
           OR coalesce(trim(i.itemname), '') ILIKE $4
           OR trim(m.invno) ILIKE $4
         )
         AND (
           ($5 = '' AND $6 = '')
           OR (
             trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
             AND ($5 = '' OR trim(m.invdate)::date >= $5::date)
             AND ($6 = '' OR trim(m.invdate)::date <= $6::date)
           )
         )
       ${
         sort === 'az'
           ? `ORDER BY coalesce(nullif(trim(i.itemname), ''), trim(d.itemno)) ASC, d.row_id ASC`
           : sort === 'za'
             ? `ORDER BY coalesce(nullif(trim(i.itemname), ''), trim(d.itemno)) DESC, d.row_id DESC`
             : sort === 'asc'
               ? `ORDER BY
                    CASE WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(m.invdate)::timestamp ELSE NULL END ASC NULLS LAST,
                    d.row_id ASC`
               : `ORDER BY
                    CASE WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(m.invdate)::timestamp ELSE NULL END DESC NULLS LAST,
                    d.row_id DESC`
       }
       LIMIT $7 OFFSET $8`,
      [...params, pageSize, offset],
    );

    const total = Number(stats.rows[0]?.total ?? 0);
    const totalQty = Number(stats.rows[0]?.total_qty ?? 0);
    const totalValue = Number(stats.rows[0]?.total_value ?? 0);

    return {
      rows: rows.rows.map((row) => {
        const qty = Number(row.qty) || 0;
        return {
          id: row.id,
          itemCode: row.itemCode,
          itemName: row.itemName,
          category: row.category,
          siteCode: row.siteCode,
          siteName: row.siteName,
          qty,
          value: Number(row.value) || 0,
          unit: row.unit || '—',
          unitRate: Number(row.unitRate) || 0,
          lastMove: row.lastMove || '',
          // Movement lines: In / Out — not stock Low/Short
          status: qty < 0 ? 'Out' : qty > 0 ? 'In' : 'Zero',
        };
      }),
      total,
      page,
      pageSize,
      summary: {
        totalQty,
        totalValue,
        locationBalance: totalQty,
        itemCount: total,
      },
      mode: 'lastAudit' as const,
      title: this.modeTitle('lastAudit'),
    };
  }

  private async purchaseComparison(
    scope: string,
    category: string,
    search: string,
    fromDate: string,
    toDate: string,
    page: number,
    pageSize: number,
    sort = 'desc',
  ) {
    const offset = (page - 1) * pageSize;
    const params = [`${scope}%`, category, search, search ? `%${search}%` : '', fromDate, toDate];

    const stats = await this.database.query<{ total: string; total_qty: string; total_value: string }>(
      `SELECT count(*)::text AS total,
              coalesce(sum(qty), 0)::text AS total_qty,
              coalesce(sum(value), 0)::text AS total_value
       FROM (
         SELECT trim(d.itemno) AS item_code,
                sum(${this.signedQtySql}) AS qty,
                sum(${this.signedValueSql}) AS value
         FROM purdet d
         JOIN purmast m ON trim(m.invno) = trim(d.invno)
         LEFT JOIN item i ON trim(i.itemcode) = trim(d.itemno)
         WHERE coalesce(trim(d.itemno), '') <> ''
           AND trim(m.ccode) LIKE $1
           AND ($2 = '' OR trim(d.itemno) LIKE $2 || '%')
           AND (
             $3 = ''
             OR trim(d.itemno) ILIKE $4
             OR coalesce(trim(i.itemname), '') ILIKE $4
           )
           AND (
             ($5 = '' AND $6 = '')
             OR (
               trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
               AND ($5 = '' OR trim(m.invdate)::date >= $5::date)
               AND ($6 = '' OR trim(m.invdate)::date <= $6::date)
             )
           )
         GROUP BY 1
       ) x`,
      params,
    );

    const rows = await this.database.query<{
      id: string;
      itemCode: string;
      itemName: string;
      category: string;
      siteCode: string;
      siteName: string;
      qty: string;
      value: string;
      unit: string;
      lastMove: string | null;
      unitRate: string;
    }>(
      `SELECT trim(d.itemno) AS id,
              trim(d.itemno) AS "itemCode",
              coalesce(nullif(trim(i.itemname), ''), trim(d.itemno)) AS "itemName",
              coalesce(
                (
                  SELECT trim(g.itemname)
                  FROM item g
                  WHERE coalesce(trim(g.uom), '') = ''
                    AND length(trim(g.itemcode)) BETWEEN 1 AND 4
                    AND trim(d.itemno) LIKE trim(g.itemcode) || '%'
                  ORDER BY length(trim(g.itemcode)) DESC
                  LIMIT 1
                ),
                left(trim(d.itemno), 2)
              ) AS category,
              'multi' AS "siteCode",
              'Purchase period' AS "siteName",
              sum(${this.signedQtySql})::text AS qty,
              sum(${this.signedValueSql})::text AS value,
              coalesce(nullif(trim(i.uom), ''), '—') AS unit,
              to_char(
                max(CASE WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(m.invdate)::timestamp END),
                'YYYY-MM-DD'
              ) AS "lastMove",
              CASE
                WHEN sum(${this.signedQtySql}) = 0 THEN '0'
                ELSE round(
                  sum(${this.signedValueSql})
                  / nullif(sum(${this.signedQtySql}), 0),
                  2
                )::text
              END AS "unitRate"
       FROM purdet d
       JOIN purmast m ON trim(m.invno) = trim(d.invno)
       LEFT JOIN item i ON trim(i.itemcode) = trim(d.itemno)
       WHERE coalesce(trim(d.itemno), '') <> ''
         AND trim(m.ccode) LIKE $1
         AND ($2 = '' OR trim(d.itemno) LIKE $2 || '%')
         AND (
           $3 = ''
           OR trim(d.itemno) ILIKE $4
           OR coalesce(trim(i.itemname), '') ILIKE $4
         )
         AND (
           ($5 = '' AND $6 = '')
           OR (
             trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
             AND ($5 = '' OR trim(m.invdate)::date >= $5::date)
             AND ($6 = '' OR trim(m.invdate)::date <= $6::date)
           )
         )
       GROUP BY trim(d.itemno), trim(i.itemname), trim(i.uom)
       ${
         sort === 'az'
           ? `ORDER BY coalesce(nullif(trim(i.itemname), ''), trim(d.itemno)) ASC`
           : sort === 'za'
             ? `ORDER BY coalesce(nullif(trim(i.itemname), ''), trim(d.itemno)) DESC`
             : sort === 'asc'
               ? `ORDER BY sum(${this.signedValueSql}) ASC NULLS LAST`
               : `ORDER BY abs(sum(${this.signedValueSql})) DESC NULLS LAST`
       }
       LIMIT $7 OFFSET $8`,
      [...params, pageSize, offset],
    );

    const total = Number(stats.rows[0]?.total ?? 0);
    const totalQty = Number(stats.rows[0]?.total_qty ?? 0);
    const totalValue = Number(stats.rows[0]?.total_value ?? 0);

    return {
      rows: rows.rows.map((row) => ({
        id: row.id,
        itemCode: row.itemCode,
        itemName: row.itemName,
        category: row.category,
        siteCode: row.siteCode,
        siteName: row.siteName,
        qty: Number(row.qty) || 0,
        value: Number(row.value) || 0,
        unit: row.unit || '—',
        unitRate: Number(row.unitRate) || 0,
        lastMove: row.lastMove || '',
        status: this.stockStatus(Number(row.qty) || 0),
      })),
      total,
      page,
      pageSize,
      summary: {
        totalQty,
        totalValue,
        locationBalance: totalQty,
        itemCount: total,
      },
      mode: 'purchaseCompare' as const,
      title: this.modeTitle('purchaseCompare'),
    };
  }

  private stockStatus(qty: number) {
    if (qty === 0) return 'Zero';
    if (qty < 0) return 'Short';
    if (qty < 10) return 'Low';
    return 'In Stock';
  }

  private normalizeSort(sort: string) {
    const key = String(sort || 'desc').trim().toLowerCase();
    if (key === 'az' || key === 'za' || key === 'asc' || key === 'desc') return key;
    return 'desc';
  }

  private stockOrderBy(sort: string) {
    if (sort === 'az') {
      return `ORDER BY coalesce(nullif(i.item_name, ''), st.item_code) ASC, st.item_code ASC`;
    }
    if (sort === 'za') {
      return `ORDER BY coalesce(nullif(i.item_name, ''), st.item_code) DESC, st.item_code DESC`;
    }
    if (sort === 'asc') {
      return `ORDER BY st.last_move ASC NULLS LAST, st.last_touch ASC NULLS LAST, st.item_code ASC`;
    }
    // Newest first: same-day rows by latest insert (row_id), not by value
    return `ORDER BY st.last_move DESC NULLS LAST, st.last_touch DESC NULLS LAST, st.item_code ASC`;
  }

  private normalizeMode(mode: string): StockReportMode {
    const key = String(mode || 'full').trim();
    const allowed: StockReportMode[] = [
      'full',
      'nonZero',
      'zero',
      'valueLedger',
      'qtyLedger',
      'drillDown',
      'assets',
      'purchaseCompare',
      'lastAudit',
    ];
    return (allowed.includes(key as StockReportMode) ? key : 'full') as StockReportMode;
  }

  /**
   * Line-level item ledger (legacy tree → item inner details).
   * P/N = In, S/R = Out; running Site Bal after each line.
   */
  async itemLedger(
    username: string,
    site: string,
    itemCode: string,
    fromDate = '',
    toDate = '',
  ) {
    const scope = await this.siteScope(username, site);
    const code = itemCode.trim();
    if (!scope || !code) {
      return {
        item: null,
        lines: [],
        summary: { totalQty: 0, totalValue: 0, locationBalance: 0, lineCount: 0 },
      };
    }

    const fromScope = fromDate.trim();
    const toScope = toDate.trim();

    const meta = await this.database.query<{
      itemCode: string;
      itemName: string;
      unit: string;
      category: string;
    }>(
      `SELECT trim(i.itemcode) AS "itemCode",
              coalesce(nullif(trim(i.itemname), ''), trim(i.itemcode)) AS "itemName",
              coalesce(nullif(trim(i.uom), ''), '—') AS unit,
              coalesce(
                (
                  SELECT trim(g.itemname)
                  FROM item g
                  WHERE coalesce(trim(g.uom), '') = ''
                    AND length(trim(g.itemcode)) BETWEEN 1 AND 4
                    AND trim(i.itemcode) LIKE trim(g.itemcode) || '%'
                  ORDER BY length(trim(g.itemcode)) DESC
                  LIMIT 1
                ),
                left(trim(i.itemcode), 2)
              ) AS category
       FROM item i
       WHERE trim(i.itemcode) = $1
       ORDER BY i.row_id
       LIMIT 1`,
      [code],
    );

    const rows = await this.database.query<{
      id: string;
      invno: string;
      moveType: string;
      qty: string;
      rate: string;
      value: string;
      siteCode: string;
      siteName: string;
      moveDate: string | null;
    }>(
      `SELECT d.row_id::text AS id,
              trim(d.invno) AS invno,
              CASE right(upper(trim(d.invno)), 1)
                WHEN 'S' THEN 'Out'
                WHEN 'R' THEN 'Out'
                WHEN 'P' THEN 'In'
                WHEN 'N' THEN 'In'
                ELSE 'In'
              END AS "moveType",
              (${this.signedQtySql})::text AS qty,
              coalesce(nullif(trim(d.rate), ''), '0') AS rate,
              (${this.signedValueSql})::text AS value,
              trim(m.ccode) AS "siteCode",
              coalesce(nullif(trim(a.ahead), ''), trim(m.ccode)) AS "siteName",
              CASE
                WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
                THEN to_char(trim(m.invdate)::date, 'YYYY-MM-DD')
                ELSE null
              END AS "moveDate"
       FROM purdet d
       JOIN purmast m ON trim(m.invno) = trim(d.invno)
       LEFT JOIN acc a ON a.acode = m.ccode
       WHERE trim(d.itemno) = $2
         AND trim(m.ccode) LIKE $1
         AND (
           ($3 = '' AND $4 = '')
           OR (
             trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
             AND ($3 = '' OR trim(m.invdate)::date >= $3::date)
             AND ($4 = '' OR trim(m.invdate)::date <= $4::date)
           )
         )
       ORDER BY
         CASE WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(m.invdate)::timestamp ELSE NULL END ASC NULLS LAST,
         trim(d.invno) ASC,
         d.row_id ASC`,
      [`${scope}%`, code, fromScope, toScope],
    );

    let runningQty = 0;
    let runningValue = 0;
    const lines = rows.rows.map((row) => {
      const qty = Number(row.qty) || 0;
      const value = Number(row.value) || 0;
      runningQty += qty;
      runningValue += value;
      return {
        id: row.id,
        invno: row.invno,
        moveType: row.moveType,
        qty,
        rate: Number(row.rate) || 0,
        value,
        balanceQty: runningQty,
        balanceValue: runningValue,
        siteCode: row.siteCode,
        siteName: row.siteName,
        moveDate: row.moveDate || '',
      };
    });

    const item = meta.rows[0] ?? {
      itemCode: code,
      itemName: code,
      unit: '—',
      category: '',
    };

    return {
      item,
      lines,
      summary: {
        totalQty: runningQty,
        totalValue: runningValue,
        locationBalance: runningQty,
        lineCount: lines.length,
      },
    };
  }

  private modeTitle(mode: StockReportMode) {
    const titles: Record<StockReportMode, string> = {
      full: 'Full Stock Position',
      nonZero: 'Stock With Quantity',
      zero: 'Zero Stock Items',
      valueLedger: 'Item Value Ledger',
      qtyLedger: 'Item Quantity Ledger',
      drillDown: 'Category Drill-Down',
      assets: 'Asset Position (Valued)',
      purchaseCompare: 'Purchase Comparison',
      lastAudit: 'Latest Stock Movements',
    };
    return titles[mode] || titles.full;
  }

  private async siteScope(username: string, site: string) {
    const zone = await this.zonePrefix(username);
    let code = site.trim();
    if (!code) code = zone || '14';
    if (zone && !(code === zone || code.startsWith(zone))) return '';
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

  /** Full voucher (master + all detail lines) for invoice PDF. */
  async invoiceVoucher(username: string, invnoRaw: string) {
    const invno = invnoRaw.trim();
    if (!invno) {
      return { ok: false, message: 'Invoice number is required.', master: null, lines: [], accountLines: [] };
    }

    const scope = await this.siteScope(username, '');
    const master = await this.database.query<{
      invno: string;
      siteCode: string;
      siteName: string;
      invDate: string | null;
      narration: string;
      kind: string;
      kindTitle: string;
    }>(
      `SELECT trim(m.invno) AS invno,
              trim(m.ccode) AS "siteCode",
              coalesce(nullif(trim(a.ahead), ''), trim(m.ccode)) AS "siteName",
              CASE
                WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
                THEN to_char(trim(m.invdate)::date, 'YYYY-MM-DD')
                ELSE null
              END AS "invDate",
              coalesce(nullif(trim(m.narp), ''), '') AS narration,
              right(upper(trim(m.invno)), 1) AS kind,
              CASE right(upper(trim(m.invno)), 1)
                WHEN 'P' THEN 'Purchase / Stock In'
                WHEN 'N' THEN 'Stock In (N)'
                WHEN 'S' THEN 'Stock Out / Issue'
                WHEN 'R' THEN 'Purchase Return'
                ELSE 'Stock Voucher'
              END AS "kindTitle"
       FROM purmast m
       LEFT JOIN acc a ON a.acode = m.ccode
       WHERE trim(m.invno) = $1
         AND ($2 = '' OR trim(m.ccode) LIKE $2 || '%')
       ORDER BY m.row_id
       LIMIT 1`,
      [invno, scope.replace(/%/g, '')],
    );

    if (!master.rows[0]) {
      const fee = await this.database.query<{
        invno: string;
        siteCode: string;
        siteName: string;
        invDate: string | null;
        narration: string;
        kind: string;
        kindTitle: string;
      }>(
        `SELECT trim(m.invno) AS invno,
                trim(m.ccode) AS "siteCode",
                coalesce(nullif(trim(a.ahead), ''), trim(m.ccode)) AS "siteName",
                CASE
                  WHEN trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
                  THEN to_char(trim(m.invdate)::date, 'YYYY-MM-DD')
                  ELSE null
                END AS "invDate",
                coalesce(nullif(trim(m.nar), ''), '') AS narration,
                right(upper(trim(m.invno)), 1) AS kind,
                CASE right(upper(trim(m.invno)), 1)
                  WHEN 'G' THEN 'Student Voucher'
                  WHEN 'F' THEN 'Collection Voucher'
                  ELSE 'Fee Voucher'
                END AS "kindTitle"
         FROM accmast m
         LEFT JOIN acc a ON trim(a.acode) = trim(m.ccode)
         WHERE trim(m.invno) = $1
           AND ($2 = '' OR trim(m.ccode) LIKE $2 || '%')
         ORDER BY m.row_id
         LIMIT 1`,
        [invno, scope.replace(/%/g, '')],
      );
      if (!fee.rows[0]) {
        return { ok: false, message: `Invoice ${invno} not found.`, master: null, lines: [], accountLines: [] };
      }
      const accountLines = await this.voucherAccountLines(invno);
      return {
        ok: true,
        message: 'OK',
        master: fee.rows[0],
        lines: [],
        accountLines,
        summary: {
          totalQty: 0,
          totalValue: accountLines.reduce((s, r) => s + r.debit + r.credit, 0),
          lineCount: accountLines.length,
        },
      };
    }

    const lines = await this.database.query<{
      id: string;
      itemCode: string;
      itemName: string;
      qty: string;
      rate: string;
      value: string;
      unit: string;
    }>(
      `SELECT d.row_id::text AS id,
              trim(d.itemno) AS "itemCode",
              coalesce(nullif(trim(i.itemname), ''), trim(d.itemno)) AS "itemName",
              coalesce(nullif(trim(d.qty), ''), '0') AS qty,
              coalesce(nullif(trim(d.rate), ''), '0') AS rate,
              CASE
                WHEN coalesce(trim(d.qty), '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                 AND coalesce(trim(d.rate), '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                THEN (trim(d.qty)::numeric * trim(d.rate)::numeric)::text
                ELSE coalesce(nullif(trim(d.tamt), ''), '0')
              END AS value,
              coalesce(nullif(trim(d.unit), ''), nullif(trim(i.uom), ''), 'PCS') AS unit
       FROM purdet d
       LEFT JOIN item i ON trim(i.itemcode) = trim(d.itemno)
       WHERE trim(d.invno) = $1
       ORDER BY d.row_id`,
      [invno],
    );

    const mapped = lines.rows.map((row) => ({
      id: row.id,
      itemCode: row.itemCode,
      itemName: row.itemName,
      qty: Number(row.qty) || 0,
      rate: Number(row.rate) || 0,
      value: Number(row.value) || 0,
      unit: row.unit || 'PCS',
    }));

    const totalQty = mapped.reduce((s, r) => s + r.qty, 0);
    const totalValue = mapped.reduce((s, r) => s + r.value, 0);
    const accountLines = await this.voucherAccountLines(invno);

    return {
      ok: true,
      message: 'OK',
      master: master.rows[0],
      lines: mapped,
      accountLines,
      summary: { totalQty, totalValue, lineCount: mapped.length },
    };
  }

  private async voucherAccountLines(invno: string) {
    const lines = await this.database.query<{
      id: string;
      accountCode: string;
      accountName: string;
      debit: string;
      credit: string;
      narration: string;
    }>(
      `SELECT d.row_id::text AS id,
              trim(d.acode) AS "accountCode",
              coalesce(nullif(trim(a.ahead), ''), trim(d.acode), '') AS "accountName",
              CASE
                WHEN coalesce(trim(d.dr), '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN trim(d.dr)
                ELSE '0'
              END AS debit,
              CASE
                WHEN coalesce(trim(d.cr), '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN trim(d.cr)
                ELSE '0'
              END AS credit,
              coalesce(trim(d.snar), '') AS narration
       FROM accdet d
       LEFT JOIN acc a ON trim(a.acode) = trim(d.acode)
       WHERE trim(d.invno) = $1
       ORDER BY d.row_id`,
      [invno],
    );
    return lines.rows.map((row) => ({
      id: row.id,
      accountCode: row.accountCode,
      accountName: row.accountName,
      debit: Number(row.debit) || 0,
      credit: Number(row.credit) || 0,
      narration: row.narration || '',
    }));
  }

  /** Voucher list header filters → `AND …` SQL; pushes values onto params. */
  private voucherColFilterSql(
    params: unknown[],
    colFilters: Record<string, string>,
    columns: Record<string, { expr: string; type: 'like' | 'exact' | 'date' | 'money' }>,
  ) {
    const where: string[] = [];
    for (const [key, raw] of Object.entries(colFilters)) {
      const v = String(raw || '').trim();
      const col = columns[key];
      if (!v || !col) continue;
      const e = `coalesce(${col.expr}, '')`;
      if (col.type === 'exact') {
        params.push(v);
        where.push(`upper(${e}) = upper($${params.length})`);
      } else if (col.type === 'date') {
        params.push(`%${v}%`);
        const n = params.length;
        where.push(
          `(left(${e}, 10) ILIKE $${n}
            OR (substr(${e}, 9, 2) || '/' || substr(${e}, 6, 2) || '/' || substr(${e}, 1, 4)) ILIKE $${n})`,
        );
      } else if (col.type === 'money') {
        params.push(`%${v.replace(/,/g, '')}%`);
        const n = params.length;
        where.push(
          `(${e} ILIKE $${n}
            OR (CASE WHEN ${e} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN round(${e}::numeric, 2)::text ELSE '' END) ILIKE $${n})`,
        );
      } else {
        params.push(`%${v}%`);
        where.push(`${e} ILIKE $${params.length}`);
      }
    }
    return where.length ? `AND ${where.join(' AND ')}` : '';
  }

  private dedupeOptions(rows: { kind: string; value: string }[], keys: string[]) {
    const out: Record<string, string[]> = Object.fromEntries(keys.map((k) => [k, []]));
    const seen: Record<string, Set<string>> = {};
    for (const r of rows) {
      const list = out[r.kind];
      if (!list || !r.value) continue;
      const k = r.value.toUpperCase();
      seen[r.kind] ??= new Set();
      if (seen[r.kind].has(k)) continue;
      seen[r.kind].add(k);
      list.push(r.value);
    }
    return out;
  }

  /** H.F Student Voucher (…G) / H.C Collection (…F) from accmast. */
  private async listFeeVouchers(
    username: string,
    kind: 'studentVoucher' | 'collectionVoucher',
    page = 1,
    pageSize = 50,
    site = '',
    colFilters: Record<string, string> = {},
    optionsOnly = false,
  ) {
    const scope = await this.siteScope(username, site);
    if (String(site || '').trim() && !scope) {
      if (optionsOnly) return { siteName: [], mont: [] };
      return { rows: [], total: 0, page, pageSize };
    }
    const scopeCode = (scope || '').replace(/%/g, '');
    const letter = kind === 'collectionVoucher' ? 'F' : 'G';
    const offset = (page - 1) * pageSize;
    const siteExpr = `coalesce(nullif(trim(a.ahead), ''), trim(m.ccode), '')`;

    if (optionsOnly) {
      const opts = await this.database.query<{ kind: string; value: string }>(
        `WITH base AS (
           SELECT ${siteExpr} AS site_name, coalesce(trim(m.mont), '') AS mont
           FROM accmast m
           LEFT JOIN acc a ON trim(a.acode) = trim(m.ccode)
           WHERE right(upper(trim(m.invno)), 1) = $2
             AND ($1 = '' OR trim(m.ccode) LIKE $1 || '%')
         )
         SELECT kind, value FROM (
           SELECT DISTINCT 'siteName' AS kind, site_name AS value, site_name AS ord FROM base WHERE site_name <> ''
           UNION
           SELECT DISTINCT 'mont', mont,
             CASE WHEN mont ~ '^[0-9]{6}$' THEN right(mont, 4) || left(mont, 2) ELSE '' END
           FROM base WHERE mont <> ''
         ) o
         ORDER BY kind, CASE WHEN kind = 'mont' THEN ord END DESC, ord`,
        [scopeCode, letter],
      );
      return this.dedupeOptions(opts.rows, ['siteName', 'mont']);
    }

    const params: unknown[] = [scopeCode, letter];
    const colFilterSql = this.voucherColFilterSql(params, colFilters, {
      invno: { expr: 'trim(m.invno)', type: 'like' },
      invdate: { expr: 'trim(m.invdate)', type: 'date' },
      siteName: { expr: siteExpr, type: 'exact' },
      sdno: { expr: `concat_ws(' ', trim(m.sdno), trim(st.name))`, type: 'like' },
      mont: { expr: 'trim(m.mont)', type: 'exact' },
      narp: { expr: 'trim(m.nar)', type: 'like' },
    });
    const fromSql = `FROM accmast m
       LEFT JOIN acc a ON trim(a.acode) = trim(m.ccode)
       LEFT JOIN student st ON trim(st.sdno) = trim(m.sdno)
       WHERE right(upper(trim(m.invno)), 1) = $2
         AND ($1 = '' OR trim(m.ccode) LIKE $1 || '%')
         ${colFilterSql}`;

    const total = await this.database.query<{ n: string }>(
      colFilterSql
        ? `SELECT count(*)::text AS n ${fromSql}`
        : `SELECT count(*)::text AS n
           FROM accmast m
           WHERE right(upper(trim(m.invno)), 1) = $2
             AND ($1 = '' OR trim(m.ccode) LIKE $1 || '%')`,
      params,
    );

    const rows = await this.database.query<{
      id: string;
      invno: string;
      invdate: string | null;
      ccode: string;
      siteName: string;
      narp: string;
      sdno: string;
      studentName: string;
      mont: string;
      bcode: string;
      aclas: string;
      edate: string | null;
      pcode: string;
      dparty: string;
      pinv: string;
      gno: string;
      pday: string;
      frt: string;
      discount: string;
      pflag: string;
      suffix: string;
      atag: string;
    }>(
      `SELECT m.row_id::text AS id,
              trim(m.invno) AS invno,
              nullif(trim(m.invdate), '') AS invdate,
              coalesce(trim(m.ccode), '') AS ccode,
              coalesce(nullif(trim(a.ahead), ''), trim(m.ccode), '') AS "siteName",
              coalesce(trim(m.nar), '') AS narp,
              coalesce(trim(m.sdno), '') AS sdno,
              coalesce(nullif(trim(st.name), ''), trim(m.sdno), '') AS "studentName",
              coalesce(trim(m.mont), '') AS mont,
              coalesce(trim(m.bcode), '') AS bcode,
              coalesce(trim(m.aclas), '') AS aclas,
              nullif(trim(m.edate), '') AS edate,
              coalesce(trim(m.bcode), '') AS pcode,
              coalesce(trim(m.sdno), '') AS dparty,
              coalesce(trim(m.mont), '') AS pinv,
              coalesce(trim(m.aclas), '') AS gno,
              coalesce(trim(m.pday), '') AS pday,
              '' AS frt,
              '' AS discount,
              coalesce(trim(m.pflag), '') AS pflag,
              right(upper(trim(m.invno)), 1) AS suffix,
              $${params.length + 1}::text AS atag
       ${fromSql}
       ORDER BY m.row_id DESC
       LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
      [...params, kind, pageSize, offset],
    );

    return {
      rows: rows.rows,
      total: Number(total.rows[0]?.n || 0),
      page,
      pageSize,
    };
  }

  /**
   * Inventory Voucher list from purmast (header only).
   * kind splits mixed types: P purchase / student / collection via atag.
   */
  async listVouchers(
    username: string,
    suffixRaw = '',
    page = 1,
    pageSize = 50,
    kindRaw = '',
    siteRaw = '',
    colFilters: Record<string, string> = {},
    optionsOnly = false,
    q = '',
  ) {
    const current = Math.max(1, Number(page) || 1);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const offset = (current - 1) * size;
    const kind = String(kindRaw || '').trim();
    if (kind === 'studentVoucher' || kind === 'collectionVoucher') {
      return this.listFeeVouchers(username, kind, current, size, siteRaw, colFilters, optionsOnly);
    }
    const scope = await this.siteScope(username, siteRaw);
    if (String(siteRaw || '').trim() && !scope) {
      if (optionsOnly) return { siteName: [], mont: [] };
      return { rows: [], total: 0, page: current, pageSize: size };
    }
    const suffix = String(suffixRaw || '')
      .trim()
      .toUpperCase()
      .slice(-1);
    const letter = /[PRSN]/.test(suffix) ? suffix : '';

    const scopeCode = (scope || '').replace(/%/g, '');
    const typeWhere = `
      AND (
        ($3 = '' AND ($2 = '' OR right(upper(trim(m.invno)), 1) = $2))
        OR ($3 = 'purchaseAssets'
            AND right(upper(trim(m.invno)), 1) = 'P'
            AND coalesce(trim(m.atag), '') IN ('', 'purchaseAssets'))
        OR ($3 = 'purchaseReturn' AND right(upper(trim(m.invno)), 1) = 'R')
        OR ($3 = 'saleGoods' AND right(upper(trim(m.invno)), 1) = 'S')
        OR ($3 = 'saleReturn' AND right(upper(trim(m.invno)), 1) = 'N')
        OR ($3 = 'studentVoucher' AND coalesce(trim(m.atag), '') = 'studentVoucher')
        OR ($3 = 'collectionVoucher' AND coalesce(trim(m.atag), '') = 'collectionVoucher')
      )`;
    const siteExpr = `coalesce(nullif(trim(a.ahead), ''), trim(m.ccode), '')`;

    if (optionsOnly) {
      const opts = await this.database.query<{ kind: string; value: string }>(
        `SELECT DISTINCT 'siteName' AS kind, ${siteExpr} AS value
         FROM purmast m
         LEFT JOIN acc a ON trim(a.acode) = trim(m.ccode)
         WHERE ($1 = '' OR trim(m.ccode) LIKE $1 || '%')
           ${typeWhere}
         ORDER BY value`,
        [scopeCode, letter, kind],
      );
      return this.dedupeOptions(opts.rows, ['siteName', 'mont']);
    }

    const params: unknown[] = [scopeCode, letter, kind];
    const colFilterSql = this.voucherColFilterSql(params, colFilters, {
      invno: { expr: 'trim(m.invno)', type: 'like' },
      invdate: { expr: 'trim(m.invdate)', type: 'date' },
      siteName: { expr: siteExpr, type: 'exact' },
      pcode: { expr: 'trim(m.pcode)', type: 'like' },
      dparty: { expr: 'trim(m.dparty)', type: 'like' },
      narp: { expr: 'trim(m.narp)', type: 'like' },
      discount: { expr: 'trim(m.discount)', type: 'money' },
    });
    let searchSql = '';
    const search = String(q || '').trim();
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      searchSql = `AND (m.invno ILIKE $${i}
        OR m.invdate ILIKE $${i}
        OR (trim(m.invdate) ~ '^\\d{4}-\\d{2}-\\d{2}'
            AND to_char(left(trim(m.invdate), 10)::date, 'DD/MM/YYYY') ILIKE $${i})
        OR ${siteExpr} ILIKE $${i}
        OR m.pcode ILIKE $${i}
        OR m.dparty ILIKE $${i}
        OR m.pinv ILIKE $${i}
        OR m.gno ILIKE $${i}
        OR m.narp ILIKE $${i}
        OR m.discount ILIKE $${i})`;
    }

    const total = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM purmast m
       LEFT JOIN acc a ON trim(a.acode) = trim(m.ccode)
       WHERE ($1 = '' OR trim(m.ccode) LIKE $1 || '%')
         ${typeWhere}
         ${colFilterSql}
         ${searchSql}`,
      params,
    );

    const rows = await this.database.query<{
      id: string;
      invno: string;
      invdate: string | null;
      ccode: string;
      siteName: string;
      pcode: string;
      dparty: string;
      pinv: string;
      gno: string;
      pday: string;
      narp: string;
      frt: string;
      discount: string;
      pflag: string;
      suffix: string;
      atag: string;
    }>(
      `SELECT m.row_id::text AS id,
              trim(m.invno) AS invno,
              nullif(trim(m.invdate), '') AS invdate,
              coalesce(trim(m.ccode), '') AS ccode,
              coalesce(nullif(trim(a.ahead), ''), trim(m.ccode), '') AS "siteName",
              coalesce(trim(m.pcode), '') AS pcode,
              coalesce(trim(m.dparty), '') AS dparty,
              coalesce(trim(m.pinv), '') AS pinv,
              coalesce(trim(m.gno), '') AS gno,
              coalesce(trim(m.pday), '') AS pday,
              coalesce(trim(m.narp), '') AS narp,
              coalesce(trim(m.frt), '') AS frt,
              coalesce(trim(m.discount), '') AS discount,
              coalesce(trim(m.pflag), '') AS pflag,
              right(upper(trim(m.invno)), 1) AS suffix,
              coalesce(trim(m.atag), '') AS atag
       FROM purmast m
       LEFT JOIN acc a ON trim(a.acode) = trim(m.ccode)
       WHERE ($1 = '' OR trim(m.ccode) LIKE $1 || '%')
         ${typeWhere}
         ${colFilterSql}
         ${searchSql}
       ORDER BY m.row_id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, offset],
    );

    return {
      rows: rows.rows,
      total: Number(total.rows[0]?.n || 0),
      page: current,
      pageSize: size,
    };
  }

  /** Save Inventory Voucher header into purmast. */
  async saveVoucher(
    username: string,
    body: {
      invno?: string;
      invdate?: string;
      ccode?: string;
      pcode?: string;
      dparty?: string;
      pinv?: string;
      gno?: string;
      pday?: string;
      narp?: string;
      frt?: string;
      discount?: string;
      pflag?: string;
      suffix?: string;
      kind?: string;
      sdno?: string;
      mont?: string;
      bcode?: string;
      aclas?: string;
      edate?: string;
      lines?: Array<{
        itemCode?: string;
        qty?: string | number;
        rate?: string | number;
        unit?: string;
      }>;
    },
  ) {
    await assertRoleAccess(this.database, username, 'inventoryVoucher', 'add');
    const kind = String(body.kind ?? '').trim();
    if (kind === 'studentVoucher' || kind === 'collectionVoucher') {
      return this.saveFeeVoucher(username, kind, body);
    }

    await this.ensureWideNarration();
    const ccode = String(body.ccode ?? '').trim();
    if (!ccode) {
      return { ok: false, message: 'Department is required.' };
    }

    const scope = await this.siteScope(username, ccode);
    if (!scope) {
      return { ok: false, message: 'Campus / department not allowed for this user.' };
    }

    let invno = String(body.invno ?? '').trim();
    if (!invno) {
      const suffix = String(body.suffix ?? 'P').trim().toUpperCase().slice(-1) || 'P';
      const next = await this.nextInvoice(suffix);
      invno = next.invno;
    }

    const exists = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM purmast WHERE trim(invno) = $1`,
      [invno],
    );
    if (Number(exists.rows[0]?.n || 0) > 0) {
      return { ok: false, message: `Invoice ${invno} already exists.`, invno };
    }

    const rawDate = String(body.invdate ?? '').trim();
    const invdate = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
      ? `${rawDate.slice(0, 10)} 00:00:00`
      : `${new Date().toISOString().slice(0, 10)} 00:00:00`;

    const atag = [
      'purchaseAssets',
      'purchaseReturn',
      'saleGoods',
      'saleReturn',
      'studentVoucher',
      'collectionVoucher',
    ].includes(kind)
      ? kind
      : '';

    const detailLines = (Array.isArray(body.lines) ? body.lines : [])
      .map((line) => {
        const itemCode = String(line?.itemCode ?? '').trim();
        const qty = Number(line?.qty);
        const rate = Number(line?.rate);
        const unit = String(line?.unit ?? '').trim() || 'PCS';
        return {
          itemCode,
          qty: Number.isFinite(qty) ? qty : 0,
          rate: Number.isFinite(rate) ? rate : 0,
          unit,
        };
      })
      .filter((line) => line.itemCode && line.qty !== 0);
    if (!detailLines.length) {
      return { ok: false, message: 'Add at least one item in Details.' };
    }

    await this.database.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO purmast
           (invno, pcode, invdate, frt, discount, dparty, narp, pinv, gno, ccode, pflag, pday, atag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          invno,
          String(body.pcode ?? '').trim() || null,
          invdate,
          String(body.frt ?? '').trim() || null,
          String(body.discount ?? '').trim() || null,
          String(body.dparty ?? '').trim() || null,
          String(body.narp ?? '').trim() || null,
          String(body.pinv ?? '').trim() || null,
          String(body.gno ?? '').trim() || null,
          ccode,
          String(body.pflag ?? '1').trim() || '1',
          String(body.pday ?? '0').trim() || '0',
          atag || null,
        ],
      );
      for (const line of detailLines) {
        await client.query(
          `INSERT INTO purdet (invno, itemno, qty, rate, unit, tamt)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            invno,
            line.itemCode,
            String(line.qty),
            String(line.rate),
            line.unit,
            String(line.qty * line.rate),
          ],
        );
      }
    });

    const siteName = await this.siteName(ccode);
    await this.activityLog.write({
      category: 'activity',
      username,
      activity: 'Inventory Voucher Saved',
      description: `Saved inventory voucher ${invno} (${detailLines.length} items)`,
      module: 'Inventory Voucher',
      campus: siteName,
      campusCode: ccode,
      status: 'Success',
      meta: { invno, lines: detailLines.length },
    });

    return {
      ok: true,
      message: `Voucher ${invno} saved.`,
      invno,
      siteName,
    };
  }

  private async saveFeeVoucher(
    username: string,
    kind: 'studentVoucher' | 'collectionVoucher',
    body: {
      invno?: string;
      invdate?: string;
      ccode?: string;
      narp?: string;
      sdno?: string;
      mont?: string;
      bcode?: string;
      aclas?: string;
      edate?: string;
      suffix?: string;
    },
  ) {
    await this.ensureWideNarration();
    const ccode = String(body.ccode ?? '').trim();
    if (!ccode) {
      return { ok: false, message: 'Department is required.' };
    }
    const scope = await this.siteScope(username, ccode);
    if (!scope) {
      return { ok: false, message: 'Campus / department not allowed for this user.' };
    }

    const letter = kind === 'collectionVoucher' ? 'F' : 'G';
    let invno = String(body.invno ?? '').trim();
    if (!invno) {
      const next = await this.nextInvoice(letter);
      invno = next.invno;
    }

    const exists = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accmast WHERE trim(invno) = $1`,
      [invno],
    );
    if (Number(exists.rows[0]?.n || 0) > 0) {
      return { ok: false, message: `Invoice ${invno} already exists.`, invno };
    }

    const rawDate = String(body.invdate ?? '').trim();
    const invdate = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
      ? `${rawDate.slice(0, 10)} 00:00:00`
      : `${new Date().toISOString().slice(0, 10)} 00:00:00`;
    const edateRaw = String(body.edate ?? '').trim();
    const edate = /^\d{4}-\d{2}-\d{2}/.test(edateRaw)
      ? `${edateRaw.slice(0, 10)} 00:00:00`
      : null;

    await this.database.query(
      `INSERT INTO accmast
         (invno, invdate, nar, ccode, pflag, edate, tflag, sdno, mont, bcode, aclas)
       VALUES ($1,$2,$3,$4,'P',$5,'1',$6,$7,$8,$9)`,
      [
        invno,
        invdate,
        String(body.narp ?? '').trim() || null,
        ccode,
        edate,
        String(body.sdno ?? '').trim() || null,
        String(body.mont ?? '').trim() || null,
        String(body.bcode ?? '').trim() || null,
        String(body.aclas ?? '').trim() || null,
      ],
    );

    const siteName = await this.siteName(ccode);
    await this.activityLog.write({
      category: 'activity',
      username,
      activity: 'Inventory Voucher Saved',
      description: `Saved ${kind} ${invno}`,
      module: 'Inventory Voucher',
      campus: siteName,
      campusCode: ccode,
      status: 'Success',
      meta: { invno, kind },
    });
    return { ok: true, message: `Voucher ${invno} saved.`, invno, siteName };
  }

  /** Delete inventory voucher header (+ any detail lines). */
  async deleteVoucher(username: string, invnoRaw: string) {
    await assertRoleAccess(this.database, username, 'inventoryVoucher', 'delete');
    const invno = String(invnoRaw ?? '').trim();
    if (!invno) {
      return { ok: false, message: 'Invoice no is required.' };
    }

    const mast = await this.database.query<{ ccode: string }>(
      `SELECT coalesce(trim(ccode), '') AS ccode
       FROM purmast WHERE trim(invno) = $1 LIMIT 1`,
      [invno],
    );
    if (!mast.rows[0]) {
      const fee = await this.database.query<{ ccode: string }>(
        `SELECT coalesce(trim(ccode), '') AS ccode
         FROM accmast WHERE trim(invno) = $1 LIMIT 1`,
        [invno],
      );
      if (!fee.rows[0]) {
        return { ok: false, message: `Invoice ${invno} not found.` };
      }
      const feeScope = await this.siteScope(username, fee.rows[0].ccode);
      if (!feeScope) {
        return { ok: false, message: 'Not allowed to delete this voucher.' };
      }
      await this.database.query(`DELETE FROM accdet WHERE trim(invno) = $1`, [invno]);
      await this.database.query(`DELETE FROM accmast WHERE trim(invno) = $1`, [invno]);
      return { ok: true, message: `Voucher ${invno} deleted.`, invno };
    }

    const scope = await this.siteScope(username, mast.rows[0].ccode);
    if (!scope) {
      return { ok: false, message: 'Not allowed to delete this voucher.' };
    }

    const det = await this.database.query(
      `DELETE FROM purdet WHERE trim(invno) = $1`,
      [invno],
    );
    await this.database.query(`DELETE FROM purmast WHERE trim(invno) = $1`, [invno]);

    const siteName = await this.siteName(mast.rows[0].ccode);
    await this.activityLog.write({
      category: 'activity',
      username,
      activity: 'Inventory Voucher Deleted',
      description: `Deleted inventory voucher ${invno}`,
      module: 'Inventory Voucher',
      campus: siteName,
      campusCode: mast.rows[0].ccode,
      status: 'Success',
      meta: { invno, detailLines: det.rowCount ?? 0 },
    });

    return { ok: true, message: `Voucher ${invno} deleted.`, invno };
  }

  /**
   * Next invoice no for purmast by ESS suffix (P/R/S/N) — same sequence as Add Stock.
   * Example: last 000626P → 000627P.
   */
  async nextInvoice(suffixRaw = 'P') {
    const suffix = String(suffixRaw || 'P')
      .trim()
      .toUpperCase()
      .slice(-1);
    const letter = /[PRSNFG]/.test(suffix) ? suffix : 'P';
    const table = letter === 'G' || letter === 'F' ? 'accmast' : 'purmast';
    const next = await this.database.query<{ n: string; last: string | null }>(
      `SELECT (coalesce(
         max(nullif(regexp_replace(trim(invno), '[^0-9]', '', 'g'), '')::bigint),
         0
       ) + 1)::text AS n,
       max(trim(invno)) AS last
       FROM ${table}
       WHERE right(upper(trim(invno)), 1) = $1`,
      [letter],
    );
    const seq = Number(next.rows[0]?.n ?? 1);
    const invno = `${String(seq).padStart(6, '0')}${letter}`;
    return {
      ok: true,
      suffix: letter,
      lastInvno: next.rows[0]?.last || null,
      invno,
    };
  }

  /**
   * Stock adjustment: In → next …P voucher, Out → next …S voucher.
   * Writes purmast + purdet (ESS purchase/stock movement tables).
   */
  async addStock(
    username: string,
    body: {
      site?: string;
      itemCode?: string;
      qty?: number | string;
      rate?: number | string;
      unit?: string;
      moveDate?: string;
      moveType?: string;
      mode?: string;
    },
  ) {
    await assertRoleAccess(
      this.database,
      username,
      'inventoryControl',
      body.mode === 'edit' ? 'edit' : 'add',
    );
    const scope = await this.siteScope(username, body.site ?? '');
    if (!scope) {
      return { ok: false, message: 'Campus / site is required or not allowed for this user.' };
    }

    const itemCode = String(body.itemCode ?? '').trim();
    if (!itemCode) {
      return { ok: false, message: 'Item code is required.' };
    }

    const qtyNum = Number(body.qty);
    if (!Number.isFinite(qtyNum) || qtyNum === 0) {
      return { ok: false, message: 'Quantity must be a non-zero number.' };
    }

    const rateNum = Number(body.rate);
    const rate = Number.isFinite(rateNum) ? Math.abs(rateNum) : 0;
    const qty = Math.abs(qtyNum);
    const moveType = String(body.moveType ?? 'In').trim().toLowerCase() === 'out' ? 'Out' : 'In';
    const suffix = moveType === 'Out' ? 'S' : 'P';

    const item = await this.database.query<{ itemCode: string; itemName: string; unit: string }>(
      `SELECT trim(i.itemcode) AS "itemCode",
              coalesce(nullif(trim(i.itemname), ''), trim(i.itemcode)) AS "itemName",
              coalesce(nullif(trim(i.uom), ''), 'PCS') AS unit
       FROM item i
       WHERE trim(i.itemcode) = $1
       ORDER BY i.row_id
       LIMIT 1`,
      [itemCode],
    );
    if (!item.rows[0]) {
      return { ok: false, message: `Item "${itemCode}" not found.` };
    }

    const unit = String(body.unit ?? '').trim() || item.rows[0].unit || 'PCS';
    const rawDate = String(body.moveDate ?? '').trim();
    const moveDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? `${rawDate} 00:00:00`
      : `${new Date().toISOString().slice(0, 10)} 00:00:00`;

    const siteCode = scope.includes('%') ? scope.replace(/%/g, '') : scope;
    // Prefer leaf campus (e.g. 1401010004). Zone-only codes like 1401 break location grouping.
    let ccode = String(body.site ?? '').trim() || siteCode;
    if (ccode.length < 8) {
      const leaf = await this.database.query<{ code: string }>(
        `SELECT trim(a.acode) AS code
         FROM acc a
         WHERE a.acode LIKE $1 || '%'
           AND length(trim(a.acode)) >= 8
         ORDER BY
           CASE WHEN trim(a.ahead) ILIKE '%Admin%' THEN 0 ELSE 1 END,
           a.acode
         LIMIT 1`,
        [ccode],
      );
      if (leaf.rows[0]?.code) ccode = leaf.rows[0].code;
    }

    const next = await this.database.query<{ n: string }>(
      `SELECT (coalesce(
         max(nullif(regexp_replace(trim(invno), '[^0-9]', '', 'g'), '')::bigint),
         0
       ) + 1)::text AS n
       FROM purmast
       WHERE right(upper(trim(invno)), 1) = $1`,
      [suffix],
    );
    const seq = Number(next.rows[0]?.n ?? 1);
    const invno = `${String(seq).padStart(6, '0')}${suffix}`;

    await this.database.query(
      `INSERT INTO purmast (invno, ccode, invdate, pflag)
       VALUES ($1, $2, $3, $4)`,
      [invno, ccode, moveDate, '1'],
    );

    await this.database.query(
      `INSERT INTO purdet (invno, itemno, qty, rate, unit, tamt)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [invno, itemCode, String(qty), String(rate), unit, String(qty * rate)],
    );

    const siteName = await this.siteName(ccode);
    await this.activityLog.write({
      category: 'activity',
      username,
      activity: 'Inventory Updated',
      description: `Stock ${moveType} ${qty} ${unit} of ${item.rows[0].itemName} (${itemCode}) — invoice ${invno}`,
      module: 'Inventory Control',
      campus: siteName,
      campusCode: ccode,
      status: 'Success',
      meta: { invno, itemCode, qty, rate, moveType },
    });

    return {
      ok: true,
      message: `Stock ${moveType} saved as ${invno}.`,
      invno,
      itemCode,
      itemName: item.rows[0].itemName,
      siteCode: ccode,
      qty: moveType === 'Out' ? -qty : qty,
      rate,
      unit,
      value: (moveType === 'Out' ? -qty : qty) * rate,
      moveType,
      moveDate: moveDate.slice(0, 10),
    };
  }

  /**
   * Permanently remove stock position for one item at one site:
   * all matching purdet (+ empty purmast) and saldet (+ empty salmast) lines.
   */
  async deleteStock(
    username: string,
    body: { site?: string; itemCode?: string },
  ) {
    await assertRoleAccess(this.database, username, 'inventoryControl', 'delete');
    const itemCode = String(body.itemCode ?? '').trim();
    const site = String(body.site ?? '').trim();
    if (!itemCode) {
      return { ok: false, message: 'Item code is required.' };
    }
    if (!site) {
      return { ok: false, message: 'Campus / site is required.' };
    }

    const scope = await this.siteScope(username, site);
    if (!scope || !(site === scope || site.startsWith(scope.replace(/%/g, '')))) {
      return { ok: false, message: 'Campus / site is not allowed for this user.' };
    }

    const purLines = await this.database.query<{ invno: string }>(
      `DELETE FROM purdet d
       USING purmast m
       WHERE trim(m.invno) = trim(d.invno)
         AND trim(d.itemno) = $1
         AND trim(m.ccode) = $2
       RETURNING trim(d.invno) AS invno`,
      [itemCode, site],
    );

    const purInvnos = [...new Set(purLines.rows.map((r) => r.invno).filter(Boolean))];
    if (purInvnos.length) {
      await this.database.query(
        `DELETE FROM purmast m
         WHERE trim(m.invno) = ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM purdet d WHERE trim(d.invno) = trim(m.invno)
           )`,
        [purInvnos],
      );
    }

    const salLines = await this.database.query<{ invno: string }>(
      `DELETE FROM saldet d
       USING salmast m
       WHERE trim(m.invno) = trim(d.invno)
         AND trim(d.itemno) = $1
         AND trim(coalesce(nullif(trim(m.wcode), ''), nullif(trim(m.pcode), ''), '')) = $2
       RETURNING trim(d.invno) AS invno`,
      [itemCode, site],
    );

    const salInvnos = [...new Set(salLines.rows.map((r) => r.invno).filter(Boolean))];
    if (salInvnos.length) {
      await this.database.query(
        `DELETE FROM salmast m
         WHERE trim(m.invno) = ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM saldet d WHERE trim(d.invno) = trim(m.invno)
           )`,
        [salInvnos],
      );
    }

    const purchaseLines = purLines.rowCount ?? purLines.rows.length;
    const salesLines = salLines.rowCount ?? salLines.rows.length;
    const removed = purchaseLines + salesLines;
    if (!removed) {
      return {
        ok: false,
        message: `No stock movements found for ${itemCode} at this site.`,
      };
    }

    const siteName = await this.siteName(site);
    await this.activityLog.write({
      category: 'activity',
      username,
      activity: 'Inventory Deleted',
      description: `Deleted ${removed} stock movement line(s) for item ${itemCode}`,
      module: 'Inventory Control',
      campus: siteName,
      campusCode: site,
      status: 'Success',
      meta: { itemCode, site, purchaseLines, salesLines },
    });

    return {
      ok: true,
      message: `Deleted ${removed} movement line(s) for ${itemCode}.`,
      itemCode,
      siteCode: site,
      purchaseLines,
      salesLines,
    };
  }

  private async siteName(code: string) {
    const rows = await this.database.query<{ name: string }>(
      `SELECT coalesce(nullif(trim(a.ahead), ''), trim(a.acode)) AS name
       FROM acc a
       WHERE trim(a.acode) = $1
       LIMIT 1`,
      [code],
    );
    return rows.rows[0]?.name || code;
  }
}
