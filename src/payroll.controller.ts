import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PayrollService } from './payroll.service';

function colFiltersFrom(all?: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all || {})) {
    if (k.startsWith('f_') && typeof v === 'string' && v.trim()) out[k.slice(2)] = v;
  }
  return out;
}

const sumOf = (key: string) => (rows: Record<string, unknown>[]) =>
  rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);

@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('sites')
  sites(@Headers('x-ess-user') user?: string) {
    return this.payroll.sites(user ?? '');
  }

  @Get('employees')
  employees(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.payroll.employees(
      user ?? '',
      site ?? '',
      q ?? '',
      Number(limit) || 5000,
    );
  }

  @Get('lookups')
  lookups(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
  ) {
    return this.payroll.lookups(user ?? '', site ?? '');
  }

  @Get('employee-ledger')
  employeeLedger(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('employee') employee?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.payroll.withColumnFilters(
      colFiltersFrom(all),
      Number(page) || 1,
      Number(pageSize) || 50,
      (p, s) =>
        this.payroll.employeeLedger(user ?? '', site ?? '', employee ?? '', fromDate ?? '', toDate ?? '', p, s),
      sumOf('credit'),
    );
  }

  @Get('employee-bonus')
  employeeBonus(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('employee') employee?: string,
    @Query('empType') empType?: string,
    @Query('designation') designation?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.payroll.withColumnFilters(
      colFiltersFrom(all),
      Number(page) || 1,
      Number(pageSize) || 50,
      (p, s) =>
        this.payroll.employeeBonus(user ?? '', site ?? '', employee ?? '', empType ?? '', designation ?? '', p, s),
      sumOf('amount'),
    );
  }

  @Get('earn-leave')
  earnLeave(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('employee') employee?: string,
    @Query('empType') empType?: string,
    @Query('designation') designation?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.payroll.withColumnFilters(
      colFiltersFrom(all),
      Number(page) || 1,
      Number(pageSize) || 50,
      (p, s) =>
        this.payroll.earnLeave(user ?? '', site ?? '', employee ?? '', empType ?? '', designation ?? '', p, s, q ?? ''),
      sumOf('leaveDays'),
    );
  }

  @Get('salary-sheet')
  salarySheet(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('mont') mont?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('empType') empType?: string,
    @Query('designation') designation?: string,
    @Query('paymentMode') paymentMode?: string,
    @Query('employee') employee?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.payroll.withColumnFilters(
      colFiltersFrom(all),
      Number(page) || 1,
      Number(pageSize) || 50,
      (p, s) =>
        this.payroll.monthlySalarySheet(
          user ?? '',
          site ?? '',
          mont ?? '',
          empType ?? '',
          designation ?? '',
          paymentMode ?? '',
          p,
          s,
          fromDate ?? '',
          toDate ?? '',
          employee ?? '',
          q ?? '',
        ),
      sumOf('net'),
    );
  }

  @Get('salary-summary')
  salarySummary(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('mont') mont?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('empType') empType?: string,
    @Query('designation') designation?: string,
    @Query('employee') employee?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.payroll.withColumnFilters(
      colFiltersFrom(all),
      Number(page) || 1,
      Number(pageSize) || 50,
      (p, s) =>
        this.payroll.salarySummary(
          user ?? '',
          site ?? '',
          mont ?? '',
          empType ?? '',
          designation ?? '',
          p,
          s,
          fromDate ?? '',
          toDate ?? '',
          employee ?? '',
          q ?? '',
        ),
      sumOf('net'),
    );
  }

  @Get('attendance')
  attendance(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('mont') mont?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('empType') empType?: string,
    @Query('designation') designation?: string,
    @Query('employee') employee?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.payroll.withColumnFilters(
      colFiltersFrom(all),
      Number(page) || 1,
      Number(pageSize) || 50,
      (p, s) =>
        this.payroll.attendanceRegister(
          user ?? '',
          site ?? '',
          mont ?? '',
          empType ?? '',
          designation ?? '',
          p,
          s,
          fromDate ?? '',
          toDate ?? '',
          employee ?? '',
          q ?? '',
        ),
      sumOf('present'),
    );
  }

  @Get('missing-newcomers')
  missingNewcomers(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('empType') empType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.payroll.withColumnFilters(
      colFiltersFrom(all),
      Number(page) || 1,
      Number(pageSize) || 50,
      (p, s) =>
        this.payroll.missingNewcomers(user ?? '', site ?? '', fromDate ?? '', toDate ?? '', empType ?? '', p, s),
      (rows) => rows.length,
    );
  }

  @Get('salary-pack')
  salaryPack(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('mont') mont?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('empType') empType?: string,
    @Query('designation') designation?: string,
    @Query('paymentMode') paymentMode?: string,
    @Query('employee') employee?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.payroll.withColumnFilters(
      colFiltersFrom(all),
      Number(page) || 1,
      Number(pageSize) || 50,
      (p, s) =>
        this.payroll.monthlySalaryPack(
          user ?? '',
          site ?? '',
          mont ?? '',
          empType ?? '',
          designation ?? '',
          paymentMode ?? '',
          p,
          s,
          fromDate ?? '',
          toDate ?? '',
          employee ?? '',
          q ?? '',
        ),
      sumOf('net'),
    );
  }

  @Get('zonal-summary')
  zonalSummary(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('mont') mont?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('employee') employee?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.payroll.withColumnFilters(
      colFiltersFrom(all),
      Number(page) || 1,
      Number(pageSize) || 50,
      (p, s) =>
        this.payroll.zonalSalarySummary(
          user ?? '',
          site ?? '',
          mont ?? '',
          p,
          s,
          fromDate ?? '',
          toDate ?? '',
          employee ?? '',
          q ?? '',
        ),
      sumOf('net'),
    );
  }

  @Get('salary-generate')
  salaryGenerateDraft(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('mont') mont?: string,
  ) {
    return this.payroll.salaryGenerateDraft(user ?? '', site ?? '', mont ?? '');
  }

  @Post('salary-generate')
  salaryGeneratePost(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: {
      mont?: string;
      site?: string;
      rows?: { code?: string; absent?: number; leave?: number; security?: number; transport?: number }[];
    },
  ) {
    return this.payroll.salaryGeneratePost(user ?? '', body || {});
  }

  @Get('next-employee-code')
  nextEmployeeCode(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
  ) {
    return this.payroll.nextEmployeeCode(user ?? '', site ?? '');
  }

  @Get('employee/:code')
  getEmployee(
    @Headers('x-ess-user') user: string | undefined,
    @Param('code') code: string,
  ) {
    return this.payroll.getEmployee(user ?? '', code ?? '');
  }

  @Post('employees')
  createEmployee(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: {
      code?: string;
      name?: string;
      fatherName?: string;
      designation?: string;
      siteCode?: string;
      empType?: string;
      gender?: string;
      paymentMode?: string;
      bank?: string;
      phone?: string;
      salary?: number | string;
      joinDate?: string;
      dob?: string;
      address?: string;
      cnic?: string;
      qualification?: string;
      photo?: string;
    },
  ) {
    return this.payroll.createEmployee(user ?? '', body || {});
  }

  @Put('employees/:code')
  updateEmployee(
    @Headers('x-ess-user') user: string | undefined,
    @Param('code') code: string,
    @Body()
    body: {
      name?: string;
      fatherName?: string;
      designation?: string;
      siteCode?: string;
      empType?: string;
      gender?: string;
      paymentMode?: string;
      bank?: string;
      phone?: string;
      salary?: number | string;
      joinDate?: string;
      dob?: string;
      address?: string;
      cnic?: string;
      qualification?: string;
      photo?: string;
    },
  ) {
    return this.payroll.updateEmployee(user ?? '', code ?? '', body || {});
  }

  @Delete('employees/:code')
  deleteEmployee(
    @Headers('x-ess-user') user: string | undefined,
    @Param('code') code: string,
  ) {
    return this.payroll.deleteEmployee(user ?? '', code ?? '');
  }

  @Patch('employees/:code/active')
  setEmployeeActive(
    @Headers('x-ess-user') user: string | undefined,
    @Param('code') code: string,
    @Body() body: { active?: boolean },
  ) {
    return this.payroll.setEmployeeActive(
      user ?? '',
      code ?? '',
      body?.active === true,
    );
  }
}
