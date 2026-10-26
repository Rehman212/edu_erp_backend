import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from './database.service';

function moneyNum(v: unknown): number {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function leftDate(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function isLeafCampus(code: string) {
  return /^14(01|02|03)01\d{4}$/.test(String(code || '').trim());
}

@Injectable()
export class RegistrationService implements OnModuleInit {
  constructor(private readonly database: DatabaseService) {}

  async onModuleInit() {
    await this.database.query(
      `ALTER TABLE student
         ADD COLUMN IF NOT EXISTS remarks text,
         ADD COLUMN IF NOT EXISTS mname varchar(120),
         ADD COLUMN IF NOT EXISTS mnic varchar(40),
         ADD COLUMN IF NOT EXISTS whatsapp varchar(40),
         ADD COLUMN IF NOT EXISTS finefee varchar(40)`,
    );
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

  async sites(username: string, site = '') {
    const zone = await this.zonePrefix(username);
    let scope = String(site || '').trim();
    if (!scope) scope = zone || '';
    else if (zone && !(scope === zone || scope.startsWith(zone))) scope = zone;
    const rows = await this.database.query<{ code: string; name: string }>(
      `SELECT trim(a.acode) AS code, trim(a.ahead) AS name
       FROM acc a
       WHERE a.acode LIKE '14%'
         AND ($1 = '' OR a.acode = $1 OR a.acode LIKE $1 || '%')
       ORDER BY a.acode`,
      [scope],
    );
    return rows.rows;
  }

  async classes() {
    // Leaf class codes only (assignable on a student). Folders like 1301 are excluded.
    const rows = await this.database.query<{ code: string; name: string }>(
      `SELECT trim(a.acode) AS code, trim(a.ahead) AS name
       FROM acc a
       WHERE trim(a.acode) ~ '^1301(01|02|03)[0-9]{4}$'
       ORDER BY a.acode`,
    );
    return rows.rows;
  }

  async sections() {
    // Leaf section codes only (assignable on a student).
    const rows = await this.database.query<{ code: string; name: string }>(
      `SELECT trim(a.acode) AS code, trim(a.ahead) AS name
       FROM acc a
       WHERE trim(a.acode) ~ '^130104[0-9]{4}$'
       ORDER BY a.acode`,
    );
    return rows.rows;
  }

  /** Bulk move active students of one campus from a class/section to another. */
  async moveClassSection(
    username: string,
    body: {
      site?: string;
      fromClass?: string;
      fromSection?: string;
      toClass?: string;
      toSection?: string;
      sdnos?: unknown;
    },
  ) {
    const site = String(body.site || '').trim();
    const fromClass = String(body.fromClass || '').trim();
    const fromSection = String(body.fromSection || '').trim();
    const toClass = String(body.toClass || '').trim();
    const toSection = String(body.toSection || '').trim();
    const sdnos = (Array.isArray(body.sdnos) ? body.sdnos : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean);

    if (!isLeafCampus(site)) return { ok: false, message: 'Select a campus first.' };
    const scope = await this.siteScope(username, site);
    if (scope !== site) return { ok: false, message: 'This campus is outside your zone.' };
    const classRe = /^1301(01|02|03)\d{4}$/;
    const sectionRe = /^130104\d{4}$/;
    if (!/^1301(01|02|03)(\d{4})?$/.test(fromClass) || !sectionRe.test(fromSection)) {
      return { ok: false, message: 'Select the old class and section.' };
    }
    if (!classRe.test(toClass) || !sectionRe.test(toSection)) {
      return { ok: false, message: 'Select the new class and section.' };
    }
    if (fromClass === toClass && fromSection === toSection) {
      return { ok: false, message: 'New class / section is the same as the old one.' };
    }
    if (!sdnos.length) return { ok: false, message: 'Select at least one student.' };
    if (sdnos.length > 2000) return { ok: false, message: 'Too many students in one move.' };

    const known = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM acc WHERE trim(acode) IN ($1, $2)`,
      [toClass, toSection],
    );
    if (Number(known.rows[0]?.n) < 2) {
      return { ok: false, message: 'New class or section does not exist.' };
    }

    const result = await this.database.query<{ sdno: string }>(
      `UPDATE student
          SET class = $1, sec = $2, sect = $2
        WHERE trim(ccode) = $3
          AND trim(class) = $4
          AND coalesce(nullif(trim(sec), ''), trim(sect)) = $5
          AND upper(trim(coalesce(stat, ''))) = 'ACTIVE'
          AND trim(sdno) = ANY($6::text[])
        RETURNING trim(sdno) AS sdno`,
      [toClass, toSection, site, fromClass, fromSection, sdnos],
    );
    const moved = result.rows.map((r) => r.sdno);
    if (!moved.length) {
      return { ok: false, message: 'No matching active students found to move.', moved: 0 };
    }
    return {
      ok: true,
      moved: moved.length,
      skipped: sdnos.length - moved.length,
      sdnos: moved,
      message: `${moved.length} student(s) moved.`,
    };
  }

  async lookups(username: string, site = '') {
    const [sites, classes, sections] = await Promise.all([
      this.sites(username, site),
      this.classes(),
      this.sections(),
    ]);
    return { sites, classes, sections };
  }

  /**
   * Active-student headcounts for zone / campus / class / section picker.
   * Returns raw rows so the client can aggregate at each drill level.
   */
  async scopeCounts(username: string, site = '') {
    const scope = await this.siteScope(username, site);
    const params: unknown[] = [];
    const where: string[] = [
      `coalesce(trim(st.name), '') <> ''`,
      `upper(trim(coalesce(st.stat, ''))) = 'ACTIVE'`,
    ];
    if (scope) {
      params.push(`${scope}%`);
      where.push(`coalesce(trim(st.ccode), '') LIKE $${params.length}`);
      if (/^14(01|02|03)$/.test(scope)) {
        params.push(`${scope}%`);
        where.push(`trim(st.sdno) LIKE $${params.length}`);
      }
    }
    const rows = await this.database.query<{
      campus: string;
      class_code: string;
      section_code: string;
      n: string;
    }>(
      `SELECT coalesce(trim(st.ccode), '') AS campus,
              coalesce(trim(st.class), '') AS class_code,
              coalesce(nullif(trim(st.sec), ''), coalesce(trim(st.sect), '')) AS section_code,
              count(*)::text AS n
       FROM student st
       WHERE ${where.join(' AND ')}
       GROUP BY 1, 2, 3`,
      params,
    );
    const byCampus: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    const bySection: Record<string, number> = {};
    let total = 0;
    for (const r of rows.rows) {
      const n = Number(r.n) || 0;
      total += n;
      if (r.campus) byCampus[r.campus] = (byCampus[r.campus] || 0) + n;
      if (r.class_code) byClass[r.class_code] = (byClass[r.class_code] || 0) + n;
      if (r.section_code) {
        bySection[r.section_code] = (bySection[r.section_code] || 0) + n;
      }
    }
    return { total, byCampus, byClass, bySection, rows: rows.rows.map((r) => ({
      campus: r.campus,
      classCode: r.class_code,
      sectionCode: r.section_code,
      count: Number(r.n) || 0,
    })) };
  }

  /** Distinct display values for the students table column dropdown filters. */
  async studentFilterOptions(username: string, site = '') {
    const scope = await this.siteScope(username, site);
    const params: unknown[] = [];
    const where: string[] = [`coalesce(trim(st.name), '') <> ''`];
    if (scope) {
      params.push(`${scope}%`);
      where.push(`coalesce(trim(st.ccode), '') LIKE $${params.length}`);
      if (/^14(01|02|03)$/.test(scope)) {
        params.push(`${scope}%`);
        where.push(`trim(st.sdno) LIKE $${params.length}`);
      }
    }
    const rows = await this.database.query<{ kind: string; value: string }>(
      `WITH s AS (
         SELECT coalesce(nullif(trim(c.ahead), ''), trim(st.ccode)) AS campus,
                coalesce(nullif(trim(cl.ahead), ''), trim(st.class)) AS class_name,
                coalesce(nullif(trim(se.ahead), ''), nullif(trim(st.sec), ''), trim(st.sect)) AS section_name,
                trim(st.atyp) AS adm_type
         FROM student st
         LEFT JOIN acc cl ON cl.acode = st.class
         LEFT JOIN acc se ON se.acode = coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), ''))
         LEFT JOIN acc c ON c.acode = st.ccode
         WHERE ${where.join(' AND ')}
       )
       SELECT DISTINCT 'campus' AS kind, campus AS value FROM s WHERE coalesce(campus, '') <> ''
       UNION SELECT DISTINCT 'className', class_name FROM s WHERE coalesce(class_name, '') <> ''
       UNION SELECT DISTINCT 'sectionName', section_name FROM s WHERE coalesce(section_name, '') <> ''
       UNION SELECT DISTINCT 'admissionType', adm_type FROM s WHERE coalesce(adm_type, '') <> ''`,
      params,
    );
    const out: Record<string, string[]> = {
      campus: [],
      className: [],
      sectionName: [],
      admissionType: [],
    };
    const seen: Record<string, Set<string>> = {};
    for (const r of rows.rows) {
      const list = out[r.kind];
      if (!list) continue;
      const key = r.value.toUpperCase();
      seen[r.kind] ??= new Set();
      if (seen[r.kind].has(key)) continue;
      seen[r.kind].add(key);
      list.push(r.value);
    }
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }
    return out;
  }

  async listStudents(
    username: string,
    site: string,
    classCode: string,
    section: string,
    status: string,
    q: string,
    page = 1,
    pageSize = 50,
    colFilters: Record<string, string> = {},
    fromDate = '',
    toDate = '',
  ) {
    const scope = await this.siteScope(username, site);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 1000);
    const current = Math.max(Number(page) || 1, 1);
    const offset = (current - 1) * size;
    const params: unknown[] = [];
    const where: string[] = [`coalesce(trim(st.name), '') <> ''`];

    if (scope) {
      params.push(`${scope}%`);
      where.push(`coalesce(trim(st.ccode), '') LIKE $${params.length}`);
      // Zone roots SRA/MTZ/TSC (1401/1402/1403): also match sdno prefix so a
      // 1403-* student sitting on a 1401 campus does not show under SRA.
      if (/^14(01|02|03)$/.test(scope)) {
        params.push(`${scope}%`);
        where.push(`trim(st.sdno) LIKE $${params.length}`);
      }
    }
    if (classCode.trim()) {
      params.push(`${classCode.trim()}%`);
      where.push(`coalesce(trim(st.class), '') LIKE $${params.length}`);
    }
    if (section.trim()) {
      params.push(`${section.trim()}%`);
      where.push(
        `(coalesce(trim(st.sec), '') LIKE $${params.length}
          OR coalesce(trim(st.sect), '') LIKE $${params.length})`,
      );
    }
    // Admit date range (ISO yyyy-mm-dd); string compare is safe for ISO dates.
    const from = String(fromDate || '').trim().slice(0, 10);
    const to = String(toDate || '').trim().slice(0, 10);
    const admitExpr = `left(coalesce(trim(st.adate::text), ''), 10)`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      params.push(from);
      where.push(
        `(${admitExpr} ~ '^\\d{4}-\\d{2}-\\d{2}' AND ${admitExpr} >= $${params.length})`,
      );
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      params.push(to);
      where.push(
        `(${admitExpr} ~ '^\\d{4}-\\d{2}-\\d{2}' AND ${admitExpr} <= $${params.length})`,
      );
    }
    // Status filters the table only — summary cards stay a breakdown of the
    // current campus / class / section / search scope (without status).
    const statusWhere: string[] = [];
    const statusParams: unknown[] = [];
    if (status.trim()) {
      const s = status.trim().toUpperCase();
      // DB may store Transfered / Transferred / Transfer — match all.
      if (s.startsWith('TRANSFER')) {
        statusWhere.push(`upper(trim(coalesce(st.stat, ''))) LIKE 'TRANSFER%'`);
      } else if (s.startsWith('PASSOUT')) {
        statusWhere.push(`upper(trim(coalesce(st.stat, ''))) LIKE 'PASSOUT%'`);
      } else {
        statusParams.push(status.trim());
        statusWhere.push(`upper(trim(coalesce(st.stat, ''))) = upper($${statusParams.length})`);
      }
    }
    if (q.trim()) {
      // AHMED / AHMAD (and spaced variants) are often the same father in ESS data.
      const rawQ = q.trim();
      const variants = new Set<string>([rawQ]);
      if (/ahmed/i.test(rawQ)) variants.add(rawQ.replace(/ahmed/gi, 'Ahmad'));
      if (/ahmad/i.test(rawQ)) variants.add(rawQ.replace(/ahmad/gi, 'Ahmed'));
      const intl = rawQ.replace(/[\s-]/g, '').match(/^\+?92(\d{6,})$/);
      if (intl) variants.add(`0${intl[1]}`);
      const qParts: string[] = [];
      for (const v of variants) {
        params.push(`%${v}%`);
        const i = params.length;
        qParts.push(
          `(st.sdno ILIKE $${i}
            OR st.rollno ILIKE $${i}
            OR st.name ILIKE $${i}
            OR st.fname ILIKE $${i}
            OR st.mname ILIKE $${i}
            OR st.gaurdian ILIKE $${i}
            OR st.cellno ILIKE $${i}
            OR st.rphone ILIKE $${i}
            OR st.ophone ILIKE $${i}
            OR st.whatsapp ILIKE $${i}
            OR st.fnic ILIKE $${i}
            OR st.mnic ILIKE $${i}
            OR st.paddress ILIKE $${i}
            OR st.remarks ILIKE $${i}
            OR st.stat ILIKE $${i}
            OR st.atyp ILIKE $${i}
            OR st.adate::text ILIKE $${i}
            OR c.ahead ILIKE $${i}
            OR cl.ahead ILIKE $${i}
            OR se.ahead ILIKE $${i}
            OR st.adfee ILIKE $${i}
            OR st.tfee ILIKE $${i}
            OR st.transfee ILIKE $${i})`,
        );
      }
      where.push(`(${qParts.join(' OR ')})`);
    }

    const like = (expr: string, raw: string) => {
      params.push(`%${raw.trim()}%`);
      where.push(`coalesce(${expr}, '') ILIKE $${params.length}`);
    };
    const exact = (expr: string, raw: string) => {
      params.push(raw.trim());
      where.push(`upper(coalesce(${expr}, '')) = upper($${params.length})`);
    };
    const money = (col: string, raw: string) => {
      params.push(`%${raw.replace(/,/g, '').trim()}%`);
      where.push(
        `replace(coalesce(trim(st.${col}::text), ''), ',', '') ILIKE $${params.length}`,
      );
    };
    for (const [key, raw] of Object.entries(colFilters)) {
      const v = String(raw || '').trim();
      if (!v) continue;
      switch (key) {
        case 'name':
          like('trim(st.name)', v);
          break;
        case 'sdno':
          like('trim(st.sdno)', v);
          break;
        case 'fatherName':
          like('trim(st.fname)', v);
          break;
        case 'remarks':
          like('trim(st.remarks)', v);
          break;
        case 'campus':
          exact(`coalesce(nullif(trim(c.ahead), ''), trim(st.ccode))`, v);
          break;
        case 'className':
          exact(`coalesce(nullif(trim(cl.ahead), ''), trim(st.class))`, v);
          break;
        case 'sectionName':
          exact(
            `coalesce(nullif(trim(se.ahead), ''), nullif(trim(st.sec), ''), trim(st.sect))`,
            v,
          );
          break;
        case 'gender': {
          const g = v.toUpperCase();
          if (g.startsWith('M')) {
            where.push(`upper(trim(coalesce(st.gndr, ''))) IN ('M', 'MALE')`);
          } else if (g.startsWith('F')) {
            where.push(`upper(trim(coalesce(st.gndr, ''))) IN ('F', 'FEMALE')`);
          } else {
            like('trim(st.gndr)', v);
          }
          break;
        }
        case 'admitDate':
          params.push(`%${v}%`);
          where.push(
            `(coalesce(trim(st.adate), '') ILIKE $${params.length}
              OR (trim(st.adate) ~ '^\\d{4}-\\d{2}-\\d{2}'
                  AND to_char(left(trim(st.adate), 10)::date, 'DD Mon YYYY') ILIKE $${params.length}))`,
          );
          break;
        case 'admissionType':
          exact('trim(st.atyp)', v);
          break;
        case 'admissionFee':
          money('adfee', v);
          break;
        case 'tuitionFee':
          money('tfee', v);
          break;
        case 'transportFee':
          money('transfee', v);
          break;
        case 'phone':
          params.push(`%${v}%`);
          where.push(
            `(coalesce(trim(st.cellno), '') ILIKE $${params.length}
              OR coalesce(trim(st.rphone), '') ILIKE $${params.length})`,
          );
          break;
        default:
          break;
      }
    }

    const joins = `LEFT JOIN acc cl ON cl.acode = st.class
       LEFT JOIN acc se ON se.acode = coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), ''))
       LEFT JOIN acc c ON c.acode = st.ccode`;

    const listWhere = [...where];
    const listParams = [...params];
    for (const clause of statusWhere) {
      if (clause.includes('$')) {
        listParams.push(...statusParams);
        listWhere.push(`upper(trim(coalesce(st.stat, ''))) = upper($${listParams.length})`);
      } else {
        listWhere.push(clause);
      }
    }

    const count = await this.database.query<{
      total: string;
      active: string;
      left: string;
      passout: string;
      transferred: string;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE upper(trim(coalesce(st.stat, ''))) = 'ACTIVE')::text AS active,
              count(*) FILTER (WHERE upper(trim(coalesce(st.stat, ''))) = 'LEFT')::text AS left,
              count(*) FILTER (WHERE upper(trim(coalesce(st.stat, ''))) LIKE 'PASSOUT%')::text AS passout,
              count(*) FILTER (WHERE upper(trim(coalesce(st.stat, ''))) LIKE 'TRANSFER%')::text AS transferred
       FROM student st
       ${joins}
       WHERE ${where.join(' AND ')}`,
      params,
    );

    const filtered = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM student st
       ${joins}
       WHERE ${listWhere.join(' AND ')}`,
      listParams,
    );

    const limitIdx = listParams.length + 1;
    const offsetIdx = listParams.length + 2;
    const rows = await this.database.query<{
      sdno: string;
      rollno: string;
      name: string;
      fatherName: string;
      classCode: string;
      className: string;
      sectionCode: string;
      sectionName: string;
      siteCode: string;
      campus: string;
      gender: string;
      phone: string;
      status: string;
      admitDate: string;
      tuitionFee: string;
    }>(
      `SELECT trim(st.sdno) AS sdno,
              coalesce(trim(st.rollno), '') AS rollno,
              coalesce(nullif(trim(st.name), ''), '') AS name,
              coalesce(trim(st.fname), '') AS "fatherName",
              coalesce(trim(st.class), '') AS "classCode",
              coalesce(nullif(trim(cl.ahead), ''), coalesce(trim(st.class), '')) AS "className",
              coalesce(nullif(trim(st.sec), ''), coalesce(trim(st.sect), '')) AS "sectionCode",
              coalesce(nullif(trim(se.ahead), ''), coalesce(nullif(trim(st.sec), ''), coalesce(trim(st.sect), ''))) AS "sectionName",
              coalesce(trim(st.ccode), '') AS "siteCode",
              coalesce(nullif(trim(c.ahead), ''), coalesce(trim(st.ccode), '')) AS campus,
              coalesce(trim(st.gndr), '') AS gender,
              coalesce(nullif(trim(st.cellno), ''), coalesce(trim(st.rphone), '')) AS phone,
              coalesce(trim(st.rphone), '') AS "homePhone",
              coalesce(trim(st.paddress), '') AS address,
              coalesce(trim(st.gaurdian), '') AS guardian,
              coalesce(trim(st.fnic), '') AS "fatherCnic",
              coalesce(trim(st.photo), '') AS photo,
              coalesce(trim(st.stat), '') AS status,
              coalesce(trim(st.atyp), '') AS "admissionType",
              left(coalesce(st.adate::text, ''), 10) AS "admitDate",
              coalesce(nullif(trim(st.adfee), ''), '0') AS "admissionFee",
              coalesce(nullif(trim(st.regfee), ''), '0') AS "registrationFee",
              coalesce(nullif(trim(st.tfee), ''), '0') AS "tuitionFee",
              coalesce(nullif(trim(st.transfee), ''), '0') AS "transportFee",
              coalesce(nullif(trim(st.anualfee), ''), '0') AS "annualFee",
              coalesce(trim(st.remarks), '') AS remarks
       FROM student st
       LEFT JOIN acc cl ON cl.acode = st.class
       LEFT JOIN acc se ON se.acode = coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), ''))
       LEFT JOIN acc c ON c.acode = st.ccode
       WHERE ${listWhere.join(' AND ')}
       ORDER BY st.row_id DESC NULLS LAST,
                left(coalesce(st.adate::text, ''), 10) DESC NULLS LAST,
                st.name
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...listParams, size, offset],
    );

    const c = count.rows[0];
    return {
      rows: rows.rows,
      total: Number(filtered.rows[0]?.n) || 0,
      page: current,
      pageSize: size,
      stats: {
        total: Number(c?.total) || 0,
        active: Number(c?.active) || 0,
        left: Number(c?.left) || 0,
        passout: Number(c?.passout) || 0,
        transferred: Number(c?.transferred) || 0,
      },
    };
  }

  async getStudent(username: string, sdnoRaw: string) {
    const sdno = String(sdnoRaw || '').trim();
    if (!sdno) return { ok: false, message: 'Student code required.' };
    const scope = await this.siteScope(username, '');
    const rows = await this.database.query<Record<string, string>>(
      `SELECT trim(st.sdno) AS sdno,
              coalesce(trim(st.rollno), '') AS rollno,
              coalesce(trim(st.name), '') AS name,
              coalesce(trim(st.fname), '') AS "fatherName",
              coalesce(trim(st.mname), '') AS "motherName",
              left(coalesce(st.dob::text, ''), 10) AS dob,
              coalesce(trim(st.gndr), '') AS gender,
              coalesce(trim(st.religion), '') AS religion,
              coalesce(trim(st.nation), '') AS nationality,
              coalesce(trim(st.caste), '') AS caste,
              coalesce(trim(st.occupat), '') AS occupation,
              coalesce(trim(st.fnic), '') AS "fatherCnic",
              coalesce(trim(st.mnic), '') AS "motherCnic",
              coalesce(trim(st.bhcert), '') AS "birthCert",
              coalesce(trim(st.ftyr), '') AS "formBay",
              coalesce(trim(st.class), '') AS "classCode",
              coalesce(nullif(trim(cl.ahead), ''), coalesce(trim(st.class), '')) AS "className",
              coalesce(nullif(trim(st.sec), ''), coalesce(trim(st.sect), '')) AS "sectionCode",
              coalesce(nullif(trim(se.ahead), ''), '') AS "sectionName",
              coalesce(trim(st.ccode), '') AS "siteCode",
              coalesce(nullif(trim(c.ahead), ''), coalesce(trim(st.ccode), '')) AS campus,
              coalesce(trim(st.paddress), '') AS address,
              coalesce(trim(st.cellno), '') AS phone,
              coalesce(trim(st.whatsapp), '') AS whatsapp,
              coalesce(trim(st.rphone), '') AS "homePhone",
              coalesce(trim(st.ophone), '') AS "officePhone",
              coalesce(trim(st.gaurdian), '') AS guardian,
              coalesce(trim(st.relation), '') AS relation,
              coalesce(trim(st.stat), '') AS status,
              coalesce(trim(st.atyp), '') AS "admissionType",
              left(coalesce(st.adate::text, ''), 10) AS "admitDate",
              left(coalesce(st.ldate::text, ''), 10) AS "leftDate",
              left(coalesce(st.dpj::text, ''), 10) AS "joinDate",
              coalesce(nullif(trim(st.adfee), ''), '0') AS "admissionFee",
              coalesce(nullif(trim(st.regfee), ''), '0') AS "registrationFee",
              coalesce(nullif(trim(st.migfee), ''), '0') AS "transferFee",
              coalesce(nullif(trim(st.tfee), ''), '0') AS "tuitionFee",
              coalesce(nullif(trim(st.anualfee), ''), '0') AS "annualFee",
              coalesce(nullif(trim(st.transfee), ''), '0') AS "transportFee",
              coalesce(nullif(trim(st.sumpack), ''), '0') AS "summerPack",
              coalesce(nullif(trim(st.security), ''), '0') AS security,
              coalesce(nullif(trim(st.finefee), ''), '0') AS "fineFee",
              coalesce(trim(st.plevel), '') AS "previousLevel",
              coalesce(trim(st.lcerti), '') AS "leavingCert",
              coalesce(trim(st.pschool), '') AS "previousSchool",
              coalesce(trim(st.photo), '') AS photo,
              coalesce(trim(st.remarks), '') AS remarks
       FROM student st
       LEFT JOIN acc cl ON cl.acode = st.class
       LEFT JOIN acc se ON se.acode = coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), ''))
       LEFT JOIN acc c ON c.acode = st.ccode
       WHERE trim(st.sdno) = $1
         AND ($2 = '' OR coalesce(trim(st.ccode), '') LIKE $2 || '%' OR $2 LIKE coalesce(trim(st.ccode), '') || '%')
       LIMIT 1`,
      [sdno, scope],
    );
    const row = rows.rows[0];
    if (!row) return { ok: false, message: 'Student not found.' };
    return { ok: true, student: row };
  }

  private bumpStudentCode(last: string, siteCode: string) {
    const raw = String(last || '').trim();
    const site = String(siteCode || '').trim().replace(/\D/g, '').slice(0, 6) || '14';
    if (!raw) return `${site}0001S`;
    const m = raw.match(/^(.*?)(\d+)(S?)$/i);
    if (!m) return `${site}0001S`;
    const prefix = m[1];
    const num = String(Number(m[2]) + 1).padStart(m[2].length, '0');
    const suffix = m[3] || 'S';
    return `${prefix}${num}${suffix}`;
  }

  /** SRA/MTZ/TSC root from site/zone code (1401… → 1401). */
  private zoneRootCode(siteOrScope: string) {
    const digits = String(siteOrScope || '').trim().replace(/\D/g, '');
    const m = digits.match(/^(1401|1402|1403)/);
    return m ? m[1] : '';
  }

  async nextStudentCode(username: string, site: string) {
    const raw = String(site || '').trim();
    // Leaf campus → always use that campus's zone for the next ID (140101… → 1401).
    // Do NOT clamp to the user's desi zone here — that produced MTZ IDs on SRA campuses.
    let zoneRoot = isLeafCampus(raw) ? this.zoneRootCode(raw) : '';
    if (!zoneRoot) {
      const scope = await this.siteScope(username, raw);
      zoneRoot = this.zoneRootCode(scope || raw);
    }
    const params: unknown[] = [];
    const where = [`coalesce(trim(st.sdno), '') <> ''`];
    if (zoneRoot) {
      params.push(`${zoneRoot}%`);
      where.push(`trim(st.sdno) LIKE $${params.length}`);
    }
    const rows = await this.database.query<{ sdno: string }>(
      `SELECT trim(st.sdno) AS sdno
       FROM student st
       WHERE ${where.join(' AND ')}
       ORDER BY length(regexp_replace(trim(st.sdno), '\\D', '', 'g')) DESC,
                regexp_replace(trim(st.sdno), '\\D', '', 'g') DESC NULLS LAST
       LIMIT 1`,
      params,
    );
    const last = String(rows.rows[0]?.sdno || '').trim();
    const code = this.bumpStudentCode(last, zoneRoot || raw);
    return { ok: true, code, lastCode: last, zone: zoneRoot };
  }

  async createStudent(
    username: string,
    body: Record<string, string | number | undefined>,
  ) {
    let sdno = String(body.sdno || body.code || '').trim();
    const name = String(body.name || '').trim();
    const siteCode = String(body.siteCode || body.ccode || '').trim();
    if (!name) return { ok: false, message: 'Student name is required.' };
    if (!isLeafCampus(siteCode)) {
      return { ok: false, message: 'Select a campus, not a zone.' };
    }
    const campusZone = this.zoneRootCode(siteCode);
    const sdnoZone = this.zoneRootCode(sdno);
    // Regenerate when missing or when ID zone ≠ selected campus zone (common UI bug).
    if (!sdno || (campusZone && sdnoZone && campusZone !== sdnoZone)) {
      const next = await this.nextStudentCode(username, siteCode);
      sdno = String(next.code || '').trim();
    }
    if (!sdno) return { ok: false, message: 'Student code required.' };

    const exists = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM student WHERE trim(sdno) = $1`,
      [sdno],
    );
    if (Number(exists.rows[0]?.n) > 0) {
      return { ok: false, message: `Student ${sdno} already exists.` };
    }

    await this.database.query(
      `INSERT INTO student (
         sdno, rollno, name, fname, mname, dob, gndr, religion, nation, caste, occupat, fnic, mnic,
         bhcert, ftyr, class, sec, sect, ccode, paddress, cellno, whatsapp, rphone, ophone,
         gaurdian, relation, stat, atyp, adate, ldate, dpj,
         adfee, regfee, migfee, tfee, anualfee, transfee, sumpack, security, finefee,
         plevel, lcerti, pschool, photo, remarks
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
         $14,$15,$16,$17,$17,$18,$19,$20,$21,$22,$23,
         $24,$25,$26,$27,$28,$29,$30,
         $31,$32,$33,$34,$35,$36,$37,$38,$39,
         $40,$41,$42,$43,$44
       )`,
      [
        sdno,
        String(body.rollno || '').trim() || null,
        name,
        String(body.fatherName || body.fname || '').trim() || null,
        String(body.motherName || body.mname || '').trim() || null,
        leftDate(body.dob) || null,
        String(body.gender || body.gndr || '').trim() || null,
        String(body.religion || '').trim() || null,
        String(body.nationality || body.nation || '').trim() || null,
        String(body.caste || '').trim() || null,
        String(body.occupation || body.occupat || '').trim() || null,
        String(body.fatherCnic || body.fnic || '').trim() || null,
        String(body.motherCnic || body.mnic || '').trim() || null,
        String(body.birthCert || body.bhcert || '').trim() || null,
        String(body.formBay || body.ftyr || '').trim() || null,
        String(body.classCode || body.class || '').trim() || null,
        String(body.sectionCode || body.sec || body.section || '').trim() || null,
        siteCode || null,
        String(body.address || body.paddress || '').trim() || null,
        String(body.phone || body.cellno || '').trim() || null,
        String(body.whatsapp || '').trim() || null,
        String(body.homePhone || body.rphone || body.fatherPhone || '').trim() || null,
        String(body.officePhone || body.ophone || '').trim() || null,
        String(body.guardian || body.gaurdian || '').trim() || null,
        String(body.relation || '').trim() || null,
        String(body.status || body.stat || 'Active').trim() || 'Active',
        String(body.admissionType || body.atyp || '').trim() || null,
        leftDate(body.admitDate || body.adate) || null,
        leftDate(body.leftDate || body.ldate) || null,
        leftDate(body.joinDate || body.dpj) || null,
        String(moneyNum(body.admissionFee ?? body.adfee)),
        String(moneyNum(body.registrationFee ?? body.regfee)),
        String(moneyNum(body.transferFee ?? body.migfee)),
        String(moneyNum(body.tuitionFee ?? body.tfee)),
        String(moneyNum(body.annualFee ?? body.anualfee)),
        String(moneyNum(body.transportFee ?? body.transfee)),
        String(moneyNum(body.summerPack ?? body.sumpack)),
        String(moneyNum(body.security)),
        String(moneyNum(body.fineFee ?? body.finefee)),
        String(body.previousLevel || body.plevel || '').trim() || null,
        String(body.leavingCert || body.lcerti || '').trim() || null,
        String(body.previousSchool || body.pschool || '').trim() || null,
        String(body.photo || '').trim() || null,
        String(body.remarks || '').trim() || null,
      ],
    );
    void username;
    return { ok: true, message: `Student ${sdno} registered.`, code: sdno, sdno };
  }

  async updateStudent(
    username: string,
    sdnoRaw: string,
    body: Record<string, string | number | undefined>,
  ) {
    const sdno = String(sdnoRaw || '').trim();
    if (!sdno) return { ok: false, message: 'Student code required.' };

    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };

    if (body.name !== undefined) set('name', String(body.name || '').trim());
    if (body.fatherName !== undefined || body.fname !== undefined) {
      set('fname', String(body.fatherName || body.fname || '').trim() || null);
    }
    if (body.motherName !== undefined || body.mname !== undefined) {
      set('mname', String(body.motherName || body.mname || '').trim() || null);
    }
    if (body.rollno !== undefined) set('rollno', String(body.rollno || '').trim() || null);
    if (body.dob !== undefined) set('dob', leftDate(body.dob) || null);
    if (body.gender !== undefined || body.gndr !== undefined) {
      set('gndr', String(body.gender || body.gndr || '').trim() || null);
    }
    if (body.religion !== undefined) set('religion', String(body.religion || '').trim() || null);
    if (body.nationality !== undefined || body.nation !== undefined) {
      set('nation', String(body.nationality || body.nation || '').trim() || null);
    }
    if (body.fatherCnic !== undefined || body.fnic !== undefined) {
      set('fnic', String(body.fatherCnic || body.fnic || '').trim() || null);
    }
    if (body.motherCnic !== undefined || body.mnic !== undefined) {
      set('mnic', String(body.motherCnic || body.mnic || '').trim() || null);
    }
    if (body.classCode !== undefined || body.class !== undefined) {
      set('class', String(body.classCode || body.class || '').trim() || null);
    }
    if (
      body.sectionCode !== undefined ||
      body.sec !== undefined ||
      body.section !== undefined
    ) {
      const sec = String(body.sectionCode || body.sec || body.section || '').trim() || null;
      set('sec', sec);
      set('sect', sec);
    }
    if (body.siteCode !== undefined || body.ccode !== undefined) {
      const siteCode = String(body.siteCode || body.ccode || '').trim();
      if (!isLeafCampus(siteCode)) {
        return { ok: false, message: 'Select a campus, not a zone.' };
      }
      set('ccode', siteCode);
    }
    if (body.address !== undefined || body.paddress !== undefined) {
      set('paddress', String(body.address || body.paddress || '').trim() || null);
    }
    if (body.phone !== undefined || body.cellno !== undefined) {
      set('cellno', String(body.phone || body.cellno || '').trim() || null);
    }
    if (body.whatsapp !== undefined) {
      set('whatsapp', String(body.whatsapp || '').trim() || null);
    }
    if (body.homePhone !== undefined || body.rphone !== undefined || body.fatherPhone !== undefined) {
      set(
        'rphone',
        String(body.homePhone || body.rphone || body.fatherPhone || '').trim() || null,
      );
    }
    if (body.officePhone !== undefined || body.ophone !== undefined) {
      set('ophone', String(body.officePhone || body.ophone || '').trim() || null);
    }
    if (body.caste !== undefined) set('caste', String(body.caste || '').trim() || null);
    if (body.occupation !== undefined || body.occupat !== undefined) {
      set('occupat', String(body.occupation || body.occupat || '').trim() || null);
    }
    if (body.birthCert !== undefined || body.bhcert !== undefined) {
      set('bhcert', String(body.birthCert || body.bhcert || '').trim() || null);
    }
    if (body.formBay !== undefined || body.ftyr !== undefined) {
      set('ftyr', String(body.formBay || body.ftyr || '').trim() || null);
    }
    if (body.guardian !== undefined || body.gaurdian !== undefined) {
      set('gaurdian', String(body.guardian || body.gaurdian || '').trim() || null);
    }
    if (body.relation !== undefined) set('relation', String(body.relation || '').trim() || null);
    if (body.status !== undefined || body.stat !== undefined) {
      set('stat', String(body.status || body.stat || '').trim() || null);
    }
    if (body.admissionType !== undefined || body.atyp !== undefined) {
      set('atyp', String(body.admissionType || body.atyp || '').trim() || null);
    }
    if (body.admitDate !== undefined || body.adate !== undefined) {
      set('adate', leftDate(body.admitDate || body.adate) || null);
    }
    if (body.leftDate !== undefined || body.ldate !== undefined) {
      set('ldate', leftDate(body.leftDate || body.ldate) || null);
    }
    if (body.joinDate !== undefined || body.dpj !== undefined) {
      set('dpj', leftDate(body.joinDate || body.dpj) || null);
    }
    if (body.admissionFee !== undefined || body.adfee !== undefined) {
      set('adfee', String(moneyNum(body.admissionFee ?? body.adfee)));
    }
    if (body.registrationFee !== undefined || body.regfee !== undefined) {
      set('regfee', String(moneyNum(body.registrationFee ?? body.regfee)));
    }
    if (body.transferFee !== undefined || body.migfee !== undefined) {
      set('migfee', String(moneyNum(body.transferFee ?? body.migfee)));
    }
    if (body.tuitionFee !== undefined || body.tfee !== undefined) {
      set('tfee', String(moneyNum(body.tuitionFee ?? body.tfee)));
    }
    if (body.annualFee !== undefined || body.anualfee !== undefined) {
      set('anualfee', String(moneyNum(body.annualFee ?? body.anualfee)));
    }
    if (body.transportFee !== undefined || body.transfee !== undefined) {
      set('transfee', String(moneyNum(body.transportFee ?? body.transfee)));
    }
    if (body.summerPack !== undefined || body.sumpack !== undefined) {
      set('sumpack', String(moneyNum(body.summerPack ?? body.sumpack)));
    }
    if (body.security !== undefined) set('security', String(moneyNum(body.security)));
    if (body.fineFee !== undefined || body.finefee !== undefined) {
      set('finefee', String(moneyNum(body.fineFee ?? body.finefee)));
    }
    if (body.previousLevel !== undefined || body.plevel !== undefined) {
      set('plevel', String(body.previousLevel || body.plevel || '').trim() || null);
    }
    if (body.leavingCert !== undefined || body.lcerti !== undefined) {
      set('lcerti', String(body.leavingCert || body.lcerti || '').trim() || null);
    }
    if (body.previousSchool !== undefined || body.pschool !== undefined) {
      set('pschool', String(body.previousSchool || body.pschool || '').trim() || null);
    }
    if (body.photo !== undefined) set('photo', String(body.photo || '').trim() || null);
    if (body.remarks !== undefined) set('remarks', String(body.remarks || '').trim() || null);

    if (!sets.length) return { ok: false, message: 'Nothing to update.' };
    values.push(sdno);
    let result;
    try {
      result = await this.database.query(
        `UPDATE student SET ${sets.join(', ')} WHERE trim(sdno) = $${values.length}`,
        values,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[registration] update ${sdno} failed:`, message);
      return { ok: false, message: `Student update failed: ${message}` };
    }
    if (!result.rowCount) return { ok: false, message: 'Student not found.' };
    void username;
    return { ok: true, message: `Student ${sdno} updated.`, code: sdno, sdno };
  }

  async deleteStudent(username: string, sdnoRaw: string) {
    const sdno = String(sdnoRaw || '').trim();
    if (!sdno) return { ok: false, message: 'Student code required.' };
    const result = await this.database.query(
      `DELETE FROM student WHERE trim(sdno) = $1`,
      [sdno],
    );
    if (!result.rowCount) return { ok: false, message: 'Student not found.' };
    void username;
    return { ok: true, message: `Student ${sdno} deleted.`, code: sdno, sdno };
  }
}
