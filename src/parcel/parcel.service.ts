import { Injectable } from '@nestjs/common';
import { ParcelDto } from 'src/dtos';
import { FirebaseAuthService } from 'src/firebasesdk/firebasesdk-service';

@Injectable()
export class ParcelService {
    constructor(private firebaseSDKService: FirebaseAuthService) {}

  async createParcelReception(ParcelDto: ParcelDto, files: Express.Multer.File[]): Promise<any> {
    return await this.firebaseSDKService.createParcelReception(ParcelDto, files);
  }
}

