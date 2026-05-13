import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => {
        const opts = config.get<TypeOrmModuleOptions>('database');
        if (!opts) throw new Error('database config not loaded');
        return opts;
      },
    }),
  ],
})
export class DatabaseModule {}
