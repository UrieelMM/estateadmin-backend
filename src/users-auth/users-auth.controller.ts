import { Controller, Post, Body, UsePipes, ValidationPipe, UploadedFile, UseInterceptors, StreamableFile, Put, Param } from '@nestjs/common';
import { UsersAuthService } from './users-auth.service';
import { RegisterClientDto, RegisterUserDto, EditUserDto } from 'src/dtos';
import { FileInterceptor } from '@nestjs/platform-express';
import { RegisterCondominiumDto } from 'src/dtos/register-condominium.dto';

@Controller('users-auth')
export class UsersAuthController {
  constructor(private readonly usersAuthService: UsersAuthService) { }

  @Post('register-client')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
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
        currentPlan: registerClientDto.currentPlan,
        address: registerClientDto.address,
        RFC: registerClientDto.RFC,
        country: registerClientDto.country,
        businessName: registerClientDto.businessName,
        taxResidence: registerClientDto.taxResidence,
        taxRegime: registerClientDto.taxRegime,
        condominiumInfo: registerClientDto.condominiumInfo,
      }
    );
  }

  @Post('register-administrators')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
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
        active: registerUserDto.active
      }
    );
  }

  @Put('edit-administrator/:uid')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async editAdministrator(
    @Param('uid') uid: string,
    @Body() editUserDto: EditUserDto
  ) {
    return await this.usersAuthService.editUser(
      uid,
      editUserDto.clientId,
      editUserDto
    );
  }

  @Post('register-condominiums')
  @UseInterceptors(FileInterceptor('file'))
  async registerCondominiums(
    @UploadedFile() file: any, 
    @Body() body: { clientId: string; condominiumId: string }
  ): Promise<{ message: string }> {
    await this.usersAuthService.registerCondominiumUsers(file.buffer, body.clientId, body.condominiumId);
    return { message: 'Usuarios registrados correctamente.' };
  }

  @Post('register-condominium')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async registerCondominium(@Body() registerCondominiumDto: RegisterCondominiumDto) {
    return await this.usersAuthService.registerCondominium(registerCondominiumDto);
  }
}
