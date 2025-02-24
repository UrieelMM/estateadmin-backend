import { Controller, Post, Body, UsePipes, ValidationPipe, UploadedFile, UseInterceptors, StreamableFile } from '@nestjs/common';
import { UsersAuthService } from './users-auth.service';
import { RegisterClientDto, RegisterUserDto } from 'src/dtos';
import { FileInterceptor } from '@nestjs/platform-express';



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
    // Llamada al servicio con todos los datos necesarios
    return await this.usersAuthService.registerUser(
      registerUserDto.email,
      registerUserDto.password,
      registerUserDto.clientId,
      {
        name: registerUserDto.name,
        lastName: registerUserDto.lastName,
        companyName: registerUserDto.companyName,
        condominiumName: registerUserDto.condominiumName,
        role: registerUserDto.role,
        condominiumUids: registerUserDto.condominiumUids,
      }
    );
  }

  @Post('register-condominiums')
  @UseInterceptors(FileInterceptor('file'))
  async registerCondominiums(
    @UploadedFile() file: any, 
    @Body() body: { clientId: string, condominiumId: string }
  ): Promise<StreamableFile> {
    const buffer = await this.usersAuthService.registerCondominiumUsers(file.buffer, body.clientId, body.condominiumId);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="credentials.xlsx"',
    });
  }
}
