import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { assertRoleAccess } from './role-access';

const FLAGS = ['view', 'add', 'edit', 'delete', 'voucher'] as const;
type Flag = (typeof FLAGS)[number];
type Rights = Record<Flag, boolean>;

/** Only the actions that screen actually has. Activity Log is view-only. */
const NODE_FLAGS: Record<string, readonly Flag[]> = {
  dashboard: ['view'],
  'registration.students': ['view', 'add', 'edit', 'delete', 'voucher'],
  classChange: ['view', 'edit'],
  inventoryControl: ['view', 'add', 'edit', 'delete'],
  inventoryVoucher: ['view', 'add', 'edit', 'delete', 'voucher'],
  transaction: ['view', 'add', 'edit', 'delete', 'voucher'],
  financialControl: ['view'],
  finalAccount: ['view'],
  feeControl: ['view', 'edit', 'delete', 'voucher'],
  feeIncrement: ['view', 'add', 'edit', 'delete', 'voucher'],
  payrollReport: ['view', 'add', 'edit', 'delete', 'voucher'],
  resultAnalysis: ['view', 'add', 'edit', 'delete'],
  history: ['view'],
  campusSetup: ['view', 'add', 'edit', 'delete'],
  users: ['view', 'add', 'edit', 'delete'],
  userRoles: ['view', 'add', 'edit', 'delete'],
  authLogs: ['view'],
};

function emptyRights(): Rights {
  return { view: false, add: false, edit: false, delete: false, voucher: false };
}

function cleanRights(raw: unknown): Record<string, Rights> {
  const out: Record<string, Rights> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const allowed = NODE_FLAGS[id];
    if (!allowed || !value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const next = emptyRights();
    for (const flag of allowed) next[flag] = row[flag] === true;
    out[id] = next;
  }
  return out;
}

@Injectable()
export class UserRolesService {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly database: DatabaseService) {}

  private ensureSchema() {
    if (!this.schemaReady) {
      this.schemaReady = this.database
        .query(
          `CREATE TABLE IF NOT EXISTS erp_role (
             id text PRIMARY KEY,
             name text NOT NULL,
             rights jsonb NOT NULL DEFAULT '{}'::jsonb,
             updated_at timestamptz NOT NULL DEFAULT now()
           )`,
        )
        .then(() =>
          this.database.query(
            `UPDATE erp_role SET rights = rights - 'registration.employees'
             WHERE rights ? 'registration.employees'`,
          ),
        )
        .then(() => undefined)
        .catch((err) => {
          this.schemaReady = null;
          throw err;
        });
    }
    return this.schemaReady;
  }

  async list() {
    await this.ensureSchema();
    const result = await this.database.query<{
      id: string;
      name: string;
      rights: Record<string, Rights>;
      updated_at: Date;
    }>(
      `SELECT id, name, rights, updated_at
       FROM erp_role
       ORDER BY lower(name), id`,
    );
    return {
      rows: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        rights: cleanRights(row.rights),
        updatedAt: row.updated_at,
      })),
    };
  }

  async create(username: string, body: { name?: string; rights?: unknown }) {
    await assertRoleAccess(this.database, username, 'userRoles', 'add');
    await this.ensureSchema();
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (!name) throw new BadRequestException('Role name is required');
    const id = `role_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const rights = cleanRights(body.rights);
    const result = await this.database.query<{
      id: string;
      name: string;
      rights: Record<string, Rights>;
      updated_at: Date;
    }>(
      `INSERT INTO erp_role (id, name, rights)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, name, rights, updated_at`,
      [id, name, JSON.stringify(rights)],
    );
    const row = result.rows[0];
    return {
      ok: true,
      role: {
        id: row.id,
        name: row.name,
        rights: cleanRights(row.rights),
        updatedAt: row.updated_at,
      },
    };
  }

  async update(username: string, id: string, body: { name?: string; rights?: unknown }) {
    await assertRoleAccess(this.database, username, 'userRoles', 'edit');
    await this.ensureSchema();
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (!name) throw new BadRequestException('Role name is required');
    const rights = cleanRights(body.rights);
    const result = await this.database.query<{
      id: string;
      name: string;
      rights: Record<string, Rights>;
      updated_at: Date;
    }>(
      `UPDATE erp_role
       SET name = $2, rights = $3::jsonb, updated_at = now()
       WHERE id = $1
       RETURNING id, name, rights, updated_at`,
      [id, name, JSON.stringify(rights)],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Role not found');
    return {
      ok: true,
      role: {
        id: row.id,
        name: row.name,
        rights: cleanRights(row.rights),
        updatedAt: row.updated_at,
      },
    };
  }

  async remove(username: string, id: string) {
    await assertRoleAccess(this.database, username, 'userRoles', 'delete');
    await this.ensureSchema();
    const result = await this.database.query(`DELETE FROM erp_role WHERE id = $1`, [id]);
    if (!result.rowCount) throw new NotFoundException('Role not found');
    return { ok: true };
  }
}
