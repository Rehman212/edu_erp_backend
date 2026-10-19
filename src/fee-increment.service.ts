import { Injectable } from '@nestjs/common';
import type { QueryResult, QueryResultRow } from 'pg';
import { ActivityLogService } from './activity-log.service';
import { DatabaseService } from './database.service';

export type FeeAction = 'increment' | 'generate' | 'discount';
export type FeeHead = 'tuition' | 'van' | 'annual' | 'summer' | 'fine';
export type IncrementMode = 'amount' | 'percent' | 'set' | 'discount';

export type FeeBulkBody = {
  action?: string;
  site?: string;
  classCode?: string;
  section?: string;
  head?: string;
  mode?: string;
  value?: string | number;
  mont?: string;
  description?: string;
  sdnos?: unknown;
};

type HeadSpec = {
  column: 'tfee' | 'transfee' | 'anualfee' | 'sumpack' | '';
  recv: string;
  income: string;
  scope: 'month' | 'year';
  label: string;
};

const HEADS: Record<FeeHead, HeadSpec> = {
  tuition: { column: 'tfee', recv: '1502010001', income: '310101', scope: 'month', label: 'Tuition Fee' },
  van: { column: 'transfee', recv: '1502010003', income: '310103', scope: 'month', label: 'Van Fee' },
  annual: { column: 'anualfee', recv: '1502010009', income: '310109', scope: 'year', label: 'Annual Fund' },
  summer: { column: 'sumpack', recv: '1502010004', income: '310104', scope: 'year', label: 'Summer Task' },
  fine: { column: '', recv: '1502010010', income: '310110', scope: 'month', label: 'Fine' },
};

const NUM = (alias: string, col: string) =>
  `CASE WHEN coalesce(${alias}.${col}, '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${alias}.${col}::numeric ELSE 0 END`;

const G_PAID_SQL = (alias: string) =>
  `EXISTS (SELECT 1 FROM accmast fx WHERE fx.invno = left(trim(${alias}.invno), length(trim(${alias}.invno)) - 1) || 'F')`;

