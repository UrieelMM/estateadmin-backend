import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import axios from 'axios';
import pdfParse from 'pdf-parse';
import { GeminiService } from '../gemini/gemini.service';
import {
  PublicDocumentsService,
  PublicDocument,
} from './public-documents.service';

/**
 * Representa un fragmento (chunk) indexado del knowledge base de un condominio.
 * Cada chunk vive en:
 *   clients/{clientId}/condominiums/{condominiumId}/knowledgeBase/{chunkId}
 */
export interface KnowledgeChunk {
  source: 'publication' | 'document';
  sourceId: string;
  sourceName: string;
  sourceKey?: string; // p.ej. 'reglamento' para documentos
  chunkIndex: number;
  text: string;
  embedding: FirebaseFirestore.VectorValue;
  metadata?: {
    url?: string;
    createdAt?: admin.firestore.Timestamp;
    tags?: string;
  };
  indexedAt: admin.firestore.Timestamp;
}

export interface KnowledgeBaseStats {
  totalChunks: number;
  publicationChunks: number;
  documentChunks: number;
  publicationsCount: number;
  documentsCount: number;
  lastIndexedAt?: admin.firestore.Timestamp | null;
}

export interface ReindexResult {
  clientId: string;
  condominiumId: string;
  publicationsIndexed: number;
  publicationChunksCreated: number;
  documentsIndexed: number;
  documentChunksCreated: number;
  errors: string[];
  durationMs: number;
}

const KB_COLLECTION = 'knowledgeBase';

@Injectable()
export class KnowledgeBaseService {
  private readonly logger = new Logger(KnowledgeBaseService.name);
  private firestore: admin.firestore.Firestore;

  constructor(
    private readonly geminiService: GeminiService,
    private readonly publicDocumentsService: PublicDocumentsService,
  ) {
    this.firestore = admin.firestore();
  }

  // ─── Utilidades de texto ────────────────────────────────────────────────

