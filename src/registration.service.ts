import { Injectable } from '@nestjs/common';
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

@Injectable()
export class RegistrationService {
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

  async classes() {
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

  async sections() {
    const rows = await this.database.query<{ code: string; name: string }>(
      `SELECT trim(a.acode) AS code, trim(a.ahead) AS name
       FROM acc a
       WHERE a.acode LIKE '130104%'
       ORDER BY a.acode`,
    );
    return rows.rows;
  }

  async lookups(username: string, site = '') {
    const [sites, classes, sections] = await Promise.all([
      this.sites(username),
      this.classes(),
      this.sections(),
    ]);
    void site;
    return { sites, classes, sections };
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
  ) {
    const scope = await this.siteScope(username, site);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
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
    if (status.trim()) {
      params.push(status.trim());
      where.push(`upper(trim(coalesce(st.stat, ''))) = upper($${params.length})`);
    }
    if (q.trim()) {
      params.push(`%${q.trim()}%`);
      where.push(
        `(st.sdno ILIKE $${params.length}
          OR st.rollno ILIKE $${params.length}
          OR st.name ILIKE $${params.length}
          OR st.fname ILIKE $${params.length}
          OR st.cellno ILIKE $${params.length})`,
      );
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
       FROM student st WHERE ${where.join(' AND ')}`,
      params,
    );

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
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
              coalesce(nullif(trim(st.anualfee), ''), '0') AS "annualFee"
       FROM student st
       LEFT JOIN acc cl ON cl.acode = st.class
       LEFT JOIN acc se ON se.acode = coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), ''))
       LEFT JOIN acc c ON c.acode = st.ccode
       WHERE ${where.join(' AND ')}
       ORDER BY length(regexp_replace(coalesce(trim(st.sdno), ''), '\\D', '', 'g')) DESC,
                regexp_replace(coalesce(trim(st.sdno), ''), '\\D', '', 'g') DESC NULLS LAST,
                st.name
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, size, offset],
    );

    const c = count.rows[0];
    return {
      rows: rows.rows,
      total: Number(c?.total) || 0,
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
              left(coalesce(st.dob::text, ''), 10) AS dob,
              coalesce(trim(st.gndr), '') AS gender,
              coalesce(trim(st.religion), '') AS religion,
              coalesce(trim(st.nation), '') AS nationality,
              coalesce(trim(st.caste), '') AS caste,
              coalesce(trim(st.occupat), '') AS occupation,
              coalesce(trim(st.fnic), '') AS "fatherCnic",
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
              coalesce(trim(st.plevel), '') AS "previousLevel",
              coalesce(trim(st.lcerti), '') AS "leavingCert",
              coalesce(trim(st.pschool), '') AS "previousSchool",
              coalesce(trim(st.photo), '') AS photo
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
    const scope = await this.siteScope(username, site);
    const zoneRoot = this.zoneRootCode(scope || site);
    const params: unknown[] = [];
    const where = [`coalesce(trim(st.sdno), '') <> ''`];
    // Always key next ID off student-code zone prefix (not ccode), so a 1403-*
    // student parked on an SRA campus cannot produce the next SRA registration ID.
    if (zoneRoot) {
      params.push(`${zoneRoot}%`);
      where.push(`trim(st.sdno) LIKE $${params.length}`);
    } else if (scope) {
      params.push(`${scope}%`);
      where.push(`coalesce(trim(st.ccode), '') LIKE $${params.length}`);
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
    const code = this.bumpStudentCode(last, zoneRoot || scope || site);
    return { ok: true, code, lastCode: last };
  }

  async createStudent(
    username: string,
    body: Record<string, string | number | undefined>,
  ) {
    let sdno = String(body.sdno || body.code || '').trim();
    const name = String(body.name || '').trim();
    const siteCode = String(body.siteCode || body.ccode || '').trim();
    if (!name) return { ok: false, message: 'Student name is required.' };
    if (!sdno) {
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
         sdno, rollno, name, fname, dob, gndr, religion, nation, caste, occupat, fnic,
         bhcert, ftyr, class, sec, sect, ccode, paddress, cellno, rphone, ophone,
         gaurdian, relation, stat, atyp, adate, ldate, dpj,
         adfee, regfee, migfee, tfee, anualfee, transfee, sumpack, security,
         plevel, lcerti, pschool, photo
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
         $12,$13,$14,$15,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25,$26,$27,
         $28,$29,$30,$31,$32,$33,$34,$35,
         $36,$37,$38,$39
       )`,
      [
        sdno,
        String(body.rollno || '').trim() || null,
        name,
        String(body.fatherName || body.fname || '').trim() || null,
        leftDate(body.dob) || null,
        String(body.gender || body.gndr || '').trim() || null,
        String(body.religion || '').trim() || null,
        String(body.nationality || body.nation || '').trim() || null,
        String(body.caste || '').trim() || null,
        String(body.occupation || body.occupat || '').trim() || null,
        String(body.fatherCnic || body.fnic || '').trim() || null,
        String(body.birthCert || body.bhcert || '').trim() || null,
        String(body.formBay || body.ftyr || '').trim() || null,
        String(body.classCode || body.class || '').trim() || null,
        String(body.sectionCode || body.sec || body.section || '').trim() || null,
        siteCode || null,
        String(body.address || body.paddress || '').trim() || null,
        String(body.phone || body.cellno || '').trim() || null,
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
        String(body.previousLevel || body.plevel || '').trim() || null,
        String(body.leavingCert || body.lcerti || '').trim() || null,
        String(body.previousSchool || body.pschool || '').trim() || null,
        String(body.photo || '').trim() || null,
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
      set('ccode', String(body.siteCode || body.ccode || '').trim() || null);
    }
    if (body.address !== undefined || body.paddress !== undefined) {
      set('paddress', String(body.address || body.paddress || '').trim() || null);
    }
    if (body.phone !== undefined || body.cellno !== undefined) {
      set('cellno', String(body.phone || body.cellno || '').trim() || null);
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

    if (!sets.length) return { ok: false, message: 'Nothing to update.' };
    values.push(sdno);
    const result = await this.database.query(
      `UPDATE student SET ${sets.join(', ')} WHERE trim(sdno) = $${values.length}`,
      values,
    );
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
