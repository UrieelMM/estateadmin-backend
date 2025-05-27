import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  GenerateContentRequest,
  Part,
  GenerateContentStreamResult,
} from '@google/generative-ai';

@Injectable()
export class GeminiService implements OnModuleInit {
  private genAI: GoogleGenerativeAI;
  private readonly logger = new Logger(GeminiService.name);
  private readonly modelName = 'gemini-2.0-flash';

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
  ): Promise<GenerateContentStreamResult> {
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

      // Return the stream result directly
      return resultStream;
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
