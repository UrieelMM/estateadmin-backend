import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { Request } from 'express';
import { KnowledgeBaseService } from './knowledge-base.service';
import { PublicDocumentsService } from './public-documents.service';

interface ReindexBody {
  clientId: string;
  condominiumId: string;
}

interface AskBody {
  clientId: string;
  condominiumId: string;
  question: string;
  topK?: number;
}

interface SyncDocumentBody {
  clientId: string;
  condominiumId: string;
  docKey: string;
  /**
   * Acción explícita. Si es 'upsert', re-indexa el documento (borra chunks
   * previos y genera nuevos). Si es 'delete', elimina los chunks de ese
   * documento del knowledge base. Si se omite, se intenta inferir leyendo
   * el documento actual de Firestore.
   */
  action?: 'upsert' | 'delete';
}

/**
 * Endpoints administrativos para el knowledge base usado por el chatbot RAG.
 * Pensados para ser invocados desde el dashboard admin del frontend.
 *
 * Todos los endpoints requieren un Bearer token de Firebase Auth y validan
 * que el `clientId` del usuario coincida con el del recurso.
 */
@Controller('whatsapp-chat-bot/knowledge-base')
export class KnowledgeBaseController {
  private readonly logger = new Logger(KnowledgeBaseController.name);

  constructor(
    private readonly kbService: KnowledgeBaseService,
    private readonly publicDocumentsService: PublicDocumentsService,
  ) {}

  @Get('stats')
  async stats(
    @Query('clientId') clientId: string,
    @Query('condominiumId') condominiumId: string,
    @Req() req: Request,
  ) {
    if (!clientId || !condominiumId) {
      throw new BadRequestException('clientId y condominiumId son requeridos');
    }
    await this.authorize(req, clientId);
    return this.kbService.getStats(clientId, condominiumId);
  }

  @Post('reindex')
  async reindex(@Body() body: ReindexBody, @Req() req: Request) {
    const { clientId, condominiumId } = body || ({} as ReindexBody);
    if (!clientId || !condominiumId) {
      throw new BadRequestException('clientId y condominiumId son requeridos');
    }
    await this.authorize(req, clientId);
    this.logger.log(
      `Reindex solicitado para ${clientId}/${condominiumId}`,
    );
    return this.kbService.reindexAll(clientId, condominiumId);
  }

  @Post('clear')
  async clear(@Body() body: ReindexBody, @Req() req: Request) {
    const { clientId, condominiumId } = body || ({} as ReindexBody);
    if (!clientId || !condominiumId) {
      throw new BadRequestException('clientId y condominiumId son requeridos');
    }
    await this.authorize(req, clientId);
    const deleted = await this.kbService.clearAll(clientId, condominiumId);
    return { deleted };
  }

  /**
   * Endpoint de prueba para validar el RAG desde el frontend sin pasar
   * por WhatsApp. Devuelve la respuesta generada por Gemini con el mismo
   * prompt que se usa en WhatsApp, junto con los chunks que sustentan la
   * respuesta (para que el admin pueda auditarla).
   */
  @Post('ask')
  async ask(@Body() body: AskBody, @Req() req: Request) {
    const { clientId, condominiumId, question, topK } =
      body || ({} as AskBody);
    if (!clientId || !condominiumId || !question) {
      throw new BadRequestException(
        'clientId, condominiumId y question son requeridos',
      );
    }
    await this.authorize(req, clientId);
    return this.kbService.askWithRag(
      clientId,
      condominiumId,
      question,
      topK || 5,
    );
  }

  /**
   * Sincroniza el knowledge base con el estado actual de un documento
   * específico de Firestore. Diseñado para invocarse desde el frontend
   * inmediatamente después de subir o eliminar un documento, garantizando
   * que la información sensible o desactualizada se purgue del RAG.
   *
   * Comportamiento:
   * - Si `action === 'delete'` → borra todos los chunks del documento.
   * - Si `action === 'upsert'` (o no se pasa y el doc existe) → borra los
   *   chunks previos y re-indexa con el contenido actual.
   * - Si no se pasa `action` y el doc no existe → borra los chunks (como delete).
   */
  @Post('sync-document')
  async syncDocument(@Body() body: SyncDocumentBody, @Req() req: Request) {
    const { clientId, condominiumId, docKey, action } =
      body || ({} as SyncDocumentBody);
    if (!clientId || !condominiumId || !docKey) {
      throw new BadRequestException(
        'clientId, condominiumId y docKey son requeridos',
      );
    }
    await this.authorize(req, clientId);

    // Resolver el documento actual en Firestore
    const docsCfg = await this.publicDocumentsService.getPublicDocuments(
      clientId,
      condominiumId,
    );
    const currentDoc =
      docsCfg && (docsCfg as any)[docKey]
        ? ((docsCfg as any)[docKey] as any)
        : null;

    // Acción efectiva
    const effective: 'upsert' | 'delete' =
      action === 'delete' ? 'delete' : currentDoc ? 'upsert' : 'delete';

    if (effective === 'delete') {
      const deleted = await this.kbService.deleteBySource(
        clientId,
        condominiumId,
        'document',
        // Borramos por id si está disponible y también por docKey por seguridad
        (currentDoc && (currentDoc.id as string)) || docKey,
      );
      // Doble pasada en caso de que el sourceId fuera distinto (defensivo)
      if (currentDoc && currentDoc.id && currentDoc.id !== docKey) {
        await this.kbService.deleteBySource(
          clientId,
          condominiumId,
          'document',
          docKey,
        );
      }
      this.logger.log(
        `sync-document (delete) ${clientId}/${condominiumId}/${docKey}: ${deleted} chunks eliminados`,
      );
      return { action: 'delete', docKey, deleted };
    }

    // upsert
    const created = await this.kbService.indexPublicDocument(
      clientId,
      condominiumId,
      docKey as any,
      currentDoc,
    );
    this.logger.log(
      `sync-document (upsert) ${clientId}/${condominiumId}/${docKey}: ${created} chunks creados`,
    );
    return { action: 'upsert', docKey, chunksCreated: created };
  }

  // ─── Autorización ──────────────────────────────────────────────────────

  private async authorize(req: Request, clientId: string) {
    const token = this.extractBearerToken(req);

    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(token, true);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado.');
    }

    const tokenClientId = String(decoded.clientId || '').trim();
    if (tokenClientId && tokenClientId !== clientId) {
      throw new UnauthorizedException(
        'No autorizado para este clientId.',
      );
    }
    return decoded;
  }

  private extractBearerToken(req: Request): string {
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization Bearer token requerido.');
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('Token vacío.');
    }
    return token;
  }
}
