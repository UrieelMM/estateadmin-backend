import { Injectable } from '@nestjs/common';
import { MaintenanceFeesDto } from 'src/dtos';
import { FirebaseAuthService } from 'src/firebasesdk/firebasesdk-service';

@Injectable()
export class MaintenanceFeesService {
    constructor(private firebaseSDKService: FirebaseAuthService) {}

  async createMaintenanceFee(MaintenanceFeesDto: MaintenanceFeesDto, files: Express.Multer.File[]): Promise<any> {
    return await this.firebaseSDKService.createMaintenanceFee(MaintenanceFeesDto, files);
  }
}