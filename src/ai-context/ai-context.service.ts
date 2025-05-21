import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pinecone } from '@pinecone-database/pinecone';
import { SyncContextDto } from './dto/sync-context.dto';
import { QueryContextDto } from './dto/query-context.dto';
import { GeminiService } from '../gemini/gemini.service';
import { MpcService } from '../mpc/mpc.service';

@Injectable()
export class AiContextService implements OnModuleInit {
  private pinecone: Pinecone;
  private readonly logger = new Logger(AiContextService.name);
  private index: any;
  private readonly embeddingModel = 'gemini-1.5-flash-latest';

  constructor(
    private readonly configService: ConfigService,
    private readonly geminiService: GeminiService,
    private readonly mpcService: MpcService,
  ) {}

  async onModuleInit() {
    try {
      const apiKey = this.configService.get<string>('PINECONE_API_KEY');
      const indexName = this.configService.get<string>('PINECONE_INDEX_NAME');

      if (!apiKey || !indexName) {
        this.logger.error(
          'PINECONE_API_KEY or PINECONE_INDEX_NAME is not set in environment variables.',
        );
        throw new Error('Pinecone configuration is missing.');
      }

      this.pinecone = new Pinecone({
        apiKey,
      });

      this.index = this.pinecone.Index(indexName);
      this.logger.log(`Pinecone initialized with index: ${indexName}`);
    } catch (error) {
      this.logger.error(
        `Error initializing Pinecone: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to initialize Pinecone: ${error.message}`);
    }
  }

