import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  IsInt,
  IsString,
  Min,
} from 'class-validator';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/decorators/roles.decorator';

class CreatePersonDto {
  @IsString()
  name!: string;
}

class PatchSettingsDto {
  @IsInt()
  @Min(0)
  registerFloatAmount!: number;
}

@Controller('meta')
export class MetaController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('shifts')
  shifts() {
    return this.prisma.shift.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  @Get('responsible-persons')
  persons() {
    return this.prisma.responsiblePerson.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
  }

  @Post('responsible-persons')
  @Roles(Role.ADMIN)
  createPerson(@Body() dto: CreatePersonDto) {
    return this.prisma.responsiblePerson.create({
      data: { name: dto.name, active: true },
    });
  }

  @Patch('responsible-persons/:id/deactivate')
  @Roles(Role.ADMIN)
  deactivatePerson(@Param('id') id: string) {
    return this.prisma.responsiblePerson.update({
      where: { id },
      data: { active: false },
    });
  }

  @Get('webmaster-users')
  @Roles(Role.ADMIN)
  webmasterUsers() {
    return this.prisma.user.findMany({
      where: { role: Role.WEBMASTER },
      select: { id: true, username: true },
    });
  }

  @Get('settings')
  settings() {
    return this.prisma.appSettings.findUnique({ where: { id: 'default' } });
  }

  @Patch('settings')
  @Roles(Role.ADMIN)
  patchSettings(@Body() dto: PatchSettingsDto) {
    return this.prisma.appSettings.update({
      where: { id: 'default' },
      data: { registerFloatAmount: dto.registerFloatAmount },
    });
  }
}
