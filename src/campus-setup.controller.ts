import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CampusSetupService } from './campus-setup.service';

@Controller('campus-setup')
export class CampusSetupController {
  constructor(private readonly campusSetup: CampusSetupService) {}

  @Get()
  tree(
    @Headers('x-ess-user') user?: string,
    @Query('site') site?: string,
  ) {
    return this.campusSetup.tree(user ?? '', site ?? '');
  }

  @Post('campuses')
  createCampus(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: Record<string, string | undefined>,
  ) {
    return this.campusSetup.createCampus(user ?? '', body || {});
  }

  @Put('campuses/:code')
  updateCampus(
    @Headers('x-ess-user') user: string | undefined,
    @Param('code') code: string,
    @Body() body: Record<string, string | undefined>,
  ) {
    return this.campusSetup.updateCampus(user ?? '', code, body || {});
  }

  @Delete('campuses/:code')
  deleteCampus(
    @Headers('x-ess-user') user: string | undefined,
    @Param('code') code: string,
  ) {
    return this.campusSetup.deleteCampus(user ?? '', code);
  }

  @Post('sections')
  createSection(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: Record<string, string | undefined>,
  ) {
    return this.campusSetup.createSection(user ?? '', body || {});
  }

  @Put('sections/:code')
  updateSection(
    @Headers('x-ess-user') user: string | undefined,
    @Param('code') code: string,
    @Body() body: Record<string, string | undefined>,
  ) {
    return this.campusSetup.updateSection(user ?? '', code, body || {});
  }

  @Delete('sections/:code')
  deleteSection(
    @Headers('x-ess-user') user: string | undefined,
    @Param('code') code: string,
  ) {
    return this.campusSetup.deleteSection(user ?? '', code);
  }
}
