import { Injectable } from '@nestjs/common';
import { FirebaseAuthService } from '../firebasesdk/firebasesdk-service';
import {
  RegisterClientDto,
  RegisterUserDto,
  EditUserDto,
  ResetPasswordDto,
  ConfirmResetPasswordDto,
} from 'src/dtos';
import { RegisterCondominiumDto } from 'src/dtos/register-condominium.dto';
import { RegisterSuperAdminDto } from 'src/dtos/register-super-admin.dto';

@Injectable()
export class UsersAuthService {
  constructor(private firebaseAuthService: FirebaseAuthService) {}

  async registerClient(email: string, password: string, userDetails: any) {
    const registerClientDto: RegisterClientDto = {
      email,
      password,
      ...userDetails,
    };

    return await this.firebaseAuthService.createClient(registerClientDto);
  }

  async registerUser(
    email: string,
    password: string,
    clientId: string,
    userDetails: any,
  ) {
    const registerUserDto: RegisterUserDto = {
      email,
      password,
      clientId,
      name: userDetails.name,
      lastName: userDetails.lastName,
      condominiumUids: userDetails.condominiumUids,
      photoURL: userDetails.photoURL,
      role: userDetails.role,
      active: userDetails.active,
    };

    return await this.firebaseAuthService.createUserWithEmail(registerUserDto);
  }

  async editUser(uid: string, clientId: string, userDetails: EditUserDto) {
    return await this.firebaseAuthService.editUser(uid, clientId, userDetails);
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto) {
    return await this.firebaseAuthService.resetPassword(resetPasswordDto);
  }

  async registerCondominiumUsers(
    fileBuffer: Buffer,
    clientId: string,
    condominiumId: string,
  ) {
    return this.firebaseAuthService.registerCondominiumUsers(
      fileBuffer,
      clientId,
      condominiumId,
    );
  }

  async registerCondominium(registerCondominiumDto: RegisterCondominiumDto) {
    return await this.firebaseAuthService.createCondominium(
      registerCondominiumDto,
    );
  }

  async confirmResetPassword(confirmResetPasswordDto: ConfirmResetPasswordDto) {
    return await this.firebaseAuthService.confirmResetPassword(
      confirmResetPasswordDto,
    );
  }

  async registerSuperAdmin(registerSuperAdminDto: RegisterSuperAdminDto) {
    return await this.firebaseAuthService.createSuperAdmin(
      registerSuperAdminDto,
    );
  }
}
