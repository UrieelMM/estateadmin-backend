// src/firebasesdk/firebase-auth.service.ts
import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { RegisterCondominiumUsersCase, registerUser, RegisterClientCase, CreatePublicationCase, ParcelReceptionCase, MaintenancePaymentCase } from 'src/cases';
import { EditUnidentifiedPaymentCase } from 'src/cases/maintenance-fees/edit-unidentified-payment.case';
import { MaintenanceUnidentifiedPaymentCase } from 'src/cases/maintenance-fees/maintenance-unidentified-payment.case';

import { RegisterUserDto, RegisterClientDto, CreatePublicationDto, ParcelDto, MaintenanceFeesDto, CreateUnidentifiedPaymentDto, EditUnidentifiedPaymentDto } from 'src/dtos';

@Injectable()
export class FirebaseAuthService {
  constructor(private registerCondominiumUsersCase: RegisterCondominiumUsersCase) {
    if (admin.apps.length === 0) { // Asegura la inicialización única de la app
      admin.initializeApp({
        // Opciones de inicialización, si es necesario
      });
    }
  }

  async createClient(registerClientCase: RegisterClientDto) {
    return await RegisterClientCase(registerClientCase);
  }

  async createUserWithEmail(registerUserDto: RegisterUserDto) {
    return await registerUser(registerUserDto);
  }

  async registerCondominiumUsers(fileBuffer: Buffer, companyName: string, condominiumName: string) {
    return this.registerCondominiumUsersCase.execute(fileBuffer, companyName, condominiumName);
  }

  async createPublication(createPublicationDto: CreatePublicationDto, files: any) {
    return await CreatePublicationCase(createPublicationDto, files);
  }

  async createParcelReception(createParcelReceptionDto: ParcelDto, files: any) {
    return await ParcelReceptionCase(createParcelReceptionDto, files);
  }

  async createMaintenanceFee(createMaintenanceFeeDto: MaintenanceFeesDto, files: any) {
    return await MaintenancePaymentCase(createMaintenanceFeeDto, files);
  }

  async createUnidentifiedPayment(createUnidentifiedPaymentDto: CreateUnidentifiedPaymentDto, files: any) {
    return await MaintenanceUnidentifiedPaymentCase(createUnidentifiedPaymentDto, files);
  }

  async editUnidentifiedPayment(editUnidentifiedPaymentDto: EditUnidentifiedPaymentDto) {
    return await EditUnidentifiedPaymentCase(editUnidentifiedPaymentDto);
  }
}
