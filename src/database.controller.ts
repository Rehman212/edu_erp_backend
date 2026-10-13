import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Controller('db')
export class DatabaseController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  async health() {
    const info = await this.database.query<{
      database: string;
      tables: string;
    }>(
      `SELECT current_database() AS database,
              (SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public') AS tables`,
    );
    return {
      connected: true,
      database: info.rows[0].database,
      tables: Number(info.rows[0].tables),
    };
  }
}
