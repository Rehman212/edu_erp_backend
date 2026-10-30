import 'dotenv/config';
import { json, urlencoded } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { authTokenMiddleware } from './auth-token';
import { DatabaseService } from './database.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '12mb' }));
  app.use(urlencoded({ extended: true, limit: '12mb' }));
  const corsOrigin = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.use(authTokenMiddleware(app.get(DatabaseService)));
  app.setGlobalPrefix('api');
  await app.listen(process.env.PORT ?? 4001);
}
bootstrap();