  /**
   * Convierte HTML (típico del editor Quill de publicaciones) a texto plano
   * preservando saltos de línea.
   */
  htmlToPlainText(html: string): string {
    if (!html) return '';
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/(div|li|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Chunker simple por párrafos con overlap a nivel de caracteres.
   * Mantiene chunks de ~1200 caracteres con 200 de overlap para no perder contexto.
   */
  chunkText(
    text: string,
    maxChars = 1200,
    overlap = 200,
  ): string[] {
    if (!text || text.trim().length === 0) return [];

    const clean = text.replace(/\s+\n/g, '\n').trim();

    // Si el texto es corto, regresar como único chunk
    if (clean.length <= maxChars) return [clean];

    const chunks: string[] = [];
    let start = 0;
    while (start < clean.length) {
      let end = Math.min(start + maxChars, clean.length);

      // Intentar cortar en un salto de párrafo o en un punto cercano
      if (end < clean.length) {
        const slice = clean.substring(start, end);
        const lastBreak = Math.max(
          slice.lastIndexOf('\n\n'),
          slice.lastIndexOf('. '),
          slice.lastIndexOf('.\n'),
        );
        if (lastBreak > maxChars * 0.5) {
          end = start + lastBreak + 1;
        }
      }

      chunks.push(clean.substring(start, end).trim());
      if (end >= clean.length) break;
      start = end - overlap;
      if (start < 0) start = 0;
    }
    return chunks.filter((c) => c.length > 20);
  }

  // ─── Rutas ─────────────────────────────────────────────────────────────

  private kbCollectionRef(clientId: string, condominiumId: string) {
    return this.firestore
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection(KB_COLLECTION);
  }

  // ─── Indexación de publicaciones ───────────────────────────────────────

  /**
   * Indexa una publicación: borra sus chunks previos y genera unos nuevos.
   * Diseñado para ser llamado tanto al crear como al actualizar.
   */
  async indexPublication(
    clientId: string,
    condominiumId: string,
    publication: {
      publicationId: string;
      title?: string;
      content?: string;
      tags?: string;
      createdAt?: admin.firestore.Timestamp | Date;
    },
  ): Promise<number> {
    try {
      const { publicationId, title, content, tags } = publication;

      const plain = this.htmlToPlainText(content || '');
      const head = [title, tags].filter(Boolean).join(' — ');
      const full = [head, plain].filter(Boolean).join('\n\n');

      // Limpia chunks previos de esta misma publicación
      await this.deleteBySource(
        clientId,
        condominiumId,
        'publication',
        publicationId,
      );

      const chunks = this.chunkText(full);
      if (chunks.length === 0) return 0;

      const embeddings = await this.geminiService.embedTexts(chunks);
      const batch = this.firestore.batch();
      const colRef = this.kbCollectionRef(clientId, condominiumId);
      let created = 0;

      chunks.forEach((chunkText, i) => {
        const vec = embeddings[i];
        if (!vec || vec.length === 0) return; // skip si falló embedding
        const docRef = colRef.doc();
        const payload: Partial<KnowledgeChunk> = {
          source: 'publication',
          sourceId: publicationId,
          sourceName: title || 'Publicación',
          chunkIndex: i,
          text: chunkText,
          embedding: admin.firestore.FieldValue.vector(vec) as any,
          metadata: {
            tags: tags || undefined,
          },
          indexedAt: admin.firestore.Timestamp.now(),
        };
        batch.set(docRef, payload);
        created++;
      });

      if (created > 0) {
        await batch.commit();
      }
      this.logger.log(
        `Publicación ${publicationId} indexada: ${created} chunks`,
      );
      return created;
    } catch (error) {
      this.logger.error(
        `Error indexando publicación ${publication.publicationId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // ─── Indexación de documentos públicos (PDF) ───────────────────────────

  /**
   * Descarga el PDF de Storage, extrae texto, lo trocea y guarda los chunks.
   */
  async indexPublicDocument(
    clientId: string,
    condominiumId: string,
    docKey:
      | 'reglamento'
      | 'manualConvivencia'
      | 'politicasAreaComun'
      | 'aiKnowledgeBase'
      | string,
    document: PublicDocument,
  ): Promise<number> {
    try {
      this.logger.log(
        `Indexando documento ${docKey} (${document.name}) desde ${document.fileUrl}`,
      );

      // Borra chunks previos del documento
      await this.deleteBySource(
        clientId,
        condominiumId,
        'document',
        document.id || docKey,
      );

      // Solo procesamos PDFs por ahora
      const isPdf =
        (document.fileType && document.fileType.includes('pdf')) ||
        (document.fileName && document.fileName.toLowerCase().endsWith('.pdf'));

      if (!isPdf) {
        this.logger.warn(
          `Documento ${docKey} no es PDF (${document.fileType}). Se omite indexado.`,
        );
        return 0;
      }

      // Descargar el archivo
      const response = await axios.get<ArrayBuffer>(document.fileUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const buffer = Buffer.from(response.data);

      // Extraer texto del PDF
      const parsed = await pdfParse(buffer);
      const fullText = (parsed.text || '').trim();

      if (!fullText) {
        this.logger.warn(`PDF ${docKey} no produjo texto extraíble.`);
        return 0;
      }

      const chunks = this.chunkText(fullText);
      if (chunks.length === 0) return 0;

      const embeddings = await this.geminiService.embedTexts(chunks);
      const batch = this.firestore.batch();
      const colRef = this.kbCollectionRef(clientId, condominiumId);
      let created = 0;

      chunks.forEach((chunkText, i) => {
        const vec = embeddings[i];
        if (!vec || vec.length === 0) return;
        const docRef = colRef.doc();
        const payload: Partial<KnowledgeChunk> = {
          source: 'document',
          sourceId: document.id || docKey,
          sourceName: document.name,
          sourceKey: docKey,
          chunkIndex: i,
          text: chunkText,
          embedding: admin.firestore.FieldValue.vector(vec) as any,
          metadata: {
            url: document.fileUrl,
          },
          indexedAt: admin.firestore.Timestamp.now(),
        };
        batch.set(docRef, payload);
        created++;
      });

      if (created > 0) {
        await batch.commit();
      }
      this.logger.log(
        `Documento ${docKey} indexado: ${created} chunks (de ${chunks.length} totales)`,
      );
      return created;
    } catch (error) {
      this.logger.error(
        `Error indexando documento ${docKey}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // ─── Reindex masivo ─────────────────────────────────────────────────────

  /**
   * Reindexa TODO el knowledge base de un condominio: publicaciones + documentos.
   * Borra los chunks existentes y regenera. Pensado para uso administrativo.
   */
  async reindexAll(
    clientId: string,
    condominiumId: string,
  ): Promise<ReindexResult> {
    const startedAt = Date.now();
    const result: ReindexResult = {
      clientId,
      condominiumId,
      publicationsIndexed: 0,
      publicationChunksCreated: 0,
      documentsIndexed: 0,
      documentChunksCreated: 0,
      errors: [],
      durationMs: 0,
    };

    // 1) Limpiar todo el KB previo del condominio
    try {
      await this.clearAll(clientId, condominiumId);
    } catch (e) {
      result.errors.push(`Error limpiando KB previo: ${e.message}`);
    }

    // 2) Indexar publicaciones
    try {
      const pubsSnap = await this.firestore
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .collection('publications')
        .get();

      for (const doc of pubsSnap.docs) {
        const data = doc.data();
        try {
          const created = await this.indexPublication(clientId, condominiumId, {
            publicationId: data.publicationId || doc.id,
            title: data.title,
            content: data.content,
            tags: data.tags,
            createdAt: data.createdAt,
          });
          if (created > 0) {
            result.publicationsIndexed++;
            result.publicationChunksCreated += created;
          }
        } catch (e) {
          result.errors.push(
            `Publicación ${doc.id}: ${e.message?.substring(0, 200)}`,
          );
        }
      }
    } catch (e) {
      result.errors.push(`Error listando publicaciones: ${e.message}`);
    }

    // 3) Indexar documentos públicos
    try {
      const docsCfg = await this.publicDocumentsService.getPublicDocuments(
        clientId,
        condominiumId,
      );
      if (docsCfg) {
        // Iteramos sobre TODAS las llaves del documento config — incluye
        // los 3 documentos públicos y `aiKnowledgeBase` (solo IA), así como
        // cualquier otro que se agregue en el futuro sin tener que tocar
        // este servicio.
        const entries = Object.entries(docsCfg) as Array<
          [string, PublicDocument | undefined]
        >;
        for (const [key, document] of entries) {
          if (!document || !document.fileUrl) continue;
          try {
            const created = await this.indexPublicDocument(
              clientId,
              condominiumId,
              key as any,
              document,
            );
            if (created > 0) {
              result.documentsIndexed++;
              result.documentChunksCreated += created;
            }
          } catch (e) {
            result.errors.push(
              `Documento ${key}: ${e.message?.substring(0, 200)}`,
            );
          }
        }
      }
    } catch (e) {
      result.errors.push(`Error listando documentos: ${e.message}`);
    }

    // 4) Guardar timestamp del último reindex
    try {
      await this.firestore
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .collection('knowledgeBaseMeta')
        .doc('status')
        .set(
          {
            lastReindexAt: admin.firestore.Timestamp.now(),
            lastReindexResult: {
              publicationsIndexed: result.publicationsIndexed,
              publicationChunksCreated: result.publicationChunksCreated,
              documentsIndexed: result.documentsIndexed,
              documentChunksCreated: result.documentChunksCreated,
              errorsCount: result.errors.length,
            },
          },
          { merge: true },
        );
    } catch (e) {
      this.logger.warn(`No se pudo escribir meta de reindex: ${e.message}`);
    }

    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // ─── Estado del KB ──────────────────────────────────────────────────────

  async getStats(
    clientId: string,
    condominiumId: string,
  ): Promise<KnowledgeBaseStats> {
    const colRef = this.kbCollectionRef(clientId, condominiumId);
    const snap = await colRef.get();

    let publicationChunks = 0;
    let documentChunks = 0;
    const publicationIds = new Set<string>();
    const documentIds = new Set<string>();

    snap.forEach((doc) => {
      const d = doc.data();
      if (d.source === 'publication') {
        publicationChunks++;
        publicationIds.add(d.sourceId);
      } else if (d.source === 'document') {
        documentChunks++;
        documentIds.add(d.sourceId);
      }
    });

    // Leer meta
    let lastIndexedAt: admin.firestore.Timestamp | null = null;
    try {
      const meta = await this.firestore
        .doc(
          `clients/${clientId}/condominiums/${condominiumId}/knowledgeBaseMeta/status`,
        )
        .get();
      if (meta.exists) {
        lastIndexedAt = meta.data()?.lastReindexAt || null;
      }
    } catch (_) {
      // ignorar
    }

    return {
      totalChunks: snap.size,
      publicationChunks,
      documentChunks,
      publicationsCount: publicationIds.size,
      documentsCount: documentIds.size,
      lastIndexedAt,
    };
  }

  // ─── Borrado ───────────────────────────────────────────────────────────

  async deleteBySource(
    clientId: string,
    condominiumId: string,
    source: 'publication' | 'document',
    sourceId: string,
  ): Promise<number> {
    const colRef = this.kbCollectionRef(clientId, condominiumId);
    const snap = await colRef
      .where('source', '==', source)
      .where('sourceId', '==', sourceId)
      .get();
    if (snap.empty) return 0;

    const batch = this.firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    return snap.size;
  }

  async clearAll(clientId: string, condominiumId: string): Promise<number> {
    const colRef = this.kbCollectionRef(clientId, condominiumId);
    let totalDeleted = 0;
    // Batches de 400 para no exceder el límite de 500
    while (true) {
      const snap = await colRef.limit(400).get();
      if (snap.empty) break;
      const batch = this.firestore.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      totalDeleted += snap.size;
      if (snap.size < 400) break;
    }
    return totalDeleted;
  }

  // ─── Búsqueda (RAG) ─────────────────────────────────────────────────────

  /**
   * Combina búsqueda vectorial + generación con Gemini para simular la
   * respuesta exacta que el chatbot daría a un residente desde WhatsApp.
   * Aplica el mismo umbral de distancia (0.55) que usa el flujo del bot.
   */
  async askWithRag(
    clientId: string,
    condominiumId: string,
    question: string,
    topK = 5,
  ): Promise<{
    answer: string;
    relevantCount: number;
    threshold: number;
    results: Array<{
      text: string;
      source: 'publication' | 'document';
      sourceId: string;
      sourceName: string;
      distance: number;
    }>;
  }> {
    const threshold = 0.55;
    const NO_ANSWER =
      'No encontré información sobre eso en los documentos de tu condominio. Te sugiero contactar al administrador.';

    const results = await this.searchKnowledgeBase(
      clientId,
      condominiumId,
      question,
      topK,
    );

    const relevant = results.filter((r) => r.distance < threshold);

    if (relevant.length === 0) {
      return { answer: NO_ANSWER, relevantCount: 0, threshold, results };
    }

    // Intentar resolver el nombre del condominio para personalizar la respuesta
    let condominiumName: string | undefined;
    try {
      const condoDoc = await this.firestore
        .doc(`clients/${clientId}/condominiums/${condominiumId}`)
        .get();
      const data = condoDoc.data();
      condominiumName =
        (data?.name as string) ||
        (data?.condominiumName as string) ||
        undefined;
    } catch (_) {
      // best effort
    }

    const answer = await this.geminiService.answerWithContext(
      question,
      relevant.map((r) => ({ text: r.text, source: r.sourceName })),
      condominiumName,
    );

    return {
      answer,
      relevantCount: relevant.length,
      threshold,
      results,
    };
  }

  /**
   * Busca los chunks más relevantes para una pregunta dentro de un condominio.
   * Devuelve los chunks con su distancia COSINE (menor = más cercano).
   */
  async searchKnowledgeBase(
    clientId: string,
    condominiumId: string,
    question: string,
    topK = 5,
  ): Promise<
    Array<{
      text: string;
      source: 'publication' | 'document';
      sourceId: string;
      sourceName: string;
      distance: number;
    }>
  > {
    if (!question || question.trim().length === 0) return [];

    const queryEmbedding = await this.geminiService.embedText(question);
    const colRef = this.kbCollectionRef(clientId, condominiumId);

    // findNearest está scoped a la colección del condominio, así que el
    // multi-tenant queda garantizado por la ruta.
    const vectorQuery = (colRef as any).findNearest({
      vectorField: 'embedding',
      queryVector: admin.firestore.FieldValue.vector(queryEmbedding),
      limit: topK,
      distanceMeasure: 'COSINE',
      distanceResultField: '_distance',
    });

    const snap = await vectorQuery.get();
    if (snap.empty) return [];

    return snap.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => {
      const data = d.data() as any;
      return {
        text: data.text as string,
        source: data.source as 'publication' | 'document',
        sourceId: data.sourceId as string,
        sourceName: data.sourceName as string,
        distance:
          typeof data._distance === 'number' ? (data._distance as number) : 1,
      };
    });
  }
}
