import { Controller, Get, Headers, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Zone/campus-scoped home dashboard (KPIs + charts + recent activity). */
  @Get('summary')
  summary(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
  ) {
    return this.dashboard.summary(user ?? '', site ?? '');
  }
}
