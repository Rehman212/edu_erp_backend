import { Body, Controller, Headers, Post } from '@nestjs/common';
import { FeeIncrementService, type FeeBulkBody } from './fee-increment.service';

@Controller('fee-increment')
export class FeeIncrementController {
  constructor(private readonly fees: FeeIncrementService) {}

  @Post('preview')
  preview(@Headers('x-ess-user') user: string | undefined, @Body() body: FeeBulkBody) {
    return this.fees.preview(user ?? '', body || {});
  }

  @Post('apply')
  apply(@Headers('x-ess-user') user: string | undefined, @Body() body: FeeBulkBody) {
    return this.fees.apply(user ?? '', body || {});
  }

  @Post('stamp-due')
  stampDue(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { invnos?: string[]; dueDate?: string; site?: string },
  ) {
    return this.fees.stampVoucherDates(user ?? '', body || {});
  }
}
