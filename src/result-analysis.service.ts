import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Injectable()
export class ResultAnalysisService {
  constructor(private readonly database: DatabaseService) {}

  async campuses(username: string) {
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

  async classes(_username: string, _campus: string) {
    const rows = await this.database.query<{ code: string; name: string }>(
      `SELECT trim(a.acode) AS code, trim(a.ahead) AS name
       FROM acc a
       WHERE (
         a.acode = '1301'
         OR a.acode LIKE '130101%'
         OR a.acode LIKE '130102%'
         OR a.acode LIKE '130103%'
       )
       ORDER BY a.acode`,
    );
    return rows.rows;
  }

  async sections(_username: string, _campus: string, _classCode: string) {
    const rows = await this.database.query<{ code: string; name: string }>(
      `SELECT trim(a.acode) AS code, trim(a.ahead) AS name
       FROM acc a
       WHERE a.acode LIKE '130104%'
       ORDER BY a.acode`,
    );
    return rows.rows;
  }

  async students(
    username: string,
    campus: string,
    classCode: string,
    section: string,
    q: string,
    page = 1,
    pageSize = 50,
    status = '',
    siblingsOnly = false,
    employeeChildOnly = false,
    sort = 'desc',
    fromDate = '',
    toDate = '',
  ) {
    const scope = await this.campusScope(username, campus);
    if (!scope) {
      return {
        rows: [],
        total: 0,
        page: 1,
        pageSize,
        stats: { total: 0, active: 0, left: 0, passout: 0, transferred: 0, other: 0 },
      };
    }

    const classScope = classCode.trim();
    const sectionScope = section.trim();
    const search = q.trim();
    const statusScope = siblingsOnly || employeeChildOnly ? 'Active' : status.trim();
    const fromScope = /^\d{4}-\d{2}-\d{2}$/.test(fromDate.trim()) ? fromDate.trim() : '';
    const toScope = /^\d{4}-\d{2}-\d{2}$/.test(toDate.trim()) ? toDate.trim() : '';
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    const params = [
      `${scope}%`,
      classScope ? `${classScope}%` : '',
      sectionScope ? `${sectionScope}%` : '',
      search,
      search ? `%${search}%` : '',
      statusScope,
      fromScope,
      toScope,
    ];

    // Uses student.fnic_norm + indexes (stat, ccode) — avoids per-row regexp_replace.
    const siblingJoin = siblingsOnly
      ? `INNER JOIN (
           SELECT st.fnic_norm AS fnic_key,
                  count(*)::int AS sibling_count,
                  max(
                    CASE
                      WHEN trim(st.adate) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(st.adate)::timestamp
                      ELSE NULL
                    END
                  ) AS latest_adate,
                  string_agg(
                    st.row_id::text
                      || E'\\t'
                      || coalesce(nullif(trim(st.name), ''), '—')
                      || E'\\t'
                      || coalesce(nullif(trim(cl2.ahead), ''), nullif(trim(st.class), ''), '—')
                      || E'\\t'
                      || coalesce(nullif(trim(se2.ahead), ''), nullif(trim(st.sec), ''), '—'),
                    E'\\n'
                    ORDER BY trim(st.name)
                  ) AS sibling_pack
           FROM student st
           LEFT JOIN acc cl2 ON cl2.acode = st.class
           LEFT JOIN acc se2 ON se2.acode = st.sec
           WHERE st.stat = 'Active'
             AND st.ccode LIKE $1
             AND length(st.fnic_norm) >= 10
           GROUP BY st.fnic_norm
           HAVING count(*) > 1
         ) sib ON s.fnic_norm = sib.fnic_key`
      : '';

    // ESS marks employee children with relation = 'EChild'.
    const employeeChildClause = employeeChildOnly
      ? `AND upper(trim(s.relation)) = 'ECHILD'`
      : '';

    // Link child → employee via father NIC, or parent name match on persona.
    const employeeJoin = employeeChildOnly
      ? `LEFT JOIN LATERAL (
           SELECT trim(p.ecode) AS ecode,
                  trim(p.ename) AS ename,
                  trim(p.design) AS design
           FROM persona p
           WHERE coalesce(trim(p.ecode), '') <> ''
             AND (
               (
                 length(coalesce(s.fnic_norm, '')) >= 10
                 AND regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g') = s.fnic_norm
               )
               OR (
                 coalesce(trim(s.fname), '') <> ''
                 AND upper(trim(p.ename)) = upper(trim(s.fname))
               )
               OR (
                 coalesce(trim(s.fname), '') <> ''
                 AND upper(trim(p.fname)) = upper(trim(s.fname))
               )
             )
           ORDER BY
             CASE
               WHEN length(coalesce(s.fnic_norm, '')) >= 10
                 AND regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g') = s.fnic_norm THEN 1
               WHEN upper(trim(p.ename)) = upper(trim(s.fname)) THEN 2
               ELSE 3
             END,
             p.ecode
           LIMIT 1
         ) emp ON true`
      : '';

    // Register / admission date (student.adate) — text like "YYYY-MM-DD HH:MM:SS".
    const where = `
      WHERE s.ccode LIKE $1
        AND ($2 = '' OR s.class LIKE $2)
        AND ($3 = '' OR s.sec LIKE $3)
        AND ($4 = '' OR s.name ILIKE $5 OR s.rollno ILIKE $5 OR s.sdno ILIKE $5 OR s.cellno ILIKE $5 OR s.fname ILIKE $5 OR s.fnic ILIKE $5)
        AND ($6 = '' OR s.stat = $6)
        AND (
          ($7 = '' AND $8 = '')
          OR (
            trim(s.adate) ~ '^\\d{4}-\\d{2}-\\d{2}'
            AND ($7 = '' OR trim(s.adate)::date >= $7::date)
            AND ($8 = '' OR trim(s.adate)::date <= $8::date)
          )
        )
        ${employeeChildClause}
    `;

    const stats = await this.database.query<{
      total: string;
      active: string;
      left: string;
      passout: string;
      transferred: string;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE s.stat = 'Active')::text AS active,
              count(*) FILTER (WHERE s.stat = 'Left')::text AS left,
              count(*) FILTER (WHERE s.stat = 'Passout')::text AS passout,
              count(*) FILTER (WHERE s.stat = 'Transfered')::text AS transferred
       FROM student s
       ${siblingJoin}
       ${where}`,
      params,
    );
    const total = Number(stats.rows[0]?.total ?? 0);
    const active = Number(stats.rows[0]?.active ?? 0);
    const left = Number(stats.rows[0]?.left ?? 0);
    const passout = Number(stats.rows[0]?.passout ?? 0);
    const transferred = Number(stats.rows[0]?.transferred ?? 0);

    const sortKey = String(sort || 'desc')
      .trim()
      .toLowerCase();
    // Parse registration date reliably (stored as text, usually YYYY-MM-DD HH:MM:SS).
    const adateTs = `CASE
      WHEN trim(s.adate) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(s.adate)::timestamp
      ELSE NULL
    END`;
    // Default / DESC = latest registration on top.
    // Sibling lists: keep family together, newest family group first.
    let orderBy: string;
    if (sortKey === 'az') {
      orderBy = siblingsOnly
        ? `ORDER BY trim(s.name) ASC, s.fnic_norm, s.row_id ASC`
        : `ORDER BY trim(s.name) ASC, s.row_id ASC`;
    } else if (sortKey === 'za') {
      orderBy = siblingsOnly
        ? `ORDER BY trim(s.name) DESC, s.fnic_norm, s.row_id DESC`
        : `ORDER BY trim(s.name) DESC, s.row_id DESC`;
    } else if (sortKey === 'asc') {
      orderBy = siblingsOnly
        ? `ORDER BY sib.latest_adate ASC NULLS LAST, s.fnic_norm, ${adateTs} ASC NULLS LAST, trim(s.name)`
        : `ORDER BY ${adateTs} ASC NULLS LAST, s.row_id ASC`;
    } else {
      // desc (default) — latest on top
      orderBy = siblingsOnly
        ? `ORDER BY sib.latest_adate DESC NULLS LAST, s.fnic_norm, ${adateTs} DESC NULLS LAST, trim(s.name)`
        : `ORDER BY ${adateTs} DESC NULLS LAST, s.row_id DESC`;
    }

    const rows = await this.database.query<{
      id: string;
      sdno: string;
      name: string;
      rollNo: string;
      contact: string;
      status: string;
      campusCode: string;
      campus: string;
      classCode: string;
      className: string;
      sectionCode: string;
      section: string;
      fatherName: string;
      fatherNic: string;
      employeeId: string | null;
      employeeName: string | null;
      employeeDesignation: string | null;
      siblingCount: string;
      siblingPack: string | null;
      address: string;
      admissionDate: string;
      dob: string;
      leftDate: string;
    }>(
      `SELECT s.row_id::text AS id,
              trim(s.sdno) AS sdno,
              trim(s.name) AS name,
              trim(s.rollno) AS "rollNo",
              trim(s.cellno) AS contact,
              trim(s.stat) AS status,
              trim(s.ccode) AS "campusCode",
              COALESCE(NULLIF(trim(c.ahead), ''), trim(s.ccode)) AS campus,
              trim(s.class) AS "classCode",
              COALESCE(NULLIF(trim(cl.ahead), ''), trim(s.class)) AS "className",
              trim(s.sec) AS "sectionCode",
              COALESCE(NULLIF(trim(se.ahead), ''), trim(s.sec)) AS section,
              trim(s.fname) AS "fatherName",
              NULLIF(trim(s.fnic), '') AS "fatherNic",
              ${employeeChildOnly ? 'NULLIF(emp.ecode, \'\')' : 'NULL'} AS "employeeId",
              ${employeeChildOnly ? 'NULLIF(emp.ename, \'\')' : 'NULL'} AS "employeeName",
              ${employeeChildOnly ? 'NULLIF(emp.design, \'\')' : 'NULL'} AS "employeeDesignation",
              ${siblingsOnly ? 'sib.sibling_count::text' : `'0'`} AS "siblingCount",
              ${siblingsOnly ? 'sib.sibling_pack' : 'NULL'} AS "siblingPack",
              trim(s.paddress) AS address,
              NULLIF(trim(s.adate), '') AS "admissionDate",
              NULLIF(trim(s.dob), '') AS dob,
              NULLIF(trim(s.ldate), '') AS "leftDate"
       FROM student s
       ${siblingJoin}
       ${employeeJoin}
       LEFT JOIN acc c ON c.acode = s.ccode
       LEFT JOIN acc cl ON cl.acode = s.class
       LEFT JOIN acc se ON se.acode = s.sec
       ${where}
       ${orderBy}
       LIMIT $9 OFFSET $10`,
      [...params, size, offset],
    );

    const mappedRows = rows.rows.map((row) => {
      const others =
        siblingsOnly && row.siblingPack
          ? row.siblingPack
              .split('\n')
              .map((line) => {
                const [id, name, className, section] = line.split('\t');
                return { id, name, className, section };
              })
              .filter((item) => item.id && item.id !== row.id)
          : [];
      const siblingDetails = others
        .map((item) => {
          const place = [item.className, item.section].filter((v) => v && v !== '—').join(' / ');
          return place ? `${item.name} (${place})` : item.name;
        })
        .join(', ');
      const { siblingPack: _pack, ...rest } = row;
      return {
        ...rest,
        siblingDetails,
      };
    });

    return {
      rows: mappedRows,
      total,
      page: current,
      pageSize: size,
      stats: {
        total,
        active,
        left,
        passout,
        transferred,
        other: Math.max(total - active - left - passout - transferred, 0),
      },
    };
  }

  async strengthClasswise(
    username: string,
    campus: string,
    classCode: string,
    section: string,
  ) {
    const scope = await this.campusScope(username, campus);
    if (!scope) {
      return {
        rows: [],
        totals: { active: 0, left: 0, passout: 0, transferred: 0, total: 0 },
      };
    }

    const classScope = classCode.trim();
    const sectionScope = section.trim();
    const params = [
      `${scope}%`,
      classScope ? `${classScope}%` : '',
      sectionScope ? `${sectionScope}%` : '',
    ];

    const rows = await this.database.query<{
      campusCode: string;
      campus: string;
      classCode: string;
      className: string;
      sectionCode: string;
      section: string;
      active: string;
      left: string;
      passout: string;
      transferred: string;
      total: string;
    }>(
      `SELECT s.ccode AS "campusCode",
              COALESCE(NULLIF(trim(c.ahead), ''), s.ccode) AS campus,
              s.class AS "classCode",
              COALESCE(NULLIF(trim(cl.ahead), ''), s.class) AS "className",
              s.sec AS "sectionCode",
              COALESCE(NULLIF(trim(se.ahead), ''), s.sec) AS section,
              count(*) FILTER (WHERE s.stat = 'Active')::text AS active,
              count(*) FILTER (WHERE s.stat = 'Left')::text AS left,
              count(*) FILTER (WHERE s.stat = 'Passout')::text AS passout,
              count(*) FILTER (WHERE s.stat = 'Transfered')::text AS transferred,
              count(*)::text AS total
       FROM student s
       LEFT JOIN acc c ON c.acode = s.ccode
       LEFT JOIN acc cl ON cl.acode = s.class
       LEFT JOIN acc se ON se.acode = s.sec
       WHERE s.ccode LIKE $1
         AND ($2 = '' OR s.class LIKE $2)
         AND ($3 = '' OR s.sec LIKE $3)
       GROUP BY s.ccode, COALESCE(NULLIF(trim(c.ahead), ''), s.ccode),
                s.class, COALESCE(NULLIF(trim(cl.ahead), ''), s.class),
                s.sec, COALESCE(NULLIF(trim(se.ahead), ''), s.sec)
       ORDER BY s.ccode, s.class, s.sec`,
      params,
    );

    const mapped = rows.rows.map((row) => ({
      campusCode: row.campusCode,
      campus: row.campus,
      classCode: row.classCode,
      className: row.className,
      sectionCode: row.sectionCode,
      section: row.section,
      active: Number(row.active) || 0,
      left: Number(row.left) || 0,
      passout: Number(row.passout) || 0,
      transferred: Number(row.transferred) || 0,
      total: Number(row.total) || 0,
    }));

    const totals = mapped.reduce(
      (acc, row) => ({
        active: acc.active + row.active,
        left: acc.left + row.left,
        passout: acc.passout + row.passout,
        transferred: acc.transferred + row.transferred,
        total: acc.total + row.total,
      }),
      { active: 0, left: 0, passout: 0, transferred: 0, total: 0 },
    );

    return { rows: mapped, totals };
  }

  private async campusScope(username: string, campus: string) {
    const zone = await this.zonePrefix(username);
    let code = campus.trim();
    if (!code) code = zone || '14';
    if (zone && !(code === zone || code.startsWith(zone))) return '';
    if (code.startsWith('140102')) return '';
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
}
