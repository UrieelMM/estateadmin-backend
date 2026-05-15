import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import axios from 'axios';

export interface PublicDocument {
  id: string;
  name: string;
  description: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  fileUrl: string;
  uploadedAt: admin.firestore.Timestamp;
}

export interface DocumentsConfig {
  reglamento?: PublicDocument;
  manualConvivencia?: PublicDocument;
  politicasAreaComun?: PublicDocument;
  /**
   * Documento opcional que SOLO se usa para alimentar el knowledge base de
   * la IA del chatbot (RAG). NO se expone en la opción "Consultar documentos
   * del condominio" del flujo de WhatsApp.
   */
  aiKnowledgeBase?: PublicDocument;
}

/**
 * Claves de documentos que NO deben mostrarse a los residentes en el
 * chatbot, pero sí se usan para entrenar la IA.
 */
export const AI_ONLY_DOCUMENT_KEYS: ReadonlyArray<keyof DocumentsConfig> = [
  'aiKnowledgeBase',
];

@Injectable()
export class PublicDocumentsService {
  private readonly logger = new Logger(PublicDocumentsService.name);
  private firestore: admin.firestore.Firestore;

  constructor() {
    this.firestore = admin.firestore();
  }

  /**
   * Obtiene los documentos públicos disponibles para un condominio específico
   */
  async getPublicDocuments(
    clientId: string,
    condominiumId: string,
  ): Promise<DocumentsConfig | null> {
    try {
      const configPath = `clients/${clientId}/condominiums/${condominiumId}/publicDocuments/config`;
      this.logger.log(`Consultando documentos en: ${configPath}`);

      const configDoc = await this.firestore.doc(configPath).get();

      if (!configDoc.exists) {
        this.logger.warn(
          `No se encontró configuración de documentos en: ${configPath}`,
        );
        return null;
      }

      const data = configDoc.data() as DocumentsConfig;
      this.logger.log(
        `Documentos encontrados para ${condominiumId}: ${Object.keys(data).length}`,
      );

      return data;
    } catch (error) {
      this.logger.error(
        `Error al obtener documentos públicos para ${clientId}/${condominiumId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Genera la lista de documentos disponibles para mostrar al usuario
   */
  formatDocumentsList(documents: DocumentsConfig): {
    text: string;
    documentKeys: string[];
  } {
    const availableDocs: { key: string; name: string; description: string }[] =
      [];

    if (documents.reglamento) {
      availableDocs.push({
        key: 'reglamento',
        name: documents.reglamento.name,
        description: documents.reglamento.description,
      });
    }

    if (documents.manualConvivencia) {
      availableDocs.push({
        key: 'manualConvivencia',
        name: documents.manualConvivencia.name,
        description: documents.manualConvivencia.description,
      });
    }

    if (documents.politicasAreaComun) {
      availableDocs.push({
        key: 'politicasAreaComun',
        name: documents.politicasAreaComun.name,
        description: documents.politicasAreaComun.description,
      });
    }

    if (availableDocs.length === 0) {
      return {
        text: '📄 Lo siento, no hay documentos públicos disponibles en este momento.',
        documentKeys: [],
      };
    }

    let text = '📚 Aquí tienes los documentos disponibles:\n\n';
    availableDocs.forEach((doc, index) => {
      text += `${index + 1}. *${doc.name}*\n   ${doc.description}\n\n`;
    });
    text +=
      'Por favor, responde con el número del documento que deseas recibir.';

    return {
      text,
      documentKeys: availableDocs.map((doc) => doc.key),
    };
  }

  /**
   * Obtiene un documento específico por su clave
   */
  getDocumentByKey(
    documents: DocumentsConfig,
    key: string,
  ): PublicDocument | null {
    switch (key) {
      case 'reglamento':
        return documents.reglamento || null;
      case 'manualConvivencia':
        return documents.manualConvivencia || null;
      case 'politicasAreaComun':
        return documents.politicasAreaComun || null;
      default:
        return null;
    }
  }

  /**
   * Valida si la URL del documento es accesible
   */
  async validateDocumentUrl(url: string): Promise<boolean> {
    try {
      const response = await axios.head(url, { timeout: 5000 });
      return response.status === 200;
    } catch (error) {
      this.logger.warn(`URL del documento no accesible: ${url}`);
      return false;
    }
  }

  /**
   * Formatea el mensaje para enviar el documento al usuario
   */
  formatDocumentMessage(document: PublicDocument): string {
    return `📄 *${document.name}*\n\n${document.description}\n\n🔗 Puedes descargar el documento desde el siguiente enlace:\n{URL_PLACEHOLDER}\n\n✅ ¡Espero que esta información te sea útil!`;
  }

  /**
   * Acorta una URL usando un servicio gratuito
   */
  async shortenUrl(longUrl: string): Promise<string> {
    try {
      // Usando is.gd que es gratuito y no requiere API key
      const response = await axios.post(
        'https://is.gd/create.php',
        new URLSearchParams({
          format: 'simple',
          url: longUrl,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 5000,
        },
      );

      if (
        response.data &&
        typeof response.data === 'string' &&
        response.data.startsWith('http')
      ) {
        this.logger.log(`URL acortada exitosamente: ${response.data}`);
        return response.data.trim();
      } else {
        this.logger.warn('Respuesta inesperada del servicio de acortado');
        return longUrl; // Fallback a URL original
      }
    } catch (error) {
      this.logger.error(`Error acortando URL: ${error.message}`);
      return longUrl; // Fallback a URL original
    }
  }
}
