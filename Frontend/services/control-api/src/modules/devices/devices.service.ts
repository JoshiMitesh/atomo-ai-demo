import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../services/prisma.service';

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async listDevices({ status }: { status?: string }) {
    return this.prisma.device.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { updatedAt: 'desc' },
      include: { site: true },
    });
  }

  async getDevice(id: string) {
    const device = await this.prisma.device.findUnique({
      where: { id },
      include: { site: true, cameras: true },
    });
    if (!device) throw new NotFoundException('Device not found');
    return device;
  }

  async registerDevice(dto: {
    serialNumber: string;
    deviceName: string;
    role: 'MASTER' | 'SLAVE' | 'SECONDARY_MASTER';
    firmwareVersion?: string;
    atomicOsVersion?: string;
    ipAddress?: string;
    macAddress?: string;
    model?: string;
    siteCode?: string;
  }) {
    const site =
      dto.siteCode
        ? await this.prisma.site.upsert({
            where: { code: dto.siteCode },
            update: {},
            create: { code: dto.siteCode, name: dto.siteCode },
          })
        : null;

    const device = await this.prisma.device.upsert({
      where: { serialNumber: dto.serialNumber },
      update: {
        deviceName: dto.deviceName,
        role: dto.role,
        firmwareVersion: dto.firmwareVersion,
        atomicOsVersion: dto.atomicOsVersion,
        ipAddress: dto.ipAddress,
        macAddress: dto.macAddress,
        model: dto.model,
        siteId: site?.id,
        lastSeenAt: new Date(),
      },
      create: {
        serialNumber: dto.serialNumber,
        deviceName: dto.deviceName,
        role: dto.role,
        firmwareVersion: dto.firmwareVersion,
        atomicOsVersion: dto.atomicOsVersion,
        ipAddress: dto.ipAddress,
        macAddress: dto.macAddress,
        model: dto.model,
        siteId: site?.id,
        lastSeenAt: new Date(),
      },
    });

    await this.prisma.discoveryEvent.create({
      data: {
        deviceId: device.id,
        status: device.status,
        source: 'self-register',
        deviceName: dto.deviceName,
        ipAddress: dto.ipAddress,
        macAddress: dto.macAddress,
        model: dto.model,
        serialNumber: dto.serialNumber,
        siteCode: dto.siteCode,
      },
    });

    return device;
  }

  async updateDeviceStatus(id: string, status: 'APPROVED' | 'REJECTED' | 'BLOCKED' | 'TRUSTED') {
    const device = await this.prisma.device.update({
      where: { id },
      data: {
        status: status as any,
        trusted: status === 'TRUSTED',
      },
    });
    return device;
  }
}

