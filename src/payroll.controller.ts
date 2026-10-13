import { Body, Controller, Delete, Get, Headers, Param, Post, Put, Query } from '@nestjs/common';
import { PayrollService } from './payroll.service';

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
  ) {
    return this.payroll.employeeLedger(
      user ?? '',
      site ?? '',
      employee ?? '',
      fromDate ?? '',
      toDate ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
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
  ) {
    return this.payroll.employeeBonus(
      user ?? '',
      site ?? '',
      employee ?? '',
      empType ?? '',
      designation ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
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
  ) {
    return this.payroll.earnLeave(
      user ?? '',
      site ?? '',
      employee ?? '',
      empType ?? '',
      designation ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      q ?? '',
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
  ) {
    return this.payroll.monthlySalarySheet(
      user ?? '',
      site ?? '',
      mont ?? '',
      empType ?? '',
      designation ?? '',
      paymentMode ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      fromDate ?? '',
      toDate ?? '',
      employee ?? '',
      q ?? '',
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
  ) {
    return this.payroll.salarySummary(
      user ?? '',
      site ?? '',
      mont ?? '',
      empType ?? '',
      designation ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      fromDate ?? '',
      toDate ?? '',
      employee ?? '',
      q ?? '',
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
  ) {
    return this.payroll.attendanceRegister(
      user ?? '',
      site ?? '',
      mont ?? '',
      empType ?? '',
      designation ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      fromDate ?? '',
      toDate ?? '',
      employee ?? '',
      q ?? '',
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
  ) {
    return this.payroll.missingNewcomers(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      empType ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
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
  ) {
    return this.payroll.monthlySalaryPack(
      user ?? '',
      site ?? '',
      mont ?? '',
      empType ?? '',
      designation ?? '',
      paymentMode ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      fromDate ?? '',
      toDate ?? '',
      employee ?? '',
      q ?? '',
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
  ) {
    return this.payroll.zonalSalarySummary(
      user ?? '',
      site ?? '',
      mont ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      fromDate ?? '',
      toDate ?? '',
      employee ?? '',
      q ?? '',
    );
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
}
