import { Injectable } from '@nestjs/common';
import { FirebaseAuthService } from '../firebasesdk/firebasesdk-service';
import { RegisterClientDto, RegisterUserDto } from 'src/dtos';

@Injectable()
export class UsersAuthService {
  constructor(private firebaseAuthService: FirebaseAuthService) {}

  async registerClient(email: string, password: string, userDetails: any, ) {
    const registerClientDto: RegisterClientDto = {
      email,
      password,
      ...userDetails
    };

    return await this.firebaseAuthService.createClient(registerClientDto);
  }

  async registerUser(email: string, password: string, clientId: string, userDetails: any) {
    const registerUserDto: RegisterUserDto = {
      email,
      password,
      clientId,
      name: userDetails.name,
      lastName: userDetails.lastName,
      companyName: userDetails.companyName,
      condominiumName: userDetails.condominiumName,
      condominiumUids: userDetails.condominiumUids,
      role: userDetails.role || 'admin-assistant',
    };

    return await this.firebaseAuthService.createUserWithEmail(registerUserDto);
  }

  async registerCondominiumUsers(fileBuffer: Buffer, clientId: string, condominiumId: string) {
    return this.firebaseAuthService.registerCondominiumUsers(fileBuffer, clientId, condominiumId);
  }
}
