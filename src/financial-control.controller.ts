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

  /** ESS voucher Site Code LOV (Ahead / Acode) — same rows & order as Payment Voucher. */
  @Get('voucher-sites')
  voucherSites(@Headers('x-ess-user') user?: string) {
    return this.finance.voucherSites(user ?? '');
  }

  @Get('accounts')
  accounts(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('scope') scope?: string,
  ) {
    return this.finance.accounts(q ?? '', Number(limit) || 80, scope ?? '');
  }

  @Get('final-accounts')
  finalAccounts(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.finance.finalAccounts(user ?? '', site ?? '', fromDate ?? '', toDate ?? '');
  }

  @Get('trial-balance')
  trialBalance(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('q') q?: string,
    @Query('acode') acode?: string,
  ) {
    return this.finance.trialBalance(
      user ?? '',
      site ?? '',
      fromDate ?? '',
      toDate ?? '',
      q ?? '',
      acode ?? '',
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
      all?.sort ?? '',
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
      all?.sort ?? '',
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
    @Query('site') site?: string,
  ) {
    return this.finance.studentChallans(user ?? '', q ?? '', only ?? '', site ?? '');
  }

  @Post('student-challans-batch')
  studentChallansBatch(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { items?: Array<{ sdno?: string; invno?: string }> },
  ) {
    return this.finance.studentChallansBatch(user ?? '', body?.items ?? []);
  }

  @Post('generate-challans')
  generateChallans(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: { sdno?: string; mont?: string; dueDate?: string; heads?: string[]; fine?: number },
  ) {
    return this.finance.generateChallans(
      user ?? '',
      body?.sdno ?? '',
      body?.mont ?? '',
      body?.dueDate ?? '',
      body?.heads ?? [],
      body?.fine ?? 0,
    );
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

  @Post('reverse-payments')
  reversePayments(@Headers('x-ess-user') user: string | undefined, @Body() body: { invnos?: string[] }) {
    return this.finance.reversePayments(user ?? '', body?.invnos);
  }

  @Post('delete-challans')
  deleteChallans(@Headers('x-ess-user') user: string | undefined, @Body() body: { invnos?: string[] }) {
    return this.finance.deleteChallans(user ?? '', body?.invnos);
  }

  @Get('student-ledger')
  studentLedger(
    @Headers('x-ess-user') user: string | undefined,
    @Query('q') q?: string,
    @Query('site') site?: string,
  ) {
    return this.finance.studentLedger(user ?? '', q ?? '', site ?? '');
  }

  @Delete('voucher')
  deleteVoucher(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { invno?: string },
  ) {
    return this.finance.deleteVoucher(user ?? '', body?.invno ?? '');
  }

  /** Accounts vouchers: RV cash receipt, PV payment, JV journal, BP/BR bank. */
  @Get('accounts-vouchers')
  accountsVouchers(
    @Headers('x-ess-user') user: string | undefined,
    @Query('suffix') suffix?: string,
    @Query('site') site?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.finance.accountsVouchers(
      user ?? '',
      suffix ?? 'RV',
      Number(page) || 1,
      Number(pageSize) || 50,
      site ?? '',
      q ?? '',
      fromDate ?? '',
      toDate ?? '',
    );
  }

  @Get('accounts-next-invoice')
  accountsNextInvoice(@Query('suffix') suffix?: string) {
    return this.finance.accountsNextInvoice(suffix ?? 'RV');
  }

  @Get('accounts-voucher')
  accountsVoucherDetail(
    @Headers('x-ess-user') user: string | undefined,
    @Query('invno') invno?: string,
  ) {
    return this.finance.accountsVoucherDetail(user ?? '', invno ?? '');
  }

  @Post('accounts-voucher')
  saveAccountsVoucher(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: {
      invno?: string;
      invdate?: string;
      ccode?: string;
      nar?: string;
      pday?: string;
      lines?: Array<{
        code?: string;
        accountHead?: string;
        subNarration?: string;
        debit?: number | string;
        credit?: number | string;
      }>;
    },
  ) {
    return this.finance.saveAccountsVoucher(user ?? '', body ?? {});
  }

  @Delete('accounts-voucher')
  deleteAccountsVoucher(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { invno?: string },
  ) {
    return this.finance.deleteAccountsVoucher(user ?? '', body?.invno ?? '');
  }
}
