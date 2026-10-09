import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
    const sourceId = String(dto.sourceUnidentifiedPaymentId || '').trim();
    if (!sourceId) {
      return this.closures.withOpenMonth(dto.clientId, dto.condominiumId, dto.paymentDate,
        () => this.firebaseSDKService.createMaintenanceFee(dto, files));
    }
    const sourceRef = admin.firestore().collection('clients').doc(dto.clientId)
      .collection('condominiums').doc(dto.condominiumId)
      .collection('unidentifiedPayments').doc(sourceId);
    const source = await sourceRef.get();
    if (!source.exists) throw new NotFoundException('Pago no identificado de origen no encontrado.');
    const sourceRawDate = source.data()?.paymentDate?.toDate?.() || source.data()?.paymentDate;
    const sourceDate = sourceRawDate instanceof Date ? sourceRawDate.toISOString() : String(sourceRawDate || '');
    if (this.closures.monthForDate(sourceDate) !== this.closures.monthForDate(dto.paymentDate)) {
      throw new ConflictException('La fecha del pago aplicado debe pertenecer al mismo mes que el pago de origen.');
    }
    if (Math.round(Number(source.data()?.amountPaid)) !== Math.round(Number(dto.amountPaid)) ||
      String(source.data()?.financialAccountId || '') !== String(dto.financialAccountId || '')) {
      throw new ConflictException('El monto o la cuenta del pago aplicado no coincide con el pago de origen.');
    }
    const apply = async () => {
      const fresh = await sourceRef.get();
      if (!fresh.exists || fresh.data()?.appliedToUser === true ||
        Math.round(Number(fresh.data()?.amountPaid)) !== Math.round(Number(dto.amountPaid)) ||
        String(fresh.data()?.financialAccountId || '') !== String(dto.financialAccountId || '')) {
        throw new ConflictException('El pago de origen cambió, ya fue aplicado o no existe.');
      }
      const created = await this.firebaseSDKService.createMaintenanceFee(dto, files);
      await this.firebaseSDKService.editUnidentifiedPayment({
        paymentId: sourceId, clientId: dto.clientId, condominiumId: dto.condominiumId,
        userId: dto.userId,
      });
      return created;
    };
    return this.closures.withOpenMonth(dto.clientId, dto.condominiumId, sourceDate, apply);
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
