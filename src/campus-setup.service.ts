import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

const ZONE_ROOTS = ['1401', '1402', '1403'] as const;
const CAMPUS_LIKE = '14__01____';
const SECTION_PREFIX = '130104';

type ZoneRoot = (typeof ZONE_ROOTS)[number];

export type CampusSectionUse = {
  code: string;
  name: string;
  students: number;
};

export type CampusRow = {
  code: string;
  name: string;
  zoneCode: string;
  zoneName: string;
  address: string;
  phone: string;
  flag: string;
  endate: string;
  students: number;
  sections: CampusSectionUse[];
};

export type SectionRow = {
  code: string;
  name: string;
  flag: string;
  endate: string;
  students: number;
  campuses: number;
};

function stampNow() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function cleanName(v: unknown) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(v: unknown) {
  return String(v ?? '').trim();
}

@Injectable()
export class CampusSetupService {
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

  private zoneRoot(code: string): ZoneRoot | '' {
    const digits = String(code || '').trim();
    const m = digits.match(/^(1401|1402|1403)/);
    return (m?.[1] as ZoneRoot) || '';
  }

  private isCampusCode(code: string) {
    return /^14(01|02|03)01\d{4}$/.test(String(code || '').trim());
  }

  private isSectionCode(code: string) {
    return /^130104\d{4}$/.test(String(code || '').trim());
  }

  private async countSql(sql: string, params: unknown[]) {
    try {
      const rows = await this.database.query<{ n: string }>(sql, params);
      return Number(rows.rows[0]?.n || 0);
    } catch {
      return 0;
    }
  }

  private async nextLeaf(prefix: string) {
    const rows = await this.database.query<{ code: string }>(
      `SELECT trim(a.acode) AS code
       FROM acc a
       WHERE trim(a.acode) LIKE $1 || '%'
         AND length(trim(a.acode)) = $2`,
      [prefix, prefix.length + 4],
    );
    let max = 0;
    for (const row of rows.rows) {
      const tail = row.code.slice(prefix.length);
      if (!/^\d+$/.test(tail)) continue;
      const n = Number(tail);
      if (n > max) max = n;
    }
    if (max >= 9999) return '';
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }

  private async campusUsage(code: string) {
    const c = String(code || '').trim();
    const [
      students,
      stud,
      stud1,
      purchases,
      fees,
      expenses,
      ledger,
      users,
    ] = await Promise.all([
      this.countSql(
        `SELECT count(*)::text AS n
         FROM student
         WHERE trim(ccode) = $1
           AND coalesce(trim(name), '') <> ''`,
        [c],
      ),
      this.countSql(`SELECT count(*)::text AS n FROM stud WHERE trim(ccode) = $1`, [c]),
      this.countSql(`SELECT count(*)::text AS n FROM stud1 WHERE trim(ccode) = $1`, [c]),
      this.countSql(`SELECT count(*)::text AS n FROM purmast WHERE trim(ccode) = $1`, [c]),
      this.countSql(`SELECT count(*)::text AS n FROM accmast WHERE trim(ccode) = $1`, [c]),
      this.countSql(`SELECT count(*)::text AS n FROM exmast WHERE trim(ccode) = $1`, [c]),
      this.countSql(`SELECT count(*)::text AS n FROM accdet WHERE trim(acode) = $1`, [c]),
      this.countSql(
        `SELECT count(*)::text AS n
         FROM puser
         WHERE trim(desi) = $1 OR trim(desi) LIKE $1 || '%'`,
        [c],
      ),
    ]);
    return {
      students,
      archives: stud + stud1,
      purchases,
      fees,
      expenses,
      ledger,
      users,
    };
  }

