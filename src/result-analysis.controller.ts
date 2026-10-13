import { Controller, Get, Headers, Query } from '@nestjs/common';
import { ResultAnalysisService } from './result-analysis.service';

@Controller('result-analysis')
export class ResultAnalysisController {
  constructor(private readonly resultAnalysis: ResultAnalysisService) {}

  @Get('campuses')
  campuses(@Headers('x-ess-user') user?: string) {
    return this.resultAnalysis.campuses(user ?? '');
  }

  @Get('classes')
  classes(@Headers('x-ess-user') user: string | undefined, @Query('campus') campus?: string) {
    return this.resultAnalysis.classes(user ?? '', campus ?? '');
  }

  @Get('sections')
  sections(
    @Headers('x-ess-user') user: string | undefined,
    @Query('campus') campus?: string,
    @Query('class') classCode?: string,
  ) {
    return this.resultAnalysis.sections(user ?? '', campus ?? '', classCode ?? '');
  }

  @Get('students')
  students(
    @Headers('x-ess-user') user: string | undefined,
    @Query('campus') campus?: string,
    @Query('class') classCode?: string,
    @Query('section') section?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('siblings') siblings?: string,
    @Query('employeeChild') employeeChild?: string,
    @Query('sort') sort?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    const siblingsOnly = ['1', 'true', 'yes'].includes(String(siblings ?? '').trim().toLowerCase());
    const employeeChildOnly = ['1', 'true', 'yes'].includes(
      String(employeeChild ?? '').trim().toLowerCase(),
    );
    return this.resultAnalysis.students(
      user ?? '',
      campus ?? '',
      classCode ?? '',
      section ?? '',
      q ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
      status ?? '',
      siblingsOnly,
      employeeChildOnly,
      sort?.trim() || 'desc',
      fromDate ?? '',
      toDate ?? '',
    );
  }

  @Get('strength-classwise')
  strengthClasswise(
    @Headers('x-ess-user') user: string | undefined,
    @Query('campus') campus?: string,
    @Query('class') classCode?: string,
    @Query('section') section?: string,
  ) {
    return this.resultAnalysis.strengthClasswise(
      user ?? '',
      campus ?? '',
      classCode ?? '',
      section ?? '',
    );
  }
}
