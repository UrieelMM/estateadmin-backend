import {
  Controller,
  Post,
  Body,
  UsePipes,
  ValidationPipe,
  UploadedFile,
  UseInterceptors,
  StreamableFile,
  Put,
  Param,
  UnauthorizedException,
  Headers,
} from '@nestjs/common';
import { UsersAuthService } from './users-auth.service';
import {
  RegisterUserDto,
  RegisterClientDto,
  EditUserDto,
  ResetPasswordDto,
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
        companyName: registerClientDto.companyName,
        condominiumName: registerClientDto.condominiumName,
        phoneNumber: registerClientDto.phoneNumber,
        plan: registerClientDto.plan,
        proFunctions: registerClientDto.proFunctions,
        address: registerClientDto.address,
        RFC: registerClientDto.RFC,
        country: registerClientDto.country,
        businessName: registerClientDto.businessName,
        taxResidence: registerClientDto.taxResidence,
        taxRegime: registerClientDto.taxRegime,
        condominiumInfo: registerClientDto.condominiumInfo,
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
  @Throttle({ default: { limit: 1, ttl: 320000 } })
  @UseInterceptors(FileInterceptor('file'))
  async registerCondominiums(
    @UploadedFile() file: any,
    @Body() body: { clientId: string; condominiumId: string },
  ): Promise<{ message: string }> {
    await this.usersAuthService.registerCondominiumUsers(
      file.buffer,
      body.clientId,
      body.condominiumId,
    );
    return { message: 'Usuarios registrados correctamente.' };
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
}
