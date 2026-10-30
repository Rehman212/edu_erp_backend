import { Body, Controller, Delete, Get, Headers, Param, Post, Put } from '@nestjs/common';
import { UserRolesService } from './user-roles.service';

@Controller('user-roles')
export class UserRolesController {
  constructor(private readonly roles: UserRolesService) {}

  @Get()
  list() {
    return this.roles.list();
  }

  @Post()
  create(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { name?: string; rights?: unknown },
  ) {
    return this.roles.create(user ?? '', body || {});
  }

  @Put(':id')
  update(
    @Headers('x-ess-user') user: string | undefined,
    @Param('id') id: string,
    @Body() body: { name?: string; rights?: unknown },
  ) {
    return this.roles.update(user ?? '', id, body || {});
  }

  @Delete(':id')
  remove(@Headers('x-ess-user') user: string | undefined, @Param('id') id: string) {
    return this.roles.remove(user ?? '', id);
  }
}
