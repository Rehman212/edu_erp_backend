import { Body, Controller, Delete, Get, Headers, Post, Query } from '@nestjs/common';
import { InventoryControlService, type StockReportMode } from './inventory-control.service';

function colFiltersFrom(all?: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all || {})) {
    if (k.startsWith('f_') && typeof v === 'string' && v.trim()) out[k.slice(2)] = v;
  }
  return out;
}

@Controller('inventory-control')
export class InventoryControlController {
  constructor(private readonly inventory: InventoryControlService) {}

  @Get('sites')
  sites(@Headers('x-ess-user') user?: string) {
    return this.inventory.sites(user ?? '');
  }

  @Get('categories')
  categories(@Query('q') q?: string) {
    return this.inventory.categories(q ?? '');
  }

  @Get('items')
  items(@Query('category') category?: string, @Query('q') q?: string) {
    return this.inventory.items(category ?? '', q ?? '');
  }

  @Get('stock')
  stock(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('category') category?: string,
    @Query('q') q?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('mode') mode?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sort') sort?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.inventory.stockReport(
      user ?? '',
      site ?? '',
      category ?? '',
      q ?? '',
      fromDate ?? '',
      toDate ?? '',
      (mode?.trim() || 'full') as StockReportMode,
      Number(page) || 1,
      Number(pageSize) || 50,
      sort?.trim() || 'desc',
      colFiltersFrom(all),
    );
  }

  /** Distinct Category / Location / Unit values for the stock table dropdown filters. */
  @Get('stock/filter-options')
  stockFilterOptions(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('category') category?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.inventory.stockReport(
      user ?? '',
      site ?? '',
      category ?? '',
      '',
      fromDate ?? '',
      toDate ?? '',
      'full',
      1,
      50,
      'desc',
      {},
      true,
    );
  }

  /** Inner details for one item (invoice movements + running Site Bal). */
  @Get('item-ledger')
  itemLedger(
    @Headers('x-ess-user') user: string | undefined,
    @Query('item') item?: string,
    @Query('site') site?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.inventory.itemLedger(
      user ?? '',
      site ?? '',
      item ?? '',
      fromDate ?? '',
      toDate ?? '',
    );
  }

  /** Next purmast invoice (ESS …P / …R / …S / …N). */
  @Get('next-invoice')
  nextInvoice(@Query('suffix') suffix?: string) {
    return this.inventory.nextInvoice(suffix ?? 'P');
  }

  /** Distinct Department / Month values for the voucher table dropdown filters. */
  @Get('vouchers/filter-options')
  voucherFilterOptions(
    @Headers('x-ess-user') user: string | undefined,
    @Query('suffix') suffix?: string,
    @Query('kind') kind?: string,
    @Query('site') site?: string,
  ) {
    return this.inventory.listVouchers(user ?? '', suffix ?? '', 1, 50, kind ?? '', site ?? '', {}, true);
  }

  /** Inventory Voucher list (purmast headers). */
  @Get('vouchers')
  vouchers(
    @Headers('x-ess-user') user: string | undefined,
    @Query('suffix') suffix?: string,
    @Query('kind') kind?: string,
    @Query('site') site?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    return this.inventory.listVouchers(
      user ?? '',
      suffix ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      kind ?? '',
      site ?? '',
      colFiltersFrom(all),
      false,
      all?.q ?? '',
    );
  }

  /** Save Inventory Voucher header to purmast. */
  @Post('vouchers')
  saveVoucher(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: {
      invno?: string;
      invdate?: string;
      ccode?: string;
      pcode?: string;
      dparty?: string;
      pinv?: string;
      gno?: string;
      pday?: string;
      narp?: string;
      frt?: string;
      discount?: string;
      pflag?: string;
      suffix?: string;
      kind?: string;
      sdno?: string;
      mont?: string;
      bcode?: string;
      aclas?: string;
      edate?: string;
      lines?: Array<{
        itemCode?: string;
        qty?: string | number;
        rate?: string | number;
        unit?: string;
      }>;
    },
  ) {
    return this.inventory.saveVoucher(user ?? '', body ?? {});
  }

  /** Delete Inventory Voucher. */
  @Delete('vouchers')
  deleteVoucher(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { invno?: string },
  ) {
    return this.inventory.deleteVoucher(user ?? '', body?.invno ?? '');
  }

  /** Full stock / purchase voucher by invoice no (for PDF download). */
  @Get('invoice')
  invoice(
    @Headers('x-ess-user') user: string | undefined,
    @Query('invno') invno?: string,
  ) {
    return this.inventory.invoiceVoucher(user ?? '', invno ?? '');
  }

  /** Add stock In (P) / Out (S) adjustment into purmast + purdet. */
  @Post('stock')
  addStock(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: {
      site?: string;
      itemCode?: string;
      qty?: number | string;
      rate?: number | string;
      unit?: string;
      moveDate?: string;
      moveType?: string;
      mode?: string;
    },
  ) {
    return this.inventory.addStock(user ?? '', body ?? {});
  }

  /** Permanently delete stock movements for one item at one site. */
  @Delete('stock')
  deleteStock(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { site?: string; itemCode?: string },
  ) {
    return this.inventory.deleteStock(user ?? '', body ?? {});
  }
}
