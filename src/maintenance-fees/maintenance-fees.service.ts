import { Injectable, NotFoundException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { MaintenanceFeesDto } from 'src/dtos';
import { CreateUnidentifiedPaymentDto } from 'src/dtos/create-unidentified-payment.dto';
import { EditUnidentifiedPaymentDto } from 'src/dtos/edit-unidentified-payment.dto'; // <-- Importa el DTO recién creado
import { FirebaseAuthService } from 'src/firebasesdk/firebasesdk-service';
import { FinancialClosuresService } from './financial-closures.service';

@Injectable()
export class MaintenanceFeesService {
  constructor(private firebaseSDKService: FirebaseAuthService, private closures: FinancialClosuresService) {}

  async createMaintenanceFee(dto: MaintenanceFeesDto, files: any): Promise<any> {
    return this.closures.withOpenMonth(dto.clientId, dto.condominiumId, dto.paymentDate,
      () => this.firebaseSDKService.createMaintenanceFee(dto, files));
  }

  async createUnidentifiedPayment(dto: CreateUnidentifiedPaymentDto, files: any): Promise<any> {
    return this.closures.withOpenMonth(dto.clientId, dto.condominiumId, dto.paymentDate,
      () => this.firebaseSDKService.createUnidentifiedPayment(dto, files));
  }

  // NUEVO MÉTODO para editar un pago no identificado
  async editUnidentifiedPayment(dto: EditUnidentifiedPaymentDto): Promise<any> {
    const snap = await admin.firestore().collection('clients').doc(dto.clientId)
      .collection('condominiums').doc(dto.condominiumId)
      .collection('unidentifiedPayments').doc(dto.paymentId).get();
    if (!snap.exists) throw new NotFoundException('Pago no identificado no encontrado.');
    const rawDate = snap.data()?.paymentDate?.toDate?.() || snap.data()?.paymentDate;
    const date = rawDate instanceof Date ? rawDate.toISOString() : String(rawDate || '');
    return this.closures.withOpenMonth(dto.clientId, dto.condominiumId, date,
      () => this.firebaseSDKService.editUnidentifiedPayment(dto));
  }
}
