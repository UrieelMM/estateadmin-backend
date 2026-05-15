import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  GenerateContentRequest,
  Part,
} from '@google/generative-ai';

export interface GeminiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
  source: 'gemini_usage_metadata' | 'count_tokens' | 'char_estimate';
}

export interface GeminiStreamResponse {
  stream: AsyncIterable<any>;
  getUsage: () => Promise<GeminiTokenUsage>;
}

@Injectable()
export class GeminiService implements OnModuleInit {
  private genAI: GoogleGenerativeAI;
  private readonly logger = new Logger(GeminiService.name);
  private readonly modelName = 'gemini-3-flash-preview';
  // Dimensión fija para mantener compatibilidad con el índice vectorial de Firestore
  private readonly embeddingDimensions = 768;
  // Modelos a probar en orden. El primero que responda exitosamente se usa.
  // Se cachea en `resolvedEmbeddingModel` para evitar reintentos posteriores.
  private readonly embeddingModelCandidates = [
    'gemini-embedding-001',
    'text-embedding-004',
    'embedding-001',
  ];
  private resolvedEmbeddingModel: string | null = null;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      this.logger.error('GEMINI_API_KEY is not set in environment variables.');
      throw new Error('GEMINI_API_KEY is missing.');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.logger.log(`Gemini AI initialized with model: ${this.modelName}`);
  }

  // Keep the original method for non-streaming, text-only generation if needed
  async generateContent(prompt: string): Promise<string> {
    try {
      const model = this.genAI.getGenerativeModel({ model: this.modelName });
      const result = await model.generateContent(prompt);
      if (result.response) {
        const text = result.response.text();
        this.logger.log(
          `Generated content for prompt: "${prompt.substring(0, 50)}..."`,
        );
        return text;
      } else {
        this.logger.warn(
          `No response generated for prompt: "${prompt.substring(0, 50)}..."`,
        );
        const blockReason = result.response?.promptFeedback?.blockReason;
        if (blockReason) {
          this.logger.error(
            `Content generation blocked. Reason: ${blockReason}`,
          );
          throw new Error(
            `Content generation blocked due to safety settings. Reason: ${blockReason}`,
          );
        }
        throw new Error('Gemini API did not return a response.');
      }
    } catch (error) {
      this.logger.error(
        `Error calling Gemini API (generateContent): ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to generate content via Gemini: ${error.message}`,
      );
    }
  }

  // New method for streaming responses and handling optional files
  async generateContentStream(
    prompt: string,
    file?: Express.Multer.File,
  ): Promise<GeminiStreamResponse> {
    try {
      const model = this.genAI.getGenerativeModel({ model: this.modelName });

      const safetySettings = [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
      ];

      const generationConfig = {
        temperature: 0.9,
        topK: 1,
        topP: 1,
        maxOutputTokens: 4096, // Increase if needed for combined text/image
      };

      const parts: Part[] = [{ text: prompt }];

      if (file) {
        this.logger.log(
          `Processing file: ${file.originalname}, MIME: ${file.mimetype}, Size: ${file.size}`,
        );
        // Updated check: Allow common image types and PDF. Add more as needed.
        const allowedMimeTypes = [
          'image/png',
          'image/jpeg',
          'image/webp',
          'image/heic',
          'image/heif',
          'application/pdf',
        ];
        if (!allowedMimeTypes.includes(file.mimetype)) {
          this.logger.warn(
            `Unsupported file type for direct processing: ${file.mimetype}. Ignoring file.`,
          );
          // Decide how to handle: throw error, ignore file, etc.
          // For now, let's ignore unsupported files for the API call
        } else {
          parts.push({
            inlineData: {
              mimeType: file.mimetype,
              data: file.buffer.toString('base64'),
            },
          });
        }
      }

      const request: GenerateContentRequest = {
        contents: [{ role: 'user', parts }],
        generationConfig,
        safetySettings,
      };

      this.logger.log(
        `Sending stream request to Gemini for prompt: "${prompt.substring(0, 50)}..." ${file ? 'with file' : ''}`,
      );
      const resultStream = await model.generateContentStream(request);
      this.logger.log(`Received stream from Gemini.`);

      const estimateTokensFromText = (text: string): number => {
        if (!text) return 0;
        return Math.max(1, Math.ceil(text.length / 4));
      };

      const getUsage = async (): Promise<GeminiTokenUsage> => {
        let outputText = '';

        try {
          const finalResponse: any = await resultStream.response;
          outputText = finalResponse?.text?.() ?? '';

          const usage = finalResponse?.usageMetadata;
          const promptTokenCount = usage?.promptTokenCount;
          const candidatesTokenCount = usage?.candidatesTokenCount;
          const totalTokenCount = usage?.totalTokenCount;

          if (
            Number.isFinite(promptTokenCount) &&
            Number.isFinite(candidatesTokenCount)
          ) {
            return {
              inputTokens: promptTokenCount,
              outputTokens: candidatesTokenCount,
              totalTokens:
                Number.isFinite(totalTokenCount)
                  ? totalTokenCount
                  : promptTokenCount + candidatesTokenCount,
              estimated: false,
              source: 'gemini_usage_metadata',
            };
          }

          const inputCount: any = await model.countTokens({
            contents: request.contents,
          } as any);
          const outputCount: any = outputText
            ? await model.countTokens({
                contents: [{ role: 'user', parts: [{ text: outputText }] }],
              } as any)
            : { totalTokens: 0 };

          if (
            Number.isFinite(inputCount?.totalTokens) &&
            Number.isFinite(outputCount?.totalTokens)
          ) {
            const inputTokens = inputCount.totalTokens;
            const outputTokens = outputCount.totalTokens;
            return {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              estimated: true,
              source: 'count_tokens',
            };
          }
        } catch (usageError) {
          this.logger.warn(
            `Could not retrieve exact usage metadata. Falling back to estimates: ${usageError.message}`,
          );
        }

        const inputTokens = estimateTokensFromText(prompt);
        const outputTokens = estimateTokensFromText(outputText);
        return {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimated: true,
          source: 'char_estimate',
        };
      };

      return {
        stream: resultStream.stream,
        getUsage,
      };
    } catch (error) {
      this.logger.error(
        `Error calling Gemini API (generateContentStream): ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to generate content stream via Gemini: ${error.message}`,
      );
    }
  }

  /**
   * Intenta generar un embedding con un modelo específico. Para
   * `gemini-embedding-001` pasamos `outputDimensionality: 768` para mantener
   * compatibilidad con el índice vectorial de Firestore.
   */
  private async tryEmbedWithModel(
    modelName: string,
    text: string,
  ): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({ model: modelName });

    // gemini-embedding-001 acepta outputDimensionality; los modelos legacy
    // (text-embedding-004, embedding-001) ya son 768 por default.
    const request: any =
      modelName === 'gemini-embedding-001'
        ? {
            content: { role: 'user', parts: [{ text }] },
            outputDimensionality: this.embeddingDimensions,
          }
        : text;

    const result: any = await (model as any).embedContent(request);
    const values: number[] | undefined = result?.embedding?.values;

    if (!values || !Array.isArray(values) || values.length === 0) {
      throw new Error('El modelo no devolvió un embedding válido');
    }

    if (values.length !== this.embeddingDimensions) {
      throw new Error(
        `Dimensión inesperada: ${values.length} (se esperaban ${this.embeddingDimensions})`,
      );
    }

    return values;
  }

  /**
   * Genera un embedding vectorial (768 dimensiones) para un texto dado.
   * Probará varios modelos compatibles en orden hasta que uno responda
   * correctamente, y luego cacheará el ganador para llamadas posteriores.
   */
  async embedText(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('No se proporcionó texto para generar el embedding');
    }

    // Truncar a un tamaño razonable para evitar exceder límites del modelo
    const safeText = text.length > 8000 ? text.substring(0, 8000) : text;

    // Si ya resolvimos un modelo válido previamente, usarlo directamente
    if (this.resolvedEmbeddingModel) {
      try {
        return await this.tryEmbedWithModel(
          this.resolvedEmbeddingModel,
          safeText,
        );
      } catch (err) {
        this.logger.warn(
          `Modelo cacheado ${this.resolvedEmbeddingModel} falló (${err.message}). Reintentando con la lista completa.`,
        );
        this.resolvedEmbeddingModel = null;
      }
    }

    // Probar candidatos en orden
    const errors: string[] = [];
    for (const candidate of this.embeddingModelCandidates) {
      try {
        const values = await this.tryEmbedWithModel(candidate, safeText);
        this.resolvedEmbeddingModel = candidate;
        this.logger.log(`Embedding generado con modelo: ${candidate}`);
        return values;
      } catch (err) {
        errors.push(`${candidate}: ${err.message?.substring(0, 200)}`);
        this.logger.warn(
          `Modelo ${candidate} no disponible (${err.message?.substring(0, 120)}). Probando siguiente.`,
        );
      }
    }

    const combined = errors.join(' | ');
    this.logger.error(`Ningún modelo de embedding funcionó: ${combined}`);
    throw new Error(
      `Failed to embed text via Gemini: ningún modelo respondió. Detalles: ${combined}`,
    );
  }

  /**
   * Genera embeddings en lote (uno por uno con cierta tolerancia a fallos).
   * No paraleliza para no superar rate limits del free tier.
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      try {
        const vec = await this.embedText(text);
        results.push(vec);
      } catch (e) {
        this.logger.warn(
          `Falló embedding de un chunk (continuando): ${e.message}`,
        );
        // Push de un vector vacío como marcador; el caller decide qué hacer
        results.push([]);
      }
    }
    return results;
  }

  /**
   * Genera una respuesta para el chatbot RAG basándose ESTRICTAMENTE en los
   * chunks de contexto provistos. Si no hay contexto suficiente, debe
   * indicarlo explícitamente en la respuesta.
   */
  async answerWithContext(
    question: string,
    contextChunks: Array<{ text: string; source: string }>,
    condominiumName?: string,
  ): Promise<string> {
    try {
      const model = this.genAI.getGenerativeModel({ model: this.modelName });

      const contextBlock = contextChunks
        .map(
          (c, i) =>
            `[Fragmento ${i + 1} — Fuente: ${c.source}]\n${c.text}`,
        )
        .join('\n\n---\n\n');

      const condominiumLine = condominiumName
        ? `Estás asistiendo a un residente del condominio "${condominiumName}".`
        : 'Estás asistiendo a un residente del condominio.';

      const prompt = `Eres un asistente virtual de administración de condominios. ${condominiumLine}

REGLAS ESTRICTAS:
1. Responde EXCLUSIVAMENTE con base en el CONTEXTO provisto abajo.
2. Si la respuesta NO está en el contexto, responde literalmente: "No encontré información sobre eso en los documentos de tu condominio. Te sugiero contactar al administrador."
3. NUNCA inventes reglas, montos, fechas, nombres o políticas que no estén explícitamente en el contexto.
4. NO emitas opiniones legales ni recomendaciones personales.
5. Responde en español, completa pero concisa (no más de 12-15 líneas). Cubre todos los puntos relevantes que aparecen en el contexto sin cortar la idea.
6. Tono amable y claro para WhatsApp.
7. NO uses Markdown complejo (sin tablas). Puedes usar *negritas* simples de WhatsApp y listas con guiones.
8. Al final, agrega una línea con la fuente más relevante usando el formato: "📎 _Fuente: <nombre de la fuente>_"

CONTEXTO:
${contextBlock}

PREGUNTA DEL RESIDENTE:
${question}

RESPUESTA:`;

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048,
        },
      });

      if (!result.response) {
        throw new Error('Gemini no devolvió respuesta');
      }

      return result.response.text().trim();
    } catch (error) {
      this.logger.error(
        `Error en answerWithContext: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to answer with context: ${error.message}`);
    }
  }

  // Método especializado para extraer datos de comprobantes de pago
  async extractReceiptData(file: Express.Multer.File): Promise<any> {
    try {
      // Verificar que se proporcionó un archivo
      if (!file) {
        throw new Error('No se proporcionó ningún archivo para procesar');
      }

      this.logger.log(
        `Procesando comprobante de pago: ${file.originalname}, MIME: ${file.mimetype}, Size: ${file.size}`,
      );

      // Verificar tipo de archivo permitido
      const allowedMimeTypes = [
        'image/png',
        'image/jpeg',
        'image/jpg',
        'image/webp',
        'image/heic',
        'image/heif',
        'application/pdf',
      ];

      if (!allowedMimeTypes.includes(file.mimetype)) {
        throw new Error(
          `Tipo de archivo no soportado: ${file.mimetype}. Por favor, sube una imagen o un PDF.`,
        );
      }

      const model = this.genAI.getGenerativeModel({ model: this.modelName });

      // Instrucciones específicas para extraer datos de comprobantes
      const prompt = `Analiza detalladamente este comprobante de pago y extrae la siguiente información en formato JSON:
      
1. Monto total del pago (solo el número, sin moneda)
2. Moneda (MXN, USD, etc.)
3. Fecha del pago (en formato ISO: YYYY-MM-DD)
4. Concepto o descripción del pago
5. Emisor o entidad que recibe el pago
6. Número de referencia o folio (si existe)
7. Método de pago (si se menciona)

Responde SOLO con un objeto JSON válido que contenga estos campos (amount, currency, date, description, recipient, reference, paymentMethod). Si algún dato no está presente, deja ese campo como null. No incluyas ningún texto adicional fuera del JSON.`;

      const parts: Part[] = [
        { text: prompt },
        {
          inlineData: {
            mimeType: file.mimetype,
            data: file.buffer.toString('base64'),
          },
        },
      ];

      const safetySettings = [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
      ];

      const generationConfig = {
        temperature: 0.1, // Temperatura baja para respuestas más precisas/deterministas
        maxOutputTokens: 2048,
      };

      const request: GenerateContentRequest = {
        contents: [{ role: 'user', parts }],
        generationConfig,
        safetySettings,
      };

      this.logger.log(
        'Enviando solicitud a Gemini para extraer datos del comprobante',
      );
      const result = await model.generateContent(request);

      if (!result.response) {
        throw new Error('Gemini API no devolvió una respuesta');
      }

      let responseText = result.response.text();
      this.logger.log(`Respuesta raw de Gemini: ${responseText}`);
      
      try {
        // Función para extraer JSON de texto, manejando diferentes formatos posibles
        const extractJsonFromText = (text: string): string => {
          // Caso 1: Texto es directamente un JSON válido
          try {
            JSON.parse(text);
            return text; // Si no lanza error, es un JSON válido
          } catch (e) {
            // No es un JSON válido, seguimos intentando otros formatos
          }
          
          // Caso 2: Bloque markdown ```json ... ```
          const markdownMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
          if (markdownMatch && markdownMatch[1]) {
            return markdownMatch[1].trim();
          }
          
          // Caso 3: Buscar cualquier objeto que parezca JSON (entre llaves)
          const jsonObjectMatch = text.match(/{[\s\S]*?}/);
          if (jsonObjectMatch) {
            return jsonObjectMatch[0];
          }
          
          // No encontramos un formato válido
          return text;
        };
        
        const jsonText = extractJsonFromText(responseText);
        this.logger.log(`JSON extraído: ${jsonText}`);
        
        // Intentar parsear la respuesta como JSON
        const extractedData = JSON.parse(jsonText);
        this.logger.log('Datos extraídos correctamente del comprobante');
        return extractedData;
      } catch (parseError) {
        this.logger.error(
          `Error al parsear la respuesta de Gemini como JSON: ${parseError.message}`,
          parseError.stack,
        );
        // Si no se puede parsear como JSON, devolver la respuesta como texto
        return {
          error: 'No se pudo extraer datos estructurados',
          rawText: responseText,
        };
      }
    } catch (error) {
      this.logger.error(
        `Error al procesar el comprobante de pago: ${error.message}`,
        error.stack,
      );
      throw new Error(`Error al procesar el comprobante: ${error.message}`);
    }
  }
}
