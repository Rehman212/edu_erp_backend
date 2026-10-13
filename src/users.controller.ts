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
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(
    @Headers('x-ess-user') user?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.users.list(
      user ?? '',
      q ?? '',
      Number(page) || 1,
      Number(pageSize) || 50,
    );
  }

  @Get('me')
  me(@Headers('x-ess-user') user?: string) {
    return this.users.getMe(user ?? '');
  }

  @Put('me')
  updateMe(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: Record<string, string | undefined>,
  ) {
    return this.users.updateMe(user ?? '', body || {});
  }

  @Put('me/password')
  changePassword(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    return this.users.changePassword(user ?? '', body || {});
  }

  @Post()
  create(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: Record<string, string | undefined>,
  ) {
    return this.users.create(user ?? '', body || {});
  }

  @Put(':id')
  update(
    @Headers('x-ess-user') user: string | undefined,
    @Param('id') id: string,
    @Body() body: Record<string, string | undefined>,
  ) {
    return this.users.update(user ?? '', id, body || {});
  }

  @Put(':id/status')
  setStatus(
    @Headers('x-ess-user') user: string | undefined,
    @Param('id') id: string,
    @Body() body: { status?: string },
  ) {
    return this.users.setStatus(user ?? '', id, body?.status ?? '');
  }

  @Delete(':id')
  remove(
    @Headers('x-ess-user') user: string | undefined,
    @Param('id') id: string,
  ) {
    return this.users.remove(user ?? '', id);
  }
}