type Runner = {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export type PreviewRow = {
  sdno: string;
  name: string;
  fatherName: string;
  className: string;
  sectionName: string;
  current: number;
  next: number;
  invno: string;
  status: 'ok' | 'zero' | 'same' | 'billed' | 'paid' | 'noBill' | 'discounted';
};

function money(raw: unknown) {
  const n = Number(String(raw ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class FeeIncrementService {
  constructor(
    private readonly database: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

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

  private parse(body: FeeBulkBody) {
    const action = String(body.action || '') as FeeAction;
    const head = String(body.head || '') as FeeHead;
    const mode = String(body.mode || 'amount') as IncrementMode;
    const value = money(body.value);
    const site = String(body.site || '').trim();
    const classCode = String(body.classCode || '').trim();
    const section = String(body.section || '').trim();
    const montDigits = String(body.mont || '').replace(/\D/g, '');
    const mm = Number(montDigits.slice(0, 2));
    const mont = montDigits.length === 6 && mm >= 1 && mm <= 12 ? montDigits : '';
    const description = String(body.description || '').trim().slice(0, 120);

    if (!['increment', 'generate', 'discount'].includes(action)) return { error: 'Unknown action.' };
    if (!/^14(01|02|03)01\d{4}$/.test(site)) return { error: 'Select a campus first.' };
    if (classCode && !/^1301(01|02|03)(\d{4})?$/.test(classCode)) return { error: 'Invalid class.' };
    if (section && !/^130104\d{4}$/.test(section)) return { error: 'Invalid section.' };

    if (action === 'increment') {
      if (!HEADS[head]?.column) return { error: 'Select the fee to change.' };
      if (!['amount', 'percent', 'set', 'discount'].includes(mode)) return { error: 'Select how to change the fee.' };
      if (mode === 'set' ? value < 0 : value <= 0) return { error: 'Enter an amount / percentage.' };
      if ((mode === 'percent' || mode === 'discount') && value > 100) return { error: 'Percentage must be 1–100.' };
    }
    if (action === 'generate') {
      if (!HEADS[head]) return { error: 'Select the fee to generate.' };
      if (!mont) return { error: 'Select the fee month.' };
      if (head === 'fine' && value <= 0) return { error: 'Enter the fine amount.' };
    }
    if (action === 'discount') {
      if (!mont) return { error: 'Select the fee month.' };
      if (mode === 'amount') {
        if (value <= 0) return { error: 'Enter the discount amount.' };
      } else if (value <= 0 || value > 100) {
        return { error: 'Discount % must be 1–100.' };
      }
    }
    return { action, head, mode, value, site, classCode, section, mont, description };
  }

  private nextAmount(current: number, mode: IncrementMode, value: number) {
    let next = current;
    if (mode === 'amount') next = current + value;
    else if (mode === 'percent') next = current + (current * value) / 100;
    else if (mode === 'discount') next = current - (current * value) / 100;
    else next = value;
    return Math.max(0, Math.round(next));
  }

  private async students(site: string, classCode: string, section: string, column: string) {
    const params: unknown[] = [site];
    const where = [`trim(st.ccode) = $1`, `upper(trim(coalesce(st.stat, ''))) = 'ACTIVE'`, `coalesce(trim(st.name), '') <> ''`];
    if (classCode) {
      params.push(classCode);
      where.push(`trim(st.class) = $${params.length}`);
    }
    if (section) {
      params.push(section);
      where.push(`coalesce(nullif(trim(st.sec), ''), trim(st.sect)) = $${params.length}`);
    }
    const res = await this.database.query<{
      sdno: string;
      name: string;
      fatherName: string;
      cls: string;
      className: string;
      sectionName: string;
      fee: string;
    }>(
      `SELECT trim(st.sdno) AS sdno, trim(st.name) AS name, coalesce(trim(st.fname), '') AS "fatherName",
              coalesce(trim(st.class), '') AS cls,
              coalesce(nullif(trim(cl.ahead), ''), trim(st.class)) AS "className",
              coalesce(nullif(trim(se.ahead), ''), coalesce(nullif(trim(st.sec), ''), trim(st.sect)), '') AS "sectionName",
              ${column ? `coalesce(st.${column}, '')` : `''`} AS fee
       FROM student st
       LEFT JOIN acc cl ON cl.acode = st.class
       LEFT JOIN acc se ON se.acode = coalesce(nullif(trim(st.sec), ''), nullif(trim(st.sect), ''))
       WHERE ${where.join(' AND ')}
       ORDER BY trim(st.class), "sectionName", trim(st.name)`,
      params,
    );
    return res.rows;
  }

  async preview(username: string, body: FeeBulkBody) {
    const p = this.parse(body);
    if ('error' in p) return { ok: false, message: p.error, rows: [] as PreviewRow[] };
    const zone = await this.zonePrefix(username);
    if (zone && !p.site.startsWith(zone)) return { ok: false, message: 'This campus is outside your zone.', rows: [] };
    const rows = await this.buildRows(this.database, p);
    return { ok: true, rows };
  }

  private async buildRows(
    db: Runner,
    p: Exclude<ReturnType<FeeIncrementService['parse']>, { error: string }>,
    only?: Set<string>,
  ): Promise<PreviewRow[]> {
    const spec = HEADS[p.action === 'discount' ? 'tuition' : p.head];
    const list = (await this.students(p.site, p.classCode, p.section, spec.column)).filter(
      (s) => !only || only.has(s.sdno),
    );
    const base = (s: (typeof list)[number]) => ({
      sdno: s.sdno,
      name: s.name,
      fatherName: s.fatherName,
      className: s.className,
      sectionName: s.sectionName,
      invno: '',
    });

    if (p.action === 'increment') {
      return list.map((s) => {
        const current = money(s.fee);
        const next = this.nextAmount(current, p.mode, p.value);
        const status: PreviewRow['status'] =
          current <= 0 && p.mode !== 'set' ? 'zero' : next === current ? 'same' : 'ok';
        return { ...base(s), current, next, status };
      });
    }

    const sdnos = list.map((s) => s.sdno);
    if (!sdnos.length) return [];
    const year = p.mont.slice(2);
    const bills = await db.query<{ sdno: string; invno: string; amount: string; paid: boolean; snar: string }>(
      `SELECT trim(m.sdno) AS sdno, trim(m.invno) AS invno,
              coalesce((SELECT sum(${NUM('d', 'dr')}) FROM accdet d WHERE d.invno = m.invno), 0)::text AS amount,
              ${G_PAID_SQL('m')} AS paid,
              coalesce((SELECT max(trim(d.snar)) FROM accdet d WHERE d.invno = m.invno), '') AS snar
       FROM accmast m
       WHERE m.sdno = ANY($1::text[]) AND m.invno LIKE '%G' AND trim(m.u4) = $2
         AND (CASE WHEN $3 = 'year' THEN right(trim(m.mont), 4) = $4 ELSE trim(m.mont) = $5 END)
       ORDER BY m.invno`,
      [sdnos, spec.recv, spec.scope, year, p.mont],
    );
    const bySdno = new Map<string, (typeof bills.rows)[number]>();
    for (const b of bills.rows) if (!bySdno.has(b.sdno)) bySdno.set(b.sdno, b);

    if (p.action === 'generate') {
      return list.map((s) => {
        const amount = p.head === 'fine' ? Math.round(p.value) : Math.round(money(s.fee));
        const bill = bySdno.get(s.sdno);
        const status: PreviewRow['status'] = bill ? 'billed' : amount <= 0 ? 'zero' : 'ok';
        return { ...base(s), invno: bill?.invno || '', current: 0, next: amount, status };
      });
    }

    return list.map((s) => {
      const bill = bySdno.get(s.sdno);
      const current = bill ? Math.round(money(bill.amount)) : 0;
      const cut = p.mode === 'amount' ? p.value : (current * p.value) / 100;
      const next = Math.max(0, Math.round(current - cut));
      let status: PreviewRow['status'] = 'ok';
      if (!bill) status = 'noBill';
      else if (bill.paid) status = 'paid';
      else if (/^Discount (\d+(\.\d+)?%|Rs )/.test(bill.snar)) status = 'discounted';
      else if (current <= 0) status = 'zero';
      return { ...base(s), invno: bill?.invno || '', current, next, status };
    });
  }

  async apply(username: string, body: FeeBulkBody) {
    const p = this.parse(body);
    if ('error' in p) return { ok: false, message: p.error, done: 0 };
    const zone = await this.zonePrefix(username);
    if (zone && !p.site.startsWith(zone)) return { ok: false, message: 'This campus is outside your zone.', done: 0 };
    const picked = new Set(
      (Array.isArray(body.sdnos) ? body.sdnos : []).map((s) => String(s || '').trim()).filter(Boolean),
    );
    if (!picked.size) return { ok: false, message: 'Select at least one student.', done: 0 };
    if (picked.size > 3000) return { ok: false, message: 'Too many students in one run.', done: 0 };

    const spec = HEADS[p.action === 'discount' ? 'tuition' : p.head];
    const user = username.trim() || null;
    let done = 0;
    let total = 0;
    const created: string[] = [];

    try {
      await this.database.withTransaction(async (client) => {
        if (p.action !== 'increment') {
          await client.query(`SELECT pg_advisory_xact_lock(hashtext('accmast_fee_gf_seq'))`);
        }
        const rows = (await this.buildRows(client, p, picked)).filter((r) => r.status === 'ok');

        if (p.action === 'increment') {
          for (const r of rows) {
            await client.query(
              `UPDATE student SET ${spec.column} = $1 WHERE trim(sdno) = $2 AND trim(ccode) = $3`,
              [String(r.next), r.sdno, p.site],
            );
            done += 1;
            total += r.next - r.current;
          }
          return;
        }

        if (p.action === 'discount') {
          const how = p.mode === 'amount' ? `Rs ${p.value}` : `${p.value}%`;
          const note = `Discount ${how}${p.description ? `: ${p.description}` : ''}`.slice(0, 200);
          for (const r of rows) {
            const cut = r.current - r.next;
            if (cut <= 0) continue;
            await client.query(
              `UPDATE accdet SET dr = ((${NUM('accdet', 'dr')}) - $2)::text, snar = $3
               WHERE invno = $1 AND (${NUM('accdet', 'dr')}) > 0`,
              [r.invno, cut, note],
            );
            await client.query(
              `UPDATE accdet SET cr = ((${NUM('accdet', 'cr')}) - $2)::text, snar = $3
               WHERE invno = $1 AND (${NUM('accdet', 'cr')}) > 0`,
              [r.invno, cut, note],
            );
            done += 1;
            total += cut;
          }
          return;
        }

        const seq = await client.query<{ n: string }>(
          `SELECT coalesce(max(left(invno, length(invno) - 1)::bigint), 0)::text AS n
           FROM accmast WHERE invno ~ '^[0-9]+[GF]$'`,
        );
        let nextNo = Number(seq.rows[0]?.n || 0);
        const classes = await client.query<{ sdno: string; cls: string }>(
          `SELECT trim(sdno) AS sdno, coalesce(trim(class), '') AS cls FROM student WHERE trim(sdno) = ANY($1::text[])`,
          [rows.map((r) => r.sdno)],
        );
        const clsOf = new Map(classes.rows.map((c) => [c.sdno, c.cls]));
        const label = `${MONTHS[Number(p.mont.slice(0, 2)) - 1]}-${p.mont.slice(2)}`;
        const year = p.mont.slice(2);
        const nar =
          p.head === 'tuition'
            ? `Tution Fee ${label}`
            : p.head === 'van'
              ? `Van Fee ${label}`
              : p.head === 'annual'
                ? `Annual Fund ${year}`
                : p.head === 'summer'
                  ? `Summer Pack ${year}`
                  : `Fine ${p.mont}${p.description ? ` ${p.description}` : ''}`.slice(0, 100);
        const issue = new Date();
        const ymd = `${issue.getFullYear()}-${String(issue.getMonth() + 1).padStart(2, '0')}-${String(issue.getDate()).padStart(2, '0')}`;
        const dueDate = new Date(`${ymd}T00:00:00Z`);
        dueDate.setUTCDate(dueDate.getUTCDate() + 10);
        const due = dueDate.toISOString().slice(0, 10);

        for (const r of rows) {
          nextNo += 1;
          const invno = `${String(nextNo).padStart(6, '0')}G`;
          await client.query(
            `INSERT INTO accmast
               (invno, invdate, nar, ccode, pflag, edate, uname, tflag, u4, sdno, mont, aclas, dudate)
             VALUES ($1, $2, $3, $4, 'P', $2, $5, '1', $6, $7, $8, $9, $10)`,
            [invno, `${ymd} 00:00:00`, nar, p.site, user, spec.recv, r.sdno, p.mont, clsOf.get(r.sdno) || null, `${due} 00:00:00`],
          );
          await client.query(
            `INSERT INTO accdet (invno, acode, dr, cr) VALUES ($1, $2, $3, '0'), ($1, $4, '0', $3)`,
            [invno, spec.recv, String(r.next), spec.income],
          );
          created.push(invno);
          done += 1;
          total += r.next;
        }
      });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Fee update failed.', done: 0 };
    }

    if (!done) return { ok: false, message: 'Nothing to update for the selected students.', done: 0 };

    const what =
      p.action === 'increment'
        ? `${spec.label} increment (${p.mode} ${p.value})`
        : p.action === 'discount'
          ? `Tuition discount ${p.mode === 'amount' ? `Rs ${p.value}` : `${p.value}%`} ${p.mont}`
          : `${spec.label} generation ${p.mont}`;
    await this.activityLog.write({
      category: 'activity',
      username: username || 'Unknown',
      activity: p.action === 'generate' ? 'Fee Challan Generated' : 'Fee Updated',
      description: `${what}: ${done} student(s), total ${total}`,
      module: 'Fee Increment',
      campus: '',
      campusCode: p.site,
      status: 'Success',
      meta: {
        action: p.action,
        head: p.head,
        mode: p.mode,
        value: p.value,
        mont: p.mont,
        classCode: p.classCode,
        section: p.section,
        done,
        total,
        created: created.slice(0, 50),
      },
    });

    const message =
      p.action === 'increment'
        ? `${spec.label} updated for ${done} student(s).`
        : p.action === 'discount'
          ? `Discount applied on ${done} tuition bill(s) (total ${total}).`
          : `${done} ${spec.label} voucher(s) generated (total ${total}).`;
    return { ok: true, message, done, total, created: created.length };
  }
}