  private async sectionUsage(code: string) {
    const c = String(code || '').trim();
    const [students, stud, stud1] = await Promise.all([
      this.countSql(
        `SELECT count(*)::text AS n
         FROM student
         WHERE coalesce(trim(name), '') <> ''
           AND (
             trim(sec) = $1
             OR trim(sect) = $1
           )`,
        [c],
      ),
      this.countSql(
        `SELECT count(*)::text AS n FROM stud WHERE trim(sec) = $1`,
        [c],
      ),
      this.countSql(
        `SELECT count(*)::text AS n FROM stud1 WHERE trim(sec) = $1`,
        [c],
      ),
    ]);
    return { students, archives: stud + stud1 };
  }

  async tree(username: string, site = '') {
    const scope = await this.siteScope(username, site);
    const zoneFilter = this.zoneRoot(scope);
    const campusPrefix = scope;

    const zones = await this.database.query<{ code: string; name: string }>(
      `SELECT trim(a.acode) AS code, coalesce(nullif(trim(a.ahead), ''), trim(a.acode)) AS name
       FROM acc a
       WHERE trim(a.acode) = ANY($1::text[])
         AND ($2 = '' OR trim(a.acode) = $2)
       ORDER BY a.acode`,
      [ZONE_ROOTS as unknown as string[], zoneFilter],
    );

    const campuses = await this.database.query<{
      code: string;
      name: string;
      address: string;
      phone: string;
      flag: string;
      endate: string;
    }>(
      `SELECT
         trim(a.acode) AS code,
         coalesce(nullif(trim(a.ahead), ''), trim(a.acode)) AS name,
         coalesce(trim(a.address), '') AS address,
         coalesce(trim(a.phone), '') AS phone,
         coalesce(trim(a.flag), '') AS flag,
         coalesce(trim(a.endate), '') AS endate
       FROM acc a
       WHERE trim(a.acode) LIKE $1
         AND ($2 = '' OR trim(a.acode) LIKE $2 || '%')
       ORDER BY a.acode`,
      [CAMPUS_LIKE, campusPrefix],
    );

    const studentCounts = await this.database.query<{ campus: string; n: string }>(
      `SELECT trim(st.ccode) AS campus, count(*)::text AS n
       FROM student st
       WHERE coalesce(trim(st.name), '') <> ''
         AND trim(st.ccode) LIKE $1
         AND ($2 = '' OR trim(st.ccode) LIKE $2 || '%')
       GROUP BY trim(st.ccode)`,
      [CAMPUS_LIKE, campusPrefix],
    );

    const sectionUse = await this.database.query<{
      campus: string;
      sec: string;
      n: string;
    }>(
      `SELECT
         trim(st.ccode) AS campus,
         trim(coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), ''))) AS sec,
         count(*)::text AS n
       FROM student st
       WHERE coalesce(trim(st.name), '') <> ''
         AND trim(st.ccode) LIKE $1
         AND ($2 = '' OR trim(st.ccode) LIKE $2 || '%')
         AND coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), '')) LIKE '130104%'
       GROUP BY 1, 2
       ORDER BY 1, 2`,
      [CAMPUS_LIKE, campusPrefix],
    );

    const catalog = await this.database.query<{
      code: string;
      name: string;
      flag: string;
      endate: string;
    }>(
      `SELECT
         trim(a.acode) AS code,
         coalesce(nullif(trim(a.ahead), ''), trim(a.acode)) AS name,
         coalesce(trim(a.flag), '') AS flag,
         coalesce(trim(a.endate), '') AS endate
       FROM acc a
       WHERE trim(a.acode) LIKE $1 || '%'
         AND length(trim(a.acode)) = 10
       ORDER BY a.acode`,
      [SECTION_PREFIX],
    );

    const sectionCounts = await this.database.query<{
      sec: string;
      n: string;
      campuses: string;
    }>(
      `SELECT
         trim(coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), ''))) AS sec,
         count(*)::text AS n,
         count(DISTINCT trim(st.ccode))::text AS campuses
       FROM student st
       WHERE coalesce(trim(st.name), '') <> ''
         AND coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), '')) LIKE '130104%'
       GROUP BY 1`,
    );

    const zoneName = new Map(zones.rows.map((z) => [z.code, z.name]));
    const studentsByCampus = new Map(
      studentCounts.rows.map((r) => [r.campus, Number(r.n) || 0]),
    );
    const catalogName = new Map(catalog.rows.map((s) => [s.code, s.name]));
    const sectionsByCampus = new Map<string, CampusSectionUse[]>();
    for (const row of sectionUse.rows) {
      if (!row.campus || !row.sec) continue;
      const list = sectionsByCampus.get(row.campus) || [];
      list.push({
        code: row.sec,
        name: catalogName.get(row.sec) || row.sec,
        students: Number(row.n) || 0,
      });
      sectionsByCampus.set(row.campus, list);
    }

    const campusRows: CampusRow[] = campuses.rows.map((c) => {
      const z = this.zoneRoot(c.code);
      return {
        code: c.code,
        name: c.name,
        zoneCode: z,
        zoneName: zoneName.get(z) || z,
        address: c.address,
        phone: c.phone,
        flag: c.flag,
        endate: c.endate,
        students: studentsByCampus.get(c.code) || 0,
        sections: sectionsByCampus.get(c.code) || [],
      };
    });

    const studentBySec = new Map(
      sectionCounts.rows.map((r) => [r.sec, Number(r.n) || 0]),
    );
    const campusBySec = new Map(
      sectionCounts.rows.map((r) => [r.sec, Number(r.campuses) || 0]),
    );

    const sectionRows: SectionRow[] = catalog.rows.map((s) => ({
      code: s.code,
      name: s.name,
      flag: s.flag,
      endate: s.endate,
      students: studentBySec.get(s.code) || 0,
      campuses: campusBySec.get(s.code) || 0,
    }));

    const nextByZone: Record<string, string> = {};
    for (const z of zones.rows) {
      nextByZone[z.code] = await this.nextLeaf(`${z.code}01`);
    }

    return {
      ok: true,
      scope: scope || '',
      zones: zones.rows.map((z) => ({
        code: z.code,
        name: z.name,
        nextCampusCode: nextByZone[z.code] || '',
        campuses: campusRows.filter((c) => c.zoneCode === z.code).length,
        students: campusRows
          .filter((c) => c.zoneCode === z.code)
          .reduce((sum, c) => sum + c.students, 0),
      })),
      campuses: campusRows,
      sections: sectionRows,
      nextSectionCode: await this.nextLeaf(SECTION_PREFIX),
    };
  }

