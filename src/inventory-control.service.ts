import { Injectable } from '@nestjs/common';
import { ActivityLogService } from './activity-log.service';
import { DatabaseService } from './database.service';

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
  constructor(
    private readonly database: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

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
  ) {
    const scope = await this.siteScope(username, site);
    if (!scope) {
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

    const params = [
      `${scope}%`,
      cat,
      search,
      search ? `%${search}%` : '',
      fromScope,
      toScope,
    ];

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
      LEFT JOIN acc a ON a.acode = st.site_code
      WHERE ($2 = '' OR st.item_code LIKE $2 || '%')
        AND (
          $3 = ''
          OR st.item_code ILIKE $4
          OR coalesce(i.item_name, '') ILIKE $4
          OR coalesce(nullif(trim(a.ahead), ''), st.site_code) ILIKE $4
        )
        ${modeFilter}
    `;

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
              coalesce(
                (
                  SELECT trim(g.itemname)
                  FROM item g
                  WHERE coalesce(trim(g.uom), '') = ''
                    AND length(trim(g.itemcode)) BETWEEN 1 AND 4
                    AND st.item_code LIKE trim(g.itemcode) || '%'
                  ORDER BY length(trim(g.itemcode)) DESC
                  LIMIT 1
                ),
                left(st.item_code, 2)
              ) AS category,
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
       LIMIT $7 OFFSET $8`,
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
      return { ok: false, message: 'Invoice number is required.', master: null, lines: [] };
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
      return { ok: false, message: `Invoice ${invno} not found.`, master: null, lines: [] };
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

    return {
      ok: true,
      message: 'OK',
      master: master.rows[0],
      lines: mapped,
      summary: { totalQty, totalValue, lineCount: mapped.length },
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
    },
  ) {
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
      `INSERT INTO purmast (invno, ccode, invdate, narp, pflag)
       VALUES ($1, $2, $3, $4, $5)`,
      [invno, ccode, moveDate, `Stock ${moveType} (ERP)`, '1'],
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
