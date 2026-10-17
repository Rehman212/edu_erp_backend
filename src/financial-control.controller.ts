import { Body, Controller, Delete, Get, Headers, Post, Query } from '@nestjs/common';
import { FinancialControlService } from './financial-control.service';

function colFiltersFrom(all?: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all || {})) {
    if (k.startsWith('f_') && typeof v === 'string' && v.trim()) out[k.slice(2)] = v;
  }
  return out;
}

@Controller('financial-control')
export class FinancialControlController {
  constructor(private readonly finance: FinancialControlService) {}

  @Get('sites')
  sites(@Headers('x-ess-user') user?: string) {
    return this.finance.sites(user ?? '');
  }

  @Get('accounts')
  accounts(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('scope') scope?: string,
  ) {
    return this.finance.accounts(q ?? '', Number(limit) || 80, scope ?? '');
  }

  @Get('trial-balance')
  trialBalance(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('q') q?: string,
  ) {
    return this.finance.trialBalance(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      q ?? '',
    );
  }

  @Get('ledger')
  ledger(
    @Headers('x-ess-user') user: string | undefined,
    @Query('acode') acode?: string,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.finance.ledger(
      user ?? '',
      acode ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      colFiltersFrom(all),
    );
  }

  @Get('cash-book')
  cashBook(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('account') account?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.finance.cashBook(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      account ?? '150601',
      Number(page) || 1,
      Number(pageSize) || 50,
      colFiltersFrom(all),
    );
  }

  @Get('bank-summary')
  bankSummary(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.finance.bankSummary(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
    );
  }

  @Get('ledger-sitewise')
  ledgerSitewise(
    @Headers('x-ess-user') user: string | undefined,
    @Query('acode') acode?: string,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.finance.ledgerSitewise(
      user ?? '',
      acode ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
    );
  }

  @Get('main-sub-ledger')
  mainSubLedger(
    @Headers('x-ess-user') user: string | undefined,
    @Query('acode') acode?: string,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.finance.mainSubLedger(
      user ?? '',
      acode ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
    );
  }

  @Get('site-summary')
  siteSummary(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.finance.siteSummary(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
    );
  }

  @Get('subsidiary-list')
  subsidiaryList(
    @Headers('x-ess-user') user: string | undefined,
    @Query('acode') acode?: string,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.finance.subsidiaryList(
      user ?? '',
      acode ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
    );
  }

  @Get('fee-collection')
  feeCollection(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('montFrom') montFrom?: string,
    @Query('montTo') montTo?: string,
    @Query('mont') mont?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.finance.feeCollection(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      montFrom || mont || '',
      montTo || '',
      Number(page) || 1,
      Number(pageSize) || 50,
      status ?? 'ALL',
      colFiltersFrom(all),
      all?.q ?? '',
    );
  }

  @Get('defaulters')
  defaulters(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('montFrom') montFrom?: string,
    @Query('montTo') montTo?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.finance.defaulters(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      status ?? 'ALL',
      montFrom ?? '',
      montTo ?? '',
      colFiltersFrom(all),
    );
  }

  @Get('fee-register')
  feeRegister(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('montFrom') montFrom?: string,
    @Query('montTo') montTo?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.finance.feeRegister(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      status ?? 'ALL',
      montFrom ?? '',
      montTo ?? '',
      colFiltersFrom(all),
      all?.q ?? '',
    );
  }

  @Get('defaulters-wo')
  defaultersWo(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('montTo') montTo?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.finance.defaultersWo(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      montTo ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      status ?? 'ALL',
    );
  }

  @Get('defaulters-banks')
  defaultersToBanks(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('montFrom') montFrom?: string,
    @Query('montTo') montTo?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.finance.defaultersToBanks(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      status ?? 'ALL',
      montFrom ?? '',
      montTo ?? '',
      colFiltersFrom(all),
    );
  }

  @Get('search')
  search(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('narration') narration?: string,
    @Query('value') value?: string,
    @Query('acode') acode?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.finance.searchEntries(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      narration ?? '',
      value ?? '',
      acode ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      colFiltersFrom(all),
    );
  }

  @Get('voucher')
  voucher(
    @Headers('x-ess-user') user: string | undefined,
    @Query('invno') invno?: string,
  ) {
    return this.finance.voucher(user ?? '', invno ?? '');
  }

  @Post('voucher')
  updateVoucher(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: {
      invno?: string;
      invdate?: string;
      mont?: string;
      ccode?: string;
      nar?: string;
      lines?: Array<{
        accountCode?: string;
        debit?: number | string;
        credit?: number | string;
        narration?: string;
      }>;
    },
  ) {
    return this.finance.updateVoucher(user ?? '', body ?? {});
  }

  @Get('student-challans')
  studentChallans(
    @Headers('x-ess-user') user: string | undefined,
    @Query('q') q?: string,
    @Query('only') only?: string,
  ) {
    return this.finance.studentChallans(user ?? '', q ?? '', only ?? '');
  }

  @Post('generate-challans')
  generateChallans(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { sdno?: string; mont?: string },
  ) {
    return this.finance.generateChallans(user ?? '', body?.sdno ?? '', body?.mont ?? '');
  }

  @Get('student-dues')
  studentDues(@Query('sdnos') sdnos?: string) {
    return this.finance.studentDues(sdnos ?? '');
  }

  @Post('receive-payment')
  receivePayment(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: {
      payDate?: string;
      bankCode?: string;
      balanceMode?: string;
      lines?: Array<{ invno?: string; received?: number | string }>;
    },
  ) {
    return this.finance.receivePayment(user ?? '', body ?? {});
  }

  @Post('reverse-payment')
  reversePayment(@Headers('x-ess-user') user: string | undefined, @Body() body: { invno?: string }) {
    return this.finance.reversePayment(user ?? '', body?.invno ?? '');
  }

  @Delete('voucher')
  deleteVoucher(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { invno?: string },
  ) {
    return this.finance.deleteVoucher(user ?? '', body?.invno ?? '');
  }
}
