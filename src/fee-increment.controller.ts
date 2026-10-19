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
}
