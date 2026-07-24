import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DevicesService } from './devices.service';

const RegisterDeviceDto = z.object({
  serialNumber: z.string().min(4),
  deviceName: z.string().min(2),
  role: z.enum(['MASTER', 'SLAVE', 'SECONDARY_MASTER']).default('SLAVE'),
  firmwareVersion: z.string().optional(),
  atomicOsVersion: z.string().optional(),
  ipAddress: z.string().optional(),
  macAddress: z.string().optional(),
  model: z.string().optional(),
  siteCode: z.string().optional(),
});

const ApproveDeviceDto = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'BLOCKED', 'TRUSTED']),
});

@Controller('/v1/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.devices.listDevices({ status });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.devices.getDevice(id);
  }

  /**
   * Edge device calls this to register/discover itself with the master.
   * In production this will be protected by mTLS + device certificates.
   */
  @Post('register')
  async register(@Body() body: unknown) {
    const dto = RegisterDeviceDto.parse(body);
    return this.devices.registerDevice(dto);
  }

  @Patch(':id/status')
  async setStatus(@Param('id') id: string, @Body() body: unknown) {
    const dto = ApproveDeviceDto.parse(body);
    return this.devices.updateDeviceStatus(id, dto.status);
  }
}

