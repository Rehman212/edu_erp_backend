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
import { RegistrationService } from './registration.service';

@Controller('registration')
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) {}

  @Get('sites')
  sites(@Headers('x-ess-user') user?: string) {
    return this.registration.sites(user ?? '');
  }

  @Get('lookups')
  lookups(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
  ) {
    return this.registration.lookups(user ?? '', site ?? '');
  }

  @Get('scope-counts')
  scopeCounts(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
  ) {
    return this.registration.scopeCounts(user ?? '', site ?? '');
  }

  @Post('class-change')
  classChange(
    @Headers('x-ess-user') user: string | undefined,
    @Body()
    body: {
      site?: string;
      fromClass?: string;
      fromSection?: string;
      toClass?: string;
      toSection?: string;
      sdnos?: string[];
    },
  ) {
    return this.registration.moveClassSection(user ?? '', body || {});
  }

  @Get('students')
  students(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
    @Query('classCode') classCode?: string,
    @Query('section') section?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('dateField') dateField?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query() all?: Record<string, string>,
  ) {
    const colFilters: Record<string, string> = {};
    for (const [k, v] of Object.entries(all || {})) {
      if (k.startsWith('f_') && typeof v === 'string' && v.trim()) {
        colFilters[k.slice(2)] = v;
      }
    }
    return this.registration.listStudents(
      user ?? '',
      site ?? '',
      classCode ?? '',
      section ?? '',
      status ?? '',
      q ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      colFilters,
      fromDate ?? '',
      toDate ?? '',
      dateField ?? '',
    );
  }

  @Get('students/filter-options')
  filterOptions(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
  ) {
    return this.registration.studentFilterOptions(user ?? '', site ?? '');
  }

  @Get('students/next-code')
  nextCode(
    @Headers('x-ess-user') user: string | undefined,
    @Query('site') site?: string,
  ) {
    return this.registration.nextStudentCode(user ?? '', site ?? '');
  }

  @Get('students/:sdno')
  one(
    @Headers('x-ess-user') user: string | undefined,
    @Param('sdno') sdno: string,
  ) {
    return this.registration.getStudent(user ?? '', sdno);
  }

  @Post('students')
  create(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: Record<string, string | number | undefined>,
  ) {
    return this.registration.createStudent(user ?? '', body || {});
  }

  @Put('students/:sdno')
  update(
    @Headers('x-ess-user') user: string | undefined,
    @Param('sdno') sdno: string,
    @Body() body: Record<string, string | number | undefined>,
  ) {
    return this.registration.updateStudent(user ?? '', sdno, body || {});
  }

  @Delete('students/:sdno')
  remove(
    @Headers('x-ess-user') user: string | undefined,
    @Param('sdno') sdno: string,
  ) {
    return this.registration.deleteStudent(user ?? '', sdno);
  }
}