  async createCampus(
    username: string,
    body: Record<string, string | undefined>,
  ) {
    const name = cleanName(body.name);
    const address = cleanText(body.address);
    const phone = cleanText(body.phone);
    const zoneCode = this.zoneRoot(cleanText(body.zoneCode || body.site));
    if (!name) return { ok: false, message: 'Campus name is required.' };
    if (!zoneCode) return { ok: false, message: 'Select a zone for the campus.' };

    const desi = await this.zonePrefix(username);
    if (desi && this.isCampusCode(desi)) {
      return { ok: false, message: 'Campus-level users cannot add a campus.' };
    }
    const scope = await this.siteScope(username, zoneCode);
    if (scope && !(zoneCode === scope || zoneCode.startsWith(scope) || scope.startsWith(zoneCode))) {
      return { ok: false, message: 'Zone is not allowed for this user.' };
    }

    const prefix = `${zoneCode}01`;
    const code = await this.nextLeaf(prefix);
    if (!code || !this.isCampusCode(code)) {
      return { ok: false, message: 'Could not allocate the next campus code.' };
    }

    const dup = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM acc
       WHERE trim(acode) LIKE $1
         AND upper(trim(ahead)) = upper($2)`,
      [`${zoneCode}01____`, name],
    );
    if (Number(dup.rows[0]?.n) > 0) {
      return { ok: false, message: `Campus "${name}" already exists.` };
    }

    await this.database.query(
      `INSERT INTO acc (acode, ahead, flag, address, phone, endate)
       VALUES ($1, $2, 'T', $3, $4, $5)`,
      [code, name, address || null, phone || null, stampNow()],
    );

    return { ok: true, message: `Campus ${name} created.`, code, name, zoneCode };
  }

  async updateCampus(
    username: string,
    codeRaw: string,
    body: Record<string, string | undefined>,
  ) {
    const code = cleanText(codeRaw);
    if (!this.isCampusCode(code)) {
      return { ok: false, message: 'Invalid campus code.' };
    }
    const scope = await this.siteScope(username, code);
    if (scope && !code.startsWith(scope) && code !== scope) {
      return { ok: false, message: 'Campus is not allowed for this user.' };
    }

    const existing = await this.database.query<{ code: string }>(
      `SELECT trim(acode) AS code FROM acc WHERE trim(acode) = $1 LIMIT 1`,
      [code],
    );
    if (!existing.rows[0]) return { ok: false, message: 'Campus not found.' };

    const name = cleanName(body.name);
    if (!name) return { ok: false, message: 'Campus name is required.' };
    const address = cleanText(body.address);
    const phone = cleanText(body.phone);

    const dup = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM acc
       WHERE trim(acode) LIKE $1
         AND upper(trim(ahead)) = upper($2)
         AND trim(acode) <> $3`,
      [`${this.zoneRoot(code)}01____`, name, code],
    );
    if (Number(dup.rows[0]?.n) > 0) {
      return { ok: false, message: `Campus "${name}" already exists.` };
    }

