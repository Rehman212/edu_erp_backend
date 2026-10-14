import { Body, Controller, Get, Headers, NotFoundException, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('branding')
  branding() {
    return this.settings.branding();
  }

  @Get('branding/:key/image')
  async image(@Param('key') key: string, @Res() res: Response) {
    if (!this.settings.isKey(key)) throw new NotFoundException('Unknown setting.');
    const img = await this.settings.image(key);
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(img.data);
  }

  @Put('branding/:key')
  save(
    @Headers('x-ess-user') user: string | undefined,
    @Param('key') key: string,
    @Body() body: { dataUrl?: string; fileName?: string },
  ) {
    if (!this.settings.isKey(key)) throw new NotFoundException('Unknown setting.');
    return this.settings.save(user ?? '', key, body || {});
  }

  @Post('branding/:key/revert')
  revert(@Headers('x-ess-user') user: string | undefined, @Param('key') key: string) {
    if (!this.settings.isKey(key)) throw new NotFoundException('Unknown setting.');
    return this.settings.revert(user ?? '', key);
  }
}
