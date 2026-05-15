import { Injectable, Logger } from '@nestjs/common';
import { CreatePublicationDto } from 'src/dtos';
import { FirebaseAuthService } from 'src/firebasesdk/firebasesdk-service';
import { KnowledgeBaseService } from 'src/whatsapp-chat-bot/knowledge-base.service';

@Injectable()
export class PublicationsService {
  private readonly logger = new Logger(PublicationsService.name);

  constructor(
    private firebaseSDKService: FirebaseAuthService,
    private readonly knowledgeBaseService: KnowledgeBaseService,
  ) {}

  async createPublication(
    createPublicationDto: CreatePublicationDto,
    files: any,
  ): Promise<any> {
    const result = await this.firebaseSDKService.createPublication(
      createPublicationDto,
      files,
    );

    // Indexación al knowledge base (fire-and-forget para no bloquear la respuesta)
    if (result?.publicationId && createPublicationDto.condominiumId) {
      this.knowledgeBaseService
        .indexPublication(
          createPublicationDto.clientId,
          createPublicationDto.condominiumId,
          {
            publicationId: result.publicationId,
            title: createPublicationDto.title,
            content: createPublicationDto.content,
            tags: createPublicationDto.tags,
          },
        )
        .catch((err) =>
          this.logger.warn(
            `Indexado RAG de publicación ${result.publicationId} falló: ${err.message}`,
          ),
        );
    }

    return result;
  }
}
