import { Global, Module } from '@nestjs/common';
import { loadEnv } from './env';
import { ENV } from './tokens';

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
