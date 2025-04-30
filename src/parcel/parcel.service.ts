import { Injectable } from '@nestjs/common';
import { ParcelDto, UpdateParcelDto } from 'src/dtos';
import { FirebaseAuthService } from 'src/firebasesdk/firebasesdk-service';

@Injectable()
export class ParcelService {
    constructor(private firebaseSDKService: FirebaseAuthService) {}

  async createParcelReception(ParcelDto: ParcelDto, files: any): Promise<any> {
    return await this.firebaseSDKService.createParcelReception(ParcelDto, files);
  }

  async updateParcelDelivery(updateParcelDto: UpdateParcelDto, files: any): Promise<any> {
    return await this.firebaseSDKService.updateParcelDelivery(updateParcelDto, files);
  }
}

