import { Body, Controller, Get, Headers, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ActivityLogService } from './activity-log.service';

function clientIp(req: Request) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim() || '';
  }
  return req.socket?.remoteAddress || '';
}

@Controller('activity-log')
export class ActivityLogController {
  constructor(private readonly logs: ActivityLogService) {}

  /** Client / UI actions (Excel, PDF, print, etc.). Auth events stay on /auth/*. */
  @Post()
  create(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: {
      username?: string;
      role?: string;
      activity?: string;
      description?: string;
      module?: string;
      campus?: string;
      campusCode?: string;
      status?: 'Success' | 'Failed';
      meta?: Record<string, unknown>;
    },
    @Req() req: Request,
  ) {
    return this.logs.write({
      category: 'activity',
      username: user || body.username || '',
      role: body.role || '',
      activity: body.activity || 'Event',
      description: body.description || '',
      module: body.module || '',
      campus: body.campus || '',
      campusCode: body.campusCode || '',
      status: body.status === 'Failed' ? 'Failed' : 'Success',
      ipAddress: clientIp(req),
      meta: body.meta,
    });
  }

  /** General ERP activity (excludes login/logout). */
  @Get()
  list(
    @Headers('x-ess-user') _user: string | undefined,
    @Query('q') q?: string,
    @Query('user') user?: string,
    @Query('activity') activity?: string,
    @Query('module') module?: string,
    @Query('status') status?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.logs.list({
      category: 'activity',
      q,
      user,
      activity,
      module,
      status,
      fromDate,
      toDate,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
    });
  }

  @Get('options')
  options() {
    return this.logs.filterOptions('activity');
  }

  /** Login / logout only. */
  @Get('auth')
  authList(
    @Query('q') q?: string,
    @Query('user') user?: string,
    @Query('activity') activity?: string,
    @Query('status') status?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.logs.list({
      category: 'auth',
      q,
      user,
      activity,
      status,
      fromDate,
      toDate,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
    });
  }

  @Get('auth/options')
  authOptions() {
    return this.logs.filterOptions('auth');
  }
}