    const result = await this.database.query(
      `UPDATE acc
       SET ahead = $2,
           address = $3,
           phone = $4
       WHERE trim(acode) = $1`,
      [code, name, address || null, phone || null],
    );
    if (!result.rowCount) return { ok: false, message: 'Campus not found.' };
    return { ok: true, message: `Campus ${name} updated.`, code, name };
  }

  async deleteCampus(username: string, codeRaw: string) {
    const code = cleanText(codeRaw);
    if (!this.isCampusCode(code)) {
      return { ok: false, message: 'Invalid campus code.' };
    }
    const scope = await this.siteScope(username, code);
    if (scope && !code.startsWith(scope) && code !== scope) {
      return { ok: false, message: 'Campus is not allowed for this user.' };
    }

    const row = await this.database.query<{ name: string }>(
      `SELECT coalesce(nullif(trim(ahead), ''), trim(acode)) AS name
       FROM acc WHERE trim(acode) = $1 LIMIT 1`,
      [code],
    );
    if (!row.rows[0]) return { ok: false, message: 'Campus not found.' };

    const usage = await this.campusUsage(code);
    if (usage.students > 0) {
      return {
        ok: false,
        message: `Cannot remove ${row.rows[0].name} — ${usage.students} student(s) are registered.`,
      };
    }
    if (usage.purchases > 0 || usage.fees > 0) {
      return {
        ok: false,
        message: `Cannot remove ${row.rows[0].name} — vouchers exist on this campus.`,
      };
    }
    if (usage.expenses > 0 || usage.ledger > 0) {
      return {
        ok: false,
        message: `Cannot remove ${row.rows[0].name} — financial postings exist on this campus.`,
      };
    }
    if (usage.users > 0) {
      return {
        ok: false,
        message: `Cannot remove ${row.rows[0].name} — user accounts are assigned here.`,
      };
    }
    if (usage.archives > 0) {
      return {
        ok: false,
        message: `Cannot remove ${row.rows[0].name} — archived student records still reference it.`,
      };
    }

    const result = await this.database.query(
      `DELETE FROM acc WHERE trim(acode) = $1 AND trim(acode) LIKE $2`,
      [code, CAMPUS_LIKE],
    );
    if (!result.rowCount) return { ok: false, message: 'Campus not found.' };
    return { ok: true, message: `Campus ${row.rows[0].name} removed.`, code };
  }

  async createSection(
    username: string,
    body: Record<string, string | undefined>,
  ) {
    void username;
    const name = cleanName(body.name);
    if (!name) return { ok: false, message: 'Section name is required.' };

    const dup = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM acc
       WHERE trim(acode) LIKE $1 || '%'
         AND length(trim(acode)) = 10
         AND upper(trim(ahead)) = upper($2)`,
      [SECTION_PREFIX, name],
    );
    if (Number(dup.rows[0]?.n) > 0) {
      return { ok: false, message: `Section "${name}" already exists.` };
    }

    const code = await this.nextLeaf(SECTION_PREFIX);
    if (!code || !this.isSectionCode(code)) {
      return { ok: false, message: 'Could not allocate the next section code.' };
    }

    await this.database.query(
      `INSERT INTO acc (acode, ahead, flag, endate)
       VALUES ($1, $2, 'T', $3)`,
      [code, name, stampNow()],
    );

    return { ok: true, message: `Section ${name} created.`, code, name };
  }

  async updateSection(
    username: string,
    codeRaw: string,
    body: Record<string, string | undefined>,
  ) {
    void username;
    const code = cleanText(codeRaw);
    if (!this.isSectionCode(code)) {
      return { ok: false, message: 'Invalid section code.' };
    }
    const name = cleanName(body.name);
    if (!name) return { ok: false, message: 'Section name is required.' };

    const existing = await this.database.query<{ code: string }>(
      `SELECT trim(acode) AS code FROM acc WHERE trim(acode) = $1 LIMIT 1`,
      [code],
    );
    if (!existing.rows[0]) return { ok: false, message: 'Section not found.' };

    const dup = await this.database.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM acc
       WHERE trim(acode) LIKE $1 || '%'
         AND length(trim(acode)) = 10
         AND upper(trim(ahead)) = upper($2)
         AND trim(acode) <> $3`,
      [SECTION_PREFIX, name, code],
    );
    if (Number(dup.rows[0]?.n) > 0) {
      return { ok: false, message: `Section "${name}" already exists.` };
    }

    const result = await this.database.query(
      `UPDATE acc SET ahead = $2 WHERE trim(acode) = $1`,
      [code, name],
    );
    if (!result.rowCount) return { ok: false, message: 'Section not found.' };
    return { ok: true, message: `Section ${name} updated.`, code, name };
  }

  async deleteSection(username: string, codeRaw: string) {
    void username;
    const code = cleanText(codeRaw);
    if (!this.isSectionCode(code)) {
      return { ok: false, message: 'Invalid section code.' };
    }

    const row = await this.database.query<{ name: string }>(
      `SELECT coalesce(nullif(trim(ahead), ''), trim(acode)) AS name
       FROM acc WHERE trim(acode) = $1 LIMIT 1`,
      [code],
    );
    if (!row.rows[0]) return { ok: false, message: 'Section not found.' };

    const usage = await this.sectionUsage(code);
    if (usage.students > 0) {
      return {
        ok: false,
        message: `Cannot remove ${row.rows[0].name} — ${usage.students} student(s) are assigned.`,
      };
    }
    if (usage.archives > 0) {
      return {
        ok: false,
        message: `Cannot remove ${row.rows[0].name} — archived student records still reference it.`,
      };
    }

    const result = await this.database.query(
      `DELETE FROM acc
       WHERE trim(acode) = $1
         AND trim(acode) LIKE $2 || '%'
         AND length(trim(acode)) = 10`,
      [code, SECTION_PREFIX],
    );
    if (!result.rowCount) return { ok: false, message: 'Section not found.' };
    return { ok: true, message: `Section ${row.rows[0].name} removed.`, code };
  }
}
