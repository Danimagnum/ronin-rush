import { Module } from '@nestjs/common';
import { AuthController, ConfigController, MeController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController, MeController, ConfigController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
