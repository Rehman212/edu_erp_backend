import { ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ActivityLogService } from './activity-log.service';
import { DatabaseService } from './database.service';

export const BRANDING_KEYS = ['logo', 'favicon', 'pageLoader', 'sidebarIcon', 'loginBg'] as const;
export type BrandingKey = (typeof BRANDING_KEYS)[number];

const BRANDING_LABELS: Record<BrandingKey, string> = {
  logo: 'Logo',
  favicon: 'Fav icon',
  pageLoader: 'Page loader',
  sidebarIcon: 'Sidebar collapsed icon',
  loginBg: 'Login page image',
};

/** SVG is excluded: it is served from the API origin and could carry script. */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

const MAX_BYTES = 8 * 1024 * 1024;

type BrandingRow = {
  key: string;
  file_name: string | null;
  updated_at: string | null;
  updated_by: string | null;
  has_data: boolean;
  has_prev: boolean;
  prev_file_name: string | null;
};

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async onModuleInit() {
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS app_branding (
         key text PRIMARY KEY,
         mime text,
         data bytea,
         file_name text,
         updated_at timestamptz,
         updated_by text,
         prev_mime text,
         prev_data bytea,
         prev_file_name text
       )`,
    );
  }

  isKey(raw: string): raw is BrandingKey {
    return (BRANDING_KEYS as readonly string[]).includes(raw);
  }

  /** Same rule the login uses to grant the Admin role. */
  private async isAdmin(username: string) {
    const name = String(username || '').trim();
    if (!name) return false;
    await this.database.query(`ALTER TABLE puser ADD COLUMN IF NOT EXISTS acct text`);
    const user = await this.database.query<{ tname: string; acct: string | null }>(
      `SELECT trim(tname) AS tname, trim(acct) AS acct
       FROM puser WHERE upper(trim(tname)) = upper($1) LIMIT 1`,
      [name],
    );
    const row = user.rows[0];
    if (!row?.tname) return false;
    return String(row.acct || '').toLowerCase() === 'admin';
  }

  private async requireAdmin(username: string) {
    if (!(await this.isAdmin(username))) {
      throw new ForbiddenException('Only admin can change system settings.');
    }
  }

  async branding() {
    const res = await this.database.query<BrandingRow>(
      `SELECT key, file_name, updated_at::text AS updated_at, updated_by,
              data IS NOT NULL AS has_data,
              prev_data IS NOT NULL AS has_prev,
              prev_file_name
       FROM app_branding`,
    );
    const byKey = new Map(res.rows.map((r) => [r.key, r]));
    return BRANDING_KEYS.map((key) => {
      const r = byKey.get(key);
      const custom = Boolean(r?.has_data);
      return {
        key,
        label: BRANDING_LABELS[key],
        custom,
        fileName: custom ? r?.file_name || '' : '',
        updatedAt: r?.updated_at || '',
        updatedBy: r?.updated_by || '',
        version: r?.updated_at ? new Date(r.updated_at).getTime() : 0,
        canRevert: custom,
        revertTo: custom ? (r?.has_prev ? r?.prev_file_name || 'previous image' : 'default') : '',
      };
    });
  }

  async image(key: BrandingKey) {
    const res = await this.database.query<{ mime: string; data: Buffer }>(
      `SELECT mime, data FROM app_branding WHERE key = $1 AND data IS NOT NULL`,
      [key],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundException('No custom image.');
    return row;
  }

  async save(username: string, key: BrandingKey, body: { dataUrl?: string; fileName?: string }) {
    await this.requireAdmin(username);
    const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(body.dataUrl || ''));
    if (!match) return { ok: false, message: 'Select an image file.' };
    const mime = match[1].toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      return { ok: false, message: 'Use a PNG, JPG, WEBP, GIF or ICO image.' };
    }
    const data = Buffer.from(match[2], 'base64');
    if (!data.length) return { ok: false, message: 'Image is empty.' };
    if (data.length > MAX_BYTES) return { ok: false, message: 'Image must be under 8 MB.' };
    const fileName = String(body.fileName || '').trim().slice(0, 200) || `${key}`;
    const user = String(username || '').trim();

    await this.database.query(
      `INSERT INTO app_branding (key, mime, data, file_name, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (key) DO UPDATE SET
         prev_mime = app_branding.mime,
         prev_data = app_branding.data,
         prev_file_name = app_branding.file_name,
         mime = EXCLUDED.mime,
         data = EXCLUDED.data,
         file_name = EXCLUDED.file_name,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [key, mime, data, fileName, user],
    );
    await this.activityLog.write({
      username: user,
      role: 'Admin',
      activity: 'Settings Updated',
      description: `${BRANDING_LABELS[key]} changed to ${fileName}`,
      module: 'Settings',
      meta: { key, fileName, bytes: data.length },
    });
    return { ok: true, message: `${BRANDING_LABELS[key]} updated.` };
  }

  async revert(username: string, key: BrandingKey) {
    await this.requireAdmin(username);
    const user = String(username || '').trim();
    const res = await this.database.query<{ prev_file_name: string | null; had_prev: boolean }>(
      `UPDATE app_branding SET
         mime = prev_mime,
         data = prev_data,
         file_name = prev_file_name,
         prev_mime = NULL,
         prev_data = NULL,
         prev_file_name = NULL,
         updated_at = now(),
         updated_by = $2
       WHERE key = $1 AND data IS NOT NULL
       RETURNING file_name AS prev_file_name, data IS NOT NULL AS had_prev`,
      [key, user],
    );
    const row = res.rows[0];
    if (!row) return { ok: false, message: `${BRANDING_LABELS[key]} is already the default.` };
    const restored = row.had_prev ? row.prev_file_name || 'previous image' : 'default image';
    await this.activityLog.write({
      username: user,
      role: 'Admin',
      activity: 'Settings Reverted',
      description: `${BRANDING_LABELS[key]} reverted to ${restored}`,
      module: 'Settings',
      meta: { key },
    });
    return { ok: true, message: `${BRANDING_LABELS[key]} reverted to ${restored}.` };
  }
}
