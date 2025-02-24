import { Injectable } from '@nestjs/common';
import { CreatePublicationDto } from 'src/dtos';
import { FirebaseAuthService } from 'src/firebasesdk/firebasesdk-service';

@Injectable()
export class PublicationsService {
  constructor(private firebaseSDKService: FirebaseAuthService) {}

  async createPublication(createPublicationDto: CreatePublicationDto, files: any): Promise<any> {
    return await this.firebaseSDKService.createPublication(createPublicationDto, files);
  }
}
