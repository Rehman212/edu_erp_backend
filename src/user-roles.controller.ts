import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { UserRolesService } from './user-roles.service';

@Controller('user-roles')
export class UserRolesController {
  constructor(private readonly roles: UserRolesService) {}

  @Get()
  list() {
    return this.roles.list();
  }

  @Post()
  create(@Body() body: { name?: string; rights?: unknown }) {
    return this.roles.create(body || {});
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; rights?: unknown }) {
    return this.roles.update(id, body || {});
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.roles.remove(id);
  }
}
