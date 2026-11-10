import './instrument'; // first: Sentry instrumentation must load before other modules
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  app.enableCors({ origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(','), credentials: true });
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`instance ${env.INSTANCE_ID} listening on :${env.PORT}`);
}

void bootstrap();