  /**
   * Genera incrustaciones (embeddings) utilizando el modelo Gemini
   * @param text Texto para generar embedding
   * @returns Vector de embedding
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Validar que el texto no esté vacío
      if (!text || text.trim().length === 0) {
        throw new Error('Cannot generate embeddings for empty text');
      }

      // Limitar longitud del texto si es muy extenso (para API limits)
      const truncatedText = text.length > 8000 ? text.substring(0, 8000) : text;
      if (truncatedText.length < text.length) {
        this.logger.warn(
          `Text was truncated from ${text.length} to ${truncatedText.length} characters for embedding generation`,
        );
      }

      const model = this.geminiService.getEmbeddingModel();
      const embedding = await model.embedContent(truncatedText);

      if (!embedding || !embedding.embedding || !embedding.embedding.values) {
        throw new Error('Invalid or empty embedding result from Gemini API');
      }

      return embedding.embedding.values;
    } catch (error) {
      this.logger.error(
        `Error generating embeddings: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to generate embeddings: ${error.message}`);
    }
  }

  /**
   * Sincroniza el contexto enviado con Pinecone
   * @param syncContextDto DTO con información para sincronizar
   * @returns Object con el ID del vector creado y estado de la operación
   */
  async syncContext(syncContextDto: SyncContextDto): Promise<any> {
    try {
      const {
        text,
        category,
        clientId,
        condominiumId,
        metadata = {},
      } = syncContextDto;

      // Validación adicional
      if (!clientId) {
        throw new Error('El ID del cliente es obligatorio');
      }

      if (!condominiumId) {
        throw new Error('El ID del condominio es obligatorio');
      }

      if (!category) {
        throw new Error('La categoría es obligatoria');
      }

      // Generar embedding para el texto
      const embedding = await this.generateEmbedding(text);

      // Crear ID único para el vector (usando UUID sería mejor en producción)
      const id = `${clientId}_${condominiumId}_${category}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

      // Extraer propiedades reservadas para no duplicarlas
      const {
        text: _,
        category: __,
        clientId: ___,
        condominiumId: ____,
        metadata: _____,
        ...additionalProperties
      } = syncContextDto;

      // Función para sanitizar los valores de metadatos para Pinecone
      // Pinecone solo acepta strings, números, booleanos o arrays de strings
      const sanitizeMetadata = (
        obj: Record<string, any>,
      ): Record<string, any> => {
        const result: Record<string, any> = {};

        for (const [key, value] of Object.entries(obj)) {
          // Si es un valor primitivo o array de strings, usarlo directamente
          if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            (Array.isArray(value) &&
              value.every((item) => typeof item === 'string'))
          ) {
            result[key] = value;
          }
          // Si es un array de objetos o un objeto, convertirlo a JSON string
          else if (typeof value === 'object' && value !== null) {
            result[key] = JSON.stringify(value);
          }
          // Ignorar valores undefined o null
        }

        return result;
      };

      // Preparar metadatos más completos para facilitar búsquedas
      const enhancedMetadata = sanitizeMetadata({
        // Propiedades básicas obligatorias
        text,
        category,
        clientId,
        condominiumId,
        timestamp: new Date().toISOString(),

        // Estadísticas del texto
        wordCount: text.split(/\s+/).length,
        charCount: text.length,

        // Metadatos explícitos proporcionados
        ...metadata,

        // Cualquier propiedad adicional que venga del frontend
        ...additionalProperties,

        // Aseguramos que 'source' tenga un valor por defecto si no viene
        source: metadata.source || additionalProperties.source || 'api',
      });

      // Insertar vector en Pinecone
      await this.index.upsert([
        {
          id,
          values: embedding,
          metadata: enhancedMetadata,
        },
      ]);

      this.logger.log(
        `Context synced to Pinecone with ID: ${id}, category: ${category}, clientId: ${clientId}, condominiumId: ${condominiumId}`,
      );

      return {
        id,
        message: 'Contexto sincronizado correctamente',
        status: 'success',
        metadata: {
          category,
          clientId,
          condominiumId,
          timestamp: new Date().toISOString(),
          // Incluimos también las propiedades adicionales en la respuesta
          ...additionalProperties,
          // Si hay metadatos específicos, los incluimos también
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        },
      };
    } catch (error) {
      this.logger.error(`Error syncing context: ${error.message}`, error.stack);
      throw new Error(`Failed to sync context to Pinecone: ${error.message}`);
    }
  }

  /**
   * Consulta el contexto relevante para un prompt y genera una respuesta enriquecida
   * @param queryContextDto DTO con el prompt y parámetros de consulta
   * @returns Respuesta generada con el contexto relevante encontrado
   */
  async queryContext(queryContextDto: QueryContextDto): Promise<any> {
    try {
      const {
        prompt,
        clientId,
        condominiumId,
        category,
        maxResults = 15, // Aumentamos el valor predeterminado para obtener más contexto
      } = queryContextDto;

      // Validación adicional
      if (!prompt || prompt.trim().length === 0) {
        throw new Error('El prompt no puede estar vacío');
      }

      if (!clientId) {
        throw new Error('El ID del cliente es obligatorio');
      }

      if (!condominiumId) {
        throw new Error('El ID del condominio es obligatorio');
      }

      // Generar embedding para el prompt
      const embedding = await this.generateEmbedding(prompt);

      // Intentar extraer un número de condómino del prompt
      const condominoNumberMatch = prompt.match(/\b(?:cond[o\u00f3]mino|unidad)\s+(\d+)\b/i);
      let condominoNumber = condominoNumberMatch ? condominoNumberMatch[1] : null;
      
      // También intentar extraer un número aislado que podría ser un condómino
      if (!condominoNumber) {
        const simpleNumberMatch = prompt.match(/\b(\d{2,4})\b/); // Números de 2-4 dígitos como posibles unidades
        condominoNumber = simpleNumberMatch ? simpleNumberMatch[1] : null;
      }
      
      this.logger.log(`Prompt contains reference to condomino number: ${condominoNumber || 'none'}`);
      
      // Preparar filtro para la consulta
      const filter: any = {
        clientId: { $eq: clientId },
        condominiumId: { $eq: condominiumId },
      };

      // Agregar filtro por categoría si se proporciona
      if (category) {
        filter.category = { $eq: category };
      }
      
      // Si detectamos un número de condómino, realizar una búsqueda exhaustiva para obtener todo el contexto posible
      let allMatches = [];
      
      if (condominoNumber) {
        // Intentar recuperar TODOS los documentos relacionados con este condómino
        try {
          const condominoFilter = {
            ...filter,
            $or: [
              { condominoNumero: { $eq: condominoNumber } },
              { condominoNumero: { $eq: parseInt(condominoNumber) } },
              { numeroCondominio: { $eq: condominoNumber } },
              { numeroCondominio: { $eq: parseInt(condominoNumber) } }
            ]
          };
          
          this.logger.log(`Executing exhaustive query for condomino ${condominoNumber} to get ALL related records`);
          
          // Máximo valor permitido por Pinecone: intentamos obtener absolutamente todo para este condómino
          // Nota: Pinecone tiene un límite práctico, pero intentamos obtener todos los disponibles
          const specificResult = await this.index.query({
            vector: embedding,
            topK: 1000, // Valor intencionalmente alto para intentar recuperar todo
            includeMetadata: true,
            filter: condominoFilter,
          });
          
          if (specificResult.matches.length > 0) {
            this.logger.log(`Found ${specificResult.matches.length} specific matches for condomino ${condominoNumber}`);
            
            // Obtenemos TODOS los registros relacionados con este condómino, pero ordenamos por relevancia semántica
            allMatches = [...specificResult.matches];
            
            // Si hay muchos resultados, podemos intentar categorizarlos para incluir una muestra representativa
            if (allMatches.length > 50) {
              // Agrupamos por categoría para tener una representación equilibrada
              const categorizedMatches = {};
              allMatches.forEach(match => {
                const category = match.metadata.category || 'unknown';
                if (!categorizedMatches[category]) {
                  categorizedMatches[category] = [];
                }
                categorizedMatches[category].push(match);
              });
              
              // Tomamos los mejores de cada categoría para mantener diversidad
              const balancedMatches = [];
              Object.values(categorizedMatches as Record<string, any[]>).forEach(categoryMatches => {
                // Tomamos hasta 10 de cada categoría, priorizando por score
                balancedMatches.push(...(categoryMatches as any[]).slice(0, 10));
              });
              
              // Si aún tenemos demasiados, limitamos al máximo permitido por Gemini (estimado 100-150 items)
              if (balancedMatches.length > 150) {
                this.logger.log(`Limiting from ${balancedMatches.length} to 150 balanced matches due to token limits`);
                allMatches = balancedMatches.slice(0, 150);
              } else {
                allMatches = balancedMatches;
              }
            }
          }
        } catch (error) {
          this.logger.warn(`Error executing exhaustive condomino query: ${error.message}`);
          // Continuamos con la consulta normal si la consulta exhaustiva falla
        }
      }

      // Determinar el número óptimo de resultados basándonos en si es una consulta específica
      // Para consultas específicas sobre un condómino, podemos permitir más resultados
      const isSpecificCondominoQuery = !!condominoNumber;
      const effectiveMaxResults = isSpecificCondominoQuery ? 100 : maxResults;
      
      // Para clientes/condominios específicos, podemos recuperar más datos
      // ya que Gemini tiene un límite de tokens, estimamos un valor máximo razonable
      const safeLimit = Math.min(
        effectiveMaxResults,
        condominoNumber ? 200 : 50  // Permitir hasta 200 para condóminos específicos, 50 para consultas generales
      );
      
      this.logger.log(`Querying Pinecone with topK=${safeLimit} (condominoNumber=${condominoNumber || 'none'})`);
      
      // Consultar vectores similares en Pinecone (búsqueda semántica general)
      const queryResult = await this.index.query({
        vector: embedding,
        topK: safeLimit,
        includeMetadata: true,
        filter,
      });
      
      // Combinar los resultados de ambas consultas (si hay resultados específicos)
      if (allMatches.length > 0) {
        // Añadir resultados generales que no estaban ya en los resultados específicos
        const specificIds = new Set(allMatches.map(match => match.id));
        
        for (const match of queryResult.matches) {
          if (!specificIds.has(match.id)) {
            allMatches.push(match);
            // Limitar el total combinado
            if (allMatches.length >= maxResults * 1.5) break;
          }
        }
        
        // Reemplazar los resultados con la combinación
        queryResult.matches = allMatches;
        
        this.logger.log(`Combined query resulted in ${queryResult.matches.length} total matches`);
      }
      
      // Si detectamos un número de condómino, consultar directamente en Firebase usando MPC
      // Esto complementa la búsqueda vectorial con datos directos de las colecciones
      let directFirebaseContext = '';
      
      if (condominoNumber) {
        try {
          this.logger.log(`Using MPC service to query Firebase directly for condomino ${condominoNumber}`);
          
          // Primero, intentamos encontrar al condómino específico
          const residentResults = await this.mpcService.queryCollectionByPrompt({
            prompt: `información del condómino ${condominoNumber}`,
            clientId,
            condominiumId,
            collection: 'residents',
            limit: 10
          });
          
          if (residentResults && residentResults.length > 0) {
            this.logger.log(`Found resident information for condomino ${condominoNumber}`);
            const formattedResidents = this.mpcService.formatCollectionResults(residentResults, 'DATOS DEL CONDÓMINO');
            directFirebaseContext += formattedResidents + '\n\n';
          }
          
          // Consultar colecciones relevantes para este condómino específico
          const specificPrompt = `pagos y gastos del condómino ${condominoNumber}`;
          const collectionsToQuery = ['payments', 'expenses'];
          
          for (const collection of collectionsToQuery) {
            const directResults = await this.mpcService.queryCollectionByPrompt({
              prompt: specificPrompt,
              clientId,
              condominiumId,
              collection,
              limit: 50 // Límite razonable por colección
            });
            
            if (directResults && directResults.length > 0) {
              // Filtrar manualmente para encontrar solo los documentos realmente relacionados con este condómino
              const filteredResults = directResults.filter(doc => {
                // Buscar en cualquier campo que pueda contener el número de condómino
                const docStr = JSON.stringify(doc).toLowerCase();
                return docStr.includes(condominoNumber) || 
                       docStr.includes(`condómino ${condominoNumber}`) || 
                       docStr.includes(`unidad ${condominoNumber}`);
              });
              
              if (filteredResults.length > 0) {
                this.logger.log(`Found ${filteredResults.length} filtered direct results from ${collection}`);
                const formattedResults = this.mpcService.formatCollectionResults(filteredResults, collection.toUpperCase());
                directFirebaseContext += formattedResults + '\n\n';
              } else {
                this.logger.log(`No filtered results for ${collection} related to condomino ${condominoNumber}`);
              }
            }
          }
          
          if (directFirebaseContext) {
            this.logger.log('Successfully retrieved direct context from Firebase');
          } else {
            this.logger.warn(`No direct context found for condomino ${condominoNumber} in any collection`);
          }
        } catch (error) {
          this.logger.error(`Error querying direct Firebase data: ${error.message}`);
          // Continuamos con el proceso normal si falla la consulta directa
        }
      }

      // Extraer los textos y metadatos relevantes
      const relevantContext = queryResult.matches.map((match) => ({
        text: match.metadata.text,
        category: match.metadata.category,
        score: match.score,
        metadata: match.metadata,
      }));

      this.logger.log(
        `Retrieved ${relevantContext.length} context items for prompt`,
      );

      // Si no hay resultados, informar al usuario
      if (relevantContext.length === 0) {
        return {
          response:
            'Lo siento, no tengo suficiente contexto para responder a esta pregunta. Por favor, proporciona más información o contacta al administrador del condominio.',
          relevantContext: [],
          prompt,
          clientId,
          condominiumId,
          hasContext: false,
        };
      }

      // Preparar respuesta con Gemini usando el contexto obtenido
      // Extraer y deserializar los metadatos para una respuesta más informativa
      const getFormattedMetadata = (item: any) => {
        const metadata = { ...item.metadata };
        const formattedData = [];

        // Intentar deserializar campos JSON si existen
        Object.keys(metadata).forEach((key) => {
          if (
            typeof metadata[key] === 'string' &&
            (metadata[key].startsWith('[') || metadata[key].startsWith('{'))
          ) {
            try {
              metadata[key] = JSON.parse(metadata[key]);
            } catch (e) {
              // Si no se puede parsear, dejarlo como está
            }
          }
        });

        // Orden de campos relevantes específicos para finanzas
        const keyOrder = [
          'category',
          'text',
          'condominiumId',
          'clientId',
          'condominoNombre',
          'condominoNumero',
          'condominoTipo',
          'condominoEmail',
          'concept',
          'amountPaid',
          'currency',
          'paymentDate',
          'paymentType',
          'conceptosPagados',
          'detalleConceptos',
          'conceptosDetallados',
          'fechaRegistro',
          'isUnidentifiedPayment',
          'source',
        ];

        // Primero los campos en orden específico
        keyOrder.forEach((key) => {
          if (metadata[key] !== undefined) {
            if (typeof metadata[key] === 'object' && metadata[key] !== null) {
              formattedData.push(
                `${key.charAt(0).toUpperCase() + key.slice(1)}:\n${JSON.stringify(metadata[key], null, 2)}`,
              );
            } else {
              formattedData.push(
                `${key.charAt(0).toUpperCase() + key.slice(1)}:\n${metadata[key]}`,
              );
            }
            delete metadata[key];
          }
        });

        // Luego el resto de campos
        Object.keys(metadata)
          .sort()
          .forEach((key) => {
            if (
              key !== 'text' &&
              key !== 'score' &&
              key !== 'timestamp' &&
              key !== 'wordCount' &&
              key !== 'charCount'
            ) {
              if (typeof metadata[key] === 'object' && metadata[key] !== null) {
                formattedData.push(
                  `${key.charAt(0).toUpperCase() + key.slice(1)}:\n${JSON.stringify(metadata[key], null, 2)}`,
                );
              } else {
                formattedData.push(
                  `${key.charAt(0).toUpperCase() + key.slice(1)}:\n${metadata[key]}`,
                );
              }
            }
          });

        return formattedData.join('\n');
      };

      // Formatea el contexto de forma estructurada
      const formattedContext = relevantContext.map((item, index) => {
        return `DOCUMENTO ${index + 1} (${item.category}):\n${item.text}\n\nMETADATOS DOCUMENTO ${index + 1}:\n${getFormattedMetadata(item)}`;
      });

      // Agregar el contexto directo de Firebase si existe
      if (directFirebaseContext) {
        this.logger.log('Adding direct Firebase context to Gemini prompt');
        // Añadir al principio para darle mayor prioridad
        formattedContext.unshift(`DATOS DIRECTOS DE FIREBASE:\n${directFirebaseContext}`);
      }

      const enhancedPrompt = `
        --- SISTEMA FINANCIERO Y DE ADMINISTRACIÓN DE CONDOMINIOS ---
        
        ${formattedContext.join('\n\n' + '-'.repeat(50) + '\n\n')}
        
        --- FIN DEL CONTEXTO ---
        
        INSTRUCCIONES PARA EL ASISTENTE:
        Eres un asistente virtual especializado en administración de condominios y finanzas. A continuación, encontrarás algunas pautas importantes:
        
        1. TERMINOLOGÍA IMPORTANTE:
           - "Condomino" o "condómino" se refiere a la PERSONA propietaria o inquilina de una unidad, no al complejo residencial.
           - "Condomino Numero" o "Numero Condominio" es el IDENTIFICADOR ÚNICO de la unidad o departamento.
           - "CondominiumId" es el identificador del condominio completo.
           - "ClientId" es el identificador del cliente del sistema, la entidad que administra el condominio.
        
        2. SOBRE PAGOS Y FINANZAS:
           - Los pagos son realizados por condóminos identificados por su número de unidad.
           - Los "Conceptos Pagados" indican los detalles específicos cubiertos por cada pago.
           - "Payment Group Id" es la referencia única de la transacción.
        
        3. BÚSQUEDA E IDENTIFICACIÓN DE DATOS:
           - IMPORTANTE: Cuando se te pregunte sobre un condómino específico, busca meticulosamente en los metadatos, prestando especial atención a los campos "condominoNumero" o "numeroCondominio".
           - Examina TODOS los documentos proporcionados. Si un documento tiene "condominoNumero" = "279" (o cualquier número consultado), significa que sÍ tenemos información sobre ese condómino.
           - Verifica también el campo "text" ya que puede contener información relevante no estructurada sobre el condómino.
           - NO confundas "condominoNumero" (identificador de departamento/vivienda) con "condominio" (el complejo completo).

        4. CÓMO RESPONDER:
           - Utiliza SOLAMENTE la información del contexto proporcionado para responder.
           - Sé CONCISO y AMIGABLE en tus respuestas, evitando tecnicismos innecesarios.
           - NO incluyas datos sensibles como correos electrónicos, números de teléfono o referencias de pago a menos que sean solicitados.
           - Cuando menciones montos, especifica la moneda (ej. MXN, USD) de forma clara.
           - Prioriza la información relevante: Quién hizo qué, cuándo y el importe.
           - Si encuentras un registro con "condominoNumero" o "numeroCondominio" que coincide con lo consultado, usa esa información para responder (incluso si no está mencionado directamente en el campo "text").
        
        5. RESPUESTA PARA BÚSQUEDAS POR NÚMERO DE CONDÓMINO:
           - Si la consulta es sobre un número de condómino específico (ej: "condómino 279"):
             1. PRIMERO busca en los campos "condominoNumero" o "numeroCondominio" en TODOS los documentos.
             2. Si encuentras coincidencia, SIEMPRE responde con la información de ese condómino.
             3. Nunca respondas "No tengo información" si has encontrado un documento con ese número de condómino.
             4. Comprueba los campos numéricos en formato string ("279" vs 279).
           - Para pagos, incluye el monto, fecha y conceptos pagados de forma clara y concisa.
        
        PREGUNTA DEL USUARIO: ${prompt}
        `;

      // Generar respuesta usando el contexto enriquecido
      const response = await this.geminiService.generateContent(enhancedPrompt);

      return {
        response,
        relevantContext,
        prompt,
        clientId,
        condominiumId,
        hasContext: true,
        categories: [...new Set(relevantContext.map((item) => item.category))],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Error querying context: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to query context from Pinecone: ${error.message}`,
      );
    }
  }
}
