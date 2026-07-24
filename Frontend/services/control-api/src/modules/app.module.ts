import { Module } from '@nestjs/common';
import { PrismaService } from '../services/prisma.service';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';

@Module({
  controllers: [DevicesController],
  providers: [PrismaService, DevicesService],
})
export class AppModule {}

