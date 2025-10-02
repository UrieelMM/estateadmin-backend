import {
  Controller,
  Post,
  Body,
  UsePipes,
  ValidationPipe,
  UploadedFile,
  UseInterceptors,
  Put,
  Param,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { UsersAuthService } from './users-auth.service';
import {
  RegisterUserDto,
  RegisterClientDto,
  EditUserDto,
  ResetPasswordDto,
  CreateMaintenanceUserDto,
  UpdateMaintenanceUserDto,
} from 'src/dtos';
import { ClientPlanDto } from 'src/dtos/client-plan.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { RegisterCondominiumDto } from 'src/dtos/register-condominium.dto';
import { ConfirmResetPasswordDto } from 'src/dtos/confirm-reset-password.dto';
import { Throttle } from '@nestjs/throttler';
import { RegisterSuperAdminDto } from 'src/dtos/register-super-admin.dto';

@Controller('users-auth')
export class UsersAuthController {
  constructor(private readonly usersAuthService: UsersAuthService) {}

  @Post('register-client')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async registerClient(@Body() registerClientDto: RegisterClientDto) {
    return await this.usersAuthService.registerClient(
      registerClientDto.email,
      registerClientDto.password,
      {
        name: registerClientDto.name,
        lastName: registerClientDto.lastName,
        companyName: registerClientDto.companyName, // Razón social
        phoneNumber: registerClientDto.phoneNumber,
        plan: registerClientDto.plan,
        proFunctions: registerClientDto.proFunctions,
        address: registerClientDto.address,
        fullFiscalAddress: registerClientDto.fullFiscalAddress, // Domicilio fiscal completo
        RFC: registerClientDto.RFC,
        country: registerClientDto.country,
        businessName: registerClientDto.businessName,
        taxRegime: registerClientDto.taxRegime, // Régimen fiscal
        businessActivity: registerClientDto.businessActivity, // Giro o actividad económica
        responsiblePersonName: registerClientDto.responsiblePersonName, // Responsable
        responsiblePersonPosition: registerClientDto.responsiblePersonPosition, // Cargo
        cfdiUse: registerClientDto.cfdiUse, // Uso de CFDI
        serviceStartDate: registerClientDto.serviceStartDate, // Fecha de inicio
        billingFrequency: registerClientDto.billingFrequency, // Periodicidad
        condominiumLimit: registerClientDto.condominiumLimit, // Límite de condominios
        termsAccepted: registerClientDto.termsAccepted, // Aceptación términos
        condominiumInfo: registerClientDto.condominiumInfo,
        hasMaintenanceApp: registerClientDto.hasMaintenanceApp, // App de mantenimiento
      },
    );
  }

  @Post('register-administrators')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async register(@Body() registerUserDto: RegisterUserDto) {
    return await this.usersAuthService.registerUser(
      registerUserDto.email,
      registerUserDto.password,
      registerUserDto.clientId,
      {
        name: registerUserDto.name,
        lastName: registerUserDto.lastName,
        condominiumUids: registerUserDto.condominiumUids,
        photoURL: registerUserDto.photoURL,
        role: registerUserDto.role,
        active: registerUserDto.active,
      },
    );
  }

  @Post('register-super-admin')
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async registerSuperAdmin(
    @Body() registerSuperAdminDto: RegisterSuperAdminDto,
  ) {
    return await this.usersAuthService.registerSuperAdmin(
      registerSuperAdminDto,
    );
  }

  @Post('client-plan')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async getClientPlan(@Body() clientPlanDto: ClientPlanDto) {
    return await this.usersAuthService.getClientPlan(
      clientPlanDto.clientId,
      clientPlanDto.condominiumId,
    );
  }

  @Post('reset-password')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    return await this.usersAuthService.resetPassword(resetPasswordDto);
  }

  @Post('reset-password/confirm')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async confirmResetPassword(
    @Body() confirmResetPasswordDto: ConfirmResetPasswordDto,
  ) {
    return await this.usersAuthService.confirmResetPassword(
      confirmResetPasswordDto,
    );
  }

  @Put('edit-administrator/:uid')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async editAdministrator(
    @Param('uid') uid: string,
    @Body() editUserDto: EditUserDto,
  ) {
    return await this.usersAuthService.editUser(
      uid,
      editUserDto.clientId,
      editUserDto,
    );
  }

  @Post('register-condominiums')
  @Throttle({ default: { limit: 250, ttl: 600000 } }) // Aumentado a 100 peticiones en 10 minutos
  @UseInterceptors(FileInterceptor('file'))
  async registerCondominiums(
    @UploadedFile() file: any,
    @Body() body: { clientId: string; condominiumId: string },
    @Res() res: any,
  ): Promise<void> {
    try {
      const resultExcelBuffer =
        await this.usersAuthService.registerCondominiumUsers(
          file.buffer,
          body.clientId,
          body.condominiumId,
        );

      // Configurar las cabeceras para descargar el archivo Excel
      res.set({
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':
          'attachment; filename="resultado-registro-condominos.xlsx"',
        'Content-Length': resultExcelBuffer.length,
      });

      // Enviar el archivo como respuesta
      res.send(resultExcelBuffer);
    } catch (error) {
      res.status(400).json({
        message: `Error durante el registro de condominios: ${error.message}`,
      });
    }
  }

  @Post('register-condominium')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async registerCondominium(
    @Body() registerCondominiumDto: RegisterCondominiumDto,
  ) {
    return await this.usersAuthService.registerCondominium(
      registerCondominiumDto,
    );
  }

  @Post('create-maintenance-user')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseInterceptors(FileInterceptor('photo'))
  async createMaintenanceUser(
    @UploadedFile() photo: Express.Multer.File,
    @Body() body: any,
  ) {
    try {
      // Parse assignedCondominiums if it's a string
      let assignedCondominiums = body.assignedCondominiums;
      if (typeof assignedCondominiums === 'string') {
        try {
          assignedCondominiums = JSON.parse(assignedCondominiums);
        } catch (e) {
          throw new BadRequestException('assignedCondominiums debe ser un array válido');
        }
      }

      const createMaintenanceUserDto: CreateMaintenanceUserDto = {
        email: body.email,
        password: body.password,
        clientId: body.clientId,
        name: body.name,
        phone: body.phone,
        company: body.company,
        responsibleName: body.responsibleName,
        responsiblePhone: body.responsiblePhone,
        emergencyNumber: body.emergencyNumber,
        assignedCondominiums,
      };

      return await this.usersAuthService.createMaintenanceUser(
        createMaintenanceUserDto,
        photo,
      );
    } catch (error) {
      throw new BadRequestException(error.message || 'Error al crear usuario de mantenimiento');
    }
  }

  @Put('update-maintenance-user')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseInterceptors(FileInterceptor('photo'))
  async updateMaintenanceUser(
    @UploadedFile() photo: Express.Multer.File,
    @Body() body: any,
  ) {
    try {
      // Parse assignedCondominiums if it's a string
      let assignedCondominiums = body.assignedCondominiums;
      if (typeof assignedCondominiums === 'string') {
        try {
          assignedCondominiums = JSON.parse(assignedCondominiums);
        } catch (e) {
          throw new BadRequestException('assignedCondominiums debe ser un array válido');
        }
      }

      const updateMaintenanceUserDto: UpdateMaintenanceUserDto = {
        userId: body.userId,
        clientId: body.clientId,
        name: body.name,
        phone: body.phone,
        company: body.company,
        responsibleName: body.responsibleName,
        responsiblePhone: body.responsiblePhone,
        emergencyNumber: body.emergencyNumber,
        assignedCondominiums,
      };

      return await this.usersAuthService.updateMaintenanceUser(
        updateMaintenanceUserDto,
        photo,
      );
    } catch (error) {
      throw new BadRequestException(error.message || 'Error al actualizar usuario de mantenimiento');
    }
  }
}
