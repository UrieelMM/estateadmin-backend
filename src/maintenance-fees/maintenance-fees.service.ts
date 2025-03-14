import { Injectable } from '@nestjs/common';
import { MaintenanceFeesDto } from 'src/dtos';
import { CreateUnidentifiedPaymentDto } from 'src/dtos/create-unidentified-payment.dto';
import { EditUnidentifiedPaymentDto } from 'src/dtos/edit-unidentified-payment.dto'; // <-- Importa el DTO recién creado
import { FirebaseAuthService } from 'src/firebasesdk/firebasesdk-service';

@Injectable()
export class MaintenanceFeesService {
  constructor(private firebaseSDKService: FirebaseAuthService) {}

  async createMaintenanceFee(dto: MaintenanceFeesDto, files: any): Promise<any> {
    return await this.firebaseSDKService.createMaintenanceFee(dto, files);
  }

  async createUnidentifiedPayment(dto: CreateUnidentifiedPaymentDto, files: any): Promise<any> {
    return await this.firebaseSDKService.createUnidentifiedPayment(dto, files);
  }

  // NUEVO MÉTODO para editar un pago no identificado
  async editUnidentifiedPayment(dto: EditUnidentifiedPaymentDto): Promise<any> {
    // Aquí delegas la operación a tu FirebaseAuthService o a otro servicio que maneje la lógica
    return await this.firebaseSDKService.editUnidentifiedPayment(dto);
  }
}
