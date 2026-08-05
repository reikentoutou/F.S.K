import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';
import { reconcileFixedShifts } from '../shifts/reconcile-fixed-shifts';

@Injectable()
export class SetupService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus() {
    const settings = await this.prisma.appSettings.findUnique({
      where: { id: 'default' },
    });
    return { setupCompleted: settings?.setupCompleted ?? false };
  }

  async ensureSeedData() {
    await this.prisma.$transaction(async (tx) => {
      await reconcileFixedShifts(tx);
    });
    await this.prisma.appSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', registerFloatAmount: 0, setupCompleted: false },
      update: {},
    });
    const pc = await this.prisma.responsiblePerson.count();
    if (pc === 0) {
      await this.prisma.responsiblePerson.create({
        data: { name: '担当者（要変更）', active: true },
      });
    }
  }

  async bootstrap(dto: {
    webmasterUsername: string;
    webmasterPassword: string;
    adminUsername: string;
    adminPassword: string;
  }) {
    await this.ensureSeedData();
    const settings = await this.prisma.appSettings.findUnique({
      where: { id: 'default' },
    });
    if (settings?.setupCompleted) {
      throw new ForbiddenException('Setup already completed');
    }
    const wm = await this.prisma.user.findUnique({
      where: { username: dto.webmasterUsername },
    });
    const ad = await this.prisma.user.findUnique({
      where: { username: dto.adminUsername },
    });
    if (wm || ad) throw new BadRequestException('Username already exists');
    if (dto.webmasterUsername === dto.adminUsername) {
      throw new BadRequestException('Usernames must differ');
    }
    const rounds = 10;
    const wh = await bcrypt.hash(dto.webmasterPassword, rounds);
    const ah = await bcrypt.hash(dto.adminPassword, rounds);
    await this.prisma.$transaction([
      this.prisma.user.create({
        data: {
          username: dto.webmasterUsername,
          passwordHash: wh,
          role: Role.WEBMASTER,
        },
      }),
      this.prisma.user.create({
        data: {
          username: dto.adminUsername,
          passwordHash: ah,
          role: Role.ADMIN,
        },
      }),
      this.prisma.appSettings.update({
        where: { id: 'default' },
        data: { setupCompleted: true },
      }),
    ]);
    return { ok: true };
  }
}
