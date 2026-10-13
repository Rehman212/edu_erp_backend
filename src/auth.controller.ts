import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';

function clientIp(req: Request) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim() || '';
  }
  return req.socket?.remoteAddress || '';
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(
    @Body() body: { username?: string; password?: string },
    @Req() req: Request,
  ) {
    return this.auth.login(body.username ?? '', body.password ?? '', clientIp(req));
  }

  @Post('logout')
  logout(
    @Headers('x-ess-user') user: string | undefined,
    @Body() body: { username?: string; role?: string; campus?: string; campusCode?: string },
    @Req() req: Request,
  ) {
    return this.auth.logout(
      user || body.username || '',
      body.role || '',
      body.campus || '',
      body.campusCode || '',
      clientIp(req),
    );
  }
}
