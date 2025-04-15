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
  private readonly modelName = 'gemini-1.5-flash-latest';

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
}
